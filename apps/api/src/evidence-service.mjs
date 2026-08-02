import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import Busboy from 'busboy';
import { appendAudit, withTenantTransaction } from '@openppwr/database';

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const allowed = new Map([
  ['.pdf','application/pdf'],
  ['.png','image/png'],
  ['.jpg','image/jpeg'],
  ['.jpeg','image/jpeg'],
  ['.txt','text/plain'],
  ['.csv','text/csv'],
]);

function uploadError(code, message, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

export function normalizeEvidenceFilename(input) {
  const value = String(input || '').normalize('NFKC').trim();
  if (!value || value !== basename(value) || value.includes('..') || /[\x00-\x1f\x7f]/.test(value)) throw uploadError('EVIDENCE_FILENAME_INVALID', 'Filename is invalid.');
  const extension = extname(value).toLowerCase();
  if (!allowed.has(extension)) throw uploadError('EVIDENCE_EXTENSION_INVALID', 'File extension is not allowed.');
  const stem = value.slice(0, -extension.length);
  if (!stem || stem.includes('.')) throw uploadError('EVIDENCE_DOUBLE_EXTENSION', 'Double extensions are not allowed.');
  return { normalized: `${stem.replace(/[^\p{L}\p{N}_ -]/gu, '_')}${extension}`, extension, expectedMime: allowed.get(extension) };
}

export function detectEvidenceMime(head) {
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  try { if (!head.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(head) !== undefined) return 'text/plain'; } catch { return 'application/octet-stream'; }
  return 'application/octet-stream';
}

// Active content inside a type that is otherwise permitted, narrowed to two concrete cases with the
// exact bytes that reach them: a PDF carrying `/JavaScript`, `/OpenAction` or an embedded file, and a CSV
// cell that a spreadsheet will evaluate as a formula.
//
// The permitted set is PDF, PNG, JPEG, TXT and CSV, so SVG and HTML — the usual carriers — are already out.
// What remains is a PDF that carries an action, and a CSV whose cells are formulas. Both pass every check
// the product had: the declared type, the extension and the leading signature all agree, and ClamAV
// correctly reports them clean, because neither is malware. They are documents that do something when
// opened.
//
// What this is not: a document sanitiser. It refuses an upload that carries the markers below and says which
// one. A structural PDF parser is the complete answer and is out of scope for Community L2; refusing the
// unambiguous cases is the part that can be done honestly now.
// Only markers long enough that a chance occurrence in a compressed stream is not a realistic worry.
//
// `/JS` and `/AA` were in this list and were removed. A PDF's content streams are usually FlateDecode
// binary, and a specific three-byte sequence appears in a megabyte of binary with roughly six percent
// probability — so those two would refuse ordinary supplier documents at a rate that makes the control worse
// than the risk. The same reasoning removed a hex-encoded-name heuristic (`/J#61vaScript`), which is a real
// evasion technique I cannot distinguish from binary noise without parsing the file properly.
//
// The consequence is stated rather than hidden: this refuses the unambiguous cases, and an attacker who knows
// about it can evade it. Active-content handling therefore stays **partially mitigated**, not closed. The
// complete answer is
// a structural PDF parser, which is out of scope for Community L2.
//
// Measured, not assumed: run against all 155 PDFs this repository has generated (up to 21 KB), none were
// flagged. That establishes no false positives on documents the product itself produces. It does *not*
// establish a rate on real-world compressed supplier PDFs, of which I have none — and that limitation is
// exactly why the two short markers are gone.
const PDF_ACTIVE_MARKERS = Object.freeze([
  '/JavaScript', '/OpenAction', '/Launch', '/EmbeddedFile', '/RichMedia', '/SubmitForm', '/ImportData',
]);

// A cell beginning with `=` or `@` is a formula in every spreadsheet that opens it.
const CSV_FORMULA_LEAD = /^\s*[=@]/u;
// `+` and `-` are a formula only when what follows is not simply a number. Refusing every leading minus would
// refuse `-5`, and a compliance dataset legitimately contains negative numbers — a control that rejects valid
// evidence is not a safer control, it is a broken one.
const CSV_SIGNED_LEAD = /^\s*[+-]/u;
const CSV_PLAIN_NUMBER = /^\s*[+-]?\d+(?:[.,]\d+)?\s*$/u;

// A naive `row.split(',')` checked the quote character, not the cell: `"=2+2",safe` split into the cell
// `"=2+2"`, whose first character is `"`, not `=` — CSV_FORMULA_LEAD never matched, and a spreadsheet that
// unquotes the field before evaluating it opens exactly the formula this control exists to refuse
// unquoted. Quoting is not an edge case of CSV, it is the feature that makes a comma or a newline
// representable inside a cell — a parser that does not honour it is not parsing CSV. This does, per
// RFC 4180: a doubled quote inside a quoted field is a literal quote, a quoted field may contain commas and
// newlines, and rows end at an unquoted line break.
// A quote is a real RFC4180 field-open only as the very first character of a cell — `cell === ''` is
// exactly that condition, checked before any other character has been appended for this field. A quote
// appearing after content has already accumulated (`safe"foo,=2+2`)
// is not well-formed CSV, and treating it as an opener anyway swallowed the rest of the line as one long
// quoted cell, including the delimiter in front of the formula that followed: the row parsed as one cell,
// `CSV_FORMULA_LEAD` never saw a cell starting with `=`, and the control this file exists to provide missed
// exactly the input a real spreadsheet still evaluates as two cells with a formula in the second. Treated as
// a literal character instead, matching how a lenient real-world CSV reader (and a spreadsheet's own import)
// actually resolves a stray quote — the parse still ends with `=2+2` as its own cell.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let unterminatedQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      if (cell === '') { inQuotes = true; continue; }
      cell += char; continue;
    }
    // Comma was the only delimiter recognised, and the whole formula-injection defence hangs off cell
    // boundaries: `safe;=2+2` parsed as one cell whose text merely contains an equals sign, so nothing
    // fired, while `safe,=2+2` was caught. That is the wrong way round for this product. Excel uses the
    // list separator of the operating system's locale, which is `;` across Polish, German, French and most
    // of the EU — the languages this product ships in — and a `sep=;` first line makes Excel use it
    // regardless of locale. Tab and pipe are the other two delimiters spreadsheet exports actually emit.
    //
    // The reviewer downloads evidence as an attachment and opens it in their own spreadsheet application,
    // where the `Content-Disposition` and `nosniff` headers that contain an embedded payload no longer help
    // at all. Splitting on any of the four costs nothing: a real comma inside a quoted cell is already
    // handled above, and a semicolon or tab in unquoted prose only ever splits a cell that was going to be
    // scanned either way.
    if (char === ',' || char === ';' || char === '\t' || char === '|') { row.push(cell); cell = ''; continue; }
    // A bare `\r` was silently dropped regardless of what followed it, so `safe\r=2+2` folded into one
    // cell, `safe=2+2`, and the formula was never in a cell of its own. `\r\n` is one
    // row boundary, not two: the `\r` here only defers to the `\n` immediately after it; a `\r` with no
    // `\n` following — the classic Mac line ending some spreadsheet exports still use — ends the row on
    // its own, exactly as `\n` does.
    if (char === '\r') {
      if (text[i + 1] === '\n') continue;
      row.push(cell); rows.push(row); row = []; cell = ''; continue;
    }
    if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  if (inQuotes) unterminatedQuote = true;
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return { rows, unterminatedQuote };
}

