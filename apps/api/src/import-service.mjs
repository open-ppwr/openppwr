import { createHash, randomUUID } from 'node:crypto';
import { appendAudit, withTenantTransaction } from '@openppwr/database';

const supportedTypes = new Set(['sales','grouped','transport','ecommerce','reusable']);
const supportedSchema = '1.0';

// Leading `#` lines are skipped before the header is read.
//
// Not a convenience: without this the product rejected its own sample files. Every CSV this repository
// publishes for operators to import \u2014 the valid set, the supplemental set and the deliberately invalid set \u2014
// is written with `# FICTIONAL ACME SAMPLE \u2014 NOT A REAL COMPLIANCE DOCUMENT` as its first line, so that a
// copy of one found loose on a disk identifies itself as fiction rather than being mistaken for a real
// compliance record. That marker is worth keeping. Reading it as the header row was not: a first-time
// evaluator following the walkthrough downloaded the sample they were told to import and got
// `IMPORT_CSV_HEADER_INVALID` from a file this project generated, exported and shipped itself.
//
// The tests never caught it because they import `createAcmeSupplementalCsv()` \u2014 the generator's return
// value, which has no marker \u2014 while what an operator actually receives is the *exported file*, which does.
// The two had drifted apart and nothing compared them.
//
// Skipping rather than tolerating anywhere: a `#` line is only special before the header. After it, a row
// whose first field begins with `#` is data, and treating it as a comment would silently drop a record.
function parseCsv(text) {
  const allLines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const firstDataLine = allLines.findIndex((line) => !line.startsWith('#'));
  const lines = firstDataLine === -1 ? [] : allLines.slice(firstDataLine);
  if (lines.length < 2) throw Object.assign(new Error('CSV contains no rows.'), { code: 'IMPORT_CSV_EMPTY', status: 422 });
  const expected = ['id','name','packagingType','country','supplierId','recycledContentPct','bomId','bomVersion','componentIds'];
  const headers = lines[0].split(',').map((item) => item.trim());
  if (JSON.stringify(headers) !== JSON.stringify(expected)) throw Object.assign(new Error('CSV header does not match schema 1.0.'), { code: 'IMPORT_CSV_HEADER_INVALID', status: 422 });
  return {
    schemaVersion: supportedSchema,
    suppliers: [], materials: [], components: [],
    packaging: lines.slice(1).map((line) => {
      const values = line.split(',').map((item) => item.trim());
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      return {
        id: row.id,
        name: row.name,
        packagingType: row.packagingType,
        country: row.country,
        supplierId: row.supplierId,
        recycledContentPct: row.recycledContentPct === '' ? null : Number(row.recycledContentPct),
        bom: { id: row.bomId, version: Number(row.bomVersion), lines: row.componentIds.split('|').filter(Boolean).map((componentId) => ({ componentId, quantity: 1, unit: 'piece' })) },
      };
    }),
  };
}

// Exported so a test can assert against the sample files this project actually publishes, rather than
// against the generator that feeds them. That distinction is the whole reason the published CSVs could be
// un-importable while every import test passed.
export function parseImportPayload(raw, contentType) {
  return parsePayload(contentType, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'));
}

function parsePayload(contentType, raw) {
  if (contentType.startsWith('text/csv')) return parseCsv(raw.toString('utf8'));
  if (!contentType.startsWith('application/json')) throw Object.assign(new Error('Only JSON and CSV imports are supported.'), { code: 'IMPORT_CONTENT_TYPE_UNSUPPORTED', status: 415 });
  try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('JSON is malformed.'), { code: 'IMPORT_JSON_INVALID', status: 422 }); }
}

function error(code, field) { return { code, field }; }

