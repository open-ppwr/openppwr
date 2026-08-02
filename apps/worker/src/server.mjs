import { createPool } from '@openppwr/database';
import { createServer } from 'node:http';
import { WorkerHealth } from './health.mjs';
import { ClamAvScanner, assertSingleTenantDeployment, authenticateWorker, cleanupRetainedEvidence, loadWorkerConfig, processNextScanJob, runPollingLoop, scanQueueSnapshot } from './index.mjs';

const config = loadWorkerConfig();
const pool = createPool(config.databaseUrl);

// The worker is a separate service and must be a separate database identity. It shared `openppwr_app` with
// the API, which meant the retention state machine — moved behind functions precisely so no role could write
// the fence directly — was callable from the request-serving process (migration 022).
//
// A connection string is a claim about which principal it connects as; `current_user` is the fact. Checked
// at startup and fatal, because the failure it prevents is silent: everything works and the separation is
// gone.
async function assertWorkerPrincipal() {
  const client = await pool.connect();
  try {
    const [identity] = (await client.query(
      `SELECT current_user AS role,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`)).rows;
    if (identity.role !== 'openppwr_worker') {
      throw new Error(`OPENPPWR_DATABASE_URL connects as ${identity.role}, not openppwr_worker; the worker and the API are sharing an identity.`);
    }
    if (identity.superuser) throw new Error('The worker connects as a superuser, which bypasses every boundary in the schema.');
  } finally { client.release(); }
}

await assertWorkerPrincipal();

const controller = new AbortController();
let healthServer;

// Replaces `let workerHealthy = false` and `workerHealthy = !result?.errorCode`.
//
// That boolean was restored to true by an *empty* poll, because `null?.errorCode` is `undefined`: a worker
// whose scanner was dead reported healthy the moment the queue drained. An outage read exactly like an
// idle queue. Liveness, readiness and operational health are now three answers, and an
// infrastructure fault is cleared only by evidence — a completed scan or a successful scanner probe.
const health = new WorkerHealth({ staleAfterMs: config.healthStaleAfterMs });

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());

const emit = (level, event, fields = {}) => console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, event, ...fields }));

