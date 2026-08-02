// What `/v1/version` says about the schema, checked against the schema.
//
// The route reported `migrationLevel` from `OPENPPWR_MIGRATION_LEVEL`, an argument baked into the image at
// build time, and nothing compared it to the database. Both halves of that failed silently: an image built
// with the wrong build argument reported the wrong level confidently, and so would a deployment whose
// migration run stopped partway. The number a reader used to decide which schema a deployment was on was
// the one number nothing verified.
//
// These tests do not assert that the two agree — they agree in a correctly built deployment, which is
// exactly why an agreement test proves nothing about the mechanism. They assert that the reported applied
// level comes from `openppwr_schema_migrations`, and that a deliberately wrong build argument is reported
// as a disagreement rather than accepted as the truth.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { appliedMigrationLevel, createPool, migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, migrationLevelFinding } from '../src/app.mjs';

let database;
let pool;
let server;
let baseUrl;
let declaredBefore;

async function jsonRequest(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json().catch(() => null) };
}

before(async () => {
  declaredBefore = process.env.OPENPPWR_MIGRATION_LEVEL;
  database = await startTestDatabase('api-version-reporting');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const app = createApp({
    pool,
    bootstrapToken: randomUUID(),
    storageRoot: resolve('.runtime-test', `version-${randomUUID()}`),
  });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (declaredBefore === undefined) delete process.env.OPENPPWR_MIGRATION_LEVEL;
  else process.env.OPENPPWR_MIGRATION_LEVEL = declaredBefore;
  await new Promise((closed) => { if (server) server.close(closed); else closed(); });
  await pool?.end();
  await database?.stop();
});

// The request-serving principal could not read the table at all before migration 036: the request pool
// connects as `openppwr_app`, and `openppwr_schema_migrations` is created and written by the migration
// principal with no grant to anyone else.
test('the request-serving principal can read the applied migration level', async () => {
  const applied = await appliedMigrationLevel(pool);
  const highest = (await database.admin.query('SELECT name FROM openppwr_schema_migrations ORDER BY name DESC LIMIT 1')).rows[0].name;
  assert.equal(applied, /^(\d+)/u.exec(highest)[1]);
});

test('the reported applied level is the one the database holds, not the one the image declares', async () => {
  // A build argument that is wrong in the way this risk describes: an image built claiming a level the
  // database does not carry. The correct report names both and does not adopt the claim.
  process.env.OPENPPWR_MIGRATION_LEVEL = '001';
  const { response, body } = await jsonRequest('/v1/version');
  assert.equal(response.status, 200);
  assert.equal(body.migrationLevel, '001', 'the declared level is still reported as declared');
  const applied = await appliedMigrationLevel(pool);
  assert.equal(body.appliedMigrationLevel, applied, 'the applied level must come from the database');
  assert.notEqual(body.appliedMigrationLevel, body.migrationLevel);
  assert.equal(body.migrationLevelVerified, false, 'a disagreement must be reported as one');
});

test('a build argument that matches the database is reported as verified', async () => {
  process.env.OPENPPWR_MIGRATION_LEVEL = await appliedMigrationLevel(pool);
  const { body } = await jsonRequest('/v1/version');
  assert.equal(body.migrationLevelVerified, true);
  assert.equal(body.appliedMigrationLevel, body.migrationLevel);
});

// The route is the one an operator reaches for while diagnosing, and it is unauthenticated so that they can
// reach it without a credential. Neither property survives a route that fails with the database.
test('the version route still answers when the applied level cannot be read', async () => {
  const failing = { query: async () => { throw new Error('relation "openppwr_schema_migrations" does not exist'); } };
  const isolated = createApp({ pool: failing, bootstrapToken: randomUUID(), storageRoot: resolve('.runtime-test', `version-degraded-${randomUUID()}`), rateLimiterFactory: () => () => (_request, _response, next) => next() });
  const listener = await new Promise((listening) => { const started = isolated.listen(0, '127.0.0.1', () => listening(started)); });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/v1/version`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.appliedMigrationLevel, 'unknown');
    assert.equal(body.migrationLevelVerified, false);
    // Whatever the database said about itself stays inside this process. The route is public.
    assert.ok(!/relation|does not exist|openppwr_schema_migrations/u.test(JSON.stringify(body)), 'the failure detail must not be published');
  } finally {
    await new Promise((closed) => listener.close(closed));
  }
});

// The startup rule, exercised against the real levels this database reports rather than only as a unit.
test('a database behind the image is fatal and a database ahead of it is not', async () => {
  const applied = await appliedMigrationLevel(pool);
  const ahead = String(Number(applied) + 1).padStart(3, '0');
  const behind = String(Number(applied) - 1).padStart(3, '0');
  assert.equal(migrationLevelFinding(applied, applied), null);
  assert.equal(migrationLevelFinding(ahead, applied).fatal, true, 'the schema this build requires is not applied');
  assert.equal(migrationLevelFinding(behind, applied).fatal, false, 'an upgrade window and a rollback must not be refused');
});
