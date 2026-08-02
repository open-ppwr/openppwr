import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACME_EXPECTED_COUNTS, canonicalAcmeJson, createAcmeCatalog, createAcmeDataset, createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport, validateAcmeDataset } from '../src/index.mjs';

test('ACME generator has approved independent shape', () => {
  const catalog = createAcmeCatalog();
  assert.equal(catalog.packaging.length, 32);
  assert.equal(catalog.materials.length, 18);
  assert.equal(catalog.components.length, 40);
  assert.equal(catalog.suppliers.length, 4);
  assert.equal(catalog.packaging.filter((item) => item.packagingType === 'sales').length, 12);
  assert.equal(catalog.packaging.filter((item) => item.packagingType === 'grouped').length, 6);
  assert.equal(catalog.packaging.filter((item) => item.packagingType === 'transport').length, 6);
  assert.equal(catalog.packaging.filter((item) => item.packagingType === 'ecommerce').length, 4);
  assert.equal(catalog.packaging.filter((item) => item.packagingType === 'reusable').length, 4);
  assert.equal(createAcmeValidJsonImport().packaging.length, 28);
  assert.equal(createAcmeInvalidImport().packaging.length, 8);
  assert.equal(createAcmeSupplementalCsv().split('\n').length - 1, 4);
});

test('ACME identifiers and names contain no legacy/customer mapping', () => {
  const serialized = JSON.stringify(createAcmeCatalog());
  const deniedLegacyMarker = String.fromCharCode(107, 105, 101, 108);
  assert.equal(serialized.toLowerCase().includes(deniedLegacyMarker), false);
  assert.match(serialized, /Example Polymers GmbH/);
});

test('dataset validation enforces the published shape and catches drift', () => {
  const result = validateAcmeDataset();
  assert.equal(result.valid, true, result.problems.join('; '));
  assert.deepEqual(result.counts, ACME_EXPECTED_COUNTS);
  const broken = createAcmeDataset();
  broken.packaging = broken.packaging.slice(0, 10);
  assert.equal(validateAcmeDataset(broken).valid, false);
});

test('canonical JSON is stable regardless of property insertion order', () => {
  const first = createAcmeDataset();
  const reordered = { boms: first.boms, organizations: first.organizations, ...first };
  assert.equal(canonicalAcmeJson(first), canonicalAcmeJson(reordered));
});

test('every organisation and supplier is flagged fictional and uses a reserved example domain', () => {
  const dataset = createAcmeDataset();
  for (const entry of [...dataset.organizations, ...dataset.suppliers]) {
    assert.equal(entry.fictional, true, `${entry.id} is not flagged fictional`);
    assert.match(entry.contact, /@[a-z0-9-]+\.example$/, `${entry.id} does not use a reserved example domain`);
  }
});

test('supplier scenarios cover the four demonstrated evidence paths', () => {
  const scenarios = createAcmeDataset().suppliers.map((supplier) => supplier.scenario);
  assert.deepEqual(scenarios, ['complete_accepted', 'missing_recycled_content', 'expired_then_replaced', 'mime_mismatch_then_clean']);
});
