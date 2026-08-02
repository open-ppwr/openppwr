// Retention deletion, against a real database and a real filesystem.
//
// Two defects were found here, and only one of them was about ordering.
//
// The first: `cleanupRetainedEvidence` was written in Stage 2, exported, and called by exactly one
// integration test. No deployment ever ran it, so nothing was ever deleted, while the retention position was
// documented as though it were. It is now scheduled in `apps/worker/src/server.mjs`.
//
// The second: the row was committed as `deleted` *before* the bytes were removed. If the removal failed, the
// catch restored the file and then tried to reset the row with `WHERE retention_status='deleting'` — which no
// longer matched, because the row already said `deleted`. The outcome was the one state a retention control
// must never reach: a record asserting the evidence is gone, beside the evidence.
//
// The two failure directions are not symmetrical, and these tests are written around that asymmetry. "Bytes
// gone, record still says deleting" is an incomplete deletion that a retry finishes. "Record says deleted,
// bytes present" is a false privacy claim nothing will notice. So the bytes go first.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { VerdictStubScanner, cleanupRetainedEvidence, processNextScanJob } from '@openppwr/worker';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, createVerifiedContext } from '../src/app.mjs';

let database;
let pool;
let workerPool;
let server;
let baseUrl;
let identities;
let tenantId;
let requirements;
let worker;
const storageRoot = resolve('.runtime-test', `retention-${randomUUID()}`);

const exists = (path) => access(path).then(() => true, () => false);

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function upload(requirement, bytes, { filename = 'declaration.pdf', mime = 'application/pdf' } = {}) {
  const form = new FormData();
  form.set('requirementId', requirement.id);
  form.set('supplierId', requirement.supplier_id);
  form.set('evidenceType', requirement.evidence_type);
  form.set('file', new Blob([bytes], { type: mime }), filename);
  const result = await jsonRequest('/v1/evidence', { method: 'POST', headers: { authorization: `Bearer ${identities.evidence_contributor.token}` }, body: form });
  assert.equal(result.response.status, 202, `upload failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

// An upload that reaches a non-clean scan status is what retention deletes.
async function infectedUpload(requirement) {
  const evidence = await upload(requirement, Buffer.from('EICAR marker for retention'), { filename: 'marker.txt', mime: 'text/plain' });
  // Scan outcomes are the worker's to record, so the worker's logic runs on the worker's pool. Running it
  // on the request pool would have needed `evidence.scan.%` registered for openppwr_app, which is the
  // boundary rather than a detail of the harness.
  const processed = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
  assert.equal(processed.evidenceId, evidence.id);
  assert.equal(processed.scanStatus, 'infected');
  return evidence;
}

const storagePathOf = async (evidenceId) => {
  const row = await database.admin.query('SELECT storage_key FROM evidence_files WHERE id=$1', [evidenceId]);
  return resolve(storageRoot, row.rows[0].storage_key);
};

const statusOf = async (evidenceId) => {
  const row = await database.admin.query('SELECT retention_status,deleted_at FROM evidence_files WHERE id=$1', [evidenceId]);
  return row.rows[0];
};

const deletionEventsOf = async (evidenceId) => Number((await database.admin.query(
  `SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='evidence.retention.deleted'`,
  [evidenceId],
)).rows[0].count);

const sweep = (options = {}) => cleanupRetainedEvidence({
  pool: workerPool,
  identity: worker,
  storageRoot,
  cutoff: new Date(Date.now() + 60_000),
  ...options,
});

before(async () => {
  // The installer's `bootstrap-acme` writes this into the real evidence volume once bootstrap succeeds,
  // so the worker's retention sweep can tell "this volume's real, a file is genuinely gone" apart from "an
  // unmounted or wrong volume that merely looks like an empty, accessible directory". This
  // fixture stands in for that one-time installer step.
  await mkdir(storageRoot, { recursive: true });
  await writeFile(resolve(storageRoot, '.openppwr-storage-initialized'), new Date().toISOString());
  database = await startTestDatabase('api-retention');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  // Retention belongs to the worker principal (migration 022). The API keeps the request-serving identity;
  // only the sweep runs as the worker, which is precisely the separation that was missing before.
  workerPool = createPool(database.workerUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((listening) => { server = app.listen(0, '127.0.0.1', listening); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: '{}',
  });
  assert.equal(created.response.status, 201);
  identities = created.body.identities;
  tenantId = created.body.tenantId;
  const imported = await jsonRequest('/v1/imports', {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.packaging_editor.token}`, 'content-type': 'application/json', 'idempotency-key': 'retention-catalog' },
    body: JSON.stringify(createAcmeValidJsonImport()),
  });
  assert.equal(imported.response.status, 201);
  requirements = (await jsonRequest('/v1/evidence-requirements', { headers: { authorization: `Bearer ${identities.evidence_contributor.token}` } })).body.items;
  assert.ok(requirements.length >= 4);
  worker = await createVerifiedContext(pool, identities.worker.token);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((closed) => server?.close(closed));
  await pool?.end();
  await workerPool?.end();
  await database?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

