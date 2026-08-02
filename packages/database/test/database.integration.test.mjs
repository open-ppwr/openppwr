import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createPool, prepareRuntime, withTenantTransaction } from '../src/index.mjs';

let database;
let pool;

before(async () => {
  database = await startTestDatabase('database-integration');
  const preparedPassword = randomUUID();
  await prepareRuntime({
    OPENPPWR_MIGRATION_DATABASE_URL: database.adminUrl,
    OPENPPWR_RUNTIME_DATABASE_PASSWORD: preparedPassword,
    OPENPPWR_WORKER_DATABASE_PASSWORD: randomUUID(),
  });
  pool = createPool(database.runtimeUrlFor(preparedPassword));
});

after(async () => {
  await pool?.end();
  await database?.stop();
});

test('FORCE RLS denies cross-tenant reads and writes', async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  await database.admin.query(
    `INSERT INTO tenants (id, slug, name, disclaimer) VALUES ($1, 'tenant-a', 'Tenant A', 'synthetic'), ($2, 'tenant-b', 'Tenant B', 'synthetic')`,
    [tenantA, tenantB],
  );
  await withTenantTransaction(pool, { tenantId: tenantA, actorId: randomUUID() }, async (client) => {
    await client.query(`INSERT INTO suppliers (tenant_id, id, name) VALUES ($1, 'SUP-A', 'Supplier A')`, [tenantA]);
  });
  const visible = await withTenantTransaction(pool, { tenantId: tenantB, actorId: randomUUID() }, async (client) => client.query('SELECT id FROM suppliers'));
  assert.deepEqual(visible.rows, []);
  await assert.rejects(
    withTenantTransaction(pool, { tenantId: tenantB, actorId: randomUUID() }, async (client) => {
      await client.query(`INSERT INTO suppliers (tenant_id, id, name) VALUES ($1, 'SUP-X', 'Supplier X')`, [tenantA]);
    }),
    /row-level security policy/,
  );
});

test('runtime role remains least privilege after automated preparation', async () => {
  const role = await database.admin.query("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname='openppwr_app'");
  assert.deepEqual(role.rows[0], { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false });
  await assert.rejects(prepareRuntime({ OPENPPWR_MIGRATION_DATABASE_URL: database.adminUrl, OPENPPWR_RUNTIME_DATABASE_PASSWORD: 'weak' }), /at least 32/);
});
