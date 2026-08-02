// SPDX-License-Identifier: Apache-2.0
// The sample files an operator actually receives must import into the product that ships them.
//
// Every other import test uses the *generator's return value* (`createAcmeSupplementalCsv()` and friends).
// What a person downloads is the *exported file*, and the export step prepends a fiction marker the
// generator output does not carry. The two drifted apart and nothing compared them, so all three published
// CSV samples were rejected by this product's own importer with `IMPORT_CSV_HEADER_INVALID` — discovered by
// following the published walkthrough on a real deployment, not by any test here.
//
// These assertions read the bytes from disk, exactly as the web tier serves them, so the thing under test is
// the artifact rather than the function that fed it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseImportPayload } from '../src/import-service.mjs';

// The samples are produced by the exporter, not committed: `apps/web/public/downloads/` is gitignored and
// written by the web build. Reading that directory made this suite depend on a build having already run in
// the same tree, which is true on a developer's machine and false on a fresh checkout — so the clean-install
// validation, whose whole purpose is to run the exported source with nothing left over, failed here with
// ENOENT while every local run passed.
//
// Generating into a temporary directory is not a workaround for that: it is the more honest test. The
// generator is deterministic and verified against a checksum manifest, so these are byte-for-byte the files
// the build writes and an operator downloads, and the suite no longer passes or fails on whether somebody
// happened to build first.
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let DOWNLOADS;

before(async () => {
  DOWNLOADS = await mkdtemp(join(tmpdir(), 'openppwr-samples-'));
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/acme/acme-dataset.mjs'), 'export', '--out', DOWNLOADS], { cwd: ROOT, stdio: 'pipe' });
});

after(async () => {
  if (DOWNLOADS) await rm(DOWNLOADS, { recursive: true, force: true });
});

const read = (name) => readFile(join(DOWNLOADS, name), 'utf8');

test('every published CSV sample carries the fiction marker', async () => {
  const csvFiles = (await readdir(DOWNLOADS)).filter((name) => name.endsWith('.csv'));
  assert.ok(csvFiles.length >= 3, `expected the published CSV samples to be present, found ${csvFiles.length}`);
  for (const name of csvFiles) {
    const text = await read(name);
    assert.ok(
      text.startsWith('#'),
      `${name} must identify itself as fiction on its first line, so a copy found loose is not mistaken for a real compliance record`,
    );
  }
});

test('every published CSV sample is accepted by the importer that ships with it', async () => {
  const csvFiles = (await readdir(DOWNLOADS)).filter((name) => name.endsWith('.csv'));
  for (const name of csvFiles) {
    const text = await read(name);
    // The deliberately invalid sample must still parse: its whole purpose is to be accepted as a
    // well-formed document and then rejected row by row, which is what demonstrates the validation report.
    // A header failure would refuse the file wholesale and demonstrate nothing.
    const parsed = parseImportPayload(text, 'text/csv');
    assert.equal(parsed.schemaVersion, '1.0', `${name} must parse as schema 1.0`);
    assert.ok(parsed.packaging.length > 0, `${name} must yield at least one row`);
    assert.ok(
      parsed.packaging.every((row) => !String(row.id).startsWith('#')),
      `${name} must not carry the marker through as a data row`,
    );
  }
});

test('a comment line is special only before the header, never in place of a record', () => {
  const body = [
    '# a marker',
    'id,name,packagingType,country,supplierId,recycledContentPct,bomId,bomVersion,componentIds',
    'PKG-1,First,sales,PL,SUP-1,50,BOM-1,1,CMP-1',
    '#PKG-2,Second,sales,PL,SUP-1,50,BOM-2,1,CMP-2',
  ].join('\n');
  const parsed = parseImportPayload(body, 'text/csv');
  assert.equal(parsed.packaging.length, 2, 'a row whose first field merely begins with # is data, and dropping it would silently lose a record');
  assert.equal(parsed.packaging[1].id, '#PKG-2');
});

test('a file that is nothing but comments is refused as empty, not as a bad header', () => {
  assert.throws(
    () => parseImportPayload('# only a marker\n# and another\n', 'text/csv'),
    (error) => error.code === 'IMPORT_CSV_EMPTY',
    'skipping comments must not turn an empty file into a header complaint',
  );
});