// The reviewer's point about the existing test: it asserted the database status and never looked at the disk.
test('a deleted record means the bytes are gone from disk, not only from the row', async () => {
  const evidence = await infectedUpload(requirements[0]);
  const path = await storagePathOf(evidence.id);
  assert.equal(await exists(path), true, 'the quarantined file must exist before the sweep, or the test proves nothing');

  const result = await sweep();
  assert.equal(result.evidenceId, evidence.id);
  assert.equal(result.retentionStatus, 'deleted');
  assert.equal(result.recovered, false);

  assert.equal(await exists(path), false, 'the file must be gone');
  assert.equal(await exists(`${path}.deleting`), false, 'no tombstone may survive a successful deletion');
  const row = await statusOf(evidence.id);
  assert.equal(row.retention_status, 'deleted');
  assert.ok(row.deleted_at, 'a deleted row records when');
});

// The invariant the ordering exists to guarantee, asserted over every row rather than the one just handled.
test('no row claiming deletion has a file behind it', async () => {
  const deleted = await database.admin.query(`SELECT id,storage_key FROM evidence_files WHERE retention_status='deleted'`);
  assert.ok(deleted.rowCount > 0, 'nothing has been deleted yet, so this invariant is untested');
  for (const row of deleted.rows) {
    const path = resolve(storageRoot, row.storage_key);
    assert.equal(await exists(path), false, `${row.id} says deleted and its file is still present`);
    assert.equal(await exists(`${path}.deleting`), false, `${row.id} says deleted and a tombstone is still present`);
    const ownedTombstones = await readdir(resolve(storageRoot, '.openppwr-retention-tombstones', row.id))
      .catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.deepEqual(ownedTombstones, [], `${row.id} says deleted with owned tombstones: ${ownedTombstones.join(', ')}`);
  }
});

