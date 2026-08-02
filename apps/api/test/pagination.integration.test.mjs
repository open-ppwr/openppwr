// GET /v1/assessments and GET /v1/gaps returned every row with no LIMIT until 2026-08-01. Measured
// against the representative synthetic tenant this repository already builds for database-deadline
// calibration (packages/database/src/index.mjs; scripts/testing/synthetic-scale-tenant.mjs), six
// reassessment rounds over 3 000 packaging records produced 18 000 assessment rows and 103 gap rows —
// real numbers that already exceed a single unpaginated page, which is why both routes take a real
// `limit`/`offset` rather than a fixed truncation with no way to reach the rest.
//
// This file proves the bound is real, not merely present in the SQL: a tenant with more rows than the
// requested limit gets back exactly the limit, never everything, and the rest is still reachable through
// `offset`. The extra rows are inserted directly through the admin connection rather than by running
// hundreds of real assessment cycles — the pagination contract does not care how the rows arrived, only
// that GET honours a bound over however many exist, and this keeps the file fast.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let server;
let baseUrl;
let identities;
let tenantId;
let packagingId;
let seedAssessmentId;
let supplierId;
const storageRoot = resolve('.runtime-test', `pagination-${randomUUID()}`);

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

function auth(role) {
  return { authorization: `Bearer ${identities[role].token}` };
}

