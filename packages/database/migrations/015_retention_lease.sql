-- 015 — give a retention deletion an owner, so two workers cannot both finish it
--
-- Two workers must not both finish one deletion, and until this migration they could. The retention sweep
-- moves a row through `retained` -> `deleting` -> `deleted`, and each step is
-- its own transaction. `FOR UPDATE SKIP LOCKED` prevents two workers claiming the same row *at the same
-- instant*, but the claim commits and releases the lock immediately — so from the moment worker A has set
-- `deleting` and is renaming and removing bytes, the row is unlocked and looks exactly like a row abandoned
-- by a process that died.
--
-- Worker B's recovery pass looks for precisely that shape. It can therefore pick up a deletion that is
-- actively in progress, observe the original absent and the tombstone present, remove the tombstone and
-- record the deletion — while A does the same. Two successes for one deletion, and in the interleaving
-- where B instead sees the original still present, B returns the row to `retained` underneath A, and A's
-- own completion then records a deletion of a row that is no longer claimed.
--
-- The missing concept is ownership. `deleting` says an operation is underway; it does not say whose, or
-- whether it is still alive. This adds both, and a generation so that a stale completion from a worker that
-- lost its lease cannot land on a row a later worker has since claimed.

BEGIN;

ALTER TABLE evidence_files
  ADD COLUMN IF NOT EXISTS retention_lease_owner uuid,
  ADD COLUMN IF NOT EXISTS retention_lease_expires_at timestamptz,
  -- Monotonic per row. A completion carries the generation it claimed under, so a worker that was paused
  -- past its lease expiry cannot complete a claim that has since been taken by someone else.
  ADD COLUMN IF NOT EXISTS retention_generation integer NOT NULL DEFAULT 0;

-- A row in `deleting` without an owner predates this migration. It is genuinely abandoned — nothing is
-- holding a lease on it — so it is left to the recovery path, which now treats a NULL lease as expired.
COMMENT ON COLUMN evidence_files.retention_lease_owner IS
  'Worker instance currently performing the deletion. NULL means no live claim.';
COMMENT ON COLUMN evidence_files.retention_lease_expires_at IS
  'When the claim stops being honoured. A recovery pass may reclaim only an expired or absent lease.';
COMMENT ON COLUMN evidence_files.retention_generation IS
  'Incremented on every claim. Completion must present the generation it claimed under.';

-- The recovery pass scans for expired claims on every sweep, so it should not read the whole table to do it.
CREATE INDEX IF NOT EXISTS evidence_files_retention_claim_idx
  ON evidence_files (retention_status, retention_lease_expires_at)
  WHERE retention_status = 'deleting';

-- The state machine, as a constraint rather than as a convention in the worker.
--
-- Written as: a row is only ever `deleting` while it has both an owner and an expiry. This makes the
-- interleaving that lets two workers each finish one deletion unrepresentable rather than merely unlikely
-- — a claim that forgets to
-- take a lease fails here instead of becoming a row any recovery pass will adopt.
ALTER TABLE evidence_files DROP CONSTRAINT IF EXISTS evidence_files_retention_lease_check;
ALTER TABLE evidence_files ADD CONSTRAINT evidence_files_retention_lease_check
  CHECK (
    retention_status <> 'deleting'
    OR (retention_lease_owner IS NOT NULL AND retention_lease_expires_at IS NOT NULL)
  ) NOT VALID;

-- NOT VALID, then validated separately: rows left `deleting` by a pre-015 deployment would otherwise block
-- the migration, and those rows are exactly the abandoned ones the recovery path must be allowed to finish.
--
-- They are given an already-expired lease rather than being returned to `retained`. The difference matters:
-- the recovery path inspects both the original and the tombstone filename and completes or restores
-- accordingly, whereas the ordinary claim path would meet ENOENT on a row whose bytes sit under the
-- tombstone name and record a deletion while leaving those bytes on the volume — a recorded deletion that
-- did not happen, reintroduced by a migration instead of by a code path.
UPDATE evidence_files
   SET retention_lease_owner = '00000000-0000-0000-0000-000000000000',
       retention_lease_expires_at = now() - interval '1 second'
 WHERE retention_status = 'deleting'
   AND retention_lease_owner IS NULL;

ALTER TABLE evidence_files VALIDATE CONSTRAINT evidence_files_retention_lease_check;

COMMIT;