async function validatePayload(client, payload) {
  const existing = await Promise.all([
    client.query('SELECT id FROM suppliers'),
    client.query('SELECT id FROM materials'),
    client.query('SELECT id FROM components'),
  ]);
  const supplierIds = new Set([...existing[0].rows.map((row) => row.id), ...(payload.suppliers || []).map((item) => item.id)]);
  const materialIds = new Set([...existing[1].rows.map((row) => row.id), ...(payload.materials || []).map((item) => item.id)]);
  const componentIds = new Set([...existing[2].rows.map((row) => row.id), ...(payload.components || []).map((item) => item.id)]);
  const catalogErrors = [];
  for (const item of payload.suppliers || []) if (!item.id || !item.name) catalogErrors.push(error('SUPPLIER_INVALID', 'suppliers'));
  for (const item of payload.materials || []) if (!item.id || !item.name || !item.family) catalogErrors.push(error('MATERIAL_INVALID', 'materials'));
  for (const item of payload.components || []) {
    if (!item.id || !item.name || !(Number(item.massG) > 0)) catalogErrors.push(error('COMPONENT_MASS_INVALID', 'components'));
    if (!materialIds.has(item.materialId)) catalogErrors.push(error('COMPONENT_MATERIAL_UNKNOWN', 'components.materialId'));
    if (!supplierIds.has(item.supplierId)) catalogErrors.push(error('COMPONENT_SUPPLIER_UNKNOWN', 'components.supplierId'));
  }
  const rows = Array.isArray(payload.packaging) ? payload.packaging : [];
  const counts = new Map();
  rows.forEach((row) => counts.set(row.id, (counts.get(row.id) || 0) + 1));
  const rowResults = rows.map((row, index) => {
    const errors = [...catalogErrors];
    if (payload.schemaVersion !== supportedSchema) errors.push(error('SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion'));
    if (!row.id) errors.push(error('PACKAGING_ID_REQUIRED', 'id'));
    if (row.id && counts.get(row.id) > 1) errors.push(error('PACKAGING_ID_DUPLICATE', 'id'));
    if (!row.name) errors.push(error('PACKAGING_NAME_REQUIRED', 'name'));
    if (!supportedTypes.has(row.packagingType)) errors.push(error('PACKAGING_TYPE_INVALID', 'packagingType'));
    if (!/^[A-Z]{2}$/.test(row.country || '')) errors.push(error('COUNTRY_INVALID', 'country'));
    if (!supplierIds.has(row.supplierId)) errors.push(error('SUPPLIER_UNKNOWN', 'supplierId'));
    if (row.recycledContentPct !== null && row.recycledContentPct !== undefined && !(Number(row.recycledContentPct) >= 0 && Number(row.recycledContentPct) <= 100)) errors.push(error('RECYCLED_CONTENT_INVALID', 'recycledContentPct'));
    if (!row.bom?.id || !Number.isInteger(Number(row.bom?.version)) || !Array.isArray(row.bom?.lines) || !row.bom.lines.length) errors.push(error('BOM_INVALID', 'bom'));
    for (const line of row.bom?.lines || []) {
      if (!componentIds.has(line.componentId)) errors.push(error('BOM_COMPONENT_UNKNOWN', 'bom.lines.componentId'));
      if (!(Number(line.quantity) > 0)) errors.push(error('BOM_QUANTITY_INVALID', 'bom.lines.quantity'));
      if (line.unit !== 'piece') errors.push(error('BOM_UNIT_INVALID', 'bom.lines.unit'));
    }
    return { rowNumber: index + 1, errors };
  });
  if (!rows.length) rowResults.push({ rowNumber: 0, errors: [error('PACKAGING_ROWS_REQUIRED', 'packaging')] });
  return rowResults;
}

async function insertCatalog(client, tenantId, payload) {
  for (const item of payload.suppliers || []) await client.query('INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,id) DO NOTHING', [tenantId,item.id,item.name]);
  for (const item of payload.materials || []) await client.query('INSERT INTO materials (tenant_id,id,name,family,recycled_content_pct) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,id) DO NOTHING', [tenantId,item.id,item.name,item.family,item.recycledContentPct]);
  for (const item of payload.components || []) await client.query('INSERT INTO components (tenant_id,id,name,material_id,supplier_id,mass_g) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,id) DO NOTHING', [tenantId,item.id,item.name,item.materialId,item.supplierId,item.massG]);
}

// The catalogue inserts above are `ON CONFLICT DO NOTHING`, so re-importing a supplier or a material is a
// no-op. Packaging, BOMs and BOM lines deliberately are not, and must not be: silently ignoring a
// re-imported packaging record would report success while discarding whatever the operator had corrected,
// which is the worse of the two failures.
//
// But raising the driver's own `23505` is not an answer either. `app.mjs` classifies anything it did not
// raise deliberately as `INTERNAL_ERROR` with a 500 — correctly, so that PostgreSQL's vocabulary never
// reaches a caller — so a re-import surfaced in the browser as "The service could not complete the request.
// Retry shortly", which is advice that can never work: the retry fails identically, for ever. The operator
// is told to wait when what they need to be told is which record already exists.
//
// So it becomes a deliberate 409 naming the record. That is honest about what happened and, until update
// and delete routes exist, it is also the whole story: this beta cannot correct a catalogue record, and an
// error that says so is better than one that implies the problem is transient.
async function insertUnique(client, description, id, text, values) {
  try {
    await client.query(text, values);
  } catch (error) {
    if (error?.code !== '23505') throw error;
    throw Object.assign(new Error(`${description} ${id} already exists in this tenant.`), {
      code: 'IMPORT_RECORD_EXISTS',
      status: 409,
      conflict: { entity: description, id },
    });
  }
}

