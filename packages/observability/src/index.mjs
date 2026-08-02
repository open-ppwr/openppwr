// Structured, redacting logger for security events, and the routing of those events to a destination
// outside the process.
//
// The write is deferred off the caller's stack. `process.stdout` is synchronous when it points at a
// file or a TTY, so logging inline made every refusal a blocking filesystem write on the request
// path. Under a gate that redirects output to a file this turned a 74-second test suite into a
// 20-minute timeout — and the same coupling would stall request handling in production whenever the
// log destination was slow to drain.
//
// Deferring keeps every event and removes the coupling. Ordering within a process is preserved
// because setImmediate callbacks run in scheduling order.
//
// Routing obeys the same rule, and for the same reason. A remote destination is far more likely to be
// slow than a local file is, so nothing about delivery may be visible to the caller: `log` returns
// after scheduling, never after sending, and no delivery outcome — timeout, refusal, 500 — can reach
// the request that produced the event.

import { randomUUID } from 'node:crypto';
import { isEnvelopeAddress, sendMail } from './smtp.mjs';

// Redaction happens once, in `serialize`, and every path out of this module goes through it. That is
// deliberate: the destination receives the bytes the log line is made of and never a separately
// assembled payload, so there is exactly one place where redaction can be got right or wrong.
//
// Dropped by name. `apiKey` was named in the documentation as a dropped field and was not actually
// matched by the expression; it is now, along with the other names a credential is ordinarily carried
// under. A key that matches is removed entirely rather than emptied, because an empty key still says
// the value existed.
const SECRET_KEY = /pass(?:word|phrase)|secret|token|authorization|credential|bearer|cookie|api[-_]?key|private[-_]?key/iu;
// Redacted by value, for the case the key rule cannot see: a secret pasted inside an ordinary message.
const SECRET_ASSIGNMENT = /(authorization|password|passphrase|secret|token|credential|api[-_]?key)=[^\s]+/giu;
// And the bare presentation form, which carries no `=` at all. `Bearer <token>` inside a message body
// or an upstream error string is the shape that would otherwise survive both rules above.
const BEARER_PRESENTATION = /\bbearer\s+[^\s"',;]+/giu;

const redact = (value) => String(value)
  .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
  .replace(BEARER_PRESENTATION, 'Bearer [REDACTED]');

function sanitize(fields) {
  return Object.fromEntries(Object.entries(fields)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
}

// One record, one line, one set of bytes. `JSON.stringify` is also what makes a value containing a
// newline inert: a forged second entry arrives as text inside this record rather than as a record of
// its own.
function serialize(level, event, fields) {
  return JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...sanitize(fields) });
}

export function log(level, event, fields = {}) {
  const line = serialize(level, event, fields);
  setImmediate(() => process.stdout.write(`${line}
`));
  route(level, event, line);
}

// Same record, written now. For tests that need to observe the output, and for shutdown paths where a
// deferred write would never run. Routing is attempted from here too — it is the same event — but a
// process that is shutting down will usually exit before delivery completes. That is stated in the
// logging documentation rather than papered over with a blocking wait on the shutdown path.
export function logSync(level, event, fields = {}) {
  const line = serialize(level, event, fields);
  process.stdout.write(`${line}
`);
  route(level, event, line);
}

// ---------------------------------------------------------------------------------------------
// Routing security events to a destination.
//
// The standard asks for alerts on critical events. The events existed and nothing carried them
// anywhere; this is the carrier. Choosing and operating the destination is an operator decision, and
// with no destination configured this code does nothing at all.
//
// Fail-open, deliberately. If the destination is unreachable the operation the event describes still
// completes, and the alert is dropped and counted. The argument, because it is a real trade-off:
//
//   - The events routed here are refusals. They are produced *after* the request has already been
//     decided; the security decision is made, recorded in the log and, where it matters, in the audit
//     chain. Failing the request because the notification could not be sent would not un-refuse
//     anything. It would only convert an alerting outage into an availability outage.
//   - Fail-closed on a notification channel is a denial-of-service primitive. Anything that can make
//     the destination unreachable — a DNS failure, an expired certificate, a receiving service under
//     maintenance — could then take the API down, and an attacker who can provoke that gains far more
//     than they lose by suppressing an alert.
//   - The audit chain, not this channel, is the integrity record. Alerts are for latency of response,
//     not for proof; a dropped alert costs response time, and losing the whole API costs everything.
//
// What fail-open must not be allowed to become is silence. So every drop is counted, the counter is
// readable through `alertMetrics()`, and a drop or a delivery failure emits its own record on stdout —
// which is collected — so that "the alerts stopped" is itself visible in the logs. A deployment that
// requires proof of delivery needs a destination that acknowledges and an operator watching that
// destination for gaps; that is the honest limit of what a fire-and-forget channel can offer, and it
// is stated rather than implied.
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

