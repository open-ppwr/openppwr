import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AUTHORIZATION_MATRIX, HUMAN_ROLE_NAMES, PERMISSION_CATALOGUE, SUPPORTED_ROLES,
  assertRegistryIsSound, derivePermissions, isAllowed, mayRotateCredential, permissionsFor,
} from '../src/permissions.mjs';

const mutationPermissions = ['packaging:write','evidence:upload','evidence:review','assessment:run','gap:manage','review:freeze','dossier:generate','scan:process','scan:requeue'];

test('every supported role has explicit mutation decisions', () => {
  const roles = ['tenant_admin','compliance_manager','packaging_editor','evidence_contributor','evidence_reviewer','read_only_auditor','supplier_user','service_account','worker'];
  assert.deepEqual(Object.keys(AUTHORIZATION_MATRIX), roles);
  for (const role of roles) {
    for (const permission of mutationPermissions) assert.equal(typeof isAllowed({ role }, permission), 'boolean');
  }
});

test('human and machine responsibilities remain separated', () => {
  assert.equal(isAllowed({ role: 'evidence_reviewer' }, 'evidence:review'), true);
  assert.equal(isAllowed({ role: 'worker' }, 'evidence:review'), false);
  assert.equal(isAllowed({ role: 'service_account' }, 'evidence:review'), false);
  assert.equal(isAllowed({ role: 'worker' }, 'scan:process'), true);
  assert.equal(isAllowed({ role: 'evidence_reviewer' }, 'scan:process'), false);
  assert.equal(isAllowed({ role: 'tenant_admin' }, 'scan:requeue'), true);
  assert.equal(isAllowed({ role: 'worker' }, 'scan:requeue'), false);
  assert.equal(isAllowed({ role: 'read_only_auditor' }, 'packaging:write'), false);
});

test('supplier ABAC denies another supplier without revealing existence', () => {
  const identity = { role: 'supplier_user', supplierId: 'ACME-SUP-001' };
  assert.equal(isAllowed(identity, 'evidence:upload', { supplierId: 'ACME-SUP-001' }), true);
  assert.equal(isAllowed(identity, 'evidence:upload', { supplierId: 'ACME-SUP-002' }), false);
});

// Regression: the role that generates a dossier could not download it. The generating role holds
// dossier:generate but the download route required dossier:download, so the workbench listed the
// artifacts it had just produced and every download returned 404.
test('a role that can generate a dossier can retrieve it', () => {
  for (const role of Object.keys(AUTHORIZATION_MATRIX)) {
    if (isAllowed({ role }, 'dossier:generate')) {
      assert.equal(isAllowed({ role }, 'dossier:download'), true, `${role} generates dossiers but cannot download them`);
    }
  }
});

test('dossier download stays denied to roles with no dossier responsibility', () => {
  for (const role of ['packaging_editor', 'evidence_contributor', 'evidence_reviewer', 'supplier_user', 'worker']) {
    assert.equal(isAllowed({ role }, 'dossier:download'), false, `${role} must not download dossiers`);
  }
  assert.equal(isAllowed({ role: 'read_only_auditor' }, 'dossier:download'), true);
  assert.equal(isAllowed({ role: 'read_only_auditor' }, 'dossier:generate'), false);
});

// Regression: the compliance manager freezes the review and generates the dossier, but could not
// verify the audit chain behind it. The workbench offered the action to every role, so the refusal
// surfaced as RESOURCE_NOT_FOUND on a button the user was invited to press.
test('every role that can freeze a review can verify the record behind it', () => {
  for (const role of Object.keys(AUTHORIZATION_MATRIX)) {
    if (isAllowed({ role }, 'review:freeze')) {
      assert.equal(isAllowed({ role }, 'audit:verify'), true, `${role} freezes reviews but cannot verify the audit chain`);
    }
  }
  assert.equal(isAllowed({ role: 'read_only_auditor' }, 'audit:verify'), true);
});

test('audit verification stays denied to roles with no review responsibility', () => {
  for (const role of ['packaging_editor', 'evidence_contributor', 'evidence_reviewer', 'supplier_user', 'worker', 'service_account']) {
    assert.equal(isAllowed({ role }, 'audit:verify'), false, `${role} must not verify the audit chain`);
  }
});

// The client decides what to offer from this list, so a role must never be told it holds something the
// server would refuse.
test('reported capabilities match the enforced decisions', () => {
  for (const role of Object.keys(AUTHORIZATION_MATRIX)) {
    const reported = permissionsFor(role);
    assert.ok(!reported.includes('*'), `${role} must not report the wildcard as a permission`);
    for (const permission of reported) {
      assert.equal(isAllowed({ role }, permission), true, `${role} reports ${permission} but is refused it`);
    }
  }
  assert.ok(permissionsFor('tenant_admin').includes('audit:verify'));
  assert.deepEqual(permissionsFor('worker'), ['scan:process']);
  assert.deepEqual(permissionsFor('nonexistent_role'), []);
});

