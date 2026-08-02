// The API reported itself healthy while it could not serve a single request.
//
// `GET /health` answered a static `{status:'ok'}` without touching the database, and the image's
// HEALTHCHECK probed exactly that route — so an API whose connection pool was exhausted, or whose
// database had gone, told the orchestrator it was healthy and kept receiving traffic. It also satisfied
// the `service_healthy` condition that `web` and `worker` wait on in
// `deploy/community/docker-compose.yml`. The worker had answered the same three questions separately
// since 2026-07-30 (`apps/worker/src/server.mjs`); the API had only the first of them.
//
// No database is involved in this suite: readiness is a rule about what a probe does with a pool's
// answer, and that is exactly what is exercised here, so the contract is checked without an integration
// environment. The last test is the one that would have caught the original defect on its own — a
// readiness route nothing probes is not a healthcheck.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp, probeReadiness } from '../src/app.mjs';

const rateLimiterFactory = () => () => (_request, _response, next) => next();

// A pool that fails the test if anything reaches the database. Liveness must never touch one.
const FORBIDDEN = {
  query() { throw new Error('a liveness answer must not depend on the database'); },
  connect() { throw new Error('a liveness answer must not depend on the database'); },
};
const ANSWERING = { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) };
// What the driver actually raises when the database is gone: a message naming the host and port, and a
// code that names the engine. Neither may reach an unauthenticated caller.
//
// The address is `203.0.113.11` — RFC 5737 documentation space — rather than the RFC 1918 address a real
// deployment would carry. The public-export validator refuses a private-network address in an exported
// file, and it is right to: that is how infrastructure detail has leaked before. A documentation address
// has the same shape, so the assertion below still checks what it says it checks.
const REFUSING = {
  query: async () => { throw Object.assign(new Error('connect ECONNREFUSED 203.0.113.11:5432 database "openppwr" role "openppwr_app"'), { code: 'ECONNREFUSED' }); },
};
// An exhausted pool: the checkout never returns. This is the failure the static route could not see at
// all, because the process is alive and answering HTTP the whole time.
const HANGING = { query: () => new Promise(() => {}) };

async function get(pool, path) {
  const app = createApp({ pool, bootstrapToken: 'unused', rateLimiterFactory });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('liveness answers without consulting any dependency', async () => {
  // A restart is the only remedy for a failed liveness probe, so a database outage must never be able
  // to produce one. `FORBIDDEN` throws on contact.
  const live = await get(FORBIDDEN, '/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.live, true);
  assert.equal(live.body.role, 'api');
});

test('the published /health route keeps its meaning and its body', async () => {
  // The decision recorded in `app.mjs`: `/health` stays liveness and the container healthcheck moved to
  // `/health/ready` instead. It is documented as liveness in the shipped API reference, `apps/web/server.mjs`
  // answers `/health` for itself with the same meaning, and the recovery rehearsal reads it as "the
  // process is up". Fields may be added; the meaning may not change.
  const health = await get(FORBIDDEN, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok', 'an existing consumer reads status:ok and must keep reading it');
  assert.equal(health.body.live, true);
});

test('readiness proves the database answers, rather than assuming it', async () => {
  const ready = await get(ANSWERING, '/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.status, 'ready');
  assert.deepEqual(ready.body.reasons, []);
});

test('a database that does not answer makes this instance unready, not healthy', async () => {
  const unready = await get(REFUSING, '/health/ready');
  // 503, so an orchestrator takes it out of service. Not 500, and not 200 — which is what the route it
  // replaced returned in this exact state.
  assert.equal(unready.status, 503);
  assert.equal(unready.body.ready, false);
  assert.equal(unready.body.status, 'unready');
  assert.deepEqual(unready.body.reasons, ['DATABASE_UNAVAILABLE']);
});

test('readiness discloses nothing about the deployment it just probed', async () => {
  // The route is unauthenticated, so its body is public. The driver error it just caught named a host,
  // a port, a database and a role, and carried a code naming the engine.
  const unready = await get(REFUSING, '/health/ready');
  const body = JSON.stringify(unready.body);
  assert.doesNotMatch(body, /ECONNREFUSED|5432|203\.0\.113\.11|openppwr_app|connect /iu, 'the probe repeated what the driver told it');
  assert.doesNotMatch(body, /postgres|sql/iu, 'the answer names the engine');
  // The whole body, enumerated: a field added here later is a field an anonymous caller receives.
  assert.deepEqual(Object.keys(unready.body).sort(), ['ready', 'reasons', 'role', 'status']);
});

// The per-test timeout is part of the assertion, not scaffolding: without a bound in `probeReadiness`
// this test does not fail, it hangs — which is exactly what the healthcheck would do.
test('readiness is bounded, so an exhausted pool answers instead of hanging', { timeout: 5_000 }, async () => {
  // The failure the static route could not see: the process is alive, HTTP is answering, and every
  // checkout is queued behind a connection that never comes back. A readiness probe that waits for that
  // checkout inherits `OPENPPWR_DB_CHECKOUT_TIMEOUT_MS`, which the shipped deployment sets to 30 000 ms —
  // ten times the interval at which it is asked. A probe that never answers is not a probe.
  const started = Date.now();
  const probe = await probeReadiness(HANGING, { timeoutMs: 50 });
  const elapsed = Date.now() - started;
  assert.equal(probe.ready, false);
  assert.deepEqual(probe.reasons, ['DATABASE_UNAVAILABLE']);
  assert.ok(elapsed < 2_000, `the probe took ${elapsed} ms and was meant to give up after 50`);
});

test('the container healthcheck probes readiness, not liveness', async () => {
  // The half of this defect that is not in the application at all. Adding a readiness route changes
  // nothing on a deployment while the healthcheck keeps asking the route that always says yes — which is
  // exactly the state this repository was in: the worker had `/health/ready` and probed it, the API had
  // neither and probed `/health`.
  const dockerfile = await readFile(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../../../deploy/community/docker-compose.yml', import.meta.url), 'utf8');
  const healthchecks = [
    ...[...dockerfile.matchAll(/^HEALTHCHECK .*$/gmu)].map((match) => ({ where: 'Dockerfile', text: match[0] })),
    ...[...compose.matchAll(/^\s*test: \[CMD.*$/gmu)].map((match) => ({ where: 'docker-compose.yml', text: match[0] })),
  ];
  assert.ok(healthchecks.length >= 4, `only ${healthchecks.length} healthchecks were found; the parse proved nothing`);
  // Every healthcheck that addresses a Node service on port 3000 — the API and the worker — must probe
  // readiness. Port 8080 is `web`, whose `/health` is its own liveness route and answers no database.
  const liveness = healthchecks.filter((entry) => entry.text.includes('127.0.0.1:3000') && !entry.text.includes('/health/ready'));
  assert.deepEqual(liveness.map((entry) => `${entry.where}: ${entry.text.trim()}`), [],
    'a service healthcheck still asks whether the process is alive rather than whether it can serve');
  assert.ok(dockerfile.includes("http://127.0.0.1:3000/health/ready"), 'the image default still probes /health');
});