// Records this module writes about its own routing. They are never routed: a destination that answers
// 500 would otherwise produce a failure record, which would be routed, which would fail — a loop that
// ends in a hot process rather than in an alert.
const INTERNAL_EVENT_PREFIX = 'observability.alert.';

// Two transports, and they are not exclusive. An operator may configure either, both, or neither.
// Both at once is a supported and sometimes correct shape — a chat webhook for the people already
// watching a channel, a mailbox for the out-of-hours record — so nothing here makes one turn the other
// off. What they do NOT share is a delivery budget: an SMTP server that hangs must not be able to
// consume the ceiling the webhook needs, so the ceiling is applied per transport rather than to a
// combined count.
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

const DEFAULT_MIN_LEVEL = 'error';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_IN_FLIGHT = 16;
const NOTICE_INTERVAL_MS = 60000;

// There is no default destination of any kind — no host, no address, no relay. A security product that
// ships pointing at somebody's mailbox is a product that sends one deployment's refusals to a third
// party, and every operator here runs their own. Absent is off.
const SMTP_TLS_MODES = ['starttls', 'implicit', 'disabled'];
const DEFAULT_SMTP_TLS = 'starttls';
const DEFAULT_SMTP_PORT = { starttls: 587, implicit: 465, disabled: 25 };
const DEFAULT_DEPLOYMENT = 'unnamed';
const MAX_RECIPIENTS = 10;

// The e-mail ceiling, and why e-mail has one when the webhook does not.
//
// A webhook points at software. A collector receiving 500 records in an hour aggregates them, which is
// what it is for. A mailbox points at a person, and 500 messages in an hour is not an alert — it is the
// destruction of the channel, because the one message that mattered is now unfindable, and because a
// submission relay that sees that rate will start refusing or blocklisting the sender, which loses the
// alerts that come after as well.
//
// A digest was considered and rejected. Digesting means holding message content until the window closes,
// which is exactly the unbounded in-flight state the fail-open design forbids: a destination that stops
// answering must never cause this process to accumulate anything. So the bound is a rate with a carried
// suppression count instead. State is two integers, the body of every message that does go out is still
// the unaltered log record, and the count of what was suppressed rides in a header and the subject —
// never in the body, which would break the one-serialization property.
const DEFAULT_EMAIL_MAX_PER_HOUR = 60;
const EMAIL_WINDOW_MS = 3600000;

const counters = { considered: 0, delivered: 0, rejected: 0, failed: 0, dropped: 0 };
const emailCounters = { delivered: 0, rejected: 0, failed: 0, dropped: 0 };
const emailWindow = { startedAt: 0, sent: 0, suppressed: 0 };
const noticedAt = new Map();
let inFlight = 0;
let emailInFlight = 0;
let cachedKey = null;
let cachedConfig = null;

// A repeated runtime condition — the destination has been down for an hour — must not turn stdout into
// the flood the size cap on the log driver then discards yesterday's evidence to hold. First occurrence
// of each distinct reason is always emitted; after that, at most one per minute.
//
// These go out through `log` like anything else — one emission path, one place redaction happens — and
// it is `route`'s prefix guard, not a separate private writer, that stops them being sent to the
// destination they are complaining about. That is deliberate: a guard on the only path is a guard that
// a test can remove and watch fail, where a second private writer would make the guard unreachable and
// therefore unfalsifiable.
function notice(level, event, fields) {
  // The transport is part of the key. Without it a webhook timing out would throttle the record that
  // says the mail server is also timing out, and an operator would see one outage where there are two.
  const key = `${event}:${fields.transport ?? ''}:${fields.reason ?? ''}`;
  const now = Date.now();
  const previous = noticedAt.get(key);
  if (previous !== undefined && now - previous < NOTICE_INTERVAL_MS) return;
  noticedAt.set(key, now);
  log(level, event, fields);
}

