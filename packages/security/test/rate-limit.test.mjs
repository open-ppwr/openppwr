import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/rate-limit.mjs';

function fakePool() {
  const rows = new Map();
  return {
    async query(sql, params) {
      if (sql.startsWith('DELETE')) return { rows: [] };
      const [key, windowStart] = params;
      const existing = rows.get(key);
      const count = (existing?.count || 0) + 1;
      rows.set(key, { count, windowStart });
      return { rows: [{ count }] };
    },
  };
}

function req({ ip = '203.0.113.9', identity, body } = {}) {
  return { ip, socket: { remoteAddress: ip }, identity, body };
}

// The limiter no longer responds directly. It raises a coded error so the refusal passes through the global
// error handler, which is the one place every refusal is logged — a rate-limit trip previously reached no
// logger at all. These helpers assert the raised error rather than a written response; the
// status, code and Retry-After header are unchanged, and the API's handler turns the error back into the
// same body.
async function run(middleware, request, response) {
  let raised = null;
  let passed = false;
  await middleware(request, response, (error) => { if (error) raised = error; else passed = true; });
  return { raised, passed };
}

function res() {
  const headers = {};
  const value = {
    statusCode: 200,
    body: undefined,
    set(name, val) { headers[name] = val; return value; },
    status(code) { value.statusCode = code; return value; },
    json(body) { value.body = body; return value; },
  };
  return { value, headers };
}

test('requests under the threshold pass through', async () => {
  const limiter = createRateLimiter({ pool: fakePool(), rules: { op: [{ dimension: 'ip', windowMs: 1000, max: 3 }] } });
  const middleware = limiter('op');
  for (let i = 0; i < 3; i += 1) {
    let called = false;
    await middleware(req(), res().value, () => { called = true; });
    assert.equal(called, true);
  }
});

test('exceeding the threshold returns 429 with Retry-After', async () => {
  const now = { value: 0 };
  const limiter = createRateLimiter({ pool: fakePool(), rules: { op: [{ dimension: 'ip', windowMs: 1000, max: 2 }] }, now: () => now.value });
  const middleware = limiter('op');
  await middleware(req(), res().value, () => {});
  await middleware(req(), res().value, () => {});
  const third = res();
  const { raised, passed } = await run(middleware, req(), third.value);
  assert.equal(passed, false, 'a refused request must not continue');
  assert.ok(raised, 'the limiter must raise so the refusal reaches the logger');
  assert.equal(raised.code, 'RATE_LIMITED');
  assert.equal(raised.status, 429);
  assert.ok(Number(raised.retryAfterSeconds) > 0, 'the documented body field must survive the handler');
  assert.ok(Number(third.headers['Retry-After']) > 0, 'the header is still set by the limiter itself');
});

