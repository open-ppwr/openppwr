// SPDX-License-Identifier: Apache-2.0
//
// The demonstration seeding that `bootstrap-acme` performs, tested from both ends.
//
// Part one runs the *product*: an embedded PostgreSQL, the real API, the real rule, the shipped
// `acme-import-valid.json` and the real worker scan path. It performs exactly the sequence
// `seed_review_readiness` performs — one requirement per supplier, upload, scan, accept, assess — and pins
// the state a fresh demonstration is promised to land in: 28 packaging records, four accepted declarations,
// outcomes 16/1/1/10, and **two** open gaps. Two, not "whatever happened": the number is the promise the
// walkthrough and the deployment documents both make, and it is what makes the freeze reachable in a few
// minutes of real work rather than nineteen remediations. The same part proves the other half of the
// promise — that the freeze is still *earned*: it is refused while those two gaps are open, and succeeds
// once they are worked through assign/remediate/reassess.
//
// Part two runs the *installer*, with `docker` and `curl` replaced. It cannot assert business outcomes, and
// does not try to; what it asserts is the shape no in-process test can see — that each route is called with
// the credential of the role that holds its permission, that no evidence is reviewed before the scan says
// clean, that a re-run replays instead of uploading again, and that a scan verdict which never arrives ends
// in a bounded, reported refusal rather than a hang. The JSON expressions the installer embeds are executed
// for real by the `docker` stub, against the same files the shell wrote, so a broken expression fails here.
//
//   node --test scripts/installer/seed-demonstration.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const INSTALLER = resolve('scripts/installer/openppwr-installer');
const SHIPPED_SAMPLE = resolve('apps/web/public/downloads/acme-import-valid.json');

// The promised starting state. Stated once, here, and asserted rather than derived from the run: if the
// product's behaviour or the shipped dataset changes, this test fails and the published figures are
// corrected deliberately, instead of the test quietly agreeing with whatever the new behaviour is.
const EXPECTED_OUTCOMES = Object.freeze({ PASS: 16, FAIL: 1, UNKNOWN: 1, NOT_APPLICABLE: 10 });
const EXPECTED_OPEN_GAPS = 2;
const EXPECTED_SUPPLIERS = 4;

// ---------------------------------------------------------------------------------------------------
// Part one — the state a seeded demonstration really lands in.
// ---------------------------------------------------------------------------------------------------

const { createPool, migrate } = await import('@openppwr/database');
const { VerdictStubScanner, processNextScanJob } = await import('@openppwr/worker');
const { createApp, createVerifiedContext } = await import('../../apps/api/src/app.mjs');
const { startTestDatabase } = await import('../testing/embedded-postgres.mjs');

let database;
let pool;
let workerPool;
let server;
let baseUrl;
let storageRoot;
let identities;
let seeded;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
};
const bearer = (role) => ({ authorization: `Bearer ${identities[role].token}` });
const asJson = (role) => ({ ...bearer(role), 'content-type': 'application/json' });

// The declaration the installer writes and uploads: plain text, because `text/plain` is a permitted
// evidence type whose declared type, extension and content signature all agree, and because a reader who
// downloads it from the workbench gets something openable.
function declarationFor(supplierId) {
  return Buffer.from([
    'FICTIONAL ACME SAMPLE — NOT A REAL COMPLIANCE DOCUMENT',
    '',
    `Recycled-content declaration for supplier ${supplierId}.`,
    'Placed here by openppwr-installer bootstrap-acme so this demonstration starts with evidence',
    'already in place.',
    '',
  ].join('\n'), 'utf8');
}

// The installer's own selection rule, restated in JavaScript: the first requirement of each supplier, from
// the order the API returns, suppliers sorted. One accepted declaration per supplier is enough because an
// assessment resolves evidence by supplier and evidence type, not per packaging record.
function firstRequirementPerSupplier(items) {
  return items
    .filter((item, index, all) => all.findIndex((other) => other.supplier_id === item.supplier_id) === index)
    .sort((a, b) => (a.supplier_id < b.supplier_id ? -1 : a.supplier_id > b.supplier_id ? 1 : 0));
}

