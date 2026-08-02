// The SECURITY DEFINER execution boundary, enumerated from a real database rather than from the migrations.
//
// A SECURITY DEFINER function runs with its owner's rights. One callable by PUBLIC hands those rights to
// anything that can open a connection. Migration 005 created `revoke_openppwr_session` and granted EXECUTE to
// the application role *without revoking from PUBLIC first* — PostgreSQL grants EXECUTE to PUBLIC by default,
// so the explicit grant added nothing the function did not already have. Fixing that one function would
// have left the property untested.
//
// Migration 011 revokes and then asserts the property inside the migration. This file asserts it again from
// outside, against the schema as actually built, because a migration's own assertion runs once at apply time
// and cannot speak for a function added later by a different migration.
//
// The check reads `pg_proc.proacl`. `NULL` means the defaults are still in force, which include EXECUTE for
// PUBLIC; an aclitem whose grantee is empty is an explicit PUBLIC grant. Either is a finding.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

let database;

before(async () => {
  database = await startTestDatabase('api-security-definer');
  await migrate(database.adminUrl);
});

after(async () => {
  await database?.stop();
});

const definerFunctions = async () => (await database.admin.query(`
  SELECT p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.proacl IS NULL AS default_acl,
         coalesce(array_to_string(p.proacl, ','), '') AS acl,
         pg_get_userbyid(p.proowner) AS owner,
         p.proconfig AS config,
         p.prosrc AS source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
   ORDER BY p.proname`)).rows;

// The exact set, by name. A count would pass against the wrong nine, and a threshold would pass against a
// schema that had silently lost one. The first version of this test asserted `>= 10` from a guess and failed
// against the real schema, which is how the miscount below came to light.
const EXPECTED_DEFINER_FUNCTIONS = Object.freeze([
  // Migration 018 replaced `lookup_openppwr_demo_user` and `issue_openppwr_session` with one operation that
  // verifies and issues together. Both were dropped rather than revoked: sign-in split across two
  // primitives held by one principal is a boundary only in the description of it.
  // Migration 020 moved the audit write behind a function, and 019 added lease renewal.
  'append_openppwr_audit_event',
  'authenticate_openppwr_demo_login',
  'authenticate_openppwr_token',
  'bootstrap_openppwr_demo_users',
  'bootstrap_openppwr_identities',
  // Migration 021 moved every retention transition behind a function: the fence was in a function while the
  // capability sat in a table-wide UPDATE grant.
  'claim_openppwr_retention',
  'complete_openppwr_retention',
  'create_openppwr_tenant',
  'mark_openppwr_retention_uncertain',
  'openppwr_demo_login_salt',
  'openppwr_tenant_count',
  'reclaim_openppwr_retention',
  'release_openppwr_retention',
  'renew_openppwr_retention_lease',
  // Migration 028: an operator requeue of a dead scan job, gated on the tenant-admin permission inside
  // the function body rather than left as a table-wide UPDATE grant.
  'requeue_openppwr_scan_job',
  'reset_openppwr_demo_tenant',
  'revoke_openppwr_identity_token',
  'revoke_openppwr_session',
  // Migration 034: the supported per-identity credential rotation. It mints the replacement itself, derives
  // the actor from the credential presented, records the change and ends the target's sessions — none of
  // which the 009 function beside it does.
  'rotate_openppwr_identity_credential',
  'rotate_openppwr_identity_token',
]);

