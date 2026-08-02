// SPDX-License-Identifier: Apache-2.0
// Deterministic ACME sample-data generator.
//
//   node scripts/acme/acme-dataset.mjs generate [--out DIR]
//   node scripts/acme/acme-dataset.mjs validate
//   node scripts/acme/acme-dataset.mjs export [--out DIR]
//   node scripts/acme/acme-dataset.mjs verify-checksums [--out DIR]
//
// The dataset is produced by pure functions with no randomness, clock or environment input,
// so regenerating always yields byte-identical files and the manifest can be verified.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ACME_DATASET,
  ACME_FICTION_MARKER,
  acmeDatasetCounts,
  canonicalAcmeJson,
  createAcmeDataset,
  createAcmeInvalidImport,
  createAcmeSupplementalCsv,
  createAcmeValidJsonImport,
  validateAcmeDataset,
} from '../../packages/testing/src/index.mjs';

const command = process.argv[2] || 'validate';
const outFlag = process.argv.indexOf('--out');
const outputRoot = resolve(outFlag > 0 ? process.argv[outFlag + 1] : 'artifacts/acme');
const MANIFEST = 'checksum-manifest.json';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validCsv() {
  const dataset = createAcmeDataset();
  const header = 'id,name,packagingType,country,supplierId,recycledContentPct,bomId,bomVersion,componentIds';
  const rows = dataset.packaging.slice(0, 28).map((row) => [
    row.id, row.name, row.packagingType, row.country, row.supplierId,
    row.recycledContentPct ?? '', row.bom.id, row.bom.version,
    row.bom.lines.map((line) => line.componentId).join('|'),
  ].join(','));
  return `# ${ACME_FICTION_MARKER}\n${[header, ...rows].join('\n')}\n`;
}

function invalidCsv() {
  const invalid = createAcmeInvalidImport();
  const header = 'id,name,packagingType,country,supplierId,recycledContentPct,bomId,bomVersion,componentIds';
  const rows = invalid.packaging.map((row) => [
    row.id, row.name, row.packagingType, row.country, row.supplierId,
    row.recycledContentPct ?? '', row.bom?.id ?? '', row.bom?.version ?? '',
    (row.bom?.lines ?? []).map((line) => line.componentId).join('|'),
  ].join(','));
  return `# ${ACME_FICTION_MARKER}\n${[header, ...rows].join('\n')}\n`;
}

function files() {
  return {
    'acme-dataset.json': canonicalAcmeJson(),
    'acme-import-valid.json': `${JSON.stringify({ marker: ACME_FICTION_MARKER, ...createAcmeValidJsonImport() }, null, 2)}\n`,
    'acme-import-invalid.json': `${JSON.stringify({ marker: ACME_FICTION_MARKER, ...createAcmeInvalidImport() }, null, 2)}\n`,
    'acme-import-valid.csv': validCsv(),
    'acme-import-invalid.csv': invalidCsv(),
    'acme-import-supplemental.csv': `# ${ACME_FICTION_MARKER}\n${createAcmeSupplementalCsv()}\n`,
    'README.md': [
      `# ${ACME_FICTION_MARKER}`,
      '',
      'Every organisation, supplier, packaging record, material, component and document in',
      'these files is invented. Nothing here describes a real company or a real compliance',
      'position, and none of it may be used as or presented as a compliance document.',
      '',
      `Seed: ${ACME_DATASET.seed}`,
      `Schema version: ${ACME_DATASET.schemaVersion}`,
      `Generator version: ${ACME_DATASET.generatorVersion}`,
      '',
      'Regenerate with `node scripts/acme/acme-dataset.mjs generate`, then verify with',
      '`node scripts/acme/acme-dataset.mjs verify-checksums`.',
      '',
    ].join('\n'),
  };
}

async function generate() {
  await mkdir(outputRoot, { recursive: true });
  const produced = files();
  const manifest = { ...ACME_DATASET, marker: ACME_FICTION_MARKER, counts: acmeDatasetCounts(), files: {} };
  for (const [name, content] of Object.entries(produced)) {
    await writeFile(resolve(outputRoot, name), content, 'utf8');
    manifest.files[name] = sha256(content);
  }
  await writeFile(resolve(outputRoot, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`ACME_GENERATE_PASS out=${outputRoot} files=${Object.keys(produced).length}`);
}

async function verifyChecksums() {
  const manifestPath = resolve(outputRoot, MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'));
  if (!manifest) {
    console.error(`ACME_CHECKSUM_FAIL no manifest at ${manifestPath} — run generate first`);
    process.exitCode = 1;
    return;
  }
  const problems = [];
  if (manifest.generatorVersion !== ACME_DATASET.generatorVersion) problems.push(`generator version drifted: manifest ${manifest.generatorVersion}, code ${ACME_DATASET.generatorVersion}`);
  const expected = files();
  for (const [name, content] of Object.entries(expected)) {
    const recorded = manifest.files?.[name];
    if (!recorded) { problems.push(`${name}: missing from manifest`); continue; }
    if (recorded !== sha256(content)) problems.push(`${name}: regenerated content does not match the manifest checksum (generator is not deterministic, or files were edited by hand)`);
    const onDisk = await readFile(resolve(outputRoot, name), 'utf8').catch(() => null);
    if (onDisk === null) problems.push(`${name}: recorded in the manifest but missing on disk`);
    else if (sha256(onDisk) !== recorded) problems.push(`${name}: file on disk does not match its recorded checksum`);
  }
  const unexpected = (await readdir(outputRoot)).filter((name) => name !== MANIFEST && !expected[name]);
  if (unexpected.length) problems.push(`unexpected files in the export directory: ${unexpected.join(',')}`);
  if (problems.length) { console.error(`ACME_CHECKSUM_FAIL\n${problems.join('\n')}`); process.exitCode = 1; }
  else console.log(`ACME_CHECKSUM_PASS files=${Object.keys(expected).length} generator=${manifest.generatorVersion}`);
}

function validate() {
  const result = validateAcmeDataset();
  const markerProblems = Object.entries(files())
    .filter(([name]) => name !== 'acme-dataset.json')
    .filter(([, content]) => !content.includes(ACME_FICTION_MARKER))
    .map(([name]) => `${name}: generated sample does not carry the fiction marker`);
  const problems = [...result.problems, ...markerProblems];
  if (problems.length) { console.error(`ACME_VALIDATE_FAIL\n${problems.join('\n')}`); process.exitCode = 1; }
  else console.log(`ACME_VALIDATE_PASS ${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
}

if (command === 'generate' || command === 'export') await generate();
else if (command === 'verify-checksums') await verifyChecksums();
else if (command === 'validate') validate();
else { console.error(`Unknown command: ${command}. Use generate, export, validate or verify-checksums.`); process.exitCode = 1; }