test('window reset allows traffic again', async () => {
  const now = { value: 0 };
  const limiter = createRateLimiter({ pool: fakePool(), rules: { op: [{ dimension: 'ip', windowMs: 1000, max: 1 }] }, now: () => now.value });
  const middleware = limiter('op');
  await middleware(req(), res().value, () => {});
  const blocked = res();
  const refused = await run(middleware, req(), blocked.value);
  assert.equal(refused.passed, false);
  assert.equal(refused.raised?.status, 429);
  now.value = 1000;
  const afterReset = res();
  let nextCalled = false;
  await middleware(req(), afterReset.value, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('different subjects, tenants and IPs are counted independently', async () => {
  const limiter = createRateLimiter({ pool: fakePool(), rules: { op: [{ dimension: 'subject', windowMs: 1000, max: 1 }] } });
  const middleware = limiter('op');
  let a = false; let b = false;
  await middleware(req({ identity: { actorId: 'user-a' } }), res().value, () => { a = true; });
  await middleware(req({ identity: { actorId: 'user-b' } }), res().value, () => { b = true; });
  assert.equal(a, true);
  assert.equal(b, true);
  const blockedAgain = res();
  const refused = await run(middleware, req({ identity: { actorId: 'user-a' } }), blockedAgain.value);
  assert.equal(refused.passed, false, 'the subject that already spent its budget must be refused');
  assert.equal(refused.raised?.status, 429);
  assert.equal(refused.raised?.code, 'RATE_LIMITED');
});

test('a request that fails one of several dimension checks is rejected even if others pass', async () => {
  const limiter = createRateLimiter({
    pool: fakePool(),
    rules: { op: [{ dimension: 'ip', windowMs: 1000, max: 100 }, { dimension: 'tenant', windowMs: 1000, max: 1 }] },
  });
  const middleware = limiter('op');
  await middleware(req({ identity: { tenantId: 't1' } }), res().value, () => {});
  const second = res();
  const refused = await run(middleware, req({ identity: { tenantId: 't1' } }), second.value);
  assert.equal(refused.passed, false, 'failing any one dimension must refuse the request');
  assert.equal(refused.raised?.status, 429);
});

test('dimensions without an identifier yet (unauthenticated request, tenant/subject rule) are skipped, not blocked', async () => {
  const limiter = createRateLimiter({ pool: fakePool(), rules: { op: [{ dimension: 'tenant', windowMs: 1000, max: 1 }] } });
  const middleware = limiter('op');
  let called = false;
  await middleware(req(), res().value, () => { called = true; });
  assert.equal(called, true);
});

test('unknown operation is a programming error, not a silent bypass', () => {
  const limiter = createRateLimiter({ pool: fakePool(), rules: {} });
  assert.throws(() => limiter('does-not-exist'), TypeError);
});

// The gap the per-IP rule alone cannot close: an attacker spreading attempts against one address across many source IPs
// evades the per-IP rule entirely, because each IP alone stays under its own budget. `loginTarget` keys
// on the attempted address instead, so the same address is throttled no matter which — or how many —
// IPs the attempts come from.
test('an address hit from many different IPs is throttled by the attempted address, not by any one IP', async () => {
  const limiter = createRateLimiter({
    pool: fakePool(),
    rules: { login: [{ dimension: 'loginTarget', windowMs: 1000, max: 2 }] },
  });
  const middleware = limiter('login');
  const attempt = (ip) => middleware(req({ ip, body: { email: 'victim@example.test', password: 'guess' } }), res().value, () => {});
  await attempt('203.0.113.1');
  await attempt('198.51.100.7');
  const third = res();
  const refused = await run(middleware, req({ ip: '192.0.2.55', body: { email: 'victim@example.test', password: 'guess' } }), third.value);
  assert.equal(refused.passed, false, 'a third attempt against the same address, from a third distinct IP, must still be refused');
  assert.equal(refused.raised?.status, 429);
});

test('two different attempted addresses are counted independently, even from the same IP', async () => {
  const limiter = createRateLimiter({
    pool: fakePool(),
    rules: { login: [{ dimension: 'loginTarget', windowMs: 1000, max: 1 }] },
  });
  const middleware = limiter('login');
  let a = false; let b = false;
  await middleware(req({ body: { email: 'alice@example.test' } }), res().value, () => { a = true; });
  await middleware(req({ body: { email: 'bob@example.test' } }), res().value, () => { b = true; });
  assert.equal(a, true);
  assert.equal(b, true);
});

test('the attempted-address bucket is case-insensitive, matching how the database compares it', async () => {
  const limiter = createRateLimiter({
    pool: fakePool(),
    rules: { login: [{ dimension: 'loginTarget', windowMs: 1000, max: 1 }] },
  });
  const middleware = limiter('login');
  await middleware(req({ body: { email: 'Victim@Example.TEST' } }), res().value, () => {});
  const second = res();
  const refused = await run(middleware, req({ body: { email: 'victim@example.test' } }), second.value);
  assert.equal(refused.passed, false, 'a differently-cased spelling of the same address must share the bucket');
  assert.equal(refused.raised?.status, 429);
});

// The whole point of this dimension is that it cannot reopen the timing/enumeration property migration
// 018 established: it must not behave any differently depending on whether the attempted address belongs
// to a real account, because the limiter runs before `signIn` ever looks the address up. Asserted
// structurally here — the bucket key is the raw attempted string and nothing else reaches it — rather
// than by asserting a login outcome, which is `signIn`'s property to hold, not this middleware's.
test('a missing, non-string or oversized email is skipped rather than colliding into one shared bucket', async () => {
  const limiter = createRateLimiter({
    pool: fakePool(),
    rules: { login: [{ dimension: 'loginTarget', windowMs: 1000, max: 1 }] },
  });
  const middleware = limiter('login');
  let calledNoBody = false;
  await middleware(req({}), res().value, () => { calledNoBody = true; });
  assert.equal(calledNoBody, true, 'a request with no body at all must not be blocked by this dimension');
  let calledNonString = false;
  await middleware(req({ body: { email: 12345 } }), res().value, () => { calledNonString = true; });
  assert.equal(calledNonString, true, 'a non-string email must not be blocked by this dimension');
  let calledOversized = false;
  await middleware(req({ body: { email: `${'a'.repeat(300)}@example.test` } }), res().value, () => { calledOversized = true; });
  assert.equal(calledOversized, true, 'an address longer than any real address must not be blocked by this dimension');
});
