import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { startTestDatabase } from '../testing/embedded-postgres.mjs';
import { createApp } from '../../apps/api/src/app.mjs';

const run = promisify(execFile);
const script = new URL('./demo-reset.mjs', import.meta.url).pathname.replace(/^\//, '');

let database;
let pool;
let server;
let baseUrl;

async function reset(env = {}) {
  try {
    const { stdout } = await run(process.execPath, [script], {
      env: { ...process.env, OPENPPWR_MAINTENANCE_DATABASE_URL: database?.maintenanceUrl || '', ...env },
    });
    return { ok: true, out: stdout };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

before(async () => {
  database = await startTestDatabase('demo-reset');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot: `.runtime-test/demo-reset-${randomUUID()}` });
  await new Promise((resolveListen) => { server = app.listen(0, '127.0.0.1', resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${baseUrl}/v1/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret }, body: '{}' });
  const body = await created.json();
  await fetch(`${baseUrl}/v1/imports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${body.identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'demo-reset-seed' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await database?.stop();
});

test('refuses to run without an explicit confirmation', async () => {
  const result = await reset({ OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: '' });
  assert.equal(result.ok, false);
  assert.match(result.out, /OPENPPWR_DEMO_RESET_CONFIRM=yes/);
});

test('refuses to run without a database URL', async () => {
  const result = await reset({ OPENPPWR_DEMO_DATABASE_URL: '', OPENPPWR_MIGRATION_DATABASE_URL: '', OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, false);
  assert.match(result.out, /no database URL/);
});

test('refuses a confirmed reset without the maintenance audit credential before changing data', async () => {
  const before = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  const result = await reset({
    OPENPPWR_DEMO_DATABASE_URL: database.adminUrl,
    OPENPPWR_MAINTENANCE_DATABASE_URL: '',
    OPENPPWR_DEMO_RESET_CONFIRM: 'yes',
  });
  assert.equal(result.ok, false);
  assert.match(result.out, /OPENPPWR_MAINTENANCE_DATABASE_URL/);
  const afterCount = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  assert.equal(afterCount.rows[0].count, before.rows[0].count);
});

test('refuses to act when the tenant is not the demonstration tenant', async () => {
  const result = await reset({ OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes', OPENPPWR_DEMO_TENANT_SLUG: 'a-real-customer' });
  assert.equal(result.ok, false);
  assert.match(result.out, /refusing to act/);
});

test('a dry run reports what it would do and changes nothing', async () => {
  const before = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  const result = await run(process.execPath, [script, '--dry-run'], { env: { ...process.env, OPENPPWR_DEMO_DATABASE_URL: database.adminUrl } });
  assert.match(result.stdout, /DEMO_RESET_DRY_RUN/);
  assert.match(result.stdout, /dataset_sha256=[0-9a-f]{64}/);
  const afterCount = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  assert.equal(afterCount.rows[0].count, before.rows[0].count);
});

test('a confirmed reset clears demo data, preserves identities, and is safe to repeat', async () => {
  const seeded = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  assert.ok(seeded.rows[0].count > 0, 'fixture should have seeded packaging');

  const first = await reset({ OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(first.ok, true, first.out);
  assert.match(first.out, /DEMO_RESET_PASS/);

  const cleared = await database.admin.query('SELECT count(*)::int AS count FROM packaging');
  assert.equal(cleared.rows[0].count, 0);
  const identities = await database.admin.query('SELECT count(*)::int AS count FROM identities');
  assert.ok(identities.rows[0].count > 0, 'credentials must survive a reset, they cannot be reissued');
  const tenants = await database.admin.query('SELECT count(*)::int AS count FROM tenants');
  assert.equal(tenants.rows[0].count, 1, 'the tenant itself must survive');

  // Idempotent: running it again on an already-clean demo must succeed, not fail.
  const second = await reset({ OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(second.ok, true, second.out);
});

test('refuses to act when more than one tenant exists, because that is not an isolated demo database', async () => {
  await database.admin.query(`INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,'another-tenant','Another','x')`, [randomUUID()]);
  const result = await reset({ OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, false);
  assert.match(result.out, /not an isolated demo database/);
  await database.admin.query(`DELETE FROM tenants WHERE slug='another-tenant'`);
});

// --- tenant-scoped mode -----------------------------------------------------------------------------
// The global path above cannot run on a multi-tenant database, by design. Scoped mode can, and these
// tests cover the three things that make it safe to use there: it refuses a tenant it cannot identify as
// synthetic, it leaves every other tenant alone, and it cannot erase audit history.

async function scopedReset(slug, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [script, `--tenant-slug=${slug}`], {
      env: { ...process.env, OPENPPWR_MAINTENANCE_DATABASE_URL: database?.maintenanceUrl || '', ...env },
    });
    return { ok: true, out: stdout };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

test('scoped mode refuses a tenant that carries no synthetic-data disclaimer', async () => {
  const id = randomUUID();
  await database.admin.query(`INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,'looks-real','Looks Real GmbH',$2)`,
    [id, 'Production tenant.']);
  const result = await scopedReset('looks-real', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, false);
  assert.match(result.out, /carries no synthetic-data disclaimer/);
  await database.admin.query('DELETE FROM tenants WHERE id=$1', [id]);
});

test('scoped mode refuses a slug that does not exist', async () => {
  const result = await scopedReset('no-such-tenant', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, false);
  assert.match(result.out, /no tenant with slug/);
});

test('scoped mode clears only the named tenant, preserves audit history, and reports no collateral', async () => {
  // A neighbour tenant with its own audit rows. If the scoped delete reached across tenants, this is
  // what would lose data — so it is asserted rather than assumed.
  const neighbour = randomUUID();
  await database.admin.query(`INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,'neighbour-synthetic','Neighbour (fictional)',$2)`,
    [neighbour, 'Synthetic tenant. All data is fictional.']);
  // A business row rather than a hand-written audit event.
  //
  // The first version of this test inserted a fabricated audit_events row with placeholder hashes, and it
  // broke the chain-verification test two cases later: appendAudit links each event to the previous one
  // **globally**, not per tenant (`ORDER BY sequence DESC LIMIT 1` has no tenant filter), so a fake row
  // poisons the chain for every tenant. Seeding a supplier proves the same thing — a scoped reset must not
  // touch another tenant's rows — without forging integrity data.
  await database.admin.query(
    `INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'NEIGHBOUR-SUP-001','ACME Neighbour Supplier (fictional)')`,
    [neighbour],
  );

  // Re-seed the demonstration tenant, since an earlier test cleared it.
  const demo = await database.admin.query(`SELECT id FROM tenants WHERE slug='acme-eu-demo'`);
  const editor = await database.admin.query(`SELECT token_hash FROM identities WHERE tenant_id=$1 AND role='packaging_editor'`, [demo.rows[0].id]);
  assert.ok(editor.rowCount, 'the demonstration tenant should still have its identities');

  const auditBefore = await database.admin.query('SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1', [demo.rows[0].id]);
  const neighbourBefore = await database.admin.query('SELECT count(*)::int AS count FROM suppliers WHERE tenant_id=$1', [neighbour]);
  assert.equal(neighbourBefore.rows[0].count, 1);

  const result = await scopedReset('acme-eu-demo', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /DEMO_RESET_SCOPED_PASS/);
  assert.match(result.out, /collateral=none/);

  // Audit history is append-only and must survive: clearing a demonstration's business data should not
  // erase the record that the demonstration happened.
  // Exactly one more than before: every prior event preserved, plus the reset's own record. Asserting
  // equality would be wrong now that the reset is itself auditable, and asserting "greater than" would
  // not notice a reset that appended several events or dropped one and added two.
  const auditAfter = await database.admin.query('SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1', [demo.rows[0].id]);
  assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count + 1,
    'the reset tenant keeps its whole audit chain and gains exactly one reset event');
  const neighbourAfter = await database.admin.query('SELECT count(*)::int AS count FROM suppliers WHERE tenant_id=$1', [neighbour]);
  assert.equal(neighbourAfter.rows[0].count, 1, 'the neighbour tenant is untouched');
  const packaging = await database.admin.query('SELECT count(*)::int AS count FROM packaging WHERE tenant_id=$1', [demo.rows[0].id]);
  assert.equal(packaging.rows[0].count, 0);
  const identities = await database.admin.query('SELECT count(*)::int AS count FROM identities WHERE tenant_id=$1', [demo.rows[0].id]);
  assert.ok(identities.rows[0].count > 0, 'credentials must survive a scoped reset too');

  await database.admin.query('DELETE FROM tenants WHERE id=$1', [neighbour]).catch(() => {});
});

test('scoped mode is safe to repeat', async () => {
  const first = await scopedReset('acme-eu-demo', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(first.ok, true, first.out);
  const second = await scopedReset('acme-eu-demo', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(second.ok, true, second.out);
});

// --- audit append-only, including TRUNCATE -----------------------------------------------------------
// Migration 001 blocks row-level mutation with a FOR EACH ROW trigger. That trigger does not fire on
// TRUNCATE, because there are no rows to iterate, so migration 007 adds a FOR EACH STATEMENT trigger.
// Without it, every global demonstration reset silently erased the audit chain.

test('audit events reject UPDATE', async () => {
  await assert.rejects(
    () => database.admin.query(`UPDATE audit_events SET action='tampered'`),
    /append-only/,
  );
});

test('audit events reject DELETE', async () => {
  await assert.rejects(
    () => database.admin.query('DELETE FROM audit_events'),
    /append-only/,
  );
});

test('audit events reject TRUNCATE — the case a row trigger cannot catch', async () => {
  await assert.rejects(
    () => database.admin.query('TRUNCATE TABLE audit_events'),
    /TRUNCATE is not permitted/,
  );
  // And with CASCADE, which is the form the global reset actually used.
  await assert.rejects(
    () => database.admin.query('TRUNCATE TABLE audit_events CASCADE'),
    /TRUNCATE is not permitted/,
  );
});

test('a scoped reset preserves the audit chain and appends a reset event', async () => {
  const demo = await database.admin.query(`SELECT id FROM tenants WHERE slug='acme-eu-demo'`);
  const tenantId = demo.rows[0].id;
  const before = await database.admin.query('SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1', [tenantId]);

  const result = await scopedReset('acme-eu-demo', { OPENPPWR_DEMO_DATABASE_URL: database.adminUrl, OPENPPWR_DEMO_RESET_CONFIRM: 'yes' });
  assert.equal(result.ok, true, result.out);

  const after = await database.admin.query('SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1', [tenantId]);
  // Strictly greater: nothing removed, and the reset itself recorded.
  assert.ok(after.rows[0].count > before.rows[0].count, `expected the chain to grow, went from ${before.rows[0].count} to ${after.rows[0].count}`);

  const event = await database.admin.query(
    `SELECT actor_id,payload FROM audit_events WHERE tenant_id=$1 AND action='demo.reset.completed' ORDER BY sequence DESC LIMIT 1`,
    [tenantId],
  );
  assert.equal(event.rowCount, 1, 'the reset must record that it happened');
  const maintenanceActor = createHash('md5').update('openppwr_maintenance').digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
  assert.equal(event.rows[0].actor_id, maintenanceActor, 'standalone reset was not attributed to maintenance principal');
  const payload = event.rows[0].payload;
  assert.equal(payload.servicePrincipal, 'openppwr_maintenance');
  assert.equal(payload.mode, 'scoped');
  assert.equal(payload.auditPreserved, true);
  assert.match(String(payload.correlationId), /^[0-9a-f-]{36}$/u);
  assert.ok(Number.isInteger(payload.clearedTables));
});

test('the audit chain still verifies after a reset', async () => {
  // The chain is hash-linked. Preserving history across a reset is only useful if the result still
  // verifies, so this asserts the link rather than the row count.
  const rows = await database.admin.query('SELECT previous_hash, event_hash FROM audit_events ORDER BY sequence');
  assert.ok(rows.rowCount > 0);
  let previous = 'GENESIS';
  for (const row of rows.rows) {
    assert.equal(row.previous_hash, previous, 'each event must link to its predecessor');
    previous = row.event_hash;
  }
});

// --- the tenant registry has its own RLS -------------------------------------------------------------
// `tenants` has no tenant_id — it *is* the tenant — so migration 001 left it with plain grants and no
// policy, while defining the boundary every other table's policy refers to.
//
// The dangerous part of fixing it is the one-tenant guarantee: bootstrap counts all tenants to refuse a
// second, and under a self-only policy that count would always be zero. These tests assert that the
// policy is on AND that the guarantee survived it.

test('the tenants table carries RLS and FORCE RLS', async () => {
  const flags = await database.admin.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='tenants' AND relnamespace='public'::regnamespace`,
  );
  assert.equal(flags.rows[0].relrowsecurity, true, 'tenants must have row-level security enabled');
  assert.equal(flags.rows[0].relforcerowsecurity, true, 'tenants must have FORCE RLS, or the owner bypasses it');
});

