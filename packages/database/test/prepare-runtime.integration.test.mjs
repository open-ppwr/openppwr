// Installer-side provisioning of the runtime database principals.
//
// Migration 014 separates the capabilities. That separation is only real once each principal has its own
// login credential, and this is the step that grants them — so it is also the step where the separation can
// be silently undone by configuration rather than by code.
//
// The failure worth guarding against is not an error. It is a deployment that sets every password to the
// same value: every grant assertion in the schema still passes, every test above the database still passes,
// and there is no separation at all.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { prepareRuntime } from '../src/prepare.mjs';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

const { Client } = pg;

let database;
let migrationUrl;

const secret = () => randomBytes(32).toString('hex');

// Each case starts from the roles as migration 014 leaves them: present, but unable to log in.
async function resetPrincipals() {
  for (const role of ['openppwr_app', 'openppwr_auth', 'openppwr_maintenance', 'openppwr_worker', 'openppwr_rotation']) {
    await database.admin.query(`ALTER ROLE ${role} NOLOGIN`);
  }
}

before(async () => {
  database = await startTestDatabase('database-prepare-runtime');
  migrationUrl = database.adminUrl;
});

after(async () => { await database?.stop(); });

test('a password reused between principals is refused', async () => {
  await resetPrincipals();
  const shared = secret();
  await assert.rejects(
    () => prepareRuntime({
      OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
      OPENPPWR_RUNTIME_DATABASE_PASSWORD: shared,
      OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
      OPENPPWR_AUTH_DATABASE_PASSWORD: shared,
    }),
    /repeats the password/u,
    'shared credentials leave the grants separated and the capability shared',
  );

  // And it is refused before anything is changed: the request role must not be left able to log in with a
  // credential the authentication role also holds.
  const [role] = (await database.admin.query(
    `SELECT rolcanlogin FROM pg_roles WHERE rolname='openppwr_app'`)).rows;
  assert.equal(role.rolcanlogin, false, 'a refused configuration must leave no principal usable');
});

test('a password shorter than the policy is refused', async () => {
  await resetPrincipals();
  await assert.rejects(
    () => prepareRuntime({
      OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
      OPENPPWR_RUNTIME_DATABASE_PASSWORD: 'short',
      OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
    }),
    /at least 32 characters/u,
  );
});

test('the request-serving principal is required and the privileged three are optional', async () => {
  await resetPrincipals();
  await assert.rejects(
    () => prepareRuntime({ OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl }),
    /OPENPPWR_RUNTIME_DATABASE_PASSWORD is required/u,
  );

  // The worker credential is required too: a deployment without one has no worker, and the retention state
  // machine would fall back to whichever role the worker connected as — which is the collapse migration 022
  // exists to prevent.
  await assert.rejects(
    () => prepareRuntime({ OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl, OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret() }),
    /OPENPPWR_WORKER_DATABASE_PASSWORD is required/u,
  );

  // Request role plus worker is the minimum production shape: no password sign-in, no reset, and no
  // credential rotation either — which is a decision an operator may take and must not take by accident, so
  // the role is retired rather than left dormant.
  const result = await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret(),
    OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
  });
  assert.deepEqual(result.configured, ['openppwr_app', 'openppwr_worker']);

  for (const role of ['openppwr_auth', 'openppwr_maintenance', 'openppwr_rotation']) {
    const [found] = (await database.admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [role])).rows;
    assert.equal(found.rolcanlogin, false, `${role} must remain unusable until an operator configures it`);
  }
});

// The shape a self-hoster actually wants: real data, no demonstration sign-in, and a supported way to
// replace a bearer token that leaked. Migration 034 shipped the rotation function; until migration 035 the
// only principal that could call it was the session-issuing one, which the API refuses to start holding — so
// this configuration was not expressible at all and every production deployment answered 404 on the route.
test('rotation is configurable without the demonstration credentials', async () => {
  await resetPrincipals();
  const rotationPassword = secret();
  const result = await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret(),
    OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
    OPENPPWR_ROTATION_DATABASE_PASSWORD: rotationPassword,
  });
  assert.deepEqual(result.configured, ['openppwr_app', 'openppwr_worker', 'openppwr_rotation']);

  for (const role of ['openppwr_auth', 'openppwr_maintenance']) {
    const [found] = (await database.admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [role])).rows;
    assert.equal(found.rolcanlogin, false, `${role} must stay retired; rotation must not drag sign-in into production with it`);
  }

  const client = new Client({ connectionString: database.urlFor('openppwr_rotation', rotationPassword) });
  await client.connect();
  try {
    const [identity] = (await client.query('SELECT current_user AS role')).rows;
    assert.equal(identity.role, 'openppwr_rotation', 'the credential must authenticate as the principal it names');
  } finally { await client.end(); }
});

