// SPDX-License-Identifier: Apache-2.0
// One-command reset of the isolated ACME demonstration tenant.
//
//   node scripts/acme/demo-reset.mjs --dry-run
//   OPENPPWR_DEMO_RESET_CONFIRM=yes node scripts/acme/demo-reset.mjs
//
// Fails closed. It refuses to touch anything it cannot positively identify as the fictional ACME
// demonstration tenant, because the cost of guessing wrong is destroying real compliance evidence.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { appendAudit } from '@openppwr/database';
import { ACME_DATASET, canonicalAcmeJson, validateAcmeDataset } from '../../packages/testing/src/index.mjs';

const { Client } = pg;
const dryRun = process.argv.includes('--dry-run');
const confirmed = process.env.OPENPPWR_DEMO_RESET_CONFIRM === 'yes';
const connectionString = process.env.OPENPPWR_DEMO_DATABASE_URL || process.env.OPENPPWR_MIGRATION_DATABASE_URL;
const maintenanceConnectionString = process.env.OPENPPWR_MAINTENANCE_DATABASE_URL;
const expectedSlug = process.env.OPENPPWR_DEMO_TENANT_SLUG || 'acme-eu-demo';

// Scoped mode: clear exactly one named tenant and prove the others were untouched.
//
// The default path below TRUNCATEs the domain tables, which is why it refuses to run unless the
// database holds exactly one tenant — on a multi-tenant deployment it would take every tenant's data
// with it. That guard is correct and stays.
//
// It also makes the default path unusable on the private deployment, which holds a demonstration
// tenant and a synthetic isolation tenant. Rather than weaken the guard, this mode deletes by
// tenant_id and then asserts that every other tenant's row counts are unchanged. It is strictly
// narrower than the global path, and it verifies its own blast radius instead of assuming it.
const scopedArgument = process.argv.find((argument) => argument.startsWith('--tenant-slug='));
const scopedSlug = scopedArgument ? scopedArgument.slice('--tenant-slug='.length) : null;

// Tables truncated on reset, ordered so dependants go first. `tenants` and `identities` are
// deliberately absent: bootstrap is a one-time operation and deleting identities would destroy
// credentials that cannot be reissued, which is how a demo reset turns into a bricked deployment.
const DEMO_TABLES = [
  'dossier_artifacts', 'review_snapshots', 'assessment_results', 'assessments', 'gaps',
  'scan_jobs', 'evidence_files', 'evidence_requirements',
  'bom_lines', 'boms', 'packaging', 'components', 'materials', 'suppliers',
  'import_row_results', 'import_runs', 'audit_events',
];

// Tables never cleared by any reset path. audit_events is append-only: migration 001 blocks row-level
// mutation and migration 007 blocks TRUNCATE.
const AUDIT_PRESERVED = ['audit_events'];

// Every reset appends through the dedicated maintenance principal. The migration connection keeps the
// destructive privileges it needs, but never gains authority to author audit events under arbitrary actions.
async function recordResetEvent({ tenantId, mode, clearedTables, clearedRows = null, packagingBefore = null }) {
  const correlationId = randomUUID();
  const maintenance = new Client({ connectionString: maintenanceConnectionString });
  await maintenance.connect();
  try {
    await appendAudit(maintenance, {
      actorCredential: null,
      action: 'demo.reset.completed',
      entityType: 'tenant',
      entityId: tenantId,
      payload: {
        mode,
        clearedTables,
        clearedRows,
        packagingBefore,
        auditPreserved: true,
        correlationId,
        seed: ACME_DATASET.seed,
        generatorVersion: ACME_DATASET.generatorVersion,
      },
    });
  } finally {
    await maintenance.end();
  }
  return correlationId;
}

function fail(message, code = 1) {
  console.error(`DEMO_RESET_FAIL ${message}`);
  process.exitCode = code;
  return null;
}

// Row counts per tenant for every table this script can touch, so collateral damage is measured
// rather than asserted. Tables without a tenant_id column are reported separately: they are joined to
// a tenant only through a parent row, so a scoped delete reaches them by cascade.
async function tenantCounts(client, tables) {
  const counts = {};
  for (const table of tables) {
    const hasTenant = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'`,
      [table],
    );
    if (!hasTenant.rowCount) {
      const total = await client.query(`SELECT count(*)::int AS total FROM ${table}`);
      counts[table] = { _total: total.rows[0].total };
      continue;
    }
    const rows = await client.query(`SELECT tenant_id::text AS tenant, count(*)::int AS total FROM ${table} GROUP BY tenant_id`);
    counts[table] = Object.fromEntries(rows.rows.map((row) => [row.tenant, row.total]));
  }
  return counts;
}

