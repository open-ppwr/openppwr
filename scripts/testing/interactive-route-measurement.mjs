// SPDX-License-Identifier: Apache-2.0
// Measures what no other harness here does: an ordinary interactive-class CRUD route, timed directly
// against a tenant of representative size. Runs the exact SQL `GET /v1/assessments`,
// `GET /v1/gaps`, `GET /v1/catalog/summary` and `GET /v1/catalog/:resource` issue (apps/api/src/app.mjs),
// under the default (interactive) deadline class, against the same 3,000-packaging synthetic tenant the
// extended-operation measurement already used — so the two results are comparable.
//
//   node scripts/testing/interactive-route-measurement.mjs [--packaging=3000] [--trials=20]
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool, migrate, withTenantTransaction } from '@openppwr/database';
import { provisionScaledTenant } from './synthetic-scale-tenant.mjs';
import { startTestDatabase } from './embedded-postgres.mjs';

function arg(name, fallback) {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const PACKAGING_COUNT = Number(arg('packaging', '3000'));
const TRIALS = Number(arg('trials', '20'));

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const q = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    count: sorted.length,
    minMs: Number((sorted[0] ?? 0).toFixed(3)),
    medianMs: Number((q(0.5) ?? 0).toFixed(3)),
    p95Ms: Number((q(0.95) ?? 0).toFixed(3)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
    meanMs: Number((sum / (sorted.length || 1)).toFixed(3)),
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function timeTrials(label, trials, operation) {
  const durations = [];
  for (let i = 0; i < trials; i += 1) {
    const start = process.hrtime.bigint();
    await operation();
    durations.push(Number(process.hrtime.bigint() - start) / 1e6);
    await sleep(20);
  }
  const stats = summarize(durations);
  console.log(`${label} trials=${stats.count} min=${stats.minMs} median=${stats.medianMs} p95=${stats.p95Ms} max=${stats.maxMs} mean=${stats.meanMs}`);
  return stats;
}

async function main() {
  let database;
  let pool;
  const storageRoot = resolve('.runtime-test', `interactive-route-${randomUUID()}`);
  try {
    console.log(`INTERACTIVE_ROUTE_MEASUREMENT_START packaging=${PACKAGING_COUNT} trials=${TRIALS} node=${process.version}`);
    database = await startTestDatabase('interactive-route-measurement');
    await migrate(database.adminUrl);
    pool = createPool(database.runtimeUrl);

    const tenant = await provisionScaledTenant({ admin: database.admin, pool, storageRoot, packagingCount: PACKAGING_COUNT, reassessmentRounds: 6 });
    console.log(`provisioned tenantId=${tenant.tenantId} catalogCounts=${JSON.stringify(tenant.catalogCounts)}`);
    console.log(`assessmentRows(expected~)=${tenant.catalogCounts.packaging * 6} openGapsRemaining=${tenant.openGapsRemaining}`);
    const identity = tenant.identities.compliance_manager;

    const results = {};

    // GET /v1/assessments default page, no deadline option -> interactive class (whatever default is
    // configured; absent means unbounded, matching every deployment shipped so far).
    results.assessments = await timeTrials('GET /v1/assessments (limit=100,offset=0)', TRIALS, () => withTenantTransaction(pool, identity, (client) => client.query(
      `SELECT a.id,a.packaging_id,a.rule_id,a.rule_version,a.supersedes_id,a.status,a.evaluated_at,r.outcome,r.explanation,r.evidence_ids
       FROM assessments a JOIN assessment_results r ON r.tenant_id=a.tenant_id AND r.assessment_id=a.id
       ORDER BY a.evaluated_at,a.packaging_id
       LIMIT $1 OFFSET $2`,
      [101, 0],
    )));

    results.assessmentsDeepPage = await timeTrials('GET /v1/assessments (limit=100, offset=17000, deep page)', TRIALS, () => withTenantTransaction(pool, identity, (client) => client.query(
      `SELECT a.id,a.packaging_id,a.rule_id,a.rule_version,a.supersedes_id,a.status,a.evaluated_at,r.outcome,r.explanation,r.evidence_ids
       FROM assessments a JOIN assessment_results r ON r.tenant_id=a.tenant_id AND r.assessment_id=a.id
       ORDER BY a.evaluated_at,a.packaging_id
       LIMIT $1 OFFSET $2`,
      [101, 17000],
    )));

    results.gaps = await timeTrials('GET /v1/gaps (limit=100,offset=0)', TRIALS, () => withTenantTransaction(pool, identity, (client) => client.query(
      `SELECT id,packaging_id,rule_id,rule_version,deduplication_key,current_assessment_id,status,owner_id,remediation_notes,remediation_evidence_ids,history
       FROM gaps ORDER BY id LIMIT $1 OFFSET $2`,
      [101, 0],
    )));

    results.catalogSummary = await timeTrials('GET /v1/catalog/summary', TRIALS, () => withTenantTransaction(pool, identity, (client) => client.query(
      `SELECT
        (SELECT count(*)::int FROM packaging) AS packaging,
        (SELECT count(*)::int FROM materials) AS materials,
        (SELECT count(*)::int FROM components) AS components,
        (SELECT count(*)::int FROM boms) AS boms,
        (SELECT count(*)::int FROM suppliers) AS suppliers`,
    )));

    results.catalogPackaging = await timeTrials('GET /v1/catalog/packaging (limit=100)', TRIALS, () => withTenantTransaction(pool, identity, (client) => client.query(
      'SELECT id,name,packaging_type,country,supplier_id,status FROM packaging ORDER BY id LIMIT 100',
    )));

    console.log('\nINTERACTIVE_ROUTE_MEASUREMENT_PASS');
    console.log(JSON.stringify({ packaging: PACKAGING_COUNT, trials: TRIALS, catalogCounts: tenant.catalogCounts, results }));
  } finally {
    await pool?.end();
    await database?.stop();
    await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
