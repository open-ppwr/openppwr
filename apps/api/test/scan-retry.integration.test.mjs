// Retry isolation and the terminal state, against a real database.
//
// The behaviour under test, and why a unit test could not have established it: the retry budgets live in
// `scan_jobs` columns, the claim predicate reads them, and the whole point of the change is which counter a
// given failure spends and whether that survives a process restart. All three are properties of the row,
// not of the function.
//
// Scenarios, in the order they appear:
//   1. a poison item exhausts its own three attempts and reaches the terminal state
//   2. a healthy item queued behind it still completes — no starvation
//   3. a scanner outage does NOT spend the item's budget, which is the defect itself
//   4. the counters survive a restart, because they are rows rather than process state
//   5. the backoff is written to `available_at`, so the job is not reclaimed immediately
//   6. the infrastructure budget is bounded too, and ends in the same terminal state
//   7. the terminal state is visible in the API and in the audit chain
//   8. an operator requeue resets both budgets, and a non-terminal job cannot be requeued
//   9. a job left `running` by a crashed worker is reclaimed after its lease

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { VerdictStubScanner, processNextScanJob, scanQueueSnapshot } from '@openppwr/worker';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, createVerifiedContext } from '../src/app.mjs';

let database;
let pool;
let workerPool;
let server;
let baseUrl;
let identities;
let requirements;
const storageRoot = resolve('.runtime-test', `scan-retry-${randomUUID()}`);

