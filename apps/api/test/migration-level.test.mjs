// The startup rule for a declared migration level that disagrees with the applied one.
//
// It is a decision about whether a deployment may start, so it is a pure function tested without a database
// and without a server: the cases that matter are the ones nobody wants to reproduce live, and an upgrade
// that will not start is one of them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationLevelFinding } from '../src/app.mjs';

test('agreement is not a finding', () => {
  assert.equal(migrationLevelFinding('036', '036'), null);
  // Zero padding is a naming convention of the migration files, not a fact about the level.
  assert.equal(migrationLevelFinding('36', '036'), null);
});

test('a database behind the image refuses the start', () => {
  const finding = migrationLevelFinding('036', '035');
  assert.equal(finding.fatal, true);
  assert.match(finding.message, /036/u);
  assert.match(finding.message, /035/u);
  // The message must name the action, because the operator reading it is mid-deployment.
  assert.match(finding.message, /Run the migrations/u);
});

// The direction an upgrade and a rollback both pass through. Refusing it would mean an operator whose
// deployment is already unhappy cannot go back to the image that worked.
test('a database ahead of the image warns and starts', () => {
  const finding = migrationLevelFinding('035', '036');
  assert.equal(finding.fatal, false);
  assert.match(finding.message, /upgrade or a deliberate rollback/u);
});

test('an unknown level on either side compares to nothing', () => {
  // The Dockerfile default, which every locally built image carries.
  assert.equal(migrationLevelFinding('unknown', '036'), null);
  // A database that has never been migrated has no applied level at all.
  assert.equal(migrationLevelFinding('036', null), null);
  assert.equal(migrationLevelFinding(undefined, undefined), null);
  assert.equal(migrationLevelFinding('', ''), null);
  // Not a number is not a level. Treating it as one would compare NaN and report agreement.
  assert.equal(migrationLevelFinding('036-hotfix', '036'), null);
});
