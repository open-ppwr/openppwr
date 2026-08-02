// The privilege model, asserted against the schema PostgreSQL actually built.
//
// Migration 014 asserts its own outcome, which catches a migration that grants less than intended. It does
// not catch a *later* migration that grants more, and that is the direction this programme has failed in
// twice: migration 013 revoked a table grant while leaving an unvalidated definer function that offered the
// same write, and its own assertion required that function to stay callable.
//
// So these read the catalogues rather than the migration text, and they are written as closed sets wherever
// a set is meaningful. A subset check passes against a role that has been granted more than it needs, which
// is the condition being tested for.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

let database;
const query = async (text, values = []) => (await database.admin.query(text, values)).rows;

const PRINCIPALS = ['openppwr_app', 'openppwr_auth', 'openppwr_maintenance', 'openppwr_worker', 'openppwr_rotation'];

before(async () => {
  database = await startTestDatabase('api-privilege-model');
  await migrate(database.adminUrl);
});

after(async () => { await database?.stop(); });

test('every runtime principal is unprivileged at the cluster level', async () => {
  const roles = await query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit, rolreplication
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [PRINCIPALS]);
  assert.equal(roles.length, PRINCIPALS.length, `expected all of ${PRINCIPALS.join(', ')}: found ${roles.map((r) => r.rolname)}`);
  for (const role of roles) {
    assert.equal(role.rolsuper, false, `${role.rolname} is a superuser and bypasses every boundary below`);
    assert.equal(role.rolbypassrls, false, `${role.rolname} bypasses row-level security`);
    assert.equal(role.rolcreaterole, false, `${role.rolname} can create roles, and therefore grant itself anything`);
    assert.equal(role.rolcreatedb, false, `${role.rolname} can create databases`);
    assert.equal(role.rolreplication, false, `${role.rolname} can stream the database it is isolated within`);
    // NOINHERIT alone does not prevent SET ROLE; the membership assertion below is what does.
    assert.equal(role.rolinherit, false, `${role.rolname} inherits privileges of roles it is granted`);
  }
});

// The property that makes the separation real. NOINHERIT stops implicit inheritance; only the absence of
// membership stops `SET ROLE`.
test('the request-serving role is a member of no other role', async () => {
  const memberships = await query(
    `SELECT r.rolname AS member, g.rolname AS granted
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1) ORDER BY 1, 2`, [PRINCIPALS]);
  assert.deepEqual(memberships, [], `a member can SET ROLE regardless of NOINHERIT: ${JSON.stringify(memberships)}`);
});

test('the stored credential verifier is unreadable by every runtime principal', async () => {
  for (const role of PRINCIPALS) {
    const readable = (await query(
      `SELECT has_column_privilege($1, 'identities', 'token_hash', 'SELECT') AS ok`, [role]))[0].ok;
    // Every runtime role reaches credential operations only through constrained definer functions. Direct
    // readability would turn a stored digest back into a reusable proof-of-possession value.
    assert.equal(readable, false, `${role} can read the verifier it may be asked to present`);
    const writable = (await query(
      `SELECT has_column_privilege($1, 'identities', 'token_hash', 'UPDATE') AS ok`, [role]))[0].ok;
    assert.equal(writable, false, `${role} can overwrite a credential verifier`);
  }
});

test('the request-serving role cannot write identities, sessions or demonstration accounts', async () => {
  const forbidden = [
    ['identities', 'INSERT'], ['identities', 'UPDATE'], ['identities', 'DELETE'],
    ['auth_sessions', 'INSERT'], ['auth_sessions', 'UPDATE'], ['auth_sessions', 'DELETE'], ['auth_sessions', 'SELECT'],
    ['demo_users', 'INSERT'], ['demo_users', 'UPDATE'],
    ['deployment_metadata', 'SELECT'], ['deployment_metadata', 'INSERT'],
    ['deployment_metadata', 'UPDATE'], ['deployment_metadata', 'DELETE'],
  ];
  for (const [table, privilege] of forbidden) {
    const held = (await query(`SELECT has_table_privilege('openppwr_app', $1, $2) AS ok`, [table, privilege]))[0].ok;
    assert.equal(held, false, `openppwr_app holds ${privilege} on ${table}`);
  }
});

