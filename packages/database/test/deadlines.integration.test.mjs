// Database deadlines: the ones a deployment can set, and the two that ship with a default.
//
// Most of what is asserted here is the mechanism, not a number: that the two statement classes are
// genuinely separate, that a deadline cannot escape the transaction that set it, and that an operator who
// has measured their own deployment can act on what they measured. That remains true for INTERACTIVE and
// CHECKOUT — neither has a value this repository chose. EXTENDED is the exception: it now ships a real
// default, derived from a representative-tenant measurement (3 000 packaging records, 18 338 audit events;
// see the comment above `DEADLINE_VARIABLES` in `../src/index.mjs`) rather than the 32-record ACME fixture
// this file used to cite, and the tests below that reference it assert the shipped value stays exactly
// what that measurement produced.
//
// The previous state of this file was that it did not exist. `createPool()` set only `max` and
// `idleTimeoutMillis`, `migrate.mjs` and `prepare.mjs` built raw unbounded `Client`s, and the environment
// overrides that were meant to make any of it tunable were never declared in the shipped compose file, so
// an installer deployment could not have set one even if the code had read it.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, databaseDeadlines, migrate, withTenantTransaction } from '../src/index.mjs';
import { migrationConnectTimeoutMs } from '../src/migrate.mjs';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

const COMPOSE = resolve(import.meta.dirname, '../../../deploy/community/docker-compose.yml');
const VARIABLES = [
  'OPENPPWR_DB_CHECKOUT_TIMEOUT_MS',
  'OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS',
  'OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS',
];

let database;
const context = { tenantId: randomUUID(), actorId: randomUUID() };

