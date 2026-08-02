// SPDX-License-Identifier: Apache-2.0
// Measures the four things `packages/database/src/index.mjs` (see the `DEADLINE_VARIABLES` comment block)
// says would be needed before a default could honestly be shipped for
// `OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS`, `OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS` and
// `OPENPPWR_DB_CHECKOUT_TIMEOUT_MS`: the same operations, against a tenant of representative size, and pool
// checkout under a range of concurrency rather than one data point.
//
//   node scripts/testing/deadline-scale-measurement.mjs [--packaging=3000] [--rounds=6]
//
// Everything here runs against a real embedded PostgreSQL cluster (`scripts/testing/embedded-postgres.mjs`)
// — nothing is estimated or invented. Four measurements, in order:
//
//   1. `freezeReviewSnapshot`, `generateDossier` and `verifyAuditChain` against one synthetic tenant built
//      by `scripts/testing/synthetic-scale-tenant.mjs` through real writes (import, assessment, gap
//      remediation, several reassessment rounds), wall time plus a per-statement breakdown captured by
//      instrumenting the connection pool.
//   2. The `verifyAuditChain` scaling curve the code comment already tried once (1k/5k/10k/20k/40k/50k
//      events) and found noisy — repeated here with multiple settled trials per checkpoint on one
//      incrementally-grown chain, so the spread reported is the spread across repeated reads of the *same*
//      data rather than across different chains.
//   3. Pool checkout latency across a range of concurrency levels (below, at and above the pool's `max`),
//      not the single 10-holders-at-250ms data point the code comment recorded.
//
// Output is newline-delimited so it is easy to grep; nothing here writes to the repository.
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { appendAudit, createPool, migrate, tokenHash, verifyAuditChain, withTenantTransaction } from '@openppwr/database';
import { generateDossier, freezeReviewSnapshot } from '../../apps/api/src/dossier-service.mjs';
import { provisionScaledTenant } from './synthetic-scale-tenant.mjs';
import { startTestDatabase } from './embedded-postgres.mjs';

const { Pool } = pg;

