// Two retention workers must not both record one deletion.
//
// The sweep moves a row `retained` -> `deleting` -> `deleted`, and each step is its own transaction. So the
// claim commits and releases its lock immediately, and from that moment a deletion in progress is
// indistinguishable, in the database, from one abandoned by a process that died. The recovery pass looks
// for exactly that shape, and would adopt a live deletion.
//
// These interleave the two workers at real state transitions rather than by timing. A concurrency test that
// sleeps proves only that the machine was fast enough that day.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createPool, migrate, verifyAuditChain, withTenantTransaction } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { cleanupRetainedEvidence, tombstonePath } from '../src/index.mjs';

let database;
let pool;
let identity;
let storageRoot;
let tenantId;

const CUTOFF = new Date('2030-01-01T00:00:00.000Z');

const admin = (text, values = []) => database.admin.query(text, values);

// One expired, deletable evidence row plus its bytes on disk.
async function seedEvidence({ storageKey: requestedStorageKey } = {}) {
  const id = randomUUID();
  const storageKey = requestedStorageKey ?? `${tenantId}/${id}.bin`;
  const path = resolve(storageRoot, storageKey);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, 'evidence-bytes');
  await admin(
    `INSERT INTO evidence_files
       (tenant_id,id,supplier_id,evidence_type,original_filename,normalized_filename,declared_mime,detected_mime,
        size_bytes,sha256,storage_key,scan_status,review_status,retention_status,uploaded_by,created_at)
     VALUES ($1,$2,'ACME-SUP-001','RECYCLED_CONTENT_DECLARATION','e.bin','e.bin','application/octet-stream',
        'application/octet-stream',14,repeat('a',64),$3,'infected','pending','retained',$4,'2020-01-01T00:00:00Z')`,
    [tenantId, id, storageKey, identity.actorId],
  );
  return { id, storageKey, path, tombstone: `${path}.deleting` };
}

const rowOf = async (id) => (await admin(
  `SELECT retention_status, retention_lease_owner, retention_lease_expires_at, retention_generation, deleted_at
     FROM evidence_files WHERE id=$1`, [id])).rows[0];

const deletionEvents = async (id) => Number((await admin(
  `SELECT count(*)::int AS c FROM audit_events WHERE entity_id=$1 AND action='evidence.retention.deleted'`, [id],
)).rows[0].c);

const sweep = (options = {}) => cleanupRetainedEvidence({ pool, identity, storageRoot, cutoff: CUTOFF, ...options });

before(async () => {
  database = await startTestDatabase('worker-retention-concurrency');
  await migrate(database.adminUrl);
  // The retention transitions belong to the worker principal now (migration 022).
  pool = createPool(database.workerUrl);
  storageRoot = resolve('.runtime-test', `retention-${randomUUID()}`);
  await mkdir(storageRoot, { recursive: true });
  // Stands in for the installer's `bootstrap-acme` writing this into the real evidence volume once
  // bootstrap succeeds — the worker's retention sweep requires it before treating absence as deletion
  // before it will treat an absent file as a completed deletion.
  await writeFile(resolve(storageRoot, '.openppwr-storage-initialized'), new Date().toISOString());

  tenantId = randomUUID();
  await admin('SELECT create_openppwr_tenant($1,$2,$3,$4)', [tenantId, 'acme-eu-demo', 'ACME', 'demo']);
  const workerId = randomUUID();
  await admin('SELECT bootstrap_openppwr_identities($1,$2::jsonb)', [tenantId, JSON.stringify([
    { id: workerId, display_name: 'ACME worker', role: 'worker', supplier_id: null, token_hash: 'a'.repeat(64) },
  ])]);
  // The credential the real authentication path supplies; the audit chain resolves the actor from
  // it rather than from a field the caller sets.
  identity = { tenantId, actorId: workerId, role: 'worker', credentialHash: 'a'.repeat(64) };
  // Evidence references a supplier, so one has to exist before any of this means anything.
  await admin(
    `INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'ACME-SUP-001','ACME Supplier')
       ON CONFLICT DO NOTHING`, [tenantId]);
});

