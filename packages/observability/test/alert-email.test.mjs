// Routing security events to a mailbox.
//
// The webhook half of this is covered by `alert-routing.test.mjs`; the protocol half by `smtp.test.mjs`.
// What is left, and what this file is about, is the join: that the mail transport obeys the same rules
// the webhook was built to — the destination receives the exact bytes of the stdout record, delivery can
// never delay or fail the caller, loss is counted and visible, absent configuration is off completely,
// and the module's own notices are never themselves alerted on.
//
// Everything runs against an SMTP server implemented below, on 127.0.0.1 on an ephemeral port. No live
// mail host is contacted and no real credential exists in this file.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { after, mock, test } from 'node:test';
import { alertMetrics, log } from '../src/index.mjs';

const CRLF = '\r\n';
const COMPOSE = resolve(import.meta.dirname, '../../../deploy/community/docker-compose.yml');

const ALERT_VARIABLES = [
  'OPENPPWR_ALERT_WEBHOOK_URL',
  'OPENPPWR_ALERT_WEBHOOK_TOKEN',
  'OPENPPWR_ALERT_MIN_LEVEL',
  'OPENPPWR_ALERT_TIMEOUT_MS',
  'OPENPPWR_ALERT_MAX_IN_FLIGHT',
  'OPENPPWR_ALERT_DEPLOYMENT',
  'OPENPPWR_ALERT_SMTP_HOST',
  'OPENPPWR_ALERT_SMTP_PORT',
  'OPENPPWR_ALERT_SMTP_TLS',
  'OPENPPWR_ALERT_SMTP_USERNAME',
  'OPENPPWR_ALERT_SMTP_PASSWORD',
  'OPENPPWR_ALERT_EMAIL_FROM',
  'OPENPPWR_ALERT_EMAIL_TO',
  'OPENPPWR_ALERT_EMAIL_MAX_PER_HOUR',
];

const EMAIL_VARIABLES = ALERT_VARIABLES.filter((name) => name.includes('SMTP') || name.includes('EMAIL') || name.endsWith('DEPLOYMENT'));

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

function configure(values = {}) {
  for (const name of ALERT_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

// ---------------------------------------------------------------------------------------------

const listeners = [];
after(async () => {
  configure();
  mock.timers.reset();
  for (const server of listeners) {
    server.closeAllConnections?.();
    await new Promise((closed) => server.close(closed));
  }
  assert.deepEqual(unhandled, [], 'mail delivery produced an unhandled rejection, which would end the process');
});

// A mailbox. `silent: true` makes it the failure this whole design is shaped around — a mail server that
// accepts the TCP connection and then never speaks.
async function startMailbox({ silent = false, failAt = null } = {}) {
  const received = [];
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on('error', () => {});
    if (silent) return;
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let lines = [];
    let envelope = { recipients: [] };
    const reply = (text) => socket.write(`${text}${CRLF}`);
    reply('220 mailbox.invalid ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        if (inData) {
          if (line === '.') {
            inData = false;
            const text = lines.map((entry) => (entry.startsWith('.') ? entry.slice(1) : entry)).join(CRLF);
            const split = text.indexOf(`${CRLF}${CRLF}`);
            const headers = new Map(text.slice(0, split).split(CRLF).map((entry) => {
              const colon = entry.indexOf(':');
              return [entry.slice(0, colon).toLowerCase(), entry.slice(colon + 2)];
            }));
            const raw = text.slice(split + 4);
            const body = headers.get('content-transfer-encoding') === 'base64'
              ? Buffer.from(raw.replaceAll(CRLF, ''), 'base64').toString('utf8')
              : raw;
            received.push({ headers, body, envelope });
            envelope = { recipients: [] };
            reply('250 accepted');
            continue;
          }
          lines.push(line);
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (failAt === verb) { reply('550 refused'); continue; }
        if (verb === 'EHLO') { reply('250-mailbox greets you'); reply('250 SIZE 1024000'); continue; }
        if (verb === 'MAIL') { envelope.from = line.slice(11, -1); reply('250 ok'); continue; }
        if (verb === 'RCPT') { envelope.recipients.push(line.slice(9, -1)); reply('250 ok'); continue; }
        if (verb === 'DATA') { inData = true; lines = []; reply('354 go ahead'); continue; }
        if (verb === 'QUIT') { reply('221 bye'); socket.end(); continue; }
        reply('250 ok');
      }
    });
  });
  server.on('error', () => {});
  listeners.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    received,
    settings(extra = {}) {
      return {
        OPENPPWR_ALERT_SMTP_HOST: '127.0.0.1',
        OPENPPWR_ALERT_SMTP_PORT: String(server.address().port),
        OPENPPWR_ALERT_SMTP_TLS: 'disabled',
        OPENPPWR_ALERT_EMAIL_FROM: 'openppwr-alerts@example.invalid',
        OPENPPWR_ALERT_EMAIL_TO: 'security@example.invalid',
        ...extra,
      };
    },
    openSockets() {
      return connections.filter((socket) => !socket.destroyed).length;
    },
  };
}