// Deployment identity must not be forgeable by the process that serves requests, and RLS with no policy is
// how that is enforced rather than merely documented.
test('deployment metadata is reachable only through owner-privileged code', async () => {
  const [table] = await query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'deployment_metadata'`);
  assert.equal(table.relrowsecurity, true, 'deployment_metadata does not enforce row-level security');
  assert.equal(table.relforcerowsecurity, true, 'FORCE is what applies the policy to the table owner too');

  const policies = await query(`SELECT policyname FROM pg_policies WHERE tablename = 'deployment_metadata'`);
  assert.deepEqual(policies, [], 'a policy on this table is a route to writing deployment identity');
});

// Not a grant check: a view or a function returning the verifier would defeat the column-level grant while
// leaving every assertion above true. This is the "what else performs the same read" question, asked of the
// schema instead of of me.
test('no view exposes the credential columns to a runtime principal', async () => {
  const views = await query(
    `SELECT c.relname AS view_name, r.rolname AS grantee
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN pg_roles r
      WHERE c.relkind IN ('v', 'm')
        AND n.nspname = 'public'
        AND r.rolname = ANY($1)
        AND has_table_privilege(r.rolname, c.oid, 'SELECT')
        AND pg_get_viewdef(c.oid) ILIKE '%token_hash%'`, [PRINCIPALS]);
  assert.deepEqual(views, [], `a view hands the verifier to a role the column grant denies: ${JSON.stringify(views)}`);
});

// A grant made to PUBLIC reaches every principal, including ones added later, and is invisible in a
// per-role check.
test('PUBLIC holds no privilege on any credential-bearing object', async () => {
  const exposed = await query(
    `SELECT c.relname, a.privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public'
        AND a.grantee = 0
        AND c.relname IN ('identities', 'auth_sessions', 'demo_users', 'deployment_metadata', 'audit_events')
      ORDER BY 1, 2`);
  assert.deepEqual(exposed, [], `granted to PUBLIC: ${JSON.stringify(exposed)}`);
});

// Default privileges apply to objects that do not exist yet, so a future migration inherits them silently.
test('no default privilege grants a runtime principal anything in advance', async () => {
  const defaults = await query(
    `SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype AS object_type,
            array_to_string(d.defaclacl, ',') AS acl
       FROM pg_default_acl d`);
  const reaching = defaults.filter((row) => PRINCIPALS.some((role) => (row.acl || '').includes(`${role}=`)));
  assert.deepEqual(reaching, [], `a default privilege pre-grants a future object: ${JSON.stringify(reaching)}`);
});

// The reset writes an audit row on its own connection, which needs the sequence as well as the table. This
// was a real omission, found by a 500 rather than by reading, and it is asserted so the next principal that
// needs it fails here instead.
test('the maintenance principal holds the audit grants its transaction requires, and no more', async () => {
  // INSERT is false since migration 020. The reset still records itself on this connection, by the one
  // application-side encoder, in the same transaction as the deletion — but through a function that takes
  // the advisory lock, checks the link against the chain tail, and refuses any action other than
  // `demo.reset`. A direct INSERT let this principal write a plausible event about something that never
  // happened, or break verification for everything after it.
  for (const [table, privilege, expected] of [
    ['audit_events', 'SELECT', true], ['audit_events', 'INSERT', false],
    ['audit_events', 'UPDATE', false], ['audit_events', 'DELETE', false],
    ['identities', 'SELECT', false], ['identities', 'DELETE', false],
    ['auth_sessions', 'INSERT', false],
  ]) {
    const held = (await query(`SELECT has_table_privilege('openppwr_maintenance', $1, $2) AS ok`, [table, privilege]))[0].ok;
    assert.equal(held, expected, `openppwr_maintenance ${expected ? 'needs' : 'must not hold'} ${privilege} on ${table}`);
  }
  // The sequence went with the INSERT: the write happens as the security owner now, so the caller needs
  // neither. A grant left behind after the capability moved is how a boundary erodes quietly.
  const sequence = (await query(
    `SELECT has_sequence_privilege('openppwr_maintenance', 'audit_events_sequence_seq', 'USAGE') AS ok`))[0].ok;
  assert.equal(sequence, false, 'the maintenance principal no longer writes the chain directly');
});

// The authentication principal exists to verify a credential and issue a session. Business data is not its
// job, and a role that accumulates grants stops being a boundary.
test('the authentication principal holds no business-table write', async () => {
  const writes = await query(
    `SELECT c.relname, a.privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'openppwr_auth')
        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      ORDER BY 1, 2`);
  // Empty, since migration 016. An INSERT on `auth_sessions` let this
  // role write the row the issuing function exists to constrain -- so the function's tenant derivation and
  // expiry ceiling bound nothing. It issues sessions solely through the definer function now, which runs
  // with its owner's rights and needs no grant here at all.
  assert.deepEqual(
    writes.map((row) => `${row.relname}:${row.privilege_type}`),
    [],
    'a principal that calls a definer function needs EXECUTE, not the capability the function performs',
  );
});

// Ownership decides whose rights a SECURITY DEFINER function runs with. If a runtime principal owned one,
// every boundary above would be negotiable from inside it.
test('no runtime principal owns a table or a definer function', async () => {
  const owned = await query(
    `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')
        AND pg_get_userbyid(c.relowner) = ANY($1)
      UNION ALL
     SELECT p.proname, pg_get_userbyid(p.proowner)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND pg_get_userbyid(p.proowner) = ANY($1)`, [PRINCIPALS]);
  assert.deepEqual(owned, [], `a runtime principal owns objects it could then redefine: ${JSON.stringify(owned)}`);
});

// --- the privileged function owner -----------------------------------------------------------------
//
// Every SECURITY DEFINER function used to be owned by whichever credential ran the migrations, and in the
// shipped Compose that is a superuser. A superuser is exempt from row-level security, and that exemption was
// the only reason `create_openppwr_tenant` could count `tenants` under its self-only policy or touch
// `deployment_metadata` at all.
//
// Nothing asserted it, and the failure mode was silent: with a non-superuser owner the count returns zero,
// the metadata update matches no row, and the function returns as though it had recorded the deployment.
// A boundary that works by accident of installation is not a boundary.

const SECURITY_OWNER = 'openppwr_security_owner';

test('the privileged function owner is explicit, cannot connect, and is not a superuser', async () => {
  const [owner] = await query(
    `SELECT rolsuper, rolcanlogin, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication
       FROM pg_roles WHERE rolname = $1`, [SECURITY_OWNER]);
  assert.ok(owner, 'the privileged function owner does not exist');
  assert.equal(owner.rolsuper, false, 'a superuser owner is the assumption migration 017 removes');
  assert.equal(owner.rolcanlogin, false, 'this role must lend its rights only through definer functions');
  assert.equal(owner.rolcreaterole, false);
  assert.equal(owner.rolcreatedb, false);
  assert.equal(owner.rolreplication, false);
  assert.equal(owner.rolinherit, false);
  // The one authority its functions genuinely need, named rather than obtained as a side effect of being
  // a superuser: it must see rows through the policies that scope every other principal.
  assert.equal(owner.rolbypassrls, true, 'without this the functions read nothing and fail silently');
});

test('no role can assume the privileged function owner', async () => {
  const members = await query(
    `SELECT member.rolname AS member
       FROM pg_auth_members m
       JOIN pg_roles member ON member.oid = m.member
       JOIN pg_roles granted ON granted.oid = m.roleid
      WHERE granted.rolname = $1`, [SECURITY_OWNER]);
  assert.deepEqual(members, [], `a member can SET ROLE to the owner and inherit BYPASSRLS: ${JSON.stringify(members)}`);
});

// Enumerated from the catalogue, not from a list. A function added by a later migration and left with the
// installer's owner is precisely the defect being closed, and it would not appear in a hand-written list.
test('every SECURITY DEFINER function is owned by the privileged owner', async () => {
  const elsewhere = await query(
    `SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) <> $1
      ORDER BY 1`, [SECURITY_OWNER]);
  assert.deepEqual(elsewhere, [], `these run with the installer's credential: ${JSON.stringify(elsewhere)}`);

  const owned = await query(
    `SELECT count(*)::int AS total FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`);
  assert.ok(owned[0].total > 0, 'no definer functions found; the query is wrong, not the schema');
});