// Recovery. A process that died between removing the bytes and recording it leaves this state; before the
// fix nothing completed it, so the record stayed mid-deletion for ever.
test('a stranded deleting row whose bytes are already gone is completed on the next sweep', async () => {
  const evidence = await infectedUpload(requirements[1]);
  const path = await storagePathOf(evidence.id);
  // Exactly the crash state: bytes removed, row still `deleting`.
  await rm(path, { force: true });
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=gen_random_uuid(),
            retention_lease_expires_at=now()-interval '1 second',retention_operation_id=gen_random_uuid(),
            retention_generation=greatest(retention_generation,1) WHERE id=$1`, [evidence.id]);

  const result = await sweep();
  assert.equal(result.evidenceId, evidence.id);
  assert.equal(result.retentionStatus, 'deleted');
  assert.equal(result.recovered, true, 'the sweep must report that this was a recovery, not a fresh deletion');
  assert.equal((await statusOf(evidence.id)).retention_status, 'deleted');
});

// The other half of recovery: the bytes are still there, so the deletion never got far. The row goes back to
// `retained` and the ordinary path may then claim it from a known state — which, within the same sweep, is
// exactly what happens. The first version of this test asserted the row must NOT end up `deleted`, and that
// was wrong: recovering a row and then deleting it properly is the correct outcome. What must never hold is a
// `deleted` row with bytes behind it, so that is what is asserted.
test('a stranded deleting row whose bytes are still present is recovered before it is deleted', async () => {
  const evidence = await infectedUpload(requirements[2]);
  const path = await storagePathOf(evidence.id);
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=gen_random_uuid(),
            retention_lease_expires_at=now()-interval '1 second',retention_operation_id=gen_random_uuid(),
            retention_generation=greatest(retention_generation,1) WHERE id=$1`, [evidence.id]);
  assert.equal(await exists(path), true);

  await sweep();
  const row = await statusOf(evidence.id);
  assert.ok(['retained', 'deleted'].includes(row.retention_status), `unexpected status ${row.retention_status}`);
  // The invariant, either way round.
  if (row.retention_status === 'deleted') assert.equal(await exists(path), false, 'a deleted row must not have bytes behind it');
  else assert.equal(await exists(path), true, 'a recovered row must still have its bytes');
  assert.equal(await exists(`${path}.deleting`), false, 'no tombstone may be left behind');
});

// A tombstone left by an interrupted rename must not be readable evidence sitting beside a row that says
// nothing is wrong.
// A tombstone with no original is the state left by a process that renamed the file and died before removing
// it. The deletion is completed rather than reversed: the item is past its cutoff and the operation in flight
// was a deletion, so restoring it would resurrect evidence the policy had already condemned.
test('a tombstone with no original completes the deletion rather than reversing it', async () => {
  const evidence = await infectedUpload(requirements[3]);
  const path = await storagePathOf(evidence.id);
  const { rename } = await import('node:fs/promises');
  await rename(path, `${path}.deleting`);
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=gen_random_uuid(),
            retention_lease_expires_at=now()-interval '1 second',retention_operation_id=gen_random_uuid(),
            retention_generation=greatest(retention_generation,1) WHERE id=$1`, [evidence.id]);

  const result = await sweep();
  assert.equal(result.evidenceId, evidence.id);
  assert.equal(result.retentionStatus, 'deleted');
  assert.equal(result.recovered, true);
  assert.equal(await exists(path), false);
  assert.equal(await exists(`${path}.deleting`), false);

  // And nothing readable is left anywhere in the quarantine directory under a tombstone name.
  const quarantine = resolve(storageRoot, tenantId, 'quarantine');
  const remaining = await readdir(quarantine).catch(() => []);
  const tombstones = remaining.filter((name) => name.endsWith('.deleting'));
  assert.deepEqual(tombstones, [], `tombstones left behind: ${tombstones.join(', ')}`);
});

// The failure that made every later sweep throw: a claimed row whose file is already gone. One missing file
// used to break retention permanently, because the same row was reclaimed and the same rename failed.
test('a claimed row whose bytes are already gone completes instead of breaking the sweep', async () => {
  const evidence = await infectedUpload(requirements[4] || requirements[0]);
  const path = await storagePathOf(evidence.id);
  await rm(path, { force: true });

  const result = await sweep();
  assert.equal(result.evidenceId, evidence.id);
  assert.equal(result.retentionStatus, 'deleted');
  assert.equal(result.recovered, true);
  // And the sweep still works afterwards, which is the part that was broken.
  assert.doesNotReject(() => sweep());
});

test('the sweep deletes only evidence that was never accepted', async () => {
  // A clean, accepted upload must survive any number of sweeps: retention here is about uploads that failed
  // scanning or review, not about accepted compliance evidence.
  const requirement = requirements[5] || requirements[0];
  const clean = await upload(requirement, Buffer.from('%PDF-1.4\nkeep me\n'));
  const scanned = await processNextScanJob({ pool: workerPool, identity: worker, storageRoot, scanner: new VerdictStubScanner({ runtime: 'test' }) });
  assert.equal(scanned.evidenceId, clean.id);
  assert.equal(scanned.scanStatus, 'clean');
  const reviewed = await jsonRequest(`/v1/evidence/${clean.id}/review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identities.evidence_reviewer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'accepted' }),
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));

  const path = await storagePathOf(clean.id);
  for (let index = 0; index < 4; index += 1) await sweep();
  assert.equal(await exists(path), true, 'accepted evidence must not be deleted by retention');
  assert.equal((await statusOf(clean.id)).retention_status, 'retained');
});

