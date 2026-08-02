// SPDX-License-Identifier: Apache-2.0
// A synthetic tenant sized to look like a producer that has actually used the product for a while, not
// like a demonstration fixture. `scripts/acme/acme-dataset.mjs` and `packages/testing/src/index.mjs` fix
// 32 packaging records because that count has to stay stable for the ACME checksum manifest and the public
// demonstration story. Nothing about that size was ever meant to answer "how does this scale" and it
// cannot: 32 records is too small to show a slope. This module is the reusable generator for the other
// question — one deployment's worth of packaging, suppliers, materials, components and, critically,
// operational *history* — so that question does not have to be re-derived by hand the next time it comes
// up.
//
// Two things are deliberately separate:
//   - `generateScaledCatalog` is pure and deterministic: the same size always produces the same rows, with
//     no randomness, clock or environment input, in the same spirit as the ACME generator.
//   - `provisionScaledTenant` is not pure: it writes the catalogue and then *operates the product on it* —
//     real imports through `executeImport`, real assessment runs through `runAssessments`, real gap
//     assignment and remediation through `assignGap`/`remediateGap` — because `freezeReviewSnapshot` and
//     `verifyAuditChain` scale with audit history, and history is not a column you can bulk-insert into
//     meaning it any other way without it meaning something different.
//
// Evidence is the one exception, and it is stated rather than hidden: `receiveEvidenceUpload` requires a
// live multipart HTTP request and a ClamAV scan pass, neither of which this module drives. The evidence
// rows below are written directly, with real bytes on disk at the storage key evidence rows are checked
// against, so `readVerifiedEvidence` and therefore `generateDossier` still succeed against them. What is
// skipped is the upload transport and the malware scan, not the row shape, the audit trail or the
// integrity check.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendAudit, tokenHash, withTenantTransaction } from '@openppwr/database';
import { assignGap, remediateGap, runAssessments } from '../../apps/api/src/assessment-service.mjs';
import { executeImport } from '../../apps/api/src/import-service.mjs';

const MATERIAL_FAMILIES = Object.freeze(['paper_fibre', 'glass', 'aluminium', 'steel', 'PET', 'PE', 'PP', 'wood', 'textile', 'composite']);
// Same proportions as the ACME fixture (12/6/6/4/4 out of 32), scaled to the requested size, so a reader
// who already knows the small fixture recognises the shape at a larger one.
const TYPE_PROPORTIONS = Object.freeze([['sales', 12], ['grouped', 6], ['transport', 6], ['ecommerce', 4], ['reusable', 4]]);
const COUNTRIES = Object.freeze(['DE', 'PL', 'FR', 'CZ']);
const ROLES = Object.freeze(['tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor', 'evidence_reviewer', 'read_only_auditor']);

function code(prefix, index) { return `SCALE-${prefix}-${String(index + 1).padStart(6, '0')}`; }

function typeSequence(count) {
  const base = TYPE_PROPORTIONS.reduce((sum, [, share]) => sum + share, 0);
  const counts = TYPE_PROPORTIONS.map(([type, share]) => [type, Math.round((share / base) * count)]);
  const assigned = counts.reduce((sum, [, n]) => sum + n, 0);
  // Rounding error goes to `sales`, the largest bucket, rather than left unassigned or given to a bucket
  // small enough to go negative.
  counts[0][1] += count - assigned;
  const sequence = [];
  for (const [type, n] of counts) for (let i = 0; i < n; i += 1) sequence.push(type);
  return sequence;
}

