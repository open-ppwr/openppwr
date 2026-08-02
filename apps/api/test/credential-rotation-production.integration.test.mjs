// Credential rotation in the only posture that holds real data: demonstration sign-in OFF.
//
// `credential-rotation.integration.test.mjs` proves the rotation route works. It also sets
// `OPENPPWR_DEMO_LOGIN=true` in its own `before`, and that single line is why it could not see the defect this
// file exists for: rotation ran on `authPool`, `authPool` is built from `OPENPPWR_AUTH_DATABASE_URL`, and
// `apps/api/src/server.mjs` makes that variable a fatal startup error whenever demonstration sign-in is off.
// So the recovery story migration 034 was written for — "for a self-hoster whose credential leaks it is not a
// recovery story, it is the absence of one" — did not exist in a production deployment. The route answered
// 404 there and 200 only in the demonstration.
//
// A suite that enables the demonstration in order to test a production capability is not testing the
// deployment anybody runs. This file never sets the flag, never declares the deployment a demonstration, and
// asserts the property directly:
//
//   **with demonstration sign-in off, an entitled actor can replace an identity's bearer credential, the
//   replaced credential stops working immediately, and the request-serving role gains nothing by it.**
//
// The credential connection here is `openppwr_rotation` (migration 035): a principal that holds EXECUTE on
// the rotation function and nothing else — no session issuance, no demonstration-user lookup, no table
// grants. `openppwr_auth` stays out of production exactly as before.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, migrate, tokenHash } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let rotationPool;
let server;
let baseUrl;
let identities;
let tenantId;
let previousDemoLogin;

// The live credential per role, because rotation replaces one and a later test holding a dead token would
// fail for the right reason at the wrong assertion.
const live = new Map();

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function rotate(target, asRole) {
  const targetId = typeof target === 'string' && identities[target] ? identities[target].id : target;
  return jsonRequest(`/v1/identities/${targetId}/rotate-credential`, {
    method: 'POST',
    headers: { authorization: `Bearer ${live.get(asRole)}` },
  });
}

const sessionFor = (token) => jsonRequest('/v1/session', { headers: { authorization: `Bearer ${token}` } });

const identityRow = async (id) => (await database.admin.query(
  'SELECT tenant_id, role, supplier_id, active, token_expires_at, token_rotated_at FROM identities WHERE id = $1',
  [id],
)).rows[0];

