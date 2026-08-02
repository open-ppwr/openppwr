import test from 'node:test';
import assert from 'node:assert/strict';
import { FICTION_DISCLAIMER, buildDossierArtifacts, verifyChecksumManifest } from '../src/index.mjs';

const snapshot = {
  schemaVersion: '1.0.0', locale: 'en', generatedAt: '2026-07-28T12:00:00.000Z', tenantId: 'ACME-EU-DEMO',
  organization: 'ACME Packaging Europe GmbH', assessment: { id: 'A-1', outcome: 'PASS', ruleId: 'OPENPPWR-DEMO-001', ruleVersion: '1.0.0' },
  evidence: [{ id: 'ACME-EVD-001', checksum: 'a'.repeat(64) }], gaps: [], auditVerification: { valid: true },
};

test('builds byte-deterministic JSON, PDF, ZIP and checksum manifest', async () => {
  const a = await buildDossierArtifacts(snapshot);
  const b = await buildDossierArtifacts(structuredClone(snapshot));
  assert.deepEqual(a, b);
  assert.match(a.pdf.toString('ascii', 0, 8), /^%PDF-1\./);
  assert.equal(JSON.parse(a.json).assessment.ruleVersion, '1.0.0');
  assert.equal(verifyChecksumManifest(a.manifest, a.files), true);
  assert.equal(a.zip.readUInt32LE(0), 0x04034b50);
});

test('checksum verification detects tampering', async () => {
  const artifacts = await buildDossierArtifacts(snapshot);
  const changed = artifacts.files.map((file) => file.name === 'dossier.json' ? { ...file, content: Buffer.from('{}') } : file);
  assert.equal(verifyChecksumManifest(artifacts.manifest, changed), false);
});

for(const locale of ['pl','de'])test(`renders a deterministic ${locale.toUpperCase()} Unicode dossier`,async()=>{
  const localized={...snapshot,locale,organization:locale==='pl'?'ACME Łódź — Żółć':'ACME Köln — Größe'};
  const a=await buildDossierArtifacts(localized);
  const b=await buildDossierArtifacts(structuredClone(localized));
  assert.deepEqual(a,b);
  assert.equal(a.pdf.subarray(0,5).toString(),'%PDF-');
});

// A dossier used to declare its own contents fictional no matter whose data it held, because this module
// wrote a constant over the disclaimer the tenant row has carried since migration 001. These three cases
// are the whole of the rule, and the third is the one that keeps the first two safe.
const realTenant = {
  ...snapshot,
  organization: { id: 't-1', slug: 'real-co', name: 'Real Packaging Sp. z o.o.', disclaimer: '' },
};

test('a tenant that says its data is real produces a dossier with no fiction disclaimer', async () => {
  const artifacts = await buildDossierArtifacts(realTenant);
  const dossier = JSON.parse(artifacts.json);
  assert.equal(dossier.disclaimer, '', 'an explicit empty disclaimer must survive to the document');
  assert.doesNotMatch(artifacts.json, /fictional/u, 'nothing in the JSON may still call this data fictional');
  // The PDF is checksummed and shipped alongside the JSON, so proving only the JSON changed would leave the
  // document a reader actually opens unverified. Compared against the same snapshot carrying the marker:
  // identical inputs but for the disclaimer must not produce identical bytes.
  const marked = await buildDossierArtifacts({ ...realTenant, organization: { ...realTenant.organization, disclaimer: FICTION_DISCLAIMER } });
  assert.notDeepEqual(artifacts.pdf, marked.pdf, 'the disclaimer must reach the rendered PDF, not only the JSON');
});

test('a tenant carrying its own disclaimer gets that one, verbatim', async () => {
  const wording = 'Prepared for internal review. Not a regulatory submission.';
  const artifacts = await buildDossierArtifacts({ ...realTenant, organization: { ...realTenant.organization, disclaimer: wording } });
  assert.equal(JSON.parse(artifacts.json).disclaimer, wording);
});

// The direction of the default is the security property here. A snapshot written before this change, or a
// tenant created without anyone answering the question, must still be marked -- losing the marker has to
// require someone to have said so.
test('a snapshot with no tenant disclaimer is still marked fictional', async () => {
  for (const organization of [
    'ACME Packaging Europe GmbH',
    { id: 't-2', slug: 'acme', name: 'ACME' },
    { id: 't-3', slug: 'acme', name: 'ACME', disclaimer: null },
    undefined,
  ]) {
    const artifacts = await buildDossierArtifacts({ ...snapshot, organization });
    assert.equal(JSON.parse(artifacts.json).disclaimer, FICTION_DISCLAIMER, `unmarked for organization ${JSON.stringify(organization)}`);
  }
});