// Suppliers, materials and components deliberately do not scale linearly with packaging. A real packaging
// catalogue grows mostly by format and material variation reusing a comparatively stable supplier base and
// a comparatively stable set of raw materials and components — not by every new SKU bringing its own new
// supplier. Scaling all four in lock-step, the way naively multiplying the ACME ratios would, produces a
// tenant with an implausible number of one-off suppliers and materials. The divisors below are a stated
// choice, not a measurement: 1 supplier per 50 packaging records, 1 material per 50, 1 component per 7.5
// (components are reused across BOMs the way real closures, labels and liners are).
export function generateScaledCatalog({
  packagingCount,
  supplierCount = Math.max(4, Math.round(packagingCount / 50)),
  materialCount = Math.max(18, Math.round(packagingCount / 50)),
  componentCount = Math.max(40, Math.round(packagingCount / 7.5)),
  // Roughly one packaging record in twenty starts below the demonstration rule's minimum, so the tenant
  // carries a genuine gap-creation/assignment/remediation/reassessment history rather than a catalogue
  // that has never failed anything.
  failEveryNth = 20,
} = {}) {
  if (!Number.isInteger(packagingCount) || packagingCount < 1) throw new TypeError('packagingCount must be a positive integer.');
  const suppliers = Array.from({ length: supplierCount }, (_, i) => ({ id: code('SUP', i), name: `Synthetic Supplier ${i + 1}` }));
  const materials = Array.from({ length: materialCount }, (_, i) => ({
    id: code('MAT', i), name: `Synthetic material ${i + 1}`, family: MATERIAL_FAMILIES[i % MATERIAL_FAMILIES.length],
    recycledContentPct: i % 3 === 0 ? 35 : 45,
  }));
  const components = Array.from({ length: componentCount }, (_, i) => ({
    id: code('CMP', i), name: `Synthetic component ${i + 1}`,
    materialId: materials[i % materials.length].id, supplierId: suppliers[i % supplierCount].id,
    massG: Number((8.5 + (i % 50) * 0.75).toFixed(3)),
  }));
  const types = typeSequence(packagingCount);
  const packaging = Array.from({ length: packagingCount }, (_, i) => {
    const lineCount = (i % 10) < 7 ? 1 : (i % 10) < 9 ? 2 : 3;
    const lineComponentIds = new Set();
    for (let k = 0; lineComponentIds.size < lineCount; k += 1) lineComponentIds.add(components[(i * 7 + k * 13) % componentCount].id);
    return {
      id: code('PKG', i), name: `Synthetic packaging ${i + 1}`, packagingType: types[i], country: COUNTRIES[i % COUNTRIES.length],
      supplierId: suppliers[i % supplierCount].id,
      recycledContentPct: i % failEveryNth === 1 ? 5 : 40,
      bom: { id: code('BOM', i), version: 1, lines: [...lineComponentIds].map((componentId) => ({ componentId, quantity: 1, unit: 'piece' })) },
    };
  });
  return { suppliers, materials, components, packaging };
}

export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

export function scaledCatalogCounts(catalog) {
  return {
    suppliers: catalog.suppliers.length,
    materials: catalog.materials.length,
    components: catalog.components.length,
    packaging: catalog.packaging.length,
    bomLines: catalog.packaging.reduce((sum, item) => sum + item.bom.lines.length, 0),
    applicablePackaging: catalog.packaging.filter((item) => ['sales', 'grouped', 'reusable'].includes(item.packagingType)).length,
  };
}

async function createIdentities(admin, tenantId) {
  const identities = {};
  for (const role of ROLES) {
    const actorId = randomUUID();
    const token = `synthetic_${randomBytes(24).toString('base64url')}`;
    const credentialHash = tokenHash(token);
    await admin.query(
      `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash) VALUES ($1,$2,$3,$4,NULL,$5)`,
      [tenantId, actorId, `Synthetic ${role.replaceAll('_', ' ')}`, role, credentialHash],
    );
    identities[role] = { tenantId, actorId, credentialHash, token, role };
  }
  return identities;
}

// The same demonstration rule `scripts/acme/provision-synthetic-tenant.mjs` installs for a second ACME
// tenant: one required input, one required evidence type, applicable to sales/grouped/reusable packaging,
// a single "at least 30% recycled content" check. Reusing its exact shape means the assessment outcomes a
// reader already understands from the ACME demonstration carry over unchanged at any scale.
async function installDemoRule(admin, tenantId) {
  await admin.query(
    `INSERT INTO rule_versions (tenant_id,rule_id,version,source_reference,publication_date,effective_from,lifecycle_status,reviewer_status,required_inputs,required_evidence,applicability,checks,explanation_keys)
     VALUES ($1,'SCALE-DEMO-RC','1.0.0','Regulation (EU) 2025/40 demonstration subset; non-authoritative','2025-02-28','2025-01-01','draft','requires_human_regulatory_review',$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)`,
    [tenantId, JSON.stringify(['recycledContentPct']), JSON.stringify(['RECYCLED_CONTENT_DECLARATION']),
      JSON.stringify({ countries: [], packagingTypes: ['sales', 'grouped', 'reusable'] }),
      JSON.stringify([{ id: 'minimum-recycled-content', input: 'recycledContentPct', operator: 'gte', value: 30, explanationKey: 'assessment.recycled_content.minimum' }]),
      JSON.stringify(['assessment.recycled_content.minimum'])],
  );
}

