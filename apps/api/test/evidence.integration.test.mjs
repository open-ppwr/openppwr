import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { cleanupRetainedEvidence, VerdictStubScanner, processNextScanJob } from '@openppwr/worker';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, createVerifiedContext } from '../src/app.mjs';
import { detectEvidenceMime } from '../src/evidence-service.mjs';

let database;
let pool;
let workerPool;
let server;
let baseUrl;
let identities;
let tenantId;
let requirements;
const storageRoot = resolve('.runtime-test', `evidence-${randomUUID()}`);

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

async function upload(identity, requirement, bytes, { filename = 'declaration.pdf', mime = 'application/pdf' } = {}) {
  const form = new FormData();
  form.set('requirementId', requirement.id);
  form.set('supplierId', requirement.supplier_id);
  form.set('evidenceType', requirement.evidence_type);
  form.set('file', new Blob([bytes], { type: mime }), filename);
  return jsonRequest('/v1/evidence', { method: 'POST', headers: { authorization: `Bearer ${identity.token}` }, body: form });
}

before(async () => {
  // Stands in for the installer's `bootstrap-acme` writing this into the real evidence volume once
  // bootstrap succeeds — the worker's retention sweep requires it before treating absence as deletion
  // before it will treat an absent file as a completed deletion.
  await mkdir(storageRoot, { recursive: true });
  await writeFile(resolve(storageRoot, '.openppwr-storage-initialized'), new Date().toISOString());
  database = await startTestDatabase('api-evidence');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  workerPool = createPool(database.workerUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  identities = created.body.identities;
  tenantId = created.body.tenantId;
  const imported = await jsonRequest('/v1/imports', { method: 'POST', headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'evidence-catalog' }, body: JSON.stringify(createAcmeValidJsonImport()) });
  assert.equal(imported.response.status, 201);
  const listed = await jsonRequest('/v1/evidence-requirements', { headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } });
  requirements = listed.body.items;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await workerPool?.end();
  await database?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

test('clean evidence stays quarantined until worker scan and reviewer decision', async () => {
  const requirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-001');
  const uploaded = await upload(identities.evidence_contributor, requirement, Buffer.from('%PDF-1.4\nSynthetic declaration\n'));
  assert.equal(uploaded.response.status, 202);
  assert.equal(uploaded.body.scanStatus, 'pending');
  const premature = await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`, { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_reviewer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }) });
  assert.equal(premature.response.status, 409);
  const worker = await createVerifiedContext(pool, identities.worker.token);
  const processed = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
  assert.equal(processed.scanStatus, 'clean');
  const denied = await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`, { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_contributor.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }) });
  assert.equal(denied.response.status, 404);
  const accepted = await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`, { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_reviewer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }) });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.reviewStatus, 'accepted');
  const downloaded = await fetch(`${baseUrl}/v1/evidence/${uploaded.body.id}/download`, { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(downloaded.status, 200);
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
  assert.match(downloadedBytes.toString('utf8'), /Synthetic declaration/);
  const stored = await database.admin.query('SELECT storage_key FROM evidence_files WHERE id=$1', [uploaded.body.id]);
  await writeFile(resolve(storageRoot, stored.rows[0].storage_key), Buffer.alloc(downloadedBytes.length, 0x58));
  const tamperedDownload = await jsonRequest(`/v1/evidence/${uploaded.body.id}/download`, { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  assert.equal(tamperedDownload.response.status, 500);
  assert.equal(tamperedDownload.body.error.code, 'EVIDENCE_INTEGRITY_MISMATCH');
});

test('MIME spoof and supplier-scope violations create no evidence row', async () => {
  const beforeCount = await database.admin.query('SELECT count(*)::int AS count FROM evidence_files');
  const requirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-002');
  const spoof = await upload(identities.evidence_contributor, requirement, Buffer.from('plain text'), { filename: 'spoof.pdf', mime: 'application/pdf' });
  assert.equal(spoof.response.status, 422);
  assert.equal(spoof.body.error.code, 'EVIDENCE_MIME_MISMATCH');
  const crossSupplier = await upload(identities.supplier_user, requirement, Buffer.from('%PDF-1.4\nSynthetic\n'));
  assert.equal(crossSupplier.response.status, 404);
  const afterCount = await database.admin.query('SELECT count(*)::int AS count FROM evidence_files');
  assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
});

test('empty and oversized streams fail before registration', async () => {
  const requirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-002');
  const beforeCount = await database.admin.query('SELECT count(*)::int AS count FROM evidence_files');
  const empty = await upload(identities.evidence_contributor, requirement, Buffer.alloc(0));
  assert.equal(empty.response.status, 422);
  assert.equal(empty.body.error.code, 'EVIDENCE_EMPTY');
  const oversized = await upload(identities.evidence_contributor, requirement, Buffer.alloc(10 * 1024 * 1024 + 1, 0x41));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, 'EVIDENCE_TOO_LARGE');
  const afterCount = await database.admin.query('SELECT count(*)::int AS count FROM evidence_files');
  assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
});

test('worker rejects evidence whose stored bytes no longer match persisted metadata', async () => {
  const requirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-002');
  const uploaded = await upload(identities.evidence_contributor, requirement, Buffer.from('%PDF-1.4\nSynthetic integrity evidence\n'));
  const stored = await database.admin.query('SELECT storage_key,size_bytes FROM evidence_files WHERE id=$1', [uploaded.body.id]);
  await writeFile(resolve(storageRoot, stored.rows[0].storage_key), Buffer.alloc(Number(stored.rows[0].size_bytes), 0x58));
  const worker = await createVerifiedContext(pool, identities.worker.token);
  const first = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
  assert.equal(first.errorCode, 'EVIDENCE_INTEGRITY_MISMATCH');
  const second = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }), now: new Date(Date.now() + 61_000) });
  const third = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }), now: new Date(Date.now() + 122_000) });
  assert.equal(second.errorCode, 'EVIDENCE_INTEGRITY_MISMATCH');
  assert.equal(third.jobStatus, 'dead');
});

test('infected and unavailable scans fail closed', async () => {
  const requirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-003');
  const infected = await upload(identities.evidence_contributor, requirement, Buffer.from('%PDF-1.4\nEICAR TEST MARKER\n'));
  const worker = await createVerifiedContext(pool, identities.worker.token);
  const infectedResult = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
  assert.equal(infectedResult.scanStatus, 'infected');
  const rejected = await jsonRequest(`/v1/evidence/${infected.body.id}/review`, { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_reviewer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'accepted' }) });
  assert.equal(rejected.response.status, 409);
  const nextRequirement = requirements.find((item) => item.supplier_id === 'ACME-SUP-004');
  await upload(identities.evidence_contributor, nextRequirement, Buffer.from('%PDF-1.4\nUnavailable scanner case\n'));
  // A scanner outage is an infrastructure failure, so it no longer spends the evidence item's three
  // attempts. This block used to assert exactly that it did — `attempt` reaching 2 then 3, and the
  // job going `dead` after three outage cycles — which was the defect: every item
  // uploaded during an outage was condemned by a problem that was never the file's fault.
  //
  // The infrastructure budget is exercised with a deliberately small limit, so the boundary is tested rather
  // than described. The shipped default is 12.
  const outage = {
    pool: workerPool, identity: worker, storageRoot,
    scanner: { scan: async () => { throw Object.assign(new Error('Unavailable'), { code: 'MALWARE_SCANNER_UNAVAILABLE' }); } },
    maxInfrastructureAttempts: 3, random: () => 0.5,
  };
  const unavailable = await processNextScanJob({ ...outage });
  assert.equal(unavailable.scanStatus, 'error');
  assert.equal(unavailable.errorCode, 'MALWARE_SCANNER_UNAVAILABLE');
  assert.equal(unavailable.jobStatus, 'failed');
  assert.equal(unavailable.failureClass, 'infrastructure');
  assert.equal(unavailable.attempt, 0, 'an outage must not spend the item budget');
  assert.equal(unavailable.infrastructureAttempts, 1);
  const retryTwo = await processNextScanJob({ ...outage, now: new Date(Date.now() + 2_000_000) });
  assert.equal(retryTwo.attempt, 0);
  assert.equal(retryTwo.infrastructureAttempts, 2);
  assert.equal(retryTwo.jobStatus, 'failed');
  const retryThree = await processNextScanJob({ ...outage, now: new Date(Date.now() + 4_000_000) });
  assert.equal(retryThree.attempt, 0);
  assert.equal(retryThree.infrastructureAttempts, 3);
  assert.equal(retryThree.jobStatus, 'dead');
  assert.equal(retryThree.terminalReason, 'infrastructure_attempts_exhausted');
  const durable = await database.admin.query(
    'SELECT status,attempts,infrastructure_attempts,last_error_code,last_failure_class,terminal_reason FROM scan_jobs WHERE id=$1',
    [unavailable.jobId],
  );
  assert.deepEqual(durable.rows[0], {
    status: 'dead', attempts: 0, infrastructure_attempts: 3,
    last_error_code: 'MALWARE_SCANNER_UNAVAILABLE', last_failure_class: 'infrastructure',
    terminal_reason: 'infrastructure_attempts_exhausted',
  });
  const deniedRequeue = await jsonRequest(`/v1/scan-jobs/${unavailable.jobId}/requeue`, { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } });
  assert.equal(deniedRequeue.response.status, 404);
  const requeued = await jsonRequest(`/v1/scan-jobs/${unavailable.jobId}/requeue`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(requeued.response.status, 200);
  assert.deepEqual(
    { status: requeued.body.status, attempts: requeued.body.attempts, infrastructureAttempts: requeued.body.infrastructureAttempts },
    { status: 'pending', attempts: 0, infrastructureAttempts: 0 },
  );
  const requeueAudit = await database.admin.query(`SELECT count(*)::int count FROM audit_events WHERE action='evidence.scan.requeued' AND entity_id=$1`, [unavailable.evidenceId]);
  assert.equal(requeueAudit.rows[0].count, 1);
  // The requeue genuinely resets the infrastructure budget: three more outage cycles are needed to reach the
  // terminal state again. Leaving the counter at its limit would have made the requeue a no-op that
  // reported success.
  const redeadOne = await processNextScanJob({ ...outage, now: new Date(Date.now() + 6_000_000) });
  const redeadTwo = await processNextScanJob({ ...outage, now: new Date(Date.now() + 8_000_000) });
  const redeadThree = await processNextScanJob({ ...outage, now: new Date(Date.now() + 10_000_000) });
  assert.deepEqual(
    [redeadOne.infrastructureAttempts, redeadTwo.infrastructureAttempts, redeadThree.infrastructureAttempts, redeadThree.jobStatus],
    [1, 2, 3, 'dead'],
  );
  assert.deepEqual([redeadOne.attempt, redeadTwo.attempt, redeadThree.attempt], [0, 0, 0]);
  const statuses = await database.admin.query('SELECT scan_status FROM evidence_files WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 2', [tenantId]);
  assert.deepEqual(new Set(statuses.rows.map((row) => row.scan_status)), new Set(['infected','error']));
  const timeoutUpload = await upload(identities.evidence_contributor, nextRequirement, Buffer.from('%PDF-1.4\nSCAN_TIMEOUT_TEST\n'));
  assert.equal(timeoutUpload.response.status, 202);
  const timeout = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime:'test' }) });
  assert.equal(timeout.scanStatus, 'timeout');
  const cleaned = [];
  for (let index = 0; index < 4; index += 1) cleaned.push(await cleanupRetainedEvidence({ pool: workerPool, identity:worker, storageRoot, cutoff:new Date(Date.now() + 1000) }));
  assert.equal(cleaned.every((item) => item?.retentionStatus === 'deleted'), true);
  const retained = await database.admin.query(`SELECT count(*)::int AS count FROM evidence_files WHERE scan_status IN ('infected','error','timeout') AND retention_status='deleted'`);
  assert.equal(retained.rows[0].count, 4);
});

// ---------------------------------------------------------------------------------------------------
// Active content inside a permitted evidence type: PDF, PNG and JPG, exercised at the HTTP boundary.
//
// `evidence-validation.test.mjs` already calls `findActiveContent` directly. That proves the function; it
// does not prove that the upload route calls it, that a refusal leaves nothing behind, or that the types the
// function deliberately does *not* inspect are safe anyway. These cases test the route.
//
// They live in this file rather than one of their own on purpose. Each integration file starts its own
// PostgreSQL cluster, and a twelfth cluster in this workspace pushed an `initdb` past the harness's
// thirty-second bound under aggregate load — a suite that passed alone and failed in the gate. Sharing the
// fixtures that are already running here removes the contention instead of tuning the bound around it.
//
// The position asserted below is deliberately not one position, because the product does not have one:
//
//   PDF   — refused. `PDF_ACTIVE_MARKERS` in `evidence-service.mjs` rejects `/JavaScript`, `/OpenAction`,
//           `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/SubmitForm` and `/ImportData` before any row is
//           written. The source itself records that this is a marker list and not a PDF parser, so it is
//           evadable; the cases below assert the refusal and the evasion, not a claim of completeness.
//
//   PNG,   — stored, not refused, and not sanitised. `findActiveContent` returns null for every image type,
//   JPEG    by design: there is no marker in an image that can be refused without refusing real
//           photographs, and a script in a `tEXt` chunk or an EXIF comment is inert in every image decoder.
//           The mitigation is therefore not rejection, it is how the bytes come back out: an allow-listed
//           `Content-Type` that is never `text/html`, `Content-Disposition: attachment`,
//           `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`. Nothing in
//           OpenPPWR renders an evidence file — the API sends bytes, and the browser client saves the blob
//           through a `download` link. So these cases prove the *download semantics*, which is the control
//           that actually exists, rather than a rejection that does not.
//
// Every fixture is built here rather than committed as a binary, so what is being tested is readable.
// ---------------------------------------------------------------------------------------------------

// The payload every image fixture carries. It is the string a downstream viewer would have to execute for
// the risk to be realised, so the cases below assert it survives storage byte for byte — a test that passed
// because something quietly stripped it would be proving the wrong thing.
const IMAGE_PAYLOAD = '<script>alert(document.domain)</script><img src=x onerror=alert(1)>';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

// A complete 1x1 greyscale PNG — signature, IHDR, a `tEXt` chunk carrying whatever the caller wants, a real
// deflated IDAT and IEND. `tEXt` is the chunk an image editor writes a caption into, so this is the shape a
// real photograph with a poisoned caption has, not a hand-waved blob with a PNG header.
function pngCarrying(text) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])),
    pngChunk('IDAT', deflateSync(Buffer.from([0x00, 0xff]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Walks the chunk stream and recomputes every CRC. The fixtures are only worth anything if they really are
// well-formed PNGs, and asserting that here is cheaper than trusting the builder above.
function pngChunkTypes(png) {
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  const types = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length), `bad CRC on ${type}`);
    types.push(type);
    offset += 12 + length;
  }
  assert.equal(offset, png.length, 'trailing bytes after IEND');
  return types;
}

function jpegSegment(marker, payload) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

// The `Exif` identifier and its two padding bytes, written numerically because they are bytes and not text.
const EXIF_IDENTIFIER = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

// A real EXIF APP1: that identifier, a big-endian TIFF header, an IFD0 holding exactly one ImageDescription
// (0x010E) entry, and the string it points at. This is where a camera or an editor writes the caption, and
// it is the field asset managers and content systems render — which is precisely the downstream viewer this
// risk is about.
function exifApp1(description) {
  const text = Buffer.concat([Buffer.from(description, 'latin1'), Buffer.from([0])]);
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x010e, 10);
  tiff.writeUInt16BE(2, 12);
  tiff.writeUInt32BE(text.length, 14);
  tiff.writeUInt32BE(tiff.length, 18);
  tiff.writeUInt32BE(0, 22);
  return jpegSegment(0xe1, Buffer.concat([EXIF_IDENTIFIER, tiff, text]));
}

// SOI, the EXIF APP1 above, a COM comment segment carrying the same payload, EOI. The segment structure is
// real; there is no scan data, so this is not a decodable picture. That is deliberate and it changes nothing
// here: no control in the upload, storage or download path decodes an image, so a complete raster would
// exercise the same code with more bytes. The claim being tested is about metadata and headers, and the
// metadata is genuine.
function jpegCarrying(text) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    exifApp1(text),
    jpegSegment(0xfe, Buffer.from(text, 'latin1')),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// A PDF whose catalog fires a JavaScript action the moment the document opens. Both refused markers present.
const ACTIVE_PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
  '3 0 obj << /S /JavaScript /JS (app.alert\\(String.fromCharCode\\(88\\)\\);) >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
  '',
].join('\n'), 'latin1');

// The same document with the two markers replaced by ordinary ones. It exists so the refusal can be
// attributed to the markers rather than to the fixture being malformed: if this one were also refused, the
// case would be proving nothing.
const BENIGN_TWIN_PDF = Buffer.from(ACTIVE_PDF.toString('latin1')
  .replace('/OpenAction', '/Outlines')
  .replace('/S /JavaScript /JS', '/S /GoTo /D'), 'latin1');

// Valid as a PNG at byte 0 and containing a complete PDF body — including the markers — inside its `tEXt`
// chunk. Lenient PDF readers accept a `%PDF-` header anywhere in the first kilobyte, so this one file is two
// documents depending on who opens it.
const POLYGLOT = pngCarrying('%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction 2 0 R >> endobj\n2 0 obj << /S /JavaScript /JS (app.alert\\(1\\);) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

// The `Content-Type` values the product can ever put on a download: `evidence_files.detected_mime` is
// written from the extension allow-list in `evidence-service.mjs`, never from anything the client sent. None
// of them is a type a browser executes.
const ALLOWED_DOWNLOAD_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']);

const activeContentRequirement = () => requirements.find((item) => item.supplier_id === 'ACME-SUP-001');

async function quarantineEntries() {
  return (await readdir(resolve(storageRoot, tenantId, 'quarantine')).catch(() => [])).sort();
}

async function evidenceAndJobCounts() {
  const result = await database.admin.query(
    'SELECT (SELECT count(*)::int FROM evidence_files) AS evidence, (SELECT count(*)::int FROM scan_jobs) AS jobs',
  );
  return result.rows[0];
}

// Upload, let the worker mark it clean, have the reviewer accept it, then fetch it back. Returns the raw
// download response so the caller can assert on headers as well as bytes.
async function uploadThenDownload(bytes, { filename, mime }) {
  const uploaded = await upload(identities.evidence_contributor, activeContentRequirement(), bytes, { filename, mime });
  assert.equal(uploaded.response.status, 202, JSON.stringify(uploaded.body));
  // Drains the queue until this upload's own job comes up rather than assuming it is next. Coupling these
  // cases to queue order made a failure in one fail the others for a reason that had nothing to do with what
  // they assert, which hides the real result.
  const worker = await createVerifiedContext(pool, identities.worker.token);
  let scanned = null;
  for (let attempt = 0; attempt < 8 && scanned?.evidenceId !== uploaded.body.id; attempt += 1) {
    scanned = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
    if (!scanned) break;
  }
  assert.equal(scanned?.evidenceId, uploaded.body.id, 'the scan queue never produced this upload');
  assert.equal(scanned.scanStatus, 'clean');
  const accepted = await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.evidence_reviewer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'accepted' }),
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  const download = await fetch(`${baseUrl}/v1/evidence/${uploaded.body.id}/download`, { headers: { authorization: `Bearer ${identities.read_only_auditor.token}` } });
  return { uploaded, download, downloaded: Buffer.from(await download.arrayBuffer()) };
}

// The fixtures are the test. If they are not what the comments say they are, everything below is theatre.
test('the active-content fixtures are the file types they claim to be', () => {
  assert.deepEqual(pngChunkTypes(pngCarrying(IMAGE_PAYLOAD)), ['IHDR', 'tEXt', 'IDAT', 'IEND']);
  assert.deepEqual(pngChunkTypes(POLYGLOT), ['IHDR', 'tEXt', 'IDAT', 'IEND']);
  const jpeg = jpegCarrying(IMAGE_PAYLOAD);
  assert.deepEqual(jpeg.subarray(0, 4), Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'SOI must be followed by the EXIF APP1');
  assert.ok(jpeg.includes(EXIF_IDENTIFIER));
  assert.ok(jpeg.includes(Buffer.from(IMAGE_PAYLOAD, 'latin1')));
  assert.ok(ACTIVE_PDF.includes('/OpenAction') && ACTIVE_PDF.includes('/JavaScript'));
  assert.ok(!BENIGN_TWIN_PDF.includes('/OpenAction') && !BENIGN_TWIN_PDF.includes('/JavaScript'), 'the twin must carry no marker');
  assert.ok(POLYGLOT.includes('%PDF-') && POLYGLOT.includes('/OpenAction') && POLYGLOT.includes('/JavaScript'));
  // Typed by the product's own signature reader rather than by an assertion of my own about the first few
  // bytes, so "this file types as a PNG" means what the upload route means by it.
  assert.equal(detectEvidenceMime(POLYGLOT.subarray(0, 4096)), 'image/png');
  assert.equal(detectEvidenceMime(pngCarrying(IMAGE_PAYLOAD).subarray(0, 4096)), 'image/png');
  assert.equal(detectEvidenceMime(jpeg.subarray(0, 4096)), 'image/jpeg');
  assert.equal(detectEvidenceMime(ACTIVE_PDF.subarray(0, 4096)), 'application/pdf');
});

test('a PDF whose catalog fires JavaScript on open is refused and leaves nothing behind', async () => {
  const baseline = await evidenceAndJobCounts();
  const entriesBefore = await quarantineEntries();
  const refused = await upload(identities.evidence_contributor, activeContentRequirement(), ACTIVE_PDF, { filename: 'supplier-declaration.pdf', mime: 'application/pdf' });
  assert.equal(refused.response.status, 422);
  assert.equal(refused.body.error.code, 'EVIDENCE_ACTIVE_CONTENT');
  // Refused before the row, before the scan job and before the byte on disk — not registered and then
  // cleaned up, which would leave a window in which the file is scannable and downloadable.
  assert.deepEqual(await evidenceAndJobCounts(), baseline, 'a refused upload must create no evidence row and no scan job');
  assert.deepEqual(await quarantineEntries(), entriesBefore, 'a refused upload must leave no file in quarantine');

  // The control is a marker list, so prove it is the markers doing the work. The same document with
  // `/OpenAction` and `/JavaScript` swapped for ordinary names is accepted and scans clean, which means the
  // refusal above is not the fixture merely being unacceptable for some other reason.
  const twin = await upload(identities.evidence_contributor, activeContentRequirement(), BENIGN_TWIN_PDF, { filename: 'supplier-declaration.pdf', mime: 'application/pdf' });
  assert.equal(twin.response.status, 202, JSON.stringify(twin.body));
  const afterTwin = await evidenceAndJobCounts();
  assert.equal(afterTwin.evidence, baseline.evidence + 1);
  assert.equal(afterTwin.jobs, baseline.jobs + 1);
});

// The other half of the honest answer. Nothing here is refused, and the case says why that is the right
// outcome rather than pretending otherwise.
test('a PNG with a script in a tEXt chunk is stored unaltered and served as a non-executable attachment', async () => {
  const png = pngCarrying(IMAGE_PAYLOAD);
  const { uploaded, download, downloaded } = await uploadThenDownload(png, { filename: 'recycling-label.png', mime: 'image/png' });
  assert.equal(download.status, 200);

  // Stored, not sanitised. Said out loud in an assertion because the mitigation claim depends on it: the
  // product does not remove the payload, it refuses to be the thing that runs it.
  const stored = await database.admin.query('SELECT storage_key,detected_mime FROM evidence_files WHERE id=$1', [uploaded.body.id]);
  const onDisk = await readFile(resolve(storageRoot, stored.rows[0].storage_key));
  assert.ok(onDisk.includes(Buffer.from(IMAGE_PAYLOAD, 'latin1')), 'the payload must still be on disk — this is not about sanitisation');
  assert.deepEqual(onDisk, png);
  assert.deepEqual(downloaded, png, 'evidence must come back byte for byte');
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), uploaded.body.sha256);

  // The type is taken from the extension allow-list, not from what the uploader declared, so it can never be
  // a type a browser executes.
  assert.equal(stored.rows[0].detected_mime, 'image/png');
  assert.ok(ALLOWED_DOWNLOAD_TYPES.has(stored.rows[0].detected_mime));
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.doesNotMatch(download.headers.get('content-type'), /html|xml|javascript|svg/u);
  // The headers that are the actual mitigation.
  //
  // Asserted as a property rather than as an exact string. What has to hold is that the response is an
  // attachment named after the stored file — never inline, never a name the client chose. Anchoring on the
  // whole header additionally forbade RFC 6266's `filename*`, which the product has to emit: an evidence
  // filename may contain any Unicode letter, and interpolating one outside Latin-1 into a header throws at
  // download time, so a Polish `zaświadczenie.pdf` uploaded cleanly and could then never be retrieved.
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="recycling-label\.png"(?:;|$)/u);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(download.headers.get('cache-control'), 'no-store');
});

test('a JPEG with a payload in its EXIF description and COM comment is stored unaltered and served the same way', async () => {
  const jpeg = jpegCarrying(IMAGE_PAYLOAD);
  const { uploaded, download, downloaded } = await uploadThenDownload(jpeg, { filename: 'weight-certificate.jpg', mime: 'image/jpeg' });
  assert.equal(download.status, 200);
  const stored = await database.admin.query('SELECT storage_key,detected_mime FROM evidence_files WHERE id=$1', [uploaded.body.id]);
  const onDisk = await readFile(resolve(storageRoot, stored.rows[0].storage_key));
  assert.ok(onDisk.includes(Buffer.from(IMAGE_PAYLOAD, 'latin1')), 'the EXIF payload must survive storage untouched');
  assert.deepEqual(downloaded, jpeg);
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), uploaded.body.sha256);
  assert.equal(stored.rows[0].detected_mime, 'image/jpeg');
  assert.equal(download.headers.get('content-type'), 'image/jpeg');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="weight-certificate\.jpg"(?:;|$)/u);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
});

test('a PNG/PDF polyglot cannot enter under a PDF name, and under a PNG name it is stored under the same download semantics', async () => {
  const baseline = await evidenceAndJobCounts();
  // It cannot be uploaded as a PDF: the leading signature is a PNG, so the declared type, the extension and
  // the content disagree and the upload is refused before any active-content check is reached.
  const asPdf = await upload(identities.evidence_contributor, activeContentRequirement(), POLYGLOT, { filename: 'declaration.pdf', mime: 'application/pdf' });
  assert.equal(asPdf.response.status, 422);
  assert.equal(asPdf.body.error.code, 'EVIDENCE_MIME_MISMATCH');
  // Nor can the JavaScript-carrying PDF be smuggled in under a PNG name to skip the marker check: the same
  // three-way agreement refuses it from the other direction.
  const pdfAsPng = await upload(identities.evidence_contributor, activeContentRequirement(), ACTIVE_PDF, { filename: 'declaration.png', mime: 'image/png' });
  assert.equal(pdfAsPng.response.status, 422);
  assert.equal(pdfAsPng.body.error.code, 'EVIDENCE_MIME_MISMATCH');
  assert.deepEqual(await evidenceAndJobCounts(), baseline, 'neither mismatched upload may register anything');

  // Under its true type it is accepted, and this is the documented limitation rather than a defect being
  // hidden: `findActiveContent` does not inspect images, so the PDF markers inside this PNG are not seen.
  // What contains it is the download contract, identical to the plain image above — the file comes back as
  // an `image/png` attachment with `nosniff`, and nothing in OpenPPWR opens it as a PDF.
  const { uploaded, download, downloaded } = await uploadThenDownload(POLYGLOT, { filename: 'polyglot-label.png', mime: 'image/png' });
  assert.equal(download.status, 200);
  assert.deepEqual(downloaded, POLYGLOT);
  assert.ok(downloaded.includes('/JavaScript'), 'the PDF markers are still in the stored bytes, unrefused and unaltered');
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), uploaded.body.sha256);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="polyglot-label\.png"(?:;|$)/u);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
});

// The claim "the download type is never attacker-chosen" is what makes the download semantics worth
// anything, so it is asserted over every row this suite created rather than argued in a comment.
test('no stored evidence carries a content type outside the allow-list', async () => {
  const rows = await database.admin.query('SELECT detected_mime FROM evidence_files WHERE tenant_id=$1', [tenantId]);
  assert.ok(rows.rowCount > 0);
  for (const row of rows.rows) assert.ok(ALLOWED_DOWNLOAD_TYPES.has(row.detected_mime), `unexpected download type: ${row.detected_mime}`);
});
