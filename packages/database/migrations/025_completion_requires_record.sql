-- 025 — a recorded deletion must leave a record
--
-- A worker could claim an eligible row, skip the filesystem work entirely and call
-- `complete_openppwr_retention`: the row read `deleted` with the bytes still present, and nothing obliged
-- it to write an audit event. A server-chosen timestamp proves *when* a deletion was recorded. It has never
-- proved *whether* one happened.
--
-- The database cannot see the volume, so it cannot prove the bytes are gone. What it can refuse is a
-- completion that leaves no trace: the event and the state change now happen in one function, so a
-- deletion that is recorded is a deletion that is auditable, and a caller cannot have the first without the
-- second.
--
-- Stated plainly as a residual rather than dressed up: a worker that lies about the filesystem still lies,
-- and the record then says a deletion occurred when it did not. Closing that needs a check outside the
-- database — a reconciliation sweep comparing stored keys against the volume. It is not in this migration.

BEGIN;

-- Dropped rather than replaced: PostgreSQL will not rename an input parameter in place, and the fifth
-- argument stops being an ignored deletion time and becomes the cutoff the record describes.
DROP FUNCTION IF EXISTS complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz);

CREATE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_cutoff timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_storage_key text;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();
  -- The retention boundary this deletion acted on. Descriptive, not authority — and bounded to the present
  -- for the same reason the claim is, so the record cannot describe a policy window that has not arrived.
  -- The fifth parameter used to be a caller-chosen deletion time that the function ignored; an ignored
  -- parameter is worse than none, because a reader assumes it does something.
  v_cutoff timestamptz := least(coalesce(p_cutoff, now()), now());
BEGIN
  SELECT e.storage_key, e.uploaded_by INTO v_storage_key, v_actor
    FROM evidence_files e
   WHERE e.tenant_id = p_tenant_id AND e.id = p_evidence_id AND e.retention_status = 'deleting'
     AND e.retention_lease_owner = p_owner AND e.retention_generation = p_generation
     AND e.retention_lease_expires_at >= now();

  IF v_storage_key IS NULL THEN
    RETURN false;
  END IF;

  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = v_occurred,
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id;

  -- The record, in the same statement of intent as the state change. The chain lock is the same one
  -- `append_openppwr_audit_event` takes, so a concurrent legitimate append still serialises.
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));
  SELECT a.event_hash INTO v_previous FROM audit_events a ORDER BY a.sequence DESC LIMIT 1;
  v_previous := coalesce(v_previous, 'GENESIS');

  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, p_tenant_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
    jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff), v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (p_tenant_id, v_event_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
          jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff),
          v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN true;
END $$;

ALTER FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz) FROM openppwr_app;
GRANT EXECUTE ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz) TO openppwr_worker;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='complete_openppwr_retention'
                AND p.prosrc NOT LIKE '%INSERT INTO audit_events%') THEN
    RAISE EXCEPTION 'a completion that leaves no record is still reachable';
  END IF;
END $$;

COMMIT;
