import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let server;
let baseUrl;
let identities;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

before(async () => {
  database = await startTestDatabase('api-import');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await request('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: JSON.stringify({}) });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve));
  await pool?.end();
  await database?.stop();
});

test('invalid import reports all eight rows and writes no domain data', async () => {
  const result = await request('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'invalid-acme-v1' },
    body: JSON.stringify(createAcmeInvalidImport()),
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.body.status, 'rejected');
  assert.equal(result.body.totalRows, 8);
  assert.equal(result.body.rejectedRows, 8);
  const counts = await database.admin.query('SELECT (SELECT count(*)::int FROM packaging) packaging, (SELECT count(*)::int FROM materials) materials, (SELECT count(*)::int FROM components) components');
  assert.deepEqual(counts.rows[0], { packaging: 0, materials: 0, components: 0 });
});

test('valid JSON and CSV imports persist once with exact ACME totals', async () => {
  const headers = { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'valid-acme-v1' };
  const payload = JSON.stringify(createAcmeValidJsonImport());
  const accepted = await request('/v1/imports', { method: 'POST', headers, body: payload });
  assert.equal(accepted.response.status, 201);
  assert.equal(accepted.body.acceptedRows, 28);
  const replay = await request('/v1/imports', { method: 'POST', headers, body: payload });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  const conflict = await request('/v1/imports', { method: 'POST', headers, body: `${payload} ` });
  assert.equal(conflict.response.status, 409);
  const supplemental = await request('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'text/csv', 'idempotency-key': 'supplemental-acme-v1' },
    body: createAcmeSupplementalCsv(),
  });
  assert.equal(supplemental.response.status, 201);
  assert.equal(supplemental.body.acceptedRows, 4);
  const counts = await database.admin.query('SELECT (SELECT count(*)::int FROM packaging) packaging, (SELECT count(*)::int FROM materials) materials, (SELECT count(*)::int FROM components) components, (SELECT count(*)::int FROM suppliers) suppliers, (SELECT count(*)::int FROM boms) boms');
  assert.deepEqual(counts.rows[0], { packaging: 32, materials: 18, components: 40, suppliers: 4, boms: 32 });
  const catalog = await request('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(catalog.response.status, 200);
  assert.deepEqual(catalog.body, { packaging: 32, materials: 18, components: 40, boms: 32, suppliers: 4 });
  const packaging = await request('/v1/catalog/packaging', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(packaging.response.status, 200);
  assert.equal(packaging.body.items.length, 32);
  assert.deepEqual(Object.keys(packaging.body.items[0]), ['id', 'name', 'packaging_type', 'country', 'supplier_id', 'status']);
  const unknown = await request('/v1/catalog/not-a-resource', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(unknown.response.status, 404);
});

// The same packaging under a *different* idempotency key is not a replay — it is a second, genuine import
// of a record that already exists, which is what an operator does after correcting a typo. It reported
// `500 INTERNAL_ERROR` with the message "The service could not complete the request. Retry shortly",
// because the driver's own 23505 is not a deliberate error and `app.mjs` correctly refuses to leak
// PostgreSQL's vocabulary. The advice was unfollowable: every retry fails identically.
//
// This asserts the deliberate 409 and, just as importantly, that the failed import left nothing behind —
// the whole import runs in one transaction, and a partial catalogue would be worse than a refusal.
test('re-importing an existing packaging record is refused by name, not as a server error', async () => {
  const payload = JSON.stringify(createAcmeValidJsonImport());
  const before = await database.admin.query('SELECT count(*)::int AS packaging FROM packaging');
  const conflict = await request('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': `reimport-${randomUUID()}` },
    body: payload,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IMPORT_RECORD_EXISTS');
  assert.notEqual(conflict.body.error.code, 'INTERNAL_ERROR');
  const after = await database.admin.query('SELECT count(*)::int AS packaging FROM packaging');
  assert.equal(after.rows[0].packaging, before.rows[0].packaging, 'a refused import must leave no partial catalogue');
});

test('catalog summary rejects an unverified identity', async () => {
  const denied = await request('/v1/catalog/summary');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.error.code, 'AUTHENTICATION_REQUIRED');
});

test('read-only auditor cannot mutate packaging', async () => {
  const denied = await request('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.read_only_auditor.token}`, 'content-type': 'application/json', 'idempotency-key': 'denied-import' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(denied.response.status, 404);
  assert.equal(denied.body.error.code, 'RESOURCE_NOT_FOUND');
});
