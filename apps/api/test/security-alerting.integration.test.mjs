import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { alertMetrics } from '@openppwr/observability';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

// The routing of security events, exercised through the request path it must never touch.
//
// The unit tests in packages/observability prove the carrier's properties in isolation. These prove the
// property that actually matters to a deployment: a destination that has stopped answering changes
// nothing a client can observe. This repository has a rule about that for a reason — a security-log
// write was once on the request path, and a remote destination is a far worse thing to put there than
// the local file that caused it.

const ALERT_VARIABLES = [
  'OPENPPWR_ALERT_WEBHOOK_URL',
  'OPENPPWR_ALERT_WEBHOOK_TOKEN',
  'OPENPPWR_ALERT_MIN_LEVEL',
  'OPENPPWR_ALERT_TIMEOUT_MS',
  'OPENPPWR_ALERT_MAX_IN_FLIGHT',
];

// A path that carries an identifier, so the assertion below is about a real one rather than a shape.
const REJECTED_CREDENTIAL_VALUE = 'opp_live_integration_value_x9';
const EVIDENCE_ID = '00000000-0000-4000-8000-0000000000ff';
const REFUSED_PATH = `/v1/evidence/${EVIDENCE_ID}/download`;

let database;
let pool;
let server;
let baseUrl;

function configure(values = {}) {
  for (const name of ALERT_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

async function startSink(handler) {
  const requests = [];
  const sink = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ headers: request.headers, body });
      handler(response);
    });
  });
  await new Promise((ready) => sink.listen(0, '127.0.0.1', ready));
  return {
    requests,
    url: `http://127.0.0.1:${sink.address().port}/hook`,
    async stop() {
      sink.closeAllConnections?.();
      await new Promise((closed) => sink.close(closed));
    },
  };
}

async function waitFor(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  return false;
}

// A refusal produced by presenting a credential that is not valid. It is the ordinary shape of the
// event this channel exists to carry, and it carries both a bearer token and an identifier in the URL —
// neither of which may appear in what leaves the process.
async function refusedRequest() {
  const started = process.hrtime.bigint();
  const response = await fetch(`${baseUrl}${REFUSED_PATH}`, { headers: { authorization: `Bearer ${REJECTED_CREDENTIAL_VALUE}` } });
  await response.arrayBuffer();
  return { status: response.status, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

before(async () => {
  database = await startTestDatabase('api-security-alerting');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const app = createApp({ pool, bootstrapToken: randomUUID(), storageRoot: resolve('.runtime-test', `alerting-${randomUUID()}`) });
  await new Promise((ready) => { server = app.listen(0, '127.0.0.1', ready); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  configure();
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await database?.stop();
});

test('with no destination configured the API behaves exactly as before', async () => {
  configure();
  const before_ = alertMetrics();
  const refused = await refusedRequest();
  assert.equal(refused.status, 401);
  assert.equal(alertMetrics().considered - before_.considered, 0, 'an unconfigured deployment routed something');
  assert.equal(alertMetrics().configured, false);
});

test('a destination that never answers does not delay the request', async () => {
  const sink = await startSink(() => {});
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MIN_LEVEL: 'warn', OPENPPWR_ALERT_TIMEOUT_MS: '5000' });
  const before_ = alertMetrics();
  try {
    const refused = await refusedRequest();
    assert.equal(refused.status, 401, 'the refusal itself changed, which is not what this test is about');
    // The delivery bound is five seconds. If any part of it were on the request path this response
    // could not arrive in a fraction of that.
    assert.ok(refused.elapsedMs < 1500, `the refusal took ${refused.elapsedMs.toFixed(0)}ms against a destination that never answered`);
    assert.ok(alertMetrics().considered > before_.considered, 'the refusal was never routed, so this proved nothing');
    assert.ok(await waitFor(() => alertMetrics().failed > before_.failed), 'delivery to a silent destination never gave up');
  } finally {
    await sink.stop();
  }
});

test('a destination that answers 500 neither fails the request nor ends the process', async () => {
  const sink = await startSink((response) => { response.writeHead(500); response.end('no'); });
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MIN_LEVEL: 'warn' });
  const before_ = alertMetrics();
  try {
    const refused = await refusedRequest();
    assert.equal(refused.status, 401);
    assert.ok(await waitFor(() => alertMetrics().rejected > before_.rejected), 'the destination refusal was never observed');
    // Still alive, still serving, still routing: a channel that stopped working after one bad answer
    // would be an outage the next reader would blame on the API.
    const second = alertMetrics();
    const again = await refusedRequest();
    assert.equal(again.status, 401);
    assert.ok(await waitFor(() => alertMetrics().rejected > second.rejected), 'routing stopped after one rejection');
  } finally {
    await sink.stop();
  }
});

test('what reaches the destination carries no credential, no request body and no raw path', async () => {
  const sink = await startSink((response) => { response.writeHead(204); response.end(); });
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MIN_LEVEL: 'warn' });
  const before_ = alertMetrics();
  try {
    const refused = await refusedRequest();
    assert.equal(refused.status, 401);
    assert.ok(await waitFor(() => alertMetrics().delivered > before_.delivered), 'nothing was delivered');
  } finally {
    await sink.stop();
  }
  const payloads = sink.requests.map((received) => received.body).join('\n');
  assert.ok(payloads.length > 0, 'the destination received nothing to inspect');
  assert.ok(!payloads.includes(REJECTED_CREDENTIAL_VALUE), 'a bearer token left the process');
  assert.ok(!payloads.includes(EVIDENCE_ID), 'an identifier from the URL left the process; identifiers belong in the audit chain');
  assert.ok(!payloads.includes(REFUSED_PATH), 'the raw path left the process');
  const entry = JSON.parse(sink.requests.at(-1).body);
  assert.equal(entry.event, 'api.request.refused');
  assert.equal(entry.status, 401);
  assert.ok(typeof entry.timestamp === 'string' && Date.parse(entry.timestamp), 'the alert has no usable timestamp');
});