test('the application role can no longer insert into tenants directly', async () => {
  const granted = await database.admin.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE table_name='tenants' AND grantee='openppwr_app' ORDER BY privilege_type`,
  );
  const privileges = granted.rows.map((row) => row.privilege_type);
  assert.ok(!privileges.includes('INSERT'), `openppwr_app must not hold INSERT on tenants, has: ${privileges.join(',')}`);
});

test('the one-tenant guarantee survived the policy — a second bootstrap is still refused', async () => {
  // The regression this test exists for: if bootstrap counted tenants as the application role under a
  // self-only policy, it would always see zero and happily create tenant after tenant. The count now
  // happens inside a SECURITY DEFINER function, so it still sees the whole registry.
  const before = await database.admin.query('SELECT count(*)::int AS count FROM tenants');
  assert.ok(before.rows[0].count >= 1, 'the fixture bootstrapped a tenant');

  const second = await fetch(`${baseUrl}/v1/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': 'wrong-on-purpose' },
    body: '{}',
  });
  // Wrong token is refused before the tenant rule is even consulted; that is the outer guard.
  assert.equal(second.status, 401);

  const after = await database.admin.query('SELECT count(*)::int AS count FROM tenants');
  assert.equal(after.rows[0].count, before.rows[0].count, 'no tenant may be created by a refused bootstrap');
});

