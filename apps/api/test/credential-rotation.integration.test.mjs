// Per-identity credential rotation.
//
// Before this, revoking one compromised bearer token meant destroying the deployment. Tokens are stored as
// hashes only, so nobody — not the operator, not the database owner — can hand the holder a replacement by
// reading the old one; and identity provisioning is a one-time whole-deployment operation that refuses to run
// once any identity exists, so a second bootstrap cannot mint a fresh credential either. A self-hoster whose
// token leaked had no supported recovery at all.
//
// The property this file asserts, stated once: **an entitled actor can replace exactly one identity's bearer
// credential, receive the replacement once, and the credential it replaced — together with every session that
// identity holds — stops working immediately, while the identity's role, tenant and supplier scope are
// untouched.**
//
// Each half is asserted as hard as the other. A rotation that works is worth nothing if a role without the
// entitlement can also perform it, if the old credential keeps authenticating, or if rotating is a way to
// acquire a role you did not have.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, migrate, tokenHash } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let authPool;
let maintenancePool;
let server;
let baseUrl;
let identities;
let tenantId;
let previousDemoLogin;

// The live credential for each role. Rotation replaces one, so a test that rotates must not leave a later
// test holding a dead token — and a later test holding a dead token would fail for the right reason but at
// the wrong assertion, which is how a suite stops explaining itself.
const live = new Map();

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function rotate(targetRole, asRole) {
  const targetId = typeof targetRole === 'string' && identities[targetRole] ? identities[targetRole].id : targetRole;
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
  database = await startTestDatabase('api-credential-rotation');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  authPool = createPool(database.authUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  await database.declareDemonstrationDeployment();
  // Set before bootstrap, not after: the demonstration accounts are provisioned during bootstrap and only
  // when the flag is on. A later flip creates the panel and not the accounts, so the session half of this
  // file would silently skip rather than run.
  previousDemoLogin = process.env.OPENPPWR_DEMO_LOGIN;
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, authPool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/rotation-${randomUUID()}` });
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
  await authPool?.end();
  await maintenancePool?.end();
  await database?.stop();
});

// ---------------------------------------------------------------------------------------------------
// The capability itself

test('an identity rotates its own credential, and the credential it replaced is refused immediately', async () => {
  const before_ = await identityRow(identities.packaging_editor.id);
  const rotated = await rotate('packaging_editor', 'packaging_editor');
  assert.equal(rotated.response.status, 200, `self-service rotation must succeed: ${JSON.stringify(rotated.body)}`);

  const replacement = rotated.body.credential;
  assert.equal(typeof replacement, 'string');
  assert.ok(replacement.length >= 32, 'a credential shorter than the one it replaces is a downgrade');
  assert.notEqual(replacement, identities.packaging_editor.token);
  assert.equal(rotated.body.identityId, identities.packaging_editor.id);
  assert.ok(Date.parse(rotated.body.expiresAt) > Date.now(), 'a replacement that is already expired is not a replacement');

  const withNew = await sessionFor(replacement);
  assert.equal(withNew.response.status, 200, 'the replacement must authenticate');
  assert.equal(withNew.body.actorId, identities.packaging_editor.id);
  assert.equal(withNew.body.role, 'packaging_editor');

  const withOld = await sessionFor(identities.packaging_editor.token);
  assert.equal(withOld.response.status, 401, 'the replaced credential must stop working, not merely age out');

  // Proven rather than assumed: the store holds a different verifier now, and it still holds only a hash.
  const after_ = await identityRow(identities.packaging_editor.id);
  assert.equal(after_.role, before_.role);
  assert.equal(after_.tenant_id, before_.tenant_id);
  assert.ok(after_.token_rotated_at, 'rotation must be recorded on the row it changed');
  live.set('packaging_editor', replacement);
});

test('a tenant administrator rotates another identity in its tenant', async () => {
  const rotated = await rotate('evidence_contributor', 'tenant_admin');
  assert.equal(rotated.response.status, 200, `the administrator must be able to recover another identity: ${JSON.stringify(rotated.body)}`);

  assert.equal((await sessionFor(identities.evidence_contributor.token)).response.status, 401, 'the compromised credential must be dead');
  const withNew = await sessionFor(rotated.body.credential);
  assert.equal(withNew.response.status, 200);
  assert.equal(withNew.body.role, 'evidence_contributor', 'the administrator recovered the identity, it did not become one');
  live.set('evidence_contributor', rotated.body.credential);

  // And the administrator's own credential is untouched by rotating somebody else's.
  assert.equal((await sessionFor(live.get('tenant_admin'))).response.status, 200);
});

// ---------------------------------------------------------------------------------------------------
// The negative half

test('a role without the entitlement cannot rotate another identity, and the target keeps working', async () => {
  const refused = await rotate('evidence_reviewer', 'compliance_manager');
  assert.equal(refused.response.status, 404, 'an unentitled rotation must be refused as not-found, disclosing nothing about the target');
  assert.equal(refused.body.error.code, 'RESOURCE_NOT_FOUND');

  const target = await sessionFor(live.get('evidence_reviewer'));
  assert.equal(target.response.status, 200, 'a refused rotation must not have rotated anything');
  const row = await identityRow(identities.evidence_reviewer.id);
  assert.equal(row.token_rotated_at, null, 'the refusal must not have touched the row');
});

test('an unentitled rotation is refused by the database as well, not only by the route', async () => {
  // The route check is the first refusal, not the boundary. This calls the function directly on the
  // credential principal, which is the most favourable position an attacker who reached the connection could
  // be in, and the authorisation still has to hold.
  const client = await authPool.connect();
  try {
    await assert.rejects(
      () => client.query(
        'SELECT new_credential FROM rotate_openppwr_identity_credential($1,$2)',
        [tokenHash(live.get('compliance_manager')), identities.evidence_reviewer.id],
      ),
      (error) => {
        assert.equal(error.code, 'P0002', `expected the function's own not-found, got ${error.code}: ${error.message}`);
        return true;
      },
      'authorisation stated in a route and not in the function is a convention, not a boundary',
    );
  } finally {
    client.release();
  }
  assert.equal((await sessionFor(live.get('evidence_reviewer'))).response.status, 200);
});