test('each configured principal connects as itself and as nothing else', async () => {
  await resetPrincipals();
  const passwords = {
    openppwr_app: secret(),
    openppwr_auth: secret(),
    openppwr_maintenance: secret(),
    openppwr_worker: secret(),
  };
  const result = await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: passwords.openppwr_app,
    OPENPPWR_AUTH_DATABASE_PASSWORD: passwords.openppwr_auth,
    OPENPPWR_MAINTENANCE_DATABASE_PASSWORD: passwords.openppwr_maintenance,
    OPENPPWR_WORKER_DATABASE_PASSWORD: passwords.openppwr_worker,
  });
  assert.deepEqual(result.configured, ['openppwr_app', 'openppwr_auth', 'openppwr_maintenance', 'openppwr_worker']);

  // Built from the harness rather than assembled from a fixed database name: under the workspace runner
  // every test file gets its own database inside one shared cluster, so the name is generated.
  for (const [role, password] of Object.entries(passwords)) {
    const client = new Client({ connectionString: database.urlFor(role, password) });
    await client.connect();
    try {
      const [identity] = (await client.query('SELECT current_user AS role')).rows;
      assert.equal(identity.role, role, 'the credential must authenticate as the principal it names');
    } finally { await client.end(); }
  }

  // The credentials must not be interchangeable. A deployment that copied one password into two variables
  // would otherwise look correct from every direction except this one.
  const wrong = new Client({
    connectionString: database.urlFor('openppwr_maintenance', passwords.openppwr_app),
  });
  await assert.rejects(() => wrong.connect(), /password authentication failed/u);
  await wrong.end().catch(() => {});
});

// Provisioning claimed to be authoritative and was not: `ALTER ROLE ... LOGIN PASSWORD` sets two things and
// leaves three, so the state after a run depended on the state before it. The sharpest of the three is
// `rolconfig`, because a superuser can pin a parameter onto a role that the role is forbidden to set itself
// — measured here with `session_replication_role`, which openppwr_app's own `SET` is refused with 42501.
//
// The availability half is what makes "re-provision to repair it" untrue rather than merely untidy: before
// this, a run that reported success and named the role as configured left it unable to connect at all.
test('re-provisioning determines the role state it claims to control', async () => {
  await resetPrincipals();
  await database.admin.query(`ALTER ROLE openppwr_app SET session_replication_role = 'replica'`);
  await database.admin.query(`ALTER ROLE openppwr_app VALID UNTIL '2000-01-01'`);
  await database.admin.query(`ALTER ROLE openppwr_app CONNECTION LIMIT 0`);

  const appPassword = secret();
  await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: appPassword,
    OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
  });

  const [state] = (await database.admin.query(
    `SELECT rolconfig, rolconnlimit, rolvaliduntil < now() AS expired
       FROM pg_roles WHERE rolname='openppwr_app'`)).rows;
  assert.equal(state.rolconfig, null, 'a pinned session default must not survive the run meant to repair it');
  assert.equal(state.rolconnlimit, -1, 'a principal that may open no connections is not a configured principal');
  assert.notEqual(state.expired, true, 'an expiry in the past disables the credential this run just issued');

  // The state is only actually repaired if the credential works, which is the claim the return value makes.
  const client = new Client({ connectionString: database.urlFor('openppwr_app', appPassword) });
  await client.connect();
  try {
    const [session] = (await client.query('SHOW session_replication_role')).rows;
    assert.equal(session.session_replication_role, 'origin', 'the session must not inherit a pinned parameter');
  } finally { await client.end(); }
});

// The one piece of role state an operator may legitimately own. A provisioner that reset it unconditionally
// would silently undo a deliberate operational decision on every unrelated run, including a password
// rotation — so a positive cap is preserved and only the unusable zero is repaired.
test('a deliberate connection cap survives provisioning', async () => {
  await resetPrincipals();
  await database.admin.query('ALTER ROLE openppwr_app CONNECTION LIMIT 40');
  await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret(),
    OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
  });
  const [state] = (await database.admin.query(
    `SELECT rolconnlimit FROM pg_roles WHERE rolname='openppwr_app'`)).rows;
  assert.equal(state.rolconnlimit, 40, 'an operator cap is a decision, not drift to be overwritten');
  await database.admin.query('ALTER ROLE openppwr_app CONNECTION LIMIT -1');
});

test('provisioning refuses a principal that has acquired a cluster privilege', async () => {
  await resetPrincipals();
  await database.admin.query('ALTER ROLE openppwr_app CREATEROLE');
  try {
    await assert.rejects(
      () => prepareRuntime({
        OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
        OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret(),
      OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
      }),
      /may create roles/u,
      'a role that can create roles can grant itself anything the schema denies it',
    );
  } finally {
    await database.admin.query('ALTER ROLE openppwr_app NOCREATEROLE');
  }
});

test('provisioning refuses a principal that has been made a member of a privileged role', async () => {
  await resetPrincipals();
  await database.admin.query('GRANT openppwr_maintenance TO openppwr_app');
  try {
    await assert.rejects(
      () => prepareRuntime({
        OPENPPWR_MIGRATION_DATABASE_URL: migrationUrl,
        OPENPPWR_RUNTIME_DATABASE_PASSWORD: secret(),
      OPENPPWR_WORKER_DATABASE_PASSWORD: secret(),
      }),
      /must not be members of any role/u,
      'NOINHERIT does not prevent SET ROLE; only the absence of membership does',
    );
  } finally {
    await database.admin.query('REVOKE openppwr_maintenance FROM openppwr_app');
  }
});