test('an exhausted sweep returns null rather than reporting work it did not do', async () => {
  // Drain whatever remains, then assert the empty answer is null and not a fabricated success.
  for (let index = 0; index < 10; index += 1) {
    if (!(await sweep())) break;
  }
  assert.equal(await sweep(), null);
});

// The deletion is auditable: a retention control that leaves no record is indistinguishable from data that
// was never there.
test('every deletion appends exactly one audit event and the chain still verifies', async () => {
  const events = await database.admin.query(`SELECT entity_id,payload FROM audit_events WHERE action='evidence.retention.deleted' ORDER BY sequence`);
  const deleted = await database.admin.query(`SELECT count(*)::int AS count FROM evidence_files WHERE retention_status='deleted'`);
  assert.equal(events.rowCount, deleted.rows[0].count, 'one event per deleted item, no more and no fewer');
  for (const row of events.rows) assert.ok(row.payload.cutoff, 'the event records the cutoff it acted on');
  const verified = await jsonRequest('/v1/audit/verify', { headers: { authorization: `Bearer ${identities.tenant_admin.token}` } });
  assert.equal(verified.body.valid, true);
});

// Guard against the first defect returning: a control that runs nowhere is a claim, not a control.
test('the worker schedules the retention sweep', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../worker/src/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /cleanupRetainedEvidence\(/u, 'the worker must call the retention sweep, not merely import it');
  assert.match(source, /retentionSweepMs/u, 'the sweep must run on a bounded interval');
  assert.match(source, /retentionDays/u, 'the cutoff must come from configuration rather than a literal');
});

// The recovery path checked only the original file before recording a deletion, and the error
// handler reset the row to `retained` whether or not the restore had succeeded. Together those produced the
// one state a retention control must never reach — a record saying the evidence is gone, beside the evidence
// — and produced it from the handler that exists to prevent it.
test('a tombstone left behind is never mistaken for a completed deletion', async () => {
  const evidence = await infectedUpload(requirements[6] || requirements[0]);
  const path = await storagePathOf(evidence.id);
  const { rename } = await import('node:fs/promises');

  // The state a failed restore leaves: the original gone, the bytes under the tombstone name, the row still
  // `deleting`. Before the fix the next sweep saw the original absent and recorded a deletion.
  await rename(path, `${path}.deleting`);
  await database.admin.query(
    `UPDATE evidence_files SET retention_status='deleting',retention_lease_owner=gen_random_uuid(),
            retention_lease_expires_at=now()-interval '1 second',retention_operation_id=gen_random_uuid(),
            retention_generation=greatest(retention_generation,1) WHERE id=$1`, [evidence.id]);

  const result = await sweep();
  assert.equal(result.evidenceId, evidence.id);
  assert.equal(result.retentionStatus, 'deleted');
  // The deletion is only recorded because the sweep actually removed the tombstone.
  assert.equal(await exists(`${path}.deleting`), false, 'the tombstone must be gone before a deletion is recorded');
  assert.equal(await exists(path), false);
});