async function resetOneTenant(client, slug) {
  const found = await client.query('SELECT id, slug, disclaimer FROM tenants WHERE slug=$1', [slug]);
  if (found.rowCount === 0) return fail(`no tenant with slug "${slug}"`);
  if (found.rowCount > 1) return fail(`slug "${slug}" is ambiguous`);
  const tenant = found.rows[0];

  // Fail closed on anything that is not positively marked as fictional. The cost of guessing wrong is
  // destroying real compliance evidence, so an absent disclaimer is a stop condition, not a warning.
  if (!tenant.disclaimer || !/synthetic|fictional|fiction/iu.test(tenant.disclaimer)) {
    return fail(`refusing to act: tenant "${slug}" carries no synthetic-data disclaimer`);
  }

  const before = await tenantCounts(client, DEMO_TABLES);
  const mine = (counts) => Object.entries(counts).reduce((sum, [table, byTenant]) => sum + (byTenant[tenant.id] || 0), 0);

  if (dryRun) {
    console.log(`DEMO_RESET_SCOPED_DRY_RUN tenant=${slug} id=${tenant.id} tables=${DEMO_TABLES.length} rows_for_this_tenant=${mine(before)} other_tenants_preserved=yes dataset_sha256=${createHash('sha256').update(canonicalAcmeJson()).digest('hex')}`);
    return null;
  }

  // Single transaction, dependants first. A partially reset tenant is worse than one never reset.
  //
  // The order below is NOT the same as DEMO_TABLES, and the difference is load-bearing. The global path
  // uses TRUNCATE ... CASCADE, which resolves foreign keys itself, so its list only has to be roughly
  // right. A scoped DELETE has no CASCADE and must satisfy every constraint as it goes.
  //
  // Found by this failing, closed, and rolling back: `gaps.current_assessment_id` references
  // `assessments`, and DEMO_TABLES deletes assessments first. Nothing was lost, because the whole
  // thing is one transaction — but the ordering had to be stated explicitly rather than inherited.
  const SCOPED_DELETE_ORDER = [
    'dossier_artifacts', 'review_snapshots',
    // gaps first: it points at assessments, and at packaging.
    'gaps', 'assessment_results', 'assessments',
    'scan_jobs', 'evidence_files', 'evidence_requirements',
    'bom_lines', 'boms', 'packaging', 'components', 'materials', 'suppliers',
    'import_row_results', 'import_runs', 'audit_events',
  ];

  // Preserved on purpose, and the reason is a security property rather than a convenience.
  //
  // `audit_events` carries a BEFORE UPDATE OR DELETE row trigger that raises 'audit events are
  // append-only'. A scoped reset therefore cannot delete audit history even if asked to, which is the
  // behaviour we want: clearing a demonstration's business data should not erase the record that the
  // demonstration happened.
  //
  // Worth knowing, and recorded rather than smoothed over: a row trigger does not fire on TRUNCATE, so
  // the global reset path above *can* erase the audit chain. Append-only is therefore append-only for
  // the application role and for any DELETE, but not against a privileged operator using TRUNCATE.
  const SCOPED_PRESERVED = ['audit_events'];
  // The two lists must describe the same tables, or a scoped reset would silently leave rows behind.
  const missing = DEMO_TABLES.filter((table) => !SCOPED_DELETE_ORDER.includes(table));
  const extra = SCOPED_DELETE_ORDER.filter((table) => !DEMO_TABLES.includes(table));
  if (missing.length || extra.length) {
    return fail(`scoped delete order disagrees with DEMO_TABLES: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }

  await client.query('BEGIN');
  for (const table of SCOPED_DELETE_ORDER) {
    if (SCOPED_PRESERVED.includes(table)) continue;
    const hasTenant = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'`,
      [table],
    );
    if (!hasTenant.rowCount) continue;
    await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant.id]);
  }
  await client.query('COMMIT');
  // PostgreSQL cannot make one transaction span two independently authenticated sessions. Destructive work
  // commits first; only then may the maintenance principal truthfully record completion. A missing
  // maintenance URL is rejected before BEGIN, so normal operation never knowingly performs an unaudited reset.
  await recordResetEvent({
    tenantId: tenant.id, mode: 'scoped', clearedTables: SCOPED_DELETE_ORDER.length - SCOPED_PRESERVED.length, clearedRows: mine(before),
  });

  const after = await tenantCounts(client, DEMO_TABLES);
  const clearable = DEMO_TABLES.filter((table) => !SCOPED_PRESERVED.includes(table));
  const remaining = clearable.reduce((sum, table) => sum + ((after[table] || {})[tenant.id] || 0), 0);
  if (remaining !== 0) return fail(`domain data was not cleared for "${slug}": ${remaining} rows remain`);
  const preserved = SCOPED_PRESERVED.reduce((sum, table) => sum + ((after[table] || {})[tenant.id] || 0), 0);

  // The point of this mode: prove nothing else moved.
  const collateral = [];
  for (const table of DEMO_TABLES) {
    for (const [tenantId, count] of Object.entries(before[table] || {})) {
      if (tenantId === tenant.id) continue;
      const now = (after[table] || {})[tenantId] ?? 0;
      if (now !== count) collateral.push(`${table}[${tenantId === '_total' ? 'no tenant column' : tenantId}] ${count}→${now}`);
    }
  }
  if (collateral.length) return fail(`collateral damage to other tenants: ${collateral.join(', ')}`);

  const identities = await client.query('SELECT count(*)::int AS total FROM identities WHERE tenant_id=$1', [tenant.id]);
  if (identities.rows[0].total === 0) return fail('identities were destroyed; credentials cannot be reissued');
  const others = await client.query('SELECT count(*)::int AS total FROM tenants WHERE id<>$1', [tenant.id]);

  console.log(`DEMO_RESET_SCOPED_PASS tenant=${slug} cleared_rows=${mine(before) - preserved} audit_events_preserved=${preserved} identities_preserved=${identities.rows[0].total} other_tenants=${others.rows[0].total} collateral=none seed=${ACME_DATASET.seed} generator=${ACME_DATASET.generatorVersion} next=import-acme-dataset`);
  return null;
}