export function findActiveContent(content, expectedMime) {
  if (expectedMime === 'application/pdf') {
    // Case-sensitive: these are PDF name objects, and `/javascript` is not one. The whole file is searched
    // rather than the first 4 KB, because an action placed after the header is exactly the interesting case
    // and the typing check only ever looked at the head.
    const text = content.toString('latin1');
    for (const marker of PDF_ACTIVE_MARKERS) {
      if (text.includes(marker)) return { kind: 'pdf_action', marker };
    }
    return null;
  }
  if (expectedMime === 'text/csv') {
    const { rows, unterminatedQuote } = parseCsvRows(content.toString('utf8'));
    for (const [index, row] of rows.entries()) {
      for (const [column, cell] of row.entries()) {
        const formula = CSV_FORMULA_LEAD.test(cell) || (CSV_SIGNED_LEAD.test(cell) && !CSV_PLAIN_NUMBER.test(cell));
        if (formula) return { kind: 'csv_formula', marker: `row ${index + 1}, column ${column + 1}` };
      }
    }
    // A quote opened and never closed is not well-formed CSV, and what the rest of the file was folded
    // into as a result is not a parse this control can vouch for one way or the other — refused rather
    // than trusted on the strength of a parse that admits it did not resolve.
    if (unterminatedQuote) return { kind: 'csv_malformed_unterminated_quote' };
    return null;
  }
  return null;
}