async function startWebhook() {
  const requests = [];
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ body, headers: request.headers });
      response.writeHead(204);
      response.end();
    });
  });
  listeners.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { requests, url: `http://127.0.0.1:${server.address().port}/hook` };
}

function capturing() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return original(chunk, ...rest);
  };
  return {
    stop() { process.stdout.write = original; },
    records() {
      return chunks.flatMap((chunk) => chunk.split('\n'))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.event === 'string');
    },
    raw() { return chunks.join(''); },
  };
}

// `performance.now()` rather than `Date.now()`: the rate-ceiling test freezes and advances the clock, and
// a wait loop reading the frozen clock never finishes.
async function waitFor(condition, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((tick) => setTimeout(tick, 5));
  }
  return false;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await new Promise((tick) => setImmediate(tick));
}

// ---------------------------------------------------------------------------------------------

test('with no mail settings the transport does not exist', async () => {
  const mailbox = await startMailbox();
  configure();
  const capture = capturing();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    await settle();
    await new Promise((tick) => setTimeout(tick, 150));
  } finally {
    capture.stop();
  }
  assert.equal(alertMetrics().email.configured, false);
  assert.equal(alertMetrics().configured, false);
  assert.equal(mailbox.received.length, 0, 'an unconfigured deployment contacted a mail server');
  assert.deepEqual(capture.records().filter((entry) => entry.event.startsWith('observability.alert.')), [],
    'an unconfigured deployment must be silent about alerting, not merely inactive');
});

test('the message body is exactly the bytes of the stdout record', async () => {
  const mailbox = await startMailbox();
  configure(mailbox.settings());
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, route: '/v1/imports', correlationId: 'm-1' });
    await waitFor(() => alertMetrics().email.delivered > before.email.delivered);
  } finally {
    capture.stop();
  }
  assert.equal(mailbox.received.length, 1, 'the event never reached the mailbox');
  const emitted = capture.records().find((entry) => entry.event === 'api.request.refused' && entry.correlationId === 'm-1');
  assert.ok(emitted, 'nothing was written to stdout');
  // The same property the webhook body has, for the same reason: one serialization, so exactly one place
  // where redaction is got right or wrong.
  assert.equal(mailbox.received[0].body, JSON.stringify(emitted));
  assert.equal(mailbox.received[0].headers.get('content-type'), 'application/json; charset=utf-8');
});

test('a record carrying characters outside ASCII survives intact', async () => {
  const mailbox = await startMailbox();
  configure(mailbox.settings());
  const capture = capturing();
  const before = alertMetrics();
  try {
    // The product accepts these filenames deliberately; an alert that mangles one is an alert that
    // misnames the evidence it is about.
    log('error', 'api.request.refused', { code: 'EVIDENCE_REJECTED', status: 422, filename: 'zaświadczenie-Prüfbericht.pdf' });
    await waitFor(() => alertMetrics().email.delivered > before.email.delivered);
  } finally {
    capture.stop();
  }
  const message = mailbox.received[0];
  assert.equal(message.headers.get('content-transfer-encoding'), 'base64', 'a non-ASCII body was sent as 7bit');
  const emitted = capture.records().find((entry) => entry.event === 'api.request.refused' && entry.status === 422);
  assert.equal(message.body, JSON.stringify(emitted), 'the decoded body is not the record');
  assert.ok(message.body.includes('zaświadczenie-Prüfbericht.pdf'));
});

