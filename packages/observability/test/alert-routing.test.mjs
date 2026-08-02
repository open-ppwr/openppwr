import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { alertMetrics, log } from '../src/index.mjs';

const COMPOSE = resolve(import.meta.dirname, '../../../deploy/community/docker-compose.yml');

// Routing security events to a destination, tested against a destination.
//
// The events existed and nothing carried them anywhere. The half built here is the carrier, so the
// properties worth holding are the ones that decide whether a carrier is safe to put behind a request
// path at all: it cannot delay the caller, it cannot crash the process when the far end misbehaves,
// it cannot leak what the logger just redacted, and with nothing configured it must do nothing.

const ALERT_VARIABLES = [
  'OPENPPWR_ALERT_WEBHOOK_URL',
  'OPENPPWR_ALERT_WEBHOOK_TOKEN',
  'OPENPPWR_ALERT_MIN_LEVEL',
  'OPENPPWR_ALERT_TIMEOUT_MS',
  'OPENPPWR_ALERT_MAX_IN_FLIGHT',
];

// An unhandled rejection anywhere in delivery would take the process down with it, which is the exact
// failure "a destination that returns 500 does not crash the process" is about. Recording them here
// makes that assertion about the whole file rather than about one test.
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

function configure(values = {}) {
  for (const name of ALERT_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

// A destination under the test's control. `handler` decides how it answers — including by never
// answering, which is the case a bounded delivery exists for.
async function startSink(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const received = { method: request.method, headers: request.headers, body };
      requests.push(received);
      handler(response, received);
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((closed) => server.close(closed));
    },
  };
}

const accepts = (response) => { response.writeHead(204); response.end(); };
const hangs = () => {};

function capturing() {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  return {
    stop() { process.stdout.write = original; },
    records() {
      return lines.flatMap((chunk) => chunk.split('\n'))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.event === 'string');
    },
    raw() { return lines.join(''); },
  };
}

async function waitFor(condition, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((tick) => setTimeout(tick, 5));
  }
  return false;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await new Promise((tick) => setImmediate(tick));
}

after(() => {
  configure();
  assert.deepEqual(unhandled, [], 'delivery produced an unhandled rejection, which would end the process');
});

test('absent configuration is off, without a request and without a complaint', async () => {
  const sink = await startSink(accepts);
  configure();
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    await settle();
    await new Promise((tick) => setTimeout(tick, 150));
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.equal(alertMetrics().configured, false);
  assert.equal(sink.requests.length, 0, 'an unconfigured deployment contacted a destination');
  assert.equal(alertMetrics().considered - before.considered, 0);
  const records = capture.records();
  assert.ok(records.some((entry) => entry.event === 'api.request.refused'), 'the event itself must still be logged');
  assert.deepEqual(records.filter((entry) => entry.event.startsWith('observability.alert.')), [],
    'an unconfigured deployment must be silent about alerting, not merely inactive');
});

test('a configured destination receives exactly the bytes of the log line', async () => {
  const sink = await startSink(accepts);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url });
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, route: '/v1/imports', correlationId: 'c-1' });
    await waitFor(() => alertMetrics().delivered > before.delivered);
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.equal(alertMetrics().delivered - before.delivered, 1, 'the event was not delivered');
  assert.equal(sink.requests.length, 1);
  assert.equal(sink.requests[0].method, 'POST');
  assert.equal(sink.requests[0].headers['content-type'], 'application/json');
  const emitted = capture.records().find((entry) => entry.event === 'api.request.refused' && entry.correlationId === 'c-1');
  assert.ok(emitted, 'nothing was written to stdout');
  // One serialization, not two. If the destination ever received a separately assembled payload there
  // would be a second place for redaction to be forgotten, and this is what forbids that.
  assert.equal(sink.requests[0].body, JSON.stringify(emitted));
});

test('redaction holds on what leaves the process', async () => {
  const sink = await startSink(accepts);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url });
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', {
      code: 'AUTHENTICATION_FAILED',
      status: 401,
      authorization: 'Bearer opp_live_abcdefghijklmnop',
      password: 'hunter2',
      apiKey: 'k-secret-123',
      private_key: 'pk-secret-456',
      credential: 'cred-secret-789',
      filename: 'sprawozdanie.pdf',
      detail: 'upstream rejected Bearer tok-live-999 and token=t-987',
    });
    await waitFor(() => alertMetrics().delivered > before.delivered);
  } finally {
    capture.stop();
    await sink.stop();
  }
  const body = sink.requests[0]?.body ?? '';
  assert.ok(body.length > 0, 'nothing reached the destination');
  for (const secret of ['opp_live_abcdefghijklmnop', 'hunter2', 'k-secret-123', 'pk-secret-456', 'cred-secret-789', 'tok-live-999', 't-987']) {
    assert.ok(!body.includes(secret), `${secret} left the process`);
  }
  assert.ok(body.includes('AUTHENTICATION_FAILED'), 'the event code must survive — it is the point of the alert');
  const emitted = capture.records().find((entry) => entry.event === 'api.request.refused' && entry.code === 'AUTHENTICATION_FAILED');
  assert.equal(body, JSON.stringify(emitted), 'the destination saw something the log did not');
});

