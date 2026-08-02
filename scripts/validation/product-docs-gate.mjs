// SPDX-License-Identifier: Apache-2.0
//
// Product documentation gate — the shipped portal against the code it describes.
//
//   node scripts/validation/product-docs-gate.mjs
//
// `apps/web/src/docs-content*.js` is not a repository document. It is the documentation portal the product
// serves, in three languages, to a self-hoster who has never met anybody who works on this. Every other
// parity gate in this directory compares code with code, or a contract with code. Nothing compared these
// pages with anything, and a first-day audit found what that produces: a QuickStart whose four commands
// could not work in the order given, a backup page that omitted the one command without which `backup`
// refuses to run, an upgrade page describing by hand exactly the path the installer's own comments record
// as having broken a real deployment, a configuration reference claiming completeness while omitting a
// variable the stack will not start without, a limitations page calling a live package dead, and a
// migration level five behind the schema. Each of those was true when written.
//
// So the pages are checked rather than trusted. Nothing below is a list of expected sentences: every
// expectation is resolved from the installer's dispatch table and its own refusal messages, from the
// compose file's required-variable markers, from the migrations directory, from the import graph, and from
// the API's route table. Where the code moves, the finding names the page that no longer matches it.
//
// Applied to all three languages. A translated page is a page a reader acts on, and two of the six
// discrepancies above were present in Polish and German as well as in English.

import { readFileSync, readdirSync } from 'node:fs';
import { describeSecretWeakness } from '../../packages/security/src/secret-strength.mjs';
import { CRITICAL_SLUGS, DOCS_PAGES, docsPage } from '../../apps/web/src/docs-content.js';
import { unreachablePackages } from './unreachable-packages.mjs';

const INSTALLER = 'scripts/installer/openppwr-installer';
const COMPOSE = 'deploy/community/docker-compose.yml';
const ENV_EXAMPLE = 'deploy/community/openppwr.env.example';
const API = 'apps/api/src/app.mjs';
const MIGRATIONS = 'packages/database/migrations';
const LOCALES = ['en', 'pl', 'de'];
// Every release's own notes, resolved from the directory rather than typed. Hardcoding the current
// release's two filenames meant that the moment a new release was written, its notes were checked by
// nothing — the gate went on inspecting the previous release's, reported PASS, and the new documents a
// self-hoster actually reads were unexamined. The notes of superseded releases stay in the list on
// purpose: they remain in the export, so a claim in one of them is still a claim this product ships.
const RELEASE_NOTE_FILES = readdirSync('docs/release')
  .filter((name) => /^(?:RELEASE|UPGRADE)_NOTES_.+\.md$/u.test(name))
  .sort()
  .map((name) => `docs/release/${name}`);

const findings = [];
const installer = readFileSync(INSTALLER, 'utf8');
const compose = readFileSync(COMPOSE, 'utf8');
const apiSource = readFileSync(API, 'utf8');

// ---- reading a page -----------------------------------------------------------------------------------
//
// One flat string per page per locale. Headings, paragraphs, list items, prerequisites and code all count:
// an instruction is an instruction wherever the renderer puts it, and a precondition stated in a list item
// is stated.

function pageText(page) {
  const blocks = page.body.map((block) => (block.kind === 'ul' ? block.items.join('\n') : block.text));
  return [page.title, page.purpose, page.audience, ...(page.prerequisites || []), ...blocks].join('\n');
}

function pageCode(page) {
  return page.body.filter((block) => block.kind === 'code').map((block) => block.text).join('\n');
}

const pages = [];
for (const locale of LOCALES) {
  for (const { slug } of DOCS_PAGES) {
    const page = docsPage(slug, locale);
    if (!page) { findings.push(`${slug}/${locale}: the page does not resolve`); continue; }
    pages.push({ slug, locale, where: `${slug}/${locale}`, text: pageText(page), code: pageCode(page) });
  }
}

// A page that is translated must be checked in its own words; an untranslated page resolves to the English
// body in every locale, which would report the same finding three times. Reported once, against English.
const relevant = (entry) => entry.locale === 'en' || CRITICAL_SLUGS.includes(entry.slug);

