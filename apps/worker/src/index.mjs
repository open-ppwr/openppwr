import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { appendAudit, authenticateToken, withTenantTransaction } from '@openppwr/database';
import { assertStrongSecrets } from '@openppwr/security';
import { classifyFailure } from './health.mjs';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_SCANNER_RESPONSE_BYTES = 4096;
// The complete, exact reply to `zPING`. Compared as bytes including the terminator, so nothing before or
// after it can be mistaken for a healthy scanner.
const PONG = Buffer.from('PONG\0', 'ascii');

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// A stub that returns a *verdict*. It does not detect malware, and the name says so.
//
// It was called DeterministicTestScanner, which read as "a scanner, made deterministic for tests" and
// invited exactly the wrong conclusion. It matches the EICAR substring, so it is strictly more permissive
// than the engine it stands in for: the deployment's ClamAV correctly reported an EICAR string wrapped in
// a PDF as clean, while this stub called the same bytes infected. A local quarantine test had therefore
// been passing on a payload production ignores.
//
// What this class is for: proving the application's handling of a verdict — quarantine placement, refusal
// to accept, refusal to serve, fail-closed on scanner unavailability. Detection belongs to ClamAV and is
// proven against the real engine on the deployment, not against this class.
export class VerdictStubScanner {
  constructor({ runtime = process.env.NODE_ENV } = {}) {
    if (runtime !== 'test') throw new Error('Deterministic scanner is test-only.');
  }

  async scan(content) {
    if (content.includes(Buffer.from('EICAR'))) return { status: 'infected', engine: 'deterministic-test' };
    if (content.includes(Buffer.from('SCAN_TIMEOUT_TEST'))) throw codedError('MALWARE_SCAN_TIMEOUT', 'Scanner timed out.');
    return { status: 'clean', engine: 'deterministic-test' };
  }

  async ping() {
    return true;
  }
}

function integerSetting(name, value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  return parsed;
}

export class ClamAvScanner {
  constructor({ host, port = 3310, timeoutMs = 10_000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!host || typeof host !== 'string') throw new TypeError('OPENPPWR_CLAMAV_HOST is required.');
    this.host = host;
    this.port = integerSetting('OPENPPWR_CLAMAV_PORT', port, 3310, { maximum: 65_535 });
    this.timeoutMs = integerSetting('OPENPPWR_CLAMAV_TIMEOUT_MS', timeoutMs, 10_000, { minimum: 10, maximum: 30_000 });
    this.maxBytes = integerSetting('OPENPPWR_SCANNER_MAX_BYTES', maxBytes, DEFAULT_MAX_BYTES, { maximum: DEFAULT_MAX_BYTES });
  }