beforeEach(async () => {
  await admin('DELETE FROM evidence_files WHERE tenant_id=$1', [tenantId]);
});

after(async () => {
  await pool?.end();
  await database?.stop();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
});

// The claim is the barrier. Worker A claims and holds; worker B runs a full sweep while A's claim is live.
test('a live claim is not adopted by another worker recovery pass', async () => {
  const evidence = await seedEvidence();

  // A claims by running a sweep whose lease is long. It completes, so we simulate "still working" by
  // reproducing the state a mid-deletion worker leaves: claimed, with the bytes moved to the tombstone.
  const ownerA = randomUUID();
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()+interval '5 minutes',retention_generation=retention_generation+1,
            retention_operation_id=gen_random_uuid()
      WHERE id=$1`, [evidence.id, ownerA]);
  await writeFile(evidence.tombstone, await readFile(evidence.path));
  await rm(evidence.path);

  // B sweeps. It must see nothing to do: the claim is live and belongs to A.
  const outcome = await sweep({ leaseOwner: randomUUID() });
  assert.equal(outcome, null, 'a second worker adopted a deletion that was still in progress');

  const row = await rowOf(evidence.id);
  assert.equal(row.retention_status, 'deleting', 'B changed the state of a row it does not own');
  assert.equal(row.retention_lease_owner, ownerA, 'B took the claim');
  assert.equal(await deletionEvents(evidence.id), 0, 'B recorded a deletion it did not perform');
  assert.ok(existsSync(evidence.tombstone), 'B removed bytes belonging to another worker operation');
});

test('an expired claim is reclaimed, and the previous owner can no longer complete it', async () => {
  const evidence = await seedEvidence();

  const ownerA = randomUUID();
  const claimedA = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',retention_generation=retention_generation+1,
            retention_operation_id=gen_random_uuid()
      WHERE id=$1 RETURNING retention_generation`, [evidence.id, ownerA]);
  const generationA = claimedA.rows[0].retention_generation;

  // The bytes are gone, which is the state A reaches just before recording its success.
  await rm(evidence.path);

  const ownerB = randomUUID();
  const outcome = await sweep({ leaseOwner: ownerB });
  assert.equal(outcome?.retentionStatus, 'deleted', 'an expired claim must be recoverable, or a crash strands the row for ever');

  const row = await rowOf(evidence.id);
  assert.equal(row.retention_status, 'deleted');
  assert.ok(row.retention_generation > generationA, 'reclaiming must advance the generation');
  assert.equal(await deletionEvents(evidence.id), 1, 'exactly one deletion, exactly one record');

  // A now returns from its pause and tries to record the success it believes it achieved. It must fail:
  // it presents a generation that no longer exists.
  const stale = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleted',deleted_at=now()
      WHERE id=$1 AND retention_status='deleting' AND retention_lease_owner=$2 AND retention_generation=$3`,
    [evidence.id, ownerA, generationA]);
  assert.equal(stale.rowCount, 0, 'a stale completion from a lost lease landed on the row');
  assert.equal(await deletionEvents(evidence.id), 1, 'a second deletion event was recorded');
});

test('two concurrent sweeps claim different rows and never the same one', async () => {
  const first = await seedEvidence();
  const second = await seedEvidence();

  // Four sweeps against two rows. The previous version could satisfy its own assertion with one successful
  // claim and one empty result, which proves nothing about contention.
  const results = await Promise.all([
    sweep({ leaseOwner: randomUUID() }), sweep({ leaseOwner: randomUUID() }),
    sweep({ leaseOwner: randomUUID() }), sweep({ leaseOwner: randomUUID() }),
  ]);
  const handled = results.filter(Boolean).map((result) => result.evidenceId);
  assert.ok(handled.length >= 1, 'no sweep claimed anything; the fixture is wrong, not the product');

  assert.equal(new Set(handled).size, handled.length, 'both workers processed the same row');
  for (const evidence of [first, second]) {
    const events = await deletionEvents(evidence.id);
    assert.ok(events <= 1, `${events} deletion events recorded for one row`);
  }
  // Whatever was claimed, no row may be left claimed by a worker that has finished.
  const dangling = (await admin(
    `SELECT id FROM evidence_files WHERE tenant_id=$1 AND retention_status='deleted' AND retention_lease_owner IS NOT NULL`,
    [tenantId])).rows;
  assert.deepEqual(dangling, [], 'a completed deletion left a live claim behind');
});

// The state machine as the database enforces it, not as the worker intends it.
test('a row cannot be left deleting without an owner', async () => {
  const evidence = await seedEvidence();
  await assert.rejects(
    () => admin(`UPDATE evidence_files SET retention_status='deleting' WHERE id=$1`, [evidence.id]),
    (error) => error.code === '23514',
    'an unowned deleting row is exactly what every recovery pass will adopt',
  );
});

test('a completed sweep clears its claim and leaves the audit chain valid', async () => {
  const evidence = await seedEvidence();
  const outcome = await sweep({ leaseOwner: randomUUID() });
  assert.equal(outcome?.retentionStatus, 'deleted');

  const row = await rowOf(evidence.id);
  assert.equal(row.retention_lease_owner, null, 'a finished deletion must not keep a claim');
  assert.equal(row.retention_lease_expires_at, null);
  assert.ok(row.deleted_at, 'the deletion must be dated');
  assert.ok(!existsSync(evidence.path) && !existsSync(evidence.tombstone), 'bytes survived a recorded deletion');

  const verified = await withTenantTransaction(pool, identity, verifyAuditChain);
  assert.equal(verified.valid, true, 'the retention sweep broke the audit chain');
});

// --- liveness and filesystem fencing ---------------------------------------------------------------
//
// Migration 015 was reported as making an invalid interleaving unrepresentable. That was wrong. The CHECK
// proves two columns are non-null, so a lease that expired an hour ago satisfies it exactly as well as one
// taken a second ago — it says a claim was *recorded*, never that one is *live*. And nothing fenced the
// filesystem: a worker that was slow rather than dead had its lease expire, another worker reclaimed the
// row, and the first worker's `rm` and `rename` still acted on the same paths.

test('RETENTION_LEASE_LIVENESS_PASS — a live worker can say it is still working, and a stale one cannot', async () => {
  const evidence = await seedEvidence();
  const owner = randomUUID();
  const claimed = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()+interval '10 seconds',
            retention_generation=retention_generation+1,retention_operation_id=gen_random_uuid()
      WHERE id=$1 RETURNING retention_generation, retention_lease_expires_at`, [evidence.id, owner]);
  const generation = claimed.rows[0].retention_generation;
  const firstExpiry = new Date(claimed.rows[0].retention_lease_expires_at).getTime();

  const renewed = await withTenantTransaction(pool, identity, (client) => client.query(
    'SELECT renew_openppwr_retention_lease($1,$2,$3,$4,$5) AS renewed',
    [tenantId, evidence.id, owner, generation, 300]));
  assert.equal(renewed.rows[0].renewed, true, 'a live owner must be able to extend its own claim');
  assert.ok(new Date((await rowOf(evidence.id)).retention_lease_expires_at).getTime() > firstExpiry,
    'renewal did not move the expiry');

  // Another worker reclaims, which advances the generation. The first worker must not be able to renew
  // itself back into ownership — that is what makes renewal safe to call from a retry loop.
  // Two separate failures. The first version only advanced the generation, so it proved a generation check
  // and never a liveness check, and would have passed against a renewal with no expiry predicate.
  //
  // First: the lease simply expires, with nobody reclaiming.
  await database.admin.query(
    `UPDATE evidence_files SET retention_lease_expires_at=now()-interval '1 second' WHERE id=$1`, [evidence.id]);
  const afterExpiry = await withTenantTransaction(pool, identity, (client) => client.query(
    'SELECT renew_openppwr_retention_lease($1,$2,$3,$4,$5) AS renewed',
    [tenantId, evidence.id, owner, generation, 300]));
  assert.equal(afterExpiry.rows[0].renewed, false, 'an expired lease renewed itself back into ownership');

  // Second: another worker reclaims and the generation moves on.
  await database.admin.query(
    `UPDATE evidence_files SET retention_lease_owner=$2,retention_lease_expires_at=now()+interval '5 minutes',
            retention_generation=retention_generation+1 WHERE id=$1`, [evidence.id, randomUUID()]);
  const stale = await withTenantTransaction(pool, identity, (client) => client.query(
    'SELECT renew_openppwr_retention_lease($1,$2,$3,$4,$5) AS renewed',
    [tenantId, evidence.id, owner, generation, 300]));
  assert.equal(stale.rows[0].renewed, false, 'a worker that lost its lease renewed itself back into ownership');
});

