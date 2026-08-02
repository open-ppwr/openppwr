import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// Importing this file used to turn a failing script into a passing one.
//
// `embedded-postgres` depends on `async-exit-hook`, which registers a `beforeExit` handler at import time
// that ends with `process.exit(0)`. Node's own semantics are that a script setting `process.exitCode = 1`
// and then returning normally exits 1 — but `process.exit(0)` overrides it, so any caller of this harness
// that reported failure that way exited 0 instead. Measured directly: with this module imported,
// `process.exitCode = 1` produced an actual exit code of 0; without it, 1.
//
// Every current caller happens also to call `process.exit()` explicitly, so nothing is failing silently
// today. That is luck rather than design, and it is the fourth distinct shape of "the gate cannot fail"
// this repository has found. The hook below restores Node's contract: if a script set a non-zero exit code
// and is on its way out, that code is the one that is used.
//
// Registered after the import above, so it runs before the library's handler in `beforeExit` ordering, and
// `process.exit` here is what actually terminates — the library's `exit(0)` is never reached.
process.on('beforeExit', () => {
  if (process.exitCode) process.exit(process.exitCode);
});
import { endPool } from './bounded-teardown.mjs';

const { Pool } = pg;

// One cluster per workspace, one database per test file.
//
// Every integration file used to call startTestDatabase() and get a PostgreSQL cluster of its own: `initdb`,
// `pg_ctl start`, a data directory, and a teardown, each bounded at 30 seconds. `apps/api` alone did that
// eleven times, the workspace twenty. `--test-concurrency=1` means only one of them is ever initialising at
// a time, so the bound was never crossed by contention between two live clusters — it was crossed by the
// accumulated cost of the ones already finished: twenty ~40 MB data directories written, scanned by the
// on-access virus scanner and deleted, plus whichever postmaster children outlived their parent. The file
// that happened to be initialising when the host was slowest lost, `before` threw, and every test in that
// file failed — the first at about 30000ms and the rest in microseconds — with nothing wrong in the code
// under test. It was observed on two different files on two different days, which is the signature of a
// race decided by ordering rather than of a defect in either file.
//
// Raising the constant would move that threshold without removing the race. Removing the twenty clusters
// removes it: a workspace runner (scripts/testing/run-integration-tests.mjs) starts exactly one cluster,
// hands its address to the `node --test` children through SHARED_CLUSTER_VARIABLE, and each file creates its
// own database inside it. `CREATE DATABASE` costs milliseconds and cannot time out the way `initdb` can.
//
// What that changes, stated plainly:
//
//   Isolation. A database, not a schema. A session connected to one database cannot read another's tables
//   at all — that is enforced by PostgreSQL, not by convention, and there is no dblink or postgres_fdw
//   here. What files *do* now share is the cluster-global catalogue: roles. Several files deliberately
//   mutate role state (prepare-runtime.integration.test.mjs sets them NOLOGIN, grants one membership in
//   another, and gives one CREATEROLE), and privilege-model.integration.test.mjs asserts closed sets over
//   exactly that state. So provisionPrincipals() below re-establishes every principal — attributes,
//   password and memberships — at the start of every file, in both modes. No file inherits another's
//   mutations, including from a file that crashed before its own `finally` could undo them.
//
//   Teardown. The runner owns the cluster and stops it once, in a `finally`, through the same bounded path
//   as before. A file's own stop() ends its pools and drops its database and never touches the cluster, so
//   one file crashing cannot strand the files after it — the worst case is a leftover database in a
//   directory that is removed wholesale at the end anyway.
//
// Callers outside a runner — the end-to-end gates and the standalone matrices — pass no variable, get a
// private cluster exactly as before, and stop it themselves.
export const SHARED_CLUSTER_VARIABLE = 'OPENPPWR_TEST_CLUSTER_URL';

// The five principals migrations 014, 022 and 035 separate. openppwr_security_owner is created by
// migration 017 and normalised by it on every run, so it is listed only where memberships are cleared.
const PRINCIPALS = ['openppwr_app', 'openppwr_auth', 'openppwr_maintenance', 'openppwr_worker', 'openppwr_rotation'];
const OWNED_ROLES = [...PRINCIPALS, 'openppwr_security_owner'];

// Resolved from this module, not from the working directory. npm runs a workspace script with the workspace
// as cwd, so `resolve('node_modules', ...)` found `apps/api/node_modules/@embedded-postgres/...`, which does
// not exist under a hoisted install — the last-resort kill below silently could not find pg_ctl in exactly
// the situation it exists for.
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

