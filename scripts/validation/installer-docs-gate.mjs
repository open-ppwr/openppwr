// SPDX-License-Identifier: Apache-2.0
//
// Installer documentation gate.
//
// The documented first-run sequence is the first thing a self-hoster ever runs, and nothing checked it
// against the script it claims to drive. The published sequence read:
//
//   sudo scripts/installer/openppwr-installer preflight
//   sudo scripts/installer/openppwr-installer install
//   sudo openppwr-installer configure IMAGE          <- silently switches invocation form here
//   ...
//
// Four of the six steps depended on a side effect of step two that the page never mentioned: install_files
// copies the script to /usr/local/bin. When that copy is absent — the sequence read before install has run,
// a sudoers secure_path without /usr/local/bin, an operator following the steps out of order — the reader
// gets `openppwr-installer: command not found` at step three with nothing on the page to explain it. The
// page was not wrong about any single command; it was wrong about the transition between two of them, and
// that is precisely the shape no per-command check sees.
//
// Four properties, each read out of the script rather than restated here:
//
//   1. Every subcommand any operator-facing document instructs is one the script actually dispatches.
//   2. The dispatch table and the usage line agree, so the refusal an operator meets lists the truth.
//   3. Every subcommand the script dispatches appears in the release contract's enumeration of the
//      dispatch table. Properties 1 and 2 only ever ran documented -> dispatched, so a subcommand that
//      nothing documented was invisible to all of them; `bootstrap` sat outside the contract's "fixed
//      dispatch table" from the day it was added until 2026-08-02, while this gate reported
//      `INSTALLER_DOCS_PASS subcommands=18` against a list of seventeen. It is the command that decides
//      whether a deployment's dossiers carry the fiction marker, so of the eighteen it was the worst one
//      to lose.
//   4. A code block never switches from the release-tree form to the bare PATH form. Going the other way
//      is legitimate and documented — a day-2 block that drops in a release-tree `upgrade` — but once a
//      block has told the reader to stand in the release tree, every later line in it must still work
//      there. Commands whose implementation reads $SOURCE_ROOT are exempt from the comparison, because
//      they are *required* to use the release-tree form; which commands those are is derived from the
//      script, so a new one inherits the rule without anybody remembering to add it here.
//
//   node scripts/validation/installer-docs-gate.mjs

import { globSync, readFileSync } from 'node:fs';

const INSTALLER = 'scripts/installer/openppwr-installer';
const script = readFileSync(INSTALLER, 'utf8');
const findings = [];

// --- What the script really accepts ------------------------------------------------------------------

// The dispatch table is the only authority on which subcommands exist: `usage` is a printf string that can
// drift from it in either direction, which is why both are read and compared rather than one trusted.
const dispatch = script.slice(script.indexOf('case "$command" in'));
const routes = [...dispatch.matchAll(/([a-z][a-z0-9-]*)\)\s+([a-z_]+) "\$@"/gu)]
  .map((match) => ({ subcommand: match[1], handler: match[2] }));
if (routes.length < 10) findings.push(`could not read the dispatch table from ${INSTALLER}; found ${routes.length} routes`);
const subcommands = new Set(routes.map((route) => route.subcommand));

// Read out of `usage()` specifically. Individual refusals print their own one-command usage strings
// ("usage: openppwr-installer journal-retention apply|show"), and the first match in the file is one of
// those, not the real thing.
const usageLine = /^usage\(\)\{[^\n]*'usage: openppwr-installer ([^']+)'/mu.exec(script);
if (!usageLine) findings.push(`could not read the usage line from ${INSTALLER}`);
const documentedInUsage = new Set((usageLine?.[1] ?? '').split('|').map((entry) => entry.trim().split(/\s+/u)[0]));

for (const subcommand of subcommands) {
  if (!documentedInUsage.has(subcommand)) findings.push(`${INSTALLER}: "${subcommand}" is dispatched but absent from the usage line`);
}
for (const subcommand of documentedInUsage) {
  if (!subcommands.has(subcommand)) findings.push(`${INSTALLER}: usage offers "${subcommand}" but nothing dispatches it`);
}

// --- The other direction: a dispatched subcommand nobody wrote down ------------------------------------

// Checked against one named list rather than against "any mention anywhere". A subcommand appears in prose
// across a dozen files by accident, so "mentioned somewhere" would pass on a coincidence and could not say
// which document was supposed to carry it. The release contract already claims to enumerate the dispatch
// table as a closed set, which makes it the one place that is wrong when a command is missing — so it is
// the place this reads. `journal-retention` is documented on the logging-retention page and appears in no
// first-run sequence; a rule keyed on the deployment pages would have failed on it while leaving
// `bootstrap` alone, which is the wrong answer twice.
//
// The parse is anchored on the contract's own phrase and fails loudly when it cannot find it. A rewording
// that silently disabled this check would restore exactly the blindness it was written for.
const CONTRACT = 'docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md';
const contract = readFileSync(CONTRACT, 'utf8');
// Non-greedy to the first backtick that is immediately followed by a full stop: the enumeration ends
// `` `uninstall`. `` and the sentence after it goes straight on to cite two script paths in backticks, which
// a greedy match would swallow.
const contractTable = /with a fixed dispatch table:([\s\S]*?`)\./u.exec(contract);
if (!contractTable) {
  findings.push(`${CONTRACT}: could not find the "fixed dispatch table" enumeration; the dispatched -> documented check cannot run`);
}
// Each entry is one backticked token, sometimes carrying its mode argument (`backup-key init|show`). The
// subcommand is the first word.
const documentedInContract = new Set(
  [...(contractTable?.[1] ?? '').matchAll(/`([a-z][a-z0-9-]*)[^`]*`/gu)].map((match) => match[1]),
);
if (contractTable) {
  for (const subcommand of subcommands) {
    if (!documentedInContract.has(subcommand)) {
      findings.push(`${CONTRACT}: the installer dispatches "${subcommand}" and the fixed dispatch table does not list it; an operator reading the contract cannot learn the command exists`);
    }
  }
  for (const subcommand of documentedInContract) {
    if (!subcommands.has(subcommand)) {
      findings.push(`${CONTRACT}: the fixed dispatch table lists "${subcommand}" and nothing dispatches it`);
    }
  }
}