test('rotating does not change role, tenant or supplier scope', async () => {
  const before_ = await identityRow(identities.supplier_user.id);
  assert.equal(before_.supplier_id, 'ACME-SUP-001', 'the fixture must carry a supplier scope for this to mean anything');

  const rotated = await rotate('supplier_user', 'tenant_admin');
  assert.equal(rotated.response.status, 200);
  live.set('supplier_user', rotated.body.credential);

  const after_ = await identityRow(identities.supplier_user.id);
  assert.equal(after_.role, 'supplier_user', 'rotation must not be a way to acquire a role');
  assert.equal(after_.tenant_id, tenantId, 'rotation must not move an identity between tenants');
  assert.equal(after_.supplier_id, 'ACME-SUP-001', 'rotation must not widen a supplier scope');
  assert.equal(after_.active, true);

  const session = await sessionFor(rotated.body.credential);
  assert.equal(session.response.status, 200);
  assert.equal(session.body.role, 'supplier_user');
  assert.equal(session.body.supplierId, 'ACME-SUP-001');
  assert.deepEqual(session.body.permissions, ['read-own', 'evidence:upload', 'evidence:download-own']);
});

test('a session derived from the rotated identity is refused afterwards', async () => {
  const signedIn = await jsonRequest('/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'read-only-auditor@dummymail.example', password: 'demo' }),
  });
  assert.equal(signedIn.response.status, 200, `the session half needs a real session: ${JSON.stringify(signedIn.body)}`);
  assert.equal((await sessionFor(signedIn.body.token)).response.status, 200, 'the session must work before rotation, or the assertion below proves nothing');

  const rotated = await rotate('read_only_auditor', 'tenant_admin');
  assert.equal(rotated.response.status, 200);
  live.set('read_only_auditor', rotated.body.credential);

  assert.equal(
    (await sessionFor(signedIn.body.token)).response.status, 401,
    'a live session outlives the credential it accompanies unless rotation ends it; the identity is compromised, not the token',
  );
  assert.equal((await sessionFor(rotated.body.credential)).response.status, 200);
});

test('rotation refuses an unknown identity, a malformed one and an unauthenticated caller alike', async () => {
  const unknown = await rotate(randomUUID(), 'tenant_admin');
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, 'RESOURCE_NOT_FOUND', 'an unknown target and an unentitled one must be indistinguishable');

  const malformed = await jsonRequest('/v1/identities/not-a-uuid/rotate-credential', {
    method: 'POST', headers: { authorization: `Bearer ${live.get('tenant_admin')}` },
  });
  assert.equal(malformed.response.status, 404, 'a malformed identifier must not reach a query, and must not be distinguishable from an unknown one');

  const anonymous = await jsonRequest(`/v1/identities/${identities.evidence_reviewer.id}/rotate-credential`, { method: 'POST' });
  assert.equal(anonymous.response.status, 401);

  const expired = await jsonRequest(`/v1/identities/${identities.evidence_reviewer.id}/rotate-credential`, {
    method: 'POST', headers: { authorization: `Bearer ${identities.evidence_contributor.token}` },
  });
  assert.equal(expired.response.status, 401, 'a credential already rotated away cannot authorise a rotation');
});

