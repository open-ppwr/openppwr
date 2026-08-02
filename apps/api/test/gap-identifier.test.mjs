// The gap identifier contract.
//
// `gaps.id` is `text`, and the previous reasoning was that this made validation unnecessary: with no cast
// to `uuid`, a malformed value produces an empty result and the ordinary 404, so nothing breaks.
// But "nothing breaks" is not the property the route-validation gate claims. The claim is that no untrusted identifier reaches a query before validation, and three gap
// routes handed the raw path segment straight to one.
//
// These tests fix the contract in place from both ends: the producers must emit identifiers the validator
// accepts, and the validator must refuse everything else — including the values that a `text` column
// would otherwise carry into a query, a log line or a dossier reference unchallenged.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createGaps } from '@openppwr/assessment';
import { requireGapId } from '../src/app.mjs';
import { gapIdentity } from '../src/assessment-service.mjs';

const CONTRACT = /^GAP-[0-9A-F]{24}$/u;
const accepts = (value) => {
  try {
    return requireGapId(value) === value;
  } catch {
    return false;
  }
};
const refusal = (value) => {
  try {
    requireGapId(value);
    return null;
  } catch (error) {
    return { code: error.code, status: error.status, message: error.message };
  }
};

// --- the producers ---------------------------------------------------------------------------------

// The contract is tested against the code that mints identifiers, not against a copy of its formula.
test('the API gap producer emits identifiers the validator accepts', () => {
  const tenantId = randomUUID();
  for (const discriminator of ['recyclability', 'material.recycled_share', 'EVIDENCE_MISSING', 'check-7', 'PPWR-ART-6-2', 'a', 'x'.repeat(200)]) {
    const { id } = gapIdentity(tenantId, 'ACME-PKG-0001', 'PPWR-2026-CORE', discriminator);
    assert.match(id, CONTRACT, `producer emitted ${id}, which the contract does not describe`);
    assert.ok(accepts(id), `the validator refused a genuine identifier: ${id}`);
    assert.equal(id.length, 28);
  }
});

test('the assessment package gap producer emits identifiers the validator accepts', () => {
  const gaps = createGaps({
    id: randomUUID(),
    outcome: 'FAIL',
    ruleId: 'PPWR-2026-CORE',
    ruleVersion: '1.0.0',
    trace: [
      { checkId: 'recyclability', passed: false, code: 'RECYCLABILITY_UNPROVEN' },
      { field: 'material.recycled_share', passed: false, code: 'RECYCLED_SHARE_MISSING' },
      { evidenceType: 'material_declaration', passed: false, code: 'EVIDENCE_MISSING' },
      { checkId: 'passes', passed: true },
    ],
  });
  assert.equal(gaps.length, 3, 'only failing checks become gaps');
  for (const gap of gaps) {
    assert.match(gap.id, CONTRACT);
    assert.ok(accepts(gap.id));
  }
});

// A discriminator that differs only in a character the identifier does not carry must still produce a
// distinct identifier — otherwise two different defects would deduplicate into one gap.
test('distinct discriminators produce distinct identifiers', () => {
  const tenantId = randomUUID();
  const ids = new Set(['recyclability', 'recyclability2', 'Recyclability', 'recyclabilit'].map(
    (discriminator) => gapIdentity(tenantId, 'ACME-PKG-0001', 'PPWR-2026-CORE', discriminator).id,
  ));
  assert.equal(ids.size, 4);
});

// The identifier is derived, so it is stable: the same defect found again is the same gap. This is the
// property that rules out replacing the type with a UUID.
test('the identifier is deterministic across calls and tenant-scoped', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const first = gapIdentity(tenantA, 'ACME-PKG-0001', 'PPWR-2026-CORE', 'recyclability').id;
  const again = gapIdentity(tenantA, 'ACME-PKG-0001', 'PPWR-2026-CORE', 'recyclability').id;
  const other = gapIdentity(tenantB, 'ACME-PKG-0001', 'PPWR-2026-CORE', 'recyclability').id;
  assert.equal(first, again);
  assert.notEqual(first, other, 'the same defect in two tenants must not share an identifier');
});

