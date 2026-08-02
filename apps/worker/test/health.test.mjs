// Worker health semantics.
//
// The defect these tests exist to prevent, verbatim from `server.mjs` before 2026-07-30:
//
//   workerHealthy = !result?.errorCode;
//
// `processNextScanJob` returns `null` when the queue is empty, `null?.errorCode` is `undefined`, and
// `!undefined` is `true`. So a worker whose scanner had just failed declared itself healthy again on the
// next empty poll. An outage was indistinguishable from an idle queue — the one thing a health endpoint
// exists to distinguish.
//
// The rule under test throughout: a successful empty poll proves connectivity and nothing else. It clears
// poll failures. It never clears an unresolved infrastructure fault, because no scan happened.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INFRASTRUCTURE_FAULTS, ITEM_FAULTS, WorkerHealth, classifyFailure } from '../src/health.mjs';
import { loadWorkerConfig } from '../src/index.mjs';

// A credential shaped like the one bootstrap mints. The fixtures used the five-character string
// 'token', which `assertStrongSecrets` now refuses — correctly, and the fixture was the unrealistic
// part.
const WORKER_TOKEN = ['opp_', 'test_', 'b7Kq2mXr', '9TfLp4Zc', '8VnD6Hsw'].join('');


// A controllable clock, so staleness and ordering are asserted rather than slept through.
function fixedClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function readyWorker(clock) {
  const health = new WorkerHealth({ clock: clock.now, staleAfterMs: 300_000 });
  health.recordAuthentication({ ok: true });
  health.recordTenancy({ tenants: 1, enforced: true });
  health.recordPollSuccess({ empty: true });
  return health;
}

test('a worker that has not authenticated or checked tenancy is unready, not healthy', () => {
  const clock = fixedClock();
  const health = new WorkerHealth({ clock: clock.now });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.equal(snapshot.ready, false);
  // Liveness is independent: the process is running, and a scanner outage must never provoke a restart.
  assert.equal(snapshot.live, true);
  assert.ok(snapshot.reasons.includes('WORKER_NOT_AUTHENTICATED'));
  assert.ok(snapshot.reasons.includes('WORKER_TENANCY_NOT_CHECKED'));
});

test('an authenticated worker with one tenant and a successful poll is healthy', () => {
  const clock = fixedClock();
  const snapshot = readyWorker(clock).snapshot();
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.reasons, []);
});

// The regression itself.
test('an empty poll after a healthy state stays ready without inventing progress', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ scanStatus: 'clean' });
  clock.advance(1000);
  health.recordPollSuccess({ empty: true });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.counters.completedJobs, 1);
  assert.equal(snapshot.counters.lastEmptyPollAt, clock.now());
});

// The core of the model, stated as the assertion that would have failed against the old boolean.
test('an empty poll does not clear an unresolved scanner fault', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'MALWARE_SCANNER_UNAVAILABLE', scanStatus: 'error' });
  assert.equal(health.snapshot().status, 'unready');

  // Ten empty polls later — the queue has drained — the worker must still report unready.
  for (let index = 0; index < 10; index += 1) {
    clock.advance(1000);
    health.recordPollSuccess({ empty: true });
  }
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready', 'an empty queue is not evidence that the scanner recovered');
  assert.deepEqual(snapshot.reasons, ['MALWARE_SCANNER_UNAVAILABLE']);
  assert.equal(snapshot.faults.infrastructure.code, 'MALWARE_SCANNER_UNAVAILABLE');
});

test('a completed scan clears the fault, because it is evidence both storage and scanner work', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'EVIDENCE_STORAGE_UNAVAILABLE', scanStatus: 'error' });
  assert.equal(health.snapshot().status, 'unready');
  clock.advance(1000);
  health.recordJobOutcome({ scanStatus: 'infected' });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.faults.infrastructure, null);
  assert.equal(snapshot.counters.consecutiveJobFailures, 0);
  assert.equal(snapshot.counters.lastCompletedJobAt, clock.now());
});

// Recovery has to be observable when the queue is empty, or an outage becomes permanent unreadiness with
// no path back: there is no job to succeed on.
test('a successful scanner probe clears the fault; a failed one does not', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'MALWARE_SCANNER_UNAVAILABLE', scanStatus: 'error' });

  clock.advance(1000);
  health.recordScannerProbe({ ok: false });
  assert.equal(health.snapshot().status, 'unready');
  assert.equal(health.snapshot().counters.lastScannerProbeOk, false);

  clock.advance(1000);
  health.recordScannerProbe({ ok: true });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.counters.lastScannerProbeOk, true);
  assert.equal(snapshot.counters.lastScannerProbeAt, clock.now());
});