before(async () => {
  database = await startTestDatabase('api-credential-rotation-production');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // Deliberately tolerant of its own absence rather than throwing in `before`. Against a tree without
  // migration 035 the harness has no such credential, and the failure this file is meant to report is the
  // route answering 404 in the production posture — not a setup error that says nothing about the product.
  rotationPool = database.rotationUrl ? createPool(database.rotationUrl) : null;
  // Off, explicitly and for the whole file. Not "left unset": a developer with the variable exported would
  // otherwise run this file in the demonstration posture and it would prove nothing.
  previousDemoLogin = process.env.OPENPPWR_DEMO_LOGIN;
  delete process.env.OPENPPWR_DEMO_LOGIN;
  // `declareDemonstrationDeployment()` is deliberately NOT called. `deployment_metadata.deployment_mode`
  // stays at its 'production' default, which is what an installer leaves behind when the operator did not
  // choose the demonstration profile.
  const bootstrapSecret = randomUUID();
  // No `authPool` and no `maintenancePool`, because a production API process is not given either — that is
  // the startup refusal in server.mjs, reproduced here as the shape of the process under test.
  const app = createApp({ pool, rotationPool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/rotation-production-${randomUUID()}` });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201, 'bootstrap must succeed; every credential below comes from it');
  identities = created.body.identities;
  tenantId = created.body.tenantId;
  for (const [role, identity] of Object.entries(identities)) live.set(role, identity.token);
});

after(async () => {
  if (previousDemoLogin === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
  else process.env.OPENPPWR_DEMO_LOGIN = previousDemoLogin;
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await rotationPool?.end();
  await database?.stop();
});

// ---------------------------------------------------------------------------------------------------
// The posture itself, asserted before anything is concluded from it

test('this deployment is the production one: demonstration sign-in is off and its routes do not exist', async () => {
  assert.equal(process.env.OPENPPWR_DEMO_LOGIN, undefined, 'the flag must be off, or every assertion below is about the demonstration');

  const accounts = await jsonRequest('/v1/demo/accounts');
  assert.equal(accounts.response.status, 404, 'the demonstration credentials panel must not exist here');

  const login = await jsonRequest('/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@dummymail.example', password: 'demo' }),
  });
  assert.equal(login.response.status, 404, 'password sign-in must not exist here');

  const [metadata] = (await database.admin.query('SELECT deployment_mode FROM deployment_metadata')).rows;
  assert.equal(metadata.deployment_mode, 'production', 'the deployment must not have been declared a demonstration');
});

// ---------------------------------------------------------------------------------------------------
// The capability, in that posture

test('an administrator rotates a leaked credential with demonstration sign-in off', async () => {
  const before_ = await identityRow(identities.evidence_contributor.id);
  assert.equal(before_.token_rotated_at, null, 'the fixture must start unrotated for the assertion below to mean anything');

  const rotated = await rotate('evidence_contributor', 'tenant_admin');
  assert.equal(
    rotated.response.status, 200,
    `a production deployment must be able to replace a leaked credential; got ${rotated.response.status} ${JSON.stringify(rotated.body)}`,
  );

  const replacement = rotated.body.credential;
  assert.equal(typeof replacement, 'string');
  assert.notEqual(replacement, identities.evidence_contributor.token);
  assert.equal(rotated.body.identityId, identities.evidence_contributor.id);
  assert.ok(Date.parse(rotated.body.expiresAt) > Date.now(), 'a replacement that is already expired is not a replacement');

  const withNew = await sessionFor(replacement);
  assert.equal(withNew.response.status, 200, 'the replacement must authenticate');
  assert.equal(withNew.body.role, 'evidence_contributor', 'the administrator recovered the identity, it did not become one');
  live.set('evidence_contributor', replacement);

  const withOld = await sessionFor(identities.evidence_contributor.token);
  assert.equal(withOld.response.status, 401, 'the leaked credential must stop working, which is the entire point of rotating it');

  const after_ = await identityRow(identities.evidence_contributor.id);
  assert.equal(after_.role, before_.role, 'rotation must not be a way to acquire a role');
  assert.equal(after_.tenant_id, tenantId, 'rotation must not move an identity between tenants');
  assert.equal(after_.supplier_id, before_.supplier_id, 'rotation must not widen a supplier scope');
  assert.ok(after_.token_rotated_at, 'rotation must be recorded on the row it changed');
});

test('an identity replaces its own credential with demonstration sign-in off', async () => {
  const rotated = await rotate('packaging_editor', 'packaging_editor');
  assert.equal(rotated.response.status, 200, `self-service rotation must work in production: ${JSON.stringify(rotated.body)}`);
  live.set('packaging_editor', rotated.body.credential);

  assert.equal((await sessionFor(rotated.body.credential)).response.status, 200);
  assert.equal(
    (await sessionFor(identities.packaging_editor.token)).response.status, 401,
    'the credential it replaced must be dead immediately, not merely aged out',
  );

  const stored = (await database.admin.query('SELECT token_hash FROM identities WHERE id = $1', [identities.packaging_editor.id])).rows[0];
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/u, 'the store must keep a digest and never the credential');
  assert.equal(stored.token_hash, tokenHash(rotated.body.credential), 'the stored digest must be of the credential returned once');
});

test('rotation stays scoped in production: an unentitled caller is refused and changes nothing', async () => {
  const refused = await rotate('evidence_reviewer', 'compliance_manager');
  assert.equal(refused.response.status, 404, 'an unentitled rotation must be refused as not-found, disclosing nothing about the target');
  assert.equal(refused.body.error.code, 'RESOURCE_NOT_FOUND');
  assert.equal((await sessionFor(live.get('evidence_reviewer'))).response.status, 200, 'a refused rotation must not have rotated anything');
  assert.equal((await identityRow(identities.evidence_reviewer.id)).token_rotated_at, null, 'the refusal must not have touched the row');

  const unknown = await rotate(randomUUID(), 'tenant_admin');
  assert.equal(unknown.response.status, 404, 'an unknown target and an unentitled one must be indistinguishable');

  const anonymous = await jsonRequest(`/v1/identities/${identities.evidence_reviewer.id}/rotate-credential`, { method: 'POST' });
  assert.equal(anonymous.response.status, 401);
});

test('rotation stays audited in production, and the chain still verifies', async () => {
  const events = (await database.admin.query(
    `SELECT actor_id, entity_type, entity_id, payload
       FROM audit_events WHERE action = 'identity.credential.rotated' ORDER BY sequence`)).rows;
  assert.ok(events.length >= 2, `expected one event per rotation performed above, found ${events.length}`);
  for (const event of events) {
    assert.equal(event.entity_type, 'identity');
    assert.ok(event.actor_id, 'a credential change with no actor is not a record');
    const serialised = JSON.stringify(event.payload);
    assert.ok(!/opp_/u.test(serialised), 'the audit payload must not carry credential material');
    assert.ok(!/[0-9a-f]{64}/u.test(serialised), 'the audit payload must not carry a credential verifier either');
  }
  assert.ok(events.some((event) => event.payload.selfService === true), 'self-service rotation must be distinguishable in the record');
  assert.ok(events.some((event) => event.payload.selfService === false), 'an administrator rotating somebody else must be recorded as exactly that');

  const verified = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${live.get('tenant_admin')}` } });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.valid, true, 'a rotation that breaks the hash chain is worse than one that is not recorded');
});

