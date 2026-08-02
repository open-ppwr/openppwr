import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, hashPassword, migrate } from '@openppwr/database';
import { MACHINE_ROLE_NAMES } from '../src/permissions.mjs';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { createRateLimiter, DEFAULT_RATE_LIMIT_RULES } from '@openppwr/security';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let authPool;
let maintenancePool;
let server;
let baseUrl;
let identities;
const DOMAIN = 'dummymail.example';

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json().catch(() => null) };
}
const login = (email, password) => jsonRequest('/v1/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
});

before(async () => {
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  process.env.OPENPPWR_DEMO_PASSWORD = 'demo';
  process.env.OPENPPWR_DEMO_EMAIL_DOMAIN = DOMAIN;
  database = await startTestDatabase('api-login');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // Migration 014 moved session issuance and the demonstration reset onto credentials the request pool
  // does not hold. A deployment is a demonstration because the installer said so, not because the
  // application claims it at runtime.
  authPool = createPool(database.authUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  await database.declareDemonstrationDeployment();
  const bootstrapSecret = randomUUID();
  // This file exercises authentication logic, not throttling. The real login budget is 10 per 15
  // minutes per IP, which a multi-test suite legitimately exhausts; the strict budget is asserted in
  // rate-limit.integration.test.mjs instead.
  const app = createApp({
    authPool, maintenancePool,
    pool,
    bootstrapToken: bootstrapSecret,
    storageRoot: resolve('.runtime-test', `login-${randomUUID()}`),
    rateLimiterFactory: ({ pool: appPool }) => createRateLimiter({
      pool: appPool,
      rules: { ...DEFAULT_RATE_LIMIT_RULES, login: [{ dimension: 'ip', windowMs: 60_000, max: 500 }] },
    }),
  });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  identities = created.body.identities;
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await authPool?.end();
  await maintenancePool?.end();
  await database?.stop();
  delete process.env.OPENPPWR_DEMO_LOGIN;
});

test('a user can sign in with email and password and receives a working session token', async () => {
  const { response, body } = await login(`demo@${DOMAIN}`, 'demo');
  assert.equal(response.status, 200);
  assert.equal(body.role, 'compliance_manager');
  assert.match(body.token, /^opp_sess_/);
  assert.ok(Date.parse(body.expiresAt) > Date.now());

  const session = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(session.response.status, 200);
  assert.equal(session.body.role, 'compliance_manager');
});

// Sign-in mutates state — it mints a session — and the stated property is that every mutation preserves
// actor and tenant history. Migration 038 records it inside the same transaction as the session insert,
// attributed to the identity that just signed in.
test('a successful sign-in appends an audit event attributed to the identity that signed in', async () => {
  const { body } = await login(`demo@${DOMAIN}`, 'demo');
  const whoAmI = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(whoAmI.response.status, 200);

  const rows = (await database.admin.query(
    `SELECT actor_id, entity_type, entity_id, payload
       FROM audit_events WHERE action = 'auth.login.succeeded' ORDER BY sequence DESC LIMIT 1`,
  )).rows;
  assert.equal(rows.length, 1, 'sign-in must append exactly one audit event');
  assert.equal(rows[0].entity_type, 'identity');
  assert.equal(rows[0].entity_id, whoAmI.body.actorId, 'the audited entity is the identity that just signed in');
  assert.equal(rows[0].actor_id, whoAmI.body.actorId, 'the audited actor is the identity that just signed in, not a caller-supplied value');
  assert.equal(rows[0].payload.role, 'compliance_manager');
});

test('a failed sign-in appends no audit event — there is no identity yet to attribute one to', async () => {
  const before = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login.succeeded'")).rows[0].n;
  await login(`demo@${DOMAIN}`, 'not-the-password');
  await login(`nobody@${DOMAIN}`, 'demo');
  const after = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login.succeeded'")).rows[0].n;
  assert.equal(after, before, 'a wrong password or an unknown address must not produce a sign-in event');
});

test('sign-in sets no cookie, so the bearer-only CSRF assessment still holds', async () => {
  const response = await fetch(`${baseUrl}/v1/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `demo@${DOMAIN}`, password: 'demo' }),
  });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a wrong password and an unknown address are indistinguishable', async () => {
  const wrongPassword = await login(`demo@${DOMAIN}`, 'not-the-password');
  const unknownUser = await login(`nobody@${DOMAIN}`, 'demo');
  assert.equal(wrongPassword.response.status, 401);
  assert.equal(unknownUser.response.status, 401);
  assert.equal(wrongPassword.body.error.code, unknownUser.body.error.code);
  assert.equal(wrongPassword.body.error.message, unknownUser.body.error.message);
});

test('an empty or missing credential is rejected without a server error', async () => {
  for (const payload of ['{}', JSON.stringify({ email: `demo@${DOMAIN}` }), JSON.stringify({ email: '', password: '' })]) {
    const { response } = await jsonRequest('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(response.status, 401);
  }
});

test('a session token carries only the role it was issued for', async () => {
  const auditor = await login(`read-only-auditor@${DOMAIN}`, 'demo');
  assert.equal(auditor.body.role, 'read_only_auditor');
  const denied = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${auditor.body.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: '1.0', packaging: [] }),
  });
  assert.equal(denied.response.status, 404, 'signing in must not grant privileges the role lacks');
});

test('the password is never echoed and no session response leaks a stored hash', async () => {
  const { body } = await login(`demo@${DOMAIN}`, 'demo');
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /demo"/);
  assert.doesNotMatch(serialized, /password|hash|salt/i);
});

test('bootstrap-issued identity tokens keep working alongside sessions', async () => {
  const legacy = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.body.role, 'tenant_admin');
});

test('demo reset clears domain data, preserves identities, and is refused for a role that may not manage the tenant', async () => {
  const admin = await login(`tenant-admin@${DOMAIN}`, 'demo');
  const auditor = await login(`read-only-auditor@${DOMAIN}`, 'demo');

  const denied = await jsonRequest('/v1/demo/reset', { method: 'POST', headers: { authorization: `Bearer ${auditor.body.token}` } });
  assert.equal(denied.response.status, 404, 'a read-only auditor must not be able to wipe the tenant');

  const allowed = await jsonRequest('/v1/demo/reset', { method: 'POST', headers: { authorization: `Bearer ${admin.body.token}` } });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.packagingRemaining, 0);

  // The credential used to perform the reset must still work afterwards, otherwise the reset
  // locks the user out of the environment it just restored.
  const stillValid = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${admin.body.token}` } });
  assert.equal(stillValid.response.status, 200);
});

