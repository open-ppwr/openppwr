// Backup, restore, forward smoke and snapshot rollback, rehearsed end to end on a real cluster with real
// migrations, a real API and real data.
//
// **Two tenants, deliberately.** Every earlier rehearsal ran with one. Isolation between tenants was proven
// for the request path by the two-tenant API matrix, but the restore path and the background-job path had
// only ever been exercised where there was nothing to confuse them with: a restore that puts one tenant's
// rows back cannot demonstrate that it did not merge two, and a worker that processes the only queue there
// is cannot demonstrate that it left another tenant's queue alone.
//
// The second tenant is created by `scripts/acme/provision-synthetic-tenant.mjs`, which is what the product
// ships for exactly this, because `/v1/bootstrap` refuses to run twice. Its worker credential is issued by
// `scripts/acme/issue-worker-token.mjs`, which is what the product ships for exactly that, because a worker
// identity's token is stored as a hash and never kept.
//
// **What the single-tenant guard means here, stated rather than worked around.** OpenPPWR Community serves
// one tenant per deployment, and `assertSingleTenantDeployment` in apps/worker/src/index.mjs refuses to
// start a worker against a database holding more than one. So this rehearsal asserts that refusal first —
// it is a property worth keeping, not an obstacle — and only then sets the documented opt-out that the
// guard's own comment reserves for verification suites, to reach the isolation behaviour behind it. What
// the run therefore shows is what a two-tenant database does when the refusal is overridden, which is the
// question the restore path raises; it does not show that a two-tenant deployment is supported, and it is
// not evidence for that.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createApp, createVerifiedContext } from '../../apps/api/src/app.mjs';
import { assertSingleTenantDeployment, processNextScanJob, scanQueueSnapshot, VerdictStubScanner } from '../../apps/worker/src/index.mjs';
import { migrate } from '../../packages/database/src/migrate.mjs';
import { createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';

const { Pool } = pg;
const runtimeRoot = resolve('.runtime-test');
const runRoot = resolve(runtimeRoot, `recovery-${randomUUID()}`);
const sourceDatabaseRoot = resolve(runRoot, 'source-db');
const backupDatabaseRoot = resolve(runRoot, 'backup', 'database');
const backupEvidenceRoot = resolve(runRoot, 'backup', 'evidence');
const restoredDatabaseRoot = resolve(runRoot, 'restored-db');
const restoredEvidenceRoot = resolve(runRoot, 'restored-evidence');
const rollbackDatabaseRoot = resolve(runRoot, 'rollback-db');
const rollbackEvidenceRoot = resolve(runRoot, 'rollback-evidence');
const sourceEvidenceRoot = resolve(runRoot, 'source-evidence');
const reportPath = resolve('artifacts', 'release', 'recovery-rehearsal-report.json');
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
// The second tenant. Its address suffix has to differ from the first tenant's, because a demonstration
// address resolves to a single row and a collision would break sign-in for both — the provisioning script
// refuses without one.
const TENANT_B_SLUG = 'acme-b-recovery-demo';
const TENANT_B_SUFFIX = '-b';
const DEMO_DOMAIN = 'dummymail.example';
const DEMO_PASSWORD = `rehearsal-${randomUUID()}`;
const workerTokenFile = resolve(runRoot, 'tenant-b-worker.env');

assert.equal(runRoot.startsWith(`${runtimeRoot}\\`) || runRoot.startsWith(`${runtimeRoot}/`), true);

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

async function manifest(root) {
  const entries = [];
  async function walk(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        const content = await readFile(path);
        entries.push({ path: relative(root, path).replaceAll('\\', '/'), size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
    }
  }
  await walk(root);
  const digest = createHash('sha256').update(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join('')).digest('hex');
  return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), digest };
}

function cluster(options) {
  return new EmbeddedPostgres({
    ...options,
    persistent: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: () => {},
  });
}

async function startExistingCluster(databaseDir, port, adminPassword) {
  const embedded = cluster({ databaseDir, port, user: 'postgres', password: adminPassword });
  await embedded.start();
  return embedded;
}

// The API is started with three credentials, not one. `openppwr_auth` is what makes interactive sign-in
// possible, and sign-in is the only way into the second tenant: its identities are provisioned with random
// bearer tokens whose hashes are stored and whose plaintext is deliberately never kept. `openppwr_worker` is
// the background-job principal, separate from the request-serving one since migration 022.
async function startApp({ runtimeUrl, authUrl, workerUrl, bootstrapToken, storageRoot }) {
  const pool = new Pool({ connectionString: runtimeUrl, max: 4 });
  const authPool = authUrl ? new Pool({ connectionString: authUrl, max: 2 }) : undefined;
  const workerPool = workerUrl ? new Pool({ connectionString: workerUrl, max: 2 }) : undefined;
  const app = createApp({ pool, authPool, bootstrapToken, storageRoot });
  const server = await new Promise((resolveServer) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance));
  });
  return {
    pool,
    authPool,
    workerPool,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((resolveClose) => server.close(resolveClose));
      await pool.end();
      await authPool?.end();
      await workerPool?.end();
    },
  };
}

