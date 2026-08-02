// The attacks, written from the attacker's side, as the real request-serving database role.
//
// Two remediations were reported closed and were not. Both failed the same way: a check was moved somewhere
// that *looks* more privileged without asking whether the caller controls its inputs. Re-reading them with
// that question in hand produced the three counterexamples below.
//
// These tests exist so that question is answered by execution rather than by reading. Each connects as
// `openppwr_app` — the role the API itself uses, and therefore the role an attacker holds after any
// application-level compromise — and tries to do the thing the boundary claims to prevent.
//
// They are written before the redesign, and they are expected to FAIL at the commit that introduces them.
// A boundary whose attack cannot be expressed as a test is a boundary nobody can check.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool, hashPassword, migrate, tokenHash } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp } from '../src/app.mjs';

let database;
let pool;
let authPool;
let maintenancePool;
let workerPool;
let server;
let baseUrl;
let identities;
let victimTenant;

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

// Everything an attacker holding the application role can do, in one transaction that is always rolled back.
// The rollback is in `finally` — the harness defect this programme has now produced twice.
async function attacker(run, { tenantId, actorId } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      // The GUC the application role sets for itself. This is the input the failed remediation treated as
      // authority.
      await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [tenantId]);
    }
    if (actorId) await client.query(`SELECT set_config('openppwr.actor_id', $1, true)`, [actorId]);
    return await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const packagingCount = async (tenantId) => Number(
  (await database.admin.query('SELECT count(*)::int AS count FROM packaging WHERE tenant_id=$1', [tenantId])).rows[0].count,
);

before(async () => {
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  database = await startTestDatabase('api-privilege-attack');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // The privileged credentials the request pool does not have. A demonstration deployment is declared by
  // the installer, exactly as an operator would — the application cannot declare it at runtime.
  authPool = createPool(database.authUrl);
  maintenancePool = createPool(database.maintenanceUrl);
  workerPool = createPool(database.workerUrl);
  await database.declareDemonstrationDeployment();
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, authPool, maintenancePool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/attack-${randomUUID()}` });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
  victimTenant = created.body.tenantId;
  const imported = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'attack-fixture' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201);
  assert.ok(await packagingCount(victimTenant) > 0, 'the victim must have data, or a wipe proves nothing');
});

after(async () => {
  delete process.env.OPENPPWR_DEMO_LOGIN;
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await authPool?.end();
  await maintenancePool?.end();
  await workerPool?.end();
  await database?.stop();
});

// --- the reset target came from a context this role sets itself ---------------------------------------
//
// The reset derives its target from `openppwr_current_tenant()`, which reads a GUC this role sets. Removing
// the parameter made the target implicit, not trusted.

test('ATTACKER_CONTROLLED_GUC_RESET_DENIED — setting the tenant GUC does not let the application role reset a tenant', async () => {
  const before = await packagingCount(victimTenant);
  assert.ok(before > 0);

  const outcome = await attacker(
    async (client) => {
      try {
        await client.query('SELECT packaging_remaining FROM reset_openppwr_demo_tenant()');
        return 'reset succeeded';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.message}`;
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );

  assert.equal(outcome, 'denied by privilege', `the application role must not be able to reset a tenant at all; got: ${outcome}`);
  assert.equal(await packagingCount(victimTenant), before, 'the victim tenant lost data');
});