// Regression: the reset deleted assessments before the gaps that reference them, so any tenant that
// had actually produced a gap could not be reset — foreign_key_violation, surfaced to the operator as
// a 500. The original test reset an empty tenant, which is precisely the state in which the bug is
// invisible: the demonstration only produces gaps once an assessment has failed, which is exactly
// when a user wants to start over.
test('demo reset works on a tenant that has produced assessments and gaps', async () => {
  const admin = await login(`tenant-admin@${DOMAIN}`, 'demo');
  const editorToken = identities.packaging_editor.token;
  const managerToken = identities.compliance_manager.token;

  const imported = await fetch(`${baseUrl}/v1/imports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${editorToken}`, 'content-type': 'application/json', 'idempotency-key': `reset-${randomUUID()}` },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.status, 201);

  const assessed = await jsonRequest('/v1/assessments/run', {
    method: 'POST',
    headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(assessed.response.status, 201);

  const gaps = await jsonRequest('/v1/gaps', { headers: { authorization: `Bearer ${managerToken}` } });
  assert.ok(gaps.body.items.length > 0, 'this test is only meaningful if the assessment produced gaps');

  const reset = await jsonRequest('/v1/demo/reset', { method: 'POST', headers: { authorization: `Bearer ${admin.body.token}` } });
  assert.equal(reset.response.status, 200, 'a tenant with gaps must be resettable');
  assert.equal(reset.body.packagingRemaining, 0);

  const remaining = await jsonRequest('/v1/gaps', { headers: { authorization: `Bearer ${managerToken}` } });
  assert.equal(remaining.body.items.length, 0);
});

test('signing out revokes the session on the server, not only in the browser', async () => {
  const { body: session } = await login(`demo@${DOMAIN}`, 'demo');
  const authorized = { authorization: `Bearer ${session.token}` };
  const before = await fetch(`${baseUrl}/v1/session`, { headers: authorized });
  assert.equal(before.status, 200);

  const loggedOut = await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: authorized });
  assert.equal(loggedOut.status, 204);

  // The credential is dead immediately. Clearing it only in the browser would leave it usable for
  // the remaining twelve hours by anyone who captured it.
  const after = await fetch(`${baseUrl}/v1/session`, { headers: authorized });
  assert.equal(after.status, 401);
});

