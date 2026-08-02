// SPDX-License-Identifier: Apache-2.0
//
// Release-contract reality gate.
//
// `docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md` states what OpenPPWR Community 1.0 promises. A promise
// document is the easiest thing in a repository to leave behind: it is prose, it is read by people rather
// than by processes, and nothing about it breaks when the code beneath it moves. This project has already
// met that failure in smaller forms — a role matrix maintained as page copy while the server granted
// something else, a migration level baked into an image and never compared to the schema, a risk count
// copied into five documents. Each was correct when written.
//
// So the contract is checked rather than trusted. Every number in it is resolved from the code that
// produces the number; every file it names must exist; every enforcement it claims must still contain the
// thing that enforces it; every npm script it names must be real and must point at a file that is there.
//
//   node scripts/validation/release-contract-gate.mjs
//
// What this gate deliberately does not check: whether the contract file is a member of the public export.
// That question belongs to the export validator, which resolves the allowlist and is itself withheld from
// the export — naming it from a file that ships publicly would publish a reference to a withheld document,
// which is the exact defect the export validator's own dangling-reference rule exists to catch. The
// membership assertion lives there, beside the manifest it needs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTHORIZATION_MATRIX, HUMAN_ROLE_NAMES, PERMISSION_CATALOGUE, SUPPORTED_ROLES } from '../../apps/api/src/permissions.mjs';
import { unreachablePackages, workspacePackages } from './unreachable-packages.mjs';

const CONTRACT = 'docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md';
const MIGRATIONS = 'packages/database/migrations';
const PREPARE = 'packages/database/src/prepare.mjs';

const findings = [];
const text = readFileSync(CONTRACT, 'utf8');

// ---- block and table parsing ----------------------------------------------------------------------
//
// The contract is a document for a reader first, so the machine-readable parts are ordinary Markdown
// tables delimited by HTML comments. A comment is invisible when rendered and unambiguous when parsed,
// which is the whole requirement: the reader sees a table, this file sees exactly the same table, and
// there is no second copy of the facts to drift from the first.

function block(name) {
  const opened = text.indexOf(`<!-- contract:${name} -->`);
  const closed = text.indexOf(`<!-- /contract:${name} -->`);
  if (opened === -1 || closed === -1 || closed < opened) {
    findings.push(`the contract has no "${name}" block; a block that is renamed or deleted removes every claim it carried`);
    return null;
  }
  return text.slice(opened, closed);
}

// Rows only: the header and the `|---|` separator are dropped, and each cell is trimmed of the backticks
// the document uses for code. A row with the wrong number of cells is reported rather than mapped by
// position onto the wrong column — the failure mode `permission-matrix-gate.mjs` had to learn.
function rows(name, expectedColumns) {
  const source = block(name);
  if (source === null) return [];
  const lines = source.split(/\r?\n/u).filter((line) => line.startsWith('|') && !/^\|\s*-{2,}/u.test(line));
  lines.shift(); // header
  const parsed = [];
  for (const line of lines) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/gu, ''));
    if (cells.length !== expectedColumns) {
      findings.push(`${name}: a row has ${cells.length} cell(s) where the table declares ${expectedColumns}: ${line.trim()}`);
      continue;
    }
    parsed.push(cells);
  }
  if (parsed.length === 0) findings.push(`${name}: the block contains no rows`);
  return parsed;
}

// ---- citations: what makes an anchor worth checking ------------------------------------------------
//
// Both the pinned table and the enforcement table work the same way: a row names a file and a string, and
// the gate checks that the file contains the string. That check is only ever as good as the string.
//
// Measured on this document rather than imagined: `LICENSE` contains the words "Apache License", so a row
// reading `| Every deployment is FIPS-140-3 certified | LICENSE | Apache License |` passed. Ten of the
// eighty-five anchors were single ordinary words — `supplier` occurs 130 times in the file it cited,
// `Community`, `trademark`, `Grype`, `SAST`, `DAST` and `ROUTE` are words or initials that a file about
// that subject contains whatever it does — so for those rows this gate confirmed that a file existed and
// nothing else.
//
// An anchor cannot be made to prove that the evidence supports the promise; the promise is prose, and no
// program reads prose. What it can be made to prove is that a *specific, named* thing is still in the
// file: a symbol, a literal, a marker the file emits. Three properties, each rejecting a way an anchor
// stops being specific:
//
//   1. Length. Below six characters a string occurs by coincidence.
//   2. Shape. Letters only, with no internal case change, is a word of English rather than a name.
//      `assertRegistryIsSound` is a symbol; `supplier` and `Community` are words. Anything carrying a
//      digit, an underscore, punctuation or a space is a literal or a phrase and passes.
//   3. Density. An anchor appearing very many times is ambient in the file rather than a citation of one
//      place in it. The limit is calibrated against this tree: the busiest legitimate anchor is
//      `openppwr_worker`, 34 times in the migration that creates it; the word `supplier` was 130. Fifty
//      is above anything a name reaches here and below anything a word does. It is a calibrated bound,
//      not a derived one, and it is stated as such.
//
// Rule 2 is the one that does the work today; rules 1 and 3 are guards against the shapes it cannot see.
const ANCHOR_MINIMUM_LENGTH = 6;
const ANCHOR_OCCURRENCE_LIMIT = 50;

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
}