// ---- 0. the first sequence anybody runs -------------------------------------------------------------------
//
// A page that says "copy this template and start the stack" is making two claims about the template, and
// both were false. The template pins a registry reference while the repository states that no image has
// been published, so the very first command ends on a failed pull; and it ships a worker token that is a
// published placeholder, which the worker refuses at startup by the same function the deployment uses —
// so a `up -d` with no service list produces a restart loop rather than the healthy stack the page
// promises. Neither is visible to a check that only asks whether the commands exist.
//
// Both conditions are read rather than assumed, and both relax on their own if the facts change: the
// weakness of the template's worker token is asked of `describeSecretWeakness`, the same function the
// worker calls, and the publication statement is read out of README, so the day an image is published the
// build requirement stops applying without anybody editing this file.

const template = readFileSync(ENV_EXAMPLE, 'utf8');
const templateValue = (name) => (new RegExp(`^${name}=(.*)$`, 'mu').exec(template) || [])[1];
const templateWorkerToken = templateValue('OPENPPWR_WORKER_TOKEN');
const templateImage = templateValue('OPENPPWR_IMAGE') || '';
if (!templateWorkerToken) findings.push(`${ENV_EXAMPLE}: OPENPPWR_WORKER_TOKEN could not be read; the start-sequence check cannot be derived`);
// Non-null means the worker refuses this value. It is the same call `loadWorkerConfig` makes.
const workerTokenRefused = Boolean(describeSecretWeakness(templateWorkerToken || ''));
const imagePinsRegistry = /^[^/\s]+\.[^/\s]+\//u.test(templateImage);
const imageUnpublished = /No container image has been published/iu.test(readFileSync('README.md', 'utf8'));

for (const entry of pages) {
  if (!relevant(entry)) continue;
  const createsEnvironment = entry.code.includes('openppwr.env.example');
  for (const line of entry.code.split('\n')) {
    if (!/docker compose/u.test(line) || !/\bup -d\b/u.test(line)) continue;
    const services = line.slice(line.indexOf('up -d') + 'up -d'.length).trim();
    if (services === '' && workerTokenRefused) {
      findings.push(`${entry.where}: starts every service with "up -d", which includes the worker, while ${ENV_EXAMPLE} still ships a worker token the worker refuses (${describeSecretWeakness(templateWorkerToken)}). The result is a restart loop, not a healthy stack`);
    }
    if (createsEnvironment && imageUnpublished && imagePinsRegistry && !entry.code.includes('docker build')) {
      findings.push(`${entry.where}: tells the reader to create an environment file from ${ENV_EXAMPLE}, which pins ${templateImage}, and to start the stack — but README states no container image has been published, and the page never says to build one`);
    }
  }
}

// ---- 1. installer subcommands the portal instructs -------------------------------------------------------
//
// Code blocks only, and the reason is empirical rather than stylistic: `openppwr-installer` followed by a
// word occurs in ordinary prose in all three languages — "as a bare openppwr-installer once that tree is
// gone", "als bloßes openppwr-installer laufen" — and treating those as instructions produces findings
// about subcommands named `once` and `laufen`. What a reader copies is what can go wrong, so what a reader
// copies is what is checked.

const dispatch = installer.slice(installer.indexOf('case "$command" in'));
const routes = [...dispatch.matchAll(/([a-z][a-z0-9-]*)\)\s+([a-z_]+) "\$@"/gu)]
  .map((match) => ({ subcommand: match[1], handler: match[2] }));
if (routes.length < 10) findings.push(`could not read the dispatch table from ${INSTALLER}; found ${routes.length} routes`);
const subcommands = new Map(routes.map((route) => [route.subcommand, route.handler]));

// Every shell function body, so a handler's own refusals can be read.
const handlers = new Map();
for (const match of installer.matchAll(/^([a-z_]+)\(\)\{[\s\S]*?^\}/gmu)) handlers.set(match[1], match[0]);

const invocation = /openppwr-installer\s+([a-z][a-z0-9-]*)/gu;
const citedBy = new Map(); // subcommand -> [page entries]
for (const entry of pages) {
  for (const match of entry.code.matchAll(invocation)) {
    const subcommand = match[1];
    if (!subcommands.has(subcommand)) {
      if (relevant(entry)) findings.push(`${entry.where}: names "openppwr-installer ${subcommand}", which ${INSTALLER} does not dispatch`);
      continue;
    }
    if (!citedBy.has(subcommand)) citedBy.set(subcommand, []);
    if (!citedBy.get(subcommand).includes(entry)) citedBy.get(subcommand).push(entry);
  }
}