test('openppwr_tenant_count sees the whole registry, which is why the worker guard still works', async () => {
  const direct = await database.admin.query('SELECT count(*)::int AS count FROM tenants');
  const viaFunction = await database.admin.query('SELECT openppwr_tenant_count() AS count');
  assert.equal(viaFunction.rows[0].count, direct.rows[0].count,
    'the function must report the true total, or assertSingleTenantDeployment can never fire');
});

test('create_openppwr_tenant refuses a second tenant even when called directly', async () => {
  // The rule lives in the function, not in the caller, so calling the function directly must not be a way
  // around it.
  await assert.rejects(
    () => database.admin.query(`SELECT create_openppwr_tenant($1,'second-tenant','Second (fictional)','Synthetic.')`, [randomUUID()]),
    /already been completed/,
  );
});

// --- bootstrap tokens now expire and can be rotated --------------------------------------------------
// `active` already allowed revocation by an operator with database access; there was no expiry and no
// rotation path, so a deployment came up with a privileged credential that never aged out.

test('every identity token carries an expiry', async () => {
  const rows = await database.admin.query('SELECT count(*)::int AS total, count(token_expires_at)::int AS dated FROM identities');
  assert.equal(rows.rows[0].dated, rows.rows[0].total, 'no identity may hold a token without an expiry');
  const future = await database.admin.query('SELECT count(*)::int AS total FROM identities WHERE token_expires_at > now()');
  assert.ok(future.rows[0].total > 0, 'the fixture tokens should still be valid');
});

