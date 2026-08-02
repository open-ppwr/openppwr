// Retry budgets and backoff.
//
// `scan_jobs` had one `attempts` counter, a fixed 60-second delay and a limit of three, and the counter was
// incremented at claim time — before the outcome was known. So three unrelated failure modes spent from the
// same budget, and the one that mattered was the middle one: every evidence item uploaded while the scanner
// was down burned its three attempts against an infrastructure problem and then needed a person, even
// though nothing was ever wrong with the file.
//
// These are the pure parts: the backoff curve and the configuration bounds. The behaviour against a real
// database — one poison job reaching a terminal state while healthy work continues, counters surviving a
// restart, and an outage not spending the item's budget — is in
// `apps/api/test/scan-retry.integration.test.mjs`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkerConfig, retryBackoffMs } from '../src/index.mjs';

// A credential shaped like the one bootstrap mints. The fixtures used the five-character string
// 'token', which `assertStrongSecrets` now refuses — correctly, and the fixture was the unrealistic
// part.
const WORKER_TOKEN = ['opp_', 'test_', 'b7Kq2mXr', '9TfLp4Zc', '8VnD6Hsw'].join('');

const base = { OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav' };
// Jitter off, so the curve itself is asserted rather than a sample of it.
const noJitter = { random: () => 0.5 };

test('the backoff doubles and is bounded above by the configured ceiling', () => {
  const options = { baseDelayMs: 60_000, maxDelayMs: 900_000, ...noJitter };
  assert.equal(retryBackoffMs(1, options), 60_000);
  assert.equal(retryBackoffMs(2, options), 120_000);
  assert.equal(retryBackoffMs(3, options), 240_000);
  assert.equal(retryBackoffMs(4, options), 480_000);
  // Doubling would give 960 000; the ceiling holds.
  assert.equal(retryBackoffMs(5, options), 900_000);
  assert.equal(retryBackoffMs(12, options), 900_000);
  // A huge attempt number must not overflow into Infinity or NaN — the exponent is clamped.
  assert.equal(retryBackoffMs(1000, options), 900_000);
  assert.ok(Number.isSafeInteger(retryBackoffMs(1000, options)));
});

test('the backoff never drops below the base delay, whatever the jitter draws', () => {
  const options = { baseDelayMs: 60_000, maxDelayMs: 900_000 };
  // The jitter is +/-20%, so the lowest draw would otherwise produce 48 000.
  assert.equal(retryBackoffMs(1, { ...options, random: () => 0 }), 60_000);
  assert.equal(retryBackoffMs(1, { ...options, random: () => 1 }), 72_000);
  for (const attempt of [1, 2, 3, 8, 40]) {
    for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = retryBackoffMs(attempt, { ...options, random: () => draw });
      assert.ok(delay >= 60_000, `attempt ${attempt} draw ${draw} produced ${delay}, below the base delay`);
      assert.ok(delay <= 900_000, `attempt ${attempt} draw ${draw} produced ${delay}, above the ceiling`);
    }
  }
});

// Jitter exists because every job and every worker would otherwise retry in lockstep and arrive at a
// recovering scanner as one burst.
test('the jitter actually varies the delay rather than being decorative', () => {
  const options = { baseDelayMs: 60_000, maxDelayMs: 900_000 };
  const low = retryBackoffMs(3, { ...options, random: () => 0 });
  const high = retryBackoffMs(3, { ...options, random: () => 1 });
  assert.notEqual(low, high);
  assert.equal(low, 192_000);
  assert.equal(high, 288_000);
});

test('attempt zero or a negative attempt is treated as the first, not as no delay', () => {
  const options = { baseDelayMs: 60_000, maxDelayMs: 900_000, ...noJitter };
  assert.equal(retryBackoffMs(0, options), 60_000);
  assert.equal(retryBackoffMs(-5, options), 60_000);
});

test('the infrastructure budget is separate, configurable and bounded', () => {
  assert.equal(loadWorkerConfig(base).maxInfrastructureAttempts, 12);
  // Larger than the item budget of three, because a scanner outage is not the evidence item's fault.
  assert.ok(loadWorkerConfig(base).maxInfrastructureAttempts > loadWorkerConfig(base).maxAttempts);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS: '5' }).maxInfrastructureAttempts, 5);
  // Bounded on both sides. Zero would make every infrastructure failure immediately terminal — exactly the
  // behaviour this risk is about — and an unbounded value would turn a permanent fault into a hot loop
  // nobody is told about.
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS: '0' }), /MAX_INFRASTRUCTURE_ATTEMPTS/u);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS: '101' }), /MAX_INFRASTRUCTURE_ATTEMPTS/u);
});

test('the item budget stays at three and cannot be widened by configuration', () => {
  assert.equal(loadWorkerConfig(base).maxAttempts, 3);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_ATTEMPTS: '10' }), /MAX_ATTEMPTS/u);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_ATTEMPTS: '1' }), /MAX_ATTEMPTS/u);
});

test('the backoff ceiling and the job lease are configurable and bounded', () => {
  assert.equal(loadWorkerConfig(base).maxRetryDelayMs, 900_000);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_RETRY_DELAY_MS: '120000' }).maxRetryDelayMs, 120_000);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_RETRY_DELAY_MS: '999' }), /MAX_RETRY_DELAY_MS/u);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_MAX_RETRY_DELAY_MS: '86400001' }), /MAX_RETRY_DELAY_MS/u);

  // The lease bounds how long a job may sit claimed by a worker that has died. Too short and a slow scan is
  // reclaimed while still running; unbounded and a crash strands the evidence permanently.
  assert.equal(loadWorkerConfig(base).jobLeaseMs, 300_000);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_WORKER_JOB_LEASE_MS: '60000' }).jobLeaseMs, 60_000);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_JOB_LEASE_MS: '9999' }), /JOB_LEASE_MS/u);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_JOB_LEASE_MS: '3600001' }), /JOB_LEASE_MS/u);
  // The lease must exceed the scanner timeout, or a scan still in progress is reclaimed underneath itself.
  const config = loadWorkerConfig(base);
  assert.ok(config.jobLeaseMs > config.clamav.timeoutMs, 'the lease must outlast a scanner timeout');
});