// Last resort when a cluster refuses to stop.
//
// pg_ctl is addressed by data directory, so this can only ever stop the cluster this harness
// started — never another test's and never a developer's own PostgreSQL. "immediate" is the right
// mode here: the data is disposable test data, and waiting politely is what failed.
//
// Arguments are passed as an array rather than a command string, so no quoting or escaping of the
// Windows path is involved.
function killCluster(databaseDir) {
  return new Promise((resolveKill) => {
    const binary = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
    const platformPackage = { win32: 'windows-x64', darwin: 'darwin-x64', linux: 'linux-x64' }[process.platform];
    if (!platformPackage) { resolveKill(); return; }
    const pgCtl = resolve(repositoryRoot, 'node_modules', '@embedded-postgres', platformPackage, 'native', 'bin', binary);
    const child = spawn(pgCtl, ['-D', databaseDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    child.on('error', () => resolveKill());
    child.on('close', () => resolveKill());
  });
}

// The reason a test file could pass every assertion, tear down cleanly, warn about nothing, and still
// never exit.
//
// `embedded-postgres` spawns the postmaster with piped stdio and attaches a 'data' listener to its
// stderr, so this process holds the read end of those pipes and they are ref'd in libuv. Its stop()
// kills the postmaster and then drops the ChildProcess (`this.process = undefined`) without destroying
// the streams.
//
// A pipe reaches EOF only when *every* writer has closed it. PostgreSQL 18 runs `io_worker` subprocesses
// which survive `taskkill /t` here — observed repeatedly as orphaned
// `postgres.exe --forkchild="io_worker"` with a dead parent — and they inherited the write end. So the
// read stream never ends, the handle stays ref'd, and Node cannot exit even though every await settled
// and every bounded step reported success. That is precisely why this failure produced no warning: it is
// not a wait that timed out, it is a handle nobody closed.
//
// Destroying our own read ends is the fix that is actually in our control. Nothing useful can arrive on
// them once the cluster is stopped.
function releaseChildPipes(child) {
  if (!child) return;
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try { stream?.removeAllListeners?.(); stream?.destroy?.(); } catch { /* already gone is the goal */ }
  }
  try { child.removeAllListeners?.(); child.unref?.(); } catch { /* nothing left to detach */ }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// Shared with stop() below. A promise that never settles — not a rejection — is the failure mode this
// harness has actually hit on Windows, on both ends of a cluster's life: `stop()` already had this
// treatment; `initialise()`/`start()` did not, so a startup wedged behind a leftover lock or a port the
// OS considers free but a zombie process still holds could hang a whole gate run for its outer stage
// timeout (up to 20 minutes) instead of failing in seconds with a clear reason.
async function bounded(label, operation, ms) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_ignored, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
    return true;
  } catch (error) {
    // embedded-postgres's own start()/initialise() can reject with a bare value rather than an Error
    // — `error.message` on that would throw a TypeError from inside
    // this catch block, skipping the caller's cleanup branch entirely and defeating the whole point of
    // bounding the call.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`TEST_DATABASE_LIFECYCLE_WARNING step=${label} reason=${reason}`);
    return false;
  } finally { clearTimeout(timer); }
}

function connectionUrl({ port, database, role, password }) {
  return `postgres://${role}:${password}@127.0.0.1:${port}/${database}`;
}

