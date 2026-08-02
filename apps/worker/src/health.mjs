// Worker health, as four separate questions instead of one boolean.
//
// The boolean was `workerHealthy = !result?.errorCode` in `server.mjs`, evaluated after every poll. When
// the queue was empty, `processNextScanJob` returned `null`, `result?.errorCode` was `undefined`, and the
// worker declared itself healthy — so a worker whose scanner was dead reported healthy the moment there
// was nothing left to fail on. An outage was indistinguishable from an idle queue, which is the state a
// health endpoint exists to distinguish.
//
// The four questions, kept apart because they have different answers and different consumers:
//
//   liveness    — is the process running and the event loop responsive? A restart is the only remedy for
//                 "no", so nothing else may be allowed to answer it.
//   readiness   — can this worker do its job right now: authenticate, reach the database, satisfy the
//                 tenancy invariant, reach the scanner? "No" means take it out of service; it does not
//                 mean restart it.
//   operational — is work actually progressing, and is anything waiting for a person? A worker can be
//                 ready and still have jobs parked in a terminal state.
//   progress    — the timestamps and counters behind the other three, reported so an operator can see
//                 *why* rather than being told a colour.
//
// The rule that makes this different from what it replaced: **a successful empty poll proves connectivity
// and nothing else.** It clears poll failures. It does not clear an unresolved scanner or storage fault,
// because no scan happened. An infrastructure fault is cleared by evidence — a completed scan, or a
// successful scanner probe — and by nothing else.

// A fault that means this worker cannot presently do its job. Any of these makes it unready, and stays
// outstanding until a scan completes or the scanner answers a probe.
export const INFRASTRUCTURE_FAULTS = Object.freeze([
  'MALWARE_SCANNER_UNAVAILABLE',
  'MALWARE_SCANNER_MALFORMED_RESPONSE',
  'MALWARE_SCAN_TIMEOUT',
  'EVIDENCE_STORAGE_UNAVAILABLE',
]);

// A fault that belongs to one evidence item. The worker is fine; this file is not. It degrades rather
// than unreadies, because taking a healthy worker out of service over one bad upload would stop every
// other tenant's evidence from being scanned — a self-inflicted outage.
export const ITEM_FAULTS = Object.freeze([
  'EVIDENCE_INTEGRITY_MISMATCH',
  'MALWARE_SCAN_SIZE_EXCEEDED',
  'STORAGE_PATH_INVALID',
  // A retention sweep that could not delete one item. Listed explicitly rather than left to the fail-closed
  // default, which would have made it an infrastructure fault and taken the worker out of service: the
  // scanner and the database are demonstrably reachable, because the same poll just used both. Housekeeping
  // that cannot finish is something a person must see, not a reason to stop scanning.
  'EVIDENCE_RETENTION_FAILED',
]);

// The subset a `zPING` is evidence about: the scanner answered, so it is reachable and speaking the protocol.
// `EVIDENCE_STORAGE_UNAVAILABLE` is deliberately absent — a reachable scanner says nothing about the volume.
export const SCANNER_REACHABILITY_FAULTS = Object.freeze([
  'MALWARE_SCANNER_UNAVAILABLE',
  'MALWARE_SCANNER_MALFORMED_RESPONSE',
  'MALWARE_SCAN_TIMEOUT',
]);

