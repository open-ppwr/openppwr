-- 019 — fence the filesystem work, and stop claiming a CHECK proves liveness
--
-- Migration 015 was reported as making an invalid interleaving *unrepresentable*. That claim was wrong,
-- on two counts:
--
--   * the CHECK proves only that two columns are non-null. A row whose lease expired an hour ago satisfies
--     it exactly as well as one claimed a second ago, so the constraint says a claim was *recorded*, never
--     that one is *live*;
--   * nothing fences the filesystem. A worker that is slow rather than dead has its lease expire, another
--     worker reclaims the row, and the first worker's `rm` and `rename` still act on the same paths. The
--     database rejects its completion; the filesystem does not reject its writes.
--
-- Liveness cannot be a CHECK: `now()` is not immutable and a row constraint cannot see time passing. So the
-- structure is enforced here, the liveness is enforced by the claim predicate and by renewal, and the
-- filesystem is fenced by naming the tombstone after the operation rather than after the file.

BEGIN;

-- The fencing token. Each deletion attempt names its tombstone after this, so a worker that has lost its
-- lease cannot remove or restore bytes belonging to the attempt that replaced it — it holds the old
-- identifier and the file under that name no longer exists.
--
-- Preserved rather than regenerated when a recovery pass adopts an abandoned claim: the new owner is
-- finishing the *same* filesystem operation, and needs the name the previous worker used.
ALTER TABLE evidence_files
  ADD COLUMN IF NOT EXISTS retention_operation_id uuid;

COMMENT ON COLUMN evidence_files.retention_operation_id IS
  'Names the tombstone for the current deletion attempt. A worker holding a stale value cannot touch a newer attempt''s bytes.';

-- Structural, and described as structural. A live lease is not something a row constraint can assert.
ALTER TABLE evidence_files DROP CONSTRAINT IF EXISTS evidence_files_retention_lease_check;
ALTER TABLE evidence_files ADD CONSTRAINT evidence_files_retention_lease_check
  CHECK (
    retention_status <> 'deleting'
    OR (
      retention_lease_owner IS NOT NULL
      AND retention_lease_expires_at IS NOT NULL
      AND retention_operation_id IS NOT NULL
      AND retention_generation > 0
    )
  ) NOT VALID;

-- Rows already `deleting` predate the fencing column. They are given an operation id so the constraint can
-- be validated, and the recovery path reads the same value — for a row whose tombstone was written under
-- the old fixed name, the worker checks both spellings.
UPDATE evidence_files
   SET retention_operation_id = coalesce(retention_operation_id, gen_random_uuid()),
       retention_generation = greatest(retention_generation, 1),
       retention_lease_owner = coalesce(retention_lease_owner, '00000000-0000-0000-0000-000000000000'),
       retention_lease_expires_at = coalesce(retention_lease_expires_at, now() - interval '1 second')
 WHERE retention_status = 'deleting';

ALTER TABLE evidence_files VALIDATE CONSTRAINT evidence_files_retention_lease_check;

-- ---------------------------------------------------------------------------------------------------
-- Renewal
--
-- The missing half of the fencing: with no way to say "still working", a slow worker is indistinguishable from
-- a dead one, and the only options were an expiry short enough to steal live work or long enough to strand
-- a crash for a shift.
--
-- Renewal is a compare-and-set on the exact claim. A worker that has already lost its lease cannot renew
-- itself back into ownership, which is the property that makes this safe to call from a retry loop.
CREATE OR REPLACE FUNCTION renew_openppwr_retention_lease(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_renewed integer;
BEGIN
  UPDATE evidence_files
     SET retention_lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30))
   WHERE tenant_id = p_tenant_id
     AND id = p_evidence_id
     AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner
     AND retention_generation = p_generation;
  GET DIAGNOSTICS v_renewed = ROW_COUNT;
  RETURN v_renewed = 1;
END $$;

-- The function runs as the security owner, which holds SELECT and DELETE on the domain tables and no
-- UPDATE. Column-level, because extending a lease is the only write it performs and a table-wide grant
-- would let this owner rewrite retention state it has no business touching.
GRANT UPDATE (retention_lease_expires_at) ON evidence_files TO openppwr_security_owner;

REVOKE ALL ON FUNCTION renew_openppwr_retention_lease(uuid, uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renew_openppwr_retention_lease(uuid, uuid, uuid, integer, integer) TO openppwr_app;
ALTER FUNCTION renew_openppwr_retention_lease(uuid, uuid, uuid, integer, integer) OWNER TO openppwr_security_owner;

-- ---------------------------------------------------------------------------------------------------
-- Uncertain filesystem state is not a retention outcome
--
-- A restore that fails leaves bytes whose location nobody can assert. Recording that as `retained` claims
-- the evidence is where the row says it is; recording it as `deleted` claims it is gone. Both are guesses,
-- and the retention control exists precisely so that neither is guessed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'evidence_files_retention_status_check'
       AND pg_get_constraintdef(oid) LIKE '%integrity_unknown%'
  ) THEN
    ALTER TABLE evidence_files DROP CONSTRAINT IF EXISTS evidence_files_retention_status_check;
    ALTER TABLE evidence_files ADD CONSTRAINT evidence_files_retention_status_check
      CHECK (retention_status IN ('retained', 'deleting', 'deleted', 'integrity_unknown'));
  END IF;
END $$;

COMMIT;