function configure(values = {}) {
  for (const name of [...VARIABLES, 'OPENPPWR_DB_CONNECT_TIMEOUT_MS']) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

before(async () => {
  database = await startTestDatabase('database-deadlines');
  await migrate(database.adminUrl);
});

after(async () => {
  configure();
  await database?.stop();
});

test('absent means unbounded, which is what this deployment did before these existed', () => {
  assert.deepEqual(databaseDeadlines({}), { checkoutMs: null, interactiveStatementMs: null, extendedStatementMs: null });
  // An empty value is what compose passes for a variable the operator left unset, and it must read as
  // absent rather than as zero.
  assert.equal(databaseDeadlines({ OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: '' }).checkoutMs, null);
});

// A deadline silently discarded because it was written the way a person writes durations is worse than no
// deadline, because the operator believes they have one.
test('a value that is not a positive whole number of milliseconds is refused, by name', () => {
  for (const bad of ['30s', '0', '-1', '1.5', 'yes']) {
    assert.throws(
      () => databaseDeadlines({ OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: bad }),
      /OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS must be a positive whole number of milliseconds/u,
      `${bad} was accepted`,
    );
  }
});

// The database cancels the statement. A client-side race would abandon the wait while the statement kept
// running on the server, holding whatever it holds — which is why the code sets `statement_timeout` rather
// than wrapping the query in a Promise.race.
test('a statement past the interactive deadline is cancelled by the database', async () => {
  configure({ OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: '250' });
  const pool = createPool(database.runtimeUrl);
  try {
    await assert.rejects(
      withTenantTransaction(pool, context, (client) => client.query('SELECT pg_sleep(3)')),
      (error) => {
        assert.equal(error.code, '57014', 'PostgreSQL must be the one cancelling it');
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

// The whole point of the two classes. One number across both is the shape that was rejected: an interactive
// read and a review freeze do not belong under the same bound.
test('the extended class is bounded separately from the interactive one', async () => {
  configure({
    OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: '250',
    OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS: '20000',
  });
  const pool = createPool(database.runtimeUrl);
  try {
    // Work the interactive bound would have killed, in the class the long operations declare.
    const result = await withTenantTransaction(pool, context, (client) => client.query('SELECT pg_sleep(1) AS slept'), { deadline: 'extended' });
    assert.equal(result.rowCount, 1);
    // The same work, unmarked, is bounded by the interactive value.
    await assert.rejects(withTenantTransaction(pool, context, (client) => client.query('SELECT pg_sleep(1)')), { code: '57014' });
  } finally {
    await pool.end();
  }
});

// `SET LOCAL` reverts with the transaction. Without that, a deadline set for one operation would ride the
// pooled connection into the next caller's work, and a pool of ten connections would develop ten different
// personalities depending on what had used them last.
test('a deadline does not survive the transaction that set it', async () => {
  configure({ OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: '250' });
  const pool = createPool(database.runtimeUrl);
  try {
    await withTenantTransaction(pool, context, (client) => client.query('SELECT 1'));
    const setting = await pool.query('SHOW statement_timeout');
    assert.equal(setting.rows[0].statement_timeout, '0', 'the deadline leaked onto the pooled connection');
  } finally {
    await pool.end();
  }
});

test('an unknown deadline class is refused rather than treated as the default', async () => {
  configure();
  const pool = createPool(database.runtimeUrl);
  try {
    await assert.rejects(
      withTenantTransaction(pool, context, (client) => client.query('SELECT 1'), { deadline: 'quick' }),
      /Unknown transaction deadline class: quick/u,
    );
  } finally {
    await pool.end();
  }
});

// The checkout bound, and the reason it ships unset. `max` is 10, so the eleventh caller is not stuck — it
// is queued. Both halves are asserted because the second is the argument for the default.
test('the checkout deadline bounds waiting for a connection, and its absence lets a caller queue', async () => {
  configure({ OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: '200' });
  const bounded = createPool(database.runtimeUrl);
  const held = [];
  try {
    for (let index = 0; index < 10; index += 1) held.push(await bounded.connect());
    await assert.rejects(bounded.connect(), /timeout exceeded when trying to connect/u);
  } finally {
    for (const client of held) client.release();
    await bounded.end();
  }

  configure();
  const unbounded = createPool(database.runtimeUrl);
  const heldAgain = [];
  try {
    for (let index = 0; index < 10; index += 1) heldAgain.push(await unbounded.connect());
    const queued = unbounded.connect();
    setTimeout(() => heldAgain[0].release(), 150);
    const eleventh = await queued;
    // Served rather than refused. This is the behaviour a blanket checkout deadline took away, and it is
    // why the shipped default is no deadline at all.
    assert.ok(eleventh);
    eleventh.release();
    for (const client of heldAgain.slice(1)) client.release();
  } finally {
    await unbounded.end();
  }
});

// The one default this package ships. It bounds establishing a connection, which cannot cancel a migration:
// a raw Client has no checkout queue to starve and no statement in flight to abort.
test('the migration connect deadline defaults, validates, and is overridable', () => {
  assert.equal(migrationConnectTimeoutMs({}), 30_000);
  assert.equal(migrationConnectTimeoutMs({ OPENPPWR_DB_CONNECT_TIMEOUT_MS: '5000' }), 5000);
  assert.throws(() => migrationConnectTimeoutMs({ OPENPPWR_DB_CONNECT_TIMEOUT_MS: '30s' }), /positive whole number/u);
});

// The failure the default exists for: a listener that accepts the TCP connection and then says nothing.
// Unbounded, this waits forever — an installer step with no output, no error and no end.
test('a migration against a database that accepts and never answers fails instead of hanging', async () => {
  // Held so they can be destroyed. The driver abandons the *wait* when a connect deadline expires and does
  // not destroy the socket it opened, so `server.close()` — which waits for every live connection — never
  // returns. That hung this test forever when it closed politely, which is a smaller instance of exactly
  // the failure the deadline exists to prevent.
  const connections = new Set();
  const silent = createServer((socket) => { connections.add(socket); });
  await new Promise((listening) => silent.listen(0, '127.0.0.1', listening));
  const { port } = silent.address();
  configure({ OPENPPWR_DB_CONNECT_TIMEOUT_MS: '400' });
  const started = Date.now();
  try {
    await assert.rejects(migrate(`postgres://openppwr_migrator:unused@127.0.0.1:${port}/openppwr`), /timeout expired/u);
    assert.ok(Date.now() - started < 10_000, `the connection attempt was not bounded (${Date.now() - started}ms)`);
  } finally {
    configure();
    for (const socket of connections) socket.destroy();
    await new Promise((closed) => silent.close(closed));
  }
});

// Half the reason this risk stayed open was not the code. `--env-file` only supplies values for compose's
// own interpolation and never injects a variable into a container, so a deadline the code reads is a
// deadline no installer deployment can set until it is declared here.
//
// EXTENDED and CHECKOUT now carry real defaults in the compose interpolation itself. EXTENDED is measured
// against a representative tenant (3 000 packaging records, 18 338 audit events; see the comment above
// `DEADLINE_VARIABLES` in `../src/index.mjs` for the full measurement). CHECKOUT is not a measurement of
// any deployment's own concurrency — it cannot be, from here — but a deliberately conservative default the
// owner chose over shipping none at all; see the comment next to it in
// `deploy/community/docker-compose.yml` for the reasoning (roughly 3x the ~10 s an extended operation can
// hold a connection at this tenant's size). Both expected patterns are asserted here; INTERACTIVE still
// ships absent.
const SHIPPED_COMPOSE_DEFAULTS = {
  OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS: '2000',
  OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: '30000',
};

test('every deadline the code reads is declared in the shipped compose file', async () => {
  const compose = await readFile(COMPOSE, 'utf8');
  const services = compose.split(/\n {2}(?=\w[\w-]*:\n)/u);
  const serviceNamed = (name) => services.find((block) => block.trimStart().startsWith(`${name}:`));
  for (const service of ['api', 'worker']) {
    const block = serviceNamed(service);
    assert.ok(block, `${service} is missing from the compose file`);
    for (const variable of VARIABLES) {
      const expectedDefault = SHIPPED_COMPOSE_DEFAULTS[variable] ?? '';
      assert.ok(block.includes(`${variable}: \${${variable}:-${expectedDefault}}`), `${service} does not pass ${variable} through with the expected default`);
    }
  }
  const migrateBlock = serviceNamed('migrate');
  assert.ok(migrateBlock.includes('OPENPPWR_DB_CONNECT_TIMEOUT_MS: ${OPENPPWR_DB_CONNECT_TIMEOUT_MS:-}'), 'the migration step cannot be given a connect deadline');
});

// The one thing `databaseDeadlines()` itself does not know is that compose supplies a default for
// EXTENDED — it treats every variable's absence the same way, by design (see the comment above
// `DEADLINE_VARIABLES`). What has to be true instead is that the exact string compose would inject
// parses cleanly and lands inside the bounds the function already enforces: a positive whole number of
// milliseconds, refused otherwise.
test('the shipped EXTENDED default is a positive whole number of milliseconds databaseDeadlines() accepts', () => {
  const shipped = SHIPPED_COMPOSE_DEFAULTS.OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS;
  const resolved = databaseDeadlines({ OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS: shipped });
  assert.equal(resolved.extendedStatementMs, Number(shipped));
  assert.ok(Number.isInteger(resolved.extendedStatementMs) && resolved.extendedStatementMs > 0);
  // INTERACTIVE carries no shipped default and must still resolve to unbounded when compose passes
  // through the empty string an unset `.env` variable produces.
  assert.deepEqual(databaseDeadlines({ OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS: shipped, OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: '', OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: '' }),
    { checkoutMs: null, interactiveStatementMs: null, extendedStatementMs: Number(shipped) });
});

// The same standard applied to the one other shipped default. Not a measurement of any deployment's own
// concurrency — see the comment next to OPENPPWR_DB_CHECKOUT_TIMEOUT_MS in
// deploy/community/docker-compose.yml for why that cannot be produced from here — but still a value this
// repository chose and ships, and it must parse the same way an operator's own override would.
test('the shipped CHECKOUT default is a positive whole number of milliseconds databaseDeadlines() accepts', () => {
  const shipped = SHIPPED_COMPOSE_DEFAULTS.OPENPPWR_DB_CHECKOUT_TIMEOUT_MS;
  const resolved = databaseDeadlines({ OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: shipped });
  assert.equal(resolved.checkoutMs, Number(shipped));
  assert.ok(Number.isInteger(resolved.checkoutMs) && resolved.checkoutMs > 0);
  // Both shipped defaults together, with INTERACTIVE passed through empty exactly as compose would for an
  // unset `.env` variable, must still resolve to unbounded for that one class alone.
  assert.deepEqual(
    databaseDeadlines({
      OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS: SHIPPED_COMPOSE_DEFAULTS.OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS,
      OPENPPWR_DB_CHECKOUT_TIMEOUT_MS: shipped,
      OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS: '',
    }),
    { checkoutMs: Number(shipped), interactiveStatementMs: null, extendedStatementMs: Number(SHIPPED_COMPOSE_DEFAULTS.OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS) },
  );
});