// ---------------------------------------------------------------------------------------------------
// Credential rotation. Two ways to qualify, and they must not collapse into one another: an identity
// replaces its own credential because it holds it, and an administrator replaces somebody else's because it
// holds `credential:rotate`. A test that only proved the administrator case would pass against a rule that
// left every other role unable to fix its own leaked token, which is the failure the capability removes.
// ---------------------------------------------------------------------------------------------------

const OWN = 'ab6f3f8e-0c6a-4d4d-8a02-6e0f0b1d5a11';
const OTHER = 'f0c1d2e3-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

test('every role may replace its own credential, whatever else it holds', () => {
  for (const role of SUPPORTED_ROLES) {
    assert.equal(
      mayRotateCredential({ role, actorId: OWN }, OWN), true,
      `${role} must be able to replace the credential it already holds`,
    );
  }
});

test('only the tenant administrator may replace another identity\'s credential', () => {
  for (const role of SUPPORTED_ROLES) {
    assert.equal(
      mayRotateCredential({ role, actorId: OWN }, OTHER), role === 'tenant_admin',
      `${role} must ${role === 'tenant_admin' ? 'hold' : 'be refused'} authority over another identity's credential`,
    );
  }
  assert.equal(isAllowed({ role: 'compliance_manager' }, 'credential:rotate'), false);
  assert.equal(isAllowed({ role: 'service_account' }, 'credential:rotate'), false);
  assert.equal(isAllowed({ role: 'worker' }, 'credential:rotate'), false);
});

// Self-service is decided by identity, not by a value the caller could omit or shape. A missing actor, a
// missing target or a non-string target must not resolve to "these are the same identity".
test('rotation authority is refused when either identity is absent or malformed', () => {
  for (const identity of [null, undefined, {}, { role: 'tenant_admin' }, { role: 'supplier_user', actorId: '' }]) {
    assert.equal(mayRotateCredential(identity, OWN), false, `an actorless caller must not rotate: ${JSON.stringify(identity)}`);
  }
  for (const target of [null, undefined, '', 42, {}, ['x']]) {
    assert.equal(mayRotateCredential({ role: 'tenant_admin', actorId: OWN }, target), false, `a malformed target must be refused: ${String(target)}`);
    assert.equal(mayRotateCredential({ role: 'supplier_user', actorId: OWN }, target), false);
  }
});

// ---------------------------------------------------------------------------------------------------
// `tenant_admin` was `['*']`. These tests are the boundary that replaces it.
// ---------------------------------------------------------------------------------------------------

test('the tenant administrator holds an explicit set, not a wildcard', () => {
  const granted = permissionsFor('tenant_admin');
  assert.ok(granted.length > 0);
  assert.ok(!granted.includes('*'), 'the administrator must not hold a wildcard');
  // Every Community human permission an administrator is meant to hold, named individually. A test that
  // asserted only "more than zero" would have passed against the wildcard too.
  for (const permission of ['read', 'packaging:write', 'evidence:upload', 'evidence:review', 'evidence:download', 'assessment:run', 'gap:manage', 'review:freeze', 'dossier:generate', 'dossier:download', 'audit:verify', 'scan:requeue', 'credential:rotate']) {
    assert.equal(isAllowed({ role: 'tenant_admin' }, permission), true, `the administrator must hold ${permission}`);
  }
});

// The defect itself: under the wildcard the administrator held the worker's permission, and
// docs/security/AUTHORIZATION_MATRIX.md said it did not.
test('the tenant administrator does not hold the worker machine permission', () => {
  assert.equal(isAllowed({ role: 'tenant_admin' }, 'scan:process'), false);
  assert.ok(!permissionsFor('tenant_admin').includes('scan:process'));
  for (const role of HUMAN_ROLE_NAMES) {
    for (const [permission, entry] of Object.entries(PERMISSION_CATALOGUE)) {
      if (entry.audience !== 'human') {
        assert.equal(isAllowed({ role }, permission), false, `${role} is human and must not hold ${entry.audience} permission ${permission}`);
      }
    }
  }
});

test('an unknown permission is denied to every role, including the administrator', () => {
  for (const role of SUPPORTED_ROLES) {
    for (const candidate of ['tenant:delete', 'billing:manage', 'read:all', '', 'READ', 'scan:process ']) {
      assert.equal(isAllowed({ role }, candidate), false, `${role} must be denied unknown permission "${candidate}"`);
    }
  }
});

// A wildcard must not be honoured as a permission *name* either, whatever route, typo or persisted value
// produces it.
test('the wildcard is refused as a permission name', () => {
  for (const role of SUPPORTED_ROLES) {
    assert.equal(isAllowed({ role }, '*'), false, `${role} must be refused "*"`);
  }
  assert.equal(isAllowed({ role: 'tenant_admin' }, '*'), false);
  for (const value of [null, undefined, 42, {}, ['read'], true]) {
    assert.equal(isAllowed({ role: 'tenant_admin' }, value), false, `a non-string permission must be refused: ${String(value)}`);
  }
});