function safeTarget(root, tenantId, name) {
  const tenantRoot = resolve(root, tenantId, 'quarantine');
  const target = resolve(tenantRoot, name);
  if (!target.startsWith(`${tenantRoot}${sep}`)) throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  return { tenantRoot, target };
}

// `safeTarget` confines the target lexically only: `resolve` plus `startsWith` proves the *string* stays
// under the root, not that the *directory* does. If `<root>/<tenantId>/quarantine` (or `<tenantId>` itself)
// is a symlink, both the temporary and the final write follow it to wherever the link points, outside
// storageRoot entirely — the same class of gap already closed on the worker's tombstone-directory handling,
// never applied to this write path. Checked once the directory is known to exist, by comparing
// its resolved real path against the root's, exactly as the worker does.
async function assertConfinedDirectory(root, directory) {
  let canonicalRoot;
  let canonicalDirectory;
  try {
    [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  } catch {
    throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  }
  const expected = resolve(canonicalRoot, relative(root, directory));
  if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)) {
    throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  }
  if (canonicalDirectory !== expected) {
    throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  }
}

export async function readVerifiedEvidence(storageRoot, evidence) {
  const tenantId = evidence.tenant_id || evidence.tenantId;
  const storageKey = evidence.storage_key || evidence.storageKey;
  const expectedSize = Number(evidence.size_bytes ?? evidence.sizeBytes);
  const expectedSha256 = evidence.sha256;
  const expectedPrefix = `${tenantId}/quarantine/`;
  if (!tenantId || !storageKey?.startsWith(expectedPrefix) || storageKey.slice(expectedPrefix.length).includes('/')) {
    throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  }
  const target = resolve(storageRoot, storageKey);
  const root = resolve(storageRoot);
  if (!target.startsWith(`${root}${sep}`)) throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
  const content = await readFile(target).catch(() => { throw uploadError('EVIDENCE_STORAGE_UNAVAILABLE', 'Evidence storage is unavailable.', 500); });
  if (content.length !== expectedSize || createHash('sha256').update(content).digest('hex') !== expectedSha256) {
    throw uploadError('EVIDENCE_INTEGRITY_MISMATCH', 'Evidence integrity verification failed.', 500);
  }
  return content;
}

