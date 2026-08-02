-- 028 — the last of the audit-authority and retention corrections
--
-- Applied migrations remain unchanged. This migration gives the
-- standalone demonstration reset a maintenance-principal audit path, removes request-role scan-state
-- writes, and reserves every legacy tombstone suffix against new evidence rows.

BEGIN;

-- The API legitimately requeues a dead job, but direct UPDATE on either scan table also lets a compromised
-- request role declare arbitrary evidence clean. Keep the business operation; remove the underlying writes.
CREATE OR REPLACE FUNCTION requeue_openppwr_scan_job(
  p_job_id uuid, p_available_at timestamptz, p_actor_token_hash text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job record;
BEGIN
  SELECT id, evidence_id, attempts, infrastructure_attempts, last_error_code,
         last_failure_class, terminal_reason
    INTO v_job
    FROM scan_jobs
   WHERE tenant_id = openppwr_current_tenant() AND id = p_job_id AND status = 'dead'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE scan_jobs
     SET status = 'pending', attempts = 0, infrastructure_attempts = 0,
         last_error_code = NULL, last_failure_class = NULL, terminal_reason = NULL,
         terminal_at = NULL, available_at = p_available_at, updated_at = p_available_at
   WHERE tenant_id = openppwr_current_tenant() AND id = v_job.id AND status = 'dead';

  UPDATE evidence_files
     SET scan_status = 'pending'
   WHERE tenant_id = openppwr_current_tenant() AND id = v_job.evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan job evidence is absent' USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Audit is part of this operation, not a caller convention. A direct invocation without a credential
  -- raises inside append_openppwr_audit_event and rolls both scan-state writes back.
  PERFORM append_openppwr_audit_event(
    p_actor_token_hash, 'evidence.scan.requeued', 'evidence', v_job.evidence_id::text,
    jsonb_build_object(
      'jobId', v_job.id,
      'previousAttempts', v_job.attempts,
      'previousInfrastructureAttempts', v_job.infrastructure_attempts,
      'previousErrorCode', v_job.last_error_code,
      'previousFailureClass', v_job.last_failure_class,
      'previousTerminalReason', v_job.terminal_reason
    )
  );
  RETURN true;
END $$;

ALTER FUNCTION requeue_openppwr_scan_job(uuid, timestamptz, text) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION requeue_openppwr_scan_job(uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION requeue_openppwr_scan_job(uuid, timestamptz, text)
  FROM openppwr_auth, openppwr_maintenance, openppwr_worker;
GRANT EXECUTE ON FUNCTION requeue_openppwr_scan_job(uuid, timestamptz, text) TO openppwr_app;

REVOKE UPDATE ON scan_jobs FROM openppwr_app;
REVOKE UPDATE (scan_status) ON evidence_files FROM openppwr_app;

-- SECURITY DEFINER owner gets only columns required by the operation above. Runtime roles receive none of
-- these grants through membership: every runtime role is NOINHERIT and membership is asserted elsewhere.
GRANT SELECT ON scan_jobs TO openppwr_security_owner;
GRANT UPDATE (status, attempts, infrastructure_attempts, last_error_code, last_failure_class,
              terminal_reason, terminal_at, available_at, updated_at)
  ON scan_jobs TO openppwr_security_owner;
GRANT UPDATE (scan_status) ON evidence_files TO openppwr_security_owner;

-- Pre-027 recovery still recognises `storage_key || '.deleting[.*]'`. Existing deployments may already
-- contain such a legitimate key, so this upgrade constraint is NOT VALID: existing rows remain readable and
-- the recovery census protects them. PostgreSQL nevertheless enforces a NOT VALID CHECK for every new row
-- and storage_key update. Ownership therefore cannot change between that census and filesystem removal.
ALTER TABLE evidence_files
  DROP CONSTRAINT IF EXISTS evidence_files_legacy_tombstone_suffix_reserved;
ALTER TABLE evidence_files
  ADD CONSTRAINT evidence_files_legacy_tombstone_suffix_reserved
  CHECK (storage_key !~ '\.deleting($|\.)') NOT VALID;

-- A standalone operator reset has no requester bearer token. Its dedicated maintenance connection is the
-- authority, and only the two registered reset actions accept a NULL credential. The tenant comes from the
-- tenant entity named by the fixed reset callsite. The stable actor UUID denotes the maintenance principal;
-- audit_events.actor_id intentionally has no identity foreign key so service principals can be represented.
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));

  IF p_action IS NULL OR length(p_action) = 0 OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

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
  ELSIF v_caller = 'openppwr_maintenance'
        AND p_action IN ('demo.reset', 'demo.reset.completed')
        AND p_entity_type = 'tenant'
        AND p_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_tenant := p_entity_id::uuid;
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = v_tenant) THEN
      RAISE EXCEPTION 'maintenance audit tenant does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;
    v_actor := md5('openppwr_maintenance')::uuid;
    v_payload := v_payload || jsonb_build_object('servicePrincipal', v_caller);
  ELSE
    RAISE EXCEPTION 'an audit event requires an actor credential' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.event_hash INTO v_previous FROM audit_events a ORDER BY a.sequence DESC LIMIT 1;
  v_previous := coalesce(v_previous, 'GENESIS');
  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, v_tenant, v_actor, p_action, p_entity_type, p_entity_id,
    v_payload, v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (v_tenant, v_event_id, v_actor, p_action, p_entity_type, p_entity_id,
          v_payload, v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN QUERY SELECT v_event_id, v_hash, v_previous, v_tenant, v_actor;
END $$;

ALTER FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  FROM openppwr_auth;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  TO openppwr_app, openppwr_maintenance, openppwr_worker;

DO $$
BEGIN
  IF has_table_privilege('openppwr_app', 'scan_jobs', 'UPDATE') THEN
    RAISE EXCEPTION 'openppwr_app still holds table-wide UPDATE on scan_jobs';
  END IF;
  IF has_column_privilege('openppwr_app', 'scan_jobs', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'openppwr_app still writes scan job state directly';
  END IF;
  IF has_column_privilege('openppwr_app', 'evidence_files', 'scan_status', 'UPDATE') THEN
    RAISE EXCEPTION 'openppwr_app still writes evidence scan state directly';
  END IF;
  IF NOT has_function_privilege('openppwr_app', 'requeue_openppwr_scan_job(uuid,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('openppwr_worker', 'requeue_openppwr_scan_job(uuid,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('public', 'requeue_openppwr_scan_job(uuid,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'scan requeue function grants differ from the exact request-role boundary';
  END IF;
END $$;

COMMIT;