async function seedThroughTheProductsRoutes() {
  const requirements = await call('/v1/evidence-requirements', { headers: bearer('evidence_contributor') });
  assert.equal(requirements.status, 200);
  const targets = firstRequirementPerSupplier(requirements.body.items);
  assert.equal(targets.length, EXPECTED_SUPPLIERS, 'the shipped catalogue must derive requirements for four suppliers');

  const uploaded = [];
  for (const target of targets) {
    const form = new FormData();
    form.set('requirementId', target.id);
    form.set('supplierId', target.supplier_id);
    form.set('evidenceType', target.evidence_type);
    form.set(
      'file',
      new Blob([declarationFor(target.supplier_id)], { type: 'text/plain' }),
      `openppwr-seed-${target.supplier_id}.txt`,
    );
    const upload = await call('/v1/evidence', { method: 'POST', headers: bearer('evidence_contributor'), body: form });
    // 202, not 201: the file is in quarantine and queued for scanning, and cannot be reviewed yet.
    assert.equal(upload.status, 202, `upload for ${target.supplier_id} was refused: ${JSON.stringify(upload.body)}`);
    uploaded.push(upload.body.id);
  }

  // ClamAV fails closed, so review is unreachable until a verdict exists. In a deployment the installer
  // polls for it; here the worker's own job processor is driven directly.
  const worker = await createVerifiedContext(pool, identities.worker.token);
  for (let index = 0; index < uploaded.length; index += 1) {
    const scan = await processNextScanJob({
      pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }),
    });
    assert.equal(scan.scanStatus ?? scan.status, 'clean');
  }

  for (const evidenceId of uploaded) {
    const review = await call(`/v1/evidence/${evidenceId}/review`, {
      method: 'POST', headers: asJson('evidence_reviewer'), body: JSON.stringify({ decision: 'accepted' }),
    });
    assert.equal(review.status, 200, `review of ${evidenceId} was refused: ${JSON.stringify(review.body)}`);
  }

  const assessed = await call('/v1/assessments/run', { method: 'POST', headers: asJson('compliance_manager'), body: '{}' });
  assert.equal(assessed.status, 201);
  const gaps = await call('/v1/gaps?limit=500', { headers: bearer('compliance_manager') });
  assert.equal(gaps.status, 200);
  return { uploaded, outcomes: assessed.body.outcomes, gaps: gaps.body.items };
}

