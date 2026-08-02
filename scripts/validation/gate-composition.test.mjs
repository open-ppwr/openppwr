// SPDX-License-Identifier: Apache-2.0
//
// The gate lists name npm scripts as strings. Nothing checked that the strings resolve, so deleting a script
// left `full-gate.mjs` declaring a stage that could only ever fail with `Missing script` — every full-gate
// run broken by a change made somewhere else entirely, and found by an unrelated audit rather than by the
// gate itself.
//
// It is the same fault as the one this programme has now met seven times in a different form: a check whose
// subject is not verified to exist. There the gate could not fail; here it could not pass. Both are the gap
// between naming something and confirming it is there.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = new Set(Object.keys(packageManifest.scripts));

function declaredStages(file) {
  return [...readFileSync(file, 'utf8').matchAll(/\{\s*command:\s*'([^']+)'/gu)].map((match) => match[1]);
}

test('every stage the full gate declares exists as an npm script', () => {
  const stages = declaredStages('scripts/validation/full-gate.mjs');
  assert.ok(stages.length > 10, `expected a substantial gate, got ${stages.length} stages`);
  const missing = stages.filter((stage) => !scripts.has(stage));
  assert.deepEqual(missing, [], `full-gate declares npm scripts that do not exist: ${missing.join(', ')}`);
});

test('the full gate declares no stage twice', () => {
  const stages = declaredStages('scripts/validation/full-gate.mjs');
  const duplicates = stages.filter((stage, index) => stages.indexOf(stage) !== index);
  assert.deepEqual(duplicates, [], `a duplicated stage doubles a budget without adding coverage: ${duplicates.join(', ')}`);
});

// The same fault one level down. A workspace's `test:unit` and `test:integration` name their files, and the
// names drift: six test files across four workspaces had no automated caller at all. `apps/worker` declared
// no `test:integration` script whatsoever, so its principal-separation and retention-concurrency suites — 27
// tests, including the ones that prove the API and the worker do not share a database identity — were run
// only by hand. `apps/web` named two of its three unit files. `packages/database` named one of its three
// integration files.
//
// None of them was failing. They were simply never asked, which is the same thing as a gate that cannot fail:
// the property is asserted somewhere, nothing checks the assertion, and the gap is invisible because every
// suite that does run is green.
test('every workspace test file is reachable from an npm script', () => {
  const workspaces = ['apps/api', 'apps/web', 'apps/worker',
    ...readdirSync('packages').map((name) => `packages/${name}`)];
  const unreachable = [];
  for (const workspace of workspaces) {
    let manifest;
    let testFiles;
    try {
      manifest = JSON.parse(readFileSync(`${workspace}/package.json`, 'utf8'));
      testFiles = readdirSync(`${workspace}/test`).filter((name) => name.endsWith('.test.mjs'));
    } catch {
      continue;
    }
    const testCommands = Object.entries(manifest.scripts || {})
      .filter(([name]) => name === 'test' || name.startsWith('test:'))
      .map(([, command]) => command);
    // `node --test` with no path argument is Node's own discovery mode: it finds every test file in the
    // workspace, so it covers all of them. `packages/security` uses exactly this, and an earlier version of
    // this check reported its four files as unreachable — a false positive in a test written to catch false
    // negatives, which would have been a fine way to teach people to ignore it.
    const discoversAll = testCommands.some((command) => /\bnode\s+--test\s*$/u.test(command.trim()));
    if (discoversAll) continue;
    const commands = testCommands.join(' ');
    for (const file of testFiles) {
      // A glob covering this file counts as naming it. `test/*.test.mjs` reaches everything;
      // `test/*.integration.test.mjs` reaches only the integration files.
      const named = commands.includes(`test/${file}`)
        || commands.includes('test/*.test.mjs')
        || (file.endsWith('.integration.test.mjs') && commands.includes('test/*.integration.test.mjs'));
      if (!named) unreachable.push(`${workspace}/test/${file}`);
    }
  }
  assert.deepEqual(unreachable, [], `test files that no npm script runs:\n${unreachable.join('\n')}`);
});

// The fourth shape of the same defect, and the least visible: a script that reports failure by setting
// `process.exitCode` and returning, while something it imported ends the process with `exit(0)`.
//
// `embedded-postgres` depends on `async-exit-hook`, whose `beforeExit` handler calls `process.exit(0)`.
// Importing the test harness therefore used to turn a failing script into a passing one — measured, not
// inferred: `process.exitCode = 1` produced an actual exit code of 0. The harness now restores Node's
// contract, and this test is what keeps it restored, because the failure is invisible from the inside.
// A gate reporting success while its own summary says FAIL is exactly what this session has spent its
// time removing.
test('a non-zero exit code survives importing the test harness', () => {
  const probe = 'await import("../testing/embedded-postgres.mjs"); process.exitCode = 1;';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: 'scripts/validation',
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    1,
    'importing the harness swallowed a non-zero exit code; a failing gate would report success',
  );
});

// Asserted over the manifest rather than by running anything: a script whose target file is absent fails at
// the moment somebody runs it, which for the deployment-only gates may be weeks after the change that broke
// it. Node's own `--test`, `--check` and shell built-ins are not repository paths and are skipped.
test('every npm script that names a repository file names one that exists', () => {
  const missing = [];
  for (const [name, command] of Object.entries(packageManifest.scripts)) {
    for (const token of String(command).split(/\s+/u)) {
      if (!/^(?:apps|packages|scripts|deploy)\/[\w./-]+\.(?:mjs|js|ps1|sh|cjs)$/u.test(token)) continue;
      try {
        readFileSync(token);
      } catch {
        missing.push(`${name} -> ${token}`);
      }
    }
  }
  assert.deepEqual(missing, [], `npm scripts point at files that do not exist:\n${missing.join('\n')}`);
});
