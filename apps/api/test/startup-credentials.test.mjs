// Which privileged database URLs a process may load, per posture.
//
// The rule lives in `forbiddenPrivilegedVariables` and is enforced at startup in `apps/api/src/server.mjs`.
// It is tested here rather than by starting a server because the property is a decision about an
// environment, and a test that has to boot a process to ask it will not be run when the answer changes.
//
// The reason this file exists at all: making credential rotation reachable in production means adding a
// privileged database URL that a production deployment *may* hold, and the obvious way to get that wrong is
// to relax the refusal that keeps the session-issuing credential out. These assertions state that the
// refusal is unchanged, one variable at a time.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoProfileFinding, forbiddenPrivilegedVariables } from '../src/app.mjs';

const AUTH = 'OPENPPWR_AUTH_DATABASE_URL';
const MAINTENANCE = 'OPENPPWR_MAINTENANCE_DATABASE_URL';
const ROTATION = 'OPENPPWR_ROTATION_DATABASE_URL';

const url = (role) => `postgres://${role}:secret@postgres/openppwr`;

test('a production process may not load the session-issuing or reset credential', () => {
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [AUTH]: url('openppwr_auth') }, false),
    [AUTH],
    'session issuance is authority by itself: EXECUTE produces a working session for any identity, having proved nothing',
  );
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [MAINTENANCE]: url('openppwr_maintenance') }, false),
    [MAINTENANCE],
    'the reset deletes a tenant, and a deployment holding real data has no use for it',
  );
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [AUTH]: url('openppwr_auth'), [MAINTENANCE]: url('openppwr_maintenance') }, false),
    [AUTH, MAINTENANCE],
    'both are reported, so an operator fixes the deployment once rather than twice',
  );
});

// The single assertion that makes the rotation route reachable in production, stated on its own so that
// relaxing it cannot be mistaken for an incidental edit.
test('a production process may load the rotation credential, and only that one', () => {
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [ROTATION]: url('openppwr_rotation') }, false),
    [],
    'without this a production deployment has no supported way to replace a leaked bearer token',
  );
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [ROTATION]: url('openppwr_rotation'), [AUTH]: url('openppwr_auth') }, false),
    [AUTH],
    'permitting rotation must not carry sign-in into production alongside it',
  );
});

test('the demonstration profile is the only posture where every privileged credential is permitted', () => {
  assert.deepEqual(
    forbiddenPrivilegedVariables({
      [AUTH]: url('openppwr_auth'), [MAINTENANCE]: url('openppwr_maintenance'), [ROTATION]: url('openppwr_rotation'),
    }, true),
    [],
    'the demonstration exists to exercise all of it; that is what makes it unsuitable for real data',
  );
});

test('an empty value is not a set one', () => {
  assert.deepEqual(
    forbiddenPrivilegedVariables({ [AUTH]: '', [MAINTENANCE]: undefined }, false),
    [],
    'Compose leaves an unconfigured variable as the empty string, which is how a production deployment arrives',
  );
});

// The mirror direction, and the one that shipped broken.
//
// A deployment declaring demonstration sign-in without the credential that performs it did not fail: it
// served `404` from `/v1/login` while `/v1/demo/accounts` kept publishing the password, so the product
// advertised credentials it refused. These assertions are what makes that state impossible to start.
test('declaring demonstration sign-in without the credential that performs it is refused', () => {
  const finding = demoProfileFinding({}, true);
  assert.ok(finding, 'a deployment that says sign-in works, and cannot, must not start silently');
  assert.equal(finding.fatal, true, 'there is no window in which this disagreement is transient: both values come from one file at one instant');
  assert.match(finding.message, /OPENPPWR_AUTH_DATABASE_PASSWORD/u, 'the message must name the variable that repairs it, not merely the one that is wrong');
  assert.match(finding.message, /OPENPPWR_DEMO_LOGIN=false/u, 'and the other legitimate resolution, for a deployment that is not a demonstration');
});

test('the demonstration profile with its credential present is not a finding', () => {
  assert.equal(
    demoProfileFinding({ [AUTH]: url('openppwr_auth') }, true),
    null,
    'this is the ordinary demonstration deployment and it must start',
  );
});

test('a production deployment without demonstration sign-in is not a finding', () => {
  assert.equal(demoProfileFinding({}, false), null, 'absent flag, absent credential: consistent, and the shipped default');
  assert.equal(
    demoProfileFinding({ [ROTATION]: url('openppwr_rotation') }, false),
    null,
    'holding rotation alone is the supported production posture and must not be confused with a broken demonstration',
  );
});

test('an empty auth URL does not satisfy the demonstration profile', () => {
  const finding = demoProfileFinding({ [AUTH]: '' }, true);
  assert.ok(finding?.fatal, 'Compose renders an unset password as the empty string, which is exactly how the broken deployment arrived');
});