before(async () => {
  database = await startTestDatabase('api-pagination');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  identities = created.body.identities;
  tenantId = created.body.tenantId;

  const imported = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { ...auth('packaging_editor'), 'content-type': 'application/json', 'idempotency-key': 'pagination-catalog' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201);

  // One real assessment run so a real packaging_id, rule_id/version and assessment_id exist to anchor the
  // bulk-inserted fixture rows to — a foreign key the schema actually enforces (assessments.packaging_id,
  // gaps.current_assessment_id), not one this test is free to fabricate.
  const ran = await jsonRequest('/v1/assessments/run', { method: 'POST', headers: { ...auth('compliance_manager'), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ran.response.status, 201);
  packagingId = ran.body.results[0].packagingId;
  seedAssessmentId = ran.body.results[0].assessmentId;

  // 600 more assessment rows: comfortably past the default page (100) and the maximum a caller may
  // request in one page (500), so both boundaries are exercised against the same fixture.
  await database.admin.query(
    `WITH inserted AS (
       INSERT INTO assessments (tenant_id,id,packaging_id,rule_id,rule_version,input_snapshot,evidence_snapshot,evaluated_by,evaluated_at)
       SELECT $1, gen_random_uuid(), $2, 'OPENPPWR-DEMO-RC', '1.0.0', '{}'::jsonb, '{}'::jsonb, $3, now() + (gs * interval '1 millisecond')
       FROM generate_series(1, 600) AS gs
       RETURNING tenant_id, id
     )
     INSERT INTO assessment_results (tenant_id,id,assessment_id,outcome,explanation,missing_inputs,missing_evidence,evidence_ids)
     SELECT tenant_id, gen_random_uuid(), id, 'PASS', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
     FROM inserted`,
    [tenantId, packagingId, identities.compliance_manager.id],
  );

  // 600 more gap rows, same reasoning.
  await database.admin.query(
    `INSERT INTO gaps (tenant_id,id,packaging_id,rule_id,rule_version,deduplication_key,current_assessment_id,status)
     SELECT $1, 'GAP-' || upper(substr(md5('pagination-fixture-' || gs::text), 1, 24)), $2, 'OPENPPWR-DEMO-RC', '1.0.0', 'pagination-fixture-' || gs, $3, 'open'
     FROM generate_series(1, 600) AS gs`,
    [tenantId, packagingId, seedAssessmentId],
  );

  // 250 more packaging rows, so the catalog exceeds one page the way a real tenant's does. The catalog
  // grows with the catalogue rather than with history, and it carried the opposite mistake to the two
  // routes above: not an unbounded read but a hard `LIMIT 100` written into each statement, with no
  // `offset` to reach past it and no `hasMore` to admit it had stopped.
  const supplier = await database.admin.query('SELECT id FROM suppliers WHERE tenant_id=$1 ORDER BY id LIMIT 1', [tenantId]);
  await database.admin.query(
    `INSERT INTO packaging (tenant_id,id,name,packaging_type,country,supplier_id,status)
     SELECT $1, 'PKG-PAGE-' || lpad(gs::text, 4, '0'), 'Pagination fixture ' || gs, 'sales', 'PL', $2, 'active'
     FROM generate_series(1, 250) AS gs`,
    [tenantId, supplier.rows[0].id],
  );

  // The two evidence collections. They returned every row with no LIMIT until 2026-08-01, and they grow
  // with the tenant's evidence rather than its catalogue: a requirement per packaging record per required
  // evidence type, and every upload against a requirement adds a version rather than replacing one.
  //
  // Both fixtures are attributed to the supplier the `supplier_user` identity belongs to, deliberately.
  // These are the two routes where a `WHERE supplier_id=$1` sits in front of the new `LIMIT $2 OFFSET $3`,
  // so the placeholder numbering has to shift with the filter — get that wrong and a supplier either sees
  // an error or sees somebody else's evidence. The scoped tests below are what prove it did not.
  supplierId = identities.supplier_user.supplierId;
  const supplierRow = await database.admin.query('SELECT id FROM suppliers WHERE tenant_id=$1 AND id=$2', [tenantId, supplierId]);
  assert.equal(supplierRow.rowCount, 1, 'the supplier identity must name a supplier this tenant actually has');
  await database.admin.query(
    `WITH requirement AS (
       INSERT INTO evidence_requirements (tenant_id,id,packaging_id,supplier_id,evidence_type,rule_id,rule_version,status)
       SELECT $1, gen_random_uuid(), 'PKG-PAGE-0001', $2, 'PAGINATION-FIXTURE-' || lpad(gs::text, 4, '0'), 'OPENPPWR-DEMO-RC', '1.0.0', 'required'
       FROM generate_series(1, 600) AS gs
       RETURNING tenant_id, id, supplier_id, evidence_type
     )
     INSERT INTO evidence_files (tenant_id,id,requirement_id,supplier_id,evidence_type,version,original_filename,normalized_filename,declared_mime,detected_mime,size_bytes,sha256,storage_key,scan_status,review_status,uploaded_by)
     SELECT tenant_id, gen_random_uuid(), id, supplier_id, evidence_type, 1,
            evidence_type || '.pdf', evidence_type || '.pdf', 'application/pdf', 'application/pdf', 1024,
            encode(sha256(evidence_type::bytea), 'hex'), 'pagination/' || evidence_type, 'clean', 'pending', $3
     FROM requirement`,
    [tenantId, supplierId, identities.evidence_contributor.id],
  );
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await database?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

test('GET /v1/assessments defaults to 100 rows and reports more remain', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM assessments WHERE tenant_id=$1', [tenantId]);
  assert.ok(totalRow.rows[0].n > 100, 'fixture must exceed the default page for this test to mean anything');

  const { response, body } = await jsonRequest('/v1/assessments', { headers: auth('compliance_manager') });
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 100, 'a caller who asked for no limit must still get exactly the default, not every row');
  assert.equal(body.limit, 100);
  assert.equal(body.offset, 0);
  assert.equal(body.hasMore, true);
});

test('GET /v1/assessments honours an explicit limit up to the maximum, and reports hasMore correctly at the boundary', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM assessments WHERE tenant_id=$1', [tenantId]);
  const total = totalRow.rows[0].n;
  assert.ok(total > 500, 'fixture must exceed the maximum page for this test to mean anything');

  const capped = await jsonRequest('/v1/assessments?limit=500', { headers: auth('compliance_manager') });
  assert.equal(capped.response.status, 200);
  assert.equal(capped.body.items.length, 500, 'the maximum page size is a hard ceiling, not a suggestion');
  assert.equal(capped.body.hasMore, true);

  const small = await jsonRequest('/v1/assessments?limit=50', { headers: auth('compliance_manager') });
  assert.equal(small.response.status, 200);
  assert.equal(small.body.items.length, 50);
  assert.equal(small.body.hasMore, true);
});

test('GET /v1/assessments offset reaches the rows a hard cap would have hidden', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM assessments WHERE tenant_id=$1', [tenantId]);
  const total = totalRow.rows[0].n;

  // Walk every page at the maximum size and confirm the pages union to exactly the real total, with no
  // row repeated and none skipped — the property a hard-cap-only design cannot offer at all.
  const seen = new Set();
  let offset = 0;
  let more = true;
  while (more) {
    const { response, body } = await jsonRequest(`/v1/assessments?limit=500&offset=${offset}`, { headers: auth('compliance_manager') });
    assert.equal(response.status, 200);
    for (const item of body.items) {
      assert.equal(seen.has(item.id), false, 'the same assessment id was returned on two different pages');
      seen.add(item.id);
    }
    more = body.hasMore;
    offset += body.items.length;
  }
  assert.equal(seen.size, total, 'paging to the end must surface every row a hard cap would have dropped');
});

test('GET /v1/gaps is bounded the same way, and the last page is reachable', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM gaps WHERE tenant_id=$1', [tenantId]);
  const total = totalRow.rows[0].n;
  assert.ok(total > 100, 'fixture must exceed the default page for this test to mean anything');

  const first = await jsonRequest('/v1/gaps', { headers: auth('compliance_manager') });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.hasMore, true);

  const last = await jsonRequest(`/v1/gaps?limit=500&offset=${total - 1}`, { headers: auth('compliance_manager') });
  assert.equal(last.response.status, 200);
  assert.equal(last.body.items.length, 1, 'exactly one row remains past every other page');
  assert.equal(last.body.hasMore, false);
});