// ---------------------------------------------------------------------------------------------------
// The boundary the capability must not cost anything

// Migration 034 asked this question with `has_table_privilege('openppwr_app','identities','UPDATE')` under
// the message "the request-serving role may write a credential directly". That function does not see
// column-level grants: with `GRANT UPDATE (token_hash) ON identities TO openppwr_app` it returns false, the
// migration installs cleanly, and `openppwr_app` can then run `UPDATE identities SET token_hash = …`. The
// assertion proved less than its message claimed. Asked here the way migration 035 now asks it — per column,
// and then by execution, which is the only answer that cannot be read wrong.
test('the request-serving role cannot write a credential by any path', async () => {
  const columns = (await database.admin.query(
    `SELECT column_name, privilege_type
       FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name IN ('identities', 'auth_sessions')
        AND grantee = 'openppwr_app' AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY 1, 2`)).rows;
  assert.deepEqual(columns, [], `a column-level write grant is invisible to has_table_privilege: ${JSON.stringify(columns)}`);

  const [held] = (await database.admin.query(`
    SELECT has_table_privilege('openppwr_app','identities','UPDATE') AS table_update,
           has_column_privilege('openppwr_app','identities','token_hash','UPDATE') AS column_update,
           has_column_privilege('openppwr_app','identities','token_expires_at','UPDATE') AS expiry_update,
           has_column_privilege('openppwr_app','identities','token_hash','SELECT') AS read_verifier,
           has_function_privilege('openppwr_app','rotate_openppwr_identity_credential(text,uuid,integer)','EXECUTE') AS app_rotate,
           has_function_privilege('openppwr_app','rotate_openppwr_identity_token(uuid,uuid,text,text,integer)','EXECUTE') AS app_legacy_rotate,
           has_function_privilege('public','rotate_openppwr_identity_credential(text,uuid,integer)','EXECUTE') AS public_rotate`)).rows;
  for (const [property, value] of Object.entries(held)) assert.equal(value, false, `openppwr_app holds ${property}`);

  // By execution, on the connection that actually serves requests. A grant matrix read from the catalogue is
  // an argument; a refused statement is the fact.
  const client = await pool.connect();
  try {
    await assert.rejects(
      () => client.query(`UPDATE identities SET token_hash = repeat('a', 64) WHERE id = $1`, [identities.evidence_reviewer.id]),
      (error) => { assert.equal(error.code, '42501', `expected permission denied, got ${error.code}: ${error.message}`); return true; },
      'the request-serving role must not be able to overwrite a credential verifier',
    );
    await assert.rejects(
      () => client.query('SELECT new_credential FROM rotate_openppwr_identity_credential($1,$2)',
        [tokenHash(live.get('tenant_admin')), identities.evidence_reviewer.id]),
      (error) => { assert.equal(error.code, '42501', `expected permission denied, got ${error.code}: ${error.message}`); return true; },
      'rotation is a credential write and must not be reachable from the request-serving connection',
    );
  } finally {
    client.release();
  }
  assert.equal((await sessionFor(live.get('evidence_reviewer'))).response.status, 200, 'neither attempt may have succeeded');
});