// Which principal may call what (migration 014). Being SECURITY DEFINER and having a fixed search_path says
// the function is not a privilege-escalation primitive; it says nothing about who should hold it. Two of
// these were reachable by the request-serving role and were used, in a reproduced attack, to mint a session
// with no credential and to wipe a tenant the caller named.
const EXECUTE_BY_ROLE = Object.freeze({
  openppwr_app: [
    'append_openppwr_audit_event',
    'authenticate_openppwr_token',
    // One-time and self-closing: they refuse once any identity or demonstration account exists.
    'bootstrap_openppwr_demo_users',
    'bootstrap_openppwr_identities',
    'create_openppwr_tenant',
    'openppwr_tenant_count',
    // Migration 028. The route it backs (`POST /v1/scan-jobs/:id/requeue`) is gated on the tenant-admin
    // permission inside the function body — the request-serving role must still hold EXECUTE to reach it.
    'requeue_openppwr_scan_job',
    'revoke_openppwr_session',
    // Genuine proof-of-possession again. The argument was a formality while the caller could read the
    // verifier it was asked to present; it no longer can, because SELECT on identities is now column-level
    // and excludes token_hash.
    //
    // `rotate_openppwr_identity_token` left this list in migration 034. Rotation is a credential write, and
    // the supported path runs on the credential principal below; leaving the 009 function reachable here
    // would have been a second door to the same write — one that records nothing and ends no session.
    'revoke_openppwr_identity_token',
  ],
  // Sign-in and credential rotation: the two operations that read or replace a credential verifier, held
  // away from the role that answers requests. Sign-in verifies the presented credential and issues the
  // resulting session in one call, so there is no half of the operation for another principal to hold;
  // rotation resolves the actor from the credential presented and mints the replacement itself, so there is
  // no hash for a caller to choose.
  openppwr_auth: ['authenticate_openppwr_demo_login', 'openppwr_demo_login_salt', 'rotate_openppwr_identity_credential'],
  // Migration 035. Rotation alone, on a principal a production deployment may load — which `openppwr_auth`
  // above is not, because sign-in is a demonstration capability and the API refuses to start holding it.
  // This list being exactly one entry is the entire argument for that: EXECUTE on the rotation function is
  // not authority by itself, since the function resolves the actor from the credential presented, whereas
  // the two entries above hand a caller a password verifier and a session for the asking.
  openppwr_rotation: ['rotate_openppwr_identity_credential'],
  // The reset, and the right to record that it happened — nothing else. The append function refuses any
  // action other than `demo.reset` from this principal.
  openppwr_maintenance: ['append_openppwr_audit_event', 'reset_openppwr_demo_tenant'],
  // Migration 022. The worker is a separate service and therefore a separate identity: the retention
  // state machine was callable from the request-serving process for as long as both shared
  // openppwr_app, which is why moving it behind functions made the boundary worse rather than better.
  openppwr_worker: [
    'append_openppwr_audit_event',
    'authenticate_openppwr_token',
    'claim_openppwr_retention',
    'complete_openppwr_retention',
    'mark_openppwr_retention_uncertain',
    // Migration 029. The worker's own startup tenancy guard (assertSingleTenantDeployment) calls this,
    // and the grant was never extended to the worker's own principal when migration 022 split it out.
    'openppwr_tenant_count',
    'reclaim_openppwr_retention',
    'release_openppwr_retention',
    'renew_openppwr_retention_lease',
  ],
});

test('the schema defines exactly the expected SECURITY DEFINER functions', async () => {
  const functions = await definerFunctions();
  assert.deepEqual(
    functions.map((row) => row.name).sort(),
    [...EXPECTED_DEFINER_FUNCTIONS].sort(),
    'the set of owner-privileged functions changed; each addition needs its grants and search_path reviewed',
  );
});

// The property, over every function rather than the two the finding named.
test('no SECURITY DEFINER function is executable by PUBLIC', async () => {
  const functions = await definerFunctions();
  const exposed = functions.filter((row) => row.default_acl || row.acl.split(',').some((entry) => entry.startsWith('=')));
  assert.deepEqual(
    exposed.map((row) => `${row.name}(${row.args})`),
    [],
    'these run with their owner\'s rights and anything that can connect may call them',
  );
});