function arg(name, fallback) {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const PACKAGING_COUNT = Number(arg('packaging', '3000'));
const REASSESSMENT_ROUNDS = Number(arg('rounds', '6'));

// --- statement-level instrumentation ------------------------------------------------------------------
// Wraps `pool.connect()` for the duration of one call so every statement issued by whatever service
// function runs against the returned client is timed and labelled, without changing anything the
// service function itself does. Restored immediately after, so it never affects a step it was not asked
// to measure.
function instrumentPool(pool) {
  const records = [];
  const originalConnect = pool.connect.bind(pool);
  pool.connect = async (...args) => {
    const client = await originalConnect(...args);
    const originalQuery = client.query.bind(client);
    client.query = async (...queryArguments) => {
      const text = typeof queryArguments[0] === 'string' ? queryArguments[0] : queryArguments[0]?.text || '';
      const label = text.trim().split('\n')[0].replace(/\s+/gu, ' ').slice(0, 72);
      const start = process.hrtime.bigint();
      try {
        return await originalQuery(...queryArguments);
      } finally {
        records.push({ label, durationMs: Number(process.hrtime.bigint() - start) / 1e6 });
      }
    };
    return client;
  };
  return { records, restore: () => { pool.connect = originalConnect; } };
}

function quantile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
  return sortedValues[index];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    totalMs: Number(sum.toFixed(3)),
    minMs: Number((sorted[0] ?? 0).toFixed(3)),
    medianMs: Number(quantile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(quantile(sorted, 0.95).toFixed(3)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
  };
}

function topLabels(records, n = 8) {
  const byLabel = new Map();
  for (const record of records) {
    const entry = byLabel.get(record.label) || { label: record.label, count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    entry.totalMs += record.durationMs;
    entry.maxMs = Math.max(entry.maxMs, record.durationMs);
    byLabel.set(record.label, entry);
  }
  return [...byLabel.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, n)
    .map((entry) => ({ ...entry, totalMs: Number(entry.totalMs.toFixed(3)), avgMs: Number((entry.totalMs / entry.count).toFixed(3)), maxMs: Number(entry.maxMs.toFixed(3)) }));
}

async function measureOperation(pool, label, operation) {
  const instrumentation = instrumentPool(pool);
  const start = process.hrtime.bigint();
  let result;
  let error = null;
  try {
    result = await operation();
  } catch (thrown) {
    error = thrown;
  } finally {
    instrumentation.restore();
  }
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (error) throw error;
  const statementStats = summarize(instrumentation.records.map((record) => record.durationMs));
  console.log(`\n--- ${label} ---`);
  console.log(`wallMs=${wallMs.toFixed(3)} statementCount=${statementStats.count} statementTotalMs=${statementStats.totalMs} statementMedianMs=${statementStats.medianMs} statementP95Ms=${statementStats.p95Ms} statementMaxMs=${statementStats.maxMs}`);
  console.log(`slowest statement groups: ${JSON.stringify(topLabels(instrumentation.records))}`);
  return { label, wallMs, statementStats, result };
}

// --- part 2: the verifyAuditChain scaling curve, controlled for settle time ---------------------------
// One tenant, grown incrementally rather than rebuilt at each size — a real chain never resets between
// checkpoints either — with the chain's own writes (which do involve disk flushes) kept strictly separate
// in time from the read-only verification trials that are actually being measured.
async function seedBareTenant(admin, slug) {
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const credentialHash = tokenHash(randomBytes(24).toString('base64url'));
  await admin.query('INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,$3,$4)', [tenantId, slug, `Audit curve ${slug}`, 'Synthetic tenant used only to grow an audit chain for a scaling measurement.']);
  await admin.query(`INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash) VALUES ($1,$2,'audit curve actor','tenant_admin',NULL,$3)`, [tenantId, actorId, credentialHash]);
  return { tenantId, actorId, credentialHash };
}

// `append_openppwr_audit_event` refuses any action not on `audit_action_registry` for the calling
// principal (migration 024) — a default-deny registry, deliberately, so a synthetic label invented for
// this script is refused exactly the way an unregistered action from real application code would be.
// `import.accepted` is registered for `openppwr_app` and carries no meaning this script depends on beyond
// "a real, permitted audit event", which is all a pure chain-length curve needs.
async function appendEvents(pool, identity, count) {
  for (let i = 0; i < count; i += 1) {
    await withTenantTransaction(pool, identity, (client) => appendAudit(client, { action: 'import.accepted', entityType: 'scale-curve', entityId: `evt-${i}`, payload: { i } }));
  }
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

async function auditChainScalingCurve(pool, identity) {
  const checkpoints = [1000, 5000, 10000, 20000, 40000, 50000];
  const trialsPerCheckpoint = 5;
  const settleMs = 500;
  let inserted = 0;
  console.log('\n--- verifyAuditChain scaling curve (one incrementally-grown chain, 5 settled trials per checkpoint) ---');
  const curve = [];
  for (const checkpoint of checkpoints) {
    const toInsert = checkpoint - inserted;
    const insertStart = process.hrtime.bigint();
    await appendEvents(pool, identity, toInsert);
    inserted = checkpoint;
    const insertMs = Number(process.hrtime.bigint() - insertStart) / 1e6;
    // Let the inserts' own I/O settle before timing reads, and give the platform's own background load
    // (this environment's on-access scanner among it, per scripts/testing/embedded-postgres.mjs) a chance
    // to quiesce rather than bleed into the first read trial.
    await sleep(settleMs);
    if (globalThis.gc) globalThis.gc();
    const trials = [];
    for (let trial = 0; trial < trialsPerCheckpoint; trial += 1) {
      const start = process.hrtime.bigint();
      const verified = await withTenantTransaction(pool, identity, (client) => verifyAuditChain(client), { deadline: 'extended' });
      const trialMs = Number(process.hrtime.bigint() - start) / 1e6;
      if (!verified.valid) throw new Error(`audit chain reported invalid at checkpoint ${checkpoint}, trial ${trial}`);
      trials.push(trialMs);
      await sleep(100);
    }
    const stats = summarize(trials);
    const spread = stats.maxMs - stats.minMs;
    console.log(`events=${checkpoint} insertMs=${insertMs.toFixed(1)} verifyTrialsMs=${trials.map((v) => v.toFixed(1)).join(',')} median=${stats.medianMs} min=${stats.minMs} max=${stats.maxMs} spread=${spread.toFixed(1)} spreadPctOfMedian=${stats.medianMs ? ((spread / stats.medianMs) * 100).toFixed(0) : 'n/a'}%`);
    curve.push({ events: checkpoint, insertMs, trials, stats });
  }
  return curve;
}

// --- part 3: pool checkout latency across a range of concurrency ---------------------------------------
async function measureCheckoutConcurrency(connectionString, concurrency, holdMs) {
  const testPool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  try {
    const checkoutMsValues = await Promise.all(Array.from({ length: concurrency }, async () => {
      const start = process.hrtime.bigint();
      const client = await testPool.connect();
      const checkoutMs = Number(process.hrtime.bigint() - start) / 1e6;
      await sleep(holdMs);
      client.release();
      return checkoutMs;
    }));
    return summarize(checkoutMsValues);
  } finally {
    await testPool.end();
  }
}

async function poolCheckoutCurve(connectionString) {
  console.log('\n--- pool checkout latency across concurrency levels (pool max=10, each holder released after 250ms) ---');
  const levels = [1, 5, 10, 15, 20, 50];
  const curve = [];
  for (const concurrency of levels) {
    const stats = await measureCheckoutConcurrency(connectionString, concurrency, 250);
    console.log(`concurrency=${concurrency} min=${stats.minMs} median=${stats.medianMs} p95=${stats.p95Ms} max=${stats.maxMs}`);
    curve.push({ concurrency, stats });
    await sleep(200);
  }
  return curve;
}

async function main() {
  let database;
  let pool;
  const storageRoot = resolve('.runtime-test', `deadline-scale-${randomUUID()}`);
  try {
    console.log(`DEADLINE_SCALE_MEASUREMENT_START packaging=${PACKAGING_COUNT} reassessmentRounds=${REASSESSMENT_ROUNDS} node=${process.version} platform=${process.platform} gcExposed=${Boolean(globalThis.gc)}`);
    database = await startTestDatabase('deadline-scale-measurement');
    await migrate(database.adminUrl);
    pool = createPool(database.runtimeUrl);

    console.log('\n=== Part 1: representative tenant ===');
    const provisionStart = process.hrtime.bigint();
    const tenant = await provisionScaledTenant({ admin: database.admin, pool, storageRoot, packagingCount: PACKAGING_COUNT, reassessmentRounds: REASSESSMENT_ROUNDS });
    const provisionMs = Number(process.hrtime.bigint() - provisionStart) / 1e6;
    console.log(`provisioned tenantId=${tenant.tenantId} provisionMs=${provisionMs.toFixed(1)}`);
    console.log(`catalogCounts=${JSON.stringify(tenant.catalogCounts)}`);
    console.log(`importBatches=${tenant.importBatches} evidenceCount=${tenant.evidenceCount} remediatedGaps=${tenant.remediatedGaps} assessmentRounds=${tenant.assessmentRounds} openGapsRemaining=${tenant.openGapsRemaining} auditEventCount=${tenant.auditEventCount}`);
    if (tenant.openGapsRemaining !== 0) throw new Error(`expected zero open gaps before freezing, found ${tenant.openGapsRemaining}`);

    const freeze = await measureOperation(pool, 'freezeReviewSnapshot', () => freezeReviewSnapshot(pool, tenant.identities.compliance_manager, { locale: 'en' }));
    const dossier = await measureOperation(pool, 'generateDossier', () => generateDossier(pool, tenant.identities.compliance_manager, { snapshotId: freeze.result.id, storageRoot }));
    const audit = await measureOperation(pool, `verifyAuditChain (representative tenant, ${tenant.auditEventCount} events)`, () => withTenantTransaction(pool, tenant.identities.compliance_manager, (client) => verifyAuditChain(client), { deadline: 'extended' }));

    console.log('\n=== Part 2: verifyAuditChain scaling curve ===');
    const curveTenant = await seedBareTenant(database.admin, `curve-${randomUUID().slice(0, 8)}`);
    const curve = await auditChainScalingCurve(pool, curveTenant);

    console.log('\n=== Part 3: pool checkout concurrency ===');
    const checkoutCurve = await poolCheckoutCurve(database.runtimeUrl);

    console.log('\nDEADLINE_SCALE_MEASUREMENT_PASS');
    console.log(JSON.stringify({
      packaging: PACKAGING_COUNT,
      reassessmentRounds: REASSESSMENT_ROUNDS,
      catalogCounts: tenant.catalogCounts,
      auditEventCount: tenant.auditEventCount,
      freeze: { wallMs: freeze.wallMs, statementStats: freeze.statementStats },
      dossier: { wallMs: dossier.wallMs, statementStats: dossier.statementStats },
      audit: { wallMs: audit.wallMs, statementStats: audit.statementStats },
      auditScalingCurve: curve.map((point) => ({ events: point.events, stats: point.stats })),
      checkoutCurve: checkoutCurve.map((point) => ({ concurrency: point.concurrency, stats: point.stats })),
    }));
  } finally {
    await pool?.end();
    await database?.stop();
    await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