  async scan(content) {
    if (!Buffer.isBuffer(content)) throw new TypeError('Scanner input must be a Buffer.');
    if (content.length > this.maxBytes) throw codedError('MALWARE_SCAN_SIZE_EXCEEDED', 'Evidence exceeds scanner size limit.');

    return new Promise((resolveScan, rejectScan) => {
      let settled = false;
      let response = Buffer.alloc(0);
      const socket = createConnection({ host: this.host, port: this.port });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) rejectScan(error);
        else resolveScan(result);
      };
      const timer = setTimeout(
        () => finish(codedError('MALWARE_SCAN_TIMEOUT', 'Malware scanner timed out.')),
        this.timeoutMs,
      );
      timer.unref?.();
      socket.once('connect', () => {
        socket.write(Buffer.from('zINSTREAM\0', 'ascii'));
        for (let offset = 0; offset < content.length; offset += 64 * 1024) {
          const chunk = content.subarray(offset, Math.min(offset + 64 * 1024, content.length));
          const size = Buffer.allocUnsafe(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      // Accumulate only. The verdict is read when the connection completes, never when a chunk lands.
      //
      // This judged the bytes in hand and resolved as soon as the accumulated buffer happened to end with the
      // terminator. A scanner that wrote a complete terminated clean verdict, waited, and then wrote anything else was already
      // accepted — including the case that matters most, where the second write is an infected
      // verdict. clamd closes the connection after answering a `z`-prefixed command, so waiting for the close
      // is what the protocol already does; the timeout covers a peer that does not.
      socket.on('data', (chunk) => {
        response = Buffer.concat([response, chunk]);
        // Still bounded, so a flood fails fast instead of buffering until the timeout.
        if (response.length > MAX_SCANNER_RESPONSE_BYTES) {
          finish(codedError('MALWARE_SCANNER_MALFORMED_RESPONSE', 'Malware scanner returned an invalid response.'));
        }
      });
      const evaluate = () => {
        if (settled) return;
        const terminator = response.indexOf(0);
        if (terminator === -1 || terminator !== response.length - 1) {
          finish(codedError('MALWARE_SCANNER_MALFORMED_RESPONSE', 'Malware scanner returned an incomplete response.'));
          return;
        }
        const value = response.subarray(0, terminator).toString('utf8');
        if (value === 'stream: OK') finish(null, { status: 'clean', engine: 'clamav' });
        else if (/^stream: .+ FOUND$/u.test(value)) finish(null, { status: 'infected', engine: 'clamav' });
        else finish(codedError('MALWARE_SCANNER_MALFORMED_RESPONSE', 'Malware scanner returned an invalid response.'));
      };
      socket.once('end', evaluate);
      socket.once('close', evaluate);
      socket.once('error', () => finish(codedError('MALWARE_SCANNER_UNAVAILABLE', 'Malware scanner is unavailable.')));
    });
  }

  // An active liveness probe for the scanner, because an empty queue cannot answer the question.
  //
  // Without it, a worker that failed a scan while the scanner was down would stay unready for ever once
  // the queue emptied: readiness is only restored by evidence, and with no job there is no scan to
  // succeed. `zPING` costs one round trip and gives that evidence directly.
  //
  // Resolves false rather than throwing: a probe that fails is an answer, not an exception.
  //
  // The parsing is exact, and the first version of it was not. It accepted anything whose first
  // NUL-terminated segment was `PONG`, so `PONG\0` followed by arbitrary bytes reported a healthy scanner
  // — a loopback socket that answers `PONG` and then keeps writing is enough to demonstrate it. That is
  // the same mistake `scan()` deliberately avoids by requiring the terminator to be the final byte, and a probe whose only
  // job is to restore readiness must be at least as strict as the path it re-enables: this one clears an
  // infrastructure fault, so a lenient parse turns a dead scanner into a healthy one.
  async ping() {
    return new Promise((resolvePing) => {
      let settled = false;
      let response = Buffer.alloc(0);
      const socket = createConnection({ host: this.host, port: this.port });
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolvePing(ok);
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      timer.unref?.();
      socket.once('connect', () => socket.write(Buffer.from('zPING\0', 'ascii')));
      socket.on('data', (chunk) => {
        response = Buffer.concat([response, chunk]);
        // Bounded so a flood fails immediately, but no verdict is reached here: the reply is judged when the
        // connection completes. Resolving as soon as five bytes matched accepted a complete terminated reply followed later by
        // anything at all, which is the same defect the byte-exact comparison was meant to close.
        if (response.length > PONG.length) finish(false);
      });
      const evaluate = () => finish(response.equals(PONG));
      socket.once('end', evaluate);
      socket.once('close', evaluate);
      socket.once('error', () => finish(false));
    });
  }
}

export function resolveStoragePath(rootInput, key) {
  const root = resolve(rootInput);
  const target = resolve(root, key);
  if (!target.startsWith(`${root}${sep}`)) throw codedError('STORAGE_PATH_INVALID', 'Storage path is invalid.');
  return target;
}

export function resolveTenantStoragePath(rootInput, tenantId, storageKey) {
  const expectedPrefix = `${tenantId}/quarantine/`;
  if (!storageKey.startsWith(expectedPrefix) || storageKey.slice(expectedPrefix.length).includes('/')) {
    throw codedError('STORAGE_PATH_INVALID', 'Storage path is invalid.');
  }
  return {
    tenantRoot: resolve(rootInput, tenantId, 'quarantine'),
    target: resolveStoragePath(rootInput, storageKey),
  };
}

async function readConfinedEvidence(storageRoot, tenantId, storageKey, expectedSize, expectedSha256, maxBytes) {
  const confined = resolveTenantStoragePath(storageRoot, tenantId, storageKey);
  const size = Number(expectedSize);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw codedError('EVIDENCE_INTEGRITY_MISMATCH', 'Evidence metadata is invalid.');
  }
  // Three canonical paths, not two. The check used to resolve the tenant quarantine directory and the file
  // inside it, and assert the second was beneath the first — which holds even when the tenant directory has
  // itself been replaced by a symlink pointing outside the storage root. `O_NOFOLLOW` below guards the final
  // component only; it cannot object to a symlinked parent.
  //
  // So the configured root is canonicalised too, and the tenant directory has to be beneath *it*. Requires
  // an attacker who can already write to the evidence volume, which is why this is a hardening rather than a
  // hole — but the containment claim in the security model is unqualified, so it should hold unqualified.
  let canonicalStorageRoot;
  let canonicalRoot;
  let canonicalTarget;
  try {
    [canonicalStorageRoot, canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(resolve(storageRoot)),
      realpath(confined.tenantRoot),
      realpath(confined.target),
    ]);
  } catch {
    throw codedError('EVIDENCE_STORAGE_UNAVAILABLE', 'Evidence storage is unavailable.');
  }
  if (canonicalRoot !== canonicalStorageRoot && !canonicalRoot.startsWith(`${canonicalStorageRoot}${sep}`)) {
    throw codedError('STORAGE_PATH_INVALID', 'Storage path is invalid.');
  }
  if (!canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) throw codedError('STORAGE_PATH_INVALID', 'Storage path is invalid.');
  let handle;
  try {
    handle = await open(canonicalTarget, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw codedError('STORAGE_PATH_INVALID', 'Storage path is invalid.');
    if (metadata.size !== size) throw codedError('EVIDENCE_INTEGRITY_MISMATCH', 'Evidence size does not match persisted metadata.');
    const buffer = Buffer.allocUnsafe(size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== size) throw codedError('EVIDENCE_INTEGRITY_MISMATCH', 'Evidence size changed during scanning.');
    const content = buffer.subarray(0, size);
    if (createHash('sha256').update(content).digest('hex') !== expectedSha256) {
      throw codedError('EVIDENCE_INTEGRITY_MISMATCH', 'Evidence checksum does not match persisted metadata.');
    }
    return content;
  } catch (error) {
    if (error.code?.startsWith('MALWARE_') || error.code === 'STORAGE_PATH_INVALID' || error.code === 'EVIDENCE_INTEGRITY_MISMATCH') throw error;
    throw codedError('EVIDENCE_STORAGE_UNAVAILABLE', 'Evidence storage is unavailable.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function scanFailureCode(error) {
  const known = new Set([
    'EVIDENCE_STORAGE_UNAVAILABLE',
    'EVIDENCE_INTEGRITY_MISMATCH',
    'MALWARE_SCAN_SIZE_EXCEEDED',
    'MALWARE_SCAN_TIMEOUT',
    'MALWARE_SCANNER_MALFORMED_RESPONSE',
    'MALWARE_SCANNER_UNAVAILABLE',
    'STORAGE_PATH_INVALID',
  ]);
  return known.has(error?.code) ? error.code : 'MALWARE_SCANNER_UNAVAILABLE';
}

// Bounded exponential backoff with jitter, for infrastructure failures only.
//
// A fixed delay treats the tenth attempt against a dead scanner exactly like the first, which is how a
// short outage turned into a tight retry loop against a service that was not answering. The doubling is
// bounded on both ends: never below the base delay, never above `maxDelayMs`, so waiting stays a delay
// rather than becoming an outage of its own.
//
// The jitter is ±20% and exists because every worker and every job would otherwise retry in lockstep,
// arriving at the recovering scanner as one burst. `random` is injectable so the bound can be tested at
// both extremes rather than sampled and hoped over.
export function retryBackoffMs(attempt, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  const uncapped = baseDelayMs * 2 ** exponent;
  const capped = Math.min(uncapped, maxDelayMs);
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(baseDelayMs, Math.round(Math.min(capped + jitter, maxDelayMs)));
}

export async function processNextScanJob({
  pool,
  identity,
  storageRoot,
  scanner,
  now = new Date(),
  maxAttempts = 3,
  retryDelayMs = 60_000,
  maxInfrastructureAttempts = 12,
  maxRetryDelayMs = 900_000,
  jobLeaseMs = 300_000,
  random = Math.random,
  correlationId = randomUUID(),
}) {
  if (identity?.role !== 'worker' || !identity.tenantId || !identity.actorId) throw codedError('WORKER_AUTHORIZATION_REQUIRED', 'Worker authorization required.');
  if (!scanner?.scan) throw new TypeError('Scanner adapter is required.');
  const attemptsLimit = integerSetting('OPENPPWR_WORKER_MAX_ATTEMPTS', maxAttempts, 3, { minimum: 3, maximum: 3 });
  const retryDelay = integerSetting('OPENPPWR_WORKER_RETRY_DELAY_MS', retryDelayMs, 60_000, { maximum: 86_400_000 });
  const infrastructureLimit = integerSetting('OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS', maxInfrastructureAttempts, 12, { minimum: 1, maximum: 100 });
  const maxDelay = integerSetting('OPENPPWR_WORKER_MAX_RETRY_DELAY_MS', maxRetryDelayMs, 900_000, { minimum: retryDelay, maximum: 86_400_000 });
  const lease = integerSetting('OPENPPWR_WORKER_JOB_LEASE_MS', jobLeaseMs, 300_000, { minimum: 10_000, maximum: 3_600_000 });
  return withTenantTransaction(pool, identity, async (client) => {
    // Two budgets in the predicate, and a lease so a job left `running` by a crashed worker is reclaimed
    // rather than stranded for ever. Ordered by `available_at` first, so a backed-off job stops sitting at
    // the head of the queue ahead of work that is ready now, which would starve it.
    const leaseCutoff = new Date(now.valueOf() - lease).toISOString();
    const selected = await client.query(
      `SELECT j.*,e.storage_key,e.size_bytes,e.sha256 FROM scan_jobs j JOIN evidence_files e ON e.tenant_id=j.tenant_id AND e.id=j.evidence_id
       WHERE ((j.status IN ('pending','failed') AND j.available_at <= $1) OR (j.status='running' AND j.updated_at < $2))
         AND j.attempts < $3 AND j.infrastructure_attempts < $4
       ORDER BY j.available_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      [now.toISOString(), leaseCutoff, attemptsLimit, infrastructureLimit],
    );
    if (!selected.rowCount) return null;
    const job = selected.rows[0];
    // A job reclaimed from an expired lease spends an item attempt. The old code incremented at claim time
    // for every job, which is what made an outage spend the item's budget; but dropping the increment
    // entirely would let a job that crashes the worker be reclaimed for ever. Charging the reclaim — and
    // only the reclaim — bounds the crash loop without charging the outage.
    const reclaimed = job.status === 'running';
    const attempt = Number(job.attempts) + (reclaimed ? 1 : 0);
    await client.query(
      `UPDATE scan_jobs SET status='running',attempts=$1,correlation_id=$2,updated_at=$3 WHERE id=$4`,
      [attempt, correlationId, now.toISOString(), job.id],
    );
    let scanStatus;
    let errorCode = null;
    try {
      const content = await readConfinedEvidence(
        storageRoot,
        identity.tenantId,
        job.storage_key,
        job.size_bytes,
        job.sha256,
        scanner.maxBytes || DEFAULT_MAX_BYTES,
      );
      const result = await scanner.scan(content);
      if (result?.status !== 'clean' && result?.status !== 'infected') throw codedError('MALWARE_SCANNER_MALFORMED_RESPONSE', 'Malware scanner returned an invalid result.');
      scanStatus = result.status;
    } catch (error) {
      errorCode = scanFailureCode(error);
      scanStatus = errorCode === 'MALWARE_SCAN_TIMEOUT' ? 'timeout' : 'error';
    }
    const completed = scanStatus === 'clean' || scanStatus === 'infected';
    const failureClass = completed ? null : classifyFailure(errorCode);
    const infrastructure = failureClass === 'infrastructure';

    // The budgets. `attempts` belongs to the evidence item and is spent on content failures; an
    // infrastructure failure spends `infrastructure_attempts` and leaves the item's budget untouched, so a
    // scanner outage delays the item instead of condemning it.
    const contentAttempts = completed || infrastructure ? attempt : attempt + 1;
    const infrastructureAttempts = Number(job.infrastructure_attempts) + (infrastructure ? 1 : 0);
    // Exhaustion is judged against *both* budgets, whichever failure this was.
    //
    // It was judged against the budget the current failure spends, and that left a hole at the boundary: a
    // job reclaimed from an expired lease charges an item attempt, and if it then failed on infrastructure
    // the row was written back as `failed` with `attempts = 3`. The claim predicate requires `attempts <
    // limit`, so nothing would ever claim it again, and requeue only accepts `dead`, so no operator could
    // recover it either. Invisible and unrecoverable, with no terminal reason recorded.
    //
    // A row that cannot be claimed is terminal whether or not the last failure was the one that exhausted it,
    // so the status must say so and an operator must be able to see and requeue it.
    const contentExhausted = contentAttempts >= attemptsLimit;
    const infrastructureExhausted = infrastructureAttempts >= infrastructureLimit;
    const exhausted = contentExhausted || infrastructureExhausted;
    const jobStatus = completed ? 'completed' : exhausted ? 'dead' : 'failed';
    // The reason names the budget that ran out. When both did, the item's own budget is the more useful thing
    // for an operator to see, because it is the one that says the file itself has been tried and tried.
    const terminalReason = jobStatus !== 'dead'
      ? null
      : contentExhausted ? 'content_attempts_exhausted' : 'infrastructure_attempts_exhausted';
    const completedAt = new Date();
    const delay = completed
      ? retryDelay
      : infrastructure
        ? retryBackoffMs(infrastructureAttempts, { baseDelayMs: retryDelay, maxDelayMs: maxDelay, random })
        : retryDelay;

    await client.query(`UPDATE evidence_files SET scan_status=$1 WHERE id=$2`, [scanStatus, job.evidence_id]);
    await client.query(
      `UPDATE scan_jobs SET status=$1,attempts=$2,infrastructure_attempts=$3,last_error_code=$4,last_failure_class=$5,
              available_at=$6,updated_at=$7,terminal_reason=$8,terminal_at=$9 WHERE id=$10`,
      [
        jobStatus, contentAttempts, infrastructureAttempts, errorCode, failureClass,
        new Date(completedAt.valueOf() + delay).toISOString(), completedAt.toISOString(),
        terminalReason, jobStatus === 'dead' ? completedAt.toISOString() : null, job.id,
      ],
    );
    await appendAudit(client, {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      action: `evidence.scan.${scanStatus}`,
      entityType: 'evidence',
      entityId: job.evidence_id,
      payload: { jobId: job.id, attempt: contentAttempts, errorCode, failureClass, infrastructureAttempts, correlationId, reclaimed },
      occurredAt: completedAt.toISOString(),
    });
    // A separate event for the terminal state, because "this job has stopped and needs a person" is a
    // different fact from "this attempt failed", and an operator searching for the first should not have
    // to reconstruct it from a count of the second. No silent drop.
    if (jobStatus === 'dead') {
      await appendAudit(client, {
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        action: 'evidence.scan.requires_attention',
        entityType: 'evidence',
        entityId: job.evidence_id,
        payload: { jobId: job.id, terminalReason, errorCode, failureClass, attempts: contentAttempts, infrastructureAttempts, correlationId },
        occurredAt: completedAt.toISOString(),
      });
    }
    return {
      jobId: job.id, evidenceId: job.evidence_id, scanStatus, errorCode, jobStatus, attempt: contentAttempts,
      failureClass, infrastructureAttempts, terminalReason, requiresAttention: jobStatus === 'dead',
      reclaimed, correlationId, availableInMs: completed ? null : delay,
    };
  });
}

// What the queue looks like right now, for the health endpoint. Reported as an observation, never as a
// release invariant: the counts depend on what a deployment has been asked to do.
export async function scanQueueSnapshot(pool, identity, { now = new Date() } = {}) {
  return withTenantTransaction(pool, identity, async (client) => {
    const result = await client.query(
      `SELECT count(*) FILTER (WHERE status IN ('pending','failed'))::int AS pending,
              count(*) FILTER (WHERE status='running')::int AS running,
              count(*) FILTER (WHERE status='dead')::int AS requires_attention,
              coalesce(max(extract(epoch from ($1::timestamptz - created_at)) * 1000)
                       FILTER (WHERE status IN ('pending','failed')), 0)::bigint AS oldest_pending_age_ms
       FROM scan_jobs`,
      [now.toISOString()],
    );
    const row = result.rows[0];
    return {
      pending: row.pending,
      running: row.running,
      requiresAttention: row.requires_attention,
      oldestPendingAgeMs: Number(row.oldest_pending_age_ms),
    };
  });
}

export async function authenticateWorker(pool, bearerToken) {
  if (!bearerToken || typeof bearerToken !== 'string') throw codedError('WORKER_AUTHENTICATION_FAILED', 'Worker authentication failed.');
  const identity = await authenticateToken(pool, bearerToken);
  if (!identity) throw codedError('WORKER_AUTHENTICATION_FAILED', 'Worker authentication failed.');
  if (identity.role !== 'worker') throw codedError('WORKER_AUTHORIZATION_REQUIRED', 'Worker authorization required.');
  return identity;
}

export function loadWorkerConfig(environment = process.env) {
  for (const name of ['OPENPPWR_DATABASE_URL', 'OPENPPWR_WORKER_TOKEN', 'OPENPPWR_EVIDENCE_STORAGE_ROOT', 'OPENPPWR_CLAMAV_HOST']) {
    if (!environment[name]) throw new TypeError(`${name} is required.`);
  }
  // Present is not the same as set. `openppwr.env.example` ships `OPENPPWR_WORKER_TOKEN=REPLACE_AFTER_BOOTSTRAP`
  // and Compose checks only that the variable is non-empty, so a file copied unchanged starts a worker whose
  // credential is a string published in this repository.
  assertStrongSecrets({ OPENPPWR_WORKER_TOKEN: environment.OPENPPWR_WORKER_TOKEN });
  return {
    databaseUrl: environment.OPENPPWR_DATABASE_URL,
    workerToken: environment.OPENPPWR_WORKER_TOKEN,
    storageRoot: environment.OPENPPWR_EVIDENCE_STORAGE_ROOT,
    clamav: {
      host: environment.OPENPPWR_CLAMAV_HOST,
      port: integerSetting('OPENPPWR_CLAMAV_PORT', environment.OPENPPWR_CLAMAV_PORT, 3310, { maximum: 65_535 }),
      timeoutMs: integerSetting('OPENPPWR_CLAMAV_TIMEOUT_MS', environment.OPENPPWR_CLAMAV_TIMEOUT_MS, 10_000, { minimum: 10, maximum: 30_000 }),
      maxBytes: integerSetting('OPENPPWR_SCANNER_MAX_BYTES', environment.OPENPPWR_SCANNER_MAX_BYTES, DEFAULT_MAX_BYTES, { maximum: DEFAULT_MAX_BYTES }),
    },
    pollIntervalMs: integerSetting('OPENPPWR_WORKER_POLL_INTERVAL_MS', environment.OPENPPWR_WORKER_POLL_INTERVAL_MS, 1000, { minimum: 10, maximum: 60_000 }),
    maxAttempts: integerSetting('OPENPPWR_WORKER_MAX_ATTEMPTS', environment.OPENPPWR_WORKER_MAX_ATTEMPTS, 3, { minimum: 3, maximum: 3 }),
    retryDelayMs: integerSetting('OPENPPWR_WORKER_RETRY_DELAY_MS', environment.OPENPPWR_WORKER_RETRY_DELAY_MS, 60_000, { maximum: 86_400_000 }),
    // The infrastructure budget, separate from the item's three attempts. Larger, because a
    // scanner outage is not the evidence item's fault; bounded, because an unbounded retry is a hot loop
    // that hides a permanent fault rather than a kindness.
    maxInfrastructureAttempts: integerSetting('OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS', environment.OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS, 12, { minimum: 1, maximum: 100 }),
    // The ceiling on exponential backoff. Doubling from 60 s reaches this in about four attempts, so the
    // remaining attempts are spaced rather than accelerating away.
    maxRetryDelayMs: integerSetting('OPENPPWR_WORKER_MAX_RETRY_DELAY_MS', environment.OPENPPWR_WORKER_MAX_RETRY_DELAY_MS, 900_000, { minimum: 1000, maximum: 86_400_000 }),
    // How long a claimed job may stay `running` before another worker may reclaim it. Without a lease, a
    // worker killed mid-scan left the job claimed for ever and the evidence permanently pending.
    jobLeaseMs: integerSetting('OPENPPWR_WORKER_JOB_LEASE_MS', environment.OPENPPWR_WORKER_JOB_LEASE_MS, 300_000, { minimum: 10_000, maximum: 3_600_000 }),
    // How stale the last poll may be before health reports the loop as stopped. A loop that stops
    // iterating without throwing leaves a boolean flag reading `true` for ever.
    healthStaleAfterMs: integerSetting('OPENPPWR_WORKER_HEALTH_STALE_MS', environment.OPENPPWR_WORKER_HEALTH_STALE_MS, 300_000, { minimum: 1000, maximum: 3_600_000 }),
    // Retention deletion of evidence that was never accepted — infected, errored or timed-out uploads.
    //
    // `cleanupRetainedEvidence` existed since Stage 2 and was called by nothing but a test, so no deployment
    // ever deleted anything. Both settings are bounded: a zero retention would delete an upload the
    // moment a scan failed, before anyone could look at why, and an unbounded one is a retention policy in
    // name only.
    retentionDays: integerSetting('OPENPPWR_EVIDENCE_RETENTION_DAYS', environment.OPENPPWR_EVIDENCE_RETENTION_DAYS, 30, { minimum: 1, maximum: 3650 }),
    retentionSweepMs: integerSetting('OPENPPWR_WORKER_RETENTION_SWEEP_MS', environment.OPENPPWR_WORKER_RETENTION_SWEEP_MS, 3_600_000, { minimum: 60_000, maximum: 86_400_000 }),
    healthHost: environment.OPENPPWR_WORKER_HEALTH_HOST || environment.OPENPPWR_HOST || '0.0.0.0',
    healthPort: integerSetting('OPENPPWR_WORKER_HEALTH_PORT', environment.OPENPPWR_WORKER_HEALTH_PORT || environment.OPENPPWR_PORT, 3000, { maximum: 65_535 }),
    // Community Public Beta supports one tenant per deployment, by scope decision rather than by accident.
    // Opting out is deliberately explicit and deliberately ugly to write down, because a deployment
    // that sets it is running an unsupported topology and that should be visible in a config review.
    allowMultiTenantDatabase: environment.OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE === 'true',
    // How often the tenancy invariant is rechecked while running. A startup-only check missed a tenant
    // created afterwards; a per-poll check would run a counting query every second for no gain.
    tenancyRecheckMs: integerSetting('OPENPPWR_WORKER_TENANCY_RECHECK_MS', environment.OPENPPWR_WORKER_TENANCY_RECHECK_MS, 60_000, { minimum: 1000, maximum: 3_600_000 }),
  };
}

// The deployment serves one tenant, so a database holding several is a configuration this worker cannot
// honestly service: it would silently process whichever tenant its own token belongs to and leave every
// other tenant's evidence stuck in `pending` for ever, which is exactly how the single-tenant scope of
// this worker was discovered in the first place.
//
// Failing closed at startup turns a silent, permanent data-processing gap into a loud refusal that an
// operator sees immediately. The verification suites that create extra synthetic tenants set the opt-out.
export async function assertSingleTenantDeployment(pool, { allowMultiTenantDatabase = false } = {}) {
  // openppwr_tenant_count() rather than a direct count: migration 008 gives `tenants` a self-only RLS
  // policy, so a direct count from this role would return at most one and the guard could never fire.
  const result = await pool.query('SELECT openppwr_tenant_count() AS total');
  const total = result.rows[0].total;
  if (total <= 1) return { tenants: total, enforced: true };
  // Strict `=== true`, not merely truthy. A caller passing a non-empty string such as 'yes' or '1' would
  // otherwise disable a safety check by accident, and a safety check that anything truthy can switch off
  // is not a safety check. `loadWorkerConfig` already narrows the environment variable to the exact
  // string; this repeats the narrowing at the point of use so a direct caller cannot bypass it.
  if (allowMultiTenantDatabase === true) return { tenants: total, enforced: false };
  throw Object.assign(
    new Error(
      `This deployment holds ${total} tenants. OpenPPWR Community supports one tenant per deployment, and a `
      + 'single worker can only process one of them, so the others would never be scanned. Run one deployment '
      + 'per tenant, or set OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE=true if this is a test environment.',
    ),
    { code: 'WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED' },
  );
}

function waitForPoll(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runPollingLoop({ processJob, signal, pollIntervalMs, onError = () => {} }) {
  if (typeof processJob !== 'function') throw new TypeError('Worker job processor is required.');
  while (!signal?.aborted) {
    let result = null;
    try {
      result = await processJob();
    } catch (error) {
      onError(error);
    }
    if (!result && !signal?.aborted) await waitForPoll(pollIntervalMs, signal);
  }
}

// Retention deletion of evidence that was never accepted: infected, errored or timed-out uploads past their
// cutoff. Two things were wrong with it until 2026-07-30.
//
// **The ordering.** The row was committed as `deleted` and *then* the bytes were removed. If the removal
// failed, the catch renamed the tombstone back — restoring a readable file — and tried to reset the row to
// `retained` with `WHERE retention_status='deleting'`, which no longer matched, because the row already said
// `deleted`. The result was the one state a retention control must never reach: a record asserting the
// evidence is gone, beside the evidence.
//
// The two failure directions are not symmetrical, so the ordering is not arbitrary. "Bytes gone, record
// still says deleting" is an incomplete deletion a retry finishes. "Record says deleted, bytes present" is a
// false privacy claim that nothing will ever notice. So the bytes go first and the record follows, and a
// stranded `deleting` row whose file is already absent is completed on the next pass rather than left.
// Tombstones have a reserved root and one directory per evidence row. Deriving a tombstone by appending a
// suffix to an unrestricted storage key made another row's valid original indistinguishable from this
// row's tombstone. Migration 027 reserves this root in the database.
export function tombstonePath(storageRoot, evidenceId, operationId) {
  if (!evidenceId || !operationId) throw codedError('RETENTION_FENCE_INVALID', 'Retention tombstones require evidence and operation identifiers.');
  return resolveStoragePath(storageRoot, `.openppwr-retention-tombstones/${evidenceId}/${operationId}`);
}

// Compare-and-set on the exact claim: a worker that has already lost its lease cannot renew itself back
// into ownership, which is what makes this safe to call from a retry loop.
async function renewLease(pool, identity, claimed, leaseOwner, leaseMs) {
  return withTenantTransaction(pool, identity, async (client) => {
    const renewed = await client.query(
      'SELECT renew_openppwr_retention_lease($1,$2,$3,$4,$5) AS renewed',
      [identity.tenantId, claimed.id, leaseOwner, claimed.generation, Math.ceil(leaseMs / 1000)],
    );
    return renewed.rows[0].renewed === true;
  }).catch(() => false);
}

// How long a claim is honoured before a recovery pass may take it. Long enough that a slow filesystem
// removal does not lose its own claim, short enough that a crashed worker's row is not stranded for a shift.
export const RETENTION_LEASE_MS = 5 * 60 * 1000;

export async function cleanupRetainedEvidence({
  pool,
  identity,
  storageRoot,
  cutoff,
  now = new Date(),
  leaseOwner = randomUUID(),
  leaseMs = RETENTION_LEASE_MS,
  filesystem = {},
}) {
  if (identity?.role !== 'worker') throw codedError('WORKER_AUTHORIZATION_REQUIRED', 'Worker authorization required.');
  const cutoffDate = new Date(cutoff);
  if (Number.isNaN(cutoffDate.valueOf())) throw new TypeError('Cleanup cutoff is invalid.');
  const fsAccess = filesystem.access ?? access;
  const fsLstat = filesystem.lstat ?? lstat;
  const fsMkdir = filesystem.mkdir ?? mkdir;
  const fsReaddir = filesystem.readdir ?? readdir;
  const fsRealpath = filesystem.realpath ?? realpath;
  const fsRename = filesystem.rename ?? rename;
  const fsRm = filesystem.rm ?? rm;

  // Every absence conclusion below rests on ENOENT from paths *under* storageRoot. If the mount itself has
  // gone away — unmounted, wrong volume attached, a restore that pointed here before the real one landed —
  // every path under it also reports ENOENT, and that is indistinguishable from "this one file was
  // legitimately deleted" by any check that only ever looks at the file. Missing/wrong storage is not proof
  // of deletion; it is exactly the "a mount that went away" case the per-file probes already treat as
  // unknown, one level up.
  //
  // Reachability alone is not enough: an unmounted filesystem commonly presents as an empty, perfectly
  // *accessible* directory, and so does a wrong volume attached in its place — both pass `fsAccess` and
  // then this function would have waved every absence below through as a real deletion. The installer's
  // `bootstrap-acme` writes `.openppwr-storage-initialized` into the evidence volume at the one point in a
  // deployment's life that is unambiguous: bootstrap has just succeeded against whatever volume is mounted
  // right now, so that volume is the real one. Its absence means either this deployment was never
  // bootstrapped through the supported path, or the volume is not the one bootstrap ran against — either
  // way, not a basis for concluding a file's absence is a deletion.
  const assertStorageRootReachable = async () => {
    try {
      await fsAccess(storageRoot);
    } catch (error) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Storage root ${storageRoot} is not reachable: ${error.code}.`);
    }
    try {
      await fsAccess(resolveStoragePath(storageRoot, '.openppwr-storage-initialized'));
    } catch (error) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Storage root ${storageRoot} has no recorded identity (${error.code}) — either never bootstrapped or a different volume than the one bootstrap ran against.`);
    }
  };

  // Lexical confinement comes from resolveStoragePath. Canonical confinement plus lstat closes the case
  // where a directory this code is about to act through is itself a symlink: following it would enumerate,
  // rename through, or remove a different directory's contents as though this row owned them.
  //
  // Used for the tombstone directory (the rename's destination) and, separately, for the parent of the
  // original evidence path (the rename's source). Checking the destination and not the source was the gap:
  // a quarantine parent replaced by a symlink was followed by the rename that starts a deletion and by the
  // one recovery uses to finish it, because nothing anchored that side to a canonical root the way the scan
  // path already anchors the directory it reads evidence out of.
  const verifyConfinedDirectory = async (directory, { allowMissing = false } = {}) => {
    resolveStoragePath(storageRoot, directory);
    let metadata;
    try {
      metadata = await fsLstat(directory);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return false;
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot inspect ${directory}: ${error.code}.`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw codedError('STORAGE_PATH_INVALID', 'Retention directory is not a confined directory.');
    }
    let canonicalRoot;
    let canonicalDirectory;
    try {
      [canonicalRoot, canonicalDirectory] = await Promise.all([
        fsRealpath(resolve(storageRoot)),
        fsRealpath(directory),
      ]);
    } catch (error) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot resolve ${directory}: ${error.code}.`);
    }
    const canonicalExpected = resolve(canonicalRoot, relative(resolve(storageRoot), directory));
    if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)) {
      throw codedError('STORAGE_PATH_INVALID', 'Retention directory leaves the storage root.');
    }
    if (canonicalDirectory !== canonicalExpected) {
      throw codedError('STORAGE_PATH_INVALID', 'Retention directory contains a symlink component.');
    }
    return true;
  };

