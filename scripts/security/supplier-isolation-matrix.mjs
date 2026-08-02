// SPDX-License-Identifier: Apache-2.0
//
// Supplier isolation inside one tenant — the complete resource and operation matrix.
//
// Why this exists as its own gate. Every isolation test in this programme asked the *cross-tenant*
// question, and none asked whether one supplier can see another **inside** one tenant. The answer was that
// it could: `/v1/assessments` and `/v1/gaps` accepted `read-own` and then returned
// every row in the tenant. Tenant isolation had never been affected; supplier isolation was simply absent
// on those two routes, while the requirement and evidence collections had always filtered correctly.
//
// The first regression test for that fix compared collection sizes: a supplier must see strictly fewer
// assessments than a compliance manager. That is a real assertion and it fails if scoping is removed — but
// it is a count, and a count cannot tell a *missing* row from a *refused* one. This gate replaces it with
// direct attempts, and the identifiers it attempts with are **read from the database**, so every probe uses
// a value that genuinely belongs to the other supplier. A guessed identifier proves only that an absent
// value is absent.
//
// Positive controls are as important as the refusals. Roles that are *meant* to see both suppliers are
// checked too, because a product that returned nothing to everybody would pass a suite made only of
// refusals.
//
//   node scripts/security/supplier-isolation-matrix.mjs

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boundedStep, closeServer, endPool } from '../testing/bounded-teardown.mjs';

process.env.NODE_ENV = 'test';

const { createPool, migrate, tokenHash } = await import('@openppwr/database');
const { createAcmeValidJsonImport } = await import('@openppwr/testing');
const { VerdictStubScanner, processNextScanJob } = await import('@openppwr/worker');
const { createApp, createVerifiedContext } = await import('../../apps/api/src/app.mjs');
const { startTestDatabase } = await import('../testing/embedded-postgres.mjs');

const SUPPLIER_A = 'ACME-SUP-001';
const SUPPLIER_B = 'ACME-SUP-002';
const outputRoot = resolve('artifacts', 'security');

const checks = [];
const failures = [];

function record(name, detail, passed) {
  checks.push({ name, detail, passed });
  if (!passed) failures.push(`${name} — ${detail}`);
}

// Every refusal must be the same refusal. A different status or code for "malformed", "not yours" and
// "does not exist" is an oracle, and the whole authorization model here is 404-everywhere.
function expectRefused(name, response, body) {
  const refused = response.status === 404 && body?.error?.code === 'RESOURCE_NOT_FOUND';
  record(name, refused ? 'refused 404 RESOURCE_NOT_FOUND' : `expected 404 RESOURCE_NOT_FOUND, got ${response.status} ${JSON.stringify(body)}`, refused);
}

function expectAbsent(name, items, identifier, key = 'id') {
  const present = items.some((item) => item[key] === identifier);
  record(name, present ? `${identifier} was returned and must not have been` : `${identifier} absent from ${items.length} rows`, !present);
}

function expectPresent(name, items, identifier, key = 'id') {
  const present = items.some((item) => item[key] === identifier);
  record(name, present ? `${identifier} present among ${items.length} rows` : `${identifier} missing — the positive control failed, so the refusals above prove nothing`, present);
}

let database;
let pool;
let workerPool;
let server;
let baseUrl;
// This gate's own try/finally had no catch: an exception thrown anywhere in the matrix — before any
// check had failed — unwound straight to `finally`, which unconditionally called `process.exit(failures.length
// ? 1 : 0)`. With `failures` still empty, that discarded the exception and exited 0, having tested nothing
// and printed nothing to say so. That is exactly what happened when this gate's worker-role pool was wired
// wrong (see the `workerPool` comment above): the gate "passed" while running zero of its 55 checks.
let crashed = null;