test('an out-of-range or malformed limit/offset is refused rather than silently clamped', async () => {
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=abc']) {
    const { response, body } = await jsonRequest(`/v1/assessments?${query}`, { headers: auth('compliance_manager') });
    assert.equal(response.status, 400, `${query} should have been refused`);
    assert.equal(body.error.code, 'PAGINATION_INVALID');
  }
  const { response, body } = await jsonRequest('/v1/gaps?limit=99999', { headers: auth('compliance_manager') });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'PAGINATION_INVALID');
});

// GET /v1/catalog/:resource. Until now it answered `{items}` and nothing else, capped at 100 rows inside
// the SQL, while GET /v1/catalog/summary answered with an unbounded count(*) — so the two routes that the
// same screen renders side by side disagreed by design, and no field in either response admitted it.
test('GET /v1/catalog/:resource defaults to 100 rows and says the rest exist', async () => {
  const summary = await jsonRequest('/v1/catalog/summary', { headers: auth('compliance_manager') });
  assert.equal(summary.response.status, 200);
  assert.ok(summary.body.packaging > 100, 'fixture must exceed the default page for this test to mean anything');

  const { response, body } = await jsonRequest('/v1/catalog/packaging', { headers: auth('compliance_manager') });
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 100, 'a caller who asked for no limit must still get exactly the default');
  assert.equal(body.limit, 100);
  assert.equal(body.offset, 0);
  // The field the route did not return at all. Without it the summary tile said 480 and the table showed
  // 100, and nothing in the response could tell the interface that the difference existed.
  assert.equal(body.hasMore, true);
  assert.ok(summary.body.packaging > body.items.length, 'the summary count still exceeds one page — now stated, not hidden');
});

test('GET /v1/catalog/:resource reaches row 101 and every row after it', async () => {
  const summary = await jsonRequest('/v1/catalog/summary', { headers: auth('compliance_manager') });
  const total = summary.body.packaging;

  const past = await jsonRequest('/v1/catalog/packaging?limit=100&offset=100', { headers: auth('compliance_manager') });
  assert.equal(past.response.status, 200);
  assert.ok(past.body.items.length > 0, 'row 101 was unreachable by any request before this route took an offset');
  assert.equal(past.body.offset, 100);

  // Walk every page and confirm the pages union to exactly the count the summary reports, with no row
  // repeated and none skipped — the property a hard cap cannot offer at all.
  const seen = new Set();
  let offset = 0;
  let more = true;
  while (more) {
    const page = await jsonRequest(`/v1/catalog/packaging?limit=500&offset=${offset}`, { headers: auth('compliance_manager') });
    assert.equal(page.response.status, 200);
    for (const item of page.body.items) {
      assert.equal(seen.has(item.id), false, 'the same packaging id was returned on two different pages');
      seen.add(item.id);
    }
    more = page.body.hasMore;
    offset += page.body.items.length;
  }
  assert.equal(seen.size, total, 'paging to the end must surface exactly the number the summary tile displays');
});

test('every catalog resource answers with the same pagination envelope', async () => {
  for (const resource of ['packaging', 'materials', 'components', 'boms', 'suppliers']) {
    const { response, body } = await jsonRequest(`/v1/catalog/${resource}?limit=1&offset=0`, { headers: auth('compliance_manager') });
    assert.equal(response.status, 200, resource);
    assert.equal(body.limit, 1, resource);
    assert.equal(body.offset, 0, resource);
    assert.equal(typeof body.hasMore, 'boolean', `${resource} must state whether more rows exist`);
    assert.ok(body.items.length <= 1, `${resource} returned more rows than it was asked for`);
  }
});

test('an out-of-range or malformed catalog limit/offset is refused rather than silently clamped', async () => {
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=abc']) {
    const { response, body } = await jsonRequest(`/v1/catalog/packaging?${query}`, { headers: auth('compliance_manager') });
    assert.equal(response.status, 400, `${query} should have been refused`);
    assert.equal(body.error.code, 'PAGINATION_INVALID');
  }
  // An unknown resource stays a 404, decided before pagination is parsed, so the two refusals do not
  // become an oracle for which resource names exist.
  const unknown = await jsonRequest('/v1/catalog/not-a-resource?limit=0', { headers: auth('compliance_manager') });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, 'RESOURCE_NOT_FOUND');
});