test('signing out twice is not an error and reports that nothing was revoked', async () => {
  const { body: session } = await login(`demo@${DOMAIN}`, 'demo');
  const authorized = { authorization: `Bearer ${session.token}` };
  assert.equal((await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: authorized })).status, 204);
  // The second attempt cannot authenticate at all, because the first one worked.
  assert.equal((await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: authorized })).status, 401);
});

// Sign-out mutates state too — it revokes a session — and produces exactly one audit event, for the
// transition that actually happened rather than for every request that names it.
test('signing out appends exactly one audit event, attributed to the identity that signed out', async () => {
  const { body: session } = await login(`packaging-editor@${DOMAIN}`, 'demo');
  const whoAmI = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(whoAmI.response.status, 200);

  const before = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.revoked'")).rows[0].n;
  const loggedOut = await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(loggedOut.status, 204);

  const rows = (await database.admin.query(
    `SELECT actor_id, entity_type, entity_id FROM audit_events WHERE action = 'session.revoked' ORDER BY sequence DESC LIMIT 1`,
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_type, 'identity');
  assert.equal(rows[0].entity_id, whoAmI.body.actorId);
  assert.equal(rows[0].actor_id, whoAmI.body.actorId);

  // A second sign-out cannot authenticate — the credential is already dead — so it must add no further
  // event. Signing out twice stays a no-op all the way down to the audit chain.
  const secondAttempt = await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(secondAttempt.status, 401);
  const after = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.revoked'")).rows[0].n;
  assert.equal(after, before + 1, 'a second sign-out attempt must not append a second event');
});

// A static operator token cannot be revoked in place — `/v1/logout` says so honestly rather than claiming a
// sign-out that did not happen — and it must not produce an event describing a revocation that never occurred.
test('logout on a static operator credential appends no session.revoked event', async () => {
  const before = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.revoked'")).rows[0].n;
  const response = await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(response.status, 200);
  const after = (await database.admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.revoked'")).rows[0].n;
  assert.equal(after, before, 'a static credential has no session to revoke and no event to append');
});

test('signing out ends one session and leaves the identity able to sign in again', async () => {
  const first = (await login(`demo@${DOMAIN}`, 'demo')).body;
  const second = (await login(`demo@${DOMAIN}`, 'demo')).body;
  assert.notEqual(first.token, second.token);
  assert.equal((await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${first.token}` } })).status, 204);
  // Revoking one session must not revoke every session the identity holds: a user signing out on
  // one machine has not asked to be signed out everywhere.
  assert.equal((await fetch(`${baseUrl}/v1/session`, { headers: { authorization: `Bearer ${second.token}` } })).status, 200);
  const again = await login(`demo@${DOMAIN}`, 'demo');
  assert.equal(again.response.status, 200);
});

test('a static operator credential reports honestly that it cannot be revoked', async () => {
  const response = await fetch(`${baseUrl}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.revoked, false);
  assert.equal(body.reason, 'STATIC_CREDENTIAL_NOT_REVOCABLE');
  // Claiming a sign-out that did not happen would be worse than the limitation itself.
  assert.equal((await fetch(`${baseUrl}/v1/session`, { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } })).status, 200);
});

test('signing out requires a credential, so a guessed session identifier revokes nothing', async () => {
  assert.equal((await fetch(`${baseUrl}/v1/logout`, { method: 'POST' })).status, 401);
});

test('a session reports its own capabilities and expiry so the interface can stop inviting refusals', async () => {
  const { body: session } = await login(`demo@${DOMAIN}`, 'demo');
  const { response, body } = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 200);
  assert.equal(body.role, 'compliance_manager');
  assert.ok(Array.isArray(body.permissions));
  assert.ok(body.permissions.includes('audit:verify'), 'the role that freezes a review must be told it may verify the record');
  assert.ok(body.permissions.includes('dossier:download'));
  assert.ok(!body.permissions.includes('scan:process'));
  assert.ok(Date.parse(body.expiresAt) > Date.now());
});

test('the audit chain can be verified by the role that runs the review, and reports what it covered', async () => {
  const { body: session } = await login(`demo@${DOMAIN}`, 'demo');
  const { response, body } = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 200, 'the compliance manager must be able to verify the audit chain');
  assert.equal(body.valid, true);
  assert.ok(body.count > 0);
  // A bare "valid: true" asks the reader to take the result on faith.
  assert.ok(Date.parse(body.firstEventAt) > 0);
  assert.ok(Date.parse(body.lastEventAt) >= Date.parse(body.firstEventAt));
});