// A scanner that fails the way a real dependency fails. `processNextScanJob` needs only `.scan`.
const failingScanner = (code) => ({ scan: async () => { throw Object.assign(new Error(code), { code }); } });
const cleanScanner = new VerdictStubScanner({ runtime: 'test' });

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function upload(identity, requirement, bytes, { filename = 'declaration.pdf', mime = 'application/pdf' } = {}) {
  const form = new FormData();
  form.set('requirementId', requirement.id);
  form.set('supplierId', requirement.supplier_id);
  form.set('evidenceType', requirement.evidence_type);
  form.set('file', new Blob([bytes], { type: mime }), filename);
  const result = await jsonRequest('/v1/evidence', { method: 'POST', headers: { authorization: `Bearer ${identity.token}` }, body: form });
  assert.equal(result.response.status, 202, `upload failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

let worker;
const workerIdentity = () => worker;

// One claim-and-process cycle. `now` is passed explicitly so a backoff can be waited out in the assertion
// rather than in wall-clock time.
const runOnce = (scanner, { now = new Date() } = {}) => processNextScanJob({
  pool: workerPool, identity: workerIdentity(), storageRoot, scanner, now,
  // Jitter off: the assertions are about which counter moved, not about the sampling.
  random: () => 0.5,
});

// Read as the administrative role, not through `pool`. The runtime role is subject to row-level security
// and has no tenant context outside `withTenantTransaction`, so a direct query returns zero rows and the
// assertion silently reads `undefined` — which is how the first run of this test failed.
async function jobRow(jobId) {
  const result = await database.admin.query(
    `SELECT status,attempts,infrastructure_attempts,last_error_code,last_failure_class,terminal_reason,terminal_at,available_at
     FROM scan_jobs WHERE id=$1`,
    [jobId],
  );
  return result.rows[0];
}

before(async () => {
  database = await startTestDatabase('api-scan-retry');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  workerPool = createPool(database.workerUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
  const imported = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'scan-retry-catalog' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201);
  const listed = await jsonRequest('/v1/evidence-requirements', { headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } });
  requirements = listed.body.items;
  assert.ok(requirements.length >= 5, `need several requirements, got ${requirements.length}`);
  worker = await createVerifiedContext(pool, identities.worker.token);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await workerPool?.end();
  await database?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

// 1 and 2 together, because the second is only meaningful in the presence of the first.
//
// The claim order is deliberately not assumed here. The first version of this test asserted that every
// cycle would claim the poison job, and it failed on cycle 2 — correctly. Once a job has failed, its
// `available_at` is pushed into the future, so the healthy job created afterwards is now the earliest due
// work and is claimed ahead of it. That ordering *is* the anti-starvation property, so the test asserts the
// outcome per item rather than the sequence.
test('a poison item reaches the terminal state while a healthy item behind it still completes', async () => {
  const poison = await upload(identities.evidence_contributor, requirements[0], Buffer.from('%PDF-1.4 poison'));
  const healthy = await upload(identities.evidence_contributor, requirements[1], Buffer.from('%PDF-1.4 fine'));

  // A scanner that fails on one file and works on the others, which is how a corrupt upload actually
  // behaves. A scanner that failed unconditionally could not distinguish starvation from a broken scanner.
  const selective = {
    scan: async (content) => {
      if (content.includes(Buffer.from('poison'))) throw Object.assign(new Error('mismatch'), { code: 'EVIDENCE_INTEGRITY_MISMATCH' });
      return { status: 'clean', engine: 'selective-test' };
    },
  };

  const byEvidence = new Map();
  const order = [];
  for (let cycle = 1; cycle <= 6; cycle += 1) {
    const result = await runOnce(selective, { now: new Date(Date.now() + cycle * 120_000) });
    if (!result) break;
    order.push(result.evidenceId);
    byEvidence.set(result.evidenceId, [...(byEvidence.get(result.evidenceId) || []), result]);
  }

  const poisonOutcomes = byEvidence.get(poison.id) || [];
  const healthyOutcomes = byEvidence.get(healthy.id) || [];

  // The poison item spends its own three attempts and then stops, with a reason.
  assert.deepEqual(poisonOutcomes.map((outcome) => outcome.attempt), [1, 2, 3]);
  assert.deepEqual(poisonOutcomes.map((outcome) => outcome.failureClass), ['content', 'content', 'content']);
  assert.deepEqual(poisonOutcomes.map((outcome) => outcome.jobStatus), ['failed', 'failed', 'dead']);
  assert.equal(poisonOutcomes[2].terminalReason, 'content_attempts_exhausted');
  assert.equal(poisonOutcomes[2].requiresAttention, true);
  // A content failure spends nothing from the infrastructure budget.
  assert.deepEqual(poisonOutcomes.map((outcome) => outcome.infrastructureAttempts), [0, 0, 0]);

  // The healthy item completes exactly once, and is not held up until the poison job has finished failing.
  assert.equal(healthyOutcomes.length, 1);
  assert.equal(healthyOutcomes[0].scanStatus, 'clean');
  assert.equal(healthyOutcomes[0].jobStatus, 'completed');
  assert.equal(healthyOutcomes[0].errorCode, null);
  const healthyPosition = order.indexOf(healthy.id);
  const poisonTerminalPosition = order.lastIndexOf(poison.id);
  assert.ok(
    healthyPosition < poisonTerminalPosition,
    `the healthy item completed at position ${healthyPosition}, after the poison job became terminal at ${poisonTerminalPosition} — that is starvation`,
  );
});

// 3. The defect itself.
test('a scanner outage does not spend the evidence item budget', async () => {
  const item = await upload(identities.evidence_contributor, requirements[2], Buffer.from('%PDF-1.4 outage'));

  const outcomes = [];
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    // Past the exponential backoff each time: 60s, 120s, 240s, 480s, then the 900s ceiling.
    const now = new Date(Date.now() + cycle * 2_000_000);
    const result = await runOnce(failingScanner('MALWARE_SCANNER_UNAVAILABLE'), { now });
    assert.equal(result.evidenceId, item.id);
    outcomes.push(result);
  }

  // Five infrastructure failures, and the item has spent none of its three attempts. Under the previous
  // implementation the first three of these would have exhausted the budget and left the job terminal.
  assert.deepEqual(outcomes.map((outcome) => outcome.attempt), [0, 0, 0, 0, 0]);
  assert.deepEqual(outcomes.map((outcome) => outcome.infrastructureAttempts), [1, 2, 3, 4, 5]);
  assert.deepEqual(outcomes.map((outcome) => outcome.failureClass), Array(5).fill('infrastructure'));
  assert.deepEqual(outcomes.map((outcome) => outcome.jobStatus), Array(5).fill('failed'));
  assert.equal(outcomes.at(-1).requiresAttention, false, 'an outage must not condemn the item');

  // 5. The backoff grows and is written to the row, so the job is genuinely deferred rather than spun on.
  const delays = outcomes.map((outcome) => outcome.availableInMs);
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 900_000]);
  const row = await jobRow(outcomes.at(-1).jobId);
  assert.equal(row.status, 'failed');
  assert.equal(Number(row.attempts), 0);
  assert.equal(Number(row.infrastructure_attempts), 5);
  assert.equal(row.last_failure_class, 'infrastructure');
  assert.equal(row.terminal_reason, null);

  // 4. Counters are rows, so they survive a restart. This claim comes from a fresh call with no shared
  // state, and a transient failure then recovers rather than being punished for the outage.
  const recovered = await runOnce(cleanScanner, { now: new Date(Date.now() + 20_000_000) });
  assert.equal(recovered.evidenceId, item.id);
  assert.equal(recovered.scanStatus, 'clean');
  assert.equal(recovered.attempt, 0, 'a recovered item must not carry a spent attempt');
});

// 6. The infrastructure budget is generous, not infinite: an unbounded retry is a hot loop that hides a
// permanent fault rather than a kindness.
test('the infrastructure budget is bounded and ends in the same terminal state', async () => {
  const item = await upload(identities.evidence_contributor, requirements[3], Buffer.from('%PDF-1.4 permanent'));
  let last;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    last = await processNextScanJob({
      pool: workerPool, identity: workerIdentity(), storageRoot, scanner: failingScanner('EVIDENCE_STORAGE_UNAVAILABLE'),
      now: new Date(Date.now() + cycle * 2_000_000), random: () => 0.5,
      // A deliberately small limit, so the boundary is exercised rather than described.
      maxInfrastructureAttempts: 3,
    });
    assert.equal(last.evidenceId, item.id);
  }
  assert.equal(last.infrastructureAttempts, 3);
  assert.equal(last.jobStatus, 'dead');
  assert.equal(last.terminalReason, 'infrastructure_attempts_exhausted');
  assert.equal(last.requiresAttention, true);
  // The item's own budget is still untouched, which is what an operator needs to know before requeueing.
  assert.equal(last.attempt, 0);
  const row = await jobRow(last.jobId);
  assert.equal(row.status, 'dead');
  assert.ok(row.terminal_at, 'a terminal job records when it became terminal');
});

// 7. No silent drop.
test('the terminal state is visible in the API, the queue snapshot and the audit chain', async () => {
  const listed = await jsonRequest('/v1/scan-jobs?requiresAttention=true', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.body.items.length >= 2, `expected the terminal jobs to be listed, got ${listed.body.items.length}`);
  for (const item of listed.body.items) {
    assert.equal(item.requiresAttention, true);
    assert.ok(['content_attempts_exhausted', 'infrastructure_attempts_exhausted'].includes(item.terminalReason));
    assert.ok(item.lastErrorCode, 'a terminal job must say what failed');
    assert.ok(item.correlationId, 'a terminal job must carry a correlation identifier');
  }
  // Both failure classes are represented, so the listing distinguishes them rather than flattening both
  // into "it failed".
  const reasons = new Set(listed.body.items.map((item) => item.terminalReason));
  assert.equal(reasons.size, 2, `expected both terminal reasons, got ${[...reasons].join(', ')}`);

  // The worker's pool, not the request pool. `scanQueueSnapshot` is a worker entry point — the worker
  // calls it on its own principal (apps/worker/src/server.mjs) and migration 022 grants `SELECT ON
  // scan_jobs` to `openppwr_worker` for it. Running it here on `pool` happened to pass only because
  // `openppwr_app` still holds the migration-001 `SELECT` on that table, so this assertion proved the
  // wrong principal could read the queue and said nothing about the one that actually does. Migration 029
  // is the same shape reaching a real deployment: a worker grant no gate exercised, found by the crash.
  const snapshot = await scanQueueSnapshot(workerPool, workerIdentity());
  assert.equal(snapshot.requiresAttention, listed.body.items.length);

  // The audit chain carries a distinct event for reaching the terminal state, separate from the failing
  // attempt: "this has stopped and needs a person" is a different fact from "this attempt failed".
  const events = await database.admin.query(`SELECT action,payload FROM audit_events WHERE action='evidence.scan.requires_attention' ORDER BY sequence`);
  assert.equal(events.rowCount, listed.body.items.length);
  for (const row of events.rows) {
    assert.ok(row.payload.terminalReason);
    assert.ok(row.payload.correlationId);
    assert.ok(Object.hasOwn(row.payload, 'attempts') && Object.hasOwn(row.payload, 'infrastructureAttempts'));
  }
  const verified = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(verified.body.valid, true, 'the chain must still verify after the terminal events');
});