test('redaction holds on what leaves the process by mail', async () => {
  const mailbox = await startMailbox();
  configure(mailbox.settings({ OPENPPWR_ALERT_SMTP_TLS: 'disabled' }));
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
      detail: 'upstream rejected Bearer tok-live-999 and token=t-987',
    });
    await waitFor(() => alertMetrics().email.delivered > before.email.delivered);
  } finally {
    capture.stop();
  }
  const message = mailbox.received[0];
  const whole = [...message.headers].map(([name, value]) => `${name}: ${value}`).join('\n') + message.body;
  for (const secret of ['opp_live_abcdefghijklmnop', 'hunter2', 'k-secret-123', 'pk-secret-456', 'cred-secret-789', 'tok-live-999', 't-987']) {
    assert.ok(!whole.includes(secret), `${secret} left the process by mail`);
  }
  assert.ok(message.body.includes('AUTHENTICATION_FAILED'), 'the event code must survive — it is the point of the alert');
  const emitted = capture.records().find((entry) => entry.event === 'api.request.refused' && entry.code === 'AUTHENTICATION_FAILED');
  assert.equal(message.body, JSON.stringify(emitted), 'the mailbox saw something the log did not');
});

test('every message says which deployment and which event, in the subject and in headers a rule can match', async () => {
  const mailbox = await startMailbox();
  configure(mailbox.settings({ OPENPPWR_ALERT_DEPLOYMENT: 'acme-prod-eu', OPENPPWR_ALERT_MIN_LEVEL: 'warn' }));
  const before = alertMetrics();
  log('warn', 'api.auth.denied', { code: 'AUTHORIZATION_DENIED', status: 403 });
  await waitFor(() => alertMetrics().email.delivered > before.email.delivered);
  const { headers, envelope } = mailbox.received[0];
  assert.equal(headers.get('subject'), '[OpenPPWR acme-prod-eu] warn api.auth.denied');
  assert.equal(headers.get('x-openppwr-deployment'), 'acme-prod-eu');
  assert.equal(headers.get('x-openppwr-level'), 'warn');
  assert.equal(headers.get('x-openppwr-event'), 'api.auth.denied');
  assert.equal(headers.get('x-openppwr-alert'), 'security-event');
  // RFC 3834. Without it a recipient's out-of-office reply comes back to the alert address, and two
  // automated systems answering each other fill a mailbox nobody is watching.
  assert.equal(headers.get('auto-submitted'), 'auto-generated');
  assert.ok(/^<[0-9a-f-]{36}@example\.invalid>$/u.test(headers.get('message-id')), `message-id was ${headers.get('message-id')}`);
  assert.equal(envelope.from, 'openppwr-alerts@example.invalid');
  assert.deepEqual(envelope.recipients, ['security@example.invalid']);
});

test('both transports run at once, and each gets the same bytes', async () => {
  const mailbox = await startMailbox();
  const webhook = await startWebhook();
  configure(mailbox.settings({ OPENPPWR_ALERT_WEBHOOK_URL: webhook.url }));
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, correlationId: 'both-1' });
    await waitFor(() => alertMetrics().email.delivered > before.email.delivered && webhook.requests.length > 0);
  } finally {
    capture.stop();
  }
  assert.equal(alertMetrics().webhook.configured, true);
  assert.equal(alertMetrics().email.configured, true);
  const emitted = capture.records().find((entry) => entry.correlationId === 'both-1');
  assert.equal(webhook.requests[0].body, JSON.stringify(emitted));
  assert.equal(mailbox.received[0].body, JSON.stringify(emitted));
  // One event, counted once; two deliveries.
  assert.equal(alertMetrics().considered - before.considered, 1);
});

test('an unreachable mail server does not delay the caller, does not leak sockets, and is not silent', async () => {
  const mailbox = await startMailbox({ silent: true });
  configure(mailbox.settings({ OPENPPWR_ALERT_TIMEOUT_MS: '300' }));
  const capture = capturing();
  const before = alertMetrics();
  let elapsedMs = 0;
  try {
    const started = process.hrtime.bigint();
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(await waitFor(() => alertMetrics().email.failed > before.email.failed, 5000),
      'delivery to a silent mail server never gave up; the bound is not bounding');
    await settle();
  } finally {
    capture.stop();
  }
  assert.ok(elapsedMs < 50, `log() took ${elapsedMs.toFixed(1)}ms; SMTP is on the caller's stack`);
  assert.equal(alertMetrics().email.inFlight, 0, 'the in-flight count leaked, so the ceiling would eventually close permanently');
  assert.ok(await waitFor(() => mailbox.openSockets() === 0, 2000),
    'the socket to a hung mail server was not destroyed; an hour of these is a file-descriptor exhaustion');
  const records = capture.records();
  assert.ok(records.some((entry) => entry.event === 'api.request.refused'),
    'the event must still be logged when its delivery fails — the log is the record, the alert is the notification');
  assert.ok(records.some((entry) => entry.event === 'observability.alert.failed' && entry.transport === 'email' && entry.reason === 'timeout'),
    'a hung mail server must be visible in the logs, or fail-open becomes silence');
});