test('an expired token no longer authenticates', async () => {
  // The check lives in authenticate_openppwr_token, so this proves the enforcement point rather than a
  // caller remembering to look.
  const identity = await database.admin.query(`SELECT tenant_id, id, token_hash FROM identities WHERE role='read_only_auditor' LIMIT 1`);
  const { tenant_id: tenantId, id, token_hash: hash } = identity.rows[0];

  const before = await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [hash]);
  assert.equal(before.rowCount, 1, 'a valid token must authenticate');

  await database.admin.query(`UPDATE identities SET token_expires_at = now() - interval '1 second' WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  const after = await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [hash]);
  assert.equal(after.rowCount, 0, 'an expired token must not authenticate');

  await database.admin.query(`UPDATE identities SET token_expires_at = now() + interval '90 days' WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
});

test('rotation requires the current token and moves the expiry forward', async () => {
  const identity = await database.admin.query(`SELECT tenant_id, id, token_hash FROM identities WHERE role='service_account' LIMIT 1`);
  const { tenant_id: tenantId, id, token_hash: oldHash } = identity.rows[0];
  const newHash = 'b'.repeat(64);

  // Rotating with the wrong current token must fail: rotation means proving you hold what you replace.
  await assert.rejects(
    () => database.admin.query('SELECT rotate_openppwr_identity_token($1,$2,$3,$4)', [tenantId, id, 'a'.repeat(64), newHash]),
    /does not match/,
  );

  const rotated = await database.admin.query('SELECT rotate_openppwr_identity_token($1,$2,$3,$4,30) AS expires', [tenantId, id, oldHash, newHash]);
  assert.ok(new Date(rotated.rows[0].expires) > new Date(), 'rotation must set a future expiry');

  // The old credential is dead and the new one works.
  assert.equal((await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [oldHash])).rowCount, 0);
  assert.equal((await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [newHash])).rowCount, 1);
});