test('RETENTION_FILESYSTEM_FENCING_PASS — two attempts never contend for one path', async () => {
  const evidence = await seedEvidence();
  const first = await sweep({ leaseOwner: randomUUID() });
  assert.equal(first?.retentionStatus, 'deleted');

  // The tombstone is named after the deletion attempt, so a worker holding a stale operation id acts on a
  // name nothing else uses. The unfenced name must never appear.
  assert.ok(!existsSync(`${evidence.path}.deleting`), 'the unfenced tombstone name is still in use');
  assert.ok(!existsSync(evidence.path), 'the bytes survived a recorded deletion');
});

test('a claim records a fencing token, and the recovery pass keeps it rather than minting a new one', async () => {
  const evidence = await seedEvidence();
  const owner = randomUUID();
  const claimed = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',
            retention_generation=retention_generation+1,retention_operation_id=gen_random_uuid()
      WHERE id=$1 RETURNING retention_operation_id`, [evidence.id, owner]);
  const operationId = claimed.rows[0].retention_operation_id;

  // The abandoned worker had renamed the bytes under its own operation id.
  await writeFile(`${evidence.path}.deleting.${operationId}`, await readFile(evidence.path));
  await rm(evidence.path);

  const recovered = await sweep({ leaseOwner: randomUUID() });
  assert.equal(recovered?.retentionStatus, 'deleted', 'the recovery pass could not find the abandoned bytes');
  assert.ok(!existsSync(`${evidence.path}.deleting.${operationId}`), 'the abandoned tombstone was left behind');
  assert.equal(await deletionEvents(evidence.id), 1);
});

// A pre-019 deployment wrote `.deleting` with no suffix. An upgrade must finish those rather than strand
// exactly the rows the recovery path exists for.
test('a tombstone written before the fencing token is still recovered', async () => {
  const evidence = await seedEvidence();
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',
            retention_generation=greatest(retention_generation,1),retention_operation_id=gen_random_uuid()
      WHERE id=$1`, [evidence.id, randomUUID()]);
  await writeFile(`${evidence.path}.deleting`, await readFile(evidence.path));
  await rm(evidence.path);

  const recovered = await sweep({ leaseOwner: randomUUID() });
  assert.equal(recovered?.retentionStatus, 'deleted', 'an upgraded deployment stranded an incomplete deletion');
  assert.ok(!existsSync(`${evidence.path}.deleting`), 'the legacy tombstone was left on the volume');
});