// A tenant reset deletes the evidence_files row; the quarantine bytes on disk were never removed by
// anything, and survived indefinitely, including into later backups. This is the reset's
// best-effort follow-up, called after the row is already gone — a file that is already absent, or a key
// that fails confinement, is not re-thrown here, because the database deletion already committed and is
// authoritative; a leftover byte on disk after a reset is a cleanup gap to log, not a reason to report the
// reset itself as failed.
export async function removeEvidenceStorageKey(storageRoot, tenantId, storageKey) {
  const expectedPrefix = `${tenantId}/quarantine/`;
  if (!storageKey?.startsWith(expectedPrefix) || storageKey.slice(expectedPrefix.length).includes('/')) return false;
  const root = resolve(storageRoot);
  const target = resolve(root, storageKey);
  if (!target.startsWith(`${root}${sep}`)) return false;
  try {
    // Lexical confinement above proves the *string*, not the directory — the same class of gap
    // `assertConfinedDirectory` already closed for the upload path, missed here because this cleanup was
    // added afterwards. A symlinked tenant or quarantine directory would otherwise let
    // this `rm` follow it to a target outside storageRoot. Checked against the parent's real path rather
    // than the file's own — the file may already be gone, which is a normal outcome here, not a failure.
    // A first version of this check only required the parent to resolve *somewhere* under the root, which
    // a symlink swapped for a *different* in-root tenant's directory would still satisfy (targeted
    // rereview) — compared instead against the exact canonical directory this key's own tenant/quarantine
    // prefix names.
    const canonicalRoot = await realpath(root);
    const canonicalParent = await realpath(dirname(target)).catch(() => null);
    if (canonicalParent === null) return false;
    const expectedParent = resolve(canonicalRoot, relative(root, dirname(target)));
    if (canonicalParent !== expectedParent) return false;
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function receiveEvidenceUpload(request, { pool, identity, storageRoot }) {
  if (!request.headers['content-type']?.startsWith('multipart/form-data')) throw uploadError('EVIDENCE_MULTIPART_REQUIRED', 'Multipart upload is required.', 415);
  const root = resolve(storageRoot);
  const temporaryId = randomUUID();
  const temporary = safeTarget(root, identity.tenantId, `${temporaryId}.upload`);
  await mkdir(temporary.tenantRoot, { recursive: true, mode: 0o700 });
  await assertConfinedDirectory(root, temporary.tenantRoot);
  let fields = {};
  let fileInfo;
  let byteCount = 0;
  let head = Buffer.alloc(0);
  let digest;
  let output;
  let filePromise;
  let fileError;
  let finalTarget;
  try {
    await new Promise((resolveUpload, rejectUpload) => {
      let parser;
      try { parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 8, fileSize: MAX_EVIDENCE_BYTES } }); }
      catch (error) { rejectUpload(uploadError('EVIDENCE_MULTIPART_INVALID', error.message)); return; }
      parser.on('field', (name, value) => { if (value.length <= 256) fields[name] = value; });
      parser.on('file', (_name, stream, info) => {
        if (fileInfo) { stream.resume(); rejectUpload(uploadError('EVIDENCE_FILE_COUNT_INVALID', 'Exactly one file is required.')); return; }
        fileInfo = info;
        digest = createHash('sha256');
        output = createWriteStream(temporary.target, { flags: 'wx', mode: 0o600 });
        filePromise = new Promise((resolveFile, rejectFile) => {
          stream.on('limit', () => rejectFile(uploadError('EVIDENCE_TOO_LARGE', 'Evidence exceeds the 10 MiB limit.', 413)));
          stream.on('data', (chunk) => {
            byteCount += chunk.length;
            digest.update(chunk);
            if (head.length < 4096) head = Buffer.concat([head, chunk]).subarray(0, 4096);
          });
          stream.on('error', rejectFile);
          output.on('error', rejectFile);
          output.on('finish', resolveFile);
          stream.pipe(output);
        }).catch((error) => { fileError = error; });
      });
      parser.on('error', rejectUpload);
      parser.on('finish', async () => {
        try { if (filePromise) await filePromise; if (fileError) throw fileError; resolveUpload(); } catch (error) { rejectUpload(error); }
      });
      request.pipe(parser);
    });
    if (!fileInfo || !byteCount) throw uploadError('EVIDENCE_EMPTY', 'Empty evidence is not allowed.');
    const filename = normalizeEvidenceFilename(fileInfo.filename);
    const detectedMime = detectEvidenceMime(head);
    const declaredMime = String(fileInfo.mimeType || '').toLowerCase();
    const detectedCompatible = filename.expectedMime === 'text/csv' ? detectedMime === 'text/plain' : detectedMime === filename.expectedMime;
    if (declaredMime !== filename.expectedMime || !detectedCompatible) throw uploadError('EVIDENCE_MIME_MISMATCH', 'Declared type, extension and content signature do not match.');
    // Active content, checked on the whole file rather than the head. The typing above reads 4 KB, which is
    // the right amount to identify a format and the wrong amount to find an action placed after it.
    // Reading the temporary file back is bounded by the 10 MiB upload limit, and it is
    // the copy whose digest was just computed, so there is no window in which a different file is inspected.
    if (filename.expectedMime === 'application/pdf' || filename.expectedMime === 'text/csv') {
      const active = findActiveContent(await readFile(temporary.target), filename.expectedMime);
      if (active) {
        throw uploadError(
          active.kind === 'csv_formula' ? 'EVIDENCE_SPREADSHEET_FORMULA' : 'EVIDENCE_ACTIVE_CONTENT',
          active.kind === 'csv_formula'
            ? 'A spreadsheet cell begins with a formula character, which executes when the file is opened.'
            : active.kind === 'csv_malformed_unterminated_quote'
              ? 'The file has a quoted field that never closes, which this check cannot parse with confidence.'
              : 'The document carries an action or embedded file, which executes or unpacks when the file is opened.',
        );
      }
    }
    const evidenceId = randomUUID();
    const finalName = `${evidenceId}${filename.extension}`;
    const final = safeTarget(root, identity.tenantId, finalName);
    await assertConfinedDirectory(root, final.tenantRoot);
    await rename(temporary.target, final.target);
    // `assertConfinedDirectory` proves the directory's real path a moment ago; `realpath` on a resolved
    // path is a snapshot, not a lock, and the directory could be replaced with a symlink in the gap between
    // that check and this rename. A first version of this re-check only required the
    // renamed file to resolve to *somewhere* under the root, which a symlink swapped for *another* in-root
    // tenant's directory would still satisfy — the write would land in the wrong tenant's files, not
    // outside the root, and this check would have missed it. Compared instead against
    // the exact expected canonical parent, the same way `assertConfinedDirectory` itself does, so only the
    // one directory this upload was actually meant for passes.
    const rootCanonicalAfterRename = await realpath(root).catch(() => null);
    const tenantRootCanonicalAfterRename = await realpath(final.tenantRoot).catch(() => null);
    const finalCanonical = await realpath(final.target).catch(() => null);
    const expectedTenantRoot = rootCanonicalAfterRename && resolve(rootCanonicalAfterRename, relative(root, final.tenantRoot));
    const valid = rootCanonicalAfterRename && tenantRootCanonicalAfterRename && finalCanonical
      && tenantRootCanonicalAfterRename === expectedTenantRoot
      && finalCanonical === resolve(tenantRootCanonicalAfterRename, basename(final.target));
    if (!valid) {
      await rm(final.target, { force: true }).catch(() => {});
      throw uploadError('EVIDENCE_STORAGE_PATH_INVALID', 'Storage path is invalid.', 500);
    }
    finalTarget = final.target;
    await chmod(final.target, 0o600).catch(() => {});
    const sha256 = digest.digest('hex');
    return await withTenantTransaction(pool, identity, async (client) => {
      const requirement = await client.query('SELECT * FROM evidence_requirements WHERE id=$1', [fields.requirementId]);
      if (!requirement.rowCount) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
      const expected = requirement.rows[0];
      if (expected.supplier_id !== fields.supplierId || expected.evidence_type !== fields.evidenceType) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
      if (identity.role === 'supplier_user' && identity.supplierId !== fields.supplierId) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
      const version = await client.query('SELECT coalesce(max(version),0)::int + 1 AS next FROM evidence_files WHERE requirement_id=$1', [fields.requirementId]);
      await client.query(
        `INSERT INTO evidence_files (tenant_id,id,requirement_id,supplier_id,evidence_type,version,original_filename,normalized_filename,declared_mime,detected_mime,size_bytes,sha256,storage_key,scan_status,uploaded_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15)`,
        [identity.tenantId,evidenceId,fields.requirementId,fields.supplierId,fields.evidenceType,version.rows[0].next,fileInfo.filename,filename.normalized,declaredMime,filename.expectedMime,byteCount,sha256,`${identity.tenantId}/quarantine/${finalName}`,identity.actorId,fields.expiresAt || null],
      );
      const jobId = randomUUID();
      await client.query(`INSERT INTO scan_jobs (tenant_id,id,evidence_id) VALUES ($1,$2,$3)`, [identity.tenantId,jobId,evidenceId]);
      await appendAudit(client, { tenantId: identity.tenantId, actorId: identity.actorId, action: 'evidence.quarantined', entityType: 'evidence', entityId: evidenceId, payload: { supplierId: fields.supplierId, sha256, sizeBytes: byteCount } });
      return { id: evidenceId, scanStatus: 'pending', reviewStatus: 'pending', sha256, sizeBytes: byteCount, jobId };
    });
  } catch (error) {
    output?.destroy();
    await rm(temporary.target, { force: true }).catch(() => {});
    if (finalTarget) await rm(finalTarget, { force: true }).catch(() => {});
    throw error;
  }
}