test('the destination credential travels as a header and never as a log line', async () => {
  const sink = await startSink(accepts);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_WEBHOOK_TOKEN: 'sink-cred-a1b2' });
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    await waitFor(() => alertMetrics().delivered > before.delivered);
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.equal(sink.requests[0].headers.authorization, 'Bearer sink-cred-a1b2');
  assert.ok(!sink.requests[0].body.includes('sink-cred-a1b2'), 'the destination credential was also in the payload');
  assert.ok(!capture.raw().includes('sink-cred-a1b2'), 'the destination credential reached stdout');
});

test('the threshold decides, in both directions', async () => {
  const quiet = await startSink(accepts);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: quiet.url });
  try {
    log('warn', 'api.request.refused', { code: 'RESOURCE_NOT_FOUND', status: 404 });
    await settle();
    await new Promise((tick) => setTimeout(tick, 150));
    assert.equal(quiet.requests.length, 0, 'a 404 was routed at the default threshold, which is how an alert channel becomes noise');
  } finally {
    await quiet.stop();
  }

  const loud = await startSink(accepts);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: loud.url, OPENPPWR_ALERT_MIN_LEVEL: 'warn' });
  const before = alertMetrics();
  try {
    log('warn', 'api.request.refused', { code: 'AUTHENTICATION_FAILED', status: 401 });
    await waitFor(() => alertMetrics().delivered > before.delivered);
    assert.equal(loud.requests.length, 1, 'lowering the threshold did not route the warning');
  } finally {
    await loud.stop();
  }
});

test('a destination that never answers does not delay the caller, and is abandoned on time', async () => {
  const sink = await startSink(hangs);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_TIMEOUT_MS: '300' });
  const before = alertMetrics();
  const capture = capturing();
  let elapsedMs = 0;
  try {
    const started = process.hrtime.bigint();
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const abandoned = await waitFor(() => alertMetrics().failed > before.failed, 5000);
    assert.ok(abandoned, 'delivery to a silent destination never gave up; the bound is not bounding');
    // The counter moves first and the record it explains is written a tick later, because every record
    // this module emits — including its own — leaves the caller's stack before it is written.
    await settle();
  } finally {
    capture.stop();
    await sink.stop();
  }
  // The reason this repository has a rule about it: a security-log write was once on the request path,
  // and a 74-second suite became a 20-minute timeout. A remote destination is a far worse thing to put
  // there than a local file.
  assert.ok(elapsedMs < 50, `log() took ${elapsedMs.toFixed(1)}ms; delivery is on the caller's stack`);
  assert.equal(alertMetrics().inFlight, 0, 'the in-flight count leaked, so the ceiling would eventually close permanently');
  const records = capture.records();
  assert.ok(records.some((entry) => entry.event === 'api.request.refused'),
    'the event must still be logged when its delivery fails — the log is the record, the alert is the notification');
  assert.ok(records.some((entry) => entry.event === 'observability.alert.failed' && entry.reason === 'timeout'),
    'a silent destination must be visible in the logs, or fail-open becomes silence');
});

test('a destination that answers 500 does not crash the process', async () => {
  const sink = await startSink((response) => { response.writeHead(500); response.end('no'); });
  // The threshold is `warn` here for the sake of the last assertion in this test: the records this
  // module writes about its own routing are themselves warnings, so a missing recursion guard is only
  // observable when warnings are in scope.
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MIN_LEVEL: 'warn' });
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    assert.ok(await waitFor(() => alertMetrics().rejected > before.rejected), 'the refusal was never observed');
    await settle();
    // Still serving. A process that died would not get here, and a channel that stopped working after
    // one bad answer would not increment again.
    const second = alertMetrics();
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 503 });
    assert.ok(await waitFor(() => alertMetrics().rejected > second.rejected), 'routing stopped after one rejection');
    // And the module's complaint about the destination is not itself sent to the destination: that loop
    // ends in a hot process, never in an alert.
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(sink.requests.length, 2, `the destination received ${sink.requests.length} requests for 2 events`);
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.deepEqual(unhandled, [], 'a 500 from the destination produced an unhandled rejection');
  assert.ok(capture.records().some((entry) => entry.event === 'observability.alert.rejected' && entry.status === 500));
});