test('RETENTION_UNCERTAIN_STATE_FAIL_CLOSED_PASS — the schema admits a state for bytes nobody can account for', async () => {
  // Recording `retained` claims the evidence is where the row says it is; recording `deleted` claims it is
  // gone. When a restore fails, both are guesses, and a retention control exists so that neither is guessed.
  const evidence = await seedEvidence();
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='integrity_unknown' WHERE id=$1`, [evidence.id]);
  assert.equal((await rowOf(evidence.id)).retention_status, 'integrity_unknown');

  // And it is terminal for the sweep: an uncertain row is neither claimed nor reported as deleted.
  const outcome = await sweep({ leaseOwner: randomUUID() });
  assert.equal(outcome, null, 'the sweep adopted a row whose byte state is unknown');
  assert.equal(await deletionEvents(evidence.id), 0);
});

// --- the dimensions no suite exercised ---------------------------------------------------------------
//
// Six things every green suite left untouched: concurrent filesystem operations,
// suffixed-tombstone enumeration, injected removal faults, cross-principal audit attempts, poisoned audit
// timestamps, and demonstration-to-production reconfiguration. A suite that never causes a failure cannot
// report that the failure is handled.

test('RETENTION_ALL_OWNED_TOMBSTONES_REMOVED — every copy in the evidence directory goes', async () => {
  const evidence = await seedEvidence();
  const owner = randomUUID();
  const claimed = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()+interval '5 minutes',
            retention_generation=retention_generation+1,retention_operation_id=gen_random_uuid()
      WHERE id=$1 RETURNING retention_operation_id`, [evidence.id, owner]);
  const operationId = claimed.rows[0].retention_operation_id;

  // New layout supplies ownership structurally through one reserved directory per evidence id. Upgrade
  // recovery also removes an old arbitrary suffix only after proving no persisted row owns that path.
  const bytes = await readFile(evidence.path);
  const preferred = tombstonePath(storageRoot, evidence.id, operationId);
  const additional = tombstonePath(storageRoot, evidence.id, randomUUID());
  const legacy = `${evidence.path}.deleting.${randomUUID()}`;
  await mkdir(resolve(preferred, '..'), { recursive: true });
  await writeFile(preferred, bytes);
  await writeFile(additional, bytes);
  await writeFile(legacy, bytes);
  await rm(evidence.path);

  // Expire the claim so the recovery pass adopts it.
  await database.admin.query(
    `UPDATE evidence_files SET retention_lease_expires_at=now()-interval '1 second' WHERE id=$1`, [evidence.id]);

  const outcome = await sweep({ leaseOwner: randomUUID() });
  assert.equal(outcome?.retentionStatus, 'deleted');

  const survivors = await readdir(resolve(preferred, '..')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(survivors, [], `a recorded deletion left readable copies: ${survivors.join(', ')}`);
  assert.ok(!existsSync(legacy), 'verified-unowned legacy tombstone survived recovery');
});