export async function reviewEvidence(pool, identity, { evidenceId, decision, rejectionCode = null, at = new Date() }) {
  if (!['accepted','rejected'].includes(decision)) throw uploadError('EVIDENCE_REVIEW_DECISION_INVALID', 'Review decision is invalid.', 400);
  return withTenantTransaction(pool, identity, async (client) => {
    const selected = await client.query('SELECT * FROM evidence_files WHERE id=$1 FOR UPDATE', [evidenceId]);
    if (!selected.rowCount) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
    const evidence = selected.rows[0];
    if (decision === 'accepted' && evidence.scan_status !== 'clean') throw uploadError('EVIDENCE_NOT_CLEAN', 'Only clean evidence may be accepted.', 409);
    if (decision === 'accepted' && evidence.expires_at && new Date(evidence.expires_at) <= at) throw uploadError('EVIDENCE_EXPIRED', 'Expired evidence may not be accepted.', 409);
    await client.query(
      `UPDATE evidence_files SET review_status=$1,reviewed_by=$2,reviewed_at=$3,rejection_code=$4 WHERE id=$5`,
      [decision,identity.actorId,at.toISOString(),decision === 'rejected' ? rejectionCode || 'reviewer_rejected' : null,evidenceId],
    );
    await appendAudit(client, { tenantId: identity.tenantId, actorId: identity.actorId, action: `evidence.${decision}`, entityType: 'evidence', entityId: evidenceId, payload: { scanStatus: evidence.scan_status, rejectionCode: decision === 'rejected' ? rejectionCode || 'reviewer_rejected' : null }, occurredAt: at.toISOString() });
    return { id: evidenceId, scanStatus: evidence.scan_status, reviewStatus: decision };
  });
}