test('authentication failure is unready and names itself', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordAuthentication({ ok: false, code: 'WORKER_AUTHENTICATION_FAILED' });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.deepEqual(snapshot.reasons, ['WORKER_AUTHENTICATION_FAILED']);
});

test('a failed poll is unready and reports the code rather than a generic failure', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordPollFailure('WORKER_DATABASE_UNAVAILABLE');
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.deepEqual(snapshot.reasons, ['WORKER_DATABASE_UNAVAILABLE']);
  assert.equal(snapshot.counters.consecutivePollFailures, 1);
  // A poll that then succeeds clears the poll failure — connectivity is exactly what it proves.
  clock.advance(1000);
  health.recordPollSuccess({ empty: true });
  assert.equal(health.snapshot().status, 'healthy');
});

test('a second tenant makes the worker unready', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordTenancy({ tenants: 2, enforced: false });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.deepEqual(snapshot.reasons, ['WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED']);
});

// The failure mode a boolean cannot express: the loop stopped iterating without throwing, so nothing ever
// set the flag false and the last recorded thing was a success.
test('a stale heartbeat makes the worker unready even though nothing failed', () => {
  const clock = fixedClock();
  const health = new WorkerHealth({ clock: clock.now, staleAfterMs: 60_000 });
  health.recordAuthentication({ ok: true });
  health.recordTenancy({ tenants: 1, enforced: true });
  health.recordPollSuccess({ empty: false });
  health.recordJobOutcome({ scanStatus: 'clean' });
  assert.equal(health.snapshot().status, 'healthy');

  clock.advance(59_000);
  assert.equal(health.snapshot().status, 'healthy');
  clock.advance(2000);
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.deepEqual(snapshot.reasons, ['WORKER_HEARTBEAT_STALE']);
  assert.ok(snapshot.heartbeatAgeMs > 60_000);
});

// A poisoned upload must not take a working worker out of service; that would stop every other item from
// being scanned, which is a self-inflicted outage in place of one bad file.
test('an item fault degrades rather than unreadies, and stays visible', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'EVIDENCE_INTEGRITY_MISMATCH', scanStatus: 'error' });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.ready, true, 'a degraded worker is still serving');
  assert.deepEqual(snapshot.reasons, ['EVIDENCE_INTEGRITY_MISMATCH']);

  // And an empty poll does not launder it away either.
  clock.advance(1000);
  health.recordPollSuccess({ empty: true });
  assert.equal(health.snapshot().status, 'degraded');
});

test('terminal jobs are reported as degraded, because they are waiting for a person', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordQueue({ pending: 4, running: 1, requiresAttention: 2, oldestPendingAgeMs: 90_000 });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.deepEqual(snapshot.reasons, ['SCAN_JOBS_REQUIRE_ATTENTION']);
  assert.equal(snapshot.queue.pending, 4);
  assert.equal(snapshot.queue.oldestPendingAgeMs, 90_000);

  clock.advance(1000);
  health.recordQueue({ pending: 0, running: 0, requiresAttention: 0, oldestPendingAgeMs: 0 });
  assert.equal(health.snapshot().status, 'healthy');
});

// An unready worker must not be reported as merely degraded: readiness is the stronger claim, so its
// reasons are the ones an operator sees.
test('an infrastructure fault outranks an item fault in what is reported', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'EVIDENCE_INTEGRITY_MISMATCH', scanStatus: 'error' });
  health.recordJobOutcome({ errorCode: 'MALWARE_SCANNER_UNAVAILABLE', scanStatus: 'error' });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready');
  assert.deepEqual(snapshot.reasons, ['MALWARE_SCANNER_UNAVAILABLE']);
  assert.equal(snapshot.faults.item.code, 'EVIDENCE_INTEGRITY_MISMATCH', 'the item fault is still recorded, just outranked');
});

test('every scanner failure code is classified, and an unknown one fails closed', () => {
  for (const code of INFRASTRUCTURE_FAULTS) assert.equal(classifyFailure(code), 'infrastructure');
  for (const code of ITEM_FAULTS) assert.equal(classifyFailure(code), 'content');
  assert.equal(classifyFailure(null), 'none');
  assert.equal(classifyFailure(undefined), 'none');
  // Fail closed: an unrecognised code reports a worker that may not be working, rather than one that
  // certainly is.
  assert.equal(classifyFailure('SOMETHING_NOBODY_HAS_SEEN'), 'infrastructure');
  // The two sets must not overlap, or a code's classification would depend on iteration order.
  for (const code of ITEM_FAULTS) assert.ok(!INFRASTRUCTURE_FAULTS.includes(code), `${code} is in both classes`);
});