// ---- 2. a cited subcommand's documented precondition ----------------------------------------------------
//
// The gap this catches is not "the command does not exist" but "the command exists and refuses". `backup`
// exits 83 on every deployment that has never run `backup-key init`; `restore` exits 104 and `rollback`
// exits 92 without `OPENPPWR_BACKUP_PRIVATE_KEY`. A page that shows the command without its precondition is
// a page whose procedure fails on first use for every reader, which is worse than one that says nothing.
//
// The preconditions are read out of the handler's own `fail` messages, so a new refusal is covered without
// anybody adding it here. Two forms are recognised, and the distinction between them is the point:
//
//   * "run: openppwr-installer X" / "run X first" — a sibling subcommand that must have happened already;
//   * "set VAR to …" / "VAR is not set" — a value the operator must supply and cannot be defaulted.
//
// A refusal asking for a confirmation (`VAR=yes`) is deliberately NOT a precondition. Those guard a
// destructive repeat — reconfiguring a live deployment, overwriting a key — and are reached only by an
// operator doing the thing they guard, not by a reader following the page for the first time. Treating
// them as preconditions would put four confirmation variables on every page that mentions `configure`,
// which is how a gate teaches people to route around it.
// The precondition may be satisfied by prose. Unlike section 3 below, where the point is that the reader
// must run a command instead of doing it by hand, the question here is only whether the page tells them
// the precondition exists — "run backup-key init first" in a sentence does that as well as in a block.
const CONFIRMATION = /(OPENPPWR_[A-Z_]+)=yes/u;