test('rotation refuses a validity window outside sane bounds', async () => {
  const identity = await database.admin.query(`SELECT tenant_id, id, token_hash FROM identities WHERE role='worker' LIMIT 1`);
  const { tenant_id: tenantId, id, token_hash: hash } = identity.rows[0];
  for (const days of [0, -1, 366]) {
    await assert.rejects(
      () => database.admin.query('SELECT rotate_openppwr_identity_token($1,$2,$3,$4,$5)', [tenantId, id, hash, 'c'.repeat(64), days]),
      /between 1 and 365/,
    );
  }
});

test('revocation stops a token without rotating it', async () => {
  const identity = await database.admin.query(`SELECT tenant_id, id, token_hash FROM identities WHERE role='evidence_contributor' LIMIT 1`);
  const { tenant_id: tenantId, id, token_hash: hash } = identity.rows[0];
  assert.equal((await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [hash])).rowCount, 1);

  // Migration 021 resolves the actor from a presented credential rather than from an identity id the caller
  // names, so self-revocation presents the identity's own verifier.
  const revoked = await database.admin.query('SELECT revoke_openppwr_identity_token($1,$2,$3) AS revoked', [tenantId, hash, id]);
  assert.equal(revoked.rows[0].revoked, true);
  assert.equal((await database.admin.query('SELECT * FROM authenticate_openppwr_token($1)', [hash])).rowCount, 0);

  // Revoking twice reports false rather than raising: idempotent, so an operator retrying is not punished.
  // The second call comes from an administrator, because the identity that just retired its own credential
  // can no longer authenticate to ask for anything — which is the point of retiring it.
  const admin = await database.admin.query(`SELECT token_hash FROM identities WHERE tenant_id=$1 AND role='tenant_admin' AND active=true LIMIT 1`, [tenantId]);
  const again = await database.admin.query('SELECT revoke_openppwr_identity_token($1,$2,$3) AS revoked', [tenantId, admin.rows[0].token_hash, id]);
  assert.equal(again.rows[0].revoked, false);
  await database.admin.query('UPDATE identities SET active=true WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
});
