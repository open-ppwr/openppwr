// SPDX-License-Identifier: Apache-2.0
//
// Refusing a secret that is not a secret.
//
// `openppwr.env.example` ships `OPENPPWR_DB_PASSWORD=REPLACE_WITH_64_HEX_CHARACTERS`, and the Compose file
// checks only that the variable is non-empty (`${VAR:?Set VAR}`). A file copied unchanged therefore starts a
// deployment whose database password, bootstrap token and worker token are strings published in this
// repository — and every check passes, because a placeholder is not empty.
//
// The supported installer generates 32 random bytes and writes the file mode `0600`, so this is the
// direct-Compose path rather than the recommended one. That is not a reason to leave it: "the documented
// path is safe" describes the path people are told to take, not the one the repository makes easiest.
//
// The check is deliberately narrow. It refuses values that are certainly not secrets — the placeholders this
// repository publishes, and lengths no generator would produce — and does not attempt to score entropy. A
// strength estimator that rejects a legitimate random secret is an outage, and one that accepts
// `Password123!` is theatre; refusing what we can name is the part that is both useful and honest.

// Every sentinel this repository publishes, matched case-insensitively. Substring rather than equality: a
// value that merely *contains* one of these was copied from the example and edited badly.
const PUBLISHED_PLACEHOLDERS = Object.freeze([
  'REPLACE_WITH',
  'REPLACE_AFTER',
  'CHANGE_ME',
  'CHANGEME',
  'YOUR_SECRET',
  'EXAMPLE_SECRET',
  'INSERT_SECRET',
  'TODO',
]);

// Values that are not placeholders but are certainly not secrets either.
const OBVIOUS_NON_SECRETS = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'admin', 'test', 'demo', 'changeit', 'openppwr',
]);

export const MINIMUM_SECRET_LENGTH = 24;

export function describeSecretWeakness(value) {
  if (typeof value !== 'string' || value.length === 0) return 'is empty';
  const trimmed = value.trim();
  if (trimmed.length !== value.length) return 'has leading or trailing whitespace, which is almost always a copy-paste accident';
  const upper = trimmed.toUpperCase();
  for (const placeholder of PUBLISHED_PLACEHOLDERS) {
    if (upper.includes(placeholder)) return `still contains the published placeholder "${placeholder}"`;
  }
  if (OBVIOUS_NON_SECRETS.includes(trimmed.toLowerCase())) return `is the literal word "${trimmed}"`;
  if (trimmed.length < MINIMUM_SECRET_LENGTH) return `is ${trimmed.length} characters; a generated secret is at least ${MINIMUM_SECRET_LENGTH}`;
  // A value made of one repeated character passes a length check and nothing else.
  if (new Set(trimmed).size < 4) return 'is made of too few distinct characters to be a generated value';
  return null;
}

// Throws on the first weak secret rather than collecting them, and names the variable but never the value:
// a startup error goes to a log, and a log that quotes the secret it refused has published it.
export function assertStrongSecrets(secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    if (value === undefined || value === null) continue;
    const weakness = describeSecretWeakness(value);
    if (weakness) {
      throw Object.assign(
        new Error(`${name} ${weakness}. Generate a value — the installer does this, or use: openssl rand -hex 32`),
        { code: 'OPENPPWR_WEAK_SECRET' },
      );
    }
  }
  return true;
}