function preconditions(subcommand) {
  const body = handlers.get(subcommands.get(subcommand)) || '';
  const required = { commands: new Set(), variables: new Set() };
  for (const refusal of body.matchAll(/fail\s+(['"])([\s\S]*?)\1\s+\d+/gu)) {
    const message = refusal[2];
    for (const match of message.matchAll(/run:?\s+(?:openppwr-installer\s+)?([a-z][a-z0-9-]*)/gu)) {
      // Self-reference is not a precondition: `upgrade` telling you to run `upgrade` from the release tree
      // is a statement about where, not about what must have happened first.
      if (subcommands.has(match[1]) && match[1] !== subcommand) required.commands.add(match[1]);
    }
    if (CONFIRMATION.test(message)) continue;
    for (const match of message.matchAll(/(?:set|or)\s+(OPENPPWR_[A-Z_]+)\s+to\b/gu)) required.variables.add(match[1]);
    for (const match of message.matchAll(/(OPENPPWR_[A-Z_]+)\s+is not set/gu)) required.variables.add(match[1]);
  }
  return required;
}

for (const [subcommand, entries] of citedBy) {
  const { commands, variables } = preconditions(subcommand);
  for (const entry of entries) {
    if (!relevant(entry)) continue;
    for (const prerequisite of commands) {
      if (!entry.text.includes(prerequisite)) {
        findings.push(`${entry.where}: instructs "${subcommand}", which ${INSTALLER} refuses until "${prerequisite}" has run, and the page never mentions "${prerequisite}"`);
      }
    }
    for (const variable of variables) {
      if (!entry.text.includes(variable)) {
        findings.push(`${entry.where}: instructs "${subcommand}", which ${INSTALLER} refuses without ${variable}, and the page never mentions ${variable}`);
      }
    }
  }
}

// ---- 3. the upgrade path the installer implements --------------------------------------------------------
//
// A different failure from the one above, and the one that made an upgrade page describe a broken
// procedure while every command on it existed. The installer's `upgrade` handler is what rewrites
// OPENPPWR_IMAGE in the deployed environment file; it also back-fills the variables later migrations made
// required, refreshes the deployed compose file, and refreshes its own copy on PATH — each of those lines
// records a real deployment it was written after. A page that tells a reader to edit OPENPPWR_IMAGE and
// recreate the stack is telling them to do the part `upgrade` does first and skip the rest.
//
// So: whichever handler writes OPENPPWR_IMAGE into the environment file is the supported path, and a page
// that instructs the same mutation must name it. Derived from the script, so if that ever moves to another
// subcommand the requirement moves with it.

// A handler that writes OPENPPWR_IMAGE into the deployment's environment file, rather than merely reading
// it back out: `sed -n 's/^OPENPPWR_IMAGE=//p'` appears in several handlers and is a read.
const imageWriters = [...subcommands.keys()].filter((subcommand) => {
  const body = handlers.get(subcommands.get(subcommand)) || '';
  return /sed -i[^\n]*OPENPPWR_IMAGE=/u.test(body) || /write_env_file/u.test(body);
});
if (imageWriters.length === 0) findings.push(`${INSTALLER}: no handler writes OPENPPWR_IMAGE; the supported upgrade path cannot be derived`);

// "Change OPENPPWR_IMAGE yourself", in any of the three languages: the variable named as something the
// reader sets, updates or points somewhere.
const HAND_EDIT = /(?:update|change|set|zmień|ustaw|ändern|setzen|setzt)[^.\n]{0,40}OPENPPWR_IMAGE|OPENPPWR_IMAGE[^.\n]{0,40}(?:auf die Zielversion|na wersję docelową|to the target)/iu;
// …on a deployment that already exists. An image reference written while the environment file is first
// created is `configure`'s ordinary job and the QuickStart's own subject; an image reference changed on a
// deployment worth backing up first is a version change, which is what `upgrade` is for and what the
// hand path silently gets wrong. The backup is the discriminator because it is the step that only makes
// sense when there is already data to lose.
const UPGRADE_CONTEXT = /\bbackup\b|\bkopi[aęi]\b|\bSicherung\b/iu;
// Naming it means showing it. An earlier draft of this check accepted the word "upgrade" anywhere on the
// page, which the pre-fix English page satisfied with the phrase "a backup taken immediately before the
// upgrade" — the prose noun, not the command — while the procedure underneath it was still the hand path.
// The requirement is an invocation in a code block, which is the thing a reader copies.
const invokes = (entry, subcommand) => new RegExp(`openppwr-installer\\s+${subcommand}\\b`, 'u').test(entry.code);
for (const entry of pages) {
  if (!relevant(entry) || !HAND_EDIT.test(entry.text) || !UPGRADE_CONTEXT.test(entry.text)) continue;
  if (!imageWriters.some((subcommand) => invokes(entry, subcommand))) {
    findings.push(`${entry.where}: instructs the reader to change OPENPPWR_IMAGE on a deployment it also tells them to back up, without naming ${imageWriters.join(' or ')} — the installer subcommands that perform that change together with the compose refresh, the PATH refresh and the secret back-fill a hand edit skips`);
  }
}

// ---- 4. the migration level the portal states -------------------------------------------------------------

const migrationFiles = readdirSync(MIGRATIONS).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
const migrationNumbers = migrationFiles.map((name) => name.slice(0, name.indexOf('_')));
const latestMigration = migrationNumbers.at(-1);

let statedMigrations = 0;
for (const entry of pages) {
  if (!relevant(entry)) continue;
  const stated = [...entry.text.matchAll(/migrat(?:ion|ie|ionsstand)?\s+(\d{3})/giu)].map((match) => match[1]);
  if (stated.length === 0) continue;
  statedMigrations += stated.length;
  for (const number of stated) {
    if (!migrationNumbers.includes(number)) {
      findings.push(`${entry.where}: names migration ${number}, which does not exist in ${MIGRATIONS}`);
    }
  }
  const highest = stated.slice().sort().at(-1);
  if (highest !== latestMigration) {
    findings.push(`${entry.where}: the highest migration it names is ${highest}; ${MIGRATIONS} ends at ${latestMigration}, so the page understates the schema a reader is being upgraded onto`);
  }
}
if (statedMigrations === 0) findings.push('no page states a migration level; the portal has stopped telling a reader which schema a release carries');

// The same number, spelled out, in the release documents a reader consults before upgrading. "Thirty-four
// migrations" and "thirty-two migrations" appeared in the same release for the same span, which is the
// ordinary fate of a number written as a word: nothing computes it. The span is the one the portal states
// and this gate has just checked against the directory, so all three now move together.
const SPAN = /from migration (\d{3}) to migration (\d{3})/u.exec(
  pages.filter((entry) => entry.slug === 'release-notes' && entry.locale === 'en').map((entry) => entry.text).join('\n'),
);
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function spelled(word) {
  const lower = word.toLowerCase();
  if (UNITS.includes(lower)) return UNITS.indexOf(lower);
  const [tens, units] = lower.split('-');
  if (!(tens in TENS)) return null;
  return TENS[tens] + (units ? UNITS.indexOf(units) : 0);
}
if (!SPAN) {
  findings.push('the release notes page no longer states the migration span, so the spelled-out counts in the release documents cannot be checked against anything');
} else {
  const span = Number(SPAN[2]) - Number(SPAN[1]);
  for (const path of RELEASE_NOTE_FILES) {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const match of text.matchAll(/\b([A-Za-z]+(?:-[a-z]+)?)\s+migrations\b/gu)) {
      const value = spelled(match[1]);
      if (value === null) continue;
      if (value !== span) {
        findings.push(`${path}: says "${match[1]} migrations" where migration ${SPAN[1]} to ${SPAN[2]} is ${span}`);
      }
    }
  }
}

// ---- 5. packages the portal calls unreachable --------------------------------------------------------------
//
// Computed from the import graph by `unreachable-packages.mjs`, the same function `release-contract-gate.mjs`
// uses. The portal names directories rather than package names, which is right for a reader looking at a
// source tree, so the comparison is on directory basenames.

const unreachable = unreachablePackages().map((entry) => entry.directory.replace('packages/', '')).sort();
const COUNT_WORDS = {
  1: ['one', 'jeden', 'ein'], 2: ['two', 'dwa', 'zwei'], 3: ['three', 'trzy', 'drei'],
  4: ['four', 'cztery', 'vier'], 5: ['five', 'pięć', 'fünf'], 6: ['six', 'sześć', 'sechs'],
};
// The sentence carrying the claim, in any of the three languages: a count word, the word for packages, and
// a colon-introduced list. Pinned as a shape rather than as three fixed sentences, but pinned: a rewrite
// that drops the claim fails here too, because a limitations page that stops naming them is not an
// improvement on one that names the wrong ones.
const UNREACHABLE_CLAIM = /([A-Za-zÀ-ɏ]+)\s+(?:packages|pakiety|Pakete)\b[^:.]{0,140}:\s*([^.]+)\./u;

for (const entry of pages) {
  if (entry.slug !== 'known-limitations' || !relevant(entry)) continue;
  const claim = UNREACHABLE_CLAIM.exec(entry.text);
  if (!claim) {
    findings.push(`${entry.where}: no longer states which packages ship without being reachable at runtime`);
    continue;
  }
  const named = claim[2].split(/,|\band\b|\bi\b|\bund\b/u).map((part) => part.trim()).filter(Boolean).sort();
  if (named.join(',') !== unreachable.join(',')) {
    findings.push(`${entry.where}: calls ${named.join('/')} unreachable at runtime; the import graph says ${unreachable.join('/')}`);
  }
  const expectedWord = COUNT_WORDS[unreachable.length];
  if (!expectedWord) {
    findings.push(`${entry.where}: ${unreachable.length} packages are unreachable and this gate has no word for that number in three languages`);
  } else if (!expectedWord.some((word) => claim[1].toLowerCase().startsWith(word))) {
    findings.push(`${entry.where}: counts the unreachable packages as "${claim[1]}"; there are ${unreachable.length}`);
  }
}

// ---- 6. environment variables the deployment cannot start without --------------------------------------------
//
// `${VAR:?...}` is Compose's own marker for "refuse to interpolate this file without a value". A variable
// carrying it stops the stack before a container starts, which makes its absence from the configuration
// reference the most expensive omission that page can have — the reader follows it, the stack does not come
// up, and nothing on the page says why.
//
// The reference page also claims to name every variable the deployment reads. That claim is checked too,
// against the union of the compose file and the shipped environment template: those are the two files a
// variable has to appear in to reach a container or the installer at all.

const requiredVariables = [...new Set([...compose.matchAll(/\$\{(OPENPPWR_[A-Z0-9_]+):\?/gu)].map((match) => match[1]))].sort();
if (requiredVariables.length === 0) findings.push(`${COMPOSE}: no variable is marked required; the hard-start check cannot be derived`);

const composeVariables = new Set([...compose.matchAll(/\$\{(OPENPPWR_[A-Z0-9_]+)[:}]/gu)].map((match) => match[1]));
const templateVariables = new Set();
for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/u)) {
  const match = /^#?\s*(OPENPPWR_[A-Z0-9_]+)=/u.exec(line);
  if (match) templateVariables.add(match[1]);
}
const everyVariable = [...new Set([...composeVariables, ...templateVariables])].sort();

const configurationPages = pages.filter((entry) => entry.slug === 'configuration' && relevant(entry));
for (const entry of configurationPages) {
  for (const variable of requiredVariables) {
    if (!entry.text.includes(variable)) {
      findings.push(`${entry.where}: ${COMPOSE} refuses to start without ${variable} and the configuration reference does not name it`);
    }
  }
  for (const variable of everyVariable) {
    if (requiredVariables.includes(variable)) continue;
    if (!entry.text.includes(variable)) {
      findings.push(`${entry.where}: the page states it lists every variable the deployment reads; ${variable} is read by ${composeVariables.has(variable) ? COMPOSE : ENV_EXAMPLE} and is not on it`);
    }
  }
}

// ---- 7. routes the portal describes, and routes it denies -----------------------------------------------------
//
// Two directions, and the second is the one that cost the most.
//
// Forwards is easy: a path named in the portal must be a path the server registers, and every path the
// server registers must be named, because an API reference that silently omits a route is how an operator
// concludes the capability does not exist.
//
// Backwards is the hard one. Three exported documents stated that a leaked bearer credential cannot be
// replaced and that the remedy is resetting the tenant — which discards its data — while
// `POST /v1/identities/:id/rotate-credential` was registered, tested and configured. An operator following
// them would have destroyed their own data to solve a problem the product already solves. Nothing detects
// that in general: "does this English, Polish or German prose deny this capability" is not a question a
// regular expression answers, and pretending otherwise would produce a gate that fires on every honest
// limitation and is therefore ignored.
//
// What is checkable is narrower and, for this failure, sufficient. The denial idioms below are the ones
// that were actually shipped, plus their obvious inflections. The gate is a two-way parity check on the
// route table rather than a blacklist: while the route is registered, a categorical denial anywhere in the
// exported documentation is a finding; if the route is ever removed, the same list becomes a requirement —
// at least one exported document must then say so, because a capability that disappears in silence is the
// same defect pointing the other way. A sentence that names the route is exempt: a document describing what
// rotation cannot do, in a sentence that names rotation's own route, is describing a bound rather than
// denying the capability.

const registeredRoutes = [...apiSource.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/gu)]
  .map((match) => match[2]);