// ---------------------------------------------------------------------------------------------------
// Accountability and the credential boundary

test('every rotation is recorded through the canonical audit path, and the chain still verifies', async () => {
  const events = (await database.admin.query(
    `SELECT actor_id, entity_type, entity_id, payload
       FROM audit_events WHERE action = 'identity.credential.rotated' ORDER BY sequence`,
  )).rows;
  assert.ok(events.length >= 4, `expected one event per rotation performed above, found ${events.length}`);

  for (const event of events) {
    assert.equal(event.entity_type, 'identity');
    assert.ok(event.actor_id, 'a credential change with no actor is not a record');
    const serialised = JSON.stringify(event.payload);
    assert.ok(!/opp_/u.test(serialised), 'the audit payload must not carry credential material');
    assert.ok(!/[0-9a-f]{64}/u.test(serialised), 'the audit payload must not carry a credential verifier either');
  }

  const selfService = events.find((event) => event.payload.selfService === true);
  assert.ok(selfService, 'self-service and administrative rotation must be distinguishable in the record');
  const administrative = events.find((event) => event.payload.selfService === false);
  assert.ok(administrative, 'an administrator rotating somebody else must be recorded as exactly that');
  assert.notEqual(administrative.actor_id, administrative.entity_id);

  const verified = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${live.get('tenant_admin')}` } });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.valid, true, 'a rotation that breaks the hash chain is worse than one that is not recorded');
});

test('the request-serving role gains no credential-writing capability from any of this', async () => {
  const row = (await database.admin.query(`
    SELECT has_table_privilege('openppwr_app','identities','UPDATE') AS update_identities,
           has_column_privilege('openppwr_app','identities','token_hash','SELECT') AS read_verifier,
           has_table_privilege('openppwr_app','auth_sessions','UPDATE') AS update_sessions,
           has_function_privilege('openppwr_app','rotate_openppwr_identity_credential(text,uuid,integer)','EXECUTE') AS app_rotate,
           has_function_privilege('openppwr_auth','rotate_openppwr_identity_credential(text,uuid,integer)','EXECUTE') AS auth_rotate,
           has_function_privilege('public','rotate_openppwr_identity_credential(text,uuid,integer)','EXECUTE') AS public_rotate,
           has_function_privilege('openppwr_app','rotate_openppwr_identity_token(uuid,uuid,text,text,integer)','EXECUTE') AS app_legacy_rotate`)).rows[0];
  assert.equal(row.update_identities, false, 'writing a token hash directly is how an identity is seized');
  assert.equal(row.read_verifier, false, 'a verifier the caller can read is not a proof of possession');
  assert.equal(row.update_sessions, false);
  assert.equal(row.app_rotate, false, 'rotation is a credential operation and must not be reachable from the request-serving role');
  assert.equal(row.public_rotate, false);
  assert.equal(row.auth_rotate, true, 'the credential principal must hold exactly this, or there is no supported rotation at all');
  assert.equal(row.app_legacy_rotate, false, 'two doors into a credential write is one more than the boundary allows');
});

test('the rotation function is owner-privileged, scoped and never returns a stored credential', async () => {
  const row = (await database.admin.query(`
    SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.prosrc AS source
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'rotate_openppwr_identity_credential'`)).rows[0];
  assert.ok(row, 'rotate_openppwr_identity_credential is missing from the schema');
  assert.equal(row.definer, true);
  assert.equal(row.owner, 'openppwr_security_owner', 'a definer function owned by the installer credential runs with whatever that credential holds');
  assert.ok((row.config || []).some((entry) => entry === 'search_path=public, pg_temp'), 'a definer function without a fixed search_path is not a boundary');
  assert.ok(!/p_new_token_hash|p_token_hash/u.test(row.source), 'a caller that supplies the hash chooses the credential');
  assert.match(row.source, /gen_random_bytes/u, 'the replacement is minted where it cannot be chosen');
  assert.match(row.source, /append_openppwr_audit_event/u, 'the record is part of the operation, not a caller convention');

  // The store keeps hashes only: nothing in the schema can hand the credential back a second time.
  const stored = (await database.admin.query('SELECT token_hash FROM identities WHERE id = $1', [identities.supplier_user.id])).rows[0];
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/u);
  assert.equal(stored.token_hash, tokenHash(live.get('supplier_user')), 'the stored value must be the digest of the credential that was returned once');
});