test('a mail server that refuses the message does not crash the process, and the refusal is not itself mailed', async () => {
  const mailbox = await startMailbox({ failAt: 'RCPT' });
  // `warn` so that this module's own notices are in scope: a missing recursion guard is only observable
  // when the level it complains at would itself be routed.
  configure(mailbox.settings({ OPENPPWR_ALERT_MIN_LEVEL: 'warn' }));
  const capture = capturing();
  const before = alertMetrics();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    assert.ok(await waitFor(() => alertMetrics().email.rejected > before.email.rejected), 'the refusal was never observed');
    await settle();
    const second = alertMetrics();
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 503 });
    assert.ok(await waitFor(() => alertMetrics().email.rejected > second.email.rejected), 'routing stopped after one refusal');
    await new Promise((tick) => setTimeout(tick, 250));
  } finally {
    capture.stop();
  }
  assert.deepEqual(unhandled, [], 'a refusal from the mail server produced an unhandled rejection');
  const complaints = capture.records().filter((entry) => entry.event === 'observability.alert.rejected' && entry.transport === 'email');
  assert.ok(complaints.length > 0, 'a refused message was not reported');
  assert.equal(complaints[0].status, 550);
  assert.equal(mailbox.received.length, 0, 'the mailbox accepted a message it was configured to refuse');
});

test('the mail in-flight ceiling drops rather than queues, and every drop is counted', async () => {
  const mailbox = await startMailbox({ silent: true });
  configure(mailbox.settings({ OPENPPWR_ALERT_TIMEOUT_MS: '300', OPENPPWR_ALERT_MAX_IN_FLIGHT: '1' }));
  const capture = capturing();
  const before = alertMetrics();
  try {
    for (let index = 0; index < 4; index += 1) log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, attempt: index });
    // Queueing here would be a memory leak in front of a mail server that has stopped answering, and an
    // SMTP session is a socket as well as an object, so it is the more expensive thing to accumulate.
    assert.equal(alertMetrics().email.dropped - before.email.dropped, 3, 'the mail ceiling did not hold');
    await waitFor(() => alertMetrics().inFlight === 0, 5000);
    assert.ok(await waitFor(() => mailbox.openSockets() <= 1, 2000), 'more than one SMTP socket existed under a ceiling of one');
  } finally {
    capture.stop();
  }
  assert.ok(capture.records().some((entry) => entry.event === 'observability.alert.dropped' && entry.transport === 'email' && entry.reason === 'in_flight_ceiling'));
  assert.equal(capture.records().filter((entry) => entry.event === 'api.request.refused').length, 4,
    'a dropped alert must not mean a dropped log entry');
});

// Why the ceiling is counted per transport instead of over a combined total. SMTP is the transport most
// able to hang — connect, TLS handshake and mid-transaction are three separate places a mail server
// stalls for minutes — so a shared counter would let a dead relay close the webhook channel too, and the
// operator would lose the destination that was still working.
test('a mail server that never answers does not consume the webhook budget', async () => {
  const mailbox = await startMailbox({ silent: true });
  const webhook = await startWebhook();
  configure(mailbox.settings({
    OPENPPWR_ALERT_WEBHOOK_URL: webhook.url,
    OPENPPWR_ALERT_TIMEOUT_MS: '4000',
    OPENPPWR_ALERT_MAX_IN_FLIGHT: '1',
  }));
  const before = alertMetrics();
  // One at a time, so the webhook's own slot is free each round. The mail slot never frees: the first
  // delivery is stuck on a server that will not speak for the whole of this test.
  //
  // Waiting for the request to *arrive* is not the same as waiting for the slot to free, and the
  // difference is a race this test lost roughly one run in three. `webhook.requests.length` rises when the
  // server receives the request; the slot is released in the `.finally()` after `deliver()` resolves,
  // which is one response later. Logging the next event inside that window finds the ceiling still at 1,
  // drops the event as `in_flight_ceiling`, and the wait then times out against a webhook that was never
  // going to receive anything — reported as the hung mail server consuming the budget, which is the one
  // thing that had not happened.
  //
  // So the round ends when the transport is idle again, which is the condition the next round actually
  // depends on. `webhook.inFlight` is read from the counters the module already exposes rather than
  // inferred from a sleep, so this stays a synchronisation rather than a guess about timing.
  for (let index = 0; index < 4; index += 1) {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, attempt: index });
    assert.ok(
      await waitFor(() => webhook.requests.length === index + 1 && alertMetrics().webhook.inFlight === 0, 4000),
      `the webhook stopped delivering at ${webhook.requests.length} of ${index + 1}; the hung mail server consumed its budget`,
    );
  }
  assert.equal(alertMetrics().email.dropped - before.email.dropped, 3, 'the mail transport was not the thing being blocked');
  assert.equal(alertMetrics().delivered - before.delivered, 4, 'the webhook delivered fewer than every event');
});

