// The audit chain is per-tenant, and it stays tamper-evident.
//
// The defect this migration closes: the chain was linked globally — `append_openppwr_audit_event` and
// `complete_openppwr_retention` both took the previous hash with `ORDER BY sequence DESC LIMIT 1` and no
// tenant predicate, from inside a SECURITY DEFINER function owned by a BYPASSRLS role — while
// `verifyAuditChain` walks one tenant through row-level security starting from 'GENESIS'. Two tenants in one
// database therefore produced `valid: false` on a record nothing had touched.
//
// Migration 037 scopes the link to the tenant. What has to be true afterwards is three separate things, and
// this file keeps them apart because a fix that satisfies the first two and quietly loses the third would be
// worse than the defect:
//
//   1. Two tenants each verify valid, independently, whatever order they write in.
//   2. A chain written before the upgrade still verifies after it, and the next event written continues it.
//   3. Real tampering is still caught — by someone in the position a real tamperer must reach, which is
//      superuser with the immutability triggers disabled.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/migrate.mjs';
import { appendAudit, verifyAuditChain } from '../src/index.mjs';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

const { Pool } = pg;
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

let database;
let runtime;

// Applies the migrations a deployment at a given level would have, recorded exactly as the runner records
// them, so the subsequent `migrate()` is the upgrade it claims to be rather than a fresh install.
async function installUpTo(adminUrl, limit) {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  const client = new pg.Client({ connectionString: adminUrl });
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

// A tenant with one credentialed identity. Inserted directly rather than through `create_openppwr_tenant`,
// which refuses a second tenant — that refusal is the reason a supported deployment never reaches this
// defect, and it is also what makes the defect impossible to test through the supported path. The
// provisioning script this product ships (scripts/acme/provision-synthetic-tenant.mjs) inserts the same way.
async function seedTenant(admin, slug) {
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const token = createHash('sha256').update(`${slug}-${tenantId}`).digest('hex');
  await admin.query('INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,$3,$4)',
    [tenantId, slug, `Tenant ${slug} (fictional)`, 'Synthetic.']);
  await admin.query(
    `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash)
     VALUES ($1,$2,'chain test admin','tenant_admin',NULL,$3)`, [tenantId, actorId, token]);
  return { tenantId, actorId, token, slug };
}

// One tenant transaction as `openppwr_app`, which is NOBYPASSRLS. Everything a tenant does to the audit
// record — writing and verifying — goes through this, because the whole finding is about what is visible
// from here rather than from an administrative connection.
async function inTenant(pool, tenant, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id',$1,true), set_config('openppwr.actor_id',$2,true)`,
      [tenant.tenantId, tenant.actorId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

const write = (pool, tenant, entityId) => inTenant(pool, tenant, (client) => appendAudit(client, {
  action: 'import.accepted', entityType: 'import', entityId, payload: { entityId }, actorCredential: tenant.token,
}));

const verify = (pool, tenant) => inTenant(pool, tenant, (client) => verifyAuditChain(client));

before(async () => {
  database = await startTestDatabase('database-audit-chain-tenant-scope');
  await migrate(database.adminUrl);
  runtime = new Pool({ connectionString: database.runtimeUrl, max: 4 });
});

after(async () => {
  await runtime?.end();
  await database?.stop();
});

// ---------------------------------------------------------------------------------------------------
// 1. Two tenants, one database

test('two tenants writing alternately each verify valid on their own chain', async () => {
  const a = await seedTenant(database.admin, `alt-a-${randomUUID().slice(0, 8)}`);
  const b = await seedTenant(database.admin, `alt-b-${randomUUID().slice(0, 8)}`);

  // Alternating is the ordering that breaks *both* tenants under the pre-037 rule: each tenant's next event
  // links to the other tenant's newest. Writing them in blocks — the recovery rehearsal's ordering — only
  // breaks the second tenant, so the weaker ordering is asserted separately below.
  for (const round of [1, 2, 3]) {
    await write(runtime, a, `a-${round}`);
    await write(runtime, b, `b-${round}`);
  }

  const verifiedA = await verify(runtime, a);
  const verifiedB = await verify(runtime, b);
  assert.equal(verifiedA.valid, true, `tenant A: ${JSON.stringify(verifiedA)}`);
  assert.equal(verifiedB.valid, true, `tenant B: ${JSON.stringify(verifiedB)}`);
  assert.equal(verifiedA.count, 3);
  assert.equal(verifiedB.count, 3);
  // Two chains, not one that happens to verify twice.
  assert.notEqual(verifiedA.head, verifiedB.head);
});

test('two tenants provisioned one after the other each verify valid', async () => {
  const a = await seedTenant(database.admin, `blk-a-${randomUUID().slice(0, 8)}`);
  const b = await seedTenant(database.admin, `blk-b-${randomUUID().slice(0, 8)}`);
  for (const round of [1, 2]) await write(runtime, a, `a-${round}`);
  for (const round of [1, 2]) await write(runtime, b, `b-${round}`);

  assert.equal((await verify(runtime, a)).valid, true);
  const verifiedB = await verify(runtime, b);
  assert.equal(verifiedB.valid, true, `this is the rehearsal's exact scenario: ${JSON.stringify(verifiedB)}`);
});

test('every tenant chain starts at GENESIS and no event links into another tenant', async () => {
  // Stated over the whole table from an administrative connection, which is the only place both tenants are
  // visible at once. A per-tenant verification cannot see a cross-tenant link; it can only report the
  // symptom. This asserts the property itself.
  const grafted = await database.admin.query(`
    SELECT x.tenant_id FROM (
      SELECT DISTINCT ON (a.tenant_id) a.tenant_id, a.previous_hash
        FROM audit_events a ORDER BY a.tenant_id, a.sequence
    ) x WHERE x.previous_hash <> 'GENESIS'`);
  assert.equal(grafted.rowCount, 0, `tenant chains not starting at GENESIS: ${JSON.stringify(grafted.rows)}`);

  const crossLinked = await database.admin.query(`
    SELECT child.tenant_id AS child_tenant, parent.tenant_id AS parent_tenant, child.event_id
      FROM audit_events child
      JOIN audit_events parent ON parent.event_hash = child.previous_hash
     WHERE parent.tenant_id <> child.tenant_id`);
  assert.equal(crossLinked.rowCount, 0, `events linking across tenants: ${JSON.stringify(crossLinked.rows)}`);
});

test('a tenant with no events of its own verifies as an empty chain rather than borrowing one', async () => {
  const fresh = await seedTenant(database.admin, `empty-${randomUUID().slice(0, 8)}`);
  const verified = await verify(runtime, fresh);
  assert.deepEqual(
    { valid: verified.valid, count: verified.count, head: verified.head },
    { valid: true, count: 0, head: 'GENESIS' });

  // And its first event anchors at GENESIS even though the table is far from empty — which is the direct
  // statement of the fix, since under the old rule this event would have carried some other tenant's hash.
  const first = await write(runtime, fresh, 'first');
  assert.equal(first.previousHash, 'GENESIS');
  assert.equal((await verify(runtime, fresh)).valid, true);
});

// ---------------------------------------------------------------------------------------------------
// 2. Tampering
//
// The immutability triggers are the first line, so the test states what they refuse before stepping around
// them. Everything below runs as the cluster superuser with the triggers disabled: less than that cannot
// alter an audit row at all, and a tamper test that could not reach the rows would prove nothing about the
// hash chain.

test('the immutability triggers still refuse UPDATE, DELETE and TRUNCATE', async () => {
  const tenant = await seedTenant(database.admin, `immutable-${randomUUID().slice(0, 8)}`);
  await write(runtime, tenant, 'only');
  await assert.rejects(
    () => database.admin.query(`UPDATE audit_events SET payload='{"x":1}'::jsonb WHERE tenant_id=$1`, [tenant.tenantId]),
    /append-only/u);
  await assert.rejects(
    () => database.admin.query('DELETE FROM audit_events WHERE tenant_id=$1', [tenant.tenantId]),
    /append-only/u);
  await assert.rejects(() => database.admin.query('TRUNCATE audit_events'), /append-only/u);
});

// Disabling and restoring the guards around one edit, so a failure inside cannot leave the table mutable for
// the tests that follow.
async function withTriggersDisabled(operation) {
  await database.admin.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
  try {
    return await operation();
  } finally {
    await database.admin.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
    const enabled = await database.admin.query(`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgrelid='audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`);
    assert.deepEqual(enabled.rows.map((row) => [row.tgname, row.tgenabled]),
      [['audit_events_immutable', 'O'], ['audit_events_truncate_guard', 'O']],
      'the immutability guards were not restored');
  }
}

test('an altered payload is still detected, and only in the tenant that was altered', async () => {
  const victim = await seedTenant(database.admin, `tamper-v-${randomUUID().slice(0, 8)}`);
  const bystander = await seedTenant(database.admin, `tamper-b-${randomUUID().slice(0, 8)}`);
  for (const round of [1, 2, 3]) {
    await write(runtime, victim, `v-${round}`);
    await write(runtime, bystander, `b-${round}`);
  }
  assert.equal((await verify(runtime, victim)).valid, true, 'the pre-tamper state must be valid or this proves nothing');

  const target = (await database.admin.query(
    'SELECT event_id FROM audit_events WHERE tenant_id=$1 ORDER BY sequence OFFSET 1 LIMIT 1', [victim.tenantId])).rows[0];

  await withTriggersDisabled(async () => {
    const altered = await database.admin.query(
      `UPDATE audit_events SET payload = payload || '{"entityId":"forged"}'::jsonb
        WHERE tenant_id=$1 AND event_id=$2`, [victim.tenantId, target.event_id]);
    assert.equal(altered.rowCount, 1, 'the tamper did not land; the assertion below would pass vacuously');
  });

  const verified = await verify(runtime, victim);
  assert.equal(verified.valid, false, 'a rewritten payload was accepted as intact');
  assert.equal(verified.failedEventId, target.event_id, 'verification reported the wrong event');
  // Per-tenant chains must also mean per-tenant blast radius: one tenant's forged row is not evidence
  // against another tenant, and reporting it as such is the failure mode 037 exists to remove.
  assert.equal((await verify(runtime, bystander)).valid, true, 'a tamper in one tenant broke another tenant');
});

test('a removed event is still detected, because the GENESIS anchor is not negotiable', async () => {
  const tenant = await seedTenant(database.admin, `excise-${randomUUID().slice(0, 8)}`);
  for (const round of [1, 2, 3]) await write(runtime, tenant, `e-${round}`);
  assert.equal((await verify(runtime, tenant)).valid, true);

  const first = (await database.admin.query(
    'SELECT event_id FROM audit_events WHERE tenant_id=$1 ORDER BY sequence LIMIT 1', [tenant.tenantId])).rows[0];
  await withTriggersDisabled(async () => {
    const removed = await database.admin.query('DELETE FROM audit_events WHERE tenant_id=$1 AND event_id=$2',
      [tenant.tenantId, first.event_id]);
    assert.equal(removed.rowCount, 1);
  });

  const verified = await verify(runtime, tenant);
  assert.equal(verified.valid, false, 'excising the first event left a chain that still verifies');
  assert.equal(verified.count, 2);
});

test('a re-hashed forgery is still detected, because the link to the tenant tail is not re-derived', async () => {
  // The strongest tamper available without the chain's own writer: recompute the row's hash so it is
  // internally consistent with the forged payload. It still breaks, because the *next* event's previous_hash
  // was computed over the original. A control that survived only the careless tamper would not be a control.
  const tenant = await seedTenant(database.admin, `rehash-${randomUUID().slice(0, 8)}`);
  for (const round of [1, 2, 3]) await write(runtime, tenant, `r-${round}`);

  const row = (await database.admin.query(
    `SELECT event_id, actor_id, action, entity_type, entity_id, occurred_at::text AS occurred_at, previous_hash
       FROM audit_events WHERE tenant_id=$1 ORDER BY sequence LIMIT 1`, [tenant.tenantId])).rows[0];
  const forged = { entityId: 'forged' };
  const rehashed = (await database.admin.query(
    'SELECT openppwr_audit_canonical_hash_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS hash',
    [row.event_id, tenant.tenantId, row.actor_id, row.action, row.entity_type, row.entity_id,
      JSON.stringify(forged), row.occurred_at, row.previous_hash])).rows[0].hash;

  await withTriggersDisabled(async () => {
    const altered = await database.admin.query(
      'UPDATE audit_events SET payload=$3::jsonb, event_hash=$4 WHERE tenant_id=$1 AND event_id=$2',
      [tenant.tenantId, row.event_id, JSON.stringify(forged), rehashed]);
    assert.equal(altered.rowCount, 1);
  });

  const verified = await verify(runtime, tenant);
  assert.equal(verified.valid, false, 'a self-consistent forgery was accepted as intact');
  // Reported at the *following* event: the forged row now hashes correctly on its own, and it is the link
  // its successor recorded that no longer matches.
  const second = (await database.admin.query(
    'SELECT event_id FROM audit_events WHERE tenant_id=$1 ORDER BY sequence OFFSET 1 LIMIT 1', [tenant.tenantId])).rows[0];
  assert.equal(verified.failedEventId, second.event_id);
});

// ---------------------------------------------------------------------------------------------------
// 3. Upgrading a database that already holds a chain
//
// These run against their own databases, because the level a database is migrated to is a property of the
// database. Each one is installed at 036 — the last migration before this one — written to as a running
// deployment would write, and then upgraded.

test('a single-tenant chain written before 037 still verifies after it, and continues across the upgrade', async () => {
  const upgraded = await startTestDatabase('database-audit-chain-upgrade-one');
  const pool = new Pool({ connectionString: upgraded.runtimeUrl, max: 2 });
  try {
    await installUpTo(upgraded.adminUrl, 36);
    const tenant = await seedTenant(upgraded.admin, 'upgrade-one');
    for (const round of [1, 2, 3]) await write(pool, tenant, `pre-${round}`);

    const before036 = await verify(pool, tenant);
    assert.equal(before036.valid, true, 'the pre-upgrade chain must be valid or the test proves nothing');
    assert.equal(before036.count, 3);

    const rowsBefore = (await upgraded.admin.query(
      'SELECT event_id, previous_hash, event_hash FROM audit_events ORDER BY sequence')).rows;

    await migrate(upgraded.adminUrl);
    const applied = (await upgraded.admin.query(
      'SELECT name FROM openppwr_schema_migrations ORDER BY name DESC LIMIT 1')).rows[0].name;
    // At least 037 — the migration this test is about — rather than exactly it, so a later migration
    // added after this test was written does not make it start failing for a reason it does not test.
    const appliedLevel = Number.parseInt(/^(\d+)/u.exec(applied)?.[1] ?? '0', 10);
    assert.ok(appliedLevel >= 37, `the upgrade did not reach at least 037: ${applied}`);

    // Nothing was rewritten. Every hash and every link is the byte the deployment wrote before the upgrade.
    const rowsAfter = (await upgraded.admin.query(
      'SELECT event_id, previous_hash, event_hash FROM audit_events ORDER BY sequence')).rows;
    assert.deepEqual(rowsAfter, rowsBefore, 'migration 037 altered rows that were already written');

    const after037 = await verify(pool, tenant);
    assert.deepEqual(
      { valid: after037.valid, count: after037.count, head: after037.head },
      { valid: before036.valid, count: before036.count, head: before036.head },
      'the existing chain does not verify identically after the upgrade');

    // And the chain continues rather than restarting: the first event written after the upgrade carries the
    // pre-upgrade head. A migration that re-anchored the tenant at GENESIS would pass every check above and
    // fail this one.
    const continued = await write(pool, tenant, 'post-1');
    assert.equal(continued.previousHash, before036.head,
      'the first post-upgrade event did not link to the pre-upgrade head');
    const final = await verify(pool, tenant);
    assert.equal(final.valid, true);
    assert.equal(final.count, 4);
  } finally {
    await pool.end();
    await upgraded.stop();
  }
});

test('upgrading a database whose chains were already grafted neither repairs nor worsens them', async () => {
  const upgraded = await startTestDatabase('database-audit-chain-upgrade-two');
  const pool = new Pool({ connectionString: upgraded.runtimeUrl, max: 2 });
  try {
    await installUpTo(upgraded.adminUrl, 36);
    const a = await seedTenant(upgraded.admin, 'grafted-a');
    const b = await seedTenant(upgraded.admin, 'grafted-b');
    for (const round of [1, 2]) await write(pool, a, `a-${round}`);
    for (const round of [1, 2]) await write(pool, b, `b-${round}`);

    // The defect, reproduced at 036 inside the test that is about to close it.
    assert.equal((await verify(pool, a)).valid, true, 'the first tenant should verify even under the old rule');
    const brokenB = await verify(pool, b);
    assert.equal(brokenB.valid, false, 'the cross-tenant graft did not reproduce at migration level 036');
    const bFirst = (await upgraded.admin.query(
      'SELECT event_id, previous_hash FROM audit_events WHERE tenant_id=$1 ORDER BY sequence LIMIT 1', [b.tenantId])).rows[0];
    assert.equal(brokenB.failedEventId, bFirst.event_id);
    const aHead = (await upgraded.admin.query(
      'SELECT event_hash FROM audit_events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 1', [a.tenantId])).rows[0].event_hash;
    assert.equal(bFirst.previous_hash, aHead, 'the second tenant should have been grafted onto the first');

    await migrate(upgraded.adminUrl);

    // The first tenant is untouched: its chain was always its own, and it stays valid.
    assert.equal((await verify(pool, a)).valid, true, 'the upgrade broke a chain that was verifying');

    // The second tenant's grafted history is immutable and stays exactly as broken as it was. Reporting it
    // as repaired would mean having rewritten an audit record, which is the one thing this must not do.
    const stillBroken = await verify(pool, b);
    assert.equal(stillBroken.valid, false);
    assert.equal(stillBroken.failedEventId, bFirst.event_id, 'the historical break moved, so rows were rewritten');

    // Nothing further is grafted. Both tenants' next events link within their own chain.
    const nextA = await write(pool, a, 'a-post');
    const nextB = await write(pool, b, 'b-post');
    assert.equal(nextA.previousHash, aHead);
    const bHead = (await upgraded.admin.query(
      `SELECT event_hash FROM audit_events WHERE tenant_id=$1 AND event_id<>$2 ORDER BY sequence DESC LIMIT 1`,
      [b.tenantId, nextB.eventId])).rows[0].event_hash;
    assert.equal(nextB.previousHash, bHead, 'a post-upgrade event was still grafted across tenants');
    assert.equal((await verify(pool, a)).valid, true);

    // And a tenant created after the upgrade gets a clean chain of its own, in a database that is anything
    // but empty. This is what a demonstration stack gains from the upgrade.
    const c = await seedTenant(upgraded.admin, 'grafted-c');
    const firstC = await write(pool, c, 'c-1');
    assert.equal(firstC.previousHash, 'GENESIS');
    await write(pool, c, 'c-2');
    const verifiedC = await verify(pool, c);
    assert.equal(verifiedC.valid, true, JSON.stringify(verifiedC));
    assert.equal(verifiedC.count, 2);
  } finally {
    await pool.end();
    await upgraded.stop();
  }
});

// ---------------------------------------------------------------------------------------------------
// 4. The seam the fix is built on

test('no runtime principal can ask for a chain head, and no function links without one', async () => {
  for (const role of ['public', 'openppwr_app', 'openppwr_auth', 'openppwr_worker', 'openppwr_maintenance', 'openppwr_rotation']) {
    const held = (await database.admin.query(
      `SELECT has_function_privilege($1,'openppwr_audit_chain_head(uuid)','EXECUTE') AS ok`, [role])).rows[0].ok;
    assert.equal(held, false, `${role} can read an arbitrary tenant's chain head`);
  }

  // The catalogue, not a list kept by hand. `complete_openppwr_retention` writes its audit row inline rather
  // than through the generic append and carried its own copy of the unscoped selection; enumerating this way
  // is what stops the next such function from being missed.
  const unscoped = await database.admin.query(`
    SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.prosrc LIKE '%INSERT INTO audit_events%'
       AND p.prosrc NOT LIKE '%openppwr_audit_chain_head%'`);
  assert.equal(unscoped.rowCount, 0, `functions still linking globally: ${JSON.stringify(unscoped.rows)}`);

  // Both known writers are accounted for, so the check above cannot pass by matching nothing.
  const writers = await database.admin.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.prosrc LIKE '%INSERT INTO audit_events%' ORDER BY p.proname`);
  assert.deepEqual(writers.rows.map((row) => row.proname),
    ['append_openppwr_audit_event', 'complete_openppwr_retention']);
});
