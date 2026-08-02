// SPDX-License-Identifier: Apache-2.0
// The classification behind `cleanup=PASS`.
//
// Tested against constructed process tables rather than against a real leak, and that is a deliberate
// choice rather than a convenience. The leak cannot be staged: stopping a test runner takes its database
// down with it, which is the tidy case. The six orphans measured on this workstation appeared through
// paths nobody reproduced on demand — so what is testable is the judgement, and the judgement is where
// this can go wrong in the two ways that matter. Missing a real orphan makes the check decorative;
// claiming somebody else's PostgreSQL makes it dangerous.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOrphans } from './orphan-check.mjs';

// A synthetic checkout path, not this workstation's. The fixture only needs *a* path for the
// classification to match against, and using the real one published a maintainer's directory layout into
// the public export -- which the export validator has no rule for and let through.
const ROOT = 'C:\\src\\openppwr';
const inCheckout = (extra = '') => `C:/src/openppwr/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe${extra}`;

test('a watched process whose parent is gone is this run\'s litter', () => {
  const table = [
    { pid: 100, parent: 999, name: 'postgres.exe', command: inCheckout(' --forkchild="io_worker"') },
  ];
  const { orphans } = findOrphans(table, ROOT);
  assert.equal(orphans.length, 1, 'a reparented database from this checkout is exactly what this check exists to find');
  assert.equal(orphans[0].pid, 100);
});

test('a watched process whose parent is alive is somebody still working', () => {
  const table = [
    { pid: 42, parent: 1, name: 'node.exe', command: 'node --test' },
    { pid: 100, parent: 42, name: 'postgres.exe', command: inCheckout() },
  ];
  const { matched, orphans } = findOrphans(table, ROOT);
  assert.equal(matched.length, 1, 'it is still a watched process from this checkout');
  assert.equal(orphans.length, 0, 'but a live parent means a gate is still running, and killing it would break that run');
});

test('another checkout\'s leak is not ours to report or to kill', () => {
  const table = [
    { pid: 100, parent: 999, name: 'postgres.exe', command: 'C:/other/project/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe' },
    { pid: 101, parent: 999, name: 'postgres.exe', command: 'C:/Program Files/PostgreSQL/18/bin/postgres.exe' },
  ];
  const { matched, orphans } = findOrphans(table, ROOT);
  assert.equal(matched.length, 0, 'a developer\'s own database and a parallel checkout are not this run\'s litter');
  assert.equal(orphans.length, 0);
});

test('the checkout is matched however the platform spells it', () => {
  const table = [
    { pid: 100, parent: 999, name: 'postgres.exe', command: 'c:\\src\\openppwr\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin\\postgres.exe' },
  ];
  const { orphans } = findOrphans(table, ROOT);
  assert.equal(orphans.length, 1, 'backslashes and a lower-case drive letter are the same checkout, and a leak must not hide behind either');
});

test('an unwatched binary from this checkout is left alone', () => {
  const table = [
    { pid: 100, parent: 999, name: 'node.exe', command: 'C:/src/openppwr/node_modules/.bin/vite' },
  ];
  const { matched } = findOrphans(table, ROOT);
  assert.equal(matched.length, 0, 'the watch list names the binaries a suite starts and does not wait for, not everything in the tree');
});

test('every orphan is reported, not only the first', () => {
  const table = [
    { pid: 100, parent: 900, name: 'postgres.exe', command: inCheckout() },
    { pid: 101, parent: 901, name: 'postgres.exe', command: inCheckout() },
    { pid: 102, parent: 100, name: 'postgres.exe', command: inCheckout() },
  ];
  const { orphans } = findOrphans(table, ROOT);
  assert.deepEqual(orphans.map((entry) => entry.pid), [100, 101], 'pid 102 has a live parent in this table -- the one still supervised is not litter');
});