// Starts one PostgreSQL cluster and returns the handle that owns it. This is the expensive part — `initdb`
// writes a whole template installation — and it is what the shared design pays for once per workspace
// rather than once per test file.
async function startCluster(label) {
  const port = await freePort();
  const databaseDir = resolve('.runtime-test', `${label}-${randomUUID()}`);
  const adminPassword = randomUUID();
  await mkdir(databaseDir, { recursive: true });
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: adminPassword,
    port,
    persistent: false,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
  });
  if (!(await bounded('postgres-initialise', () => embedded.initialise(), 30_000))) {
    await bounded('postgres-kill-after-failed-initialise', () => killCluster(databaseDir), 15_000);
    throw new Error(`Embedded PostgreSQL initialise() did not complete within 30000ms (label=${label}); a leftover lock or process from a previous run is the likely cause.`);
  }
  if (!(await bounded('postgres-start', () => embedded.start(), 30_000))) {
    await bounded('postgres-kill-after-failed-start', () => killCluster(databaseDir), 15_000);
    throw new Error(`Embedded PostgreSQL start() did not complete within 30000ms (label=${label}); a leftover lock or process from a previous run is the likely cause.`);
  }
  // Captured now, because `embedded.stop()` sets its own `process` field to undefined before returning
  // and we need the streams afterwards. See releaseChildPipes() for why.
  const clusterChild = embedded.process;
  return {
    port,
    adminPassword,
    databaseDir,
    // The maintenance connection. `CREATE DATABASE` and `DROP DATABASE` cannot run from inside the database
    // they name, so every per-file database is created and dropped through this one.
    url: connectionUrl({ port, database: 'postgres', role: 'postgres', password: adminPassword }),
    async stop() {
      const stopped = await bounded('postgres-stop', () => embedded.stop(), 20_000);
      if (!stopped) await bounded('postgres-kill', () => killCluster(databaseDir), 15_000);
      // After the cluster is down, not before: until then these pipes carry the server's own error
      // output. Once it is down they carry nothing and only keep this process alive.
      releaseChildPipes(clusterChild);
      // The `io_worker` survivors this file's own comment describes, finally acted on rather than only
      // noted. `pg_ctl -m immediate stop` returns success having reaped the postmaster, and PostgreSQL 18's
      // io_worker subprocesses can outlive it — which is exactly what accumulated to six orphaned
      // `postgres.exe` on this workstation across a day of green gate runs, and to one more on the run that
      // added the check able to see them.
      //
      // Scoped by `findOrphans` to this checkout and to processes whose parent is already gone, so a
      // suite running in parallel in the same tree is never touched: its database still has a live parent.
      // Failure here is deliberately not fatal — the cluster is already stopped and the test's verdict is
      // already decided, so a stray process is a housekeeping fact for the gate's cleanup line to report,
      // not a reason to fail a suite that passed.
      try {
        const { findOrphans } = await import('../validation/orphan-check.mjs');
        const { listProcesses } = await import('../validation/orphan-check.mjs');
        const listed = listProcesses();
        for (const entry of findOrphans(listed, repositoryRoot).orphans) {
          try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      } catch { /* process listing is best-effort; the gate's own cleanup check is the authority */ }
      await bounded('remove-data-dir', () => rm(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 20_000);
    },
  };
}

// A short-lived pool on the cluster's maintenance database. Held open only for the statement it was opened
// for, because a connection to `postgres` counts against nothing here except this process's ability to exit.
async function onMaintenanceDatabase(clusterUrl, label, statement) {
  const cluster = new Pool({
    connectionString: clusterUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
  });
  try {
    await cluster.query(statement);
  } finally {
    await endPool(cluster, label, 10_000);
  }
}

// Re-establishes the runtime principals as migration 014 and migration 022 leave them, plus the login
// credential the installer would supply — from whatever state the previous test file left them in.
//
// This is what makes a shared cluster safe. Roles are cluster-global, the migrations create them only
// `IF NOT EXISTS`, and several files change them on purpose. Without this a file that set openppwr_app
// CREATEROLE and died before its `finally` would fail the next file's privilege assertions, and the report
// would name the wrong file.
//
// Each password is distinct. Reusing one would make the separation look real in the grants while being
// absent in practice, which is the failure mode this whole redesign exists to correct. The worker is a
// separate service and therefore a separate identity: sharing one with the API is what made every retention
// grant decorative, because a capability reachable from the wrong process is a capability nobody separated
// (migration 022).
// Runs a DDL statement whose identifiers and literals are quoted by PostgreSQL itself.
//
// Role DDL cannot take bound parameters, so the statement has to be assembled as text. `format()` is where
// that assembly belongs: `%I` applies the server's own identifier rules — including the ones a hand-written
// check gets wrong, such as embedded double quotes, mixed case and reserved words — and `%L` the same for
// literals. The template is a constant in this file and the values arrive as parameters, so no caller-shaped
// text ever reaches the parser unquoted.
//
// This replaced plain interpolation. That interpolation was not exploitable here — the values are role names
// from this file's own constants and hex passwords from `randomBytes` — but "the input happens to be safe"
// is a property of today's callers, not of the code, and this is a file people copy patterns out of.
async function runFormattedDdl(admin, template, values) {
  const placeholders = values.map((_value, index) => `, $${index + 2}::text`).join('');
  const built = await admin.query(`SELECT format($1::text${placeholders}) AS ddl`, [template, ...values]);
  await admin.query(built.rows[0].ddl);
}

async function provisionPrincipals(admin) {
  // NOINHERIT does not prevent SET ROLE; only the absence of membership does. A membership left behind by a
  // previous file would therefore survive every attribute reset below.
  //
  // Note which side of each row is constrained: the WHERE matches `granted` OR `member` against the owned
  // set, so exactly one end is known to be ours and the other is any role in the cluster. That is precisely
  // why the REVOKE below quotes both.
  const memberships = await admin.query(
    `SELECT g.rolname AS granted, m.rolname AS member
       FROM pg_auth_members a
       JOIN pg_roles g ON g.oid = a.roleid
       JOIN pg_roles m ON m.oid = a.member
      WHERE g.rolname = ANY($1) OR m.rolname = ANY($1)`, [OWNED_ROLES]);
  for (const { granted, member } of memberships.rows) {
    await runFormattedDdl(admin, 'REVOKE %I FROM %I', [granted, member]);
  }
  const passwords = new Map(PRINCIPALS.map((role) => [role, randomBytes(18).toString('hex')]));
  for (const [role, password] of passwords) {
    const present = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount > 0;
    if (!present) await runFormattedDdl(admin, 'CREATE ROLE %I NOLOGIN', [role]);
    // `RESET ALL` clears `rolconfig` — the per-role `ALTER ROLE ... SET` defaults. Setting the attributes
    // below does not touch them, so without this they are the one part of a principal that a previous test
    // file could still hand to the next one. That matters more than it sounds: a superuser may pin a
    // parameter onto a role that the role is forbidden to set itself, so the inherited value is not one the
    // session could undo even if it noticed. The admin here is the cluster superuser, which is what makes
    // clearing it possible.
    await runFormattedDdl(admin, 'ALTER ROLE %I RESET ALL', [role]);
    // CONNECTION LIMIT and VALID UNTIL are reset in the same statement as the attributes, and
    // unconditionally: a limit of 0 makes the principal unable to connect and an expiry in the past makes its
    // password stop authenticating, and either one inherited from a crashed file would fail every test in
    // every file after it, naming the wrong file. Unlike the installer's copy of this reset, there is no
    // operator here whose deliberate connection cap could be overridden — the cluster is disposable and this
    // function is its only authority.
    await runFormattedDdl(
      admin,
      `ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION
         CONNECTION LIMIT -1 VALID UNTIL 'infinity'`,
      [role, password],
    );
  }
  return passwords;
}

// Builds the handle every test file works with, against a database that already exists. `releaseCluster` is
// what separates the two modes: in a runner it is a no-op, because the runner stops the cluster; standalone
// it is the cluster's own stop().
async function attachDatabase({ port, adminPassword, database, clusterUrl, releaseCluster, dropOnStop }) {
  const adminUrl = connectionUrl({ port, database, role: 'postgres', password: adminPassword });
  // Every deadline below is enforced independently, and deliberately not by wrapping each query in
  // another Promise.race: a client-side race abandons the wait without cancelling the statement on the
  // server, so the query — and whatever lock it holds — keeps running regardless. `statement_timeout`
  // and `lock_timeout` are enforced by PostgreSQL itself and actually end the work; `connectionTimeoutMillis`
  // bounds pool/socket/auth acquisition, which happens lazily on the first query and was unbounded before
  // — and that is the actual gap behind an idle, 0%-CPU postgres.exe outlasting every bounded startup
  // step above it: pool acquisition, not necessarily one specific CREATE ROLE.
  const admin = new Pool({
    connectionString: adminUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    lock_timeout: 10_000,
  });
  let passwords;
  try {
    passwords = await provisionPrincipals(admin);
  } catch (error) {
    // Fail atomic rather than leaving a half-provisioned database the caller thinks it can still use, and
    // without taking down a cluster that the files after this one still need.
    await endPool(admin, 'admin-pool-after-bootstrap-failure', 10_000);
    if (dropOnStop) await bounded('drop-database-after-bootstrap-failure', () => onMaintenanceDatabase(clusterUrl, 'cluster-admin-after-bootstrap-failure', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`), 20_000);
    await releaseCluster();
    throw error;
  }
  const urlFor = (role, password) => connectionUrl({ port, database, role, password });
  return {
    adminUrl,
    runtimeUrl: urlFor('openppwr_app', passwords.get('openppwr_app')),
    authUrl: urlFor('openppwr_auth', passwords.get('openppwr_auth')),
    maintenanceUrl: urlFor('openppwr_maintenance', passwords.get('openppwr_maintenance')),
    workerUrl: urlFor('openppwr_worker', passwords.get('openppwr_worker')),
    // The one privileged credential a production deployment may hold (migration 035). A test that exercises
    // credential rotation in the production posture connects as this and never as openppwr_auth, which is
    // the whole distinction: the request-serving process must be able to rotate without also being able to
    // mint a session for an identity it holds no credential for.
    rotationUrl: urlFor('openppwr_rotation', passwords.get('openppwr_rotation')),
    // The database name is generated, so a test that needs a connection string for a credential it has just
    // provisioned itself must build it from here rather than assume a name.
    urlFor,
    runtimeUrlFor(password) { return urlFor('openppwr_app', password); },
    // A deployment is a demonstration only because the installer said so at install time. Tests that
    // exercise the reset must make that declaration explicitly, as an operator would.
    async declareDemonstrationDeployment() {
      await admin.query(`UPDATE deployment_metadata SET deployment_mode='demo' WHERE singleton`);
    },
    admin,
    // Teardown must be bounded, and must release everything this file owns without touching anything it
    // does not.
    //
    // A suite that finished every test and then never exited was the cause of a stalled release gate
    // and of several orphaned PostgreSQL clusters. `embedded.stop()` does not always return on
    // Windows, and a rejected promise is not the failure mode — a promise that never settles is.
    // Each step therefore has a deadline, and a cluster that will not stop politely is killed, since
    // a leftover test database is worse than an abrupt one.
    async stop() {
      // endPool rather than bounded(): a timed-out `admin.end()` leaves this pool's sockets open and
      // ref'd, so the caller's process still cannot exit. Bounding the wait without releasing the
      // handle turns a silent hang into a warning plus a silent hang.
      await endPool(admin, 'admin-pool', 10_000);
      // WITH (FORCE) because the file being torn down may have left a connection behind and a DROP that
      // waits for it is a hang. Best effort: the runner removes the entire data directory afterwards, so a
      // database that refuses to drop costs disk until the workspace finishes and nothing more.
      if (dropOnStop) await bounded('drop-test-database', () => onMaintenanceDatabase(clusterUrl, 'cluster-admin', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`), 20_000);
      await releaseCluster();
    },
  };
}