test('a role with no review responsibility is refused audit verification without confirming it exists', async () => {
  const { body: session } = await login(`packaging-editor@${DOMAIN}`, 'demo');
  const { response, body } = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND');
});

test('build metadata is reported without a credential and names no infrastructure', async () => {
  const { response, body } = await jsonRequest('/v1/version');
  assert.equal(response.status, 200);
  assert.equal(body.product, 'OpenPPWR Community');
  for (const field of ['version', 'revision', 'revisionShort', 'builtAt', 'channel', 'imageDigest', 'migrationLevel', 'docsVersion']) {
    assert.ok(field in body, `${field} must be reported`);
  }
  const serialized = JSON.stringify(body);
  assert.ok(!/https?:\/\//u.test(serialized), 'build metadata must not carry a URL');
  assert.ok(!/password|token|secret/iu.test(serialized), 'build metadata must not carry credentials');
});

// Demonstration sign-in survived its own feature flag.
//
// `/v1/demo/accounts` and `/v1/demo/reset` both consulted `demoLoginEnabled()`; `/v1/login` did not. The
// accounts are persisted rows, so unsetting the variable removed the panel that advertised the published
// password and left the password working — and every session already issued kept its full lifetime.
//
// The flag is read from the environment on every call, so it governs a running process rather than only a
// restart. These tests exercise that contract in both directions.
test('disabling demonstration sign-in denies new logins and existing sessions, and leaves operator tokens working', async () => {
  const previous = process.env.OPENPPWR_DEMO_LOGIN;
  process.env.OPENPPWR_DEMO_LOGIN = 'true';

  const email = `demo@${DOMAIN}`;
  const signedIn = await jsonRequest('/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
  });
  assert.equal(signedIn.response.status, 200, `demo sign-in must work while enabled: ${JSON.stringify(signedIn.body)}`);
  const sessionToken = signedIn.body.token;

  // The session works while the flag is on.
  const before = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(before.response.status, 200);

  try {
    process.env.OPENPPWR_DEMO_LOGIN = 'false';

    // A new sign-in is refused as not-found: with the flag off the route does not exist, and "disabled here"
    // would confirm the accounts are present.
    const denied = await jsonRequest('/v1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
    });
    assert.equal(denied.response.status, 404, 'a new demo sign-in must be refused once the flag is off');
    assert.equal(denied.body.error.code, 'RESOURCE_NOT_FOUND');

    // The session issued while it was on stops working immediately. Blocking new sign-ins alone would have
    // left it valid for its full lifetime, so disabling the feature would not disable the access it granted.
    const after = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(after.response.status, 401, 'an existing demo session must stop working');
    assert.equal(after.body.error.code, 'AUTHENTICATION_FAILED');

    // The credentials panel is gone too, and so is the demo reset.
    const accounts = await jsonRequest('/v1/demo/accounts');
    assert.equal(accounts.response.status, 404);

    // Operator bearer tokens are a different credential and must be unaffected: they are how a deployment is
    // administered, and taking them out with the demo flag would be an outage.
    const operator = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
    assert.equal(operator.response.status, 200, 'an operator token must not be affected by the demo flag');
    assert.equal(operator.body.role, 'tenant_admin');
  } finally {
    if (previous === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
    else process.env.OPENPPWR_DEMO_LOGIN = previous;
  }
});

