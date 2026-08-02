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
  return { response, body: await response.json() };
}

before(async () => {
  database = await startTestDatabase('api-security-headers');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot: resolve('.runtime-test', `headers-${randomUUID()}`) });
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

test('every response carries the API security header set, including on errors and 404s', async () => {
  const ok = await fetch(`${baseUrl}/health`);
  const missing = await fetch(`${baseUrl}/v1/catalog/summary`);
  for (const response of [ok, missing]) {
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('strict-transport-security'), /^max-age=\d+$/);
  }
});

test('CORS allows every approved OpenPPWR origin', async () => {
  for (const origin of ['https://openppwr.eu', 'https://app.openppwr.eu', 'https://demo.openppwr.eu', 'https://docs.openppwr.eu', 'https://api.openppwr.eu', 'https://status.openppwr.eu', 'https://community.openppwr.eu']) {
    const response = await fetch(`${baseUrl}/health`, { headers: { origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin, `expected ${origin} to be allowed`);
  }
});

test('CORS rejects an untrusted origin outright, with no reflection', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('CORS never combines a wildcard with credentials support', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://app.openppwr.eu' } });
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('CSRF is not applicable: auth is bearer-only, no Set-Cookie is ever issued, and requests without an Authorization header are rejected regardless of Origin/Referer', async () => {
  const bootstrapResponse = await fetch(`${baseUrl}/health`);
  assert.equal(bootstrapResponse.headers.get('set-cookie'), null);
  const authedResponse = await fetch(`${baseUrl}/v1/catalog/summary`, { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(authedResponse.headers.get('set-cookie'), null);
  // A same-site, credential-free request forged from a third-party page cannot succeed:
  // it has no way to attach the bearer token (nothing is auto-sent by the browser), so the
  // request is indistinguishable from any other unauthenticated request and is rejected.
  const forged = await fetch(`${baseUrl}/v1/catalog/summary`, { headers: { origin: 'https://attacker.example', referer: 'https://attacker.example/csrf.html' } });
  assert.equal(forged.status, 403); // rejected by the CORS allowlist before auth is even evaluated
  const forgedFromTrustedOriginWithoutToken = await fetch(`${baseUrl}/v1/catalog/summary`, { headers: { origin: 'https://app.openppwr.eu' } });
  assert.equal(forgedFromTrustedOriginWithoutToken.status, 401); // Origin alone, without the bearer token, is never sufficient
});