// The operator remedy for a job in its terminal state. Both retry budgets are reset, because the operator
// is asserting that the reason it stopped has been dealt with — and leaving the infrastructure counter at
// its limit would make the requeue a no-op that reported success.
export async function requeueDeadScanJob(pool, identity, { jobId, at = new Date() }) {
  return withTenantTransaction(pool, identity, async (client) => {
    const selected = await client.query(
      'SELECT id,evidence_id,status,attempts,infrastructure_attempts,last_error_code,last_failure_class,terminal_reason FROM scan_jobs WHERE id=$1',
      [jobId],
    );
    if (!selected.rowCount) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
    const job = selected.rows[0];
    if (job.status !== 'dead') throw uploadError('SCAN_JOB_NOT_DEAD', 'Only a scan job that requires attention can be requeued.', 409);
    // Direct scan-state UPDATE belongs only to the worker. This constrained operation preserves the one
    // request-side write the product needs: dead -> pending, with both tables and its audit record changed
    // atomically.
    const requeued = await client.query(
      'SELECT requeue_openppwr_scan_job($1,$2,$3) AS requeued',
      [job.id, at.toISOString(), identity.credentialHash ?? null],
    );
    if (requeued.rows[0].requeued !== true) {
      throw uploadError('SCAN_JOB_NOT_DEAD', 'Only a scan job that requires attention can be requeued.', 409);
    }
    return { jobId: job.id, evidenceId: job.evidence_id, status: 'pending', attempts: 0, infrastructureAttempts: 0 };
  });
}

// The operator's view of the scanning queue: what is waiting, what is running, and what has stopped and
// needs a person. Without this the terminal state was reachable only by requeueing a job identifier the
// operator had no way to obtain — a remedy with no diagnosis.
export async function listScanJobs(pool, identity, { requiresAttentionOnly = false } = {}) {
  return withTenantTransaction(pool, identity, async (client) => {
    const result = await client.query(
      `SELECT id,evidence_id,status,attempts,infrastructure_attempts,last_error_code,last_failure_class,
              terminal_reason,terminal_at,available_at,correlation_id,created_at,updated_at
       FROM scan_jobs ${requiresAttentionOnly ? "WHERE status='dead'" : ''} ORDER BY created_at,id`,
    );
    return {
      items: result.rows.map((row) => ({
        jobId: row.id,
        evidenceId: row.evidence_id,
        status: row.status,
        // `dead` is the database value and stays the database value; an operator is told what to do about
        // it rather than being handed a tombstone.
        requiresAttention: row.status === 'dead',
        attempts: Number(row.attempts),
        infrastructureAttempts: Number(row.infrastructure_attempts),
        lastErrorCode: row.last_error_code,
        lastFailureClass: row.last_failure_class,
        terminalReason: row.terminal_reason,
        terminalAt: row.terminal_at,
        availableAt: row.available_at,
        correlationId: row.correlation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });
}

export async function evidencePathForDownload(client, { evidenceId, identity, storageRoot }) {
  const result = await client.query('SELECT * FROM evidence_files WHERE id=$1', [evidenceId]);
  if (!result.rowCount) throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  const evidence = result.rows[0];
  if (evidence.scan_status !== 'clean') throw uploadError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  return { evidence, content: await readVerifiedEvidence(storageRoot, evidence) };
}