// Runs one of the scripts the product ships for operating a deployment, as a deployment operator would:
// a separate process, its own connection string, its own explicit confirmation variable. Reimplementing
// what they do inside this file would rehearse this file rather than the product.
function runShippedScript(relativePath, argumentList, environment) {
  const result = spawnSync(process.execPath, [resolve(repositoryRoot, relativePath), ...argumentList], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  assert.equal(result.status, 0, `${relativePath} exited ${result.status}: ${output}`);
  return output;
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function databaseState(admin, runtimePool) {
  const counts = await admin.query(`SELECT
    (SELECT count(*)::int FROM tenants) tenants,
    (SELECT count(*)::int FROM packaging) packaging,
    (SELECT count(*)::int FROM audit_events) audit_events,
    (SELECT count(*)::int FROM assessments) assessments,
    (SELECT count(*)::int FROM openppwr_schema_migrations) migrations`);
  const isolated = await runtimePool.query('SELECT count(*)::int count FROM packaging');
  assert.equal(isolated.rows[0].count, 0, 'FORCE RLS must hide rows without tenant context');
  // Totals alone cannot tell a restore that put both tenants back from one that put 64 rows back under a
  // single tenant, so the state carries a per-tenant breakdown and the comparison is made on that.
  const perTenant = await admin.query(`SELECT t.slug,
      (SELECT count(*)::int FROM packaging p WHERE p.tenant_id = t.id) packaging,
      (SELECT count(*)::int FROM evidence_files e WHERE e.tenant_id = t.id) evidence_files,
      (SELECT count(*)::int FROM scan_jobs s WHERE s.tenant_id = t.id) scan_jobs,
      (SELECT count(*)::int FROM audit_events a WHERE a.tenant_id = t.id) audit_events,
      (SELECT count(*)::int FROM identities i WHERE i.tenant_id = t.id) identities
    FROM tenants t ORDER BY t.slug`);
  return { ...counts.rows[0], runtimeRowsWithoutTenant: isolated.rows[0].count, perTenant: perTenant.rows };
}

// Row scoping, asked of the database through the request-serving credential rather than of the API.
//
// `openppwr_app` is NOBYPASSRLS and every tenant table is FORCE RLS, so what a connection can see is decided
// by the tenant identifier set on it. Setting one tenant and counting the other's rows is the question the
// restore path actually raises: rows that came back under the wrong tenant would be invisible to the API's
// own queries and perfectly visible here.
async function rowsVisibleUnderTenant(runtimePool, tenantId) {
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [tenantId]);
    const visible = await client.query(`SELECT
      (SELECT count(*)::int FROM packaging) packaging,
      (SELECT count(*)::int FROM evidence_files) evidence_files,
      (SELECT count(*)::int FROM audit_events) audit_events,
      (SELECT count(*)::int FROM packaging WHERE tenant_id <> $1) foreign_packaging,
      (SELECT count(*)::int FROM audit_events WHERE tenant_id <> $1) foreign_audit_events`, [tenantId]);
    await client.query('ROLLBACK');
    return visible.rows[0];
  } finally {
    client.release();
  }
}

const startedAt = new Date();
const adminPassword = randomUUID();
const runtimePassword = randomUUID();
const authPassword = randomUUID();
const workerPassword = randomUUID();
const bootstrapToken = randomUUID();
const databaseName = 'openppwr_recovery';
let embedded;
let app;
let admin;
const report = {
  schemaVersion: '1.0',
  environment: { platform: process.platform, node: process.version, database: 'embedded PostgreSQL 18 test harness', backupType: 'offline physical database and evidence-storage snapshot' },
  startedAt: startedAt.toISOString(),
  status: 'FAIL',
  checks: {},
  findings: [],
  limitations: [
    'Rehearsal uses an isolated local PostgreSQL test cluster, not a production container or managed database.',
    'No N-1 binary or schema is exercised. Migration idempotency and same-version snapshot restoration are not a versioned upgrade/rollback pass.',
    'The second tenant exists only because the worker\'s single-tenant startup guard was overridden with the option its own comment reserves for verification suites. This run says what a two-tenant database does; it is not evidence that a two-tenant deployment is supported.',
    'The backup is a physical snapshot of a stopped cluster plus its evidence directory. It is not the installer\'s encrypted backup set, and nothing here exercises encryption, off-host copying or the operator commands that drive them.',
  ],
};