before(async () => {
  database = await startTestDatabase('installer-seed-demonstration');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  workerPool = createPool(database.workerUrl);
  storageRoot = resolve('.runtime-test', `installer-seed-${randomUUID()}`);
  await mkdir(storageRoot, { recursive: true });
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await call('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: JSON.stringify({ slug: 'acme-eu-demo', name: 'ACME Packaging Europe GmbH' }),
  });
  assert.equal(created.status, 201);
  identities = created.body.identities;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((closed) => (server ? server.close(closed) : closed()));
  await pool?.end();
  await workerPool?.end();
  await database?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

test('the catalogue the installer imports is the file the deployment serves', async () => {
  // The exact bytes, with the exact idempotency key the installer sends, through the editor credential —
  // not a generator-built copy that could drift from what a self-hoster actually downloads.
  const raw = await readFile(SHIPPED_SAMPLE, 'utf8');
  const imported = await call('/v1/imports', {
    method: 'POST',
    headers: { ...asJson('packaging_editor'), 'idempotency-key': 'openppwr-bootstrap-acme-catalogue' },
    body: raw,
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.rejectedRows, 0);
  assert.equal(imported.body.acceptedRows, 28);

  const catalogue = await call('/v1/catalog/summary', { headers: bearer('compliance_manager') });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.body.packaging, 28);
  assert.equal(catalogue.body.suppliers, EXPECTED_SUPPLIERS);
});

test('seeding leaves exactly two open gaps, and they are the two no upload can close', async () => {
  seeded = await seedThroughTheProductsRoutes();
  assert.deepEqual(seeded.outcomes, EXPECTED_OUTCOMES,
    'the seeded demonstration must reproduce the published starting outcome exactly');

  const open = seeded.gaps.filter((gap) => gap.status !== 'closed');
  assert.equal(open.length, EXPECTED_OPEN_GAPS,
    `seeding must leave exactly ${EXPECTED_OPEN_GAPS} gaps open, got ${open.length}`);
  // Named, because "two gaps" is only a useful promise if they are the two the walkthrough describes: a
  // packaging record declaring 5% against a 30% minimum, and one declaring nothing at all. Neither is
  // closable by uploading a document, which is precisely why they are the ones left.
  assert.deepEqual(
    open.map((gap) => `${gap.packaging_id}:${gap.deduplication_key}`).sort(),
    ['ACME-PKG-002:minimum-recycled-content', 'ACME-PKG-006:recycledContentPct'],
  );
  // And no gap was created for missing evidence: four uploads resolved every one of them.
  assert.equal(seeded.gaps.filter((gap) => gap.deduplication_key === 'RECYCLED_CONTENT_DECLARATION').length, 0);
});

test('re-seeding replays: no second upload, no second version, the same two gaps', async () => {
  const before = await call('/v1/evidence', { headers: bearer('evidence_contributor') });
  assert.equal(before.body.items.length, EXPECTED_SUPPLIERS);

  // What the installer's plan step does on a re-run: it recognises its own declarations by filename and
  // reuses them rather than uploading a second version.
  const requirements = await call('/v1/evidence-requirements', { headers: bearer('evidence_contributor') });
  const replayed = firstRequirementPerSupplier(requirements.body.items).map((target) => {
    const name = `openppwr-seed-${target.supplier_id}.txt`;
    return before.body.items.find((item) => item.normalized_filename === name);
  });
  assert.equal(replayed.filter(Boolean).length, EXPECTED_SUPPLIERS,
    'a re-run must find every declaration it uploaded before, by filename');
  assert.deepEqual(replayed.map((item) => item.version), [1, 1, 1, 1],
    'a replayed run must not stack a second version on an existing declaration');
  assert.deepEqual([...new Set(replayed.map((item) => item.review_status))], ['accepted'],
    'already-accepted evidence must not be reviewed again');

  // The import replays too, on the key the installer sends.
  const raw = await readFile(SHIPPED_SAMPLE, 'utf8');
  const reimported = await call('/v1/imports', {
    method: 'POST',
    headers: { ...asJson('packaging_editor'), 'idempotency-key': 'openppwr-bootstrap-acme-catalogue' },
    body: raw,
  });
  assert.equal(reimported.body.replayed, true);

  const gaps = await call('/v1/gaps?limit=500', { headers: bearer('compliance_manager') });
  assert.equal(gaps.body.items.filter((gap) => gap.status !== 'closed').length, EXPECTED_OPEN_GAPS);
});

test('the freeze is still earned: refused while the two gaps are open, granted once they are worked', async () => {
  const premature = await call('/v1/review-snapshots', { method: 'POST', headers: asJson('compliance_manager'), body: '{}' });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.error.code, 'READY_FOR_REVIEW_BLOCKED');

  const gaps = await call('/v1/gaps?limit=500', { headers: bearer('compliance_manager') });
  const open = gaps.body.items.filter((gap) => gap.status !== 'closed');
  for (const gap of open) {
    const assigned = await call(`/v1/gaps/${gap.id}/assign`, {
      method: 'POST', headers: asJson('compliance_manager'),
      body: JSON.stringify({ ownerId: identities.compliance_manager.id }),
    });
    assert.equal(assigned.body.status, 'assigned');
    const remediated = await call(`/v1/gaps/${gap.id}/remediate`, {
      method: 'POST', headers: asJson('compliance_manager'),
      body: JSON.stringify({ notes: 'Corrected the declared recycled content.', packagingPatch: { recycledContentPct: 40 } }),
    });
    assert.equal(remediated.body.status, 'remediated');
    const reassessed = await call(`/v1/gaps/${gap.id}/reassess`, { method: 'POST', headers: bearer('compliance_manager') });
    assert.equal(reassessed.body.results[0].outcome, 'PASS');
  }

  const frozen = await call('/v1/review-snapshots', {
    method: 'POST', headers: asJson('compliance_manager'), body: JSON.stringify({ locale: 'en' }),
  });
  assert.equal(frozen.status, 201, JSON.stringify(frozen.body));
  assert.equal(frozen.body.status, 'READY_FOR_REVIEW');
  const dossier = await call(`/v1/review-snapshots/${frozen.body.id}/dossier`, {
    method: 'POST', headers: bearer('compliance_manager'),
  });
  assert.equal(dossier.status, 201);
  assert.equal(dossier.body.artifacts.length, 4);
});

// ---------------------------------------------------------------------------------------------------
// Part two — the installer's own orchestration, with docker and curl replaced.
// ---------------------------------------------------------------------------------------------------