// A fixed search_path is what stops a caller resolving an unqualified name to an object of their own. Without
// it, SECURITY DEFINER is a privilege-escalation primitive rather than a boundary.
test('every SECURITY DEFINER function fixes its search_path', async () => {
  const functions = await definerFunctions();
  const unfixed = functions.filter((row) => !(row.config || []).some((entry) => entry.startsWith('search_path=')));
  assert.deepEqual(unfixed.map((row) => row.name), [], 'a SECURITY DEFINER function without a fixed search_path is not a boundary');

  for (const row of functions) {
    const setting = (row.config || []).find((entry) => entry.startsWith('search_path='));
    // `public, pg_temp` is the shipped value. `pg_temp` must be last: a temporary object shadows a permanent
    // one when its schema is searched first, which is the classic escalation this setting exists to prevent.
    assert.match(setting, /^search_path=/u);
    const value = setting.slice('search_path='.length).split(',').map((part) => part.trim());
    assert.ok(!value.includes('"$user"'), `${row.name} searches "$user", which a caller controls`);
    if (value.includes('pg_temp')) {
      assert.equal(value.at(-1), 'pg_temp', `${row.name} searches pg_temp before a permanent schema`);
    }
  }
});

// The runtime role must hold exactly the EXECUTE it needs. Two functions are deliberately callable by nobody
// but the owner: the audit trigger guards, which PostgreSQL invokes as triggers without consulting EXECUTE.
test('each role holds EXECUTE on exactly the definer functions its job requires', async () => {
  const functions = await definerFunctions();
  for (const [role, expected] of Object.entries(EXECUTE_BY_ROLE)) {
    const granted = functions.filter((row) => row.acl.includes(`${role}=X`)).map((row) => row.name).sort();
    // Asserted as a set rather than a subset. A subset check passes against a role that has been granted
    // more than it needs, which is the condition being tested for.
    assert.deepEqual(granted, [...expected].sort(), `${role} does not hold exactly its intended EXECUTE grants`);
  }
});

// Stated separately and positively, because these are the two capabilities whose presence on the request
// role was the finding. A reader should not have to derive them from the table above.
test('the request-serving role can neither mint a session nor reset a tenant', async () => {
  const functions = await definerFunctions();
  // The two primitives that made the split possible are gone from the schema entirely, which is stronger
  // than being unreachable: a revoked grant is one GRANT away from returning.
  for (const name of ['issue_openppwr_session', 'lookup_openppwr_demo_user']) {
    assert.equal(functions.find((entry) => entry.name === name), undefined, `${name} still exists and can be granted back`);
  }
  for (const name of ['reset_openppwr_demo_tenant', 'authenticate_openppwr_demo_login', 'openppwr_demo_login_salt']) {
    const row = functions.find((entry) => entry.name === name);
    assert.ok(row, `${name} is missing from the schema`);
    assert.ok(!row.acl.includes('openppwr_app=X'), `openppwr_app can still call ${name}`);
  }
});

// `openppwr_current_tenant` is SECURITY INVOKER, not DEFINER — a fact this suite established by failing.
// Migration 011 revoked its default PUBLIC grant anyway, which is correct hardening and was described
// inaccurately at the time. It must stay callable by the application role, because every row-level-security
// policy in the schema calls it and policy expressions are evaluated as the querying role: without EXECUTE,
// every policy fails on a permission error, which is an outage rather than a safeguard.
test('the RLS helper is not owner-privileged, is not public, and is still callable by the application role', async () => {
  const row = (await database.admin.query(`
    SELECT p.prosecdef AS definer, coalesce(array_to_string(p.proacl, ','), '') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'openppwr_current_tenant'`)).rows[0];
  assert.ok(row, 'openppwr_current_tenant is missing');
  assert.equal(row.definer, false, 'the RLS helper does not need owner rights and must not have them');
  assert.ok(!row.acl.split(',').some((entry) => entry.startsWith('=')), 'it must not be executable by PUBLIC');

  const may = (await database.admin.query(
    `SELECT has_function_privilege('openppwr_app', 'openppwr_current_tenant()', 'EXECUTE') AS ok`,
  )).rows[0];
  assert.equal(may.ok, true, 'every RLS policy calls this; without EXECUTE the application cannot read anything');
});

