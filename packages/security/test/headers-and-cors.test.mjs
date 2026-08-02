import assert from 'node:assert/strict';
import test from 'node:test';
import { API_CSP, WEB_CSP, buildSecurityHeaders, cors, securityHeaders } from '../src/index.mjs';

function res() {
  const headers = {};
  const value = {
    statusCode: 200,
    ended: false,
    set(nameOrMap, val) {
      if (typeof nameOrMap === 'object') Object.assign(headers, nameOrMap);
      else headers[nameOrMap] = val;
      return value;
    },
    status(code) { value.statusCode = code; return value; },
    json(body) { value.body = body; return value; },
    end() { value.ended = true; return value; },
  };
  return { value, headers };
}

test('buildSecurityHeaders sets the full required set with no unsafe-eval/broad unsafe-inline', () => {
  const headers = buildSecurityHeaders({ csp: WEB_CSP });
  assert.equal(headers['Content-Security-Policy'], WEB_CSP);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-eval/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-inline/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /base-uri 'self'/);
  assert.match(headers['Content-Security-Policy'], /form-action 'self'/);
  assert.match(headers['Strict-Transport-Security'], /^max-age=\d+$/);
  assert.doesNotMatch(headers['Strict-Transport-Security'], /includeSubDomains|preload/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('cacheControl:null omits Cache-Control entirely, unlike cacheControl:undefined which falls back to the default', () => {
  const omitted = buildSecurityHeaders({ cacheControl: null });
  assert.equal('Cache-Control' in omitted, false);
  const defaulted = buildSecurityHeaders({ cacheControl: undefined });
  assert.equal(defaulted['Cache-Control'], 'no-store');
});

test('API CSP is fully locked down (no page is ever rendered by the API)', () => {
  assert.equal(API_CSP, "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
});

test('securityHeaders middleware applies the header set and calls next', () => {
  const { value, headers } = res();
  let called = false;
  securityHeaders()( {}, value, () => { called = true; });
  assert.equal(called, true);
  assert.equal(headers['Content-Security-Policy'], API_CSP);
});

test('cors allows an approved origin and echoes it explicitly (no wildcard)', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value, headers } = res();
  let called = false;
  middleware({ get: (name) => (name === 'origin' ? 'https://app.openppwr.eu' : undefined), method: 'GET' }, value, () => { called = true; });
  assert.equal(called, true);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.openppwr.eu');
  assert.equal(headers.Vary, 'Origin');
  assert.equal(headers['Access-Control-Allow-Credentials'], undefined);
});

test('cors rejects an origin that is not on the allowlist (no reflection)', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value, headers } = res();
  let called = false;
  middleware({ get: (name) => (name === 'origin' ? 'https://evil.example' : undefined), method: 'GET' }, value, () => { called = true; });
  assert.equal(called, false);
  assert.equal(value.statusCode, 403);
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
});

test('cors allows same-origin traffic on a host the allowlist does not know (self-hosted custom domain)', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value } = res();
  const headerValues = { origin: 'https://ppwr.selfhosted.example', host: 'ppwr.selfhosted.example' };
  let called = false;
  // `protocol` is part of a real Express request and was missing from this fake, which is why the scheme went
  // unchecked for so long: the middleware had nothing to compare against and the test never noticed.
  middleware({ get: (name) => headerValues[name.toLowerCase()], method: 'POST', protocol: 'https' }, value, () => { called = true; });
  assert.equal(called, true);
  assert.notEqual(value.statusCode, 403);
});

// The scheme is part of an origin. `isSameOrigin` compared only the host, so an http origin was treated as
// same-origin with an https deployment and echoed back in Access-Control-Allow-Origin. The existing negative
// test above varies the hostname and never the scheme, so it passed throughout.
test('cors rejects a same-host origin on a different scheme', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value, headers } = res();
  const headerValues = { origin: 'http://ppwr.selfhosted.example', host: 'ppwr.selfhosted.example' };
  let called = false;
  middleware({ get: (name) => headerValues[name.toLowerCase()], method: 'POST', protocol: 'https' }, value, () => { called = true; });
  assert.equal(called, false, 'an http origin must not be same-origin with an https deployment');
  assert.equal(value.statusCode, 403);
  assert.equal(headers['Access-Control-Allow-Origin'], undefined, 'a refused origin must never be reflected');
});

// And the legitimate direction: a deployment genuinely served over http — loopback, or a local install — must
// still work, or the fix would break self-hosting to close a gap that does not exist there.
test('cors allows a same-host http origin when the deployment is served over http', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value } = res();
  const headerValues = { origin: 'http://127.0.0.1:31114', host: '127.0.0.1:31114' };
  let called = false;
  middleware({ get: (name) => headerValues[name.toLowerCase()], method: 'POST', protocol: 'http' }, value, () => { called = true; });
  assert.equal(called, true);
  assert.notEqual(value.statusCode, 403);
});

// If the protocol cannot be determined, the origin is refused rather than guessed at.
test('cors refuses a same-host origin when the request protocol is unknown', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value } = res();
  const headerValues = { origin: 'https://ppwr.selfhosted.example', host: 'ppwr.selfhosted.example' };
  let called = false;
  middleware({ get: (name) => headerValues[name.toLowerCase()], method: 'POST' }, value, () => { called = true; });
  assert.equal(called, false);
  assert.equal(value.statusCode, 403);
});

test('a foreign origin is still rejected even when the request reaches a self-hosted host', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value } = res();
  const headerValues = { origin: 'https://evil.example', host: 'ppwr.selfhosted.example' };
  let called = false;
  middleware({ get: (name) => headerValues[name.toLowerCase()], method: 'POST' }, value, () => { called = true; });
  assert.equal(called, false);
  assert.equal(value.statusCode, 403);
});

test('cors handles preflight for an approved origin with a scoped method/header allowlist', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value, headers } = res();
  middleware({ get: (name) => (name === 'origin' ? 'https://app.openppwr.eu' : undefined), method: 'OPTIONS' }, value, () => {});
  assert.equal(value.statusCode, 204);
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS');
  assert.match(headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('cors with no Origin header (same-origin or non-browser client) passes through untouched', () => {
  const middleware = cors(['https://app.openppwr.eu']);
  const { value, headers } = res();
  let called = false;
  middleware({ get: () => undefined, method: 'GET' }, value, () => { called = true; });
  assert.equal(called, true);
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
});