test('the staleness window is configurable and bounded', () => {
  const base = { OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav' };
  assert.equal(loadWorkerConfig(base).healthStaleAfterMs, 300_000);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_WORKER_HEALTH_STALE_MS: '30000' }).healthStaleAfterMs, 30_000);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_HEALTH_STALE_MS: '0' }), /HEALTH_STALE/u);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_HEALTH_STALE_MS: '99999999' }), /HEALTH_STALE/u);
  assert.throws(() => new WorkerHealth({ staleAfterMs: 10 }), /at least 1000/u);
});

// The old boolean, written out, so the difference is a test rather than a claim in a commit message.
test('the replaced boolean would have reported healthy where this reports unready', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  health.recordJobOutcome({ errorCode: 'MALWARE_SCANNER_UNAVAILABLE', scanStatus: 'error' });
  clock.advance(1000);
  const emptyPollResult = null;
  const oldBoolean = !emptyPollResult?.errorCode;
  health.recordPollSuccess({ empty: !emptyPollResult });
  assert.equal(oldBoolean, true, 'this is what the previous implementation computed');
  assert.equal(health.snapshot().ready, false, 'and this is what it should have computed');
});

// The periodic tenancy guard reported an invariant it had stopped enforcing.
//
// `lastTenancyCheck` advanced *before* the check ran, so a recheck that threw — which is exactly what an
// unsupported topology causes — moved the deadline forward. The next poll skipped the check, the following
// successful poll cleared the failure, and the worker went on claiming jobs against stale state. The same
// shape as the startup-only check it was written to replace.
test('an unsupported topology latches and is not cleared by a later successful poll', () => {
  const clock = fixedClock();
  const health = readyWorker(clock);
  assert.equal(health.snapshot().status, 'healthy');

  // The recheck throws; the server records the unsupported topology.
  health.recordTenancy({ tenants: null, enforced: false });
  health.recordPollFailure('WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED');
  assert.equal(health.snapshot().status, 'unready');

  // A later poll succeeds — connectivity is fine, the topology is not.
  clock.advance(1000);
  health.recordPollSuccess({ empty: true });
  const snapshot = health.snapshot();
  assert.equal(snapshot.status, 'unready', 'a successful poll must not clear an unsupported topology');
  assert.ok(snapshot.reasons.includes('WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED'));

  // Only a successful recheck clears it.
  clock.advance(1000);
  health.recordTenancy({ tenants: 1, enforced: true });
  assert.equal(health.snapshot().status, 'healthy');
});

// The ordering itself, asserted against the source. A behavioural test cannot easily express "the timestamp
// moved too early", and that ordering is the whole defect.
test('the tenancy recheck advances its deadline only after the check succeeds', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const block = /if \(now - lastTenancyCheck >= config\.tenancyRecheckMs\) \{[\s\S]*?\n      \}/u.exec(source)?.[0];
  assert.ok(block, 'the recheck block was not found');
  const assignment = block.indexOf('lastTenancyCheck =');
  const check = block.indexOf('await assertSingleTenantDeployment');
  assert.ok(check !== -1 && assignment !== -1, 'the recheck no longer calls the guard');
  assert.ok(check < assignment, 'the deadline must advance after the check, or a throwing check skips the next one');
});

test('an unsupported topology is latched by the poll error handler, not merely logged', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED[\s\S]{0,400}recordTenancy\(\{ tenants: null, enforced: false \}\)/u,
    'the error handler must latch the unsupported topology so a later success cannot resume work',
  );
});

// A scanner probe cleared every infrastructure fault, including one about the filesystem.
test('a scanner probe clears a scanner fault and not a storage fault', () => {
  const clock = fixedClock();
  const storage = readyWorker(clock);
  storage.recordJobOutcome({ errorCode: 'EVIDENCE_STORAGE_UNAVAILABLE', scanStatus: 'error' });
  clock.advance(1000);
  storage.recordScannerProbe({ ok: true });
  assert.equal(storage.snapshot().status, 'unready', 'a reachable scanner is no evidence about the evidence volume');
  assert.deepEqual(storage.snapshot().reasons, ['EVIDENCE_STORAGE_UNAVAILABLE']);

  // A completed scan does clear it, because reading the file and getting a verdict exercises both.
  clock.advance(1000);
  storage.recordJobOutcome({ scanStatus: 'clean' });
  assert.equal(storage.snapshot().status, 'healthy');

  for (const code of ['MALWARE_SCANNER_UNAVAILABLE', 'MALWARE_SCANNER_MALFORMED_RESPONSE', 'MALWARE_SCAN_TIMEOUT']) {
    const scanner = readyWorker(fixedClock());
    scanner.recordJobOutcome({ errorCode: code, scanStatus: 'error' });
    scanner.recordScannerProbe({ ok: true });
    assert.equal(scanner.snapshot().status, 'healthy', `a probe must clear ${code}`);
  }
});
