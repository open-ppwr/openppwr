// Upgrading a database that is already running, rather than installing a clean one.
//
// Migrations 014, 016 and 017 change who holds what. A clean install gets the intended end state by
// construction; an upgrade only gets it if every grant made by 001–013 is explicitly taken back. A REVOKE
// that names a privilege the role no longer has is silently fine, and a grant nobody remembered to revoke is
// silently retained — so this applies 001–013, seeds the state a real deployment would hold, and then
// upgrades and asks the catalogue what survived.
//
// The failure being guarded against is a deployment that upgrades, reports success, and keeps the capability
// the upgrade existed to remove.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/migrate.mjs';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

const { Client } = pg;
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

let database;
let tenantId;

const query = async (text, values = []) => (await database.admin.query(text, values)).rows;

// Applies the migrations a pre-014 deployment would have, and records them exactly as the runner does, so
// the subsequent `migrate()` treats this as the upgrade it is rather than a fresh install.
async function installUpTo(limit) {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  const client = new Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS openppwr_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      if (Number(name.slice(0, 3)) > limit) continue;
      await client.query(await readFile(resolve(migrationDirectory, name), 'utf8'));
      await client.query('INSERT INTO openppwr_schema_migrations (name) VALUES ($1)', [name]);
    }
  } finally { await client.end(); }
}

before(async () => {
  database = await startTestDatabase('database-privilege-upgrade');
  await installUpTo(13);

  // The state a running deployment holds at 013: a tenant, identities with credentials, a live session, and
  // an evidence row mid-deletion. Each of these is something an upgrade could destroy or strand.
  tenantId = randomUUID();
  await database.admin.query('SELECT create_openppwr_tenant($1,$2,$3,$4)', [tenantId, 'acme-eu-demo', 'ACME', 'demo']);
  const identityId = randomUUID();
  await database.admin.query(
    `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash)
     VALUES ($1,$2,'existing admin','tenant_admin',NULL,$3)`,
    [tenantId, identityId, 'b'.repeat(64)],
  );
  await database.admin.query(
    `INSERT INTO auth_sessions (tenant_id,id,identity_id,token_hash,expires_at)
     VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
    [tenantId, randomUUID(), identityId, 'c'.repeat(64)],
  );
  await database.admin.query(
    `INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'ACME-SUP-001','ACME Supplier')`, [tenantId]);
  await database.admin.query(
    `INSERT INTO evidence_files
       (tenant_id,id,supplier_id,evidence_type,original_filename,normalized_filename,declared_mime,detected_mime,
        size_bytes,sha256,storage_key,scan_status,review_status,retention_status,uploaded_by)
     VALUES ($1,$2,'ACME-SUP-001','RECYCLED_CONTENT_DECLARATION','e.bin','e.bin','application/octet-stream',
        'application/octet-stream',14,repeat('a',64),$3,'infected','pending','deleting',$4)`,
    [tenantId, randomUUID(), `${tenantId}/stranded.bin`, identityId],
  );

  // The pre-014 grants really are present, or the upgrade below would prove nothing.
  const held = (await query(
    `SELECT has_table_privilege('openppwr_app','identities','INSERT') AS insert_identities,
            has_table_privilege('openppwr_app','demo_users','INSERT') AS insert_demo`))[0];
  assert.equal(held.insert_identities, true, 'the pre-upgrade state is wrong; the test would pass vacuously');
  assert.equal(held.insert_demo, true, 'the pre-upgrade state is wrong; the test would pass vacuously');

  await migrate(database.adminUrl);
});

after(async () => { await database?.stop(); });

test('the upgrade applied every migration through 017', async () => {
  const applied = (await query('SELECT name FROM openppwr_schema_migrations ORDER BY name')).map((row) => row.name);
  assert.ok(applied.some((name) => name.startsWith('017')), `017 was not applied: ${applied.at(-1)}`);
  assert.equal(applied.length, (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/u.test(name)).length);
});

test('every grant the upgrade exists to remove is gone from the request-serving role', async () => {
  for (const [table, privilege] of [
    ['identities', 'INSERT'], ['identities', 'UPDATE'],
    ['demo_users', 'INSERT'], ['demo_users', 'UPDATE'],
    ['auth_sessions', 'SELECT'], ['auth_sessions', 'INSERT'], ['auth_sessions', 'UPDATE'],
  ]) {
    const held = (await query(`SELECT has_table_privilege('openppwr_app', $1, $2) AS ok`, [table, privilege]))[0].ok;
    assert.equal(held, false, `the upgrade left openppwr_app holding ${privilege} on ${table}`);
  }
  const verifier = (await query(
    `SELECT has_column_privilege('openppwr_app','identities','token_hash','SELECT') AS ok`))[0].ok;
  assert.equal(verifier, false, 'the upgrade left the credential verifier readable');
});

// 014 granted these and 016 took them back. On an upgrade both run in the same pass, so the end state must
// be the same as a clean install — this is the check that the order of the two is not load-bearing.
test('the privileged principals end the upgrade holding EXECUTE and no table capability', async () => {
  for (const [role, table, privilege] of [
    ['openppwr_maintenance', 'packaging', 'DELETE'],
    ['openppwr_maintenance', 'packaging', 'SELECT'],
    ['openppwr_maintenance', 'evidence_files', 'DELETE'],
    ['openppwr_auth', 'auth_sessions', 'INSERT'],
    ['openppwr_auth', 'identities', 'SELECT'],
    ['openppwr_auth', 'demo_users', 'SELECT'],
  ]) {
    const held = (await query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, table, privilege]))[0].ok;
    assert.equal(held, false, `the upgrade left ${role} holding ${privilege} on ${table}`);
  }
  const reset = (await query(
    `SELECT has_function_privilege('openppwr_maintenance','reset_openppwr_demo_tenant()','EXECUTE') AS ok`))[0].ok;
  assert.equal(reset, true, 'the upgrade left the maintenance principal unable to do its job');
});

test('the upgrade reassigns definer-function ownership rather than leaving the installer credential', async () => {
  const elsewhere = await query(
    `SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner'`);
  assert.deepEqual(elsewhere, [], `functions upgraded without their owner: ${JSON.stringify(elsewhere)}`);

  const [owner] = await query(
    `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'deployment_metadata'`);
  assert.equal(owner.owner, 'openppwr_security_owner');
});