async function main() {
  if (!connectionString) return fail('no database URL: set OPENPPWR_DEMO_DATABASE_URL');
  if (!dryRun && !confirmed) return fail('refusing to modify data without OPENPPWR_DEMO_RESET_CONFIRM=yes');
  if (!dryRun && !maintenanceConnectionString) return fail('no maintenance database URL: set OPENPPWR_MAINTENANCE_DATABASE_URL');

  const dataset = validateAcmeDataset();
  if (!dataset.valid) return fail(`generator dataset is invalid: ${dataset.problems.join('; ')}`);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (scopedSlug) return await resetOneTenant(client, scopedSlug);
    const tenants = await client.query('SELECT id, slug FROM tenants ORDER BY slug');

    // Ambiguity is a stop condition, not something to resolve by picking one.
    if (tenants.rowCount === 0) return fail('no tenant exists; run the installer bootstrap first');
    if (tenants.rowCount > 1) {
      return fail(`refusing to act: ${tenants.rowCount} tenants present, so this is not an isolated demo database`);
    }
    const tenant = tenants.rows[0];
    if (tenant.slug !== expectedSlug) {
      return fail(`refusing to act: tenant slug is "${tenant.slug}", expected the demonstration tenant "${expectedSlug}"`);
    }

    const checksum = createHash('sha256').update(canonicalAcmeJson()).digest('hex');
    const before = await client.query('SELECT count(*)::int AS packaging FROM packaging');

    if (dryRun) {
      console.log(`DEMO_RESET_DRY_RUN tenant=${tenant.slug} tables=${DEMO_TABLES.length} packaging_now=${before.rows[0].packaging} seed=${ACME_DATASET.seed} generator=${ACME_DATASET.generatorVersion} dataset_sha256=${checksum}`);
      return null;
    }

    // Single transaction: a partially reset demo is worse than one that was never reset.
    //
    // audit_events is excluded deliberately, and migration 007 now enforces the exclusion with a
    // BEFORE TRUNCATE statement trigger. Until then this path had been erasing the audit chain on every
    // global reset: the row-level immutability trigger from migration 001 does not fire on TRUNCATE,
    // because there are no rows to iterate. Clearing a demonstration's business data must not erase the
    // record that the demonstration happened.
    const truncatable = DEMO_TABLES.filter((table) => !AUDIT_PRESERVED.includes(table));
    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${truncatable.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
    await recordResetEvent({
      tenantId: tenant.id, mode: 'global', clearedTables: truncatable.length, packagingBefore: before.rows[0].packaging,
    });

    const after = await client.query('SELECT count(*)::int AS packaging FROM packaging');
    const identities = await client.query('SELECT count(*)::int AS identities FROM identities');
    if (after.rows[0].packaging !== 0) return fail('domain data was not cleared');
    if (identities.rows[0].identities === 0) return fail('identities were destroyed; credentials cannot be reissued');

    console.log(`DEMO_RESET_PASS tenant=${tenant.slug} cleared_tables=${DEMO_TABLES.length} identities_preserved=${identities.rows[0].identities} seed=${ACME_DATASET.seed} schema=${ACME_DATASET.schemaVersion} generator=${ACME_DATASET.generatorVersion} dataset_sha256=${checksum} next=import-acme-dataset`);
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(error.message);
  } finally {
    await client.end();
  }
}

await main();