export function classifyFailure(code) {
  if (INFRASTRUCTURE_FAULTS.includes(code)) return 'infrastructure';
  if (ITEM_FAULTS.includes(code)) return 'content';
  // An unrecognised code is treated as infrastructure, which is the fail-closed direction: it reports a
  // worker that may not be working rather than a worker that certainly is.
  return code ? 'infrastructure' : 'none';
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export class WorkerHealth {
  constructor({ clock = () => Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1000) throw new TypeError('staleAfterMs must be at least 1000.');
    this.clock = clock;
    this.staleAfterMs = staleAfterMs;
    this.startedAt = clock();
    // Nothing is assumed. A worker that has not yet authenticated is unready, not healthy, so a process
    // that dies during startup never reports itself available.
    this.authenticated = false;
    this.authFailureCode = null;
    this.tenancy = null;
    this.lastSuccessfulPollAt = null;
    this.lastEmptyPollAt = null;
    this.lastFailedPollAt = null;
    this.lastPollFailureCode = null;
    this.consecutivePollFailures = 0;
    this.lastCompletedJobAt = null;
    this.lastJobFailureAt = null;
    this.consecutiveJobFailures = 0;
    this.completedJobs = 0;
    this.infrastructureFault = null;
    this.itemFault = null;
    this.lastScannerProbeAt = null;
    this.lastScannerProbeOk = null;
    this.queue = null;
  }

  recordAuthentication({ ok, code = null } = {}) {
    this.authenticated = ok === true;
    this.authFailureCode = ok === true ? null : code || 'WORKER_AUTHENTICATION_FAILED';
    return this;
  }

  recordTenancy({ tenants, enforced }) {
    this.tenancy = { tenants, enforced: enforced === true };
    return this;
  }

  // A poll that reached the database and returned, whether or not it carried a job.
  recordPollSuccess({ empty }) {
    const at = this.clock();
    this.lastSuccessfulPollAt = at;
    this.consecutivePollFailures = 0;
    this.lastPollFailureCode = null;
    if (empty) this.lastEmptyPollAt = at;
    // Deliberately absent: any clearing of `infrastructureFault` or `itemFault`. This is the whole of
    // the rule. An empty queue is not evidence that the scanner recovered.
    return this;
  }

  recordPollFailure(code) {
    this.lastFailedPollAt = this.clock();
    this.lastPollFailureCode = code || 'WORKER_POLL_FAILED';
    this.consecutivePollFailures += 1;
    return this;
  }

  // The outcome of one claimed job. `errorCode` null means a verdict was reached — which is the only
  // thing that proves the scanner and the storage path both work end to end.
  recordJobOutcome({ errorCode = null, scanStatus = null } = {}) {
    const at = this.clock();
    if (!errorCode) {
      this.lastCompletedJobAt = at;
      this.consecutiveJobFailures = 0;
      this.completedJobs += 1;
      // A completed scan is proof for both classes of fault at once: the file was read from storage and
      // the scanner returned a verdict.
      this.infrastructureFault = null;
      this.itemFault = null;
      return this;
    }
    this.lastJobFailureAt = at;
    this.consecutiveJobFailures += 1;
    const fault = { code: errorCode, at, scanStatus };
    if (classifyFailure(errorCode) === 'content') this.itemFault = fault;
    else this.infrastructureFault = fault;
    return this;
  }

  // The active probe. Without it, a worker with a dead scanner and an empty queue would stay unready for
  // ever with no way to notice recovery: there is no job to succeed on. `zPING`/`PONG` is cheap and
  // answers exactly the question the empty poll cannot.
  recordScannerProbe({ ok }) {
    this.lastScannerProbeAt = this.clock();
    this.lastScannerProbeOk = ok === true;
    // A probe clears only the faults it is evidence for.
    //
    // It cleared every infrastructure fault, so a successful `zPING` restored readiness after
    // `EVIDENCE_STORAGE_UNAVAILABLE` — a fault about the filesystem, which a scanner ping says nothing about
    // at all. That is the same error as the empty poll this whole model exists to reject: treating an
    // unrelated success as evidence.
    //
    // A completed scan still clears everything, because reading the file and getting a verdict exercises both.
    if (ok === true && this.infrastructureFault && SCANNER_REACHABILITY_FAULTS.includes(this.infrastructureFault.code)) {
      this.infrastructureFault = null;
    }
    return this;
  }

  recordQueue({ pending = 0, running = 0, requiresAttention = 0, oldestPendingAgeMs = 0 } = {}) {
    this.queue = { pending, running, requiresAttention, oldestPendingAgeMs, at: this.clock() };
    return this;
  }

  // A heartbeat is stale when neither a poll nor a job has been recorded inside the window. It catches
  // the case a boolean cannot: a loop that stopped iterating without throwing, so nothing ever set the
  // flag false and the last thing it recorded was a success.
  heartbeatAgeMs(at = this.clock()) {
    const last = Math.max(this.lastSuccessfulPollAt || 0, this.lastFailedPollAt || 0, this.startedAt);
    return at - last;
  }

  snapshot(at = this.clock()) {
    const notReady = [];
    const degraded = [];

    if (!this.authenticated) notReady.push(this.authFailureCode || 'WORKER_NOT_AUTHENTICATED');
    if (this.tenancy && !this.tenancy.enforced) notReady.push('WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED');
    if (!this.tenancy) notReady.push('WORKER_TENANCY_NOT_CHECKED');
    if (this.consecutivePollFailures > 0) notReady.push(this.lastPollFailureCode || 'WORKER_POLL_FAILED');
    if (this.infrastructureFault) notReady.push(this.infrastructureFault.code);
    const heartbeat = this.heartbeatAgeMs(at);
    if (heartbeat > this.staleAfterMs) notReady.push('WORKER_HEARTBEAT_STALE');

    if (this.itemFault) degraded.push(this.itemFault.code);
    if (this.queue?.requiresAttention > 0) degraded.push('SCAN_JOBS_REQUIRE_ATTENTION');

    const ready = notReady.length === 0;
    const status = !ready ? 'unready' : degraded.length ? 'degraded' : 'healthy';
    return {
      status,
      // Liveness is answered by this method returning at all. Recorded explicitly so a consumer does not
      // have to infer it, and kept independent of readiness so a scanner outage never triggers a restart.
      live: true,
      ready,
      reasons: [...new Set(ready ? degraded : notReady)],
      role: 'worker',
      uptimeMs: at - this.startedAt,
      heartbeatAgeMs: heartbeat,
      tenancy: this.tenancy,
      counters: {
        completedJobs: this.completedJobs,
        consecutivePollFailures: this.consecutivePollFailures,
        consecutiveJobFailures: this.consecutiveJobFailures,
        lastSuccessfulPollAt: this.lastSuccessfulPollAt,
        lastEmptyPollAt: this.lastEmptyPollAt,
        lastFailedPollAt: this.lastFailedPollAt,
        lastCompletedJobAt: this.lastCompletedJobAt,
        lastJobFailureAt: this.lastJobFailureAt,
        lastScannerProbeAt: this.lastScannerProbeAt,
        lastScannerProbeOk: this.lastScannerProbeOk,
      },
      faults: {
        infrastructure: this.infrastructureFault,
        item: this.itemFault,
      },
      queue: this.queue,
    };
  }
}