const isProseWord = (anchor) => /^[A-Za-z]+$/u.test(anchor) && !/[a-z][A-Z]/u.test(anchor);

// Returns every reason this citation fails to substantiate anything, in the order a reader would want
// them: what is wrong with the anchor, then whether the file has it.
function citationProblems(file, anchor) {
  const problems = [];
  if (anchor.length < ANCHOR_MINIMUM_LENGTH) {
    problems.push(`the anchor "${anchor}" is ${anchor.length} characters long; a string that short occurs by accident and proves nothing`);
  }
  if (isProseWord(anchor)) {
    problems.push(`the anchor "${anchor}" is an ordinary word, not a citation; cite a symbol, a literal or a marker the file emits`);
  }
  if (!existsSync(file)) {
    problems.push(`${file} does not exist`);
    return problems;
  }
  const body = readFileSync(file, 'utf8');
  if (!body.includes(anchor)) {
    problems.push(`"${anchor}" is no longer in ${file}`);
    return problems;
  }
  const count = occurrences(body, anchor);
  if (count > ANCHOR_OCCURRENCE_LIMIT) {
    problems.push(`"${anchor}" appears ${count} times in ${file}; an anchor that common is ambient in the file rather than a citation of one place in it`);
  }
  return problems;
}

const sameSet = (actual, expected) => {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  return { missing, extra, equal: missing.length === 0 && extra.length === 0 };
};

// ---- 1. the stated facts, each resolved from the thing that produces it -----------------------------

const facts = new Map(rows('facts', 2).map(([key, value]) => [key, value]));
function fact(key) {
  if (!facts.has(key)) {
    findings.push(`facts: the contract no longer states "${key}"`);
    return null;
  }
  return facts.get(key);
}
function assertFact(key, actual, why) {
  const stated = fact(key);
  if (stated === null) return;
  if (stated !== String(actual)) findings.push(`facts: the contract states ${key} = ${stated}; ${why} says ${actual}`);
}

const migrationFiles = readdirSync(MIGRATIONS).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
const migrationNumber = (name) => name.slice(0, name.indexOf('_'));

assertFact('Verified against version', JSON.parse(readFileSync('package.json', 'utf8')).version, 'package.json');
assertFact('First migration', migrationNumber(migrationFiles[0]), MIGRATIONS);
assertFact('Last migration', migrationNumber(migrationFiles.at(-1)), MIGRATIONS);
assertFact('Named permissions', Object.keys(PERMISSION_CATALOGUE).length, 'the permission catalogue');
assertFact('Roles in the registry', SUPPORTED_ROLES.length, 'the permission registry');
// Resolved from `HUMAN_ROLES` in the permission registry, which is the list the registry's own soundness
// check uses to refuse a machine permission to a person — so it is the list the server acts on.
//
// It used to be resolved from `DISPLAY_ROLES`, the column list of the role matrix in the interface, and
// those are two different questions. The matrix shows what an identity may do and includes
// `service_account` because a reader auditing grants needs its column; the sign-in question is about who
// may present a password. Reading one for the other made the contract state eight where the code said
// seven, and — worse — made the gate refuse the correction: fixing the document to match `permissions.mjs`
// failed this line. A gate that fails on the truth is enforcing the mistake.
assertFact('Roles a person can sign in as', HUMAN_ROLE_NAMES.length, 'the human role list in the permission registry');

// The migration directory must also be contiguous. A contract that names a range says, by naming it, that
// everything between the ends is present; a gap would make "migration 001 to 038" describe a schema the
// deployment does not have.
const gaps = migrationFiles
  .map((name, index) => (Number(migrationNumber(name)) === index + 1 ? null : name))
  .filter(Boolean);