// A role read from persisted state cannot smuggle a wildcard in, because the role name is looked up in a
// frozen table and an unknown role resolves to no permissions at all.
test('a forged role or wildcard role name grants nothing', () => {
  for (const role of ['*', 'tenant_admin ', 'TENANT_ADMIN', '', null, undefined, 'root']) {
    assert.equal(isAllowed({ role }, 'read'), false, `role "${String(role)}" must grant nothing`);
    assert.deepEqual(permissionsFor(role), []);
  }
});

// The drift guard the wildcard removed. A permission added without an explicit role assignment must fail
// rather than be granted to the administrator by default.
test('a future permission is denied until its assignment is explicit', () => {
  const withUnassigned = { ...PERMISSION_CATALOGUE, 'tenant:rename': { audience: 'human', scope: 'tenant', edition: 'community', roles: [], unassigned: 'awaiting an owner decision on who renames a tenant' } };
  assert.equal(assertRegistryIsSound(withUnassigned), true);
  const derived = derivePermissions(withUnassigned, SUPPORTED_ROLES);
  for (const role of SUPPORTED_ROLES) {
    assert.ok(!derived[role].includes('tenant:rename'), `${role} must not receive an unassigned permission`);
  }
  // Same entry with neither an assignment nor a stated reason: the registry refuses to load.
  const silent = { ...PERMISSION_CATALOGUE, 'tenant:rename': { audience: 'human', scope: 'tenant', edition: 'community', roles: [] } };
  assert.throws(() => assertRegistryIsSound(silent), /assigned to no role/u);
});

test('a machine or system permission cannot be assigned to a human role', () => {
  assert.throws(
    () => assertRegistryIsSound({ ...PERMISSION_CATALOGUE, 'scan:process': { audience: 'machine', scope: 'tenant', edition: 'community', roles: ['worker', 'tenant_admin'] } }),
    /machine-only but is assigned to human role "tenant_admin"/u,
  );
  assert.throws(
    () => assertRegistryIsSound({ ...PERMISSION_CATALOGUE, 'platform:operate': { audience: 'system', scope: 'tenant', edition: 'community', roles: ['tenant_admin'] } }),
    /system-only but is assigned to human role/u,
  );
});

// The Community registry must not grant a permission belonging to another edition, and must not silently
// accept one either.
test('a permission from another edition is refused by the registry', () => {
  assert.throws(
    () => assertRegistryIsSound({ ...PERMISSION_CATALOGUE, 'sso:configure': { audience: 'human', scope: 'tenant', edition: 'enterprise', roles: ['tenant_admin'] } }),
    /belongs to edition "enterprise"/u,
  );
  for (const entry of Object.values(PERMISSION_CATALOGUE)) assert.equal(entry.edition, 'community');
  assert.equal(isAllowed({ role: 'tenant_admin' }, 'sso:configure'), false);
});

test('a global-scope permission cannot be held by a tenant role', () => {
  assert.throws(
    () => assertRegistryIsSound({ ...PERMISSION_CATALOGUE, 'tenant:list-all': { audience: 'system', scope: 'global', edition: 'community', roles: ['tenant_admin'] } }),
    /global in scope/u,
  );
  for (const entry of Object.values(PERMISSION_CATALOGUE)) assert.equal(entry.scope, 'tenant');
});

test('the registry itself contains no wildcard and is sound as shipped', () => {
  assert.ok(!Object.hasOwn(PERMISSION_CATALOGUE, '*'));
  assert.equal(assertRegistryIsSound(), true);
  assert.throws(() => assertRegistryIsSound({ '*': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin'] } }), /must not contain a wildcard/u);
});

// The rendered matrix and the enforced decisions come from one table, and the two must agree cell by
// cell. The build gate checks placement; this checks the grants themselves, so a locale-only build
// failure cannot be the sole thing standing between a wrong matrix and a reader.
test('the role matrix places every catalogued permission exactly once', () => {
  const source = readFileSync(new URL('../../web/src/permission-matrix.js', import.meta.url), 'utf8');
  assert.ok(!source.includes("'*'"), 'the presentation matrix must not place a wildcard');
  for (const permission of Object.keys(PERMISSION_CATALOGUE)) {
    const occurrences = source.split(`'${permission}'`).length - 1;
    assert.equal(occurrences, 1, `${permission} appears ${occurrences} times in the presentation matrix, expected exactly 1`);
  }
});

// Every permission a route actually demands must exist in the catalogue. Under the wildcard a route
// could require a permission no role list mentioned and it would still work — for the administrator
// only, silently. That is exactly what happened to `scan:requeue`.
test('every permission demanded by a route exists in the catalogue', () => {
  const source = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const demanded = new Set([...source.matchAll(/(?:requirePermission|isAllowed)\(\s*request\.identity\s*,\s*'([^']+)'/gu)].map((match) => match[1]));
  assert.ok(demanded.size >= 10, `expected the route table to demand several permissions, found ${demanded.size}`);
  for (const permission of demanded) {
    assert.ok(Object.hasOwn(PERMISSION_CATALOGUE, permission), `route code demands "${permission}", which the catalogue does not define`);
    assert.ok([...Object.values(AUTHORIZATION_MATRIX)].some((granted) => granted.includes(permission)), `route code demands "${permission}", which no role holds`);
  }
});