const normalise = (path) => path.replace(/\{[^}]+\}|:[a-zA-Z]+/gu, '*').replace(/[.,;)]+$/u, '');
const registered = new Set(registeredRoutes.map(normalise));
if (registered.size < 20) findings.push(`${API}: only ${registered.size} routes could be read; the route comparison cannot be trusted`);

const apiReferencePages = pages.filter((entry) => entry.slug === 'api-reference' && relevant(entry));
for (const entry of apiReferencePages) {
  // `/v1` alone is the version prefix the page explains in prose, not a route. A route has a path after it.
  const mentioned = new Set([...entry.text.matchAll(/\/health(?:\/[a-z]+)?|\/v1\/[\w./{}:-]+/gu)].map((match) => normalise(match[0])));
  for (const route of registered) {
    if (!mentioned.has(route)) findings.push(`${entry.where}: ${API} registers ${route} and the API reference does not name it`);
  }
  for (const route of mentioned) {
    if (!registered.has(route)) findings.push(`${entry.where}: names ${route}, which ${API} does not register`);
  }
}

// The capability, its route, and the ways this repository has denied it in the three languages it ships.
const ROTATION_ROUTE = '/v1/identities/*/rotate-credential';
const DENIALS = [
  /credentials?\s+(?:can\s?not|cannot|can't)\s+be\s+rotated/iu,
  /(?:can\s?not|cannot|can't)\s+be\s+rotated\s+(?:in\s+place|without)/iu,
  /no\s+API\s+route\s+(?:exposes|provides|offers)\s+it/iu,
  /rotating\s+[^.]{0,80}(?:has\s+no\s+supported|is\s+not\s+supported)/iu,
  /(?:nie\s+(?:można|da\s+się))\s+[^.]{0,60}(?:wymienić|rotować)/iu,
  /nicht\s+(?:rotiert|ausgetauscht|ersetzt)\s+werden/iu,
];
// Every file a self-hoster receives that could carry the claim. The portal is included: its API reference
// is where an integrator looks first.
const EXPORTED_PROSE = [
  'README.md',
  ...readdirSync('docs/deployment').filter((name) => name.endsWith('.md')).map((name) => `docs/deployment/${name}`),
  ...readdirSync('docs/user').filter((name) => name.endsWith('.md')).map((name) => `docs/user/${name}`),
  ...RELEASE_NOTE_FILES,
  INSTALLER,
  'apps/web/src/docs-content.js',
  'apps/web/src/docs-content-pl.js',
  'apps/web/src/docs-content-de.js',
];
// The private-infrastructure documents in `docs/deployment/` are excluded from the public export and
// describe one particular installation; they are read here anyway, because a denial in any of them is
// still a denial an operator can act on, and none of them is a historical record that must be preserved.
const routeExists = registered.has(ROTATION_ROUTE);
let denials = 0;
let statements = 0;
for (const path of EXPORTED_PROSE) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { continue; }
  // Paragraphs first, then sentences. Splitting on every newline missed the claim in
  // `CLEAN_SERVER_INSTALLER.md`, where "cannot be rotated" and "without a database reset" sat on two
  // wrapped lines of one sentence — a denial invisible to the check purely because of where the text
  // happened to wrap.
  const sentences = text
    .split(/\n\s*\n/u)
    .flatMap((paragraph) => paragraph.replace(/\s+/gu, ' ').split(/(?<=[.!?])\s+/u));
  for (const sentence of sentences) {
    const names = sentence.includes('rotate-credential') || sentence.includes('rotate_openppwr_identity');
    const denied = DENIALS.some((pattern) => pattern.test(sentence));
    if (denied && !names) {
      denials += 1;
      if (routeExists) {
        findings.push(`${path}: states that a credential cannot be replaced — "${sentence.trim().slice(0, 110)}" — while ${API} registers ${ROTATION_ROUTE}. An operator reading this destroys their own tenant to solve a problem the product already solves`);
      }
    }
    if (names && /rotate-credential/u.test(sentence)) statements += 1;
  }
}
if (!routeExists && denials === 0) {
  findings.push(`${API} no longer registers ${ROTATION_ROUTE} and no shipped document says the capability is gone; a capability that disappears in silence is the same defect as one that is denied while it exists`);
}
if (routeExists && statements === 0) {
  findings.push(`${API} registers ${ROTATION_ROUTE} and no shipped document mentions it; the recovery path for a leaked credential exists and nobody is told`);
}

// ---- verdict --------------------------------------------------------------------------------------------

// Deduplicated before it is counted: a page whose code block repeats an instruction produces the same
// finding twice, and a count that disagrees with the list printed under it is a gate nobody reads twice.
const reported = [...new Set(findings)];
if (reported.length) {
  console.error(`PRODUCT_DOCS_FAIL findings=${reported.length}`);
  for (const finding of reported) console.error(`  ${finding}`);
  console.error('\nThe documentation the product ships describes something the code does not do. Correct the page, or correct the code.');
  process.exitCode = 1;
} else {
  console.log(
    `PRODUCT_DOCS_PASS pages=${pages.length} locales=${LOCALES.join(',')} subcommands_cited=${citedBy.size}`
    + ` required_variables=${requiredVariables.length} documented_variables=${everyVariable.length}`
    + ` routes=${registered.size} migration=${latestMigration} unreachable_packages=${unreachable.length}`
    + ` rotation_statements=${statements}`,
  );
}