// The demonstration marker the reset checks for is a row in `demo_users`, and the application role can write
// that table. So the "this is a demonstration tenant" test can be satisfied by the attacker.
test('ATTACKER_FORGED_DEMO_MARKER_RESET_DENIED — a demo marker the attacker created is not proof of a demo tenant', async () => {
  const before = await packagingCount(victimTenant);
  await database.admin.query('DELETE FROM demo_users WHERE tenant_id=$1', [victimTenant]);

  const outcome = await attacker(
    async (client) => {
      // A savepoint, because the forge attempt is *expected* to be refused and a refusal aborts the
      // transaction — leaving every later statement answering 25P02 instead of the question asked. That is
      // the harness defect this programme has now produced three times; here it turned a correct refusal
      // into an unreadable one.
      let forged = 'refused';
      await client.query('SAVEPOINT forge');
      try {
        await client.query(
          `INSERT INTO demo_users (tenant_id,id,identity_id,email,password_hash,password_salt)
           VALUES ($1,$2,$3,$4,repeat('0',128),'salt')`,
          [victimTenant, randomUUID(), identities.tenant_admin.id, `forged-${randomUUID()}@example.invalid`],
        );
        forged = 'forged';
      } catch (error) {
        forged = error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT forge').catch(() => {});
      }
      let reset = 'refused';
      try {
        await client.query('SELECT packaging_remaining FROM reset_openppwr_demo_tenant()');
        reset = 'reset succeeded';
      } catch (error) {
        reset = error.code === '42501' ? 'denied by privilege' : `refused: ${error.message}`;
      }
      return { forged, reset };
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );

  assert.equal(outcome.forged, 'denied by privilege', 'the application role must not be able to create a demonstration marker');
  assert.equal(outcome.reset, 'denied by privilege', 'the reset must be unreachable regardless of the marker');
  assert.equal(await packagingCount(victimTenant), before);
});

// --- the session issuer validated nothing it was handed -----------------------------------------------
//
// Revoking INSERT on auth_sessions closed the table door. `issue_openppwr_session` is the function door: it
// is SECURITY DEFINER, executable by this role, and validates no password, no role, no expiry ceiling and no
// caller scope — it installs the supplied tenant context itself.

test('UNAUTHENTICATED_SESSION_ISSUANCE_DENIED — there is no primitive left to call', async () => {
  const chosen = `opp_sess_${randomUUID().replaceAll('-', '')}`;
  // Migration 018 dropped the function rather than revoking it, which is the stronger outcome: a revoked
  // grant is one GRANT away from returning. `42883` — the function does not exist — is therefore the
  // expected answer here, and a privilege denial would mean it had come back.
  const outcome = await attacker(
    async (client) => {
      try {
        await client.query('SELECT issue_openppwr_session($1,$2,$3,$4,$5)', [
          victimTenant, identities.tenant_admin.id, randomUUID(), tokenHash(chosen),
          new Date(Date.now() + 365 * 86_400_000).toISOString(),
        ]);
        return 'session issued';
      } catch (error) {
        return error.code === '42883' ? 'no such function' : (error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`);
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );
  assert.equal(outcome, 'no such function', `the generic issuer must not exist at all; got: ${outcome}`);

  const used = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${chosen}` } });
  assert.equal(used.response.status, 401, 'a forged session token authenticated');
});

test('CALLER_CONTROLLED_EXPIRY_SESSION_ISSUANCE_DENIED — the request role has no issuer to pass an expiry to', async () => {
  const outcome = await attacker(
    async (client) => {
      try {
        await client.query('SELECT issue_openppwr_session($1,$2,$3,$4,$5)', [
          victimTenant, identities.compliance_manager.id, randomUUID(), tokenHash(`opp_sess_${randomUUID()}`),
          new Date(Date.now() + 3650 * 86_400_000).toISOString(),
        ]);
        return 'ten-year session issued';
      } catch (error) {
        return error.code === '42883' ? 'no such function' : (error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`);
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );
  assert.equal(outcome, 'no such function', `got: ${outcome}`);
  // The ceiling itself is asserted against the surviving atomic operation, further down.
});

// --- INSERT on identities was a standing grant to create an administrator -----------------------------
//
// `INSERT` on `identities` was kept for bootstrap. With a tenant GUC the role controls, it creates a new
// administrator with a token hash the attacker chose — which then authenticates. Seizure by another name.

test('APPLICATION_ROLE_ADMIN_CREATION_DENIED — the application role cannot mint itself an administrator', async () => {
  const chosen = `opp_attack_${randomUUID().replaceAll('-', '')}`;
  const outcome = await attacker(
    async (client) => {
      try {
        await client.query(
          `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash)
           VALUES ($1,$2,'seized','tenant_admin',NULL,$3)`,
          [victimTenant, randomUUID(), tokenHash(chosen)],
        );
        // Committed deliberately: the attack is only real if the credential survives the transaction.
        await client.query('COMMIT');
        await client.query('BEGIN');
        return 'administrator created';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.message}`;
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );

  if (outcome === 'administrator created') {
    const escalated = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${chosen}` } });
    await database.admin.query(`DELETE FROM identities WHERE display_name='seized'`);
    assert.fail(`the application role created a tenant_admin and it authenticated with status ${escalated.response.status}`);
  }
  assert.equal(outcome, 'denied by privilege', `got: ${outcome}`);
});

test('APPLICATION_ROLE_TOKEN_HASH_INJECTION_DENIED — an existing identity cannot have its credential replaced', async () => {
  const chosen = `opp_attack_${randomUUID().replaceAll('-', '')}`;
  const outcome = await attacker(
    async (client) => {
      try {
        const updated = await client.query('UPDATE identities SET token_hash=$1 WHERE id=$2', [tokenHash(chosen), identities.tenant_admin.id]);
        return updated.rowCount ? 'token replaced' : 'no rows affected';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.message}`;
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );
  assert.equal(outcome, 'denied by privilege', `got: ${outcome}`);
});

// The rotation function takes the current hash as proof. The role can read that hash, so the proof is a
// formality — this asserts the role cannot obtain the verifier in the first place.
test('the application role cannot read a stored credential verifier', async () => {
  const outcome = await attacker(
    async (client) => {
      try {
        const read = await client.query('SELECT token_hash FROM identities WHERE id=$1', [identities.tenant_admin.id]);
        return read.rows[0]?.token_hash ? 'verifier readable' : 'no verifier returned';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
      }
    },
    { tenantId: victimTenant, actorId: identities.tenant_admin.id },
  );
  assert.notEqual(outcome, 'verifier readable', 'a stored hash a caller can read is not a proof of possession');
});

// --- the boundary that must survive ----------------------------------------------------------------
//
// A redesign that breaks the product is not a fix. These assert the supported paths still work, so the
// tests above cannot be satisfied by simply revoking everything.

test('the supported paths still work after every refusal above', async () => {
  const operator = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.compliance_manager.token}` } });
  assert.equal(operator.response.status, 200, 'an operator token must still authenticate');

  const listed = await jsonRequest('/v1/catalog/packaging', { headers: { authorization: `Bearer ${identities.compliance_manager.token}` } });
  assert.equal(listed.response.status, 200, 'ordinary business reads must still work');
  assert.ok(listed.body.items.length > 0);

  const signedIn = await jsonRequest('/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `demo@${process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example'}`, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
  });
  // Demonstration users exist only where provisioning ran; where they do, sign-in must still issue a session
  // through the authenticated path.
  if (signedIn.response.status === 200) {
    const used = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${signedIn.body.token}` } });
    assert.equal(used.response.status, 200, 'the authenticated session path must survive the redesign');
  }
});

// A record of what the attacker could reach, so a future reader sees the shape rather than only the verdicts.
test('the attack surface is enumerated rather than assumed', async () => {
  const grants = (await database.admin.query(`
    SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
      FROM information_schema.table_privileges
     WHERE grantee = 'openppwr_app' AND table_name IN ('identities','auth_sessions','demo_users','tenants')
     GROUP BY table_name ORDER BY table_name`)).rows;
  const functions = (await database.admin.query(`
    SELECT p.proname AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND coalesce(array_to_string(p.proacl, ','), '') LIKE '%openppwr_app=X%'
     ORDER BY p.proname`)).rows.map((row) => row.name);

  // Asserted individually, because these are the capabilities the findings are about.
  const byTable = Object.fromEntries(grants.map((row) => [row.table_name, row.privileges]));
  assert.ok(!(byTable.identities || '').includes('INSERT'), `the request role may still INSERT identities: ${byTable.identities}`);
  assert.ok(!(byTable.identities || '').includes('UPDATE'), `the request role may still UPDATE identities: ${byTable.identities}`);
  assert.ok(!(byTable.demo_users || '').includes('INSERT'), `the request role may still create demonstration markers: ${byTable.demo_users}`);
  assert.ok(!functions.includes('issue_openppwr_session'), 'the generic session-minting primitive is still callable by the request role');
  assert.ok(!functions.includes('reset_openppwr_demo_tenant'), 'the reset is still callable by the request role');
});

// --- what was still reachable after migration 014 claimed these closed ----------------------------
//
// Both findings came back INCOMPLETE for the same reason, and it was mine: I granted the new principals the
// underlying table privileges "so the function would work". A SECURITY DEFINER function runs with its
// owner's rights and needs nothing from the caller but EXECUTE — so those grants did not enable the
// function, they bypassed it. Migration 016 takes them back.
//
// The question to ask of a grant to a principal that calls a definer function is not "does the function
// need this" but "what can the caller do with it without the function".

async function asRole(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('MAINTENANCE_ROLE_CANNOT_DELETE_WITHOUT_THE_RESET_FUNCTION — the reset function is not optional', async () => {
  const before = await packagingCount(victimTenant);
  assert.ok(before > 0);

  const outcome = await asRole(maintenancePool, async (client) => {
    try {
      await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [victimTenant]);
      const deleted = await client.query('DELETE FROM packaging WHERE tenant_id=$1', [victimTenant]);
      return `deleted ${deleted.rowCount} rows directly`;
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });

  assert.equal(outcome, 'denied by privilege', `the maintenance credential must reach the data only through the audited, metadata-checked function; got: ${outcome}`);
  assert.equal(await packagingCount(victimTenant), before, 'the tenant lost data');
});

test('AUTH_ROLE_CANNOT_INSERT_A_SESSION_DIRECTLY — the expiry ceiling is not optional', async () => {
  const chosen = `opp_sess_${randomUUID().replaceAll('-', '')}`;
  const outcome = await asRole(authPool, async (client) => {
    try {
      await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [victimTenant]);
      await client.query(
        `INSERT INTO auth_sessions (tenant_id,id,identity_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [victimTenant, randomUUID(), identities.tenant_admin.id, tokenHash(chosen), new Date(Date.now() + 3650 * 86_400_000).toISOString()],
      );
      return 'ten-year session inserted directly';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(outcome, 'denied by privilege', `a session-issuing function that validates nothing the caller can also write directly is not a boundary; got: ${outcome}`);

  const used = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${chosen}` } });
  assert.equal(used.response.status, 401, 'a directly inserted session authenticated');
});

test('AUTH_ROLE_CANNOT_READ_A_CREDENTIAL_VERIFIER — the authentication role reads verifiers only inside the definer boundary', async () => {
  for (const [table, column] of [['identities', 'token_hash'], ['demo_users', 'password_hash']]) {
    const outcome = await asRole(authPool, async (client) => {
      try {
        // A valid tenant context first. Both tables carry an RLS policy that casts the tenant GUC to uuid,
        // and with the GUC unset the planner folds that cast and raises 22P02 -- which is not a privilege
        // answer at all. Without this the test would report a refusal it had not actually obtained.
        await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [victimTenant]);
        await client.query(`SELECT ${column} FROM ${table} LIMIT 1`);
        return 'verifier readable';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
      }
    });
    assert.equal(outcome, 'denied by privilege', `openppwr_auth can read ${table}.${column} directly`);
  }
});

// --- the authentication boundary as one operation -----------------------------------------------------
//
// Migration 016 revoked the direct `INSERT` on `auth_sessions`, and that was necessary and not sufficient.
// Sign-in remained two primitives held by one principal: a lookup that returned the stored verifier having
// authenticated nothing, and an issuer that minted a session having verified nothing. A caller holding both
// needs neither. Migration 018 replaces them with one operation and drops both.

test('SESSION_MINTING_PRIMITIVE_ABSENT — the schema has no generic issuer or verifier lookup left to grant', async () => {
  const surviving = (await database.admin.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('issue_openppwr_session','lookup_openppwr_demo_user')`)).rows;
  // Dropped rather than revoked: a revoked function is one GRANT away from returning.
  assert.deepEqual(surviving, [], `these are one GRANT away from reinstating the split: ${JSON.stringify(surviving)}`);
});

test('ATOMIC_LOGIN_REJECTS_A_WRONG_CREDENTIAL — and issues nothing when it does', async () => {
  const before = Number((await database.admin.query('SELECT count(*)::int AS c FROM auth_sessions')).rows[0].c);
  const outcome = await asRole(authPool, async (client) => {
    const attempt = await client.query(
      'SELECT session_token FROM authenticate_openppwr_demo_login($1,$2,$3)',
      [`demo@${process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example'}`, 'f'.repeat(64), 3600],
    );
    return attempt.rowCount;
  });
  assert.equal(outcome, 0, 'a wrong derived hash produced a session');
  assert.equal(
    Number((await database.admin.query('SELECT count(*)::int AS c FROM auth_sessions')).rows[0].c),
    before,
    'a refused sign-in still wrote a session row',
  );
});

test('CALLER_CANNOT_SELECT_IDENTITY — an unknown address is refused exactly as a wrong credential is', async () => {
  const unknown = await asRole(authPool, async (client) => (await client.query(
    'SELECT session_token FROM authenticate_openppwr_demo_login($1,$2,$3)',
    [`nobody-${randomUUID()}@example.invalid`, 'a'.repeat(64), 3600])).rowCount);
  assert.equal(unknown, 0);

  // The salt for an unknown address is a stable decoy rather than nothing, so the shape of the reply is not
  // an address oracle.
  const address = `nobody-${randomUUID()}@example.invalid`;
  const first = await asRole(authPool, (client) => client.query('SELECT openppwr_demo_login_salt($1) AS salt', [address]));
  const second = await asRole(authPool, (client) => client.query('SELECT openppwr_demo_login_salt($1) AS salt', [address]));
  assert.ok(first.rows[0].salt, 'an unknown address returned no salt, which discloses that it is unknown');
  assert.equal(first.rows[0].salt, second.rows[0].salt, 'the decoy must be stable or repeated calls disclose it');
});

test('SESSION_EXPIRY_CEILING_ENFORCED — a caller asking for a decade gets the server policy', async () => {
  // Provisioned here rather than reused from bootstrap: an earlier test in this file deletes `demo_users`
  // as part of its own setup, and a test that depends on the order the others ran in is asserting that
  // order rather than the property it is named for.
  const address = `ceiling-${randomUUID()}@example.invalid`;
  const password = `pw-${randomUUID()}`;
  const { passwordHash, passwordSalt } = hashPassword(password);
  await database.admin.query(
    `INSERT INTO demo_users (tenant_id,id,identity_id,email,password_hash,password_salt)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [victimTenant, randomUUID(), identities.compliance_manager.id, address, passwordHash, passwordSalt],
  );
  try {
    const salt = (await asRole(authPool, (client) => client.query(
      'SELECT openppwr_demo_login_salt($1) AS salt', [address]))).rows[0].salt;
    assert.equal(salt, passwordSalt, 'the salt returned must be the one the stored hash was made with');

    const issued = await asRole(authPool, (client) => client.query(
      'SELECT expires_at FROM authenticate_openppwr_demo_login($1,$2,$3)',
      [address, hashPassword(password, salt).passwordHash, 3650 * 86400]));
    assert.equal(issued.rowCount, 1, 'the correct credential must still sign in');
    const granted = new Date(issued.rows[0].expires_at).getTime() - Date.now();
    assert.ok(granted <= 24 * 3600 * 1000 + 60000, `the caller chose a ${Math.round(granted / 86400000)}-day session`);
  } finally {
    await database.admin.query('DELETE FROM demo_users WHERE email=$1', [address]).catch(() => {});
  }
});

test('APPLICATION_ROLE_CANNOT_SIGN_IN_AS_ANYONE — the request pool holds neither half', async () => {
  const attempts = [
    ['SELECT openppwr_demo_login_salt($1)', ['demo@example.invalid']],
    ['SELECT session_token FROM authenticate_openppwr_demo_login($1,$2,$3)', ['demo@example.invalid', 'a'.repeat(64), 60]],
  ];
  for (const [sql, values] of attempts) {
    const outcome = await asRole(pool, async (client) => {
      try { await client.query(sql, values); return 'permitted'; }
      catch (error) { return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`; }
    });
    assert.equal(outcome, 'denied by privilege', `openppwr_app can reach the authentication path: ${sql}`);
  }
});