// Compose passes an unset variable through as an empty string, so "" has to mean absent everywhere
// here. Treating it as a present-but-invalid value would turn the shipped default configuration into a
// misconfiguration report on every deployment that never enabled alerting.
function setting(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bounded(raw, fallback, minimum, maximum) {
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

// Refusing to route is the response to *invalid* configuration, and it is loud. The alternative —
// falling back to the defaults — silently gives an operator who asked for `warn` the coverage of
// `error`, and they would have no way to tell. Absent configuration is the only thing that means "off"
// quietly; a value that was typed and cannot be honoured says so.
//
// The reason never carries the URL. A webhook URL is frequently the credential (a Slack endpoint is
// nothing but a secret in a path), and a misconfiguration report is exactly the record most likely to
// be pasted into a ticket. The same rule now covers the mail settings: no host, no address, no
// username, no password ever appears in a reason.
function refuse(reason) {
  notice('error', `${INTERNAL_EVENT_PREFIX}disabled`, { reason });
  return null;
}

// A label, not an address. It goes in the subject line and in a header so a mail rule can file by
// deployment, and it is constrained rather than escaped: an unconstrained value here is interpolated
// into a header, and a header is where CRLF injection buys a second recipient.
const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
// A hostname or a bracketed literal. Interpolated into nothing, but it is worth refusing a value that
// could only have come from a mistake.
const SMTP_HOST = /^[A-Za-z0-9.[\]:_-]{1,253}$/u;

function buildWebhook() {
  const raw = setting('OPENPPWR_ALERT_WEBHOOK_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return refuse('unparseable_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('unsupported_scheme');
  // Not a refusal: a collector inside the deployment is reachable over plain HTTP by design, the same
  // way web reaches the API. It is worth one record, once, because a destination on the public internet
  // over HTTP puts refusal metadata on the wire in cleartext.
  if (url.protocol === 'http:') notice('warn', `${INTERNAL_EVENT_PREFIX}insecure_scheme`, { reason: 'http' });
  const headers = { 'content-type': 'application/json' };
  const token = setting('OPENPPWR_ALERT_WEBHOOK_TOKEN');
  if (token) headers.authorization = `Bearer ${token}`;
  return { url: url.href, headers };
}

function buildEmail() {
  const host = setting('OPENPPWR_ALERT_SMTP_HOST');
  if (!SMTP_HOST.test(host)) return refuse('invalid_smtp_host');
  const mode = (setting('OPENPPWR_ALERT_SMTP_TLS') || DEFAULT_SMTP_TLS).toLowerCase();
  if (!SMTP_TLS_MODES.includes(mode)) return refuse('unknown_smtp_tls_mode');
  const port = bounded(setting('OPENPPWR_ALERT_SMTP_PORT'), DEFAULT_SMTP_PORT[mode], 1, 65535);
  if (port === null) return refuse('invalid_smtp_port');

  const from = setting('OPENPPWR_ALERT_EMAIL_FROM');
  if (!from) return refuse('missing_email_sender');
  if (!isEnvelopeAddress(from)) return refuse('invalid_email_sender');
  const to = setting('OPENPPWR_ALERT_EMAIL_TO');
  if (!to) return refuse('missing_email_recipient');
  const recipients = to.split(',').map((address) => address.trim()).filter(Boolean);
  if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) return refuse('invalid_email_recipient');
  if (!recipients.every(isEnvelopeAddress)) return refuse('invalid_email_recipient');

  const username = setting('OPENPPWR_ALERT_SMTP_USERNAME');
  const password = setting('OPENPPWR_ALERT_SMTP_PASSWORD');
  // The credential is the thing being protected here, so this is a refusal rather than a warning. A
  // deployment that submits a username and password over a cleartext TCP connection has handed them to
  // anything on the path, and doing it quietly because the operator set both variables is worse than
  // not sending the alert. An internal relay that speaks no TLS is still usable — with no credentials.
  if (username && mode === 'disabled') return refuse('credentials_without_tls');
  if (password && !username) return refuse('password_without_username');

  const maxPerHour = bounded(setting('OPENPPWR_ALERT_EMAIL_MAX_PER_HOUR'), DEFAULT_EMAIL_MAX_PER_HOUR, 1, 10000);
  if (maxPerHour === null) return refuse('invalid_email_rate_ceiling');
  if (mode === 'disabled') notice('warn', `${INTERNAL_EVENT_PREFIX}insecure_scheme`, { reason: 'smtp_cleartext' });

  return { host, port, tls: mode, username, password, from, recipients, maxPerHour, domain: from.split('@')[1] };
}

function buildAlertConfig() {
  const wantsWebhook = setting('OPENPPWR_ALERT_WEBHOOK_URL') !== null;
  const wantsEmail = setting('OPENPPWR_ALERT_SMTP_HOST') !== null;
  // Neither destination named. Off, completely and silently — no attempt, no complaint, no record that
  // alerting exists at all.
  if (!wantsWebhook && !wantsEmail) return null;

  const minLevel = (setting('OPENPPWR_ALERT_MIN_LEVEL') || DEFAULT_MIN_LEVEL).toLowerCase();
  if (!Object.hasOwn(LEVEL_RANK, minLevel)) return refuse('unknown_minimum_level');
  const timeoutMs = bounded(setting('OPENPPWR_ALERT_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS, 100, 15000);
  if (timeoutMs === null) return refuse('invalid_timeout');
  const maxInFlight = bounded(setting('OPENPPWR_ALERT_MAX_IN_FLIGHT'), DEFAULT_MAX_IN_FLIGHT, 1, 256);
  if (maxInFlight === null) return refuse('invalid_in_flight_ceiling');
  const deployment = setting('OPENPPWR_ALERT_DEPLOYMENT') ?? DEFAULT_DEPLOYMENT;
  if (!DEPLOYMENT_NAME.test(deployment)) return refuse('invalid_deployment_name');

  // One unusable transport disables routing entirely rather than leaving the other running. An operator
  // who configured two destinations and is silently served one has the same problem as an operator who
  // asked for `warn` and silently got `error`: the deployment is not doing what its configuration says,
  // and nothing about the running system reveals which half is live.
  const webhook = wantsWebhook ? buildWebhook() : null;
  if (wantsWebhook && !webhook) return null;
  const email = wantsEmail ? buildEmail() : null;
  if (wantsEmail && !email) return null;

  return { webhook, email, minLevel, timeoutMs, maxInFlight, deployment };
}

// Keyed on the raw variables rather than resolved once at import. Reading the environment at import
// time would make the configuration depend on module load order, and would make it untestable without
// a module cache reset; keying on the values re-derives only when an operator actually changed one.
function alertConfig() {
  // `JSON.stringify` of the values, not a joined string: with any separator a value containing that
  // separator makes two different configurations produce the same key, and the second one is then served
  // a cached configuration built from the first.
  const key = JSON.stringify(ALERT_VARIABLES.map((name) => process.env[name] ?? null));
  if (key !== cachedKey) {
    cachedKey = key;
    cachedConfig = buildAlertConfig();
  }
  return cachedConfig;
}

async function deliver(config, line) {
  try {
    const response = await fetch(config.webhook.url, {
      method: 'POST',
      headers: config.webhook.headers,
      // The log line verbatim. Not a payload assembled here from the same fields — that would be a
      // second formatting path, and a second place for redaction to be forgotten.
      body: line,
      // Bounded, and bounded by the only mechanism that covers a destination which accepts the
      // connection and then never answers. A connect timeout alone would not.
      signal: AbortSignal.timeout(config.timeoutMs),
      // A redirect would send the body, and the shared secret in the Authorization header, to a host
      // the operator did not configure. There is no legitimate reason for an alert sink to redirect.
      redirect: 'error',
    });
    // Discarded rather than read: the body of an alert acknowledgement is of no interest, and an
    // unconsumed body holds the socket open.
    if (response.body) await response.body.cancel().catch(() => {});
    if (response.ok) counters.delivered += 1;
    else {
      counters.rejected += 1;
      notice('warn', `${INTERNAL_EVENT_PREFIX}rejected`, { reason: `status_${response.status}`, transport: 'webhook', status: response.status, rejected: counters.rejected });
    }
  } catch (error) {
    counters.failed += 1;
    // The name, never the message. A fetch failure message embeds the URL, which is frequently the
    // credential.
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unreachable';
    notice('warn', `${INTERNAL_EVENT_PREFIX}failed`, { reason, transport: 'webhook', failed: counters.failed });
  }
}

// ---------------------------------------------------------------------------------------------
// The e-mail transport.

// A fixed window, and the suppressed count is carried rather than discarded. When the ceiling has been
// holding for a while, the next message that does get sent says how many did not — so "alerting went
// quiet" and "alerting was throttled" are distinguishable from the mailbox alone, without reading the
// container log. The state is two integers and never message content.
function emailBudget(config) {
  const now = Date.now();
  if (now - emailWindow.startedAt >= EMAIL_WINDOW_MS) {
    emailWindow.startedAt = now;
    emailWindow.sent = 0;
  }
  if (emailWindow.sent >= config.email.maxPerHour) {
    emailWindow.suppressed += 1;
    return null;
  }
  emailWindow.sent += 1;
  const suppressed = emailWindow.suppressed;
  emailWindow.suppressed = 0;
  return { suppressed };
}

// An event name reaches the subject line and a header. Every one of them is a constant at a call site in
// this repository, so this cannot currently be hostile — which is exactly why it is constrained here
// rather than left to the day somebody derives an event name from input.
function headerToken(value) {
  return String(value).replace(/[^\x20-\x7e]/gu, '_').slice(0, 120);
}

// The subject is what an operator sees in a list of 40 messages, so it names the deployment, the
// severity and the event class, in that order, and nothing else. The suppression count appears here and
// in a header — never in the body, which is the log record and only the log record.
function emailMessage(config, level, event, line, suppressed) {
  const deployment = config.deployment;
  const suffix = suppressed > 0 ? ` (+${suppressed} suppressed)` : '';
  // The record may carry a Polish or German filename, so it is not necessarily ASCII. Rather than
  // negotiate 8BITMIME, anything outside ASCII is base64-encoded: the transferred form differs, the
  // decoded bytes are the log line exactly, and there is still only one serialization.
  const encoding = /[^\x00-\x7f]/u.test(line) ? 'base64' : '7bit';
  const headers = [
    ['From', config.email.from],
    ['To', config.email.recipients.join(', ')],
    ['Subject', `[OpenPPWR ${deployment}] ${headerToken(level)} ${headerToken(event)}${suffix}`],
    ['Date', new Date().toUTCString()],
    ['Message-ID', `<${randomUUID()}@${config.email.domain}>`],
    // RFC 3834. Without it a recipient's out-of-office replies to an alert address, and two automated
    // systems answering each other is a loop nobody notices until the mailbox is full.
    ['Auto-Submitted', 'auto-generated'],
    ['Precedence', 'bulk'],
    // What a mail rule files on. Separate fields rather than one blob: an operator wants "everything
    // from the production deployment" and "every authentication event" to be different rules.
    ['X-OpenPPWR-Alert', 'security-event'],
    ['X-OpenPPWR-Deployment', deployment],
    ['X-OpenPPWR-Level', headerToken(level)],
    ['X-OpenPPWR-Event', headerToken(event)],
    // The record is JSON, and saying so lets a rule or a script parse it without guessing.
    ['MIME-Version', '1.0'],
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Content-Transfer-Encoding', encoding],
  ];
  if (suppressed > 0) headers.push(['X-OpenPPWR-Suppressed', String(suppressed)]);
  return { headers, encoding };
}

async function deliverEmail(config, level, event, line, suppressed) {
  const { headers, encoding } = emailMessage(config, level, event, line, suppressed);
  try {
    await sendMail({
      host: config.email.host,
      port: config.email.port,
      tls: config.email.tls,
      username: config.email.username,
      password: config.email.password,
      from: config.email.from,
      recipients: config.email.recipients,
      headers,
      // The log line verbatim, for the same reason the webhook gets it verbatim: a body assembled here
      // from the same fields would be a second formatting path and a second place for redaction to be
      // forgotten.
      body: line,
      encoding,
      timeoutMs: config.timeoutMs,
    });
    counters.delivered += 1;
    emailCounters.delivered += 1;
  } catch (error) {
    // An enumerated token from the client, never the server's text and never the host: SMTP servers put
    // the connecting address, the relay name and sometimes the authenticated username into a rejection.
    const reason = typeof error?.reason === 'string' ? error.reason : 'session_failed';
    if (reason === 'rejected') {
      counters.rejected += 1;
      emailCounters.rejected += 1;
      notice('warn', `${INTERNAL_EVENT_PREFIX}rejected`, { reason: `smtp_${error.replyCode}`, transport: 'email', status: error.replyCode, rejected: counters.rejected });
    } else {
      counters.failed += 1;
      emailCounters.failed += 1;
      notice('warn', `${INTERNAL_EVENT_PREFIX}failed`, { reason, transport: 'email', failed: counters.failed });
    }
  }
}

function routeWebhook(config, line) {
  // Bounded by dropping, not by queueing. An unbounded queue in front of a destination that has
  // stopped answering is a memory leak that ends in the process being killed — which loses the events
  // the queue was protecting, plus everything else the process was doing.
  if (inFlight >= config.maxInFlight) {
    counters.dropped += 1;
    notice('warn', `${INTERNAL_EVENT_PREFIX}dropped`, { reason: 'in_flight_ceiling', transport: 'webhook', dropped: counters.dropped, ceiling: config.maxInFlight });
    return;
  }
  inFlight += 1;
  // Off the caller's stack for the same reason the write is. `fetch` resolves the URL and validates
  // headers synchronously before it ever reaches the network, and none of that belongs on a request.
  setImmediate(() => {
    deliver(config, line).finally(() => { inFlight -= 1; });
  });
}

function routeEmail(config, level, event, line) {
  // The same ceiling value, counted separately. SMTP is the transport most able to hang — connect, TLS
  // handshake and mid-transaction are three distinct places a mail server stalls for minutes — so a
  // shared counter would let a dead relay close the webhook's channel as well.
  if (emailInFlight >= config.maxInFlight) {
    counters.dropped += 1;
    emailCounters.dropped += 1;
    notice('warn', `${INTERNAL_EVENT_PREFIX}dropped`, { reason: 'in_flight_ceiling', transport: 'email', dropped: counters.dropped, ceiling: config.maxInFlight });
    return;
  }
  const budget = emailBudget(config);
  if (!budget) {
    counters.dropped += 1;
    emailCounters.dropped += 1;
    notice('warn', `${INTERNAL_EVENT_PREFIX}dropped`, { reason: 'email_rate_ceiling', transport: 'email', dropped: counters.dropped, ceiling: config.email.maxPerHour });
    return;
  }
  emailInFlight += 1;
  setImmediate(() => {
    deliverEmail(config, level, event, line, budget.suppressed).finally(() => { emailInFlight -= 1; });
  });
}

function route(level, event, line) {
  if (event.startsWith(INTERNAL_EVENT_PREFIX)) return;
  const config = alertConfig();
  if (!config) return;
  if ((LEVEL_RANK[level] ?? 0) < LEVEL_RANK[config.minLevel]) return;
  counters.considered += 1;
  if (config.webhook) routeWebhook(config, line);
  if (config.email) routeEmail(config, level, event, line);
}

// Readable in-process, and the numbers a deployment is judged on: `dropped` is the fail-open cost made
// countable. `considered` counts events accepted for routing, once per event; `delivered`, `rejected`,
// `failed` and `dropped` count deliveries, so with both transports enabled one event can produce two of
// them. The per-transport view is what tells an operator which destination stopped working.
export function alertMetrics() {
  const config = alertConfig();
  return {
    ...counters,
    // Every delivery outstanding anywhere. A leak in either transport shows here.
    inFlight: inFlight + emailInFlight,
    configured: config !== null,
    webhook: { configured: config?.webhook != null, inFlight },
    email: { configured: config?.email != null, inFlight: emailInFlight, suppressed: emailWindow.suppressed, ...emailCounters },
  };
}
