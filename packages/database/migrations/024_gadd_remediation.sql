-- 024 — audit action authority, and the retention predicates 023 claimed and did not have
--
-- Eight findings, six High, none Critical and nothing regressed. Two are my own false statements rather
-- than defects I failed to foresee: migration 023 says three retention transitions require a live lease and
-- gave the predicate to two, and the test written to prove audit content is not caller-chosen appends an
-- arbitrary action itself.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- A registry that permits what it does not know is not a registry
--
-- The lookup returned NULL for an unregistered action and the function proceeded, so any principal holding
-- a valid credential could record `administrator.access.approved` with a correct chain hash. The registry
-- listed four actions and therefore constrained four.
--
-- It defaults to deny now. Actions are patterns because several are composed at runtime
-- (`evidence.${decision}`, `evidence.scan.${status}`), and a family is a deliberate entry rather than an
-- accident of matching.
DROP TABLE IF EXISTS audit_action_registry;

CREATE TABLE audit_action_registry (
  action_pattern text NOT NULL,
  allowed_principal text NOT NULL,
  PRIMARY KEY (action_pattern, allowed_principal)
);
REVOKE ALL ON audit_action_registry FROM PUBLIC;
ALTER TABLE audit_action_registry OWNER TO openppwr_security_owner;

-- Derived from the code that emits these, not guessed from a family name. The first version listed
-- `review.%` while `dossier-service.mjs` appends `review_snapshot.frozen`, so freezing a snapshot raised
-- 42501 and rolled the transaction back: a default-deny list built from a guess broke dossier generation,
-- and no gate caught it because none exercises that path.
--
-- Exact actions wherever the code writes a literal. Two are composed at runtime and their operands are
-- enumerated rather than wildcarded, because `evidence.scan.%` for the request role let it claim a scan
-- outcome it never produced.
INSERT INTO audit_action_registry (action_pattern, allowed_principal) VALUES
  -- The maintenance credential records its own reset and nothing else.
  ('demo.reset',                        'openppwr_maintenance'),

  -- The worker's own outcomes. `evidence.scan.${scanStatus}` over the scan_status domain.
  ('evidence.retention.deleted',        'openppwr_worker'),
  ('evidence.scan.pending',             'openppwr_worker'),
  ('evidence.scan.clean',               'openppwr_worker'),
  ('evidence.scan.infected',            'openppwr_worker'),
  ('evidence.scan.error',               'openppwr_worker'),
  ('evidence.scan.timeout',             'openppwr_worker'),
  ('evidence.scan.requires_attention',  'openppwr_worker'),
  ('evidence.quarantined',              'openppwr_worker'),

  -- The request path. An upload is scanned inline before a queue entry exists for it, so the same scan
  -- outcomes are reachable here; `evidence.retention.deleted` deliberately is not.
  ('evidence.scan.pending',             'openppwr_app'),
  ('evidence.scan.clean',               'openppwr_app'),
  ('evidence.scan.infected',            'openppwr_app'),
  ('evidence.scan.error',               'openppwr_app'),
  ('evidence.scan.timeout',             'openppwr_app'),
  ('evidence.scan.requeued',            'openppwr_app'),
  ('evidence.scan.requires_attention',  'openppwr_app'),
  ('evidence.quarantined',              'openppwr_app'),
  -- `evidence.${decision}` over the review_status domain.
  ('evidence.accepted',                 'openppwr_app'),
  ('evidence.rejected',                 'openppwr_app'),

  ('assessment.completed',              'openppwr_app'),
  ('assessment_linked',                 'openppwr_app'),
  ('reopened',                          'openppwr_app'),
  ('gap.assigned',                      'openppwr_app'),
  ('gap.remediated',                    'openppwr_app'),
  ('gap.reopened',                      'openppwr_app'),
  ('assigned',                          'openppwr_app'),
  ('remediation_evidence_added',        'openppwr_app'),

  ('import.accepted',                   'openppwr_app'),
  ('import.rejected',                   'openppwr_app'),

  ('review_snapshot.frozen',            'openppwr_app'),
  ('dossier.generated',                 'openppwr_app'),

  ('tenant.bootstrapped',               'openppwr_app');

-- ---------------------------------------------------------------------------------------------------
-- A caller must not choose when a deletion happened
--
-- A compromised worker called `claim_` with a cutoff of `infinity` and then `complete_` directly: the row
-- became `deleted` with a deletion time of the caller's choosing while the bytes stayed on the volume. The
-- cutoff is bounded to the present, and the deletion time comes from the server.
CREATE OR REPLACE FUNCTION claim_openppwr_retention(
  p_tenant_id uuid, p_cutoff timestamptz, p_owner uuid, p_lease_seconds integer
) RETURNS TABLE (evidence_id uuid, storage_key text, generation integer, operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  -- Never past the present. `infinity` made every retained row eligible regardless of its retention period.
  v_cutoff timestamptz := least(coalesce(p_cutoff, now()), now());
BEGIN
  SELECT e.id INTO v_id FROM evidence_files e
   WHERE e.tenant_id = p_tenant_id AND e.retention_status = 'retained'
     AND e.scan_status IN ('infected','error','timeout')
     AND e.review_status IN ('pending','rejected')
     AND e.created_at < v_cutoff
   ORDER BY e.created_at, e.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE evidence_files e
     SET retention_status = 'deleting',
         retention_lease_owner = p_owner,
         retention_lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 3600)),
         retention_generation = e.retention_generation + 1,
         retention_operation_id = gen_random_uuid()
   WHERE e.tenant_id = p_tenant_id AND e.id = v_id AND e.retention_status = 'retained'
  RETURNING e.id, e.storage_key, e.retention_generation, e.retention_operation_id;