  // A completion must present the claim it is completing. Without this, a worker whose lease expired while
  // it was paused could land its success on a row another worker has since claimed and is midway through,
  // and two workers could each record a deletion for one deletion.
  //
  // The UPDATE is the authorization. Matching no row is not a condition to log and swallow: it means the
  // claim now belongs to someone else, and this worker must not report a deletion it no longer owns.
  const finalise = (evidenceId, generation, payload) => withTenantTransaction(pool, identity, async (client) => {
    // Through the function, because table-wide UPDATE on evidence_files is no longer held: a role that can
    // write the retention columns can roll the generation back and defeat every check above it.
    const completed = await client.query(
      'SELECT complete_openppwr_retention($1,$2,$3,$4,$5,$6) AS completed',
      [identity.tenantId, evidenceId, leaseOwner, generation, cutoffDate.toISOString(), identity.credentialHash ?? null],
    );
    if (completed.rows[0].completed !== true) throw codedError('RETENTION_LEASE_LOST', 'The retention claim was taken by another worker.');
    // No separate append. Migration 025 writes the record inside the same function as the state change, so a
    // completion that leaves no trace is unreachable rather than merely discouraged — a worker could
    // previously mark a row deleted and simply not call this. Appending here as well would
    // record one deletion twice.
    return { evidenceId, retentionStatus: 'deleted', deletedAt: now.toISOString(), ...payload };
  });

