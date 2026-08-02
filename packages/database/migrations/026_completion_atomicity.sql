-- 026 — one statement, and an actor that presented a credential
--
-- Migration 025 moved the audit record inside the completion so that a deletion could not be recorded
-- without a trace. In doing so it introduced two defects of its own.
--
-- The first is a check-then-act. 025 validated the claim with an unlocked SELECT and then issued an
-- UPDATE keyed only on tenant and id. Between the two, another worker can reclaim the row and change the
-- owner and generation; the first worker's UPDATE then overwrites that claim and completes a generation
-- that no longer exists. Every predicate that made the fence work was present in the SELECT and absent from
-- the write — which is the same compare-and-set I had already got right in 021 and took apart in 025.
--
-- The second is attribution. 025 wrote `actor_id = uploaded_by`: the person who uploaded the evidence, who
-- did not perform the deletion, did not present a credential, and may no longer be active. The generic
-- append function refuses exactly that, and writing the row directly walked around it.

BEGIN;

DROP FUNCTION IF EXISTS complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz);

CREATE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer,
  p_cutoff timestamptz, p_actor_token_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_storage_key text;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();
  v_cutoff timestamptz := least(coalesce(p_cutoff, now()), now());
BEGIN
  -- The actor is whoever presented a credential, resolved the same way the canonical append resolves it.
  -- The worker holds its own token; nobody else's identity is attributed to work it did not do.
  IF p_actor_token_hash IS NULL OR p_actor_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'a completion must be attributed to a presented credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT i.id INTO v_actor
    FROM identities i
   WHERE i.tenant_id = p_tenant_id AND i.token_hash = p_actor_token_hash AND i.active = true
     AND (i.token_expires_at IS NULL OR i.token_expires_at > now());

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'completion actor credential is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- One statement. The claim is checked and consumed together, so nothing can reclaim the row between the
  -- two — there is no between.
  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = v_occurred,
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now()
  RETURNING storage_key INTO v_storage_key;

  IF v_storage_key IS NULL THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));
  SELECT a.event_hash INTO v_previous FROM audit_events a ORDER BY a.sequence DESC LIMIT 1;
  v_previous := coalesce(v_previous, 'GENESIS');

  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, p_tenant_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
    jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff),
    v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (p_tenant_id, v_event_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
          jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff),
          v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN true;
END $$;

ALTER FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text) TO openppwr_worker;

-- `scripts/acme/demo-reset` records `demo.reset.completed`, which no pattern matched, so the
-- reset raised 42501 against a migrated database. The registry is only as good as the enumeration, and this
-- one was enumerated from `apps/` and missed `scripts/`.
INSERT INTO audit_action_registry (action_pattern, allowed_principal) VALUES
  ('demo.reset.completed', 'openppwr_maintenance')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='complete_openppwr_retention'
                AND p.prosrc LIKE '%SELECT e.storage_key%') THEN
    RAISE EXCEPTION 'the completion still validates with a separate read before it writes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='complete_openppwr_retention'
                AND p.prosrc LIKE '%uploaded_by%') THEN
    RAISE EXCEPTION 'the completion still attributes the deletion to the uploader';
  END IF;
END $$;

COMMIT;