try {
  await mkdir(sourceDatabaseRoot, { recursive: true });
  const sourcePort = await freePort();
  embedded = cluster({ databaseDir: sourceDatabaseRoot, port: sourcePort, user: 'postgres', password: adminPassword });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase(databaseName);
  const adminUrl = `postgres://postgres:${adminPassword}@127.0.0.1:${sourcePort}/${databaseName}`;
  const url = (role, password) => `postgres://${role}:${password}@127.0.0.1:${sourcePort}/${databaseName}`;
  const runtimeUrl = url('openppwr_app', runtimePassword);
  const authUrl = url('openppwr_auth', authPassword);
  const workerUrl = url('openppwr_worker', workerPassword);
  admin = new Pool({ connectionString: adminUrl, max: 4 });
  await admin.query(`CREATE ROLE openppwr_app LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await migrate(adminUrl);
  // Migrations 014 and 022 create these two as NOLOGIN, because a schema does not know what an installer
  // will call them or what credential it will give them. The installer supplies both; here this does.
  await admin.query(`ALTER ROLE openppwr_auth LOGIN PASSWORD '${authPassword}'`);
  await admin.query(`ALTER ROLE openppwr_worker LOGIN PASSWORD '${workerPassword}'`);
  app = await startApp({ runtimeUrl, authUrl, workerUrl, bootstrapToken, storageRoot: sourceEvidenceRoot });

  const created = await request(app.baseUrl, '/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapToken }, body: '{}' });
  assert.equal(created.response.status, 201);
  const { identities } = created.body;
  const authorization = (role, type = 'application/json') => ({ authorization: `Bearer ${identities[role].token}`, 'content-type': type });
  const imported = await request(app.baseUrl, '/v1/imports', { method: 'POST', headers: { ...authorization('packaging_editor'), 'idempotency-key': 'recovery-json' }, body: JSON.stringify(createAcmeValidJsonImport()) });
  assert.equal(imported.response.status, 201);
  const supplemental = await request(app.baseUrl, '/v1/imports', { method: 'POST', headers: { ...authorization('packaging_editor', 'text/csv'), 'idempotency-key': 'recovery-csv' }, body: createAcmeSupplementalCsv() });
  assert.equal(supplemental.response.status, 201);
  const requirements = await request(app.baseUrl, '/v1/evidence-requirements', { headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } });
  assert.equal(requirements.response.status, 200);
  const requirement = requirements.body.items[0];
  const form = new FormData();
  form.set('requirementId', requirement.id);
  form.set('supplierId', requirement.supplier_id);
  form.set('evidenceType', requirement.evidence_type);
  form.set('file', new Blob([Buffer.from('%PDF-1.4\nSynthetic ACME recovery evidence\n')], { type: 'application/pdf' }), 'synthetic-acme-recovery.pdf');
  const uploaded = await request(app.baseUrl, '/v1/evidence', { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_contributor.token}` }, body: form });
  assert.equal(uploaded.response.status, 202);
  const verified = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.valid, true);
  const tenantA = created.body.tenantId;

  // ---- the second tenant ------------------------------------------------------------------------------
  //
  // Enabled after bootstrap, so the first tenant keeps the shape every earlier rehearsal gave it: operator
  // bearer tokens and no demonstration accounts. The second tenant has to be reached by sign-in, because
  // `provision-synthetic-tenant.mjs` stores the hash of each identity's bearer token and keeps no copy of
  // the token itself — which is the right design and is why the sign-in credential exists at all.
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  process.env.OPENPPWR_DEMO_PASSWORD = DEMO_PASSWORD;
  process.env.OPENPPWR_DEMO_EMAIL_DOMAIN = DEMO_DOMAIN;

  const provisioned = runShippedScript('scripts/acme/provision-synthetic-tenant.mjs',
    [`--slug=${TENANT_B_SLUG}`, `--email-suffix=${TENANT_B_SUFFIX}`],
    {
      OPENPPWR_DEMO_DATABASE_URL: adminUrl,
      OPENPPWR_DEMO_PASSWORD: DEMO_PASSWORD,
      OPENPPWR_DEMO_EMAIL_DOMAIN: DEMO_DOMAIN,
      OPENPPWR_PROVISION_CONFIRM: 'yes',
    });
  assert.match(provisioned, /PROVISION_PASS/u, provisioned);
  const tenantB = /tenant_id=([0-9a-f-]{36})/u.exec(provisioned)?.[1];
  assert.ok(tenantB, `provisioning did not report a tenant identifier: ${provisioned}`);
  assert.notEqual(tenantB, tenantA);

  const signIn = async (role) => {
    const local = role === 'compliance_manager' ? 'demo' : role.replaceAll('_', '-');
    const { response, body } = await request(app.baseUrl, '/v1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${local}${TENANT_B_SUFFIX}@${DEMO_DOMAIN}`, password: DEMO_PASSWORD }),
    });
    assert.equal(response.status, 200, `sign-in failed for ${role}: ${JSON.stringify(body)}`);
    return body.token;
  };
  // Signed in once, and the tokens are carried across the backup and into the restored deployment. The real
  // sign-in budget is ten attempts per quarter hour and this rehearsal keeps it: re-authenticating in every
  // phase would exhaust a limit the product deliberately sets low. That the sessions still work after the
  // restore is a property of the restore, and it is asserted rather than assumed.
  const tenantBTokens = {
    packaging_editor: await signIn('packaging_editor'),
    evidence_contributor: await signIn('evidence_contributor'),
    read_only_auditor: await signIn('read_only_auditor'),
  };

  const importedB = await request(app.baseUrl, '/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${tenantBTokens.packaging_editor}`, 'content-type': 'application/json', 'idempotency-key': 'recovery-json-tenant-b' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(importedB.response.status, 201, JSON.stringify(importedB.body));
  const requirementsB = await request(app.baseUrl, '/v1/evidence-requirements', { headers: { authorization: `Bearer ${tenantBTokens.evidence_contributor}` } });
  assert.equal(requirementsB.response.status, 200);
  const requirementB = requirementsB.body.items[0];
  const formB = new FormData();
  formB.set('requirementId', requirementB.id);
  formB.set('supplierId', requirementB.supplier_id);
  formB.set('evidenceType', requirementB.evidence_type);
  formB.set('file', new Blob([Buffer.from('%PDF-1.4\nSynthetic second-tenant recovery evidence\n')], { type: 'application/pdf' }), 'synthetic-tenant-b-recovery.pdf');
  const uploadedB = await request(app.baseUrl, '/v1/evidence', { method: 'POST', headers: { authorization: `Bearer ${tenantBTokens.evidence_contributor}` }, body: formB });
  assert.equal(uploadedB.response.status, 202, JSON.stringify(uploadedB.body));

  // ---- the audit record ----------------------------------------------------------------------------
  //
  // Each tenant's chain verifies on its own. That was not always true here, and the history is worth
  // keeping rather than deleting: this rehearsal originally found that the hash chain was one global
  // sequence while verification was tenant-scoped, so the second tenant's first event carried the first
  // tenant's last hash and its own verification reported `valid: false` with nothing tampered.
  // `packages/database/migrations/037_audit_chain_per_tenant.sql` scopes the chain link to the tenant that
  // wrote it, and what this rehearsal now demonstrates is the fix rather than the defect: two tenants
  // provisioned into the same database each start from their own `GENESIS` and neither's verification
  // depends on the other having written anything at all.
  const verifiedB = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${tenantBTokens.read_only_auditor}` } });
  assert.equal(verifiedB.response.status, 200);
  const chainLink = await admin.query(`
    SELECT b.event_id AS second_tenant_first_event, b.previous_hash, a.event_hash AS first_tenant_hash_at_that_point,
           a.tenant_id AS linked_to_tenant
      FROM (SELECT event_id, previous_hash, sequence FROM audit_events WHERE tenant_id=$1 ORDER BY sequence LIMIT 1) b
      LEFT JOIN audit_events a ON a.event_hash = b.previous_hash`, [tenantB]);
  assert.equal(chainLink.rowCount, 1, 'the second tenant must have written at least one event');
  assert.equal(chainLink.rows[0].previous_hash, 'GENESIS',
    'the second tenant\'s chain must start from its own genesis, not from a hash the first tenant wrote');
  assert.equal(chainLink.rows[0].linked_to_tenant, null,
    'no event should exist whose hash the second tenant\'s first event happens to name — GENESIS is a constant, not a lookup');
  assert.equal(verifiedB.body.valid, true,
    'each tenant\'s chain must verify independently once the link is scoped to the tenant that wrote it');
  assert.equal(verifiedB.body.failedEventId, undefined, 'a valid chain reports no failed event');

  // The worker credential for the second tenant, issued the way an operator would issue it: to a file with
  // mode 0600, never to stdout, by the script the product ships for it.
  const issued = runShippedScript('scripts/acme/issue-worker-token.mjs',
    [`--slug=${TENANT_B_SLUG}`, `--out=${workerTokenFile}`],
    { OPENPPWR_DEMO_DATABASE_URL: adminUrl, OPENPPWR_ISSUE_CONFIRM: 'yes' });
  assert.match(issued, /ISSUE_WORKER_TOKEN_PASS/u, issued);
  assert.match(issued, /token_printed=no/u, 'the issuing script must not print the credential');
  // The pattern is named rather than written inline at the assignment. Inline, the line reads to the
  // public-export validator as a credential noun assigned an unquoted run of characters — which is what a
  // leaked credential looks like, so the rule is right to refuse it. Naming the pattern keeps the rule
  // strict and this line honest. The same trap catches the comment explaining it, so the shape is not
  // written out here either.
  const workerTokenPattern = /OPENPPWR_WORKER_TOKEN=(\S+)/u;
  const tenantBWorkerToken = workerTokenPattern.exec(await readFile(workerTokenFile, 'utf8'))?.[1];
  assert.ok(tenantBWorkerToken, 'no worker token was written');

  const beforeBackup = await databaseState(admin, app.pool);
  assert.equal(beforeBackup.tenants, 2);
  // Deliberately unequal: the first tenant also imported the supplemental CSV and the second did not. Two
  // tenants holding identical row counts would let a restore that merged or swapped them produce numbers
  // that still add up.
  assert.equal(beforeBackup.packaging, 60);
  assert.deepEqual(beforeBackup.perTenant.map((row) => [row.slug, row.packaging, row.evidence_files, row.scan_jobs]), [
    [TENANT_B_SLUG, 28, 1, 1],
    ['acme-eu-demo', 32, 1, 1],
  ]);
  report.checks.twoTenantSource = {
    status: 'PASS',
    tenants: beforeBackup.perTenant.map((row) => row.slug),
    provisionedBy: 'scripts/acme/provision-synthetic-tenant.mjs',
    workerCredentialIssuedBy: 'scripts/acme/issue-worker-token.mjs',
    perTenant: beforeBackup.perTenant,
    auditChainPerTenantBeforeBackup: {
      'acme-eu-demo': { valid: verified.body.valid, events: verified.body.count },
      [TENANT_B_SLUG]: { valid: verifiedB.body.valid, events: verifiedB.body.count, failedEventId: verifiedB.body.failedEventId },
    },
  };

  await app.stop();
  app = undefined;
  await admin.query('CHECKPOINT');
  await admin.end();
  admin = undefined;
  await embedded.stop();
  embedded = undefined;

  await cp(sourceDatabaseRoot, backupDatabaseRoot, { recursive: true, force: false });
  await cp(sourceEvidenceRoot, backupEvidenceRoot, { recursive: true, force: false });
  const databaseBackupManifest = await manifest(backupDatabaseRoot);
  const evidenceBackupManifest = await manifest(backupEvidenceRoot);
  assert.ok(databaseBackupManifest.files > 0);
  assert.ok(evidenceBackupManifest.files > 0);
  report.checks.backup = { status: 'PASS', database: databaseBackupManifest, evidence: evidenceBackupManifest, state: beforeBackup };

  await cp(backupDatabaseRoot, restoredDatabaseRoot, { recursive: true, force: false });
  await cp(backupEvidenceRoot, restoredEvidenceRoot, { recursive: true, force: false });
  assert.deepEqual(await manifest(restoredDatabaseRoot), databaseBackupManifest);
  assert.deepEqual(await manifest(restoredEvidenceRoot), evidenceBackupManifest);
  const restoredPort = await freePort();
  embedded = await startExistingCluster(restoredDatabaseRoot, restoredPort, adminPassword);
  const restoredAdminUrl = `postgres://postgres:${adminPassword}@127.0.0.1:${restoredPort}/${databaseName}`;
  const restoredUrl = (role, password) => `postgres://${role}:${password}@127.0.0.1:${restoredPort}/${databaseName}`;
  admin = new Pool({ connectionString: restoredAdminUrl, max: 4 });
  app = await startApp({
    runtimeUrl: restoredUrl('openppwr_app', runtimePassword),
    authUrl: restoredUrl('openppwr_auth', authPassword),
    workerUrl: restoredUrl('openppwr_worker', workerPassword),
    bootstrapToken,
    storageRoot: restoredEvidenceRoot,
  });
  const restoredAudit = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(restoredAudit.body.valid, true);
  const restoredState = await databaseState(admin, app.pool);
  assert.deepEqual(restoredState, beforeBackup);
  report.checks.restore = { status: 'PASS', state: restoredState, auditEvents: restoredAudit.body.count, snapshotManifestsMatchedBeforeStartup: true };

  // ---- what the restore has to prove once there are two tenants ---------------------------------------
  //
  // Equal totals are not enough. A restore that put every row back under one tenant would produce exactly
  // the same totals, so the questions are asked per tenant and from inside the boundary.

  // 1. Each tenant's rows are still that tenant's. Asked through the request-serving credential, which is
  //    NOBYPASSRLS, so the answer is the database's rather than this script's.
  const visibleToA = await rowsVisibleUnderTenant(app.pool, tenantA);
  const visibleToB = await rowsVisibleUnderTenant(app.pool, tenantB);
  assert.equal(visibleToA.packaging, 32);
  assert.equal(visibleToB.packaging, 28);
  assert.equal(visibleToA.foreign_packaging, 0, 'a connection scoped to the first tenant must see none of the second tenant\'s packaging');
  assert.equal(visibleToB.foreign_packaging, 0, 'a connection scoped to the second tenant must see none of the first tenant\'s packaging');
  assert.equal(visibleToA.foreign_audit_events, 0);
  assert.equal(visibleToB.foreign_audit_events, 0);
  assert.equal(visibleToA.audit_events + visibleToB.audit_events, restoredState.audit_events,
    'every restored audit event belongs to exactly one tenant');

  // 2. The audit record comes back for both tenants, and each tenant's verification answers exactly what it
  //    answered before the backup — both tenants valid, independently. The claim being made here is the one
  //    the restore can actually support: verification is unchanged by taking a backup and putting it back.
  //    The sessions used were issued before the backup, so this also settles whether a restored deployment
  //    still honours the credentials that existed when it was taken.
  const restoredAuditB = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${tenantBTokens.read_only_auditor}` } });
  assert.equal(restoredAuditB.response.status, 200, 'a session issued before the backup must still work after the restore');
  assert.equal(restoredAudit.body.valid, verified.body.valid);
  assert.equal(restoredAudit.body.head, verified.body.head, 'the first tenant\'s chain head must survive the restore unchanged');
  assert.equal(restoredAudit.body.count, verified.body.count);
  assert.equal(restoredAuditB.body.valid, verifiedB.body.valid);
  assert.equal(restoredAuditB.body.failedEventId, verifiedB.body.failedEventId,
    'the restore must not move where the second tenant\'s verification stops');
  assert.equal(restoredAuditB.body.count, verifiedB.body.count);
  assert.equal(restoredAudit.body.count + restoredAuditB.body.count, restoredState.audit_events,
    'the two tenants together must account for the restored record exactly once');

  // 3. A credential from one tenant still cannot reach the other's data after a restore. The identifier is
  //    real and belongs to the other tenant — a random one would prove only that an absent row is absent.
  const foreignPackaging = (await admin.query('SELECT id FROM packaging WHERE tenant_id=$1 LIMIT 1', [tenantB])).rows[0].id;
  const reachedAcross = await request(app.baseUrl, `/v1/packaging/${foreignPackaging}`, { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(reachedAcross.response.status, 404, 'the first tenant reached one of the second tenant\'s packaging records after the restore');

  // 4. Both tenants' evidence files came back, under their own directories. The manifest above proves the
  //    bytes are identical; this proves they are filed under the tenant that owns them.
  const storedFiles = await admin.query('SELECT tenant_id, storage_key FROM evidence_files ORDER BY tenant_id');
  assert.equal(storedFiles.rowCount, 2);
  for (const row of storedFiles.rows) {
    assert.ok(row.storage_key.includes(row.tenant_id), `evidence storage key ${row.storage_key} is not scoped to its tenant`);
    await stat(resolve(restoredEvidenceRoot, row.storage_key));
  }
  report.checks.twoTenantRestore = {
    status: 'PASS',
    visibleToFirstTenant: visibleToA,
    visibleToSecondTenant: visibleToB,
    auditVerificationUnchangedByRestore: {
      'acme-eu-demo': { valid: restoredAudit.body.valid, events: restoredAudit.body.count },
      [TENANT_B_SLUG]: { valid: restoredAuditB.body.valid, events: restoredAuditB.body.count, failedEventId: restoredAuditB.body.failedEventId },
    },
    crossTenantReadAfterRestore: reachedAcross.response.status,
    evidenceFilesRestoredUnderOwningTenant: storedFiles.rowCount,
    sessionsIssuedBeforeBackupStillValid: true,
  };

  // ---- the background-job path ------------------------------------------------------------------------
  //
  // The guard first. A worker started against this database refuses, and that refusal is the supported
  // behaviour: one worker holds one tenant's credential and would leave every other tenant's evidence
  // pending for ever. Asserting it here keeps the rest of this section honest about what it is doing.
  await assert.rejects(
    () => assertSingleTenantDeployment(app.workerPool),
    (error) => error.code === 'WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED',
    'the worker must refuse to start against a database holding two tenants',
  );
  const overridden = await assertSingleTenantDeployment(app.workerPool, { allowMultiTenantDatabase: true });
  assert.deepEqual(overridden, { tenants: 2, enforced: false });

  // With the refusal overridden, the question the restore raises can be asked: does a worker holding one
  // tenant's credential touch the other tenant's queue? Each tenant has exactly one scan job, both still
  // pending, both restored from the backup.
  const workerA = await createVerifiedContext(app.pool, identities.worker.token);
  const workerB = await createVerifiedContext(app.pool, tenantBWorkerToken);
  assert.equal(workerA.tenantId, tenantA);
  assert.equal(workerB.tenantId, tenantB);

  const queueBeforeA = await scanQueueSnapshot(app.workerPool, workerA);
  const queueBeforeB = await scanQueueSnapshot(app.workerPool, workerB);
  assert.equal(queueBeforeA.pending, 1, 'each worker must see only its own tenant\'s queue');
  assert.equal(queueBeforeB.pending, 1);

  // A stub verdict scanner, which is product code rather than a test double: what is under test here is
  // which rows a worker may claim, not what ClamAV says about the bytes.
  // `runtime: 'test'` is the only value it accepts — the constructor refuses anything else, so a
  // deterministic verdict cannot be reached from a deployed process by naming it something plausible.
  const scanner = new VerdictStubScanner({ runtime: 'test' });
  const processedByA = await processNextScanJob({ pool: app.workerPool, identity: workerA, storageRoot: restoredEvidenceRoot, scanner });
  assert.equal(processedByA.scanStatus, 'clean');
  const claimedByA = await admin.query('SELECT tenant_id FROM scan_jobs WHERE status=$1', ['completed']);
  assert.equal(claimedByA.rowCount, 1);
  assert.equal(claimedByA.rows[0].tenant_id, tenantA, 'the first tenant\'s worker processed a job belonging to another tenant');

  // The first tenant's worker now has nothing left, while the second tenant's job is untouched. A worker
  // that reached across would have drained both and this would return a job.
  const exhausted = await processNextScanJob({ pool: app.workerPool, identity: workerA, storageRoot: restoredEvidenceRoot, scanner });
  assert.equal(exhausted, null, 'the first tenant\'s worker found more work than its own tenant had');
  const stillPendingForB = await scanQueueSnapshot(app.workerPool, workerB);
  assert.equal(stillPendingForB.pending, 1, 'the second tenant\'s queue was consumed by the first tenant\'s worker');

  const processedByB = await processNextScanJob({ pool: app.workerPool, identity: workerB, storageRoot: restoredEvidenceRoot, scanner });
  assert.equal(processedByB.scanStatus, 'clean');
  const claimedByB = await admin.query('SELECT tenant_id FROM scan_jobs WHERE status=$1 ORDER BY tenant_id', ['completed']);
  assert.equal(claimedByB.rowCount, 2);
  assert.deepEqual([...new Set(claimedByB.rows.map((row) => row.tenant_id))].sort(), [tenantA, tenantB].sort());
  report.checks.twoTenantWorkerIsolation = {
    status: 'PASS',
    startupGuardRefusesTwoTenants: true,
    documentedOverride: 'OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE',
    queueVisibleToEachWorker: { first: queueBeforeA.pending, second: queueBeforeB.pending },
    firstWorkerClaimedOwnTenantOnly: true,
    secondTenantQueueUntouchedByFirstWorker: stillPendingForB.pending,
    bothJobsProcessedByTheirOwnWorker: claimedByB.rowCount,
  };

  const migrationsBefore = restoredState.migrations;
  await migrate(restoredAdminUrl);
  const health = await request(app.baseUrl, '/health');
  assert.equal(health.response.status, 200);
  const assessed = await request(app.baseUrl, '/v1/assessments/run', { method: 'POST', headers: authorization('compliance_manager'), body: '{}' });
  assert.equal(assessed.response.status, 201);
  const upgradedState = await databaseState(admin, app.pool);
  assert.equal(upgradedState.migrations, migrationsBefore);
  assert.ok(upgradedState.assessments > beforeBackup.assessments);
  assert.ok(upgradedState.audit_events > beforeBackup.audit_events);
  report.checks.migrationAndForwardSmoke = { status: 'PASS', migrationsIdempotent: true, healthStatus: health.response.status, state: upgradedState };

  await app.stop();
  app = undefined;
  await admin.query('CHECKPOINT');
  await admin.end();
  admin = undefined;
  await embedded.stop();
  embedded = undefined;

  await cp(backupDatabaseRoot, rollbackDatabaseRoot, { recursive: true, force: false });
  await cp(backupEvidenceRoot, rollbackEvidenceRoot, { recursive: true, force: false });
  const rollbackPort = await freePort();
  embedded = await startExistingCluster(rollbackDatabaseRoot, rollbackPort, adminPassword);
  const rollbackAdminUrl = `postgres://postgres:${adminPassword}@127.0.0.1:${rollbackPort}/${databaseName}`;
  const rollbackUrl = (role, password) => `postgres://${role}:${password}@127.0.0.1:${rollbackPort}/${databaseName}`;
  admin = new Pool({ connectionString: rollbackAdminUrl, max: 4 });
  app = await startApp({
    runtimeUrl: rollbackUrl('openppwr_app', runtimePassword),
    authUrl: rollbackUrl('openppwr_auth', authPassword),
    workerUrl: rollbackUrl('openppwr_worker', workerPassword),
    bootstrapToken,
    storageRoot: rollbackEvidenceRoot,
  });
  const rollbackHealth = await request(app.baseUrl, '/health');
  assert.equal(rollbackHealth.response.status, 200);
  const rollbackAudit = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(rollbackAudit.body.valid, true);
  // The second tenant comes back from the snapshot too, with its own chain intact and its scan job pending
  // again — the work the restored deployment did to it is gone, which is what a rollback means.
  const rollbackAuditB = await request(app.baseUrl, '/v1/audit/verify', { headers: { authorization: `Bearer ${tenantBTokens.read_only_auditor}` } });
  assert.equal(rollbackAuditB.response.status, 200);
  assert.equal(rollbackAuditB.body.count, verifiedB.body.count, 'the second tenant\'s record must come back whole');
  assert.equal(rollbackAuditB.body.failedEventId, verifiedB.body.failedEventId);
  const rollbackState = await databaseState(admin, app.pool);
  assert.deepEqual(rollbackState, beforeBackup);
  const rollbackPending = await admin.query(`SELECT count(*)::int AS pending FROM scan_jobs WHERE status='pending'`);
  assert.equal(rollbackPending.rows[0].pending, 2, 'the rolled-back snapshot must still hold both tenants\' unprocessed work');
  report.checks.snapshotRestoreAfterCandidateWrites = {
    status: 'PASS',
    healthStatus: rollbackHealth.response.status,
    auditEvents: rollbackAudit.body.count,
    auditEventsSecondTenant: rollbackAuditB.body.count,
    secondTenantVerificationUnchanged: rollbackAuditB.body.valid === verifiedB.body.valid,
    pendingScanJobsRestored: rollbackPending.rows[0].pending,
    state: rollbackState,
  };
  report.status = 'PASS';
} finally {
  await app?.stop().catch(() => {});
  await admin?.end().catch(() => {});
  await embedded?.stop().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.durationSeconds = Number(((new Date() - startedAt) / 1000).toFixed(3));
  await mkdir(resolve('artifacts', 'release'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

for (const finding of report.findings || []) console.log(`RECOVERY_REHEARSAL_FINDING ${finding.id}: ${finding.observed}`);
console.log(`RECOVERY_REHEARSAL_${report.status} findings=${(report.findings || []).length} report=${reportPath} duration=${report.durationSeconds}s`);

// Explicit exit, replacing a `process.exitCode = 1` that could never have taken effect.
//
// `embedded-postgres` registers an `async-exit-hook` at import time, and that hook's `beforeExit` handler
// ends the process with `process.exit(0)` so it can stop clusters first. An explicit code beats
// `process.exitCode`, so in any script that imports it — directly or through the test harness — assigning
// `process.exitCode` and letting the loop drain exits 0. Measured on this host: `process.exitCode = 1` set
// after an embedded cluster lifecycle exits 0.
//
// **This file was not actually reporting failures as successes**, and the distinction is worth stating
// rather than claiming a bug that was not there: every failure path here throws, an uncaught exception
// takes the hook's other branch, and that one passes 1. So the old line was dead code rather than a hole.
// It becomes a hole the moment anyone adds a `catch` that records a failure instead of rethrowing, which is
// an ordinary thing to add, so the exit code is now stated where it is decided.
// `scripts/security/supplier-isolation-matrix.mjs` exits explicitly already, for a related reason.
await new Promise((flushed) => process.stdout.write('', flushed));
process.exit(report.status === 'PASS' ? 0 : 1);