// Deployment identity is created by 014 on a database that already has a tenant. If the backfill missed it,
// the reset would refuse on a demonstration deployment and no log would say why.
test('the upgrade records deployment identity for the tenant that already existed', async () => {
  const [metadata] = await query('SELECT deployment_mode, synthetic_tenant, tenant_id FROM deployment_metadata');
  assert.equal(metadata.deployment_mode, 'production', 'an upgrade must not silently declare a running deployment a demonstration');
  assert.equal(metadata.synthetic_tenant, false);

  // The tenant predates the metadata table, so `tenant_id` is null until an operator declares the mode and
  // bootstraps — which is correct for an upgrade and must not be mistaken for a demonstration deployment.
  const resettable = await query(
    `SELECT 1 FROM deployment_metadata WHERE deployment_mode='demo' AND synthetic_tenant AND tenant_id IS NOT NULL`);
  assert.deepEqual(resettable, [], 'an upgraded production deployment must not become resettable');
});

// The existing credentials must survive. An upgrade that revokes the grants and also invalidates every
// session is a different kind of outage.
test('existing identities and sessions survive the upgrade', async () => {
  const [identity] = await query('SELECT count(*)::int AS total FROM identities WHERE tenant_id=$1', [tenantId]);
  assert.equal(identity.total, 1, 'the upgrade destroyed an existing identity');
  const [session] = await query('SELECT count(*)::int AS total FROM auth_sessions WHERE tenant_id=$1', [tenantId]);
  assert.equal(session.total, 1, 'the upgrade destroyed a live session');
});

// Migration 015 backfills rows that were mid-deletion when the deployment stopped. Returning them to
// `retained` would lose bytes sitting under the tombstone name; they must get an expired lease so the
// recovery path inspects both filenames.
test('a row left mid-deletion by the old deployment is backfilled as a reclaimable claim', async () => {
  const [row] = await query(
    `SELECT retention_status, retention_lease_owner, retention_lease_expires_at, retention_generation,
            retention_operation_id
       FROM evidence_files WHERE tenant_id=$1`, [tenantId]);
  assert.equal(row.retention_status, 'deleting', 'the backfill discarded an incomplete deletion');
  assert.ok(row.retention_lease_owner, 'a deleting row without an owner is adopted by every recovery pass');
  assert.ok(row.retention_lease_expires_at < new Date(), 'the backfilled claim must already be expired so a worker can reclaim it');
  // Migration 019 requires a positive generation on any `deleting` row, so the backfill raises it. The
  // assertion said 0 and passed only because it ran before 019 existed.
  assert.ok(row.retention_generation >= 1, `a deleting row must carry a real generation: ${row.retention_generation}`);
  assert.ok(row.retention_operation_id, 'the backfill must name the operation, or recovery cannot find the bytes');
});

test('the upgraded schema enforces the retention state machine', async () => {
  await assert.rejects(
    () => database.admin.query(
      `UPDATE evidence_files SET retention_lease_owner=NULL, retention_lease_expires_at=NULL WHERE tenant_id=$1`,
      [tenantId]),
    (error) => error.code === '23514',
    'the CHECK was added NOT VALID and never validated, so it constrains nothing',
  );
});
