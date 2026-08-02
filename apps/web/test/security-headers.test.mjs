// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { after, before, test } from 'node:test';

let child;
let api;
let webPort;
let apiPort;
let lastApiHeaders;

async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function waitFor(url) { for (let attempt = 0; attempt < 50; attempt += 1) { try { const response = await fetch(url); if (response.ok) return response; } catch { } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`timeout waiting for ${url}`); }

before(async () => {
  api = http.createServer((request, response) => { lastApiHeaders = request.headers; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); });
  apiPort = await listen(api);
  const reservation = http.createServer();
  webPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, OPENPPWR_WEB_HOST: '127.0.0.1', OPENPPWR_WEB_PORT: String(webPort), OPENPPWR_API_ORIGIN: `http://127.0.0.1:${apiPort}` }, stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${webPort}/health`);
});

after(async () => {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => api.close(resolve));
});

test('static SPA responses carry the full web security header set', async () => {
  const response = await fetch(`http://127.0.0.1:${webPort}/en/community`);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-eval|unsafe-inline/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('strict-transport-security'), /^max-age=\d+$/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.get('permissions-policy'));
});

test('proxied /v1 responses also carry the security header set on top of the upstream body', async () => {
  const response = await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, { headers: { authorization: 'Bearer synthetic' } });
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('client-supplied X-Forwarded-For / CF-Connecting-IP are stripped, not trusted, before reaching the API', async () => {
  await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, {
    headers: { authorization: 'Bearer synthetic', 'x-forwarded-for': '9.9.9.9', 'cf-connecting-ip': '9.9.9.9' },
  });
  assert.notEqual(lastApiHeaders['x-forwarded-for'], '9.9.9.9');
  assert.equal(lastApiHeaders['cf-connecting-ip'], undefined);
});

// The defect this asserts against: `web` fabricated the forwarded scheme instead of reporting it, saying
// `http` on every deployment that had not set the Cloudflare flag. The API's same-origin check compares the
// scheme, so a self-hosted deployment behind TLS had its own front end classified as a foreign origin and
// answered `403 origin_not_allowed` to every request carrying an `Origin` header — which is every POST the
// workbench makes, including sign-in. It stayed hidden because the API's built-in allowlist names this
// project's own hostnames, so the reference deployment never reached the same-origin branch.
test('the scheme the operator proxy reports is forwarded to the API, not replaced with a guess', async () => {
  await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, {
    headers: { authorization: 'Bearer synthetic', 'x-forwarded-proto': 'https' },
  });
  assert.equal(
    lastApiHeaders['x-forwarded-proto'],
    'https',
    'a TLS-terminating proxy says https; reporting http makes the deployment a foreign origin to itself',
  );
});

test('a forwarded scheme list is reduced to the originating hop, and a junk value never reaches the API', async () => {
  await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, {
    headers: { authorization: 'Bearer synthetic', 'x-forwarded-proto': 'https, http' },
  });
  assert.equal(lastApiHeaders['x-forwarded-proto'], 'https', 'the client-facing hop is the first entry');

  await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, {
    headers: { authorization: 'Bearer synthetic', 'x-forwarded-proto': 'javascript:alert(1)' },
  });
  assert.equal(
    lastApiHeaders['x-forwarded-proto'],
    'http',
    'anything that is not http or https falls back to the connection, rather than being passed through',
  );
});

test('with no proxy in front, the connection decides the scheme', async () => {
  await fetch(`http://127.0.0.1:${webPort}/v1/catalog/summary`, { headers: { authorization: 'Bearer synthetic' } });
  assert.equal(lastApiHeaders['x-forwarded-proto'], 'http', 'a plain HTTP connection direct to the container is http, and saying so is correct');
});

test('static assets keep their own cache-control policy alongside the security headers', async () => {
  const indexResponse = await fetch(`http://127.0.0.1:${webPort}/`);
  // The shell must always revalidate. It names the hashed assets, so a stale shell pins an entire
  // stale application — the symptom that is indistinguishable from a deployment that never happened.
  assert.equal(indexResponse.headers.get('cache-control'), 'no-cache, must-revalidate');
  assert.ok(indexResponse.headers.get('content-security-policy'));

  // A hashed asset may be cached forever, because changing its content changes its name.
  const html = await indexResponse.text();
  const asset = html.match(/\/assets\/([A-Za-z0-9._-]+\.js)/u)?.[1];
  assert.ok(asset, 'the shell must reference a hashed asset');
  const assetResponse = await fetch(`http://127.0.0.1:${webPort}/assets/${asset}`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok(assetResponse.headers.get('content-security-policy'), 'security headers apply to assets too');
});