// The old two-argument function took no actor and checked no permission, so the role the API
// already holds could retire every operator credential in the deployment.
// The version of this test that shipped with migration 018 passed the *actor id* and read as proof the
// boundary held. It was the demonstration of the bypass: the function looked up the role of whatever
// identity it was handed, so `openppwr_app` could name any tenant_admin and revoke anything.
//
// The actor is now proved by a credential the caller must possess, and `openppwr_app` cannot read
// `token_hash`, so presenting its digest is possession rather than assertion.
test('CROSS_IDENTITY_TOKEN_REVOCATION_DENIED — naming an administrator is not being one', async () => {
  const impersonation = await asRole(pool, async (client) => {
    try {
      // The exact attack: the auditor's own credential, aimed at a manager.
      await client.query('SELECT revoke_openppwr_identity_token($1,$2,$3)',
        [victimTenant, tokenHash(identities.read_only_auditor.token), identities.compliance_manager.id]);
      return 'revoked';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(impersonation, 'denied by privilege', 'an auditor retired a manager credential');

  // And an id alone proves nothing, whoever it belongs to.
  const byIdAlone = await asRole(pool, async (client) => {
    try {
      await client.query('SELECT revoke_openppwr_identity_token($1,$2,$3)',
        [victimTenant, identities.tenant_admin.id, identities.compliance_manager.id]);
      return 'revoked';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(byIdAlone, 'denied by privilege', 'an identity id was accepted as authority');

  const still = await jsonRequest('/v1/session', { headers: { authorization: `Bearer ${identities.compliance_manager.token}` } });
  assert.equal(still.response.status, 200, 'the target credential stopped working');
});

test('the authorised revocation paths still work, on a presented credential', async () => {
  const contributor = identities.evidence_contributor;
  const self = await asRole(pool, (client) => client.query(
    'SELECT revoke_openppwr_identity_token($1,$2,$3) AS revoked',
    [victimTenant, tokenHash(contributor.token), contributor.id]));
  assert.equal(self.rows[0].revoked, true, 'an identity must be able to retire its own credential');
  await database.admin.query('UPDATE identities SET active=true WHERE id=$1', [contributor.id]);

  const byAdmin = await asRole(pool, (client) => client.query(
    'SELECT revoke_openppwr_identity_token($1,$2,$3) AS revoked',
    [victimTenant, tokenHash(identities.tenant_admin.token), contributor.id]));
  assert.equal(byAdmin.rows[0].revoked, true, 'a tenant administrator must be able to retire a credential');
  await database.admin.query('UPDATE identities SET active=true WHERE id=$1', [contributor.id]);
});

// The stored salt is 16 random bytes as hex — 32 characters. The decoy was a SHA-256 digest, 64.
// No timing measurement was needed: `length()` answered "does this account exist".
test('LOGIN_SALT_DECOY_INDISTINGUISHABLE — a decoy of a different length is not a decoy', async () => {
  const address = `probe-${randomUUID()}@example.invalid`;
  const password = `pw-${randomUUID()}`;
  const { passwordHash, passwordSalt } = hashPassword(password);
  await database.admin.query(
    `INSERT INTO demo_users (tenant_id,id,identity_id,email,password_hash,password_salt)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [victimTenant, randomUUID(), identities.compliance_manager.id, address, passwordHash, passwordSalt],
  );
  try {
    const known = (await asRole(authPool, (client) => client.query(
      'SELECT openppwr_demo_login_salt($1) AS salt', [address]))).rows[0].salt;
    const unknown = (await asRole(authPool, (client) => client.query(
      'SELECT openppwr_demo_login_salt($1) AS salt', [`absent-${randomUUID()}@example.invalid`]))).rows[0].salt;

    assert.equal(known, passwordSalt);
    assert.equal(unknown.length, known.length, `the decoy is ${unknown.length} characters and a real salt is ${known.length}`);
    assert.match(unknown, /^[0-9a-f]+$/u, 'the decoy must look like the thing it stands in for');
  } finally {
    await database.admin.query('DELETE FROM demo_users WHERE email=$1', [address]).catch(() => {});
  }
});

// The fence lived in a function while the capability lived in a grant, so the request-serving
// role could roll the generation back, reuse an operation id, or move a terminal state anywhere.
test('RETENTION_STATE_NOT_WRITABLE_BY_REQUEST_ROLE — the fence is not reachable around the functions', async () => {
  const columns = ['retention_status', 'retention_generation', 'retention_operation_id', 'retention_lease_owner', 'retention_lease_expires_at'];
  for (const column of columns) {
    const held = (await database.admin.query(
      `SELECT has_column_privilege('openppwr_app','evidence_files',$1,'UPDATE') AS ok`, [column])).rows[0].ok;
    assert.equal(held, false, `openppwr_app can write ${column} directly`);
  }
  // Review writes remain direct and column-scoped. Scan requeue moved behind one constrained operation;
  // direct scan state is worker-only.
  for (const column of ['review_status', 'reviewed_by', 'reviewed_at', 'rejection_code']) {
    const held = (await database.admin.query(
      `SELECT has_column_privilege('openppwr_app','evidence_files',$1,'UPDATE') AS ok`, [column])).rows[0].ok;
    assert.equal(held, true, `the workflow can no longer write ${column}`);
  }
  const scanStatus = (await database.admin.query(
    `SELECT has_column_privilege('openppwr_app','evidence_files','scan_status','UPDATE') AS ok`)).rows[0].ok;
  assert.equal(scanStatus, false, 'openppwr_app can mark quarantined evidence clean');
  const scanJobUpdate = (await database.admin.query(
    `SELECT has_table_privilege('openppwr_app','scan_jobs','UPDATE') AS ok`)).rows[0].ok;
  assert.equal(scanJobUpdate, false, 'openppwr_app can rewrite arbitrary scan job state');
  const canRequeue = (await database.admin.query(
    `SELECT has_function_privilege('openppwr_app','requeue_openppwr_scan_job(uuid,timestamptz,text)','EXECUTE') AS ok`)).rows[0].ok;
  assert.equal(canRequeue, true, 'the legitimate dead-job requeue operation is unavailable');
});

test('SCAN_REQUEUE_REQUIRES_A_VERIFIED_ACTOR — direct function use cannot skip audit attribution', async () => {
  // The packaging import in `before()` creates no evidence or scan jobs by itself — a scan job exists only
  // once a requirement has a real upload against it, exactly as in production.
  const listed = await jsonRequest('/v1/evidence-requirements', { headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } });
  assert.ok(listed.body.items?.length > 0, 'the import fixture produced no evidence requirements to upload against');
  const requirement = listed.body.items[0];
  const form = new FormData();
  form.set('requirementId', requirement.id);
  form.set('supplierId', requirement.supplier_id);
  form.set('evidenceType', requirement.evidence_type);
  form.set('file', new Blob([Buffer.from('%PDF-1.4 attack fixture')], { type: 'application/pdf' }), 'declaration.pdf');
  const uploaded = await jsonRequest('/v1/evidence', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.evidence_contributor.token}` },
    body: form,
  });
  assert.equal(uploaded.response.status, 202, `upload failed: ${JSON.stringify(uploaded.body)}`);

  const selected = await database.admin.query('SELECT id,evidence_id FROM scan_jobs WHERE tenant_id=$1 AND evidence_id=$2 LIMIT 1', [victimTenant, uploaded.body.id]);
  assert.equal(selected.rowCount, 1, 'no scan job exists to exercise the requeue boundary');
  const job = selected.rows[0];
  await database.admin.query(
    `UPDATE scan_jobs SET status='dead',terminal_reason='legacy_attempts_exhausted',terminal_at=now() WHERE id=$1`,
    [job.id],
  );
  await database.admin.query(`UPDATE evidence_files SET scan_status='error' WHERE id=$1`, [job.evidence_id]);
  try {
    const outcome = await attacker(async (client) => {
      try {
        await client.query('SELECT requeue_openppwr_scan_job($1,now(),NULL)', [job.id]);
        return 'requeued without actor';
      } catch (error) {
        return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
      }
    }, { tenantId: victimTenant, actorId: identities.tenant_admin.id });
    assert.equal(outcome, 'denied by privilege');
    const unchanged = await database.admin.query(
      `SELECT j.status,e.scan_status FROM scan_jobs j JOIN evidence_files e ON e.id=j.evidence_id WHERE j.id=$1`,
      [job.id],
    );
    assert.equal(unchanged.rows[0].status, 'dead', 'failed attribution left scan job requeued');
    assert.equal(unchanged.rows[0].scan_status, 'error', 'failed attribution changed evidence state');
  } finally {
    await database.admin.query(
      `UPDATE scan_jobs SET status='pending',terminal_reason=NULL,terminal_at=NULL WHERE id=$1`, [job.id],
    );
    await database.admin.query(`UPDATE evidence_files SET scan_status='pending' WHERE id=$1`, [job.evidence_id]);
  }
});

// Critical. The append function validated the *shape* of the digests and not their content, so
// a caller supplying the correct link could attribute any action to any actor, or break verification for
// every event after it with a hash of its choosing. The caller no longer supplies a hash at all.
test('AUDIT_EVENT_ATTRIBUTION_NOT_CALLER_CHOSEN — the chain derives the actor, tenant and time', async () => {
  // The signature is the finding. Removing the caller's choice of digest while leaving its choice of actor,
  // action and timestamp changed nothing that mattered: a caller that picks who did what and when does not
  // need to pick the hash. `occurred_at` could be `infinity`, which takes verification down.
  const arguments_ = (await database.admin.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='append_openppwr_audit_event'`)).rows;
  assert.equal(arguments_.length, 1, 'exactly one append function must exist');
  assert.ok(!/timestamp with time zone/u.test(arguments_[0].args), `the caller can still choose the time: ${arguments_[0].args}`);
  assert.ok(!/uuid/u.test(arguments_[0].args), `the caller can still name an actor or tenant: ${arguments_[0].args}`);

  // A credential that does not resolve is refused, so the actor cannot simply be asserted.
  const forged = await asRole(pool, async (client) => {
    try {
      await client.query('SELECT event_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
        ['f'.repeat(64), 'assessment.completed', 'tenant', victimTenant, '{}']);
      return 'recorded';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(forged, 'denied by privilege', 'an unresolvable credential produced an audit event');

  // An action nobody registered is refused, whoever asks. The earlier version of this test appended
  // `probe.event` — an unregistered action — and so demonstrated the very hole it claimed to disprove.
  const unregistered = await asRole(pool, async (client) => {
    try {
      await client.query('SELECT event_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
        [tokenHash(identities.tenant_admin.token), 'administrator.access.approved', 'tenant', victimTenant, '{}']);
      return 'recorded';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(unregistered, 'denied by privilege', 'an unregistered action produced a valid chain entry');

  // Read inside the same transaction that wrote it: `asRole` rolls back in `finally`.
  const { appended, stored } = await asRole(pool, async (client) => {
    // The read-back is scoped by row-level security like every other read; the append derives its own
    // tenant, but the SELECT that checks it still needs a request context.
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [victimTenant]);
    const hash = (await client.query(
      'SELECT event_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
      [tokenHash(identities.tenant_admin.token), 'assessment.completed', 'tenant', victimTenant, '{}'],
    )).rows[0].event_hash;
    const row = (await client.query(
      `SELECT event_id, tenant_id, actor_id, action, entity_type, entity_id, payload, occurred_at,
              previous_hash, event_hash, hash_algorithm
         FROM audit_events WHERE event_hash=$1`, [hash])).rows[0];
    return { appended: hash, stored: row };
  });
  assert.match(appended, /^[0-9a-f]{64}$/u, 'the database must produce the digest');
  assert.ok(stored, 'the event was not written');
  assert.equal(stored.hash_algorithm, 'sql-canonical-v2');
  // Attributed to the identity whose credential was presented, not to anything the caller named.
  assert.equal(stored.actor_id, identities.tenant_admin.id);
  assert.equal(stored.tenant_id, victimTenant);
  // Action, entity and payload remain caller-supplied. Registry constrains which action names each database
  // principal may submit; it does not prove the described domain operation happened. This test asserts
  // attribution and encoding only, not semantic authenticity.
});

// `concat_ws` with a newline separator cannot distinguish a newline inside a field from the
// boundary between two, so two different events produced one digest. A chain that cannot tell them apart is
// not tamper-evident.
test('AUDIT_CANONICAL_ENCODING_INJECTIVE — no field content can imitate a boundary', async () => {
  const digest = async (action, entityType) => (await database.admin.query(
    `SELECT openppwr_audit_canonical_hash_v2($1,$2,NULL,$3,$4,'x','{}'::jsonb,$5,'GENESIS') AS hash`,
    ['00000000-0000-4000-8000-000000000001', victimTenant, action, entityType, '2026-01-01T00:00:00Z'],
  )).rows[0].hash;

  assert.notEqual(
    await digest('a\nb', 'c'), await digest('a', 'b\nc'),
    'a newline inside a field still collides with the separator between fields',
  );

  // And two events in the same millisecond stay two events.
  const atTime = async (when) => (await database.admin.query(
    `SELECT openppwr_audit_canonical_hash_v2($1,$2,NULL,'a','b','x','{}'::jsonb,$3,'GENESIS') AS hash`,
    ['00000000-0000-4000-8000-000000000001', victimTenant, when],
  )).rows[0].hash;
  assert.notEqual(
    await atTime('2026-01-01T00:00:00.000100Z'), await atTime('2026-01-01T00:00:00.000200Z'),
    'sub-millisecond timestamps collide',
  );
});

// Inside a SECURITY DEFINER function `current_user` is the *owner*, so the role check never fired
// and the maintenance principal could record any action it liked.
test('AUDIT_ACTION_SCOPED_TO_CALLING_PRINCIPAL — the maintenance credential may only record its reset', async () => {
  const outcome = await asRole(maintenancePool, async (client) => {
    try {
      // Registered for the request principal, not maintenance. Valid actor credential ensures registry
      // scoping is what rejects the call; NULL previously let credential validation satisfy this test.
      await client.query(
        'SELECT event_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
        [tokenHash(identities.tenant_admin.token), 'assessment.completed', 'assessment', randomUUID(), '{}'],
      );
      return { code: null, message: 'recorded' };
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  });
  assert.equal(outcome.code, '42501', `unexpected rejection: ${outcome.message}`);
  assert.match(outcome.message, /action assessment\.completed is not registered for openppwr_maintenance/u);
});

test('AUDIT_ACTION_REGISTRY_EQUALS_EMITTER_CENSUS — no historical literal grants append authority', async () => {
  const expected = [
    ['openppwr_app', 'assessment.completed'],
    ['openppwr_app', 'dossier.generated'],
    ['openppwr_app', 'evidence.accepted'],
    ['openppwr_app', 'evidence.quarantined'],
    ['openppwr_app', 'evidence.rejected'],
    ['openppwr_app', 'evidence.scan.requeued'],
    ['openppwr_app', 'gap.assigned'],
    ['openppwr_app', 'gap.remediated'],
    ['openppwr_app', 'import.accepted'],
    ['openppwr_app', 'import.rejected'],
    ['openppwr_app', 'review_snapshot.frozen'],
    // Migration 038. `/v1/logout` runs on the request-serving pool, and only a session that was actually
    // ended — never a second sign-out or a session already expired — produces this event.
    ['openppwr_app', 'session.revoked'],
    ['openppwr_app', 'tenant.bootstrapped'],
    // Migration 038. The only session_user a successful demonstration sign-in ever runs as.
    ['openppwr_auth', 'auth.login.succeeded'],
    // Migration 034. Registered for the credential principal, which is the only principal with a rotation
    // callsite — a principal that cannot rotate must not be able to claim a rotation happened.
    ['openppwr_auth', 'identity.credential.rotated'],
    ['openppwr_maintenance', 'demo.reset'],
    ['openppwr_maintenance', 'demo.reset.completed'],
    // Migration 035. The second principal that can rotate, and the only one a production deployment loads.
    // The registry lookup is against `session_user`, so without this row every rotation on that connection
    // would be refused and roll back the credential write with it — which is fail-closed and useless.
    ['openppwr_rotation', 'identity.credential.rotated'],
    ['openppwr_worker', 'evidence.scan.clean'],
    ['openppwr_worker', 'evidence.scan.error'],
    ['openppwr_worker', 'evidence.scan.infected'],
    ['openppwr_worker', 'evidence.scan.requires_attention'],
    ['openppwr_worker', 'evidence.scan.timeout'],
  ];
  const actual = (await database.admin.query(
    `SELECT allowed_principal, action_pattern FROM audit_action_registry
      ORDER BY allowed_principal, action_pattern`,
  )).rows.map((row) => [row.allowed_principal, row.action_pattern]);
  assert.deepEqual(actual, expected);
});

test('AUDIT_ACTIONS_WITHOUT_APPEND_EMITTERS_ARE_DENIED — valid credentials cannot revive guessed authority', async () => {
  const denied = [
    {
      principal: 'openppwr_app',
      rolePool: pool,
      credential: tokenHash(identities.tenant_admin.token),
      actions: [
        'evidence.scan.pending', 'evidence.scan.clean', 'evidence.scan.infected', 'evidence.scan.error',
        'evidence.scan.timeout', 'evidence.scan.requires_attention', 'assessment_linked', 'reopened',
        'gap.reopened', 'assigned', 'remediation_evidence_added',
      ],
    },
    {
      principal: 'openppwr_worker',
      rolePool: workerPool,
      credential: tokenHash(identities.worker.token),
      actions: ['evidence.scan.pending', 'evidence.quarantined', 'evidence.retention.deleted'],
    },
  ];

  for (const group of denied) {
    for (const action of group.actions) {
      await asRole(group.rolePool, async (client) => {
        await assert.rejects(
          () => client.query(
            'SELECT event_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
            [group.credential, action, 'evidence', randomUUID(), '{}'],
          ),
          (error) => error.code === '42501'
            && error.message === `action ${action} is not registered for ${group.principal}`,
          `${group.principal} retained guessed authority for ${action}`,
        );
      });
    }
  }
});
