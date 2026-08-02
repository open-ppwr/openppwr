// The API and the worker are two services with two jobs, and one database identity.
//
// Migration 021 moved the retention state machine behind six SECURITY DEFINER functions so that no role
// could write the fence directly — and then granted those functions to `openppwr_app`. The worker runs as
// `openppwr_app`. So does the API. `deploy/community/docker-compose.yml` gives both services the same
// `OPENPPWR_DATABASE_URL`.
//
// The capability left through a table grant and came back as an EXECUTE grant: the remediation added reach
// that had not existed before, which is a regression wearing a fix's clothes.
//
// These tests connect as the real roles and ask what each can do. They are written before the fix and are
// expected to fail at the commit that introduces them — a boundary whose absence cannot be demonstrated is
// a boundary nobody can check.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { endPool } from '../../../scripts/testing/bounded-teardown.mjs';

let database;
let apiPool;
let workerPool;
let tenantId;
let evidenceId;

const admin = (text, values = []) => database.admin.query(text, values);

// Runs a statement as a given pool and reports what happened, never leaving the connection in an aborted
// transaction — the harness defect this programme has produced four times.
async function attempt(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const outcomeOf = async (pool, sql, values = []) => attempt(pool, async (client) => {
  try { await client.query(sql, values); return 'permitted'; }
  catch (error) { return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`; }
});

before(async () => {
  database = await startTestDatabase('worker-principal-separation');
  await migrate(database.adminUrl);
  apiPool = createPool(database.runtimeUrl);
  // No `|| database.runtimeUrl` fallback. It was written when the worker had no credential of its own, and
  // migration 022 has since given it one — but a fallback outliving its reason is how a boundary test goes
  // quietly vacuous: with both pools on `openppwr_app`, every `WORKER_CANNOT_*` assertion below still reads
  // "denied by privilege", because the API is denied those functions too. The suite would pass while
  // proving nothing. A missing `workerUrl` must break the harness loudly, not soften the test.
  if (!database.workerUrl) throw new Error('The test harness exposes no workerUrl; this suite cannot separate two principals it cannot connect as.');
  workerPool = createPool(database.workerUrl);

  tenantId = randomUUID();
  await admin('SELECT create_openppwr_tenant($1,$2,$3,$4)', [tenantId, 'acme-eu-demo', 'ACME', 'demo']);
  const workerIdentity = randomUUID();
  await admin('SELECT bootstrap_openppwr_identities($1,$2::jsonb)', [tenantId, JSON.stringify([
    { id: workerIdentity, display_name: 'ACME worker', role: 'worker', supplier_id: null, token_hash: 'a'.repeat(64) },
  ])]);
  await admin(`INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'ACME-SUP-001','ACME Supplier')`, [tenantId]);

  evidenceId = randomUUID();
  await admin(
    `INSERT INTO evidence_files
       (tenant_id,id,supplier_id,evidence_type,original_filename,normalized_filename,declared_mime,detected_mime,
        size_bytes,sha256,storage_key,scan_status,review_status,retention_status,uploaded_by,created_at)
     VALUES ($1,$2,'ACME-SUP-001','RECYCLED_CONTENT_DECLARATION','e.bin','e.bin','application/octet-stream',
        'application/octet-stream',14,repeat('a',64),$3,'infected','pending','retained',$4,'2020-01-01T00:00:00Z')`,
    [tenantId, evidenceId, `${tenantId}/e.bin`, workerIdentity],
  );
});

// pg's Pool.end() has no timeout of its own — it waits for every checked-out client to be returned and
// each connection closed, and on Windows this session found that wait does not always resolve. The same
// class of fault startTestDatabase()'s own stop() already guards against (a promise that never settles,
// not one that rejects), one layer up: this file creates its own apiPool/workerPool directly rather than
// through the harness, so their teardown was never covered by that fix.
//
// The local `boundedEnd` that used to live here bounded the wait with Promise.race and stopped there. That
// is why this file still intermittently refused to exit after printing every assertion as passed: the race
// abandons the wait, the pool keeps its sockets, and the event loop stays alive with nothing left to report.
// `endPool` destroys the sockets the deadline gave up on, which is the half that actually lets it exit.
after(async () => {
  await endPool(apiPool, 'principal-separation-api-pool');
  await endPool(workerPool, 'principal-separation-worker-pool');
  await database?.stop();
});

// The deployment, read from the file that creates it. A grant model that is correct in the schema and
// collapsed in Compose is collapsed.
test('compose gives the API and the worker different database identities', async () => {
  // Resolved from this file, not from `cwd`. `resolve('deploy/community/…')` only found the compose file
  // when the whole suite happened to be run from the repository root, and it silently was: this file had no
  // npm script invoking it — `apps/worker` declared no `test:integration` at all — so the only way it ever
  // ran was by hand from the root. Wiring it into the workspace, where npm sets `cwd` to `apps/worker`,
  // turned a passing test into `ENOENT`. The test was right about the property and wrong about where to look.
  const compose = await readFile(resolve(import.meta.dirname, '../../../deploy/community/docker-compose.yml'), 'utf8');
  const urls = [...compose.matchAll(/postgres:\/\/(openppwr_[a-z_]+):/gu)].map((match) => match[1]);
  const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  const workerService = compose.slice(compose.indexOf('\n  worker:'));

  const apiRoles = new Set([...apiService.matchAll(/postgres:\/\/(openppwr_[a-z_]+):/gu)].map((m) => m[1]));
  const workerRoles = new Set([...workerService.matchAll(/postgres:\/\/(openppwr_[a-z_]+):/gu)].map((m) => m[1]));

  assert.ok(urls.length > 0, 'no database URLs found; the parse is wrong, not the compose file');
  assert.ok(workerRoles.has('openppwr_worker'), `the worker connects as ${[...workerRoles].join(', ')}`);
  assert.ok(!apiRoles.has('openppwr_worker'), 'the API is given the worker credential');
  assert.ok(!workerRoles.has('openppwr_app'), 'the worker shares the request-serving identity');
});

test('API_CANNOT_CALL_WORKER_FUNCTIONS — the retention state machine is not reachable from the request path', async () => {
  const workerOnly = [
    ['claim_openppwr_retention', 'SELECT * FROM claim_openppwr_retention($1,$2,$3,$4)', [null, '2030-01-01', randomUUID(), 300]],
    ['reclaim_openppwr_retention', 'SELECT * FROM reclaim_openppwr_retention($1,$2,$3)', [null, randomUUID(), 300]],
    // Migration 026 added a sixth argument, the presented credential's token hash, so a completion could
    // be attributed to whoever actually performed it rather than to whoever had uploaded the evidence.
    ['complete_openppwr_retention', 'SELECT complete_openppwr_retention($1,$2,$3,$4,$5,$6)', [null, null, randomUUID(), 1, new Date().toISOString(), 'a'.repeat(64)]],
    ['release_openppwr_retention', 'SELECT release_openppwr_retention($1,$2,$3,$4)', [null, null, randomUUID(), 1]],
    ['mark_openppwr_retention_uncertain', 'SELECT mark_openppwr_retention_uncertain($1,$2,$3,$4)', [null, null, randomUUID(), 1]],
    ['renew_openppwr_retention_lease', 'SELECT renew_openppwr_retention_lease($1,$2,$3,$4,$5)', [null, null, randomUUID(), 1, 300]],
  ];
  for (const [name, sql, template] of workerOnly) {
    const values = template.map((value) => (value === null ? (sql.includes('claim_openppwr_retention($1,$2') ? tenantId : tenantId) : value));
    // The first argument of every one of these is the tenant; the second of the row-scoped ones is the row.
    if (values.length >= 2 && template[1] === null) values[1] = evidenceId;
    const outcome = await outcomeOf(apiPool, sql, values);
    assert.equal(outcome, 'denied by privilege', `openppwr_app can call ${name}`);
  }
});

// The consequence, not just the grant: a role that can complete a deletion can record one that never
// happened, and the bytes are still on the volume.
test('API_CANNOT_ADVANCE_RETENTION_STATE — a deletion cannot be recorded by the process that serves requests', async () => {
  const claimed = await attempt(apiPool, async (client) => {
    try {
      const taken = await client.query(
        'SELECT evidence_id, generation FROM claim_openppwr_retention($1,$2,$3,$4)',
        [tenantId, '2030-01-01T00:00:00Z', randomUUID(), 300]);
      return taken.rowCount ? 'claimed' : 'nothing to claim';
    } catch (error) {
      return error.code === '42501' ? 'denied by privilege' : `refused: ${error.code}`;
    }
  });
  assert.equal(claimed, 'denied by privilege', 'the request-serving role claimed a retention job');

  const [row] = (await admin('SELECT retention_status FROM evidence_files WHERE id=$1', [evidenceId])).rows;
  assert.equal(row.retention_status, 'retained', 'the row moved');
});

test('WORKER_CANNOT_CALL_API_AUTH_FUNCTIONS — the worker has no business authenticating anyone', async () => {
  for (const [name, sql, values] of [
    ['authenticate_openppwr_demo_login', 'SELECT * FROM authenticate_openppwr_demo_login($1,$2,$3)', ['a@example.invalid', 'a'.repeat(64), 60]],
    ['openppwr_demo_login_salt', 'SELECT openppwr_demo_login_salt($1)', ['a@example.invalid']],
    ['revoke_openppwr_identity_token', 'SELECT revoke_openppwr_identity_token($1,$2,$3)', [tenantId, 'a'.repeat(64), randomUUID()]],
    ['reset_openppwr_demo_tenant', 'SELECT * FROM reset_openppwr_demo_tenant()', []],
    ['bootstrap_openppwr_identities', 'SELECT bootstrap_openppwr_identities($1,$2::jsonb)', [tenantId, '[]']],
  ]) {
    const outcome = await outcomeOf(workerPool, sql, values);
    assert.equal(outcome, 'denied by privilege', `the worker principal can call ${name}`);
  }
});

test('WORKER_CANNOT_PERFORM_NORMAL_BUSINESS_MUTATIONS — it processes jobs, it does not run the product', async () => {
  for (const [what, sql, values] of [
    ['write packaging', 'DELETE FROM packaging WHERE tenant_id=$1', [tenantId]],
    ['review evidence', `UPDATE evidence_files SET review_status='accepted' WHERE id=$1`, [evidenceId]],
    ['create a supplier', `INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'X','X')`, [tenantId]],
  ]) {
    const outcome = await outcomeOf(workerPool, sql, values);
    assert.equal(outcome, 'denied by privilege', `the worker principal can ${what}`);
  }
});

// Stated last and separately, because it is the shape of the whole finding: two services, one identity.
test('the API and the worker do not resolve to the same current_user', async () => {
  const asApi = (await attempt(apiPool, (client) => client.query('SELECT current_user AS role'))).rows[0].role;
  const asWorker = (await attempt(workerPool, (client) => client.query('SELECT current_user AS role'))).rows[0].role;
  assert.notEqual(asApi, asWorker, `both services connect as ${asApi}; every grant separating them is decorative`);
  assert.equal(asApi, 'openppwr_app');
  assert.equal(asWorker, 'openppwr_worker');
});
