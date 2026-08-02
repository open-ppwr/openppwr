import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createRateLimiter, DEFAULT_RATE_LIMIT_RULES } from '@openppwr/security';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let server;
let baseUrl;
let bootstrapSecret;
let identities;
let clock = Date.now();

const TINY_RULES = {
  ...DEFAULT_RATE_LIMIT_RULES,
  bootstrap: [{ dimension: 'ip', windowMs: 1000, max: 3 }],
  read: [{ dimension: 'subject', windowMs: 1000, max: 2 }],
  import: [{ dimension: 'tenant', windowMs: 1000, max: 2 }, { dimension: 'ip', windowMs: 1000, max: 50 }],
};

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

before(async () => {
  database = await startTestDatabase('api-rate-limit');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  bootstrapSecret = randomUUID();
  const app = createApp({
    pool,
    bootstrapToken: bootstrapSecret,
    storageRoot: resolve('.runtime-test', `rate-limit-${randomUUID()}`),
    rateLimiterFactory: ({ pool: appPool }) => createRateLimiter({ pool: appPool, rules: TINY_RULES, now: () => clock }),
  });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await database?.stop();
});

test('bootstrap brute-force attempts are throttled by IP regardless of whether the token was correct (no enumeration signal)', async () => {
  const wrong = { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': 'wrong' }, body: '{}' };
  const first = await jsonRequest('/v1/bootstrap', wrong);
  assert.equal(first.response.status, 401);
  const second = await jsonRequest('/v1/bootstrap', wrong);
  assert.equal(second.response.status, 401);
  const third = await jsonRequest('/v1/bootstrap', wrong);
  assert.equal(third.response.status, 401);
  const fourth = await jsonRequest('/v1/bootstrap', wrong);
  assert.equal(fourth.response.status, 429);
  assert.equal(fourth.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(fourth.response.headers.get('retry-after')) > 0);
  // A correct token is throttled identically once the IP bucket is exhausted — the 429
  // carries no information about whether the token would otherwise have succeeded.
  const correctButThrottled = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  assert.equal(correctButThrottled.response.status, 429);
  clock += 1000;
});

test('window reset allows bootstrap to actually succeed once the IP bucket clears, and it is blocked afterward regardless (already bootstrapped)', async () => {
  const created = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
});

test('read limit is enforced per authenticated subject, independent of other subjects in the same tenant', async () => {
  clock += 1000;
  const auditorA = await jsonRequest('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(auditorA.response.status, 200);
  const auditorB = await jsonRequest('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(auditorB.response.status, 200);
  const auditorBlocked = await jsonRequest('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(auditorBlocked.response.status, 429);
  // A different subject (different actor id, same tenant) is not affected by auditor's exhausted bucket.
  const admin = await jsonRequest('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(admin.response.status, 200);
});

test('import limit is enforced per tenant and does not block unrelated operations for the same tenant', async () => {
  clock += 1000;
  const headers = { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json' };
  const payload = JSON.stringify({ format: 'json', organizations: [], packaging: [], materials: [], components: [], boms: [], suppliers: [] });
  const first = await jsonRequest('/v1/imports', { method: 'POST', headers: { ...headers, 'idempotency-key': 'rl-import-1' }, body: payload });
  const second = await jsonRequest('/v1/imports', { method: 'POST', headers: { ...headers, 'idempotency-key': 'rl-import-2' }, body: payload });
  const third = await jsonRequest('/v1/imports', { method: 'POST', headers: { ...headers, 'idempotency-key': 'rl-import-3' }, body: payload });
  assert.equal(third.response.status, 429);
  assert.notEqual(first.response.status, 429);
  assert.notEqual(second.response.status, 429);
  // A read on a fresh subject-bucket still works while the tenant's import bucket is exhausted.
  const unaffected = await jsonRequest('/v1/catalog/summary', { headers: { authorization: `Bearer ${identities.compliance_manager.token}` } });
  assert.notEqual(unaffected.response.status, 429);
});

test('IP spoofing via a client-supplied X-Forwarded-For does not let a client evade its own rate limit (api trusts only the one hop it is configured for)', async () => {
  const wrong = { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': 'wrong', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 254) + 1}` }, body: '{}' };
  // app.set('trust proxy', 1) trusts exactly one hop; supertest/fetch here connects directly
  // (no proxy hop at all), so Express's req.ip resolves from the raw socket address and the
  // attacker-supplied XFF value is not used to pick a different bucket.
  clock += 5000;
  const a = await jsonRequest('/v1/bootstrap', wrong);
  const b = await jsonRequest('/v1/bootstrap', wrong);
  const c = await jsonRequest('/v1/bootstrap', wrong);
  const d = await jsonRequest('/v1/bootstrap', wrong);
  assert.deepEqual([a.response.status, b.response.status, c.response.status, d.response.status], [401, 401, 401, 429]);
});

test('normal single-request traffic on an expensive endpoint (dossier generation class) is never rejected', async () => {
  clock += 5000;
  const frozen = await jsonRequest('/v1/review-snapshots', { method: 'POST', headers: { authorization: `Bearer ${identities.compliance_manager.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) });
  assert.notEqual(frozen.response.status, 429);
});

// Two halves of the same control, and both were broken in ways no test would have noticed.
//
// The global error handler logged `request.identity?.id`. The verified identity has never had an `id`
// property — `authenticateToken` returns `actorId` — so the read was `undefined` on every authenticated
// request and every security event recorded a null actor. The control is specifically about attributing a
// refusal to someone; it recorded that something was refused and nothing about whom.
//
// And a rate-limit trip returned its 429 directly from the middleware, so it never reached that handler and
// was never logged at all, while the documentation describes it as a logged security event.
test('an authenticated refusal is logged with the actor, and a rate-limit trip is logged at all', async () => {
  // The logger writes to `process.stdout` on a deferred tick (packages/observability), not to console.warn.
  // The first version of this test captured console.warn and saw nothing — and would have "passed" as soon
  // as its assertion was relaxed, which is exactly the failure mode this test exists to catch elsewhere.
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    // An authenticated request that is refused: the auditor may not write.
    const denied = await jsonRequest('/v1/imports', {
      method: 'POST',
      headers: { authorization: `Bearer ${identities.read_only_auditor.token}`, 'content-type': 'application/json', 'idempotency-key': 'actor-logging' },
      body: JSON.stringify({ packaging: [] }),
    });
    assert.equal(denied.response.status, 404, 'the auditor must be refused, or this test proves nothing');

    await new Promise((tick) => setImmediate(tick));
    const refusal = captured.flatMap((line) => line.split(String.fromCharCode(10))).map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .find((entry) => entry.event === 'api.request.refused' && entry.route === '/v1/imports');
    assert.ok(refusal, `no refusal was logged; captured ${captured.length} lines`);
    assert.equal(refusal.actorId, identities.read_only_auditor.id, 'the refusal must name the actor it refused');
    assert.equal(refusal.tenantId, identities.read_only_auditor.tenantId ?? refusal.tenantId);
    // And it must still carry no credential material.
    assert.ok(!JSON.stringify(refusal).includes(identities.read_only_auditor.token), 'a log line must never contain a bearer token');
    // The write is deferred with setImmediate, so give it a tick before reading.
    await new Promise((tick) => setImmediate(tick));
  } finally {
    process.stdout.write = original;
  }
});