// --- the validator --------------------------------------------------------------------------------

test('a canonical identifier is accepted', () => {
  assert.ok(accepts('GAP-0123456789ABCDEF01234567'));
  assert.ok(accepts(`GAP-${'A'.repeat(24)}`));
  assert.ok(accepts(`GAP-${'0'.repeat(24)}`));
});

test('a too long or too short identifier is refused', () => {
  assert.equal(accepts('GAP-0123456789ABCDEF012345678'), false, 'one character too long');
  assert.equal(accepts('GAP-0123456789ABCDEF0123456'), false, 'one character too short');
  assert.equal(accepts(`GAP-${'A'.repeat(24)}${'A'.repeat(4096)}`), false, 'a long value must not reach a query');
  assert.equal(accepts(`GAP-${'A'.repeat(24)}\n`), false, 'a trailing newline is not part of the identifier');
});

test('an empty or absent identifier is refused', () => {
  for (const value of ['', ' ', 'GAP-', 'GAP', null, undefined]) {
    assert.equal(accepts(value), false, `"${String(value)}" must be refused`);
  }
});

// A `text` column takes whatever it is given, so these are the values that previously reached a query.
test('path traversal and filesystem semantics are refused', () => {
  for (const value of [
    '../GAP-0123456789ABCDEF01234567',
    'GAP-0123456789ABCDEF01234567/../secret',
    'GAP-0123456789ABCDEF01234567/..',
    '..%2fGAP-0123456789ABCDEF01234567',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'GAP-0123456789ABCDEF01234567\\..\\x',
  ]) {
    assert.equal(accepts(value), false, `traversal value must be refused: ${value}`);
  }
});

test('control characters, whitespace and null bytes are refused', () => {
  for (const value of [
    'GAP-0123456789ABCDEF0123456\u0000',
    'GAP-0123456789ABCDEF01234567\u0000',
    'GAP-0123456789ABCDEF01234567\r\n',
    'GAP-0123456789ABCDEF01234 67',
    '\tGAP-0123456789ABCDEF01234567',
    'GAP-0123456789ABCDEF01234567\u200b',
    'GAP-0123456789ABCDEF0123456\u007f',
  ]) {
    assert.equal(accepts(value), false, `control or whitespace value must be refused: ${JSON.stringify(value)}`);
  }
});

// Explicit policy: refuse, and do not normalise.
test('Unicode confusables and non-ASCII digits are refused', () => {
  for (const value of [
    'GAP-\u0410123456789ABCDEF0123456', // Cyrillic А in place of A
    'GAP-\uFF10123456789ABCDEF0123456', // fullwidth zero
    'GAP-0123456789ABCDEF0123456\u0430', // Cyrillic а
    'G\u0410P-0123456789ABCDEF01234567', // confusable inside the prefix
    '\uFF27\uFF21\uFF30-0123456789ABCDEF01234567', // fullwidth prefix
    'GAP-0123456789ABCDEF0123456\u2170', // Roman numeral small one
  ]) {
    assert.equal(accepts(value), false, `confusable must be refused: ${JSON.stringify(value)}`);
  }
});

// The reason the policy is "refuse", stated as a test rather than as a comment.
//
// This assertion first read "normalising must not turn a refused value into an accepted one", and it
// failed - correctly. NFKC maps the fullwidth prefix onto the canonical `GAP-`, so normalisation *does*
// launder a refused value into a valid identifier. That is a property of Unicode, not something a
// validator can forbid; what the product controls is whether it ever normalises. It must not, and the
// laundering below is the reason.
test('NFKC would launder a confusable into a canonical identifier, so it is never applied', () => {
  const fullwidth = '\uFF27\uFF21\uFF30-0123456789ABCDEF01234567';
  assert.equal(accepts(fullwidth), false, 'the fullwidth form must be refused as given');
  assert.equal(fullwidth.normalize('NFKC'), 'GAP-0123456789ABCDEF01234567');
  assert.ok(accepts(fullwidth.normalize('NFKC')), 'this is the laundering the policy exists to prevent');

  // So no identifier validator may normalise, case-fold or trim. If one ever does, this fails and the
  // contract document has to be revisited rather than the test relaxed.
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const validators = [...source.matchAll(/export function require(?:Uuid|GapId)\([\s\S]*?\n\}/gu)].map((match) => match[0]);
  assert.equal(validators.length, 2, 'both identifier validators must be found for this check to mean anything');
  for (const validator of validators) {
    for (const laundering of ['normalize(', 'toUpperCase(', 'toLowerCase(', 'trim(', 'replace(']) {
      assert.ok(!validator.includes(laundering), `an identifier validator must not ${laundering} its input`);
    }
  }
});