// Real writes through the real import service, batched the way an operator actually imports: the full
// catalogue once, then packaging-only batches, because that is what onboarding followed by ongoing use
// looks like. Each batch is its own idempotency key and therefore its own `import.accepted` audit event —
// batches of `batchSize`, not one row at a time, because a tenant's real import history is made of import
// runs, not of one event per record.
async function importCatalog(pool, identity, catalog, { batchSize = 250 } = {}) {
  const batches = chunk(catalog.packaging, batchSize);
  for (const [index, batch] of batches.entries()) {
    const payload = {
      schemaVersion: '1.0',
      suppliers: index === 0 ? catalog.suppliers : [],
      materials: index === 0 ? catalog.materials : [],
      components: index === 0 ? catalog.components : [],
      packaging: batch,
    };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const result = await executeImport(pool, identity, { raw, contentType: 'application/json', idempotencyKey: `scale-import-${index}` });
    if (result.status === 'rejected') throw new Error(`Synthetic import batch ${index} was rejected: ${JSON.stringify(result.errors).slice(0, 500)}`);
  }
  return batches.length;
}

// One accepted evidence file per supplier for the demonstration rule's one required evidence type. The
// assessment query that matters (`assessment-service.mjs`) resolves evidence per supplier, not per
// packaging record, so this is the whole evidence surface every packaging record under that supplier
// needs — matching how the ACME fixture works today.
async function provisionEvidence(pool, identities, storageRoot, tenantId) {
  const quarantineDir = resolve(storageRoot, tenantId, 'quarantine');
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  const content = Buffer.from('Synthetic recycled-content declaration, generated for a scale measurement. Not a real document.\n', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const requirements = await withTenantTransaction(pool, identities.read_only_auditor, (client) => client.query(
    `SELECT DISTINCT ON (supplier_id) id, supplier_id, evidence_type FROM evidence_requirements ORDER BY supplier_id, id`,
  ));
  let count = 0;
  for (const requirement of requirements.rows) {
    const evidenceId = randomUUID();
    const storageKey = `${tenantId}/quarantine/${evidenceId}.txt`;
    await writeFile(resolve(storageRoot, storageKey), content, { mode: 0o600 });
    await withTenantTransaction(pool, identities.evidence_contributor, async (client) => {
      await client.query(
        `INSERT INTO evidence_files (tenant_id,id,requirement_id,supplier_id,evidence_type,version,original_filename,normalized_filename,declared_mime,detected_mime,size_bytes,sha256,storage_key,scan_status,review_status,uploaded_by)
         VALUES ($1,$2,$3,$4,$5,1,'declaration.txt','declaration.txt','text/plain','text/plain',$6,$7,$8,'clean','pending',$9)`,
        [tenantId, evidenceId, requirement.id, requirement.supplier_id, requirement.evidence_type, content.length, sha256, storageKey, identities.evidence_contributor.actorId],
      );
      await appendAudit(client, { action: 'evidence.quarantined', entityType: 'evidence', entityId: evidenceId, payload: { supplierId: requirement.supplier_id, sha256, sizeBytes: content.length } });
    });
    await withTenantTransaction(pool, identities.evidence_reviewer, async (client) => {
      await client.query(`UPDATE evidence_files SET review_status='accepted',reviewed_by=$1,reviewed_at=now() WHERE id=$2`, [identities.evidence_reviewer.actorId, evidenceId]);
      await appendAudit(client, { action: 'evidence.accepted', entityType: 'evidence', entityId: evidenceId, payload: { scanStatus: 'clean' } });
    });
    count += 1;
  }
  return count;
}

async function remediateOpenGaps(pool, identities) {
  const open = await withTenantTransaction(pool, identities.compliance_manager, (client) => client.query(`SELECT id FROM gaps WHERE status <> 'closed' ORDER BY id`));
  for (const gap of open.rows) {
    await assignGap(pool, identities.compliance_manager, { gapId: gap.id, ownerId: identities.compliance_manager.actorId });
    await remediateGap(pool, identities.compliance_manager, {
      gapId: gap.id, notes: 'Synthetic correction to a passing recycled-content value.', packagingPatch: { recycledContentPct: 40 },
    });
  }
  return open.rowCount;
}

// Orchestrates the whole lifecycle a real tenant would have gone through: onboarding import, evidence
// collection, a first assessment run that fails a small fraction of records, remediation of every failure,
// and further reassessment rounds standing in for ordinary periodic re-checks. Everything after the
// catalogue generation is a real write through real service code — `executeImport`, `runAssessments`,
// `assignGap`, `remediateGap` — so the resulting audit chain and review-readiness state are exactly what
// those functions would have produced for an actual deployment, not a hand-built imitation of one.
export async function provisionScaledTenant({
  admin, pool, storageRoot, packagingCount,
  tenantSlug = `scale-bench-${randomUUID().slice(0, 8)}`,
  reassessmentRounds = 2,
  catalogOverrides = {},
}) {
  const tenantId = randomUUID();
  await admin.query('INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,$3,$4)', [
    tenantId, tenantSlug, `Synthetic Scale Tenant ${tenantSlug} (fictional)`,
    'Synthetic tenant generated to measure database query and pool-checkout behaviour at representative scale. All data is fictional.',
  ]);
  const identities = await createIdentities(admin, tenantId);
  await installDemoRule(admin, tenantId);
  const catalog = generateScaledCatalog({ packagingCount, ...catalogOverrides });
  const importBatches = await importCatalog(pool, identities.packaging_editor, catalog);
  const evidenceCount = await provisionEvidence(pool, identities, storageRoot, tenantId);
  const rounds = [];
  rounds.push(await runAssessments(pool, identities.compliance_manager));
  const remediatedGaps = await remediateOpenGaps(pool, identities);
  for (let round = 1; round < reassessmentRounds; round += 1) rounds.push(await runAssessments(pool, identities.compliance_manager));
  const openGaps = await withTenantTransaction(pool, identities.compliance_manager, (client) => client.query(`SELECT count(*)::int AS open FROM gaps WHERE status <> 'closed'`));
  const auditCount = await withTenantTransaction(pool, identities.compliance_manager, (client) => client.query(`SELECT count(*)::int AS total FROM audit_events`));
  return {
    tenantId, tenantSlug, identities,
    catalogCounts: scaledCatalogCounts(catalog),
    importBatches, evidenceCount, remediatedGaps,
    assessmentRounds: rounds.length,
    assessmentOutcomes: rounds.map((round) => round.outcomes),
    openGapsRemaining: openGaps.rows[0].open,
    auditEventCount: auditCount.rows[0].total,
  };
}

// --- standalone CLI: node scripts/testing/synthetic-scale-tenant.mjs --packaging=3000 -----------------
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { createPool, migrate } = await import('@openppwr/database');
  const { startTestDatabase } = await import('./embedded-postgres.mjs');
  const { rm } = await import('node:fs/promises');
  const packagingArgument = process.argv.find((arg) => arg.startsWith('--packaging='));
  const packagingCount = packagingArgument ? Number(packagingArgument.split('=')[1]) : 3000;
  const storageRoot = resolve('.runtime-test', `synthetic-scale-${randomUUID()}`);
  let database;
  let pool;
  try {
    database = await startTestDatabase('synthetic-scale-tenant');
    await migrate(database.adminUrl);
    pool = createPool(database.runtimeUrl);
    const started = Date.now();
    const result = await provisionScaledTenant({ admin: database.admin, pool, storageRoot, packagingCount });
    console.log(`SYNTHETIC_SCALE_TENANT_PASS packagingCount=${packagingCount} tenantId=${result.tenantId} elapsedMs=${Date.now() - started}`);
    console.log(JSON.stringify(result.catalogCounts));
    console.log(`importBatches=${result.importBatches} evidenceCount=${result.evidenceCount} remediatedGaps=${result.remediatedGaps} assessmentRounds=${result.assessmentRounds} openGapsRemaining=${result.openGapsRemaining} auditEventCount=${result.auditEventCount}`);
  } finally {
    await pool?.end();
    await database?.stop();
    await rm(storageRoot, { recursive: true, force: true });
  }
}