  // Recovery first. A row left `deleting` by a process that died between removing the bytes and recording it
  // is finished here, so a crash costs one pass rather than leaving the record permanently mid-deletion.
  //
  // Only an *expired* claim. The previous version took any row in `deleting`, which is indistinguishable
  // from a deletion another worker is performing right now: the claim commits and releases its lock
  // immediately, so an active deletion and an abandoned one looked identical — the same double-record
  // hazard the generation check above exists to make unrepresentable.
  //
  // Reclaiming increments the generation, so the worker that lost the lease can no longer complete it.
  const stranded = await withTenantTransaction(pool, identity, async (client) => {
    // Only an expired claim, and the operation id is preserved: this pass is finishing the same filesystem
    // operation the abandoned worker started. The generation still advances, which is what stops the
    // previous owner completing.
    const taken = await client.query(
      'SELECT evidence_id, storage_key, generation, operation_id FROM reclaim_openppwr_retention($1,$2,$3)',
      [identity.tenantId, leaseOwner, Math.ceil(leaseMs / 1000)],
    );
    if (!taken.rowCount) return null;
    const row = taken.rows[0];
    return { id: row.evidence_id, storage_key: row.storage_key, generation: row.generation, operationId: row.operation_id };
  });
  if (stranded) {
    const original = resolveStoragePath(storageRoot, stranded.storage_key);

    // New tombstones carry row ownership in their directory. Legacy suffix candidates are enumerated, then
    // checked against persisted storage-key ownership before removal.
    //
    // Deriving it was the defect. A reclaim keeps the operation id of the attempt it inherits, so two
    // attempts could name the same path; and a deployment upgraded past migration 019 has copies under the
    // old unsuffixed `.deleting`. Removing only the "preferred" name completed the row while a readable
    // copy stayed on the volume.
    const directory = resolveStoragePath(storageRoot, `.openppwr-retention-tombstones/${stranded.id}`);
    const markUncertain = async (cause) => {
      const transitioned = await withTenantTransaction(pool, identity, (client) => client.query(
        'SELECT mark_openppwr_retention_uncertain($1,$2,$3,$4) AS transitioned',
        [identity.tenantId, stranded.id, leaseOwner, stranded.generation],
      ));
      if (transitioned.rows[0].transitioned !== true) {
        throw Object.assign(
          codedError('RETENTION_LEASE_LOST', 'Storage recovery failed after this worker lost the retention claim; current owner must reconcile it.'),
          { cause },
        );
      }
    };

    // A failure moves the row to uncertainty only while this owner/generation fence still matches. If a
    // current worker reclaimed it, transition returns false and this path reports lease loss; current owner
    // then owns reconciliation. No failure result is discarded.
    try {
      // Anchored before anything reads or writes through it. `resolveStoragePath` proves the *string* stays
      // under storageRoot; it does not prove the directory holding `original` does. A parent this pass has
      // not yet touched may already be a symlink, and both the probe below and the rename further down would
      // follow it to wherever the link points. Absence is allowed: a quarantine directory that is simply
      // missing is exactly what every other absence check here already treats as informative, not invalid.
      // Inside the try so a symlinked parent lands this claim on `integrity_unknown` through the same
      // handler every other storage failure in this pass reaches, rather than an uncaught throw that leaves
      // the row `deleting` for a later pass to hit the identical symlink again.
      await verifyConfinedDirectory(dirname(original), { allowMissing: true });

      // ENOENT means absent. Anything else — EACCES, EIO, a mount that went away — means *unknown*, and
      // reading it as absent let recovery record a deletion while the bytes were still there.
      const probe = async (path) => {
        try { await fsAccess(path); return true; }
        catch (error) {
          if (error.code === 'ENOENT') return false;
          throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot determine whether ${path} exists: ${error.code}.`);
        }
      };

      const directoryExists = await verifyConfinedDirectory(directory, { allowMissing: true });
      let entries = [];
      if (directoryExists) {
        try {
          entries = await fsReaddir(directory);
        } catch (error) {
          if (error.code !== 'ENOENT') throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot list ${directory}: ${error.code}.`);
        }
      }
      // Every entry below this evidence-specific directory belongs to this row. No filename grammar or
      // prefix inference is needed.
      const tombstones = entries.map((name) => resolve(directory, name));
      // Directory listings can be stale on remote storage. operationId names one path exactly, so probe it
      // independently before an empty listing may establish deletion.
      const preferred = tombstonePath(storageRoot, stranded.id, stranded.operationId);
      if (await probe(preferred) && !tombstones.includes(preferred)) tombstones.push(preferred);

      // Pre-027 deployments wrote suffix-based tombstones beside the original. Migration 028 reserves every
      // such suffix for new rows, so ownership cannot change after this census. Existing upgrade collisions
      // remain protected by the census because the constraint is deliberately NOT VALID.
      const legacyDirectory = dirname(original);
      const legacyBase = basename(original);
      const legacyEntries = await fsReaddir(legacyDirectory).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot list ${legacyDirectory}: ${error.code}.`);
      });
      const legacyCandidates = legacyEntries
        .filter((name) => name === `${legacyBase}.deleting` || name.startsWith(`${legacyBase}.deleting.`))
        .map((name) => ({
          key: `${stranded.storage_key}${name.slice(legacyBase.length)}`,
          path: resolve(legacyDirectory, name),
        }));
      const legacyKeys = legacyCandidates.map((candidate) => candidate.key);
      const occupied = await withTenantTransaction(pool, identity, (client) => client.query(
        `SELECT storage_key FROM evidence_files
          WHERE tenant_id=$1 AND id<>$2 AND storage_key=ANY($3::text[])`,
        [identity.tenantId, stranded.id, legacyKeys],
      ));
      const occupiedKeys = new Set(occupied.rows.map((row) => row.storage_key));
      const collisions = [];
      for (const candidate of legacyCandidates) {
        if (!await probe(candidate.path)) continue;
        if (occupiedKeys.has(candidate.key)) collisions.push(candidate.path);
        else tombstones.push(candidate.path);
      }

      const originalPresent = await probe(original);

      if (!originalPresent && collisions.length > 0) {
        throw codedError(
          'RETENTION_STORAGE_COLLISION',
          'A legacy tombstone-shaped path belongs to another evidence row; ownership of the missing bytes is uncertain.',
        );
      }

      if (!originalPresent && tombstones.length === 0) {
        // Nothing on disk: the bytes went and the record did not. Finish the record — but only once the
        // storage root itself is confirmed reachable, or "nothing on disk" could mean "no disk".
        await assertStorageRootReachable();
        return await finalise(stranded.id, stranded.generation, { cutoff: cutoffDate.toISOString(), recovered: true });
      }

      if (originalPresent) {
        // The deletion never got past its first step. The row keeps its claim and this pass finishes the
        // deletion it inherited — it is not handed back to `retained`, because releasing clears the
        // operation id while the worker that lost the lease may still be between its own rename and its
        // own removal.
        await fsMkdir(directory, { recursive: true });
        await verifyConfinedDirectory(directory);
        try {
          await fsRename(original, preferred);
        } catch (error) {
          // Remote storage can move bytes and still report EIO. Probe both outcomes before choosing release,
          // deletion, or uncertainty.
          const originalAfter = await probe(original);
          const tombstoneAfter = await probe(preferred);
          if (originalAfter && !tombstoneAfter) throw error;
          if (originalAfter || !tombstoneAfter) {
            throw codedError('RETENTION_STORAGE_UNREADABLE', 'Rename outcome is ambiguous after probing original and tombstone paths.');
          }
        }
        if (!tombstones.includes(preferred)) tombstones.push(preferred);
      }

      // Every copy, not the preferred one. `force: false`, so a removal that silently did nothing is not
      // reported as a deletion.
      for (const path of new Set(tombstones)) {
        if (!await probe(path)) continue;
        if (dirname(path) === directory) await verifyConfinedDirectory(directory);
        await fsRm(path);
        if (await probe(path)) throw codedError('RETENTION_STORAGE_UNREADABLE', `The tombstone ${path} survived its own removal.`);
      }

      if (await probe(original)) {
        throw codedError('RETENTION_STORAGE_UNREADABLE', 'The original reappeared after tombstone removal.');
      }
      const survivors = await verifyConfinedDirectory(directory, { allowMissing: true })
        ? await fsReaddir(directory).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot list ${directory}: ${error.code}.`);
        })
        : [];
      if (survivors.length > 0) {
        throw codedError('RETENTION_STORAGE_UNREADABLE', 'An owned tombstone appeared during retention removal.');
      }

      return await finalise(stranded.id, stranded.generation, { cutoff: cutoffDate.toISOString(), recovered: true });
    } catch (error) {
      await markUncertain(error);
      throw error;
    }
  }

  const claimed = await withTenantTransaction(pool, identity, async (client) => {
    const taken = await client.query(
      'SELECT evidence_id, storage_key, generation, operation_id FROM claim_openppwr_retention($1,$2,$3,$4)',
      [identity.tenantId, cutoffDate.toISOString(), leaseOwner, Math.ceil(leaseMs / 1000)],
    );
    if (!taken.rowCount) return null;
    const row = taken.rows[0];
    return { id: row.evidence_id, storage_key: row.storage_key, generation: row.generation, operationId: row.operation_id };
  });
  if (!claimed) return null;
  const original = resolveStoragePath(storageRoot, claimed.storage_key);
  const tombstoneDirectory = resolveStoragePath(storageRoot, `.openppwr-retention-tombstones/${claimed.id}`);
  const tombstone = tombstonePath(storageRoot, claimed.id, claimed.operationId);
  // Said "still working" before touching the filesystem, and *acted on the answer*. Ignoring it was the
  // whole point: a worker whose lease had already been taken went on to rename and remove the bytes
  // while the new owner, seeing the original still present, returned the row to `retained`. The bytes were
  // gone and the row said they were not.
  if (!await renewLease(pool, identity, claimed, leaseOwner, leaseMs)) {
    throw codedError('RETENTION_LEASE_LOST', 'The retention claim expired before the deletion began.');
  }
  const present = async (path) => {
    try { await fsAccess(path); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot determine whether ${path} exists: ${error.code}.`);
    }
  };
  const list = async (directory) => {
    try { return await fsReaddir(directory); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw codedError('RETENTION_STORAGE_UNREADABLE', `Cannot list ${directory}: ${error.code}.`);
    }
  };
  const markUncertain = async (cause) => {
    const transitioned = await withTenantTransaction(pool, identity, (client) => client.query(
      'SELECT mark_openppwr_retention_uncertain($1,$2,$3,$4) AS transitioned',
      [identity.tenantId, claimed.id, leaseOwner, claimed.generation],
    ));
    if (transitioned.rows[0].transitioned !== true) {
      throw Object.assign(
        codedError('RETENTION_LEASE_LOST', 'Storage became uncertain after this worker lost the retention claim; current owner must reconcile it.'),
        { cause },
      );
    }
  };
  const legacyBase = basename(original);
  const legacyTombstones = async () => (await list(dirname(original)))
    .filter((name) => name === `${legacyBase}.deleting` || name.startsWith(`${legacyBase}.deleting.`));

  let moved = false;
  let originalPresenceProven = false;
  let deletionAbsenceProven = false;
  try {
    // Anchored before the rename below touches it. `resolveStoragePath` proves the *string* stays under
    // storageRoot; it does not prove the directory holding `original` does — a quarantine parent replaced
    // by a symlink would otherwise have the rename follow it to wherever the link points. Inside the try so
    // a violation here reaches the same catch as every other storage failure in this claim and is reported
    // as uncertainty rather than an uncaught throw.
    await verifyConfinedDirectory(dirname(original), { allowMissing: true });
    await fsMkdir(tombstoneDirectory, { recursive: true });
    await verifyConfinedDirectory(tombstoneDirectory);
    try {
      await fsRename(original, tombstone);
    } catch (error) {
      // Reported rename failure does not establish whether bytes moved. Probe storage before deciding; a
      // missing original can be finalised only after this evidence-specific tombstone directory is empty.
      const originalPresent = await present(original);
      const entries = await list(tombstoneDirectory);
      const preferredPresent = await present(tombstone);
      const legacyEntries = await legacyTombstones();
      if (!originalPresent && preferredPresent
          && entries.length === 1 && entries[0] === basename(tombstone) && legacyEntries.length === 0) {
        // Rename happened despite its reported error. Continue from the observed tombstone.
        moved = true;
      } else if (!originalPresent && !preferredPresent && entries.length === 0 && legacyEntries.length === 0) {
        // Absence becomes proof only after direct probes of both known paths, enumeration of both current
        // and legacy tombstone locations, and confirmation the storage root itself is still there to be
        // empty — a missing mount reads exactly like an empty one to every probe above.
        await assertStorageRootReachable();
        deletionAbsenceProven = true;
        return await finalise(claimed.id, claimed.generation, { cutoff: cutoffDate.toISOString(), recovered: true });
      } else if (originalPresent && !preferredPresent && entries.length === 0 && legacyEntries.length === 0) {
        originalPresenceProven = true;
        throw error;
      } else {
        throw codedError('RETENTION_STORAGE_UNREADABLE', 'Rename outcome is ambiguous after probing original and tombstone paths.');
      }
    }
    moved = true;
    // The bytes go before the record. `force: false` on purpose: a removal that silently did nothing must not
    // be reported as a deletion.
    await fsRm(tombstone);
    // Confirmed gone rather than assumed, and a probe that fails for any reason other than ENOENT is not
    // evidence of absence — reading EACCES or EIO as "gone" let a deletion be recorded with the bytes still
    // there.
    if (await present(tombstone)) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', 'The tombstone survived its own removal.');
    }
    if (await present(original)) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', 'The original reappeared after tombstone removal.');
    }
    const remaining = await list(tombstoneDirectory);
    if (remaining.length > 0) {
      throw codedError('RETENTION_STORAGE_UNREADABLE', 'An owned tombstone appeared during retention removal.');
    }
    for (const name of await legacyTombstones()) {
      const legacyPath = resolve(dirname(original), name);
      if (await present(legacyPath)) {
        throw codedError('RETENTION_STORAGE_UNREADABLE', `The legacy tombstone ${legacyPath} remains present.`);
      }
    }
    deletionAbsenceProven = true;
    return await finalise(claimed.id, claimed.generation, { cutoff: cutoffDate.toISOString(), recovered: false });
  } catch (error) {
    // The row returns to `retained` only if the bytes are demonstrably back where the row says they are.
    //
    // This swallowed a failed restore and reset the row regardless. The bytes then sat under the tombstone
    // name, the next sweep found the original absent, and recorded a deletion that had not happened — the one
    // state a retention control must never reach, produced by the error handler that exists to prevent it.
    // A row left `deleting` is an incomplete deletion the next sweep finishes; a row wrongly
    // returned to `retained` is a lie the next sweep believes.
    let retainedPresenceProven = originalPresenceProven;
    if (moved && !deletionAbsenceProven) {
      try {
        await fsRename(tombstone, original);
        // A resolved rename is not physical evidence. Confirm the postcondition directly before releasing.
        retainedPresenceProven = await present(original);
      } catch {
        retainedPresenceProven = false;
      }
    }
    if (!retainedPresenceProven) {
      // The bytes are under the tombstone name and the row cannot honestly say where they are. Recording
      // `retained` claims the evidence is where the row says it is; recording `deleted` claims it is gone.
      // Both are guesses, and a retention control exists so that neither is guessed.
      await markUncertain(error);
    }
    if (retainedPresenceProven) {
      const transitioned = await withTenantTransaction(pool, identity, (client) => client.query(
        'SELECT release_openppwr_retention($1,$2,$3,$4) AS transitioned',
        [identity.tenantId, claimed.id, leaseOwner, claimed.generation],
      ));
      if (transitioned.rows[0].transitioned !== true) {
        throw Object.assign(
          codedError('RETENTION_LEASE_LOST', 'Original bytes are present, but this worker lost the retention claim before release.'),
          { cause: error },
        );
      }
    }
    throw error;
  }
}