try {
  database = await startTestDatabase('supplier-isolation');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // The worker's own principal, not the API's. `openppwr_app` (the role behind `pool`, above) was never
  // granted SELECT on `scan_jobs` — migration 022 grants that to `openppwr_worker` alone, by design, the
  // same separation apps/api/test/evidence.integration.test.mjs already keeps with its own `workerPool`.
  // Scanning evidence to a clean state through the API's pool doesn't fail loudly: it throws
  // "permission denied for table scan_jobs" from inside processNextScanJob, before this gate has recorded
  // a single check, and the top-level try/finally below has no catch — so that exception was being
  // discarded by the unconditional process.exit() in `finally` and the gate exited 0 having tested nothing.
  workerPool = createPool(database.workerUrl);
  const bootstrapToken = randomUUID();
  const storageRoot = resolve('.runtime-test', `supplier-isolation-${randomUUID()}`);
  const app = createApp({ pool, bootstrapToken, storageRoot });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', token, body, contentType = 'application/json', idempotencyKey } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (body && !(body instanceof FormData)) headers['content-type'] = contentType;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body instanceof FormData ? body : body });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { response, body: parsed };
  };

  const bootstrapped = await call('/v1/bootstrap', {
    method: 'POST',
    token: undefined,
    body: '{}',
  });
  // The bootstrap token is a header, not a bearer credential.
  const created = bootstrapped.response.status === 201 ? bootstrapped : await (async () => {
    const response = await fetch(`${baseUrl}/v1/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapToken },
      body: '{}',
    });
    return { response, body: await response.json() };
  })();
  assert.equal(created.response.status, 201, `bootstrap failed: ${JSON.stringify(created.body)}`);
  const identities = created.body.identities;
  const tenantId = created.body.tenantId;

  const imported = await call('/v1/imports', {
    method: 'POST',
    token: identities.packaging_editor.token,
    idempotencyKey: 'supplier-isolation-catalog',
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201, `import failed: ${JSON.stringify(imported.body)}`);

  // A second supplier identity. Bootstrap mints one per role, so the product ships with exactly one
  // supplier credential and the same-tenant question cannot be asked without a second one. Inserted as the
  // administrative role, which is how an operator would add a supplier user.
  const supplierBToken = `opp_test_${randomBytes(24).toString('base64url')}`;
  const supplierBId = randomUUID();
  await database.admin.query(
    `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash) VALUES ($1,$2,$3,'supplier_user',$4,$5)`,
    [tenantId, supplierBId, `ACME supplier ${SUPPLIER_B}`, SUPPLIER_B, tokenHash(supplierBToken)],
  );
  const supplierA = { token: identities.supplier_user.token, supplierId: SUPPLIER_A };
  const supplierB = { token: supplierBToken, supplierId: SUPPLIER_B };
  assert.equal(identities.supplier_user.supplierId, SUPPLIER_A, 'the bootstrap supplier identity is no longer ACME-SUP-001; revisit this gate');

  // Requirements, read as the administrator so the full set is visible.
  const allRequirements = (await call('/v1/evidence-requirements', { token: identities.tenant_admin.token })).body.items;
  const requirementsA = allRequirements.filter((item) => item.supplier_id === SUPPLIER_A);
  const requirementsB = allRequirements.filter((item) => item.supplier_id === SUPPLIER_B);
  assert.ok(requirementsA.length && requirementsB.length, `both suppliers need requirements: A=${requirementsA.length} B=${requirementsB.length}`);

  // Each supplier uploads one piece of evidence for its own requirement, so there is a real foreign object
  // to attempt rather than a hypothetical one.
  const uploadFor = async (supplier, requirement) => {
    const form = new FormData();
    form.set('requirementId', requirement.id);
    form.set('supplierId', requirement.supplier_id);
    form.set('evidenceType', requirement.evidence_type);
    form.set('file', new Blob([Buffer.from(`%PDF-1.4\n${requirement.supplier_id} declaration\n`)], { type: 'application/pdf' }), 'declaration.pdf');
    const result = await call('/v1/evidence', { method: 'POST', token: supplier.token, body: form });
    assert.equal(result.response.status, 202, `upload failed for ${requirement.supplier_id}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const evidenceA = await uploadFor(supplierA, requirementsA[0]);
  const evidenceB = await uploadFor(supplierB, requirementsB[0]);

  // Scan both to clean, so download is a genuine authorization decision rather than a refusal for being
  // unscanned. `evidencePathForDownload` refuses anything not clean, which would mask the boundary.
  const worker = await createVerifiedContext(pool, identities.worker.token);
  const scanner = new VerdictStubScanner({ runtime: 'test' });
  for (let index = 0; index < 8; index += 1) {
    const processed = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner, now: new Date(Date.now() + index * 2_000_000) });
    if (!processed) break;
  }
  const scanned = await database.admin.query('SELECT id,scan_status FROM evidence_files WHERE id = ANY($1::uuid[])', [[evidenceA.id, evidenceB.id]]);
  for (const row of scanned.rows) assert.equal(row.scan_status, 'clean', `evidence ${row.id} is ${row.scan_status}, so the download probe would be meaningless`);

  // Assessments and gaps, produced by the workflow rather than inserted, so the rows are the ones the
  // product actually creates.
  const assessed = await call('/v1/assessments/run', { method: 'POST', token: identities.compliance_manager.token, body: JSON.stringify({}) });
  assert.equal(assessed.response.status, 201, `assessment run failed: ${JSON.stringify(assessed.body)}`);

  // Which packaging records belong to which supplier — the same definition the API uses for `read-own`.
  const packagingOf = async (supplierId) => {
    const result = await database.admin.query('SELECT DISTINCT packaging_id FROM evidence_requirements WHERE tenant_id=$1 AND supplier_id=$2', [tenantId, supplierId]);
    return new Set(result.rows.map((row) => row.packaging_id));
  };
  const packagingA = await packagingOf(SUPPLIER_A);
  const packagingB = await packagingOf(SUPPLIER_B);
  const exclusiveB = [...packagingB].filter((id) => !packagingA.has(id));
  assert.ok(exclusiveB.length, 'supplier B must hold packaging that supplier A does not, or there is no boundary to test');

  const foreignAssessment = (await database.admin.query(
    'SELECT id,packaging_id FROM assessments WHERE tenant_id=$1 AND packaging_id = ANY($2::text[]) LIMIT 1',
    [tenantId, exclusiveB],
  )).rows[0];
  assert.ok(foreignAssessment, 'no assessment exists on packaging exclusive to supplier B');

  const foreignGap = (await database.admin.query(
    'SELECT id,packaging_id FROM gaps WHERE tenant_id=$1 AND packaging_id = ANY($2::text[]) LIMIT 1',
    [tenantId, exclusiveB],
  )).rows[0] || (await database.admin.query('SELECT id,packaging_id FROM gaps WHERE tenant_id=$1 LIMIT 1', [tenantId])).rows[0];

  // ------------------------------------------------------------------------------------------------
  // The matrix
  // ------------------------------------------------------------------------------------------------

  // 1. list — every collection a supplier may read must contain only its own rows.
  for (const [path, key] of [['/v1/evidence-requirements', 'supplier_id'], ['/v1/evidence', 'supplier_id']]) {
    const listed = await call(path, { token: supplierA.token });
    record(`list ${path} as supplier A returns 200`, `status ${listed.response.status}`, listed.response.status === 200);
    const foreign = listed.body.items.filter((item) => item[key] !== SUPPLIER_A);
    record(
      `list ${path} contains no other supplier's rows`,
      foreign.length ? `${foreign.length} foreign rows: ${[...new Set(foreign.map((item) => item[key]))].join(', ')}` : `${listed.body.items.length} rows, all ${SUPPLIER_A}`,
      foreign.length === 0,
    );
    expectAbsent(`list ${path} excludes the other supplier's known identifier`, listed.body.items, path === '/v1/evidence' ? evidenceB.id : requirementsB[0].id);
  }

  // 2. list, scoped by derivation — assessments and gaps have no supplier column, so "own" is defined by
  // the packaging the supplier holds a requirement for. This is exactly where the leak lived.
  for (const path of ['/v1/assessments', '/v1/gaps']) {
    const listed = await call(path, { token: supplierA.token });
    record(`list ${path} as supplier A returns 200`, `status ${listed.response.status}`, listed.response.status === 200);
    const outside = listed.body.items.filter((item) => !packagingA.has(item.packaging_id));
    record(
      `list ${path} contains no row outside the supplier's own packaging`,
      outside.length ? `${outside.length} rows on foreign packaging: ${[...new Set(outside.map((item) => item.packaging_id))].slice(0, 5).join(', ')}` : `${listed.body.items.length} rows, all on own packaging`,
      outside.length === 0,
    );
  }
  expectAbsent('assessments exclude the other supplier\'s known assessment', (await call('/v1/assessments', { token: supplierA.token })).body.items, foreignAssessment.id);
  if (foreignGap && !packagingA.has(foreignGap.packaging_id)) {
    expectAbsent('gaps exclude the other supplier\'s known gap', (await call('/v1/gaps', { token: supplierA.token })).body.items, foreignGap.id);
  }

  // 3. get by known foreign identifier — download is the only supplier-reachable per-object route.
  {
    const own = await call(`/v1/evidence/${evidenceA.id}/download`, { token: supplierA.token });
    record('supplier A downloads its own evidence', `status ${own.response.status}`, own.response.status === 200);
    const foreign = await call(`/v1/evidence/${evidenceB.id}/download`, { token: supplierA.token });
    expectRefused('supplier A cannot download supplier B evidence by its real identifier', foreign.response, foreign.body);
    const reverse = await call(`/v1/evidence/${evidenceA.id}/download`, { token: supplierB.token });
    expectRefused('supplier B cannot download supplier A evidence by its real identifier', reverse.response, reverse.body);
    // Both directions, and both with correct identifiers. A refusal that only holds one way is a filter
    // written for one case.
    const absent = await call(`/v1/evidence/${randomUUID()}/download`, { token: supplierA.token });
    expectRefused('an identifier that exists for nobody is refused identically', absent.response, absent.body);
  }

  // 4. submit — uploading against another supplier's requirement, in both spellings an attacker would try.
  {
    const asForeign = new FormData();
    asForeign.set('requirementId', requirementsB[0].id);
    asForeign.set('supplierId', SUPPLIER_B);
    asForeign.set('evidenceType', requirementsB[0].evidence_type);
    asForeign.set('file', new Blob([Buffer.from('%PDF-1.4\nforged\n')], { type: 'application/pdf' }), 'forged.pdf');
    const forged = await call('/v1/evidence', { method: 'POST', token: supplierA.token, body: asForeign });
    expectRefused('supplier A cannot submit evidence for supplier B declaring B', forged.response, forged.body);

    const asSelf = new FormData();
    asSelf.set('requirementId', requirementsB[0].id);
    asSelf.set('supplierId', SUPPLIER_A);
    asSelf.set('evidenceType', requirementsB[0].evidence_type);
    asSelf.set('file', new Blob([Buffer.from('%PDF-1.4\nforged\n')], { type: 'application/pdf' }), 'forged.pdf');
    const mismatched = await call('/v1/evidence', { method: 'POST', token: supplierA.token, body: asSelf });
    expectRefused('supplier A cannot submit against supplier B requirement declaring itself', mismatched.response, mismatched.body);

    const rows = await database.admin.query('SELECT count(*)::int AS count FROM evidence_files WHERE tenant_id=$1 AND requirement_id=$2', [tenantId, requirementsB[0].id]);
    record('the refused submissions created no evidence row', `${rows.rows[0].count} row(s) for the foreign requirement, expected 1 (supplier B\'s own)`, rows.rows[0].count === 1);
  }

  // 5. update — every mutating route on a foreign object, including the ones a supplier lacks the
  // permission for. A permission refusal and a scope refusal must be indistinguishable.
  for (const [name, path, body] of [
    ['review another supplier\'s evidence', `/v1/evidence/${evidenceB.id}/review`, JSON.stringify({ decision: 'accepted' })],
    ['review its own evidence', `/v1/evidence/${evidenceA.id}/review`, JSON.stringify({ decision: 'accepted' })],
    ['assign a gap', `/v1/gaps/${foreignGap?.id || 'GAP-000000000000000000000000'}/assign`, JSON.stringify({ ownerId: randomUUID() })],
    ['remediate a gap', `/v1/gaps/${foreignGap?.id || 'GAP-000000000000000000000000'}/remediate`, JSON.stringify({ notes: 'x' })],
    ['reassess a gap', `/v1/gaps/${foreignGap?.id || 'GAP-000000000000000000000000'}/reassess`, null],
    ['run assessments', '/v1/assessments/run', JSON.stringify({})],
    ['import a catalogue', '/v1/imports', JSON.stringify(createAcmeValidJsonImport())],
    ['read the scanning queue', '/v1/scan-jobs', null],
    ['freeze a review', '/v1/review-snapshots', JSON.stringify({ locale: 'en' })],
  ]) {
    const method = path === '/v1/scan-jobs' ? 'GET' : 'POST';
    const attempt = await call(path, {
      method, token: supplierA.token,
      // Supplied where the route requires it, so the refusal is the authorization decision rather than a
      // missing header: a 400 would leave the permission check unexercised.
      idempotencyKey: path === '/v1/imports' ? 'supplier-forged-import' : undefined,
      body: method === 'POST' ? body || '{}' : undefined,
    });
    expectRefused(`supplier A cannot ${name}`, attempt.response, attempt.body);
  }

  // 6. search and filter — a client-supplied supplier identifier must not widen the scope. If a filter is
  // ever added, this is the probe that stops it being added as an override.
  for (const query of [`?supplierId=${SUPPLIER_B}`, `?supplier_id=${SUPPLIER_B}`, `?supplierId=`, `?supplierId=${SUPPLIER_A}%2C${SUPPLIER_B}`]) {
    for (const path of ['/v1/evidence', '/v1/evidence-requirements', '/v1/assessments', '/v1/gaps']) {
      const filtered = await call(`${path}${query}`, { token: supplierA.token });
      if (filtered.response.status !== 200) {
        record(`filter ${path}${query} is refused rather than honoured`, `status ${filtered.response.status}`, filtered.response.status === 404);
        continue;
      }
      const key = path === '/v1/assessments' || path === '/v1/gaps' ? 'packaging_id' : 'supplier_id';
      const leaked = filtered.body.items.filter((item) => (key === 'supplier_id' ? item[key] !== SUPPLIER_A : !packagingA.has(item[key])));
      record(`filter ${path}${query} does not widen the scope`, leaked.length ? `${leaked.length} foreign rows returned` : `${filtered.body.items.length} rows, all own`, leaked.length === 0);
    }
  }

  // 7. forged identity headers — the same probe the two-tenant matrix runs, at supplier granularity.
  for (const header of [{ 'x-openppwr-supplier-id': SUPPLIER_B }, { 'x-openppwr-role': 'tenant_admin' }, { 'x-openppwr-supplier-id': SUPPLIER_B, 'x-openppwr-role': 'compliance_manager' }]) {
    const response = await fetch(`${baseUrl}/v1/evidence`, { headers: { authorization: `Bearer ${supplierA.token}`, ...header } });
    const body = await response.json();
    const foreign = (body.items || []).filter((item) => item.supplier_id !== SUPPLIER_A);
    record(
      `forged ${Object.keys(header).join('+')} is ignored`,
      foreign.length ? `${foreign.length} foreign rows after forging ${JSON.stringify(header)}` : `still ${body.items.length} own rows`,
      foreign.length === 0,
    );
  }

  // 8. Positive controls. Without these, a product that returned nothing to everybody would pass.
  {
    const adminRequirements = (await call('/v1/evidence-requirements', { token: identities.tenant_admin.token })).body.items;
    expectPresent('the administrator sees supplier A requirements', adminRequirements, requirementsA[0].id);
    expectPresent('the administrator sees supplier B requirements', adminRequirements, requirementsB[0].id);

    const reviewerEvidence = (await call('/v1/evidence', { token: identities.evidence_reviewer.token })).body.items;
    expectPresent('the evidence reviewer sees supplier A evidence', reviewerEvidence, evidenceA.id);
    expectPresent('the evidence reviewer sees supplier B evidence', reviewerEvidence, evidenceB.id);

    const auditorDownload = await call(`/v1/evidence/${evidenceB.id}/download`, { token: identities.read_only_auditor.token });
    record('the read-only auditor may download supplier B evidence', `status ${auditorDownload.response.status}`, auditorDownload.response.status === 200);

    const managerAssessments = (await call('/v1/assessments', { token: identities.compliance_manager.token })).body.items;
    expectPresent('the compliance manager sees an assessment on supplier B packaging', managerAssessments, foreignAssessment.id);

    // And the counts must differ in the right direction. Equal counts would mean the scoping does nothing;
    // this is the assertion that fails if the supplier filter is quietly removed.
    const supplierAssessments = (await call('/v1/assessments', { token: supplierA.token })).body.items;
    record(
      'a supplier sees strictly fewer assessments than a compliance manager',
      `${supplierAssessments.length} of ${managerAssessments.length}`,
      supplierAssessments.length > 0 && supplierAssessments.length < managerAssessments.length,
    );

    // Both suppliers must be scoped, not just the one the fix was written against.
    const supplierBEvidence = (await call('/v1/evidence', { token: supplierB.token })).body.items;
    const bForeign = supplierBEvidence.filter((item) => item.supplier_id !== SUPPLIER_B);
    record('supplier B is scoped as well as supplier A', bForeign.length ? `${bForeign.length} foreign rows` : `${supplierBEvidence.length} rows, all ${SUPPLIER_B}`, bForeign.length === 0);
  }

  await mkdir(outputRoot, { recursive: true });
  const report = {
    gate: failures.length ? 'SUPPLIER_ISOLATION_SAME_TENANT_FAIL' : 'SUPPLIER_ISOLATION_SAME_TENANT_PASS',
    generatedAt: new Date().toISOString(),
    tenantId,
    suppliers: { a: SUPPLIER_A, b: SUPPLIER_B },
    identifiersReadFromDatabase: {
      evidenceA: evidenceA.id,
      evidenceB: evidenceB.id,
      requirementB: requirementsB[0].id,
      assessmentOnExclusiveBPackaging: foreignAssessment.id,
      gap: foreignGap?.id || null,
      packagingExclusiveToB: exclusiveB.length,
    },
    checks: checks.length,
    failures: failures.length,
    detail: checks,
    reportSha256: null,
  };
  const serialized = JSON.stringify(report, null, 2);
  report.reportSha256 = createHash('sha256').update(serialized).digest('hex');
  await writeFile(resolve(outputRoot, 'supplier-isolation-matrix-report.json'), JSON.stringify(report, null, 2));

  if (failures.length) {
    console.error(`SUPPLIER_ISOLATION_SAME_TENANT_FAIL checks=${checks.length} failures=${failures.length}`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`SUPPLIER_ISOLATION_SAME_TENANT_PASS checks=${checks.length} failures=0 suppliers=${SUPPLIER_A},${SUPPLIER_B}`);
    console.log(`report=${resolve(outputRoot, 'supplier-isolation-matrix-report.json')}`);
  }
} catch (error) {
  crashed = error;
} finally {
  // Bounded, because `process.exit()` below is only reached if these settle. An unbounded `pool.end()`
  // — which never settles once a client is checked out and not returned — defeats the explicit exit
  // entirely: the process would sit here holding a live socket with its report already written.
  await closeServer(server, 'supplier-isolation-server', 15_000);
  await endPool(pool, 'supplier-isolation-pool', 15_000);
  await endPool(workerPool, 'supplier-isolation-worker-pool', 15_000);
  await boundedStep('supplier-isolation-database', () => database?.stop(), 60_000);
  if (crashed) {
    console.error(`SUPPLIER_ISOLATION_SAME_TENANT_CRASH ${crashed?.stack || crashed}`);
  }
  // Explicit exit after cleanup. Observed once during mutation testing: the process stayed alive well past
  // the end of its work, which for a gate is as bad as exiting 0 on failure — a hung gate is indistinguishable
  // from a slow one, and that exact shape stalled the full gate before with no stage name and no output.
  // Everything above has already written its report and flushed its lines, so the exit code is the last word.
  await new Promise((flushed) => process.stdout.write('', flushed));
  process.exit(crashed || failures.length ? 1 : 0);
}