// Starts a cluster for a whole workspace. Only scripts/testing/run-integration-tests.mjs calls this; it is
// exported rather than inlined there so the cluster lifecycle stays in one file with releaseChildPipes().
export async function startTestCluster(label = 'workspace') {
  if (process.env.NODE_ENV === 'production') throw new Error('Embedded PostgreSQL is test-only.');
  return startCluster(label);
}

export async function startTestDatabase(label = 'integration') {
  if (process.env.NODE_ENV === 'production') throw new Error('Embedded PostgreSQL is test-only.');
  const shared = process.env[SHARED_CLUSTER_VARIABLE];
  if (shared) {
    const clusterAddress = new URL(shared);
    const adminPassword = decodeURIComponent(clusterAddress.password);
    // Unique per file, so two files in the same workspace can never name the same database and a file that
    // failed to drop its own cannot collide with the next run of itself.
    const database = `openppwr_test_${label.replace(/[^a-z0-9]+/giu, '_')}_${randomBytes(6).toString('hex')}`.slice(0, 63);
    await onMaintenanceDatabase(shared, 'cluster-admin-create', `CREATE DATABASE "${database}"`);
    return attachDatabase({
      port: Number(clusterAddress.port),
      adminPassword,
      database,
      clusterUrl: shared,
      dropOnStop: true,
      // The runner owns the cluster. A test file that stopped it would take every file after it with it.
      releaseCluster: async () => {},
    });
  }
  // No runner: this caller gets a cluster of its own and tears the whole thing down, which is what the
  // end-to-end gates and the standalone security matrices need. One database, so it keeps the fixed name.
  const cluster = await startCluster(label);
  const database = 'openppwr_test';
  try {
    await onMaintenanceDatabase(cluster.url, 'cluster-admin-create', `CREATE DATABASE "${database}"`);
  } catch (error) {
    await cluster.stop();
    throw error;
  }
  return attachDatabase({
    port: cluster.port,
    adminPassword: cluster.adminPassword,
    database,
    clusterUrl: cluster.url,
    dropOnStop: false,
    releaseCluster: () => cluster.stop(),
  });
}