try {
  await authenticateWorker(pool, config.workerToken);
  health.recordAuthentication({ ok: true });
  // Before serving anything: refuse a topology this worker cannot honestly cover.
  let tenancy = await assertSingleTenantDeployment(pool, config);
  health.recordTenancy(tenancy);
  let lastTenancyCheck = Date.now();
  let lastQueueCheck = 0;
  let lastRetentionSweep = Date.now();
  emit('info', 'worker.tenancy.checked', { tenants: tenancy.tenants, singleTenantEnforced: tenancy.enforced });
  const scanner = new ClamAvScanner(config.clamav);
  healthServer = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    const snapshot = health.snapshot();
    // Three endpoints, because the three questions have different remedies. Liveness answers "restart
    // me"; readiness answers "take me out of service"; /health is the operational summary and keeps its
    // existing path so nothing watching it has to change.
    //
    // A `degraded` worker returns 200: it is working, and one poisoned upload must not take a healthy
    // worker out of service and stop every other item from being scanned.
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', live: true, role: 'worker', uptimeMs: snapshot.uptimeMs }));
      return;
    }
    if (request.url === '/health/ready') {
      response.writeHead(snapshot.ready ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: snapshot.ready ? 'ready' : 'unready', ready: snapshot.ready, reasons: snapshot.reasons, role: 'worker' }));
      return;
    }
    if (request.url === '/health') {
      response.writeHead(snapshot.ready ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen, rejectListen) => {
    healthServer.once('error', rejectListen);
    healthServer.listen(config.healthPort, config.healthHost, resolveListen);
  });
  await runPollingLoop({
    signal: controller.signal,
    pollIntervalMs: config.pollIntervalMs,
    processJob: async () => {
      // Re-check the tenancy invariant before claiming, not only at startup.
      //
      // The startup check alone was a real gap: a tenant created
      // after this process began was never noticed, so the unsupported topology could appear silently on a
      // running deployment — precisely the state the guard exists to prevent. Enforcing it once and calling
      // it an invariant was the mistake.
      //
      // Rechecked on an interval rather than on every poll, because the poll interval is a second and this
      // is a counting query; and it stops work rather than merely reporting, because a worker that keeps
      // claiming jobs while starving other tenants is the harm.
      const now = Date.now();
      if (now - lastTenancyCheck >= config.tenancyRecheckMs) {
        // The timestamp advances only *after* the check succeeds, and a failure latches.
        //
        // It advanced first, so a recheck that threw — which is exactly what an unsupported topology causes —
        // moved the deadline forward, the next poll skipped the check entirely, `onError` cleared the poll
        // failure on the following success, and the worker went on claiming jobs against stale state
        // The guard reported an invariant it had stopped enforcing, which is the same shape as
        // the startup-only check it replaced.
        const rechecked = await assertSingleTenantDeployment(pool, config);
        lastTenancyCheck = Date.now();
        if (rechecked.tenants !== tenancy.tenants) {
          emit('warn', 'worker.tenancy.changed', { from: tenancy.tenants, to: rechecked.tenants });
          tenancy = rechecked;
        }
        health.recordTenancy(rechecked);
      }
      const identity = await authenticateWorker(pool, config.workerToken);
      health.recordAuthentication({ ok: true });
      const result = await processNextScanJob({
        pool,
        identity,
        storageRoot: config.storageRoot,
        scanner,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        maxInfrastructureAttempts: config.maxInfrastructureAttempts,
        maxRetryDelayMs: config.maxRetryDelayMs,
        jobLeaseMs: config.jobLeaseMs,
      });
      // The poll succeeded — that is all an empty result proves.
      health.recordPollSuccess({ empty: !result });
      if (result) {
        health.recordJobOutcome(result);
        if (result.requiresAttention) {
          emit('warn', 'worker.scan.requires_attention', {
            jobId: result.jobId, terminalReason: result.terminalReason, code: result.errorCode, correlationId: result.correlationId,
          });
        }
      } else if (health.snapshot().faults.infrastructure) {
        // Empty queue with an outstanding infrastructure fault: probe the scanner, because no job will
        // arrive to prove recovery and staying unready for ever is not an answer either.
        const ok = await scanner.ping().catch(() => false);
        health.recordScannerProbe({ ok });
        emit(ok ? 'info' : 'warn', 'worker.scanner.probed', { ok });
      }
      // Queue depth on an interval, not per poll: it is an aggregate over the table and the poll interval
      // is a second.
      if (now - lastQueueCheck >= config.tenancyRecheckMs) {
        lastQueueCheck = now;
        health.recordQueue(await scanQueueSnapshot(pool, identity));
      }
      // Retention deletion, on its own interval.
      //
      // `cleanupRetainedEvidence` was written in Stage 2, exported, and called by exactly one integration
      // test — so no deployment has ever deleted an unaccepted upload, while the retention policy was
      // documented as if it had. A control that exists in the source tree and runs nowhere is not a
      // control; it is a claim.
      //
      // Deliberately after the scan work rather than before it: scanning is what the worker exists for, and
      // housekeeping must not delay a verdict. One item per sweep, so a large backlog is worked through
      // steadily instead of blocking the loop.
      if (now - lastRetentionSweep >= config.retentionSweepMs) {
        lastRetentionSweep = now;
        try {
          const deleted = await cleanupRetainedEvidence({
            pool,
            identity,
            storageRoot: config.storageRoot,
            cutoff: new Date(now - config.retentionDays * 86_400_000),
          });
          if (deleted) emit('info', 'worker.retention.deleted', { evidenceId: deleted.evidenceId, recovered: deleted.recovered === true });
        } catch (error) {
          // A failed sweep is reported and does not stop scanning: the item stays `retained` and the next
          // sweep tries again. It is recorded as an item fault rather than an infrastructure one, because the
          // scanner and the database are demonstrably reachable — this poll just claimed a job through them.
          health.recordJobOutcome({ errorCode: error.code || 'EVIDENCE_RETENTION_FAILED' });
          emit('error', 'worker.retention.failed', { code: error.code || 'EVIDENCE_RETENTION_FAILED' });
        }
      }
      return result;
    },
    onError: (error) => {
      const code = error.code || 'WORKER_POLL_FAILED';
      // An unsupported topology is latched, not merely reported. Without this the next successful poll
      // cleared the failure and work resumed while the database still held more than one tenant — the guard
      // stops work, so a transient-looking recovery must not restart it.
      if (code === 'WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED') {
        health.recordTenancy({ tenants: null, enforced: false });
        tenancy = { tenants: null, enforced: false };
      }
      // An authentication or tenancy failure is recorded as what it is, so readiness names the actual
      // cause instead of a generic poll failure.
      if (code === 'WORKER_AUTHENTICATION_FAILED' || code === 'WORKER_AUTHORIZATION_REQUIRED') health.recordAuthentication({ ok: false, code });
      health.recordPollFailure(code);
      emit('error', 'worker.poll.failed', { code });
    },
  });
} finally {
  if (healthServer?.listening) await new Promise((resolveClose) => healthServer.close(resolveClose));
  await pool.end();
}