// The listing is an operator surface, not a compliance one.
test('the scan job listing is denied to roles without the operator permission', async () => {
  for (const role of ['compliance_manager', 'evidence_reviewer', 'read_only_auditor', 'supplier_user', 'evidence_contributor']) {
    const denied = await jsonRequest('/v1/scan-jobs', { headers: { authorization: `Bearer ${identities[role].token}` } });
    assert.equal(denied.response.status, 404, `${role} must not read the scanning queue: ${JSON.stringify(denied.body)}`);
    assert.equal(denied.body.error.code, 'RESOURCE_NOT_FOUND');
  }
});

// 8.
test('an operator requeue resets both budgets and a non-terminal job cannot be requeued', async () => {
  const listed = await jsonRequest('/v1/scan-jobs?requiresAttention=true', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  const target = listed.body.items.find((item) => item.terminalReason === 'content_attempts_exhausted');
  assert.ok(target, 'the content-exhausted job must be present for this test to mean anything');
  assert.equal(target.attempts, 3);

  const requeued = await jsonRequest(`/v1/scan-jobs/${target.jobId}/requeue`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(requeued.response.status, 200);
  assert.equal(requeued.body.attempts, 0);
  assert.equal(requeued.body.infrastructureAttempts, 0);

  const row = await jobRow(target.jobId);
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.attempts), 0);
  assert.equal(Number(row.infrastructure_attempts), 0);
  assert.equal(row.terminal_reason, null, 'a requeued job must not still claim to be terminal');
  assert.equal(row.terminal_at, null);
  assert.equal(row.last_failure_class, null);

  // Requeueing it again is refused, because it is no longer terminal. A remedy that silently succeeds
  // against a running job would hide the fact that nothing needed fixing.
  const again = await jsonRequest(`/v1/scan-jobs/${target.jobId}/requeue`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(again.response.status, 409);
  assert.equal(again.body.error.code, 'SCAN_JOB_NOT_DEAD');

  // And the requeued item can now be scanned successfully, so the reset is real rather than cosmetic.
  const rescanned = await runOnce(cleanScanner, { now: new Date(Date.now() + 30_000_000) });
  assert.equal(rescanned.jobId, target.jobId);
  assert.equal(rescanned.scanStatus, 'clean');
});

// 9. The third failure mode the single counter hid: a worker killed mid-scan left the job `running` for
// ever, because nothing reclaimed it and the claim predicate did not look at `running` rows.
test('a job left running by a crashed worker is reclaimed after its lease, and the reclaim is charged', async () => {
  const item = await upload(identities.evidence_contributor, requirements[4], Buffer.from('%PDF-1.4 stranded'));
  // Simulate the crash: claim the job and leave it `running`, exactly as an abrupt exit would.
  const claimed = await database.admin.query(
    `UPDATE scan_jobs SET status='running',updated_at=$1 WHERE evidence_id=$2 RETURNING id`,
    [new Date(Date.now() - 3_600_000).toISOString(), item.id],
  );
  assert.equal(claimed.rowCount, 1);
  const jobId = claimed.rows[0].id;

  // Inside the lease it stays claimed: a slow scan must not be reclaimed underneath itself.
  const notYet = await processNextScanJob({
    pool: workerPool, identity: workerIdentity(), storageRoot, scanner: cleanScanner,
    now: new Date(Date.now() - 3_540_000), jobLeaseMs: 300_000, random: () => 0.5,
  });
  assert.notEqual(notYet?.jobId, jobId, 'a job inside its lease must not be reclaimed');

  // Past the lease it is reclaimed, and the reclaim spends an item attempt so a job that kills the worker
  // cannot be retried for ever.
  const reclaimed = await processNextScanJob({
    pool: workerPool, identity: workerIdentity(), storageRoot, scanner: cleanScanner,
    now: new Date(Date.now() + 40_000_000), jobLeaseMs: 300_000, random: () => 0.5,
  });
  assert.equal(reclaimed.jobId, jobId);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.attempt, 1, 'the reclaim is charged to the item budget, bounding a crash loop');
  assert.equal(reclaimed.scanStatus, 'clean');
});

