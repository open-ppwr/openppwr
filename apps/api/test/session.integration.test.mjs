import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let server;
let baseUrl;
let identities;

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json().catch(() => null) };
}

before(async () => {
  database = await startTestDatabase('api-session');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot: resolve('.runtime-test', `session-${randomUUID()}`) });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  identities = created.body.identities;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await database?.stop();
});

test('a request with no credential is rejected as AUTHENTICATION_REQUIRED', async () => {
  const { response, body } = await jsonRequest('/v1/session');
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED');
});

test('an invalid credential is rejected as AUTHENTICATION_FAILED — the exact failure reported from /pl/app', async () => {
  const { response, body } = await jsonRequest('/v1/session', { headers: { authorization: 'Bearer opp_test_not_a_real_token' } });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'AUTHENTICATION_FAILED');
});

test('the failure message is localized so the interface can explain it in the user language', async () => {
  const { body } = await jsonRequest('/v1/session', { headers: { authorization: 'Bearer opp_test_not_a_real_token', 'accept-language': 'pl' } });
  assert.equal(body.error.message, 'Uwierzytelnienie nie powiodło się.');
  const german = await jsonRequest('/v1/session', { headers: { authorization: 'Bearer opp_test_not_a_real_token', 'accept-language': 'de' } });
  assert.notEqual(german.body.error.message, body.error.message);
});

test('every role can establish a session and sees only its own identity', async () => {
  for (const [role, identity] of Object.entries(identities)) {
    const { response, body } = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identity.token}` } });
    assert.equal(response.status, 200, `${role} could not establish a session`);
    assert.equal(body.role, role);
    assert.equal(body.actorId, identity.id);
    assert.ok(body.tenantId);
  }
});

test('the session response carries no secret material', async () => {
  const { body } = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  // Pinned deliberately: any new field here is a deliberate disclosure decision, not an accident.
  // "permissions" lets the interface stop offering actions the server will refuse, and "expiresAt"
  // lets it show how long the session has left. Both describe the caller's own session and neither
  // carries secret material.
  assert.deepEqual(Object.keys(body).sort(), ['actorId', 'expiresAt', 'permissions', 'role', 'supplierId', 'tenantId']);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /opp_test_/, 'a bearer token must never be echoed back');
  assert.doesNotMatch(serialized, /token|hash|secret/i);
  // A static operator credential still has its own token_expires_at, enforced by the database; reporting
  // it is not a leak, and reporting null when the database will reject the token later was the defect
  // it reported.
  assert.ok(body.expiresAt && !Number.isNaN(Date.parse(body.expiresAt)), 'a static credential\'s own expiry must be reported, not hidden');
  assert.ok(Array.isArray(body.permissions) && body.permissions.length > 0);
});

test('establishing a session grants no privilege by itself — authorization is still enforced per operation', async () => {
  const auditorSession = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(auditorSession.response.status, 200);
  const denied = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.read_only_auditor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: '1.0', packaging: [] }),
  });
  assert.equal(denied.response.status, 404, 'a read-only auditor must not be able to import after signing in');
});

test('a correlation ID is returned so a user-visible failure can be traced without exposing internals', async () => {
  const { response } = await jsonRequest('/v1/session', { headers: { authorization: 'Bearer opp_test_not_a_real_token' } });
  assert.match(response.headers.get('x-correlation-id') || '', /^[A-Za-z0-9._:-]{1,128}$/);
});

test('no session response sets a cookie, so the bearer-only CSRF assessment still holds', async () => {
  const anonymous = await fetch(`${baseUrl}/v1/session`);
  const authenticated = await fetch(`${baseUrl}/v1/session`, { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(anonymous.headers.get('set-cookie'), null);
  assert.equal(authenticated.headers.get('set-cookie'), null);
});