// GET /v1/evidence-requirements and GET /v1/evidence. Both returned every row with no LIMIT at all until
// 2026-08-01 — not a hard cap that hid rows, but the opposite failure: a tenant with ten thousand evidence
// files received ten thousand, and the browser rendered all of them. The requirement collection additionally
// fills a `<select>`, which is why the workbench asks it for the maximum page in one request rather than
// the default (see SELECT_PAGE_SIZE in apps/web/src/paging.js): a dropdown that stops silently tells the
// user their requirement does not exist.
test('GET /v1/evidence-requirements defaults to 100 rows and reports more remain', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM evidence_requirements WHERE tenant_id=$1', [tenantId]);
  assert.ok(totalRow.rows[0].n > 100, 'fixture must exceed the default page for this test to mean anything');

  const { response, body } = await jsonRequest('/v1/evidence-requirements', { headers: auth('compliance_manager') });
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 100, 'a caller who asked for no limit must still get exactly the default, not every row');
  assert.equal(body.limit, 100);
  assert.equal(body.offset, 0);
  assert.equal(body.hasMore, true);
});

test('the requirement page the selector asks for is served, and offset reaches the rest', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM evidence_requirements WHERE tenant_id=$1', [tenantId]);
  const total = totalRow.rows[0].n;
  assert.ok(total > 500, 'fixture must exceed the maximum page for this test to mean anything');

  const first = await jsonRequest('/v1/evidence-requirements?limit=500', { headers: auth('compliance_manager') });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.items.length, 500, 'the page the workbench selector requests must be served in full');
  assert.equal(first.body.hasMore, true, 'and it must admit when it did not fit');

  const seen = new Set();
  let offset = 0;
  let more = true;
  while (more) {
    const { response, body } = await jsonRequest(`/v1/evidence-requirements?limit=500&offset=${offset}`, { headers: auth('compliance_manager') });
    assert.equal(response.status, 200);
    for (const item of body.items) {
      assert.equal(seen.has(item.id), false, 'the same requirement was returned on two different pages');
      seen.add(item.id);
    }
    more = body.hasMore;
    offset += body.items.length;
  }
  assert.equal(seen.size, total, 'a requirement reachable by no page at all is a requirement the user cannot upload against');
});

test('GET /v1/evidence is bounded the same way, and the last page is reachable', async () => {
  const totalRow = await database.admin.query('SELECT count(*)::int AS n FROM evidence_files WHERE tenant_id=$1', [tenantId]);
  const total = totalRow.rows[0].n;
  assert.ok(total > 100, 'fixture must exceed the default page for this test to mean anything');

  const first = await jsonRequest('/v1/evidence', { headers: auth('evidence_reviewer') });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.limit, 100);
  assert.equal(first.body.hasMore, true);

  const last = await jsonRequest(`/v1/evidence?limit=500&offset=${total - 1}`, { headers: auth('evidence_reviewer') });
  assert.equal(last.response.status, 200);
  assert.equal(last.body.items.length, 1, 'exactly one row remains past every other page');
  assert.equal(last.body.hasMore, false);
});

// The supplier filter and the new bound share a parameter list, and the filter is bound first. This is
// where a placeholder off by one would land: `read-own` is the narrowest grant in the product, and a
// supplier reading another supplier's evidence is the isolation defect these two routes had always
// avoided while the assessment and gap routes did not.
test('supplier scoping survives pagination on both evidence collections', async () => {
  for (const path of ['/v1/evidence-requirements', '/v1/evidence']) {
    const { response, body } = await jsonRequest(path, { headers: auth('supplier_user') });
    assert.equal(response.status, 200, path);
    assert.equal(body.items.length, 100, `${path} must bound a supplier's own page too`);
    assert.equal(body.hasMore, true, path);
    for (const item of body.items) assert.equal(item.supplier_id, supplierId, `${path} returned another supplier's row`);

    // And the page past the first is still scoped: a filter applied only to the first page would be a
    // filter that pagination walks straight past.
    const second = await jsonRequest(`${path}?limit=500&offset=100`, { headers: auth('supplier_user') });
    assert.equal(second.response.status, 200, path);
    assert.ok(second.body.items.length > 0, `${path} offset reached nothing`);
    for (const item of second.body.items) assert.equal(item.supplier_id, supplierId, `${path} leaked another supplier's row on page two`);
  }
});

test('an out-of-range or malformed evidence limit/offset is refused rather than silently clamped', async () => {
  for (const path of ['/v1/evidence-requirements', '/v1/evidence']) {
    for (const query of ['limit=0', 'limit=501', 'limit=abc', 'offset=-1']) {
      const { response, body } = await jsonRequest(`${path}?${query}`, { headers: auth('compliance_manager') });
      assert.equal(response.status, 400, `${path}?${query} should have been refused`);
      assert.equal(body.error.code, 'PAGINATION_INVALID');
    }
  }
});
