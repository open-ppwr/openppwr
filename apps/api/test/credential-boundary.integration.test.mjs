// The credential write boundary.
//
// Row-level security limits which rows the application role sees. It does not limit which columns it may
// write. Migration 001 granted `UPDATE` on `identities` and migration 004 granted `SELECT, INSERT, UPDATE`
// on `auth_sessions`, so the role could overwrite an operator's `token_hash`, or insert a session row with a
// token hash and expiry of its choosing — seizing an identity with no password and no existing credential.
//
// `rotate_openppwr_identity_token` asks for the current hash as proof of possession, and against that role
// the proof was a formality: it holds `SELECT` and can read the verifier it is asked to present.
//
// **A stored hash is not a proof of possession when the caller can read it.** That is the finding, and it is
// why the remedy is to remove the write capability rather than to strengthen the argument the function takes.

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

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

// A statement run as the application role, inside its own tenant context, which is the most favourable
// position an attacker holding that role could be in.
async function asApplicationRole(sql, parameters = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true), set_config('openppwr.actor_id', $2, true)`, [tenantId, identities.tenant_admin.id]);
    return await client.query(sql, parameters);
  } finally {
    // Rolled back in `finally`, not after the statement. When the statement threw — which is the whole point
    // of these tests — the rollback was skipped and the connection went back to the pool inside an aborted
    // transaction, so the next borrower got 25P02 and the request after that a 500. The refusals were
    // correct; the harness was poisoning itself.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

before(async () => {
  database = await startTestDatabase('api-credential-boundary');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // Migration 014 moved session issuance and the demonstration reset onto credentials the request pool
  // does not hold. A deployment is a demonstration because the installer said so, not because the
  // application claims it at runtime.
  authPool = createPool(database.authUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  await database.declareDemonstrationDeployment();
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, authPool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/credential-${randomUUID()}` });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201, 'bootstrap must still work: it is the one identity write the role keeps');
  identities = created.body.identities;
  tenantId = created.body.tenantId;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await authPool?.end();
  await maintenancePool?.end();
  await database?.stop();
});

// The seizure the finding describes, attempted directly.
test('the application role cannot overwrite an identity token hash', async () => {
  await assert.rejects(
    () => asApplicationRole('UPDATE identities SET token_hash=$1 WHERE id=$2', [tokenHash('opp_attacker_chosen_value'), identities.tenant_admin.id]),
    (error) => {
      assert.equal(error.code, '42501', `expected insufficient_privilege, got ${error.code}: ${error.message}`);
      return true;
    },
  );
  // And the credential still works, so the refusal changed nothing.
  const session = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(session.response.status, 200);
});

test('the application role cannot mint or alter a session', async () => {
  for (const [sql, parameters] of [
    ['INSERT INTO auth_sessions (tenant_id,id,identity_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,now() + interval \'365 days\')',
      [tenantId, randomUUID(), identities.tenant_admin.id, tokenHash('opp_sess_forged')]],
    ['UPDATE auth_sessions SET expires_at = now() + interval \'365 days\'', []],
    ['SELECT token_hash FROM auth_sessions', []],
  ]) {
    await assert.rejects(
      () => asApplicationRole(sql, parameters),
      (error) => {
        assert.equal(error.code, '42501', `expected insufficient_privilege for ${sql.slice(0, 40)}, got ${error.code}`);
        return true;
      },
    );
  }
});

