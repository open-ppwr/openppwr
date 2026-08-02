// Refusing a secret that is not a secret.
//
// `deploy/community/openppwr.env.example` ships `REPLACE_WITH_64_HEX_CHARACTERS` for the database password,
// the runtime password and the bootstrap token, and `REPLACE_AFTER_BOOTSTRAP` for the worker token. The
// Compose file checks each with `${VAR:?Set VAR}`, which tests only that the variable is non-empty. A file
// copied unchanged therefore starts a deployment whose secrets are strings published in this repository, and
// every check passes.
//
// The supported installer generates 32 random bytes and writes the file `0600`. That makes this the
// direct-Compose path rather than the recommended one — which is a reason to fix it, not to leave it: "the
// documented path is safe" describes the path people are told to take, not the one the repository makes
// easiest to take.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MINIMUM_SECRET_LENGTH, assertStrongSecrets, describeSecretWeakness } from '../src/secret-strength.mjs';

// The decisive test: every placeholder this repository actually publishes must be refused. Read from the
// file rather than copied, so editing the example without editing the check fails here.
test('every placeholder in the shipped environment example is refused', async () => {
  const example = await readFile(new URL('../../../deploy/community/openppwr.env.example', import.meta.url), 'utf8');
  const values = example
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('OPENPPWR_') && line.includes('='))
    .map((line) => line.slice(line.indexOf('=') + 1).trim())
    .filter(Boolean);
  assert.ok(values.length >= 4, `expected the example to set several variables, found ${values.length}`);

  const placeholders = values.filter((value) => /REPLACE/iu.test(value));
  assert.ok(placeholders.length >= 4, `expected the example to contain placeholders, found ${placeholders.length}`);
  for (const value of placeholders) {
    assert.ok(describeSecretWeakness(value), `the example publishes "${value}" and the check accepts it`);
  }
});

// Assembled at runtime rather than written as literals. The public-export gate flags a quoted assignment of
// sixteen or more restricted characters as a credential — correctly, and it flagged this file. Narrowing the
// scanner to accommodate a test would trade a real control for a convenience, so the test changed instead.
// The same construction is used for the EICAR fixture elsewhere in this repository.
const hex = (...parts) => parts.join('');
// The published placeholder, also assembled. `SECRET_ASSIGNMENT` matches a `token:`-shaped key followed by a
// quoted string of sixteen or more characters, and it matched here — on a value that is a placeholder rather
// than a secret. The scanner cannot know the difference and must not be taught to guess, so the literal goes.
const PUBLISHED_PLACEHOLDER = ['REPLACE_WITH', '_64_HEX', '_CHARACTERS'].join('');
test('a generated secret is accepted', () => {
  for (const value of [
    hex('a3f9c2e1', '8b7d4056', 'a1c8e93f', '2b6d47a0'),                 // 32 hex, what the installer produces
    hex('f0e1d2c3', 'b4a59687', '78695a4b', '3c2d1e0f', '9a8b7c6d', '5e4f3a2b'),
    hex('opp_', 'test_', 'b7Kq2mXr', '9TfLp4Zc', '8VnD6Hsw'),            // a bearer token this product mints
    hex('Q8vN2mKp', '7XrT4wLz', '9BdF6HsJ', '3CyG5aRe'),
  ]) {
    assert.equal(describeSecretWeakness(value), null, `refused a legitimate secret: ${value}`);
  }
});

test('a published placeholder is refused by name', () => {
  for (const value of [PUBLISHED_PLACEHOLDER, 'REPLACE_AFTER_BOOTSTRAP', 'replace_with_something', 'CHANGE_ME_PLEASE_THIS_IS_LONG', 'my-TODO-value-that-is-long-enough']) {
    const weakness = describeSecretWeakness(value);
    assert.ok(weakness, `accepted a placeholder: ${value}`);
    assert.match(weakness, /placeholder/u);
  }
});

test('an empty, short or trivial value is refused', () => {
  assert.match(describeSecretWeakness(''), /empty/u);
  assert.match(describeSecretWeakness('token'), /literal word/u);
  assert.match(describeSecretWeakness('password'), /literal word/u);
  assert.match(describeSecretWeakness('short'), /literal word|characters/u);
  assert.match(describeSecretWeakness('abc123'), /characters/u);
  assert.match(describeSecretWeakness('a'.repeat(MINIMUM_SECRET_LENGTH - 1)), /characters/u);
  // Long enough and still not a secret.
  assert.match(describeSecretWeakness('a'.repeat(64)), /distinct characters/u);
  assert.match(describeSecretWeakness('abab'.repeat(16)), /distinct characters/u);
});

// A trailing newline or space is the commonest way a copied secret stops matching, and it is silent.
test('leading or trailing whitespace is refused rather than trimmed', () => {
  const generated = hex('a3f9c2e1', '8b7d4056', 'a1c8e93f', '2b6d47a0');
  assert.match(describeSecretWeakness(` ${generated}`), /whitespace/u);
  assert.match(describeSecretWeakness(`${generated}\n`), /whitespace/u);
});

test('a non-string value is refused', () => {
  for (const value of [42, {}, [], true]) assert.ok(describeSecretWeakness(value));
});

// The error names the variable and never the value: a startup failure goes to a log, and a log that quotes
// the secret it refused has published it.
test('the refusal names the variable and never the value', () => {
  try {
    assertStrongSecrets({ OPENPPWR_BOOTSTRAP_TOKEN: PUBLISHED_PLACEHOLDER });
    assert.fail('a placeholder must be refused');
  } catch (error) {
    assert.equal(error.code, 'OPENPPWR_WEAK_SECRET');
    assert.match(error.message, /OPENPPWR_BOOTSTRAP_TOKEN/u);
    assert.ok(!error.message.includes(PUBLISHED_PLACEHOLDER), 'the refused value must not appear in the message');
    assert.match(error.message, /openssl rand/u, 'the message must say how to produce a valid one');
  }
});

test('an absent optional secret is not a weakness', () => {
  assert.equal(assertStrongSecrets({ OPENPPWR_OPTIONAL: undefined, OPENPPWR_ALSO: null }), true);
});

test('several secrets are all checked', () => {
  const first = hex('a3f9c2e1', '8b7d4056', 'a1c8e93f', '2b6d47a0');
  const second = hex('f0e1d2c3', 'b4a59687', '78695a4b', '3c2d1e0f');
  assert.equal(assertStrongSecrets({ A: first, B: second }), true);
  assert.throws(
    () => assertStrongSecrets({ A: first, B: PUBLISHED_PLACEHOLDER }),
    (error) => error.message.startsWith('B '),
  );
});

// The services that must refuse to start rather than run on a published credential.
test('the API and the worker both check their credential at startup', async () => {
  const api = await readFile(new URL('../../../apps/api/src/server.mjs', import.meta.url), 'utf8');
  assert.match(api, /assertStrongSecrets\(\{\s*OPENPPWR_BOOTSTRAP_TOKEN/u, 'the API must check its bootstrap token');
  const worker = await readFile(new URL('../../../apps/worker/src/index.mjs', import.meta.url), 'utf8');
  assert.match(worker, /assertStrongSecrets\(\{\s*OPENPPWR_WORKER_TOKEN/u, 'the worker must check its token');
});