test('the in-flight ceiling drops rather than queues, and every drop is counted', async () => {
  const sink = await startSink(hangs);
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_TIMEOUT_MS: '300', OPENPPWR_ALERT_MAX_IN_FLIGHT: '1' });
  const capture = capturing();
  const before = alertMetrics();
  try {
    for (let index = 0; index < 4; index += 1) log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, attempt: index });
    // An unbounded queue in front of a destination that stopped answering is a memory leak that ends in
    // the process being killed, which loses everything the queue was protecting.
    assert.equal(alertMetrics().dropped - before.dropped, 3, 'the ceiling did not hold');
    await waitFor(() => alertMetrics().inFlight === 0, 5000);
    assert.equal(sink.requests.length, 1, 'more than one delivery was in flight under a ceiling of one');
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.ok(capture.records().some((entry) => entry.event === 'observability.alert.dropped' && entry.reason === 'in_flight_ceiling'),
    'a dropped alert must appear in the logs; an uncounted drop is the failure mode fail-open is accused of');
  assert.equal(capture.records().filter((entry) => entry.event === 'api.request.refused').length, 4,
    'a dropped alert must not mean a dropped log entry');
});

test('configuration that cannot be honoured disables routing loudly, and never repeats the URL', async () => {
  const sink = await startSink(accepts);
  const cases = [
    ['unparseable_url', { OPENPPWR_ALERT_WEBHOOK_URL: 'not a url at all' }],
    ['unsupported_scheme', { OPENPPWR_ALERT_WEBHOOK_URL: 'file:///etc/passwd' }],
    ['unknown_minimum_level', { OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MIN_LEVEL: 'critical' }],
    ['invalid_timeout', { OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_TIMEOUT_MS: 'soon' }],
    ['invalid_in_flight_ceiling', { OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_MAX_IN_FLIGHT: '0' }],
  ];
  const capture = capturing();
  try {
    for (const [reason, values] of cases) {
      configure(values);
      log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, reason });
      await settle();
      assert.equal(alertMetrics().configured, false, `${reason} left routing enabled`);
    }
    await new Promise((tick) => setTimeout(tick, 150));
  } finally {
    capture.stop();
    await sink.stop();
  }
  assert.equal(sink.requests.length, 0, 'a deployment with invalid alert configuration contacted the destination anyway');
  const disabled = capture.records().filter((entry) => entry.event === 'observability.alert.disabled');
  for (const [reason] of cases) {
    assert.ok(disabled.some((entry) => entry.reason === reason), `${reason} was refused silently`);
  }
  // A webhook URL is frequently the credential itself, and a misconfiguration record is the one most
  // likely to be pasted into a ticket.
  assert.ok(!capture.raw().includes(sink.url), 'the configured destination URL was written to the log');
});

test('a redirect is refused rather than followed', async () => {
  const elsewhere = await startSink(accepts);
  const sink = await startSink((response) => { response.writeHead(302, { location: elsewhere.url }); response.end(); });
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: sink.url, OPENPPWR_ALERT_WEBHOOK_TOKEN: 'sink-cred-a1b2' });
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    assert.ok(await waitFor(() => alertMetrics().failed > before.failed), 'the redirect was neither followed nor refused');
    await new Promise((tick) => setTimeout(tick, 150));
  } finally {
    await sink.stop();
    await elsewhere.stop();
  }
  // Following it would hand the payload, and the shared secret in the Authorization header, to a host
  // the operator never configured.
  assert.equal(elsewhere.requests.length, 0, 'the redirect was followed to an unconfigured host');
});

// The shipped deployment, not just the code.
//
// A capability that the container cannot see is not a capability. `--env-file` supplies values for a
// compose file's own `${...}` interpolation and does not inject anything into a container, so a
// variable an operator sets in `openppwr.env` has no effect at all until it is also named in the
// service's `environment:` block. That has already happened once in this file, to two trust flags whose
// documented topology could not actually be enabled through the shipped stack.
test('every alerting variable is named in the API service, or the operator setting it does nothing', async () => {
  const compose = await readFile(COMPOSE, 'utf8');
  const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  assert.ok(api.length > 0, 'the api service was not found; the parse is wrong, not the compose file');
  for (const name of ALERT_VARIABLES) {
    // The passthrough in full, including the `:-` default that makes an unset variable an empty value
    // rather than a compose error. Matching the name alone would pass on a comment that mentions it.
    assert.ok(api.includes(`      ${name}: \${${name}:-}`),
      `${name} is not passed into the api container, so setting it in the environment file has no effect`);
  }
});

// This file's log-volume check was retired 2026-08-01. Every service now logs to journald rather than
// json-file, so a volume bound is no longer the enforceable property — `scripts/validation/log-retention-gate.mjs`
// asserts the property that replaced it (driver, per-service tag, the retired variables, the installer's
// drop-in) by parsing the compose YAML rather than slicing its text, which this test did and a merge
// anchor made fragile. Removing this test narrows coverage nowhere: the gate is strictly the stronger
// check, runs in `full-gate.mjs`, and was proven able to fail during its own construction.