// Exhaustion was judged against the budget the current failure spends, which left a hole exactly at
// the boundary: a job reclaimed from an expired lease charges an item attempt, and if it then failed on
// infrastructure the row was written back as `failed` with `attempts = 3`. The claim predicate requires
// `attempts < limit`, so nothing would claim it again; requeue accepts only `dead`, so no operator could
// recover it. Invisible and unrecoverable, with no terminal reason recorded.
test('a reclaimed job that exhausts its item budget on an infrastructure failure is still terminal', async () => {
  const item = await upload(identities.evidence_contributor, requirements[5] || requirements[0], Buffer.from('%PDF-1.4 boundary'));
  const jobId = (await database.admin.query('SELECT id FROM scan_jobs WHERE evidence_id=$1', [item.id])).rows[0].id;

  // Exactly the boundary state: two item attempts already spent, and the job left `running` by a worker that
  // died, with its lease long expired.
  await database.admin.query(
    `UPDATE scan_jobs SET status='running', attempts=2, infrastructure_attempts=0, updated_at=$1 WHERE id=$2`,
    [new Date(Date.now() - 3_600_000).toISOString(), jobId],
  );

  const result = await processNextScanJob({
    pool: workerPool, identity: workerIdentity(), storageRoot,
    scanner: failingScanner('MALWARE_SCANNER_UNAVAILABLE'),
    now: new Date(Date.now() + 40_000_000), random: () => 0.5,
  });
  assert.equal(result.jobId, jobId);
  assert.equal(result.reclaimed, true);
  assert.equal(result.attempt, 3, 'the reclaim charges the item budget, which is what exhausts it');
  assert.equal(result.failureClass, 'infrastructure');
  assert.equal(result.jobStatus, 'dead', 'a row the claim predicate can never select again must be terminal');
  assert.equal(result.terminalReason, 'content_attempts_exhausted');
  assert.equal(result.requiresAttention, true);

  const row = await jobRow(jobId);
  assert.equal(row.status, 'dead');
  assert.ok(row.terminal_at, 'a terminal row records when');

  // And the operator can now both see it and recover it — neither was possible before.
  const listed = await jsonRequest('/v1/scan-jobs?requiresAttention=true', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.ok(listed.body.items.some((entry) => entry.jobId === jobId), 'the terminal job must be visible to an operator');
  const requeued = await jsonRequest(`/v1/scan-jobs/${jobId}/requeue`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(requeued.response.status, 200);
  assert.equal(requeued.body.attempts, 0);
});