// The invariant across every deleted row, including both filenames. This is the assertion the earlier version
// of this file made against the original path only.
test('no deleted row has bytes behind it under either name', async () => {
  const deleted = await database.admin.query(`SELECT id,storage_key FROM evidence_files WHERE retention_status='deleted'`);
  assert.ok(deleted.rowCount > 0);
  for (const row of deleted.rows) {
    const path = resolve(storageRoot, row.storage_key);
    assert.equal(await exists(path), false, `${row.id} says deleted and its file is present`);
    assert.equal(await exists(`${path}.deleting`), false, `${row.id} says deleted and its tombstone is present`);
    const ownedTombstones = await readdir(resolve(storageRoot, '.openppwr-retention-tombstones', row.id))
      .catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.deepEqual(ownedTombstones, [], `${row.id} says deleted with owned tombstones: ${ownedTombstones.join(', ')}`);
  }
});

// Fault-injected property coverage follows. No source-spelling assertion: behavior is contract.
test('rename failure truth table chooses retained, deleted, or integrity_unknown only from observed bytes', async (t) => {
  const cases = [
    { name: 'original only', expected: 'retained', arrange: async () => {} },
    { name: 'preferred only', expected: 'deleted', arrange: rename },
    { name: 'both', expected: 'integrity_unknown', arrange: copyFile },
    { name: 'neither', expected: 'deleted', arrange: async (source) => rm(source) },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const evidence = await infectedUpload(requirements[0]);
      const original = await storagePathOf(evidence.id);
      let preferred;
      const operation = sweep({
        filesystem: {
          rename: async (source, target) => {
            preferred = target;
            await scenario.arrange(source, target);
            throw Object.assign(new Error(`synthetic ${scenario.name} rename result`), { code: 'EIO' });
          },
        },
      });

      if (scenario.expected === 'deleted') {
        const outcome = await operation;
        assert.equal(outcome.retentionStatus, 'deleted');
      } else {
        await assert.rejects(operation, (error) => error.code === 'EIO' || error.code === 'RETENTION_STORAGE_UNREADABLE');
      }
      assert.equal((await statusOf(evidence.id)).retention_status, scenario.expected);
      assert.equal(await deletionEventsOf(evidence.id), scenario.expected === 'deleted' ? 1 : 0);

      if (scenario.expected === 'retained') {
        assert.equal(await exists(original), true, 'retained requires direct evidence at original path');
        // Keep this deliberately retained row from being selected by later fault cases.
        await database.admin.query(`UPDATE evidence_files SET retention_status='integrity_unknown' WHERE id=$1`, [evidence.id]);
      }
      if (scenario.name === 'both') {
        assert.equal(await exists(original), true);
        assert.equal(await exists(preferred), true);
        await rm(preferred, { force: true });
      }
      if (scenario.expected === 'deleted') {
        assert.equal(await exists(original), false);
        assert.equal(await exists(preferred), false);
      }
    });
  }
});

test('probe and directory-enumeration faults before classification fail closed', async (t) => {
  for (const fault of ['access', 'readdir']) {
    await t.test(fault, async () => {
      const evidence = await infectedUpload(requirements[1]);
      const original = await storagePathOf(evidence.id);
      let injected = false;
      await assert.rejects(
        () => sweep({
          filesystem: {
            rename: async () => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); },
            [fault]: async (path, ...args) => {
              if (!injected) {
                injected = true;
                throw Object.assign(new Error(`synthetic ${fault} failure`), { code: 'EIO' });
              }
              return fault === 'access' ? access(path, ...args) : readdir(path, ...args);
            },
          },
        }),
        (error) => error.code === 'RETENTION_STORAGE_UNREADABLE',
      );
      assert.equal((await statusOf(evidence.id)).retention_status, 'integrity_unknown');
      assert.equal(await deletionEventsOf(evidence.id), 0);
      assert.equal(await exists(original), true);
    });
  }
});