// The machine identities are not people, and a demonstration account for one is a credential nobody
// announced.
//
// `bootstrap` minted an identity for all nine roles and then handed the same published password to every
// one of them, while `/v1/demo/accounts` offered seven. `worker` and `service_account` therefore had a
// working sign-in at a predictable address — `worker@<domain>` — on the default demonstration posture, in
// a product whose own role matrix says nobody signs in as the worker and whose contract said the same.
// `authenticate_openppwr_demo_login` did not filter by role, so the account existing was the whole of the
// vulnerability.
//
// The property asserted is the account's absence rather than only the refusal. A refusal that depends on a
// check somewhere above the credential leaves the credential in the database, reachable by anything that
// ever forgets to make the check — which is the shape of every defect this file already records. Migration
// 039 adds the other half for a deployment that was bootstrapped before the provisioning was corrected:
// it removes the rows that already exist and makes sign-in refuse a machine role in the database, which is
// what the three tests below this one exercise.
test('the machine identities are given no demonstration sign-in account', async () => {
  const accounts = await database.admin.query(
    `SELECT i.role FROM demo_users u JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
      WHERE i.role = ANY($1)`,
    [['worker', 'service_account']],
  );
  assert.deepEqual(accounts.rows, [], 'a machine identity must hold no password account');

  for (const role of ['worker', 'service_account']) {
    const attempt = await login(`${role.replaceAll('_', '-')}@${DOMAIN}`, 'demo');
    assert.equal(attempt.response.status, 401, `${role} must not be able to sign in with the published demonstration password`);
  }
});