// An operator receiving 500 of these in an hour has no alerting: the one that mattered is unfindable, and
// a submission relay seeing that rate starts refusing, which loses everything after it too. A digest was
// rejected because digesting means holding message content, which is the unbounded in-flight state
// fail-open forbids. So: a rate bound, with the suppressed count carried into the next message that does
// go out, in a header — never in the body, which is the record and stays the record.
test('the hourly ceiling suppresses rather than floods, and says how many it suppressed', async (t) => {
  const mailbox = await startMailbox();
  configure(mailbox.settings({ OPENPPWR_ALERT_EMAIL_MAX_PER_HOUR: '2' }));
  const capture = capturing();
  const start = Date.now() + 7200000;
  try {
    // The clock is frozen so the window cannot roll under the test, and advanced so it rolls exactly
    // where the test says it does.
    t.mock.timers.enable({ apis: ['Date'], now: new Date(start) });
    const before = alertMetrics();
    for (let index = 0; index < 5; index += 1) log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, attempt: index });
    assert.ok(await waitFor(() => alertMetrics().email.delivered - before.email.delivered === 2, 5000),
      `delivered ${alertMetrics().email.delivered - before.email.delivered} of an allowance of 2`);
    assert.equal(alertMetrics().email.dropped - before.email.dropped, 3, 'the hourly ceiling did not hold');
    assert.equal(alertMetrics().email.suppressed, 3);
    assert.equal(mailbox.received.length, 2);
    assert.equal(mailbox.received[0].headers.has('x-openppwr-suppressed'), false);

    t.mock.timers.setTime(start + 3700000);
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, attempt: 'after' });
    t.mock.timers.reset();
    assert.ok(await waitFor(() => mailbox.received.length === 3, 5000), 'the window never rolled');
  } finally {
    t.mock.timers.reset();
    capture.stop();
  }
  const message = mailbox.received[2];
  assert.equal(message.headers.get('x-openppwr-suppressed'), '3');
  assert.match(message.headers.get('subject'), /\(\+3 suppressed\)$/u);
  assert.equal(alertMetrics().email.suppressed, 0, 'the carried count was not cleared once it was reported');
  assert.ok(capture.records().some((entry) => entry.event === 'observability.alert.dropped' && entry.reason === 'email_rate_ceiling'),
    'suppression must be visible in the log as well as in the next message');
  // And the body is still the record. The count rides in metadata precisely so this stays true.
  const emitted = capture.records().find((entry) => entry.attempt === 'after');
  assert.equal(message.body, JSON.stringify(emitted));
});