if (gaps.length) findings.push(`${MIGRATIONS}: the migration sequence is not contiguous, starting at ${gaps[0]}; the contract states a range and a range implies every step in it`);

// ---- 2. database principals ------------------------------------------------------------------------
//
// Read out of `prepare.mjs` rather than out of a list kept here. A second list would be a second thing to
// keep in step, which is the defect this gate exists to prevent rather than to reproduce.

const prepareSource = readFileSync(PREPARE, 'utf8');
const principalsLiteral = prepareSource.slice(prepareSource.indexOf('const PRINCIPALS='));
const principalsEnd = principalsLiteral.indexOf(']);');
const codePrincipals = principalsEnd === -1 ? [] : [...principalsLiteral.slice(0, principalsEnd).matchAll(
  /\{\s*role:\s*'([a-z_]+)'\s*,\s*variable:\s*'[A-Z_]+'\s*,\s*required:\s*(true|false)\s*\}/gu,
)].map(([, role, required]) => ({ role, required: required === 'true' }));

if (codePrincipals.length === 0) {
  findings.push(`${PREPARE}: the PRINCIPALS list could not be read; this gate cannot confirm the contract's principal table against anything`);
} else {
  assertFact('Login principals', codePrincipals.length, PREPARE);
  const contractPrincipals = rows('principals', 3).map(([role, configuration]) => ({ role, configuration }));
  const comparison = sameSet(contractPrincipals.map((entry) => entry.role), codePrincipals.map((entry) => entry.role));
  for (const role of comparison.missing) findings.push(`principals: ${PREPARE} provisions "${role}" and the contract does not name it`);
  for (const role of comparison.extra) findings.push(`principals: the contract names "${role}", which ${PREPARE} does not provision`);
  for (const entry of contractPrincipals) {
    const actual = codePrincipals.find((principal) => principal.role === entry.role);
    if (!actual) continue;
    const stated = entry.configuration.toLowerCase();
    if (stated !== 'required' && stated !== 'optional') {
      findings.push(`principals: "${entry.role}" is described as "${entry.configuration}", which is neither required nor optional`);
    } else if ((stated === 'required') !== actual.required) {
      findings.push(`principals: the contract calls "${entry.role}" ${stated}; ${PREPARE} declares required: ${actual.required}`);
    }
  }
}

// ---- 3. roles ---------------------------------------------------------------------------------------

const contractRoles = rows('roles', 2);
const roleComparison = sameSet(contractRoles.map(([role]) => role), [...SUPPORTED_ROLES]);
for (const role of roleComparison.missing) findings.push(`roles: the registry defines "${role}" and the contract does not list it`);
for (const role of roleComparison.extra) findings.push(`roles: the contract lists "${role}", which the registry does not define`);
for (const [role, signIn] of contractRoles) {
  if (!(role in AUTHORIZATION_MATRIX)) continue;
  const stated = signIn.toLowerCase();
  if (stated !== 'yes' && stated !== 'no') {
    findings.push(`roles: "${role}" is marked "${signIn}", which is neither yes nor no`);
    continue;
  }
  if ((stated === 'yes') !== HUMAN_ROLE_NAMES.includes(role)) {
    findings.push(`roles: the contract says a person ${stated === 'yes' ? 'can' : 'cannot'} sign in as "${role}"; the permission registry says the opposite`);
  }
}

// ---- 4. packages that are never loaded at runtime ---------------------------------------------------
//
// Computed, not listed. The claim "three packages ship and are never reachable" is exactly the kind that
// rots quietly: a package acquires its first importer and the sentence becomes false with nothing to say
// so. It has already happened once in this repository's own documentation, in the other direction — a
// package with a live importer was named as unreachable.

// The traversal itself lives in `unreachable-packages.mjs`, because `product-docs-gate.mjs` asks the same
// question of the shipped documentation portal. One computation, two callers: a second copy would be a
// second answer to drift from the first, which is the defect this section exists to prevent.
const packages = workspacePackages();
const unreachable = unreachablePackages();

const contractUnreachable = rows('unreachable-packages', 2);
assertFact('Runtime-unreachable packages', unreachable.length, 'the import graph');
const unreachableComparison = sameSet(contractUnreachable.map(([name]) => name), unreachable.map((entry) => entry.name));
for (const name of unreachableComparison.missing) findings.push(`unreachable-packages: nothing in the running services imports "${name}" and the contract does not name it`);
for (const name of unreachableComparison.extra) findings.push(`unreachable-packages: the contract calls "${name}" unreachable, but a running service imports it`);
for (const [name, directory] of contractUnreachable) {
  const actual = packages.find((entry) => entry.name === name);
  if (actual && actual.directory !== directory) findings.push(`unreachable-packages: the contract puts "${name}" in ${directory}; it lives in ${actual.directory}`);
}

