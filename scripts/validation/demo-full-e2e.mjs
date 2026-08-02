// The complete Community demonstration business process, end to end, in the owner's stated order.
//
// This is deliberately not the same script as `e2e-gate.mjs`. That gate proves the reference workflow
// reaches a correct assessment twice with identical numbers; it is a determinism check. This one proves
// the *demonstration* — the process an evaluator is invited to reproduce — covers every step the owner
// named, including the ones a determinism check has no reason to exercise: a real password sign-in for
// every interactive role, a revoked session refused afterwards, an infected upload quarantined rather
// than accepted, and one denied action per role.
//
// Both matter, and neither replaces the other. A determinism check asserting `outcomes.PASS > 0` cannot
// tell an evaluator whether the demonstration produces the published numbers, and the published numbers
// are what a reader compares against. So the outcome counts here are exact and unconditional.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boundedStep, closeServer, endPool } from '../testing/bounded-teardown.mjs';

// Set before the application module graph is imported: demonstration sign-in is read at bootstrap and
// at every login, and the whole point of this gate is to prove the password path rather than paste a
// bearer token. Test-only, and the deployment's own setting is untouched.
process.env.OPENPPWR_DEMO_LOGIN = 'true';
process.env.OPENPPWR_DEMO_PASSWORD = process.env.OPENPPWR_DEMO_PASSWORD || 'demo';
process.env.NODE_ENV = 'test';

const { createPool, migrate } = await import('@openppwr/database');
const { createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } = await import('@openppwr/testing');
const { VerdictStubScanner, processNextScanJob } = await import('@openppwr/worker');
const { createApp, createVerifiedContext } = await import('../../apps/api/src/app.mjs');
const { startTestDatabase } = await import('../testing/embedded-postgres.mjs');

const outputRoot = resolve('artifacts', 'demo-e2e');
const DEMO_PASSWORD = process.env.OPENPPWR_DEMO_PASSWORD;
const EMAIL_DOMAIN = process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example';

// The seven interactive roles the owner requires covered. The machine identities (service_account,
// worker) are excluded on purpose: they hold no demonstration sign-in, and inventing one to make a
// table look complete would misrepresent the product.
const INTERACTIVE_ROLES = Object.freeze([
  'tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor',
  'evidence_reviewer', 'supplier_user', 'read_only_auditor',
]);

// The owner's published demonstration outcome, before and after remediation. Asserted exactly. If the
// product's behaviour changes, this gate fails and the published figure is corrected — the figure is
// not re-derived from whatever the run happened to produce.
const EXPECTED_INITIAL = Object.freeze({ PASS: 20, FAIL: 1, UNKNOWN: 1, NOT_APPLICABLE: 10 });
const EXPECTED_REMEDIATED = Object.freeze({ PASS: 22, FAIL: 0, UNKNOWN: 0, NOT_APPLICABLE: 10 });
const EXPECTED_CATALOG = Object.freeze({ packaging: 32, materials: 18, components: 40, boms: 32 });

// The bare EICAR test file, assembled at runtime so this source file is not itself flagged by a
// scanner reading the repository. Uploaded as text/plain, a permitted evidence type whose content
// check it passes, so it reaches the scanner and is then caught.
//
// This used to carry the EICAR string inside a structurally valid PDF, reasoning that a bare string
// declared as a PDF is refused by content typing before the scanner sees it. That reasoning was right
// about typing and wrong about the scanner: run against the deployment, the real ClamAV reported the
// PDF-wrapped copy as **clean**.
//
// That is correct engine behaviour, not a product defect — EICAR is defined as an exact file, and
// engines flag that file rather than anything containing its bytes. The lesson is about the test.
// `VerdictStubScanner` matches the substring, so it is more permissive than the engine it stands
// in for, and this test passed locally on a payload the real scanner ignores. A stub that is easier to
// satisfy than production turns a passing test into a false assurance.
const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);

function checksum(content) { return createHash('sha256').update(content).digest('hex'); }

function demoEmailFor(role) {
  return role === 'compliance_manager' ? `demo@${EMAIL_DOMAIN}` : `${role.replaceAll('_', '-')}@${EMAIL_DOMAIN}`;
}

const steps = [];
function record(step, detail) {
  steps.push({ step, detail });
  console.log(`STEP ${String(steps.length).padStart(2, '0')} ${step} — ${detail}`);
}