// The defect in migration 034's assertion, reproduced rather than argued.
//
// `has_table_privilege('openppwr_app','identities','UPDATE')` is false while a column-level UPDATE grant on
// `identities.token_hash` exists, so 034 installed cleanly and reported "the request-serving role may write a
// credential directly" as not-happening — while the role could write exactly that. Migration 014 had already
// replaced the table-level SELECT on this table with a column list, so column grants here are ordinary, not
// exotic. This grants it in a transaction, asks both questions, and rolls back.
test('a column-level write grant is invisible to the table-level check migration 034 used', async () => {
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('GRANT UPDATE (token_hash) ON identities TO openppwr_app');

    const [answers] = (await client.query(`
      SELECT has_table_privilege('openppwr_app','identities','UPDATE') AS table_level,
             has_column_privilege('openppwr_app','identities','token_hash','UPDATE') AS column_level,
             EXISTS (SELECT 1 FROM information_schema.column_privileges
                      WHERE table_schema='public' AND table_name='identities'
                        AND column_name='token_hash' AND grantee='openppwr_app'
                        AND privilege_type='UPDATE') AS catalogue`)).rows;
    assert.equal(
      answers.table_level, false,
      'this is the defect: the check migration 034 made returns false while the capability it names is held',
    );
    assert.equal(answers.column_level, true, 'the check migration 035 makes sees it');
    assert.equal(answers.catalogue, true, 'and so does the catalogue view, which is the other supported way to ask');

    // And the capability is real, not a catalogue artefact: the request-serving role can now perform the
    // write the assertion said it could not. Same transaction, so it is rolled back with the grant.
    const [reachable] = (await client.query(`
      SELECT has_column_privilege('openppwr_app','identities','token_hash','UPDATE') AS may_seize`)).rows;
    assert.equal(reachable.may_seize, true, 'GRANT UPDATE (token_hash) is a credential write by any other name');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  // The grant is gone and the boundary is where it was, so the rest of the suite still means something.
  const [restored] = (await database.admin.query(
    `SELECT has_column_privilege('openppwr_app','identities','token_hash','UPDATE') AS ok`)).rows;
  assert.equal(restored.ok, false, 'the fixture leaked the grant it borrowed');
});