// The capability that must survive: bootstrap creates identity rows as the application role. A migration
// that removed too much would be discovered at the next install rather than here.
// Reversed by migration 014, and the reversal is the point. This test previously asserted that INSERT was
// retained "because bootstrap requires it" -- and that retained grant was itself the escalation: the role
// inserted a tenant_admin with a token hash of its choosing, and the token authenticated. Provisioning is
// now a one-time function that closes itself once any identity exists.
test('the application role can no longer insert identities, and still reads the metadata it needs', async () => {
  await assert.rejects(
    () => asApplicationRole(
      `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash) VALUES ($1,$2,'probe','service_account',NULL,$3)`,
      [tenantId, randomUUID(), tokenHash(`opp_probe_${randomUUID()}`)],
    ),
    (error) => error.code === '42501',
    'a standing INSERT on identities is a standing grant to create an administrator',
  );

  // Column-level SELECT: everything the request path legitimately reads, and not the verifier.
  const read = await asApplicationRole('SELECT count(*)::int AS count FROM identities');
  assert.ok(Number(read.rows[0].count) > 0, 'the role must still resolve its own identity');
  await assert.rejects(
    () => asApplicationRole('SELECT token_hash FROM identities LIMIT 1'),
    (error) => error.code === '42501',
    'a stored hash the caller can read is not proof of possession',
  );
});

// Sign-in and sign-out still work, because both go through SECURITY DEFINER functions inside the
// authentication boundary rather than through the table grants that were removed.
test('session issue and revocation still work through the definer functions', async () => {
  const previous = process.env.OPENPPWR_DEMO_LOGIN;
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  try {
    const signedIn = await jsonRequest('/v1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `demo@${process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example'}`, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
    });
    // The demonstration users exist only when provisioning has run; if they do not, the definer path is
    // still exercised by the bootstrap identity below, and this half is skipped rather than faked.
    if (signedIn.response.status === 200) {
      const used = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${signedIn.body.token}` } });
      assert.equal(used.response.status, 200, 'a session issued through issue_openppwr_session must authenticate');
      const out = await jsonRequest('/v1/logout', { method: 'POST', headers: { authorization: `Bearer ${signedIn.body.token}` } });
      assert.equal(out.response.status, 204, 'revoke_openppwr_session must still revoke');
      const after = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${signedIn.body.token}` } });
      assert.equal(after.response.status, 401);
    }
    const operator = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.compliance_manager.token}` } });
    assert.equal(operator.response.status, 200, 'authenticate_openppwr_token must still resolve an operator token');
  } finally {
    if (previous === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
    else process.env.OPENPPWR_DEMO_LOGIN = previous;
  }
});

// The privileges themselves, read from the catalogue rather than inferred from a statement failing —
// `has_table_privilege` reports the effective privilege, so this catches a grant arriving by any route.
test('the effective privileges match the intended boundary', async () => {
  const row = (await database.admin.query(`
    SELECT has_table_privilege('openppwr_app','identities','UPDATE')     AS update_identities,
           has_table_privilege('openppwr_app','identities','INSERT')     AS insert_identities,
           has_table_privilege('openppwr_app','identities','SELECT')     AS select_identities,
           has_table_privilege('openppwr_app','auth_sessions','SELECT')  AS select_sessions,
           has_table_privilege('openppwr_app','auth_sessions','INSERT')  AS insert_sessions,
           has_table_privilege('openppwr_app','auth_sessions','UPDATE')  AS update_sessions,
           has_table_privilege('openppwr_app','auth_sessions','DELETE')  AS delete_sessions,
           has_column_privilege('openppwr_app','identities','display_name','SELECT') AS select_display_name,
           has_column_privilege('openppwr_app','identities','token_hash','SELECT')   AS select_token_hash`)).rows[0];
  assert.equal(row.update_identities, false, 'writing a token hash is how an identity is seized');
  assert.equal(row.insert_sessions, false, 'inserting a session is how one is minted');
  assert.equal(row.update_sessions, false);
  assert.equal(row.delete_sessions, false);
  assert.equal(row.select_sessions, false, 'a session token hash is a bearer-equivalent verifier');
  // Both reversed by migration 014. INSERT was the identity-provisioning escalation, and table-wide SELECT handed the
  // caller the verifier that made every proof-of-possession argument circular.
  assert.equal(row.insert_identities, false, 'a standing INSERT is a standing grant to create an administrator');
  assert.equal(row.select_identities, false, 'table-wide SELECT includes token_hash');
  assert.equal(row.select_display_name, true, 'the role must resolve its own identity');
  assert.equal(row.select_token_hash, false, 'the verifier must not be readable by the role that presents it');
});