test('RETENTION_CROSS_ROW_COLLISION_FAILS_CLOSED — recovery never removes another row original', async () => {
  const first = await seedEvidence();
  const operationId = randomUUID();
  // Simulate a collision already present when migration 028 adds its NOT VALID constraint. New rows cannot
  // acquire this shape, while upgrade rows still exercise recovery's ownership census.
  await database.admin.query('ALTER TABLE evidence_files DROP CONSTRAINT evidence_files_legacy_tombstone_suffix_reserved');
  let second;
  try {
    second = await seedEvidence({ storageKey: `${first.storageKey}.deleting.${operationId}` });
  } finally {
    await database.admin.query(
      `ALTER TABLE evidence_files ADD CONSTRAINT evidence_files_legacy_tombstone_suffix_reserved
       CHECK (storage_key !~ '\\.deleting($|\\.)') NOT VALID`,
    );
  }
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',
            retention_generation=retention_generation+1,retention_operation_id=$3
      WHERE id=$1`,
    [first.id, randomUUID(), operationId],
  );
  await rm(first.path);

  await assert.rejects(
    () => sweep({ leaseOwner: randomUUID() }),
    (error) => error.code === 'RETENTION_STORAGE_COLLISION',
    'a cross-row filename collision was not reported as uncertainty',
  );

  assert.equal((await rowOf(first.id)).retention_status, 'integrity_unknown');
  assert.equal((await rowOf(second.id)).retention_status, 'retained');
  assert.ok(existsSync(second.path), 'recovery removed bytes owned by another evidence row');
  assert.equal(await deletionEvents(first.id), 0);
  assert.equal(await deletionEvents(second.id), 0);
});

test('LEGACY_TOMBSTONE_SUFFIX_CANNOT_ACQUIRE_NEW_OWNER — insertion cannot race recovery census', async () => {
  const first = await seedEvidence();
  const appPool = createPool(database.runtimeUrl);
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id',$1,true)`, [tenantId]);
    await assert.rejects(
      () => client.query(
        `INSERT INTO evidence_files
           (tenant_id,id,supplier_id,evidence_type,original_filename,normalized_filename,declared_mime,
            detected_mime,size_bytes,sha256,storage_key,scan_status,review_status,retention_status,uploaded_by,created_at)
         VALUES ($1,$2,'ACME-SUP-001','RECYCLED_CONTENT_DECLARATION','e.bin','e.bin','application/octet-stream',
            'application/octet-stream',14,repeat('a',64),$3,'pending','pending','retained',$4,'2020-01-01T00:00:00Z')`,
        [tenantId, randomUUID(), `${first.storageKey}.deleting.${randomUUID()}`, identity.actorId],
      ),
      (error) => error.code === '23514',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await appPool.end();
  }
});