// The whole justification for reaching rotation from a production API process is that the principal doing it
// holds rotation and nothing else. If it accumulated the session primitive, this would be `openppwr_auth`
// under another name and migration 014's reasoning would be back where it started.
test('the rotation principal holds rotation and nothing else', async () => {
  if (!rotationPool) assert.fail('there is no rotation principal; migration 035 has not run');

  const [role] = (await database.admin.query(
    `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit
       FROM pg_roles WHERE rolname = 'openppwr_rotation'`)).rows;
  assert.ok(role, 'openppwr_rotation does not exist');
  for (const [attribute, value] of Object.entries(role)) assert.equal(value, false, `openppwr_rotation ${attribute}`);

  const memberships = (await database.admin.query(
    `SELECT g.rolname AS granted, m.rolname AS member
       FROM pg_auth_members a
       JOIN pg_roles g ON g.oid = a.roleid
       JOIN pg_roles m ON m.oid = a.member
      WHERE g.rolname = 'openppwr_rotation' OR m.rolname = 'openppwr_rotation'`)).rows;
  assert.deepEqual(memberships, [], `membership is what SET ROLE follows, whatever NOINHERIT says: ${JSON.stringify(memberships)}`);

  const tables = (await database.admin.query(
    `SELECT table_name, privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND grantee = 'openppwr_rotation' ORDER BY 1, 2`)).rows;
  assert.deepEqual(tables, [], `the rotation principal reaches every table through the function or not at all: ${JSON.stringify(tables)}`);

  const columns = (await database.admin.query(
    `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND grantee = 'openppwr_rotation' ORDER BY 1, 2, 3`)).rows;
  assert.deepEqual(columns, [], `a column grant is a table grant nobody looks for: ${JSON.stringify(columns)}`);

  const functions = (await database.admin.query(
    `SELECT p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND coalesce(array_to_string(p.proacl, ','), '') LIKE '%openppwr_rotation=X%'
      ORDER BY 1`)).rows.map((row) => row.name);
  assert.deepEqual(
    functions, ['rotate_openppwr_identity_credential'],
    'the rotation principal must hold exactly one EXECUTE; anything else makes it openppwr_auth under another name',
  );

  // Stated positively as well, because the two capabilities that put openppwr_auth out of production are the
  // ones a reader will look for by name.
  const [reachable] = (await database.admin.query(`
    SELECT has_function_privilege('openppwr_rotation','authenticate_openppwr_demo_login(text,text,integer)','EXECUTE') AS demo_login,
           has_function_privilege('openppwr_rotation','openppwr_demo_login_salt(text)','EXECUTE') AS demo_salt,
           has_function_privilege('openppwr_rotation','append_openppwr_audit_event(text,text,text,text,jsonb)','EXECUTE') AS audit_append,
           has_function_privilege('openppwr_rotation','rotate_openppwr_identity_token(uuid,uuid,text,text,integer)','EXECUTE') AS legacy_rotate,
           has_table_privilege('openppwr_rotation','auth_sessions','INSERT') AS mint_session,
           has_table_privilege('openppwr_rotation','identities','UPDATE') AS write_identity,
           has_table_privilege('openppwr_rotation','demo_users','SELECT') AS read_password_verifier`)).rows;
  for (const [property, value] of Object.entries(reachable)) assert.equal(value, false, `openppwr_rotation holds ${property}`);
});

// The function is the boundary; the route is the fast refusal. Asked from the most favourable position an
// attacker who reached the credential connection could occupy.
test('an unentitled rotation is refused by the database as well, not only by the route', async () => {
  if (!rotationPool) assert.fail('there is no rotation principal; migration 035 has not run');
  const client = await rotationPool.connect();
  try {
    await assert.rejects(
      () => client.query('SELECT new_credential FROM rotate_openppwr_identity_credential($1,$2)',
        [tokenHash(live.get('compliance_manager')), identities.evidence_reviewer.id]),
      (error) => { assert.equal(error.code, 'P0002', `expected the function's own not-found, got ${error.code}: ${error.message}`); return true; },
      'authorisation stated in a route and not in the function is a convention, not a boundary',
    );
    // And a caller that presents no valid credential at all gets nothing, however the connection was reached.
    await assert.rejects(
      () => client.query('SELECT new_credential FROM rotate_openppwr_identity_credential($1,$2)',
        [tokenHash('opp_not_a_credential'), identities.evidence_reviewer.id]),
      (error) => { assert.equal(error.code, '42501', `expected insufficient privilege, got ${error.code}: ${error.message}`); return true; },
      'EXECUTE on this function is not authority; the credential presented is',
    );
  } finally {
    client.release();
  }
  assert.equal((await sessionFor(live.get('evidence_reviewer'))).response.status, 200);
});
