// SPDX-License-Identifier: Apache-2.0
//
// The browser assertions in `workbench-screens.mjs` decide "this English text is on a Polish screen" by
// comparing the rendered string against the English catalog and permitting the handful of labels the two
// languages genuinely share. That allowlist is the one part of the check a human wrote from inspection,
// and an allowlist nobody re-derives is how a check quietly stops checking: translate "Status" into
// Polish next year and the entry becomes a licence to serve English in that position forever.
//
// So it is recomputed here, from the same key set the browser reads, and asserted both ways — an entry
// that is no longer identical fails just as loudly as a missing one. No browser, no database, milliseconds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogs, errorMessageKey, SUPPORTED_LOCALES } from '../../apps/web/src/i18n.js';
import { assertNarrowedView, checkedKeys, isCatalogString, REFUSALS, SHARED_WITH_ENGLISH } from './workbench-screens.mjs';

test('every catalog key the workbench assertions read exists in every locale', () => {
  const missing = [];
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of checkedKeys()) if (catalogs[locale][key] === undefined) missing.push(`${locale}:${key}`);
  }
  assert.deepEqual(missing, [], `a screen these assertions read is served by the English fallback:\n${missing.join('\n')}`);
});

test('the shared-with-English allowlist is exactly what the catalogs say it is', () => {
  const keys = [...checkedKeys()];
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === 'en') continue;
    const identical = keys.filter((key) => catalogs[locale][key] === catalogs.en[key]).sort();
    assert.deepEqual([...SHARED_WITH_ENGLISH[locale]].sort(), identical,
      `SHARED_WITH_ENGLISH.${locale} no longer matches the catalogs. Every entry is a position where an English string on a ${locale} screen is accepted, so each one has to be re-earned when the translations change.`);
  }
});

test('the allowlist is small enough to be read', () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(SHARED_WITH_ENGLISH[locale].size <= 5,
      `SHARED_WITH_ENGLISH.${locale} has grown to ${SHARED_WITH_ENGLISH[locale].size} entries; an allowlist that large is a locale falling back to English, not a coincidence of vocabulary`);
  }
});

test('a reason is recognized as this locale\'s only when the locale actually has it', () => {
  assert.ok(isCatalogString('pl', catalogs.pl.lockedHint), 'a Polish catalog string is Polish');
  assert.ok(!isCatalogString('pl', 'Sign in to enable the workflow actions below.'),
    'the English hint must not be accepted as Polish, which is exactly what the fallback would serve');
  assert.ok(!isCatalogString('de', 'Reason assembled in a component'), 'text from outside the catalog is not a catalog string');
});

// The sentence each refused operation is supposed to carry, stated in `REFUSALS` and compared here to
// the mapping the interface actually uses. Deriving the expectation from that mapping instead is what let
// a real regression through a full three-locale browser run: removing `GAP_OWNER_INVALID` from
// `ERROR_MESSAGE_KEYS` degrades the refusal to the generic 422 sentence — the user is told to check the
// values they entered, which is true of a different failure — and the check moved with it and agreed.
test('each refusal is still explained by the message written for it', () => {
  for (const refusal of REFUSALS) {
    assert.equal(errorMessageKey(refusal.code, refusal.status), refusal.key,
      `${refusal.code} is now explained with "${errorMessageKey(refusal.code, refusal.status)}" rather than "${refusal.key}". If that is deliberate, change the entry in REFUSALS; if it is not, the user is being handed a sentence written for another failure.`);
  }
});

// `assertNarrowedView` is the check that decides whether a supplier's screen withheld the other
// suppliers' records. Two of its three conditions cannot be reached by breaking the product: the "nothing
// was withheld" guard fires only on a fixture where every record is already in scope, and the "nothing was
// shown" guard only where the screen is empty. Both are the ways this check would stop checking without
// anyone noticing, so they are exercised directly rather than trusted.
test('a narrowed view is only accepted when it actually withheld something', () => {
  const own = ['ACME-SUP-001'];
  const tenant = ['ACME-SUP-001', 'ACME-SUP-002'];
  assert.deepEqual(
    assertNarrowedView({ shown: own, permitted: own, all: tenant, label: 'evidence', where: 'unit' }),
    { shown: 1, withheld: 1 },
  );
  assert.throws(
    () => assertNarrowedView({ shown: tenant, permitted: own, all: tenant, label: 'evidence', where: 'unit' }),
    /outside its scope: ACME-SUP-002/u,
    'a screen showing another supplier\'s record must fail',
  );
  assert.throws(
    () => assertNarrowedView({ shown: own, permitted: own, all: own, label: 'evidence', where: 'unit' }),
    /narrowing is not under test/u,
    'a fixture holding nothing outside the role\'s scope proves nothing and must say so',
  );
  assert.throws(
    () => assertNarrowedView({ shown: [], permitted: own, all: tenant, label: 'evidence', where: 'unit' }),
    /indistinguishable from "it failed to load"/u,
    'an empty screen is not evidence that anything was withheld',
  );
});

test('an interpolated catalog string is still recognized', () => {
  const template = 'This role does not hold {permission}.';
  const original = catalogs.en.lockPermissionProbe;
  catalogs.en.lockPermissionProbe = template;
  try {
    assert.ok(isCatalogString('en', 'This role does not hold review:freeze.'),
      'a reason built by substituting into a catalog template is still a catalog string');
    assert.ok(!isCatalogString('en', 'This role does not hold review:freeze'),
      'the match is anchored, so a near-miss is not accepted');
  } finally {
    if (original === undefined) delete catalogs.en.lockPermissionProbe; else catalogs.en.lockPermissionProbe = original;
  }
});