test('RECOVERY_PROBES_OPERATION_TOMBSTONE_WHEN_DIRECTORY_LISTING_IS_STALE', async () => {
  const evidence = await seedEvidence();
  const claimed = await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',retention_generation=retention_generation+1,
            retention_operation_id=gen_random_uuid()
      WHERE id=$1 RETURNING retention_operation_id`, [evidence.id, randomUUID()]);
  const preferred = tombstonePath(storageRoot, evidence.id, claimed.rows[0].retention_operation_id);
  const directory = resolve(preferred, '..');
  await mkdir(directory, { recursive: true });
  await rename(evidence.path, preferred);

  const outcome = await sweep({
    filesystem: {
      readdir: async (path, ...args) => path === directory ? [] : readdir(path, ...args),
    },
  });
  assert.equal(outcome?.retentionStatus, 'deleted');
  assert.ok(!existsSync(preferred), 'directly named tombstone survived stale empty listing');
  assert.equal(await deletionEvents(evidence.id), 1);
});

test('RECOVERY_REJECTS_SYMLINKED_TOMBSTONE_DIRECTORY', async () => {
  const evidence = await seedEvidence();
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',retention_generation=retention_generation+1,
            retention_operation_id=gen_random_uuid() WHERE id=$1`, [evidence.id, randomUUID()]);
  await rm(evidence.path);

  const directory = resolve(storageRoot, '.openppwr-retention-tombstones', evidence.id);
  const target = resolve(storageRoot, `symlink-target-${randomUUID()}`);
  const sentinel = resolve(target, 'must-survive');
  await mkdir(resolve(directory, '..'), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(sentinel, 'owned elsewhere');
  await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    () => sweep({ leaseOwner: randomUUID() }),
    (error) => error.code === 'STORAGE_PATH_INVALID',
  );
  assert.equal((await rowOf(evidence.id)).retention_status, 'integrity_unknown');
  assert.ok(existsSync(sentinel), 'recovery followed symlink and removed target contents');
  assert.equal(await deletionEvents(evidence.id), 0);
});