test('deletion needs direct absence evidence for original and every tombstone', async (t) => {
  await t.test('confirmed absent', async () => {
    const evidence = await infectedUpload(requirements[2]);
    let original;
    let preferred;
    let removed = false;
    const absenceProbes = new Set();
    const outcome = await sweep({
      filesystem: {
        rename: async (source, target) => {
          original = source;
          preferred = target;
          await rename(source, target);
        },
        rm: async (path, options) => {
          await rm(path, options);
          removed = true;
        },
        access: async (path, ...args) => {
          if (removed && (path === original || path === preferred)) absenceProbes.add(path);
          return access(path, ...args);
        },
      },
    });
    assert.equal(outcome.retentionStatus, 'deleted');
    assert.deepEqual(absenceProbes, new Set([original, preferred]));
    assert.equal(await deletionEventsOf(evidence.id), 1);
  });

  await t.test('preferred probe contradicts empty listing', async () => {
    const evidence = await infectedUpload(requirements[3]);
    let preferred;
    await assert.rejects(
      () => sweep({
        filesystem: {
          rename: async (source, target) => {
            preferred = target;
            await rm(source);
            throw Object.assign(new Error('synthetic lost rename result'), { code: 'EIO' });
          },
          access: async (path, ...args) => {
            if (path === preferred) return;
            return access(path, ...args);
          },
        },
      }),
      (error) => error.code === 'RETENTION_STORAGE_UNREADABLE',
    );
    assert.equal((await statusOf(evidence.id)).retention_status, 'integrity_unknown');
    assert.equal(await deletionEventsOf(evidence.id), 0);
  });
});

test('finalise failure after proven byte absence never releases the row to retained', async () => {
  const evidence = await infectedUpload(requirements[4] || requirements[0]);
  let original;
  let preferred;
  let expired = false;
  await assert.rejects(
    () => sweep({
      filesystem: {
        rename: async (source, target) => {
          original = source;
          preferred = target;
          await rename(source, target);
        },
        access: async (path, ...args) => {
          if (!expired && path === original) {
            expired = true;
            await database.admin.query(
              `UPDATE evidence_files SET retention_lease_expires_at=now()-interval '1 second' WHERE id=$1`,
              [evidence.id],
            );
          }
          return access(path, ...args);
        },
      },
    }),
    (error) => error.code === 'RETENTION_LEASE_LOST',
  );
  assert.equal(expired, true, 'test never reached post-removal access(original)');
  assert.equal(await exists(original), false);
  assert.equal(await exists(preferred), false);
  assert.equal((await statusOf(evidence.id)).retention_status, 'integrity_unknown');
  assert.equal(await deletionEventsOf(evidence.id), 0);
});

test('resolved restore is followed by access(original) before retained is allowed', async () => {
  const evidence = await infectedUpload(requirements[5] || requirements[0]);
  let original;
  let renameCalls = 0;
  let restoreProbeCalls = 0;
  await assert.rejects(
    () => sweep({
      filesystem: {
        rename: async (source, target) => {
          renameCalls += 1;
          if (renameCalls === 1) original = source;
          await rename(source, target);
        },
        rm: async () => { throw Object.assign(new Error('synthetic removal failure'), { code: 'EIO' }); },
        access: async (path, ...args) => {
          if (renameCalls === 2 && path === original) {
            restoreProbeCalls += 1;
            throw Object.assign(new Error('synthetic missing restore postcondition'), { code: 'ENOENT' });
          }
          return access(path, ...args);
        },
      },
    }),
    (error) => error.code === 'EIO',
  );
  assert.equal(renameCalls, 2, 'restore rename did not run');
  assert.equal(restoreProbeCalls, 1, 'restore result was trusted without access(original)');
  assert.equal((await statusOf(evidence.id)).retention_status, 'integrity_unknown');
  assert.equal(await deletionEventsOf(evidence.id), 0);
});