test('deployment identity is owned by the privileged owner and readable by no runtime principal', async () => {
  const [table] = await query(
    `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'deployment_metadata'`);
  assert.equal(table.owner, SECURITY_OWNER);
  for (const role of PRINCIPALS) {
    const readable = (await query(
      `SELECT has_table_privilege($1, 'deployment_metadata', 'SELECT') AS ok`, [role]))[0].ok;
    assert.equal(readable, false, `${role} can read deployment identity directly`);
  }
});

// The silent failure itself, reproduced. Zero rows updated is a successful statement, and the function used
// to return the tenant id as though it had recorded it.
test('a deployment whose metadata row is missing fails the bootstrap rather than succeeding quietly', async () => {
  // One connection, explicitly. Issuing BEGIN and ROLLBACK against a pool can send them to different
  // connections, which would leave the DELETE committed and destroy the deployment metadata for every test
  // that follows. The first version of this did exactly that and passed anyway.
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM deployment_metadata');
    await assert.rejects(
      () => client.query('SELECT create_openppwr_tenant($1,$2,$3,$4)', [
        '00000000-0000-4000-8000-00000000dead', 'probe', 'Probe', 'probe',
      ]),
      /deployment metadata holds 0 rows/u,
      'a missing metadata row must stop the bootstrap, not produce a deployment that records nothing',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  // And the row survived the rollback, so the suite that follows still has a deployment.
  const [remaining] = await query('SELECT count(*)::int AS total FROM deployment_metadata');
  assert.equal(remaining.total, 1, 'the fixture destroyed the deployment metadata it borrowed');
});

// `openppwr_tenant_count()` was granted only to `openppwr_app` (migration 008). Migration 022 split the
// worker into its own principal and granted it every retention transition function, but not this one — the
// worker calls it at startup and on every tenancy recheck, so a real deployment crash-loops the worker
// container from the first `docker compose up`. No integration test caught this because every test exercises
// `assertSingleTenantDeployment` and the retention functions directly against a pool, never through the
// worker's actual startup sequence connecting as `openppwr_worker` after a full migration. Found only by
// running the real installer against a real Debian 13 host (migration 029).
//
// Rather than assert the one function by name, this derives the exact set of SQL functions the worker's own
// source code calls and checks each is actually callable — so a future function added to the worker without
// a matching grant fails here instead of at deployment time.
test('the worker can execute every SQL function its own source code calls', async () => {
  const workerSource = await readFile(
    new URL('../../worker/src/index.mjs', import.meta.url),
    'utf8',
  );
  const names = new Set(
    [...workerSource.matchAll(/\b(?:[a-z][a-z0-9_]*_)?openppwr[a-z0-9_]*(?=\s*\()/g)].map((m) => m[0]),
  );
  assert.ok(names.size > 0, 'no openppwr_* function calls found in worker source — this test would pass vacuously');
  for (const name of names) {
    const matches = await query(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1`,
      [name],
    );
    assert.equal(matches.length, 1, `expected exactly one function named ${name}, found ${matches.length}`);
    const callable = (await query(
      `SELECT has_function_privilege('openppwr_worker', $1, 'EXECUTE') AS ok`, [matches[0].signature],
    ))[0].ok;
    assert.equal(callable, true, `openppwr_worker cannot execute ${matches[0].signature}, which its own source code calls`);
  }
});