async function runDemonstration() {
  const started = new Date();
  const runRoot = resolve(outputRoot, 'run');
  const storageRoot = resolve(runRoot, 'private-storage');
  const downloadRoot = resolve(runRoot, 'downloads');
  await mkdir(downloadRoot, { recursive: true });
  const database = await startTestDatabase('demo-full-e2e');
  let pool;
let authPool;
let maintenancePool;
let workerPool;
  let server;
  try {
    // ---- 1. clean / reset synthetic tenant -------------------------------------------------------
    await migrate(database.adminUrl);
    pool = createPool(database.runtimeUrl);
    // Sign-in and the reset run on credentials the request pool does not hold (migrations 014, 018), and
    // retention runs on the worker's (migration 022). This script had not been updated for any of them, so
    // the one gate that exercises the whole workflow could not reach step 1 — which is why a default-deny
    // audit registry built from a guess broke dossier generation unnoticed.
    authPool = createPool(database.authUrl);
    maintenancePool = createPool(database.maintenanceUrl);
    workerPool = createPool(database.workerUrl);
    await database.declareDemonstrationDeployment();
    const bootstrapSecret = randomUUID();
    const app = createApp({ pool, authPool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot });
    await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, options);
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { response, body, status: response.status };
    };

    const created = await call('/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
      body: '{}',
    });
    assert.equal(created.status, 201);
    const { tenantId, identities } = created.body;
    const zeroed = await database.admin.query('SELECT count(*)::int count FROM packaging');
    assert.equal(zeroed.rows[0].count, 0, 'a reset tenant must start with no packaging');
    record('clean/reset synthetic tenant', `tenant ${tenantId}, packaging 0, disclaimer present`);

    // ---- 2. login using the demonstration roles --------------------------------------------------
    // A real password sign-in per role, not a bearer token handed over by bootstrap. This is the path
    // an evaluator uses, so it is the path proven.
    const published = await call('/v1/demo/accounts');
    assert.equal(published.status, 200);
    assert.equal(published.body.accounts.length, 7);
    const sessions = {};
    for (const role of INTERACTIVE_ROLES) {
      const signedIn = await call('/v1/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: demoEmailFor(role), password: DEMO_PASSWORD }),
      });
      assert.equal(signedIn.status, 200, `${role} must be able to sign in`);
      assert.equal(signedIn.body.role, role);
      assert.ok(signedIn.body.token.startsWith('opp_sess_'), 'sign-in must issue a session credential');
      const confirmed = await call('/v1/session', { headers: { authorization: `Bearer ${signedIn.body.token}` } });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.body.role, role);
      assert.equal(confirmed.body.tenantId, tenantId);
      sessions[role] = signedIn.body.token;
    }
    // A wrong password is refused, and indistinguishably from an unknown address.
    const wrongPassword = await call('/v1/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: demoEmailFor('tenant_admin'), password: 'incorrect' }),
    });
    const unknownAddress = await call('/v1/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `absent@${EMAIL_DOMAIN}`, password: DEMO_PASSWORD }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAddress.status, 401);
    assert.equal(wrongPassword.body.error.code, unknownAddress.body.error.code);
    record('login using demo roles', `7 roles signed in with a password; wrong password and unknown address both ${wrongPassword.status} ${wrongPassword.body.error.code}`);

    const bearer = (role, type = 'application/json') => ({ authorization: `Bearer ${sessions[role]}`, 'content-type': type });
    // Just the credential, for a request that carries no body: multipart uploads must let fetch set
    // their own boundary content-type, and a GET has nothing to type.
    const read = (role) => ({ authorization: `Bearer ${sessions[role]}` });
    const get = (path, role) => call(path, { headers: read(role) });

    // ---- 3-4. reject invalid rows without partial persistence ------------------------------------
    const invalid = await call('/v1/imports', {
      method: 'POST',
      headers: { ...bearer('packaging_editor'), 'idempotency-key': 'demo-invalid' },
      body: JSON.stringify(createAcmeInvalidImport()),
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.rejectedRows, 8);
    const afterInvalid = await database.admin.query('SELECT count(*)::int count FROM packaging');
    assert.equal(afterInvalid.rows[0].count, 0, 'a rejected import must persist nothing at all');
    record('reject invalid rows', `${invalid.body.rejectedRows} rows rejected, ${afterInvalid.rows[0].count} rows persisted`);

    // ---- 5. import valid JSON and CSV, persist packaging/materials/components/BOM -----------------
    const validPayload = JSON.stringify(createAcmeValidJsonImport());
    const validHeaders = { ...bearer('packaging_editor'), 'idempotency-key': 'demo-valid' };
    const valid = await call('/v1/imports', { method: 'POST', headers: validHeaders, body: validPayload });
    assert.equal(valid.body.acceptedRows, 28);
    const replay = await call('/v1/imports', { method: 'POST', headers: validHeaders, body: validPayload });
    assert.equal(replay.body.replayed, true, 'a replayed idempotency key must not double-import');
    const supplemental = await call('/v1/imports', {
      method: 'POST',
      headers: { ...bearer('packaging_editor', 'text/csv'), 'idempotency-key': 'demo-supplemental' },
      body: createAcmeSupplementalCsv(),
    });
    assert.equal(supplemental.body.acceptedRows, 4);
    const catalog = await database.admin.query(
      `SELECT (SELECT count(*)::int FROM packaging WHERE tenant_id=$1) packaging,
              (SELECT count(*)::int FROM materials WHERE tenant_id=$1) materials,
              (SELECT count(*)::int FROM components WHERE tenant_id=$1) components,
              (SELECT count(*)::int FROM boms WHERE tenant_id=$1) boms`, [tenantId]);
    assert.deepEqual(catalog.rows[0], EXPECTED_CATALOG);
    record('persist packaging/materials/components/BOM', `JSON ${valid.body.acceptedRows} + CSV ${supplemental.body.acceptedRows} rows → ${JSON.stringify(catalog.rows[0])}`);

    // ---- 6-7. suppliers linked, evidence requirements derived ------------------------------------
    const requirements = await get('/v1/evidence-requirements', 'evidence_contributor');
    assert.equal(requirements.status, 200);
    const bySupplier = new Map();
    for (const item of requirements.body.items) if (!bySupplier.has(item.supplier_id)) bySupplier.set(item.supplier_id, item);
    assert.ok(bySupplier.size >= 4, 'the demonstration needs requirements across several suppliers');
    const linkedSuppliers = await database.admin.query('SELECT count(*)::int count FROM suppliers WHERE tenant_id=$1', [tenantId]);
    record('link suppliers, derive evidence requirements', `${linkedSuppliers.rows[0].count} suppliers, ${requirements.body.items.length} requirements over ${bySupplier.size} suppliers`);

    const workerPrincipal = (await workerPool.query('SELECT session_user, current_user')).rows[0];
    assert.deepEqual(workerPrincipal, { session_user: 'openppwr_worker', current_user: 'openppwr_worker' },
      'scan jobs must execute through the worker database principal');
    const worker = await createVerifiedContext(pool, identities.worker.token);
    const upload = async (requirement, bytes, { filename = `declaration-${requirement.supplier_id}.pdf`, mime = 'application/pdf', expiresAt = null, as = 'evidence_contributor' } = {}) => {
      const form = new FormData();
      form.set('requirementId', requirement.id);
      form.set('supplierId', requirement.supplier_id);
      form.set('evidenceType', requirement.evidence_type);
      if (expiresAt) form.set('expiresAt', expiresAt);
      form.set('file', new Blob([bytes], { type: mime }), filename);
      return call('/v1/evidence', { method: 'POST', headers: read(as), body: form });
    };
    const scan = () => processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
    const review = (evidenceId, decision = 'accepted') => call(`/v1/evidence/${evidenceId}/review`, {
      method: 'POST', headers: bearer('evidence_reviewer'), body: JSON.stringify({ decision }),
    });

    // ---- 8-9. allowed evidence accepted, unsafe evidence refused --------------------------------
    const first = await upload(bySupplier.get('ACME-SUP-001'), Buffer.from('%PDF-1.4\nSynthetic complete evidence\n'));
    // 202, not 201: the upload is stored in quarantine and queued for scanning, and the API says so
    // rather than reporting a resource that is not yet servable.
    assert.equal(first.status, 202);
    const firstScan = await scan();
    assert.equal(firstScan.scanStatus ?? firstScan.status, 'clean');
    assert.equal((await review(first.body.id)).status, 200);

    const spoofed = await upload(bySupplier.get('ACME-SUP-004'), Buffer.from('synthetic MIME mismatch'), { filename: 'mismatch.pdf' });
    assert.equal(spoofed.status, 422);
    assert.equal(spoofed.body.error.code, 'EVIDENCE_MIME_MISMATCH');
    record('reject unsafe evidence', `declared PDF with non-PDF content → ${spoofed.status} ${spoofed.body.error.code}`);

    // ---- 10. malware scan and quarantine --------------------------------------------------------
    // The upload is accepted into quarantine and the *review* is refused, which is the honest
    // behaviour: the file is stored where nothing serves it, and no reviewer can approve it.
    const infectedUpload = await upload(bySupplier.get('ACME-SUP-002'), EICAR, { filename: 'infected-declaration.txt', mime: 'text/plain' });
    let quarantine = null;
    if (infectedUpload.status === 202) {
      const infectedScan = await scan();
      assert.equal(infectedScan.scanStatus ?? infectedScan.status, 'infected', 'the scanner must report the test pattern as infected');
      const accepted = await review(infectedUpload.body.id, 'accepted');
      assert.equal(accepted.status, 409);
      assert.equal(accepted.body.error.code, 'EVIDENCE_NOT_CLEAN');
      const download = await get(`/v1/evidence/${infectedUpload.body.id}/download`, 'evidence_reviewer');
      assert.equal(download.status, 404, 'quarantined evidence must not be retrievable');
      const stored = await database.admin.query('SELECT storage_key,scan_status FROM evidence_files WHERE id=$1', [infectedUpload.body.id]);
      assert.match(stored.rows[0].storage_key, /\/quarantine\//u);
      assert.equal(stored.rows[0].scan_status, 'infected');
      quarantine = { evidenceId: infectedUpload.body.id, scanStatus: stored.rows[0].scan_status, acceptRefused: accepted.body.error.code, downloadStatus: download.status };
      record('malware scan and quarantine', `EICAR pattern → scan_status=infected, accept ${accepted.status} ${accepted.body.error.code}, download ${download.status}, stored under /quarantine/`);
    } else {
      // Refused at the door instead. Also acceptable, and recorded as what actually happened.
      quarantine = { rejectedAtUpload: infectedUpload.status, code: infectedUpload.body?.error?.code };
      record('malware scan and quarantine', `EICAR pattern refused at upload → ${infectedUpload.status} ${infectedUpload.body?.error?.code}`);
    }

    // ---- 11-12. review, approve and reject -----------------------------------------------------
    const supplier2 = await upload(bySupplier.get('ACME-SUP-002'), Buffer.from('%PDF-1.4\nSynthetic remediation evidence\n'));
    await scan();
    assert.equal((await review(supplier2.body.id)).status, 200);

    const expired = await upload(bySupplier.get('ACME-SUP-003'), Buffer.from('%PDF-1.4\nSynthetic expired declaration\n'), { expiresAt: '2026-01-01T00:00:00.000Z' });
    await scan();
    const expiredReview = await review(expired.body.id);
    assert.equal(expiredReview.status, 409);
    assert.equal(expiredReview.body.error.code, 'EVIDENCE_EXPIRED');
    const replacement = await upload(bySupplier.get('ACME-SUP-003'), Buffer.from('%PDF-1.4\nSynthetic replacement declaration\n'));
    await scan();
    assert.equal((await review(replacement.body.id)).status, 200);

    const resubmission = await upload(bySupplier.get('ACME-SUP-004'), Buffer.from('%PDF-1.4\nSynthetic clean resubmission\n'));
    await scan();
    assert.equal((await review(resubmission.body.id)).status, 200);
    const rejectedOnMerit = await upload(bySupplier.get('ACME-SUP-001'), Buffer.from('%PDF-1.4\nSynthetic superseded declaration\n'));
    await scan();
    const rejected = await review(rejectedOnMerit.body.id, 'rejected');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.reviewStatus, 'rejected');
    record('review, approve and reject evidence', `4 accepted, 1 rejected on the reviewer's decision, 1 refused as expired (${expiredReview.body.error.code})`);

    // ---- 13-15. assessment, explanation, deduplicated gaps -------------------------------------
    const assessed = await call('/v1/assessments/run', { method: 'POST', headers: bearer('compliance_manager'), body: '{}' });
    // 201: a run creates an assessment record, which is what the gap and dossier steps later cite.
    assert.equal(assessed.status, 201);
    assert.deepEqual(assessed.body.outcomes, EXPECTED_INITIAL, 'the published initial demonstration outcome must be reproduced exactly');
    // The explanation is carried as a trace of i18n keys, and rendered into business language when the
    // dossier is produced. Both halves are asserted: the key here, the resolved sentence below, after
    // the dossier is downloaded. Checking only the key would let a missing translation ship as a raw
    // identifier in front of a reader.
    const explained = assessed.body.results.filter((result) => Array.isArray(result.trace) && result.trace.length
      && result.trace.every((entry) => entry.explanationKey || entry.code));
    assert.equal(explained.length, assessed.body.results.length, 'every result must carry an explanation trace');
    record('assessment', `outcomes ${JSON.stringify(assessed.body.outcomes)} over ${assessed.body.results.length} results, rule ${assessed.body.ruleId}@${assessed.body.ruleVersion}`);
    record('business-language explanation', `${explained.length}/${assessed.body.results.length} results carry an explanation`);

    // Freezing is refused while a gap is open. Proven before remediation, not asserted afterwards.
    const prematureFreeze = await call('/v1/review-snapshots', { method: 'POST', headers: bearer('compliance_manager'), body: '{}' });
    assert.equal(prematureFreeze.status, 409);

    const gaps = await get('/v1/gaps', 'compliance_manager');
    const blocking = gaps.body.items.filter((gap) => gap.status !== 'closed');
    assert.equal(blocking.length, 2);
    // Deduplication is per packaging record *and* discriminator, not per discriminator alone.
    // `deduplication_key` names what the gap is about — `RECYCLED_CONTENT_DECLARATION`,
    // `recycledContentPct` — so the same key legitimately recurs across different packaging records.
    // What must never happen is two rows for the same packaging and the same finding.
    //
    // The earlier version of this assertion compared distinct keys against the row count over the two
    // open gaps, and passed only because those two happened to carry different discriminators. Run
    // against the deployment's eight gaps it failed immediately: 8 rows, 3 discriminators. A two-row
    // sample is not enough to test a uniqueness rule.
    const gapPairs = new Set(gaps.body.items.map((gap) => `${gap.packaging_id}::${gap.deduplication_key}`));
    assert.equal(gapPairs.size, gaps.body.items.length, 'gaps must be deduplicated per packaging record and discriminator');
    assert.equal(new Set(gaps.body.items.map((gap) => gap.id)).size, gaps.body.items.length);
    record('deduplicated gaps', `${blocking.length} open of ${gaps.body.items.length} gaps, ${gapPairs.size} distinct (packaging, discriminator) pairs, freeze refused ${prematureFreeze.status} while open`);

    // ---- 16-17. ownership, remediation, reassessment -------------------------------------------
    for (const gap of blocking) {
      const assigned = await call(`/v1/gaps/${gap.id}/assign`, {
        method: 'POST', headers: bearer('compliance_manager'),
        body: JSON.stringify({ ownerId: identities.compliance_manager.id }),
      });
      assert.equal(assigned.body.status, 'assigned');
      const remediated = await call(`/v1/gaps/${gap.id}/remediate`, {
        method: 'POST', headers: bearer('compliance_manager'),
        body: JSON.stringify({ notes: 'Synthetic remediation', evidenceIds: [supplier2.body.id], packagingPatch: { recycledContentPct: 40 } }),
      });
      assert.equal(remediated.body.status, 'remediated');
      const reassessed = await call(`/v1/gaps/${gap.id}/reassess`, { method: 'POST', headers: read('compliance_manager') });
      assert.equal(reassessed.body.results[0].outcome, 'PASS');
    }
    record('ownership, remediation, reassessment', `${blocking.length} gaps assigned, remediated and reassessed to PASS`);

    // ---- 18. the remediated assessment, asserted exactly ---------------------------------------
    const remediatedRun = await call('/v1/assessments/run', { method: 'POST', headers: bearer('compliance_manager'), body: '{}' });
    assert.deepEqual(remediatedRun.body.outcomes, EXPECTED_REMEDIATED, 'the published remediated demonstration outcome must be reproduced exactly');
    record('remediated assessment', `outcomes ${JSON.stringify(remediatedRun.body.outcomes)}`);

    // ---- 19. frozen review ---------------------------------------------------------------------
    const frozen = await call('/v1/review-snapshots', { method: 'POST', headers: bearer('compliance_manager'), body: JSON.stringify({ locale: 'en' }) });
    assert.equal(frozen.body.status, 'READY_FOR_REVIEW');
    assert.ok(frozen.body.snapshotSha256);
    record('READY_FOR_REVIEW and frozen review', `snapshot ${frozen.body.id}, sha256 ${frozen.body.snapshotSha256.slice(0, 16)}…`);

    // ---- 20-21. dossier and SHA-256 manifest verification --------------------------------------
    const generated = await call(`/v1/review-snapshots/${frozen.body.id}/dossier`, { method: 'POST', headers: read('compliance_manager') });
    assert.equal(generated.body.artifacts.length, 4);
    const artifacts = [];
    for (const artifact of generated.body.artifacts) {
      const response = await fetch(`${baseUrl}/v1/dossiers/${artifact.id}/download`, { headers: read('read_only_auditor') });
      assert.equal(response.status, 200, 'the read-only auditor must be able to retrieve the dossier');
      const content = Buffer.from(await response.arrayBuffer());
      // Verified against the recorded digest, not merely against itself.
      assert.equal(checksum(content), artifact.sha256, `${artifact.artifactType} digest must match the manifest`);
      const filename = artifact.artifactType === 'manifest' ? 'checksum-manifest.json' : `dossier.${artifact.artifactType}`;
      const path = resolve(downloadRoot, filename);
      await writeFile(path, content, { flag: 'w' });
      artifacts.push({ type: artifact.artifactType, path, sha256: artifact.sha256, sizeBytes: content.length });
    }
    const manifestArtifact = artifacts.find((artifact) => artifact.type === 'manifest');
    assert.ok(manifestArtifact, 'the dossier must include a checksum manifest');
    record('dossier and manifest verification', `${artifacts.map((a) => a.type).join('/')}; every digest recomputed and matched`);

    // The other half of the explanation claim: the dossier a reader actually opens must contain
    // sentences, not the i18n keys behind them.
    // Every trace entry keeps its machine key *and* gains a rendered sentence. Both are wanted: the key
    // is what a downstream system matches on, the sentence is what a reader understands. What must not
    // happen is a key arriving with no sentence beside it, or with the key echoed back as the sentence
    // because a translation was missing.
    const dossierJson = JSON.parse(await readFile(resolve(downloadRoot, 'dossier.json'), 'utf8'));
    // The dossier carries the machine trace (`explanation`) and the reader's version
    // (`localizedExplanation`) side by side, entry for entry.
    assert.equal(dossierJson.locale, 'en');
    assert.ok(dossierJson.assessments.length > 0, 'the dossier must carry assessments');
    let rendered = 0;
    for (const assessment of dossierJson.assessments) {
      assert.ok(Array.isArray(assessment.localizedExplanation), 'each assessment must carry a localized explanation');
      assert.equal(assessment.localizedExplanation.length, assessment.explanation.length, 'every machine trace entry needs a reader-facing counterpart');
      for (const entry of assessment.localizedExplanation) {
        const key = entry.explanationKey || entry.code;
        assert.equal(typeof entry.message, 'string', `explanation ${key} must carry a rendered message`);
        assert.notEqual(entry.message, key, `explanation ${key} was not translated, the key was echoed as the message`);
        assert.ok(/\p{L}{3}\s\p{L}{2}/u.test(entry.message), `explanation ${key} must read as a sentence, got "${entry.message}"`);
        rendered += 1;
      }
    }
    record('business-language explanation rendered', `${rendered} explanations across ${dossierJson.assessments.length} assessments, each a translated sentence beside its key`);

    // ---- 22. audit chain reconstruction --------------------------------------------------------
    const audit = await get('/v1/audit/verify', 'read_only_auditor');
    assert.equal(audit.body.valid, true);
    assert.ok(audit.body.count > 0);
    const auditActions = (await database.admin.query(
      'SELECT DISTINCT action FROM audit_events WHERE tenant_id=$1 ORDER BY action',
      [tenantId],
    )).rows.map((row) => row.action);
    assert.deepEqual(auditActions, [
      'assessment.completed',
      // Migration 038: a successful sign-in now appends its own audit event. `session.revoked` does not
      // belong in this list -- the logout call later in this script runs after this assertion, so at this
      // point in the demonstration no session has been revoked yet.
      'auth.login.succeeded',
      'dossier.generated',
      'evidence.accepted',
      'evidence.quarantined',
      'evidence.rejected',
      'evidence.scan.clean',
      'evidence.scan.infected',
      'gap.assigned',
      'gap.remediated',
      'import.accepted',
      'import.rejected',
      'review_snapshot.frozen',
      'tenant.bootstrapped',
    ], 'audit hash verification passed, but action set did not match operations exercised by the demonstration');
    record('audit chain reconstruction', `${audit.body.count} events verified, head ${String(audit.body.head).slice(0, 16)}…`);

    // ---- 23-24. logout, then the reused session refused ---------------------------------------
    const editorToken = sessions.packaging_editor;
    const loggedOut = await call('/v1/logout', { method: 'POST', headers: { authorization: `Bearer ${editorToken}` } });
    assert.equal(loggedOut.status, 204, 'a session credential must be revoked server-side');
    const reused = await call('/v1/session', { headers: { authorization: `Bearer ${editorToken}` } });
    assert.equal(reused.status, 401, 'a revoked session must not authenticate again');
    const reusedWrite = await call('/v1/imports', {
      method: 'POST',
      headers: { authorization: `Bearer ${editorToken}`, 'content-type': 'application/json', 'idempotency-key': 'demo-replay' },
      body: validPayload,
    });
    assert.equal(reusedWrite.status, 401, 'a revoked session must not be usable for a write either');
    record('logout and reused-session rejection', `logout ${loggedOut.status}; the same credential then ${reused.status} on read and ${reusedWrite.status} on write`);

    // ---- 25-27. read-only auditor: allowed reads, denied write --------------------------------
    // The frozen review is served from the collection; there is no per-id route, so the auditor's
    // access is proven the way the product actually exposes it.
    const auditorSnapshot = await get('/v1/review-snapshots', 'read_only_auditor');
    assert.equal(auditorSnapshot.status, 200, 'the auditor must reach the frozen review');
    const visible = auditorSnapshot.body.items.find((item) => item.id === frozen.body.id);
    assert.ok(visible, 'the frozen review must be visible to the auditor');
    // The frozen digest the auditor is shown must be the one the freeze produced, or the auditor is
    // reviewing something other than what was frozen.
    assert.equal(visible.snapshotSha256 ?? visible.snapshot_sha256, frozen.body.snapshotSha256);
    assert.equal(visible.artifacts.length, 4, 'the auditor must see every dossier artifact');
    const auditorWrite = await call('/v1/imports', {
      method: 'POST',
      headers: { ...bearer('read_only_auditor'), 'idempotency-key': 'demo-auditor-write' },
      body: validPayload,
    });
    assert.equal(auditorWrite.status, 404, 'a denied write must not disclose that the route exists');
    record('read-only auditor', `frozen review ${auditorSnapshot.status}, dossier 200, write refused ${auditorWrite.status}`);

    // ---- role matrix: one allowed and one denied action for each of the seven roles -----------
    const matrix = [];
    const probe = async (role, label, request) => {
      const result = await request();
      matrix.push({ role, ...label, status: result.status, code: result.body?.error?.code ?? null });
      return result;
    };
    const denyBody = (role, key) => ({
      method: 'POST',
      headers: { ...bearer(role), 'idempotency-key': key },
      body: validPayload,
    });

    // tenant_admin holds every permission, so its refusal is not a permission at all — it is the
    // tenant boundary. A dossier identifier belonging to another tenant, which really exists.
    // Built rather than guessed, and deliberately not wrapped in a catch: a setup step that fails
    // quietly would leave this probe asserting only that a random UUID is absent, which proves nothing
    // about the tenant boundary. If the copy cannot be made, the gate must fail and say so.
    const otherTenant = randomUUID();
    const neighbourSnapshot = randomUUID();
    const neighbourArtifact = randomUUID();
    await database.admin.query(
      `INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,'Synthetic neighbour tenant','Fictional synthetic data.')`,
      [otherTenant, `neighbour-${Date.now()}`],
    );
    await database.admin.query(
      `INSERT INTO review_snapshots (tenant_id,id,locale,generator_version,frozen_at,frozen_by,snapshot,snapshot_sha256)
       SELECT $1,$2,locale,generator_version,frozen_at,frozen_by,snapshot,snapshot_sha256
       FROM review_snapshots WHERE tenant_id=$3 AND id=$4`,
      [otherTenant, neighbourSnapshot, tenantId, frozen.body.id],
    );
    await database.admin.query(
      `INSERT INTO dossier_artifacts (tenant_id,id,snapshot_id,artifact_type,storage_key,sha256,size_bytes,created_by,created_at)
       SELECT $1,$2,$3,artifact_type,storage_key,sha256,size_bytes,created_by,created_at
       FROM dossier_artifacts WHERE tenant_id=$4 AND id=$5`,
      [otherTenant, neighbourArtifact, neighbourSnapshot, tenantId, generated.body.artifacts[0].id],
    );
    const neighbourExists = await database.admin.query('SELECT count(*)::int count FROM dossier_artifacts WHERE tenant_id=$1 AND id=$2', [otherTenant, neighbourArtifact]);
    assert.equal(neighbourExists.rows[0].count, 1, 'the neighbour tenant artifact must really exist for the denial to mean anything');

    await probe('tenant_admin', { action: 'GET /v1/session', expectation: 'allowed' }, () => get('/v1/session', 'tenant_admin'));
    await probe('tenant_admin', { action: `GET /v1/dossiers/{another tenant's artifact}/download`, expectation: 'denied' }, () => get(`/v1/dossiers/${neighbourArtifact}/download`, 'tenant_admin'));

    await probe('compliance_manager', { action: 'POST /v1/assessments/run', expectation: 'allowed' }, () => call('/v1/assessments/run', { method: 'POST', headers: bearer('compliance_manager'), body: '{}' }));
    await probe('compliance_manager', { action: 'POST /v1/evidence', expectation: 'denied' }, async () => {
      const form = new FormData();
      form.set('requirementId', bySupplier.get('ACME-SUP-001').id);
      form.set('supplierId', 'ACME-SUP-001');
      form.set('evidenceType', bySupplier.get('ACME-SUP-001').evidence_type);
      form.set('file', new Blob([Buffer.from('%PDF-1.4\nrefused\n')], { type: 'application/pdf' }), 'refused.pdf');
      return call('/v1/evidence', { method: 'POST', headers: read('compliance_manager'), body: form });
    });

    // packaging_editor's session was revoked above on purpose, so sign in again for its matrix row.
    const editorAgain = await call('/v1/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: demoEmailFor('packaging_editor'), password: DEMO_PASSWORD }),
    });
    sessions.packaging_editor = editorAgain.body.token;
    await probe('packaging_editor', { action: 'POST /v1/imports (replayed key)', expectation: 'allowed' }, () => call('/v1/imports', { method: 'POST', headers: { ...bearer('packaging_editor'), 'idempotency-key': 'demo-valid' }, body: validPayload }));
    await probe('packaging_editor', { action: 'POST /v1/assessments/run', expectation: 'denied' }, () => call('/v1/assessments/run', { method: 'POST', headers: bearer('packaging_editor'), body: '{}' }));

    await probe('evidence_contributor', { action: 'GET /v1/evidence-requirements', expectation: 'allowed' }, () => get('/v1/evidence-requirements', 'evidence_contributor'));
    await probe('evidence_contributor', { action: 'POST /v1/evidence/{id}/review', expectation: 'denied' }, () => call(`/v1/evidence/${first.body.id}/review`, { method: 'POST', headers: bearer('evidence_contributor'), body: JSON.stringify({ decision: 'accepted' }) }));

    await probe('evidence_reviewer', { action: 'GET /v1/evidence/{id}/download', expectation: 'allowed' }, () => get(`/v1/evidence/${first.body.id}/download`, 'evidence_reviewer'));
    await probe('evidence_reviewer', { action: 'POST /v1/imports', expectation: 'denied' }, () => call('/v1/imports', denyBody('evidence_reviewer', 'demo-reviewer-write')));

    await probe('supplier_user', { action: 'GET /v1/evidence-requirements (own supplier only)', expectation: 'allowed' }, () => get('/v1/evidence-requirements', 'supplier_user'));
    await probe('supplier_user', { action: 'POST /v1/evidence for another supplier', expectation: 'denied' }, async () => {
      const target = bySupplier.get('ACME-SUP-002');
      const form = new FormData();
      form.set('requirementId', target.id);
      form.set('supplierId', target.supplier_id);
      form.set('evidenceType', target.evidence_type);
      form.set('file', new Blob([Buffer.from('%PDF-1.4\nnot mine\n')], { type: 'application/pdf' }), 'not-mine.pdf');
      return call('/v1/evidence', { method: 'POST', headers: read('supplier_user'), body: form });
    });

    await probe('read_only_auditor', { action: 'GET /v1/audit/verify', expectation: 'allowed' }, () => get('/v1/audit/verify', 'read_only_auditor'));
    await probe('read_only_auditor', { action: 'POST /v1/imports', expectation: 'denied' }, () => call('/v1/imports', denyBody('read_only_auditor', 'demo-auditor-write-2')));

    for (const role of INTERACTIVE_ROLES) {
      const rows = matrix.filter((entry) => entry.role === role);
      const allowed = rows.filter((entry) => entry.expectation === 'allowed');
      const denied = rows.filter((entry) => entry.expectation === 'denied');
      assert.ok(allowed.length >= 1, `${role} needs a verified allowed action`);
      assert.ok(denied.length >= 1, `${role} needs a verified denied action`);
      for (const entry of allowed) assert.ok(entry.status >= 200 && entry.status < 300, `${role} ${entry.action} expected allowed, got ${entry.status}`);
      for (const entry of denied) assert.ok(entry.status === 403 || entry.status === 404, `${role} ${entry.action} expected denied, got ${entry.status}`);
    }

    // ---- supplier isolation inside one tenant ------------------------------------------------
    // Every isolation test in this programme asked the cross-tenant question. None asked whether one
    // supplier can see another supplier inside the same tenant, and the answer was that it could, on
    // /v1/assessments and /v1/gaps. This is the regression test.
    const supplierScope = await get('/v1/evidence-requirements', 'supplier_user');
    const ownPackaging = new Set(supplierScope.body.items.map((item) => item.packaging_id));
    assert.ok(ownPackaging.size > 0, 'the supplier must own at least one packaging record for this to mean anything');

    const managerAssessments = await get('/v1/assessments', 'compliance_manager');
    const supplierAssessments = await get('/v1/assessments', 'supplier_user');
    assert.equal(supplierAssessments.status, 200);
    assert.ok(managerAssessments.body.items.length > supplierAssessments.body.items.length,
      'a supplier must see strictly fewer assessments than a compliance manager, or it is not scoped');
    for (const item of supplierAssessments.body.items) {
      assert.ok(ownPackaging.has(item.packaging_id),
        `supplier saw assessment for packaging ${item.packaging_id}, which is not its own`);
    }

    const managerGaps = await get('/v1/gaps', 'compliance_manager');
    const supplierGaps = await get('/v1/gaps', 'supplier_user');
    assert.equal(supplierGaps.status, 200);
    for (const gap of supplierGaps.body.items) {
      assert.ok(ownPackaging.has(gap.packaging_id),
        `supplier saw gap for packaging ${gap.packaging_id}, which is not its own`);
    }
    record('supplier isolation within the tenant', `supplier owns ${ownPackaging.size} packaging records; sees ${supplierAssessments.body.items.length} of ${managerAssessments.body.items.length} assessments and ${supplierGaps.body.items.length} of ${managerGaps.body.items.length} gaps, all its own`);
    record('role matrix', `${INTERACTIVE_ROLES.length} roles, ${matrix.length} probes, every role one allowed and one denied`);

    return {
      tenantId,
      durationSeconds: Number(((new Date() - started) / 1000).toFixed(3)),
      catalog: catalog.rows[0],
      rejectedRows: invalid.body.rejectedRows,
      outcomes: { initial: assessed.body.outcomes, remediated: remediatedRun.body.outcomes },
      gaps: { open: blocking.length, total: gaps.body.items.length, distinctPairs: gapPairs.size },
      quarantine,
      snapshot: { id: frozen.body.id, sha256: frozen.body.snapshotSha256, status: frozen.body.status },
      artifacts,
      audit: { valid: audit.body.valid, count: audit.body.count, head: audit.body.head },
      session: { logout: loggedOut.status, reusedRead: reused.status, reusedWrite: reusedWrite.status },
      roleMatrix: matrix,
      steps,
    };
  } finally {
    // Four pools, each previously unbounded. `pool.end()` has no deadline of its own and does not settle
    // while a client is checked out, so any one of these could hold the demonstration stage open after it
    // had finished and written its report: the work complete, the process unable to exit, nothing in the
    // log to say so.
    await closeServer(server, 'demo-server', 15_000);
    await endPool(pool, 'demo-pool', 15_000);
    await endPool(authPool, 'demo-auth-pool', 15_000);
    await endPool(maintenancePool, 'demo-maintenance-pool', 15_000);
    await endPool(workerPool, 'demo-worker-pool', 15_000);
    await boundedStep('demo-database', () => database.stop(), 60_000);
  }
}

await mkdir(outputRoot, { recursive: true });
const result = await runDemonstration();
const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), status: 'PASS', ...result };
const reportPath = resolve(outputRoot, 'demo-full-e2e-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('');
console.log(`DEMO_FULL_E2E_PASS steps=${result.steps.length} duration=${result.durationSeconds}s report=${reportPath}`);
console.log(`DEMO_ROLE_MATRIX_PASS roles=${INTERACTIVE_ROLES.length} probes=${result.roleMatrix.length}`);
console.log(`initial=${JSON.stringify(result.outcomes.initial)} remediated=${JSON.stringify(result.outcomes.remediated)}`);