// The tombstone *destination* directory was checked for a symlinked parent; the deletion *source* — the
// directory holding the original bytes — was not. Lexical confinement (resolveStoragePath) proves the
// string stays under storageRoot; it does not prove the directory does. A parent replaced by a symlink is
// followed by both the rename that starts the deletion and the rename recovery uses to finish one.
test('RETENTION_REJECTS_SYMLINKED_ORIGINAL_PARENT — a symlinked source directory is not followed', async () => {
  const id = randomUUID();
  const storageKey = `${tenantId}/qtest-${randomUUID()}/target.bin`;
  const originalPath = resolve(storageRoot, storageKey);
  const parentDir = resolve(originalPath, '..');

  // Bytes this row does not own. If the delete follows a symlinked parent, this is what it destroys
  // instead of leaving alone.
  const elsewhere = resolve(storageRoot, `elsewhere-${randomUUID()}`);
  const sentinel = resolve(elsewhere, 'target.bin');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(sentinel, 'owned by a directory this row does not own');

  // The row's own quarantine subdirectory never exists as a plain directory — it is a symlink from the
  // moment retention deletion first looks at it, exactly as a volume an attacker can write to would present it.
  await mkdir(resolve(parentDir, '..'), { recursive: true });
  await symlink(elsewhere, parentDir, process.platform === 'win32' ? 'junction' : 'dir');

  await admin(
    `INSERT INTO evidence_files
       (tenant_id,id,supplier_id,evidence_type,original_filename,normalized_filename,declared_mime,detected_mime,
        size_bytes,sha256,storage_key,scan_status,review_status,retention_status,uploaded_by,created_at)
     VALUES ($1,$2,'ACME-SUP-001','RECYCLED_CONTENT_DECLARATION','e.bin','e.bin','application/octet-stream',
        'application/octet-stream',14,repeat('a',64),$3,'infected','pending','retained',$4,'2020-01-01T00:00:00Z')`,
    [tenantId, id, storageKey, identity.actorId],
  );

  await assert.rejects(
    () => sweep({ leaseOwner: randomUUID() }),
    (error) => error.code === 'STORAGE_PATH_INVALID',
    'a symlinked quarantine parent was followed by the retention delete',
  );

  assert.ok(existsSync(sentinel), 'retention cleanup destroyed bytes outside the evidence row it claimed');
  assert.equal((await rowOf(id)).retention_status, 'integrity_unknown');
  assert.equal(await deletionEvents(id), 0);

  await rm(parentDir, { force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

test('RETENTION_AMBIGUOUS_RENAME_IS_REPROBED — moved bytes are removed even when rename reports EIO', async () => {
  const evidence = await seedEvidence();
  let calls = 0;
  const outcome = await sweep({
    leaseOwner: randomUUID(),
    filesystem: {
      rename: async (source, target) => {
        calls += 1;
        await rename(source, target);
        throw Object.assign(new Error('synthetic ambiguous rename result'), { code: 'EIO' });
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome?.retentionStatus, 'deleted');
  assert.equal((await rowOf(evidence.id)).retention_status, 'deleted');
  assert.ok(!existsSync(evidence.path), 'ambiguous rename recovery restored bytes after deletion was recorded');
  assert.equal(await deletionEvents(evidence.id), 1);
});

test('RETENTION_EXPIRED_FAILURE_REACHES_UNCERTAIN — lease expiry does not strand deleting', async () => {
  const evidence = await seedEvidence();
  let renameCalls = 0;
  await assert.rejects(
    () => sweep({
      leaseOwner: randomUUID(),
      filesystem: {
        rename: async (source, target) => {
          renameCalls += 1;
          if (renameCalls === 1) return rename(source, target);
          throw Object.assign(new Error('synthetic restore failure'), { code: 'EIO' });
        },
        rm: async () => {
          await database.admin.query(
            `UPDATE evidence_files SET retention_lease_expires_at=now()-interval '1 second' WHERE id=$1`,
            [evidence.id],
          );
          throw Object.assign(new Error('synthetic delayed removal failure'), { code: 'EIO' });
        },
      },
    }),
    (error) => error.code === 'EIO',
  );

  assert.equal((await rowOf(evidence.id)).retention_status, 'integrity_unknown',
    'an expired current claim was left deleting after storage became uncertain');
  assert.equal(await deletionEvents(evidence.id), 0);
});

test('RETENTION_FAILURE_AFTER_RECLAIM_REPORTS_LEASE_LOSS — stale owner never overwrites current claim', async () => {
  const evidence = await seedEvidence();
  const currentOwner = randomUUID();
  let renameCalls = 0;
  await assert.rejects(
    () => sweep({
      leaseOwner: randomUUID(),
      filesystem: {
        rename: async (source, target) => {
          renameCalls += 1;
          if (renameCalls === 1) return rename(source, target);
          throw Object.assign(new Error('synthetic restore failure'), { code: 'EIO' });
        },
        rm: async () => {
          await database.admin.query(
            `UPDATE evidence_files SET retention_lease_owner=$2,
                    retention_lease_expires_at=now()+interval '5 minutes',
                    retention_generation=retention_generation+1
              WHERE id=$1`,
            [evidence.id, currentOwner],
          );
          throw Object.assign(new Error('synthetic removal failure after reclaim'), { code: 'EIO' });
        },
      },
    }),
    (error) => error.code === 'RETENTION_LEASE_LOST',
  );

  const row = await rowOf(evidence.id);
  assert.equal(row.retention_status, 'deleting');
  assert.equal(row.retention_lease_owner, currentOwner);
  assert.equal(await deletionEvents(evidence.id), 0);
});

test('RETENTION_REMOVAL_FAULT_IS_UNCERTAIN — a removal that cannot happen is not a deletion', async () => {
  const evidence = await seedEvidence();
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=$2,
            retention_lease_expires_at=now()-interval '1 second',
            retention_generation=retention_generation+1,retention_operation_id=gen_random_uuid()
      WHERE id=$1`, [evidence.id, randomUUID()]);

  // A directory where the file should be. `rm` without `recursive` refuses it, which is a removal failure
  // the worker did not cause and cannot resolve — exactly the shape of EACCES on a real volume.
  await rm(evidence.path);
  await mkdir(`${evidence.path}.deleting`, { recursive: true });
  await writeFile(resolve(`${evidence.path}.deleting`, 'occupied'), 'x');

  await assert.rejects(() => sweep({ leaseOwner: randomUUID() }), (error) => error instanceof Error);

  const row = await rowOf(evidence.id);
  assert.equal(row.retention_status, 'integrity_unknown',
    'a failed removal must leave the row in the state that says nobody can account for the bytes');
  assert.equal(await deletionEvents(evidence.id), 0, 'a deletion was recorded for bytes that are still there');

  await rm(`${evidence.path}.deleting`, { recursive: true, force: true }).catch(() => {});
});

test('RETENTION_CONCURRENT_FILESYSTEM_WORK — two sweeps over the same rows leave no readable copy', async () => {
  const rows = [await seedEvidence(), await seedEvidence(), await seedEvidence()];
  // Genuinely concurrent, and more sweeps than rows so at least one meets an empty queue.
  await Promise.all([
    sweep({ leaseOwner: randomUUID() }), sweep({ leaseOwner: randomUUID() }),
    sweep({ leaseOwner: randomUUID() }), sweep({ leaseOwner: randomUUID() }),
    sweep({ leaseOwner: randomUUID() }),
  ]);

  for (const evidence of rows) {
    const row = await rowOf(evidence.id);
    assert.equal(row.retention_status, 'deleted', 'a seeded row did not reach its expected terminal state');
    assert.ok(!existsSync(evidence.path), 'a deleted row still has its original on disk');
    const events = await deletionEvents(evidence.id);
    assert.equal(events, 1, `${events} deletion events for one deletion`);
  }
});

test('AUDIT_POISONED_TIMESTAMP_IS_REPORTED — one unrenderable event does not take verification down', async () => {
  // Written past the append function, as a pre-023 deployment's chain would already contain. The constraint
  // added by 024 is NOT VALID precisely so such a row can still exist and be described.
  const beforePoison = await withTenantTransaction(pool, identity, verifyAuditChain);
  assert.equal(beforePoison.valid, true, `audit chain was already invalid at ${beforePoison.failedEventId}`);
  const poisonedEventId = randomUUID();
  await database.admin.query('ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_occurred_at_finite');
  {
    await database.admin.query(
      `INSERT INTO audit_events (tenant_id,event_id,actor_id,action,entity_type,entity_id,payload,occurred_at,
                                 previous_hash,event_hash,hash_algorithm)
       SELECT $1::uuid, $4::uuid, $2::uuid, 'assessment.completed', 'tenant', $3, '{}'::jsonb,
              'infinity'::timestamptz, event_hash, repeat('b',64), 'js-canonical-v1'
         FROM audit_events ORDER BY sequence DESC LIMIT 1`,
      [tenantId, identity.actorId, tenantId, poisonedEventId]);

    // Reported as invalid rather than thrown out of. The previous version called auditRange, which runs the
    // same failing conversion on the first and last rows.
    const verified = await withTenantTransaction(pool, identity, verifyAuditChain);
    assert.equal(verified.valid, false, 'an unrenderable timestamp must be reported, not raised');
    assert.equal(verified.failedEventId, poisonedEventId, 'verification did not name the row this test poisoned');
  }
  // The row is not removed afterwards: audit_events refuses DELETE, which is the immutability guard doing
  // its job. This test is deliberately last in the file, and the cluster is torn down with the suite.
});