test('mail configuration that cannot be honoured disables routing loudly, and repeats nothing sensitive', async () => {
  const mailbox = await startMailbox();
  const base = mailbox.settings();
  const cases = [
    ['invalid_smtp_host', { ...base, OPENPPWR_ALERT_SMTP_HOST: 'not a host name' }],
    ['unknown_smtp_tls_mode', { ...base, OPENPPWR_ALERT_SMTP_TLS: 'maybe' }],
    ['invalid_smtp_port', { ...base, OPENPPWR_ALERT_SMTP_PORT: '70000' }],
    ['missing_email_sender', { ...base, OPENPPWR_ALERT_EMAIL_FROM: '' }],
    ['invalid_email_sender', { ...base, OPENPPWR_ALERT_EMAIL_FROM: 'openppwr-alerts@example.invalid>\r\nRCPT TO:<attacker@example.invalid' }],
    ['missing_email_recipient', { ...base, OPENPPWR_ALERT_EMAIL_TO: '' }],
    ['invalid_email_recipient', { ...base, OPENPPWR_ALERT_EMAIL_TO: 'security@example.invalid, not an address' }],
    ['invalid_email_recipient', { ...base, OPENPPWR_ALERT_EMAIL_TO: new Array(11).fill('a@example.invalid').join(',') }],
    // A credential over a cleartext TCP connection is handed to anything on the path. Refused, not
    // downgraded to an unauthenticated attempt and not sent anyway.
    ['credentials_without_tls', { ...base, OPENPPWR_ALERT_SMTP_USERNAME: 'relay-user', OPENPPWR_ALERT_SMTP_PASSWORD: 'relay-secret-p7' }],
    ['password_without_username', { ...base, OPENPPWR_ALERT_SMTP_TLS: 'starttls', OPENPPWR_ALERT_SMTP_PASSWORD: 'relay-secret-p7' }],
    ['invalid_email_rate_ceiling', { ...base, OPENPPWR_ALERT_EMAIL_MAX_PER_HOUR: '0' }],
    ['invalid_deployment_name', { ...base, OPENPPWR_ALERT_DEPLOYMENT: 'acme prod\r\nBcc: attacker@example.invalid' }],
  ];
  const capture = capturing();
  try {
    for (const [reason, values] of cases) {
      configure(values);
      log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500, reason });
      await settle();
      assert.equal(alertMetrics().configured, false, `${reason} left routing enabled`);
      assert.equal(alertMetrics().email.configured, false, `${reason} left the mail transport enabled`);
    }
    await new Promise((tick) => setTimeout(tick, 200));
  } finally {
    capture.stop();
  }
  assert.equal(mailbox.received.length, 0, 'a deployment with invalid mail configuration sent mail anyway');
  const disabled = capture.records().filter((entry) => entry.event === 'observability.alert.disabled');
  for (const [reason] of cases) {
    assert.ok(disabled.some((entry) => entry.reason === reason), `${reason} was refused silently`);
  }
  assert.ok(!capture.raw().includes('relay-secret-p7'), 'a mail credential was written to the log');
});

// The rule the webhook half already lives by, applied to the second transport: an unusable destination
// must not leave the other one quietly running, because then the deployment is not doing what its
// configuration says and nothing about the running system reveals which half is live.
test('one unusable transport disables routing rather than leaving the other running', async () => {
  const webhook = await startWebhook();
  configure({ OPENPPWR_ALERT_WEBHOOK_URL: webhook.url, OPENPPWR_ALERT_SMTP_HOST: '127.0.0.1', OPENPPWR_ALERT_EMAIL_FROM: 'a@example.invalid' });
  const capture = capturing();
  try {
    log('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 });
    await settle();
    await new Promise((tick) => setTimeout(tick, 200));
  } finally {
    capture.stop();
  }
  assert.equal(alertMetrics().configured, false);
  assert.equal(alertMetrics().webhook.configured, false, 'the webhook transport survived an unusable mail transport');
  assert.equal(webhook.requests.length, 0, 'the webhook kept delivering while the mail transport was unusable');
  // The reason itself is asserted in the refusal-cases test above rather than here. It cannot be
  // asserted in both: the notice throttle keys on event, transport and reason for a minute, so the
  // second test in the same process to provoke a given reason correctly sees nothing.
  assert.ok(capture.records().some((entry) => entry.event === 'api.request.refused'),
    'the event must still be logged when no transport can carry it');
});

// A capability the container cannot see is not a capability. `--env-file` supplies values for a compose
// file's own `${...}` interpolation and injects nothing into a container, so a variable an operator sets
// in `openppwr.env` has no effect until it is also named in the service's `environment:` block. That has
// already happened twice in this repository to shipped settings whose documented behaviour could not be
// reached.
test('every mail alerting variable is named in the API service, or the operator setting it does nothing', async () => {
  const compose = await readFile(COMPOSE, 'utf8');
  const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  assert.ok(api.length > 0, 'the api service was not found; the parse is wrong, not the compose file');
  const absent = EMAIL_VARIABLES.filter((name) => !api.includes(`      ${name}: \${${name}:-}`));
  assert.deepEqual(absent, [], `not passed into the api container, so setting them in openppwr.env has no effect:\n${absent.join('\n')}`);
});