// The half the application fix could not reach.
//
// Correcting `bootstrap` stops the account being created. It does nothing for a deployment bootstrapped
// before it — the rows are still there — and nothing at all if an older image, a restored backup or one
// hand-written INSERT puts a row back. This reproduces that exactly: the row is written straight into
// `demo_users` by a credential that bypasses the application entirely, with a hash of the published
// password that is correct, against the real `worker` identity. Before migration 039 this signed in.
//
// The row is left in place for the duration of the assertions on purpose. If the test deleted it first it
// would be re-testing the deletion, not the refusal, and a refusal is what has to hold when the deletion
// has been undone by something the product does not control.
test('a demonstration account reinstated for a machine identity is refused, and is not confirmed by the salt lookup', async () => {
  const address = `worker-reinstated@${DOMAIN}`;
  const { passwordHash, passwordSalt } = hashPassword('demo');
  await database.admin.query(
    `INSERT INTO demo_users (tenant_id, id, email, password_hash, password_salt, identity_id)
     SELECT i.tenant_id, $1, $2, $3, $4, i.id FROM identities i WHERE i.role = 'worker'`,
    [randomUUID(), address, passwordHash, passwordSalt],
  );
  const reinstated = await database.admin.query('SELECT count(*)::int AS n FROM demo_users WHERE email = $1', [address]);
  assert.equal(reinstated.rows[0].n, 1, 'this test is only meaningful if the row it is about actually exists');

  try {
    const attempt = await login(address, 'demo');
    assert.equal(attempt.response.status, 401, 'a live password account for a machine identity must not authenticate');
    assert.equal(attempt.body.error.code, 'AUTHENTICATION_FAILED');

    // No session was minted, and no `auth.login.succeeded` was appended for it — a refusal that still
    // recorded a successful sign-in would be a refusal in the response only.
    const sessions = await database.admin.query(
      `SELECT count(*)::int AS n FROM auth_sessions s JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
        WHERE i.role = ANY($1)`, [[...MACHINE_ROLE_NAMES]],
    );
    assert.equal(sessions.rows[0].n, 0, 'no session may exist for a machine identity');

    // The salt lookup is the other half of sign-in, and it answers before any password is checked. It must
    // return the deterministic decoy — the same answer an address with no account gets — rather than the
    // real salt that is sitting in the row. Returning the real one would confirm the account exists to
    // anybody who can compute the decoy, which is anybody, because the derivation is in the schema.
    const decoy = createHash('sha256').update(`openppwr-decoy-salt:${address.toLowerCase()}`).digest('hex').slice(0, 32);
    const answered = await database.admin.query('SELECT openppwr_demo_login_salt($1) AS salt', [address]);
    assert.equal(answered.rows[0].salt, decoy, 'the salt lookup must treat a machine identity as an address that does not exist');
    assert.notEqual(answered.rows[0].salt, passwordSalt);
  } finally {
    await database.admin.query('DELETE FROM demo_users WHERE email = $1', [address]);
  }
});

// One list, in two places that cannot import each other. `permissions.mjs` decides what the running process
// will do; `openppwr_machine_roles()` decides what the database will do for every other caller, including an
// older image. They are compared here because a migration cannot import JavaScript and the API cannot read a
// role list it never queries — so nothing else would notice them diverging.
test('the database and the permission registry name the same machine roles', async () => {
  const { rows } = await database.admin.query('SELECT openppwr_machine_roles() AS roles');
  assert.deepEqual([...rows[0].roles].sort(), [...MACHINE_ROLE_NAMES].sort());
  assert.ok(rows[0].roles.length > 0, 'an empty list would filter nothing while still passing a set comparison against an empty registry');
});

// The seven that are offered must still work, so the fix above cannot be satisfied by provisioning nobody.
test('every role the demonstration offers can sign in', async () => {
  const { body: offered } = await jsonRequest('/v1/demo/accounts');
  assert.equal(offered.accounts.length, 7);
  for (const account of offered.accounts) {
    const attempt = await login(account.email, 'demo');
    assert.equal(attempt.response.status, 200, `${account.role} is offered on the sign-in panel and must be able to sign in`);
    assert.equal(attempt.body.role, account.role);
  }
});

// Re-enabling restores the feature. The session revoked above is not resurrected, because a credential that
// has been refused once must not become valid again by flipping a switch.
test('re-enabling demonstration sign-in allows a fresh login and does not revive a refused session', async () => {
  const previous = process.env.OPENPPWR_DEMO_LOGIN;
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  try {
    const email = `read-only-auditor@${DOMAIN}`;
    const again = await jsonRequest('/v1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
    });
    assert.equal(again.response.status, 200);
    const fresh = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${again.body.token}` } });
    assert.equal(fresh.response.status, 200);
    assert.equal(fresh.body.role, 'read_only_auditor');
  } finally {
    if (previous === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
    else process.env.OPENPPWR_DEMO_LOGIN = previous;
  }
});