// The audit trigger guards are also SECURITY INVOKER. PostgreSQL checks EXECUTE when a trigger is created,
// not when it fires, so revoking afterwards removes a direct call nobody needs while the guards keep working.
test('the audit trigger guards are not executable by anyone but their owner', async () => {
  const rows = (await database.admin.query(`
    SELECT p.proname AS name, coalesce(array_to_string(p.proacl, ','), '<default>') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('reject_audit_mutation', 'reject_audit_truncate')
     ORDER BY p.proname`)).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.acl, '<default>', `${row.name} still has the default PUBLIC grant`);
    assert.ok(!row.acl.split(',').some((entry) => entry.startsWith('=')), `${row.name} is executable by PUBLIC`);
    assert.ok(!row.acl.includes('openppwr_app=X'), `${row.name} is a trigger guard and needs no direct EXECUTE`);
  }
});

// Dynamic SQL inside a definer function is where an injected identifier becomes an owner-privileged
// statement. None is expected; this asserts it rather than trusting a reading.
test('no SECURITY DEFINER function builds dynamic SQL from its arguments', async () => {
  const functions = await definerFunctions();
  const dynamic = functions.filter((row) => /\bEXECUTE\s+(?:format\(|'|"|\|\|)/iu.test(row.source));
  assert.deepEqual(dynamic.map((row) => row.name), [], 'dynamic SQL in a definer function runs with the owner\'s rights');
});

// The one-tenant rule must live inside the function, not in a caller trusted to have counted. Migration 008
// moved it there precisely because the tenants registry now has a self-only policy that would make a caller's
// count always return zero.
test('the one-tenant rule is enforced inside create_openppwr_tenant', async () => {
  const functions = await definerFunctions();
  const create = functions.find((row) => row.name === 'create_openppwr_tenant');
  assert.ok(create, 'create_openppwr_tenant is missing');
  assert.match(create.source, /pg_advisory_xact_lock/u, 'tenant creation must serialise, or two callers race the count');
  assert.match(create.source, /count\(\*\)|openppwr_tenant_count/u, 'the rule must consult the registry inside the function');

  // And the application role must not be able to reach the table directly.
  const insert = await database.admin.query(
    `SELECT has_table_privilege('openppwr_app', 'tenants', 'INSERT') AS may_insert`,
  );
  assert.equal(insert.rows[0].may_insert, false, 'the application role can insert a tenant without the function');
});

// RLS on the registry itself. A tenant row readable by every tenant is a directory of deployments.
test('the tenants registry carries RLS and FORCE RLS', async () => {
  const row = (await database.admin.query(
    `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'tenants'`,
  )).rows[0];
  assert.equal(row.rls, true);
  assert.equal(row.force, true);
});

// Every tenant-scoped table, not only the ones a finding named. FORCE matters because without it the table
// owner bypasses the policy, and the owner is the role migrations run as.
test('every tenant-scoped table carries RLS and FORCE RLS', async () => {
  const rows = (await database.admin.query(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`)).rows;
  assert.ok(rows.length >= 12, `expected many tenant-scoped tables, found ${rows.length}`);
  const missing = rows.filter((row) => !row.rls || !row.force);
  assert.deepEqual(missing.map((row) => row.name), [], 'a tenant-scoped table without RLS and FORCE RLS is isolated by convention only');
});

// The guard that makes migration 011's assertion meaningful for the future: a new definer function added by a
// later migration must be caught here even if nobody re-reads 011.
test('a hypothetical new definer function would be caught by this suite', async () => {
  const name = `probe_${randomUUID().replaceAll('-', '')}`;
  await database.admin.query(`CREATE FUNCTION ${name}() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`);
  try {
    const functions = await definerFunctions();
    const probe = functions.find((row) => row.name === name);
    assert.ok(probe, 'the enumeration does not see a newly created function');
    assert.equal(probe.default_acl, true, 'a new function defaults to PUBLIC EXECUTE, which is the hazard');
    assert.ok(!(probe.config || []).some((entry) => entry.startsWith('search_path=')), 'and defaults to no fixed search_path');
  } finally {
    await database.admin.query(`DROP FUNCTION ${name}()`);
  }
});
