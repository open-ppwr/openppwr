// A database error must be answered as what it is.
//
// The demonstration reset originally raised `insufficient_privilege` to mean "this deployment is not a
// demonstration", and the route mapped SQLSTATE 42501 to a 404. But PostgreSQL raises 42501 for "permission
// denied for table" as well — so a missing grant on the maintenance role was reported to callers as a route
// that does not exist, and it took a wasted cycle to find because the symptom was indistinguishable from
// the intended refusal.
//
// Two properties follow, and they pull in opposite directions:
//
//   * a resource that is absent or not yours is a 404, with nothing to distinguish the two;
//   * an internal grant or configuration defect is never disguised as one.
//
// Reading an ambiguous signal as though it carried one meaning is the same error as trusting a
// caller-controlled input, so this is asserted rather than left to the reading of the code.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let maintenancePool;
let server;
let baseUrl;
let identities;

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

before(async () => {
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  database = await startTestDatabase('api-database-error-mapping');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  await database.declareDemonstrationDeployment();
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/errmap-${randomUUID()}` });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
});

after(async () => {
  delete process.env.OPENPPWR_DEMO_LOGIN;
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await maintenancePool?.end();
  await database?.stop();
});

// The refusal the reset is meant to give: this deployment was never declared a demonstration.
test('a deployment that is not a demonstration answers the reset as a resource that does not exist', async () => {
  await database.admin.query(`UPDATE deployment_metadata SET deployment_mode='production', synthetic_tenant=false WHERE singleton`);
  try {
    const refused = await jsonRequest('/v1/demo/reset', {
      method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` },
    });
    assert.equal(refused.response.status, 404);
    assert.equal(refused.body.error.code, 'RESOURCE_NOT_FOUND');
    // Nothing about deployment mode, tables, roles or SQL.
    const serialised = JSON.stringify(refused.body);
    for (const leak of ['deployment_metadata', 'demo', 'openppwr_maintenance', 'permission', 'SQLSTATE', 'P0002']) {
      assert.ok(!serialised.includes(leak), `the refusal disclosed "${leak}": ${serialised}`);
    }
  } finally {
    await database.admin.query(`UPDATE deployment_metadata SET deployment_mode='demo', synthetic_tenant=true WHERE singleton`);
  }
});

// The defect the first version hid. A revoked grant is an operator fault, and it must look like one.
test('a missing grant surfaces as an internal fault, never as a missing route', async () => {
  await database.admin.query('REVOKE EXECUTE ON FUNCTION reset_openppwr_demo_tenant() FROM openppwr_maintenance');
  try {
    const broken = await jsonRequest('/v1/demo/reset', {
      method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` },
    });
    assert.equal(broken.response.status, 500, 'a misconfigured deployment was reported as a route that does not exist');
    assert.equal(broken.body.error.code, 'INTERNAL_ERROR');
    // Visible as a fault, but the caller learns nothing about the schema.
    const serialised = JSON.stringify(broken.body);
    assert.ok(!serialised.includes('42501'), 'the SQLSTATE reached the caller');
    assert.ok(!/permission denied/iu.test(serialised), 'the driver message reached the caller');
    assert.ok(!serialised.includes('reset_openppwr_demo_tenant'), 'the function name reached the caller');
  } finally {
    await database.admin.query('GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant() TO openppwr_maintenance');
  }
});

// The general rule, checked away from the reset so it is not a property of one route.
test('a raw SQLSTATE is never echoed as an error code', async () => {
  const malformed = await jsonRequest('/v1/evidence/not-a-uuid/download', {
    headers: { authorization: `Bearer ${identities.compliance_manager.token}` },
  });
  assert.equal(malformed.response.status, 404, 'a malformed identifier must be indistinguishable from an unknown one');
  assert.equal(malformed.body.error.code, 'RESOURCE_NOT_FOUND');
  assert.ok(!/^\d/u.test(malformed.body.error.code), 'a SQLSTATE begins with a digit and is not an error code this codebase chose');
});

// Absent capability and absent resource must be the same answer, or the response enumerates the deployment.
test('the reset is a not-found when no maintenance credential is configured', async () => {
  const withoutMaintenance = createApp({ pool, bootstrapToken: randomUUID(), storageRoot: `.runtime-test/errmap-none-${randomUUID()}` });
  const isolated = withoutMaintenance.listen(0, '127.0.0.1');
  await new Promise((listening) => isolated.once('listening', listening));
  try {
    const response = await fetch(`http://127.0.0.1:${isolated.address().port}/v1/demo/reset`, {
      method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'RESOURCE_NOT_FOUND');
  } finally {
    isolated.closeAllConnections?.();
    await new Promise((closed) => isolated.close(closed));
  }
});