END $$;

CREATE OR REPLACE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- `p_deleted_at` is accepted and ignored. A deletion happened when the database recorded it, not when the
  -- caller says it did, and a caller-chosen time is a caller-chosen history.
  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = now(),
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now();
  RETURN FOUND;
END $$;

-- The predicate migration 023 was described as having, and did not
--
-- Migration 023's comment claims `complete_`, `release_` and `mark_..._uncertain` all require a live lease.
-- It appears twice in that file. A lapsed claim could still reach a terminal state.
CREATE OR REPLACE FUNCTION mark_openppwr_retention_uncertain(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_status = 'integrity_unknown',
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now();
  RETURN FOUND;
END $$;

DO $$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'claim_openppwr_retention(uuid,timestamptz,uuid,integer)',
    'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz)',
    'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO openppwr_security_owner', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM openppwr_app', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openppwr_worker', v_signature);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- The same default-deny rule, continued: the append function refuses what it does not recognise
CREATE OR REPLACE FUNCTION append_openppwr_audit_event(
  p_actor_token_hash text, p_action text, p_entity_type text, p_entity_id text, p_payload jsonb
) RETURNS TABLE (event_id uuid, event_hash text, previous_hash text, tenant uuid, actor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller text := session_user;
  v_tenant uuid;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));

  IF p_action IS NULL OR length(p_action) = 0 OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Default deny. An action nobody registered is an action nobody authorised, and a registry that permits
  -- what it does not know constrains only what it happens to list.
  IF NOT EXISTS (
    SELECT 1 FROM audit_action_registry r
     WHERE r.allowed_principal = v_caller AND p_action LIKE r.action_pattern
  ) THEN
    RAISE EXCEPTION 'action % is not registered for %', p_action, v_caller
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_actor_token_hash IS NOT NULL THEN
    SELECT i.tenant_id, i.id INTO v_tenant, v_actor
      FROM identities i
     WHERE i.token_hash = p_actor_token_hash AND i.active = true
       AND (i.token_expires_at IS NULL OR i.token_expires_at > now());
    IF v_actor IS NULL THEN
      SELECT i.tenant_id, i.id INTO v_tenant, v_actor
        FROM auth_sessions s
        JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
       WHERE s.token_hash = p_actor_token_hash AND s.revoked_at IS NULL
         AND s.expires_at > now() AND i.active = true;
    END IF;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'audit actor credential is not valid' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'an audit event requires an actor credential' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.event_hash INTO v_previous FROM audit_events a ORDER BY a.sequence DESC LIMIT 1;
  v_previous := coalesce(v_previous, 'GENESIS');

  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, v_tenant, v_actor, p_action, p_entity_type, p_entity_id,
    coalesce(p_payload, '{}'::jsonb), v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (v_tenant, v_event_id, v_actor, p_action, p_entity_type, p_entity_id,
          coalesce(p_payload, '{}'::jsonb), v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN QUERY SELECT v_event_id, v_hash, v_previous, v_tenant, v_actor;
END $$;

ALTER FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  TO openppwr_app, openppwr_maintenance, openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- A timestamp nobody can render must not take verification down
--
-- A pre-023 chain can contain `occurred_at = 'infinity'`, written through the old caller-supplied path. The
-- verifier renders it through a JavaScript Date and throws, so one poisoned row made the whole chain
-- unverifiable rather than reported as broken.
--
-- The row is NOT rewritten. An audit chain that a migration edits is not an audit chain, and a recorded
-- event that cannot be rendered is a finding to surface rather than damage to conceal. The verifier reports
-- it as the broken row it is; the constraint stops another from being written.
--
-- NOT VALID on purpose: validating it would fail against exactly the poisoned rows this exists to describe,
-- and refusing to migrate is not better than refusing to insert.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_occurred_at_finite;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_occurred_at_finite
  CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz) NOT VALID;

-- ---------------------------------------------------------------------------------------------------
-- Assertions

DO $$
DECLARE v_problem text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='mark_openppwr_retention_uncertain'
                AND p.prosrc NOT LIKE '%retention_lease_expires_at >= now()%') THEN
    v_problem := 'the uncertain transition still accepts a lapsed claim';
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname='complete_openppwr_retention'
                   AND p.prosrc LIKE '%deleted_at = p_deleted_at%') THEN
    v_problem := 'the deletion time is still chosen by the caller';
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname='append_openppwr_audit_event'
                   AND p.prosrc NOT LIKE '%is not registered for%') THEN
    v_problem := 'the audit registry still permits what it does not list';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'Audit registry and retention predicate assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