async function insertPackaging(client, tenantId, payload) {
  const rule = await client.query(`SELECT rule_id, version, required_evidence, applicability FROM rule_versions WHERE lifecycle_status IN ('draft','approved') ORDER BY effective_from DESC LIMIT 1`);
  for (const row of payload.packaging) {
    await insertUnique(client, 'packaging', row.id, `INSERT INTO packaging (tenant_id,id,name,packaging_type,country,supplier_id,recycled_content_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId,row.id,row.name,row.packagingType,row.country,row.supplierId,row.recycledContentPct]);
    await insertUnique(client, 'bill of materials', row.bom.id, `INSERT INTO boms (tenant_id,id,packaging_id,version,status) VALUES ($1,$2,$3,$4,'approved')`, [tenantId,row.bom.id,row.id,row.bom.version]);
    for (const line of row.bom.lines) await client.query(`INSERT INTO bom_lines (tenant_id,id,bom_id,component_id,quantity) VALUES ($1,$2,$3,$4,$5)`, [tenantId,randomUUID(),row.bom.id,line.componentId,line.quantity]);
    if (rule.rowCount) {
      const selected = rule.rows[0];
      const types = selected.applicability?.packagingTypes || [];
      if (!types.length || types.includes(row.packagingType)) {
        for (const evidenceType of selected.required_evidence) await client.query(
          `INSERT INTO evidence_requirements (tenant_id,id,packaging_id,supplier_id,evidence_type,rule_id,rule_version) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [tenantId,randomUUID(),row.id,row.supplierId,evidenceType,selected.rule_id,selected.version],
        );
      }
    }
  }
}

export async function executeImport(pool, identity, { raw, contentType, idempotencyKey, now = new Date() }) {
  if (!idempotencyKey || idempotencyKey.length > 128) throw Object.assign(new Error('A valid Idempotency-Key is required.'), { code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400 });
  const payload = parsePayload(contentType, raw);
  const checksum = createHash('sha256').update(raw).digest('hex');
  return withTenantTransaction(pool, identity, async (client) => {
    const prior = await client.query('SELECT * FROM import_runs WHERE idempotency_key=$1', [idempotencyKey]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum) throw Object.assign(new Error('Idempotency key content conflict.'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      return { ...prior.rows[0], replayed: true };
    }
    const rows = await validatePayload(client, payload);
    const rejected = rows.filter((row) => row.errors.length);
    const importId = randomUUID();
    const createdAt = now.toISOString();
    await client.query(
      `INSERT INTO import_runs (tenant_id,id,idempotency_key,checksum,schema_version,status,total_rows,accepted_rows,rejected_rows,errors,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [identity.tenantId,importId,idempotencyKey,checksum,String(payload.schemaVersion || ''),rejected.length ? 'rejected' : 'accepted',rows.length,rejected.length ? 0 : rows.length,rejected.length,JSON.stringify(rejected),identity.actorId,createdAt],
    );
    for (const row of rows) await client.query(
      `INSERT INTO import_row_results (tenant_id,id,import_id,row_number,status,errors) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [identity.tenantId,randomUUID(),importId,row.rowNumber,row.errors.length ? 'rejected' : 'accepted',JSON.stringify(row.errors)],
    );
    if (!rejected.length) {
      await insertCatalog(client, identity.tenantId, payload);
      await insertPackaging(client, identity.tenantId, payload);
    }
    await appendAudit(client, { tenantId: identity.tenantId, actorId: identity.actorId, action: rejected.length ? 'import.rejected' : 'import.accepted', entityType: 'import_run', entityId: importId, payload: { checksum, totalRows: rows.length, rejectedRows: rejected.length }, occurredAt: createdAt });
    return { id: importId, status: rejected.length ? 'rejected' : 'accepted', totalRows: rows.length, acceptedRows: rejected.length ? 0 : rows.length, rejectedRows: rejected.length, errors: rejected, replayed: false };
  });
}

