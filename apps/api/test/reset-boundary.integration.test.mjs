// The demonstration reset privilege boundary.
//
// `reset_openppwr_demo_tenant(p_tenant_id uuid)` was SECURITY DEFINER, granted to the application role, and
// deleted every row of a tenant's domain data. The three things that made it safe — the demonstration-mode
// check, the permission check and the audit event — all lived in the HTTP wrapper, so a caller holding the
// application role could call the function directly and get none of them, against any tenant identifier it
// chose to pass.
//
// The severity is not "the application can delete data": it holds `DELETE` on those tables anyway and could
// do it row by row. It is that a *privileged* helper took its target from the caller and left no trace.
//
// Migration 012 moved the rules inside the function and did not hold: the target came
// from `openppwr_current_tenant()`, which reads a GUC the application role sets for itself, and the
// demonstration marker it checked lived in `demo_users`, which the same role could write. The attacker
// tests reproduced both.
//
// Migration 014 does not move the check again. It moves the capability: the reset is unreachable from the
// request-serving role, its target comes from deployment metadata written at install time, and the
// demonstration property is an operator decision rather than an inference from rows.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, migrate, withTenantTransaction } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, createVerifiedContext } from '../src/app.mjs';

let database;
let pool;
let authPool;
let maintenancePool;
let server;
let baseUrl;
let identities;
let tenantId;
const storageRoot = `.runtime-test/reset-boundary-${randomUUID()}`;

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const packagingCount = async () => Number((await database.admin.query('SELECT count(*)::int AS count FROM packaging')).rows[0].count);

before(async () => {
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  database = await startTestDatabase('api-reset-boundary');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // Migration 014 moved session issuance and the demonstration reset onto credentials the request pool
  // does not hold. A deployment is a demonstration because the installer said so, not because the
  // application claims it at runtime.
  authPool = createPool(database.authUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  await database.declareDemonstrationDeployment();
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, authPool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
  tenantId = created.body.tenantId;
  const imported = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'reset-boundary' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201);
  assert.ok(await packagingCount() > 0, 'the catalogue must be populated, or a reset proves nothing');
});

after(async () => {
  delete process.env.OPENPPWR_DEMO_LOGIN;
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await authPool?.end();
  await maintenancePool?.end();
  await database?.stop();
});

// The signature itself is the fix: there is no longer a parameter with which to name another tenant.

test('the reset function takes no tenant argument', async () => {
  const args = (await database.admin.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='reset_openppwr_demo_tenant'`)).rows;
  assert.equal(args.length, 1, 'exactly one reset function must exist');
  assert.equal(args[0].args, '', 'a caller-supplied target is what made the old signature a cross-tenant wipe');
});

test('the reset function is callable by neither PUBLIC nor the request-serving role', async () => {
  const acl = (await database.admin.query(
    `SELECT coalesce(array_to_string(p.proacl, ','), '') AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='reset_openppwr_demo_tenant'`)).rows[0].acl;
  assert.ok(!/(^|,)=X/u.test(acl), `PUBLIC may call the reset: ${acl}`);
  assert.ok(!acl.includes('openppwr_app=X'), `the request-serving role may call the reset: ${acl}`);
  assert.ok(acl.includes('openppwr_maintenance=X'), `the maintenance role must be able to call it: ${acl}`);
});

// The property migration 012 claimed and did not have. Asserted against the real role, with the GUC set to
// the tenant an attacker would name.
test('a direct call by the application role is refused whatever tenant context it sets', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('openppwr.actor_id', $1, true)`, [identities.tenant_admin.id]);
    await assert.rejects(
      () => client.query('SELECT * FROM reset_openppwr_demo_tenant()'),
      (error) => error.code === '42501',
      'a GUC the caller sets is not authority',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

// Not a demonstration deployment means no reset, regardless of what rows exist. The distinct SQLSTATE
// matters: 42501 would be indistinguishable from a missing grant, and the route maps that to a 500 on
// purpose so a misconfigured deployment cannot hide behind a 404.
test('a deployment the installer did not declare a demonstration cannot be reset', async () => {
  await database.admin.query(`UPDATE deployment_metadata SET deployment_mode='production', synthetic_tenant=false WHERE singleton`);
  const client = await maintenancePool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      () => client.query('SELECT * FROM reset_openppwr_demo_tenant()'),
      (error) => error.code === 'P0002',
      'the maintenance credential is not itself permission to wipe a production tenant',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await database.admin.query(`UPDATE deployment_metadata SET deployment_mode='demo', synthetic_tenant=true WHERE singleton`);
  }
});

test('the approved path resets the demonstration tenant and leaves the audit chain intact', async () => {
  const before = Number((await database.admin.query('SELECT count(*)::int AS c FROM packaging WHERE tenant_id=$1', [tenantId])).rows[0].c);
  assert.ok(before > 0, 'the fixture must have data, or the reset proves nothing');

  const response = await fetch(`${baseUrl}/v1/demo/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.tenant_admin.token}` },
  });
  // Read once: passing `await response.text()` as the assertion message consumes the body that the next
  // line then needs.
  const payload = await response.text();
  assert.equal(response.status, 200, payload);
  assert.equal(JSON.parse(payload).packagingRemaining, 0);

  assert.equal(
    Number((await database.admin.query('SELECT count(*)::int AS c FROM packaging WHERE tenant_id=$1', [tenantId])).rows[0].c),
    0,
  );
  // Identities and demonstration accounts survive: bootstrap is one-time and credentials are hash-only, so
  // removing them would leave the deployment unusable.
  assert.ok(Number((await database.admin.query('SELECT count(*)::int AS c FROM identities WHERE tenant_id=$1', [tenantId])).rows[0].c) > 0);

  // Exactly one event, and the chain still verifies. The event is written on the maintenance connection in
  // the same transaction as the deletion, by the one application-side encoder.
  const events = Number((await database.admin.query(
    `SELECT count(*)::int AS c FROM audit_events WHERE tenant_id=$1 AND action='demo.reset'`, [tenantId])).rows[0].c);
  assert.equal(events, 1, 'one reset, one record');

  const verified = await withTenantTransaction(pool, await createVerifiedContext(pool, identities.tenant_admin.token), async (client) => {
    const { verifyAuditChain } = await import('@openppwr/database');
    return verifyAuditChain(client);
  });
  assert.equal(verified.valid, true, 'the reset broke the audit chain');
});