// ---- 5. pinned components ---------------------------------------------------------------------------

for (const [component, pin, where] of rows('pinned', 3)) {
  for (const problem of citationProblems(where, pin)) {
    findings.push(`pinned: the ${component} pin — ${problem}`);
  }
}

// ---- 6. the public-project files ---------------------------------------------------------------------

for (const [file] of rows('public-files', 2)) {
  if (!existsSync(file)) findings.push(`public-files: the contract names "${file}" as a published project file and it does not exist`);
}

// ---- 7. enforcement ----------------------------------------------------------------------------------
//
// The centre of this gate. A promise names a file and a string inside it; the string is the enforcement,
// and if it has been renamed or removed the promise is no longer kept by anything. This is the difference
// between a document that cites its evidence and a document that once did.
//
// What it is not: a reading of the promise. See `citationProblems` above for what an anchor is required to
// be, and the contract's own "How to read a promise here" for the same statement addressed to a reader.

const enforcementRows = rows('enforcement', 3);
if (enforcementRows.length < 40) findings.push(`enforcement: the table holds ${enforcementRows.length} rows; a contract this size cannot be substantiated by fewer than 40`);
// One citation, one promise. Two rows resting on the same line in the same file means the second promise
// is substantiated by the first one's evidence rather than by its own, and deleting that line would be
// reported as one failure where two promises had lapsed.
const citedBy = new Map();
for (const [promise, file, anchor] of enforcementRows) {
  const citation = `${file} :: ${anchor}`;
  if (citedBy.has(citation)) {
    findings.push(`enforcement: "${promise}" cites ${file} for "${anchor}", which "${citedBy.get(citation)}" already cites; one line of evidence cannot substantiate two promises`);
  } else {
    citedBy.set(citation, promise);
  }
  for (const problem of citationProblems(file, anchor)) {
    findings.push(`enforcement: "${promise}" — ${problem}`);
  }
}

// ---- 8. the gates the contract sends a reader to -------------------------------------------------------

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const [, script] of rows('gates', 2)) {
  const command = packageManifest.scripts?.[script];
  if (!command) {
    findings.push(`gates: the contract tells a reader to run "npm run ${script}", which package.json does not define`);
    continue;
  }
  for (const token of String(command).split(/\s+/u)) {
    if (!/^(?:apps|packages|scripts|deploy)\/[\w./-]+\.(?:mjs|js|ps1|sh|cjs)$/u.test(token)) continue;
    if (!existsSync(token)) findings.push(`gates: "${script}" runs ${token}, which does not exist`);
  }
}

// ---- 9. every repository path the prose cites ------------------------------------------------------------
//
// Outside the tables as well as inside them. A contract whose prose points at a file that has been moved
// sends its reader nowhere, and the reader has no way to tell that from a file they simply cannot find.
// Inline code only: a bare path in a sentence is prose, a path in backticks is a citation.

const citations = new Set();
for (const match of text.matchAll(/`((?:apps|packages|scripts|deploy|docs)\/[\w./-]+)`/gu)) citations.add(match[1]);
for (const citation of [...citations].sort()) {
  if (!existsSync(citation)) findings.push(`citation: the contract points at ${citation}, which does not exist`);
}

// ---- verdict ---------------------------------------------------------------------------------------

if (findings.length) {
  console.error(`RELEASE_CONTRACT_FAIL findings=${findings.length}`);
  for (const finding of [...new Set(findings)]) console.error(`  ${finding}`);
  console.error('\nA promise the code no longer keeps is not a contract. Correct the code or correct the contract.');
  process.exitCode = 1;
} else {
  console.log(
    `RELEASE_CONTRACT_PASS enforcement_rows=${enforcementRows.length} principals=${codePrincipals.length}`
    + ` roles=${SUPPORTED_ROLES.length} permissions=${Object.keys(PERMISSION_CATALOGUE).length}`
    + ` migrations=${migrationFiles.length} unreachable_packages=${unreachable.length} citations=${citations.size}`,
  );
}

// Exported for the sake of anything that wants the resolved facts without re-deriving them; running the
// file directly is the supported use.
export const resolved = { migrationFiles, unreachable, findings };
if (process.argv[1] && fileURLToPath(import.meta.url) !== process.argv[1] && findings.length) process.exitCode = 1;