// The same shell selection `validate-installer.mjs` makes, for the same reason: `wsl.exe` needs `-e` or it
// wraps the command in a second shell that eats the `$`-expansions the script depends on.
const windowsShell = process.platform !== 'win32'
  ? null
  : spawnSync('wsl.exe', ['-e', 'sh', '-c', 'exit 0'], { encoding: 'utf8' }).status === 0
    ? { kind: 'wsl', executable: 'wsl.exe' }
    : { kind: 'git', executable: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe') };

function shellPath(path) {
  if (process.platform !== 'win32') return path;
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
  assert.ok(match, `cannot map Windows path: ${path}`);
  const prefix = windowsShell.kind === 'wsl' ? `/mnt/${match[1].toLowerCase()}` : `/${match[1].toLowerCase()}`;
  return `${prefix}/${match[2].replaceAll('\\', '/')}`;
}

function sh(script) {
  const args = ['-c', script];
  if (process.platform !== 'win32') return spawnSync('sh', args, { encoding: 'utf8' });
  return windowsShell.kind === 'wsl'
    ? spawnSync(windowsShell.executable, ['-e', 'sh', ...args], { encoding: 'utf8' })
    : spawnSync(windowsShell.executable, args, { encoding: 'utf8' });
}

// `docker` and `curl`, replaced.
//
// `docker` is not a mock of the JSON work: for `seed_read` it rewrites the container path back to the host
// directory and runs the installer's own expression through a real `node`, so an expression that is wrong
// fails this test rather than being asserted against a second copy of itself. For `seed_token` it answers
// with a distinguishable token per role, which is what lets the assertions below tell which credential each
// route was called with.
//
// `curl` records every invocation and answers from canned files. `sleep` is neutralised so the bounded
// five-minute wait is exercised in full without taking five minutes.
function stubs(root) {
  const dir = shellPath(root);
  return [
    `FIX='${dir}'`,
    'docker(){',
    '  args="$*"',
    '  script=""; mount=""; prev=""',
    '  for a in "$@"; do case "$prev" in -v) mount=$a;; -e) script=$a;; esac; prev=$a; done',
    '  case "$args" in',
    '    *"/state:ro"*)',
    '      case "$script" in',
    "        *evidence_contributor*) printf 'tok-contributor';;",
    "        *evidence_reviewer*) printf 'tok-reviewer';;",
    "        *compliance_manager*) printf 'tok-manager';;",
    "        *packaging_editor*) printf 'tok-editor';;",
    '        *) return 1;;',
    '      esac',
    '      ;;',
    '    *"/seed:ro"*)',
    '      host=${mount%%:*}',
    '      rest=${mount#*:}; cpath=${rest%%:*}',
    '      rewritten=$(printf \'%s\' "$script" | sed "s|$cpath/|./|g")',
    '      ( cd "$host" && node -e "$rewritten" )',
    '      ;;',
    '    *) return 1;;',
    '  esac',
    '}',
    'sleep(){ :; }',
    'curl(){',
    '  printf \'%s\\n\' "$*" >> "$FIX/curl.log"',
    '  out=""; prev=""',
    '  for a in "$@"; do case "$prev" in -o) out=$a;; esac; prev=$a; done',
    '  case "$*" in',
    '    *v1/evidence-requirements*) body="$FIX/reply/requirements.json";;',
    '    *requirementId=*) body="$FIX/reply/upload.json";;',
    '    *"/review"*) body="$FIX/reply/review.json";;',
    '    *v1/assessments/run*) body="$FIX/reply/assessment.json";;',
    '    *v1/assessments*) body="$FIX/reply/assessments.json";;',
    '    *v1/gaps*) body="$FIX/reply/gaps.json";;',
    '    *v1/evidence*)',
    '      n=$(cat "$FIX/polls"); n=$((n + 1)); printf \'%s\' "$n" > "$FIX/polls"',
    '      if [ -f "$FIX/reply/evidence-$n.json" ]; then body="$FIX/reply/evidence-$n.json";',
    '      else body="$FIX/reply/evidence-last.json"; fi',
    '      ;;',
    '    *) return 1;;',
    '  esac',
    '  [ -f "$body" ] || return 1',
    '  if [ -n "$out" ] && [ "$out" != /dev/null ]; then cat "$body" > "$out"; fi',
    '  return 0',
    '}',
  ].join('\n');
}

async function fixture(replies) {
  const root = await mkdtemp(join(tmpdir(), 'openppwr-seed-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await mkdir(join(root, 'reply'), { recursive: true });
  await writeFile(join(root, 'polls'), '0');
  await writeFile(join(root, 'curl.log'), '');
  for (const [name, value] of Object.entries(replies)) {
    await writeFile(join(root, 'reply', name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

function runSeeding(root) {
  return sh([
    `OPENPPWR_INSTALL_ROOT=${shellPath(root)}`,
    'OPENPPWR_INSTALLER_LIB=1',
    `. ${shellPath(INSTALLER)}`,
    stubs(root),
    'seed_review_readiness 31114 openppwr:test',
  ].join('\n'));
}

// Two suppliers, one of them holding a second requirement, so "one upload per supplier" is a claim this
// fixture can actually falsify. The identifiers share no prefix, so a substring search over the recorded
// call cannot confuse one for another.
const REQUIREMENTS = {
  items: [
    { id: 'alpha', packaging_id: 'ACME-PKG-001', supplier_id: 'ACME-SUP-001', evidence_type: 'RECYCLED_CONTENT_DECLARATION' },
    { id: 'bravo', packaging_id: 'ACME-PKG-002', supplier_id: 'ACME-SUP-002', evidence_type: 'RECYCLED_CONTENT_DECLARATION' },
    { id: 'charlie', packaging_id: 'ACME-PKG-005', supplier_id: 'ACME-SUP-001', evidence_type: 'RECYCLED_CONTENT_DECLARATION' },
  ],
};
const TWO_OPEN_GAPS = {
  items: [
    { id: 'GAP-A', packaging_id: 'ACME-PKG-002', deduplication_key: 'minimum-recycled-content', status: 'open' },
    { id: 'GAP-B', packaging_id: 'ACME-PKG-006', deduplication_key: 'recycledContentPct', status: 'open' },
  ],
};

test('the installer calls each route with the credential of the role that holds its permission', async () => {
  const root = await fixture({
    'requirements.json': REQUIREMENTS,
    'upload.json': { id: 'evidence-1', scanStatus: 'pending' },
    'review.json': { id: 'evidence-1', reviewStatus: 'accepted' },
    'evidence-1.json': { items: [] },
    // The scan is still pending on the first poll and clean on the second: the wait is exercised, not
    // short-circuited.
    'evidence-2.json': { items: [{ id: 'evidence-1', normalized_filename: 'openppwr-seed-ACME-SUP-001.txt', version: 1, scan_status: 'pending', review_status: 'pending' }] },
    'evidence-last.json': { items: [{ id: 'evidence-1', normalized_filename: 'openppwr-seed-ACME-SUP-001.txt', version: 1, scan_status: 'clean', review_status: 'pending' }] },
    'assessments.json': { items: [] },
    'assessment.json': { outcomes: { PASS: 16, FAIL: 1, UNKNOWN: 1, NOT_APPLICABLE: 10 } },
    'gaps.json': TWO_OPEN_GAPS,
  });
  try {
    const run = runSeeding(root);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /BOOTSTRAP_SEED_READY /u, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /open_gaps=2/u);
    assert.match(run.stdout, /outcomes=PASS:16,FAIL:1,UNKNOWN:1,NOT_APPLICABLE:10/u);
    assert.match(run.stdout, /scan=clean/u);

    const calls = (await readFile(join(root, 'curl.log'), 'utf8')).trim().split('\n');
    const find = (needle) => calls.filter((line) => line.includes(needle));

    // One requirement per supplier, not one per requirement: two suppliers in the fixture, two uploads.
    assert.equal(find('requirementId=').length, 2, `uploads: ${calls.join(' | ')}`);
    assert.ok(find('requirementId=alpha').length === 1 && find('requirementId=bravo').length === 1,
      'the first requirement of each supplier must be the one used');
    assert.equal(find('requirementId=charlie').length, 0, 'a supplier must not be uploaded for twice');

    // The role each route is called as. This is the assertion the whole part exists for: a seeded state
    // produced under the wrong credential is a state the audit chain records against the wrong actor.
    for (const line of find('/v1/evidence-requirements')) assert.match(line, /Bearer tok-contributor/u);
    for (const line of find('requirementId=')) assert.match(line, /Bearer tok-contributor/u);
    for (const line of find('/review')) assert.match(line, /Bearer tok-reviewer/u);
    for (const line of find('/v1/assessments/run')) assert.match(line, /Bearer tok-manager/u);
    for (const line of find('/v1/gaps')) assert.match(line, /Bearer tok-manager/u);

    // Ordering: nothing is reviewed before a clean verdict exists. The review call must come after the
    // poll that first reported clean.
    const firstReview = calls.findIndex((line) => line.includes('/review'));
    const pollsBeforeReview = calls.slice(0, firstReview).filter((line) => line.includes('/v1/evidence') && !line.includes('requirementId=')).length;
    assert.ok(firstReview > 0, 'no review was attempted at all');
    assert.ok(pollsBeforeReview >= 3, `review ran after only ${pollsBeforeReview} evidence reads; the scan wait was skipped`);

    // The uploads are declared as text/plain, which is what makes them pass content typing.
    for (const line of find('requirementId=')) assert.match(line, /type=text\/plain/u);

    // Nothing is left behind: the work directory held the declarations and the API responses.
    assert.ok(!existsSync(join(root, 'state', 'seed-work')), 'the seeding work directory was not removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a re-run replays: evidence already uploaded and accepted is neither uploaded nor reviewed again', async () => {
  const held = {
    items: [
      { id: 'evidence-1', normalized_filename: 'openppwr-seed-ACME-SUP-001.txt', version: 1, scan_status: 'clean', review_status: 'accepted' },
      { id: 'evidence-2', normalized_filename: 'openppwr-seed-ACME-SUP-002.txt', version: 1, scan_status: 'clean', review_status: 'accepted' },
    ],
  };
  const root = await fixture({
    'requirements.json': REQUIREMENTS,
    'evidence-last.json': held,
    'assessments.json': { items: [{ id: 'assessment-1' }] },
    'gaps.json': TWO_OPEN_GAPS,
  });
  try {
    const run = runSeeding(root);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /BOOTSTRAP_SEED_READY /u);
    assert.match(run.stdout, /open_gaps=2/u);
    assert.match(run.stdout, /outcomes=replayed/u, 'a replay must not re-run the assessment');

    const calls = (await readFile(join(root, 'curl.log'), 'utf8')).trim().split('\n');
    assert.equal(calls.filter((line) => line.includes('requirementId=')).length, 0, 'a replay uploaded again');
    assert.equal(calls.filter((line) => line.includes('/review')).length, 0, 'a replay reviewed again');
    assert.equal(calls.filter((line) => line.includes('/v1/assessments/run')).length, 0, 'a replay ran the assessment again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scan verdict that never arrives is bounded, reported, and never reviewed anyway', async () => {
  const root = await fixture({
    'requirements.json': REQUIREMENTS,
    'upload.json': { id: 'evidence-1', scanStatus: 'pending' },
    'evidence-1.json': { items: [] },
    'evidence-last.json': { items: [{ id: 'evidence-1', normalized_filename: 'openppwr-seed-ACME-SUP-001.txt', version: 1, scan_status: 'pending', review_status: 'pending' }] },
    'gaps.json': TWO_OPEN_GAPS,
  });
  try {
    const run = runSeeding(root);
    // Non-fatal by design: bootstrap cannot be run a second time, so a failure here must report and let the
    // deployment continue rather than dead-end it.
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /BOOTSTRAP_WARN demonstration_state=catalogue_only reason=scan_not_clean_after_300s/u);
    assert.doesNotMatch(run.stdout, /BOOTSTRAP_SEED_READY/u);

    const calls = (await readFile(join(root, 'curl.log'), 'utf8')).trim().split('\n');
    assert.equal(calls.filter((line) => line.includes('/review')).length, 0,
      'evidence was reviewed without a clean scan verdict');
    assert.equal(calls.filter((line) => line.includes('/v1/assessments/run')).length, 0);
    // The wait really is bounded, and it really did wait: 60 attempts, and then it stopped.
    const polls = Number((await readFile(join(root, 'polls'), 'utf8')).trim());
    assert.equal(polls, 61, `expected 1 pre-upload read and 60 bounded polls, got ${polls}`);
    assert.ok(!existsSync(join(root, 'state', 'seed-work')), 'an abandoned attempt left its work directory behind');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