// Which handlers read the release tree. `$SOURCE_ROOT` resolves from the script's own location, so a
// handler that reads it produces a different — and wrong — path when run from the installed copy under
// /usr/local/bin. Those subcommands must always be documented in the release-tree form.
const bodies = new Map();
for (const match of script.matchAll(/^([a-z_]+)\(\)\{[\s\S]*?^\}/gmu)) bodies.set(match[1], match[0]);
const treeOnly = new Set(routes.filter((route) => bodies.get(route.handler)?.includes('$SOURCE_ROOT')).map((route) => route.subcommand));
if (treeOnly.size === 0) findings.push(`${INSTALLER}: no handler reads $SOURCE_ROOT; the release-tree rule cannot be derived`);

// --- What the documents instruct ---------------------------------------------------------------------

// Operator-facing surfaces only. Internal review records quote earlier revisions of these sequences on
// purpose; rewriting a finding to match the fix it caused would destroy the record.
const sources = [
  'README.md',
  ...globSync('docs/deployment/*.md'),
  ...globSync('docs/release/*.md'),
  ...globSync('docs/user/*.md'),
  ...globSync('apps/web/src/docs-content*.js'),
];

// Prose mentions the installed copy by absolute path and names subcommands in passing; neither is an
// instruction. Only what a reader would copy counts, so only code carries the rules below.
function codeBlocks(path, text) {
  if (path.endsWith('.js')) {
    return [...text.matchAll(/\bcode\('((?:[^'\\]|\\.)*)'\)/gu)]
      .map((match) => ({ path, text: match[1].replaceAll('\\n', '\n').replaceAll("\\'", "'") }));
  }
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gmu)].map((match) => ({ path, text: match[1] }));
}

const invocation = /(?:^|\s)((?:[\w./-]*\/)?openppwr-installer)\s+([a-z][a-z0-9-]*)([^\n]*)/gu;

// `bootstrap` and `bootstrap-acme` create the same tenant row through the same function and differ in two
// things a reader cannot see in the command: whether the tenant is marked as a demonstration, and whether
// the synthetic catalogue is loaded. Getting them the wrong way round is silent and permanent -- bootstrap
// runs once per deployment -- and it happened: the first-run block on the clean-install page was changed to
// `bootstrap acme-eu-demo 'ACME Packaging Europe GmbH'`, which produces an ACME-named deployment carrying no
// fiction marker and no data, and every gate stayed green because each was checking something else.
//
// The rule is narrow on purpose: naming ACME while invoking the production form is always wrong, in either
// direction. A document that means the demonstration must say `bootstrap-acme`, and a document showing an
// operator their own deployment must not use the demonstration's name as the example.
const acmeArgument = /acme/iu;

for (const path of sources) {
  const text = readFileSync(path, 'utf8');
  for (const block of codeBlocks(path, text)) {
    const calls = [...block.text.matchAll(invocation)]
      .map((match) => ({ subcommand: match[2], arguments: match[3] || '', form: match[1].includes('/') ? 'tree' : 'path' }));
    let sawTree = false;
    for (const call of calls) {
      if (!subcommands.has(call.subcommand)) {
        findings.push(`${path}: documents "openppwr-installer ${call.subcommand}", which the script does not dispatch`);
        continue;
      }
      if (call.subcommand === 'bootstrap' && acmeArgument.test(call.arguments)) {
        findings.push(`${path}: documents "openppwr-installer bootstrap${call.arguments}" -- the production form named after the demonstration. It creates a tenant with no fiction disclaimer and no catalogue, so every dossier it produces omits the marker. Use "bootstrap-acme" for the demonstration.`);
        continue;
      }
      if (treeOnly.has(call.subcommand)) {
        // Required to be release-tree, and exempt from the transition rule in either direction: a day-2
        // block may legitimately drop one in without changing what the rest of the block assumes.
        if (call.form !== 'tree') {
          findings.push(`${path}: documents "${call.subcommand}" through PATH, but its handler reads $SOURCE_ROOT and refuses when run from the installed copy`);
        }
        continue;
      }
      if (call.form === 'tree') sawTree = true;
      else if (sawTree) {
        findings.push(`${path}: a code block runs "${call.subcommand}" as a bare command after an earlier line in the same block used the release-tree form; the switch depends on install having placed a copy on PATH and says so nowhere`);
      }
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(`INSTALLER_DOCS_FAIL findings=${findings.length}`);
  process.exit(1);
}
console.log(`INSTALLER_DOCS_PASS subcommands=${subcommands.size} contract_listed=${documentedInContract.size} tree_only=${[...treeOnly].join(',')} sources=${sources.length}`);