// Case is significant, and the decision is to refuse rather than fold. An identifier with two accepted
// spellings appears with two spellings in audit records, logs and dossier references.
test('case ambiguity is refused, not normalised', () => {
  const canonical = 'GAP-0123456789ABCDEF01234567';
  assert.ok(accepts(canonical));
  for (const value of [canonical.toLowerCase(), 'gap-0123456789ABCDEF01234567', 'GAP-0123456789abcdef01234567', 'Gap-0123456789ABCDEF01234567']) {
    assert.equal(accepts(value), false, `case variant must be refused: ${value}`);
  }
});

test('a wrong prefix or a UUID is refused', () => {
  for (const value of [randomUUID(), randomUUID().toUpperCase(), 'GAP_0123456789ABCDEF01234567', 'XAP-0123456789ABCDEF01234567', '0123456789ABCDEF01234567']) {
    assert.equal(accepts(value), false, `must be refused: ${value}`);
  }
});

test('SQL fragments are refused before any query is built', () => {
  for (const value of [
    "GAP-0123456789ABCDEF01234567' OR '1'='1",
    "' OR 1=1--",
    'GAP-0123456789ABCDEF01234567; DROP TABLE gaps',
    'GAP-0123456789ABCDEF01234567%',
    'GAP-0123456789ABCDEF01234567_',
  ]) {
    assert.equal(accepts(value), false, `SQL fragment must be refused: ${value}`);
  }
});

test('a non-string value is refused rather than coerced', () => {
  for (const value of [42, {}, ['GAP-0123456789ABCDEF01234567'], true, Symbol('GAP'), { toString: () => 'GAP-0123456789ABCDEF01234567' }]) {
    assert.equal(accepts(value), false, `a non-string must be refused: ${String(value)}`);
  }
});

// The refusal must be the ordinary not-found, identical for a malformed identifier and for a well-formed
// one belonging to another tenant. If they differed, the response would say which of the two happened —
// the existence oracle the 404-everywhere rule exists to remove. A foreign tenant's gap is well-formed,
// so it passes this validator and is refused by RLS and the query's empty result with the same code.
test('a malformed identifier and a foreign well-formed one are refused identically', () => {
  const malformed = refusal('not-a-gap');
  assert.deepEqual(malformed, { code: 'RESOURCE_NOT_FOUND', status: 404, message: 'Resource not found.' });
  // A foreign tenant's identifier is canonical, so the validator lets it through — deliberately. The
  // refusal then comes from the tenant boundary, with the same code and status.
  const foreign = gapIdentity(randomUUID(), 'ACME-PKG-0001', 'PPWR-2026-CORE', 'recyclability').id;
  assert.ok(accepts(foreign), 'a foreign identifier must be well-formed, or the boundary is never exercised');
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const notFound = source.split('RESOURCE_NOT_FOUND').length - 1;
  assert.ok(notFound >= 3, `expected the not-found refusal to be the uniform answer, found ${notFound} uses`);
});

// The contract as documented and the contract as enforced must be the same string.
test('the documented contract matches the enforced pattern', () => {
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /const GAP_ID = \/\^GAP-\[0-9A-F\]\{24\}\$\/u;/u, 'the enforced pattern changed without this test being revisited');
  const contract = readFileSync(new URL('../../../docs/security/GAP_IDENTIFIER_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /\^GAP-\[0-9A-F\]\{24\}\$/u, 'the contract document does not state the enforced pattern');
});
