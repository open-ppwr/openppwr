-- 023 — caller-chosen audit content, and the retention fence that was not held
--
-- Six findings, two Critical. Each is the same family as the ones before it, and the audit-attribution one
-- is the cleanest statement of it yet: the caller's choice of *hash* was removed and its choice of
-- *content* was left.
-- A caller that picks the actor, the action and the time does not need to pick the digest.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- An expired credential still authorised
--
-- Actor resolution checked `active` and not `token_expires_at`, so a retired administrator token still
-- carried administrative authority. `authenticate_openppwr_token` has honoured expiry since migration 009;
-- this path simply did not ask.
CREATE OR REPLACE FUNCTION revoke_openppwr_identity_token(
  p_tenant_id uuid, p_actor_token_hash text, p_identity_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_id uuid;
  v_actor_role text;
BEGIN
  IF p_actor_token_hash IS NULL OR p_actor_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'actor credential required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT i.id, i.role INTO v_actor_id, v_actor_role
    FROM identities i
   WHERE i.tenant_id = p_tenant_id AND i.token_hash = p_actor_token_hash AND i.active = true
     AND (i.token_expires_at IS NULL OR i.token_expires_at > now());

  IF v_actor_id IS NULL THEN
    SELECT i.id, i.role INTO v_actor_id, v_actor_role
      FROM auth_sessions s
      JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
     WHERE s.tenant_id = p_tenant_id AND s.token_hash = p_actor_token_hash
       AND s.revoked_at IS NULL AND s.expires_at > now() AND i.active = true;
  END IF;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor credential is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_actor_id <> p_identity_id AND v_actor_role <> 'tenant_admin' THEN
    RAISE EXCEPTION 'not permitted to revoke another identity' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE identities SET active = false
   WHERE tenant_id = p_tenant_id AND id = p_identity_id AND active = true;
  RETURN FOUND;
END $$;

ALTER FUNCTION revoke_openppwr_identity_token(uuid, text, uuid) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION revoke_openppwr_identity_token(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_openppwr_identity_token(uuid, text, uuid) TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- A terminal transition must prove the claim is still live
--
-- `complete_`, `release_` and `mark_..._uncertain` required the owner and the generation and never asked
-- whether the lease had lapsed. A worker paused past its expiry could still land any of them, which is the
-- condition the lease exists to describe.

CREATE OR REPLACE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = p_deleted_at,
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now();
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION release_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_status = 'retained',
         retention_lease_owner = NULL, retention_lease_expires_at = NULL, retention_operation_id = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now();
  RETURN FOUND;
END $$;

-- The uncertain state must keep the fence
--
-- The worker called `release_` when a filesystem probe failed, and `release_` clears
-- `retention_operation_id`. So the one state that means "nobody can say where these bytes are" was reached
-- by erasing the name under which they would be found. The operation id is retained here, deliberately.
CREATE OR REPLACE FUNCTION mark_openppwr_retention_uncertain(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_status = 'integrity_unknown',
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation;
  RETURN FOUND;
END $$;

DO $$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz)',
    'release_openppwr_retention(uuid,uuid,uuid,integer)',
    'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO openppwr_security_owner', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM openppwr_app', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openppwr_worker', v_signature);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- The canonical encoding was not injective
--
-- `concat_ws(E'\n', …)` cannot distinguish a newline inside a field from the separator between two, so
-- `action = 'a' || E'\n' || 'b'` with `entity_type = 'c'` produced the same bytes as `action = 'a'` with
-- `entity_type = 'b' || E'\n' || 'c'`. Two different events, one digest, and a chain that cannot tell them
-- apart is not tamper-evident.
--
-- Length-prefixed instead, so no field content can imitate a boundary, and microseconds rather than
-- milliseconds, so two events in the same millisecond are still two events.
CREATE OR REPLACE FUNCTION openppwr_audit_canonical_hash_v2(
  p_event_id uuid, p_tenant_id uuid, p_actor_id uuid, p_action text,
  p_entity_type text, p_entity_id text, p_payload jsonb, p_occurred_at timestamptz, p_previous_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(digest(
    (SELECT string_agg(format('%s:%s', length(part), part), '' ORDER BY ordinality)
       FROM unnest(ARRAY[
         p_event_id::text,
         p_tenant_id::text,
         coalesce(p_actor_id::text, ''),
         p_action,
         p_entity_type,
         p_entity_id,
         coalesce(p_payload, '{}'::jsonb)::text,
         to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         p_previous_hash
       ]) WITH ORDINALITY AS entry(part, ordinality)),
    'sha256'), 'hex')
$$;

-- ---------------------------------------------------------------------------------------------------
-- Critical: the caller chose what was recorded about whom
--
-- The append function took the actor, the tenant, the action and the time as parameters. `openppwr_app`
-- could attribute any action to any actor at any moment — including `infinity`, which makes the JavaScript
-- verifier throw and takes verification down with it.
--
-- Removing the caller's choice of digest while leaving its choice of content changed nothing that mattered.
-- The actor is now resolved from a credential the caller must possess, the tenant from that actor, the time
-- from the server, and the action from a registry keyed by the calling principal.

CREATE TABLE IF NOT EXISTS audit_action_registry (
  action text PRIMARY KEY,
  allowed_principal text NOT NULL
);
REVOKE ALL ON audit_action_registry FROM PUBLIC;
ALTER TABLE audit_action_registry OWNER TO openppwr_security_owner;

INSERT INTO audit_action_registry (action, allowed_principal) VALUES
  ('demo.reset', 'openppwr_maintenance'),
  ('evidence.retention.deleted', 'openppwr_worker'),
  ('evidence.scan.completed', 'openppwr_worker'),
  ('evidence.scan.requeued', 'openppwr_worker')
ON CONFLICT (action) DO UPDATE SET allowed_principal = excluded.allowed_principal;

DROP FUNCTION IF EXISTS append_openppwr_audit_event(uuid, uuid, text, text, text, jsonb, timestamptz);

CREATE OR REPLACE FUNCTION append_openppwr_audit_event(
  p_actor_token_hash text, p_action text, p_entity_type text, p_entity_id text, p_payload jsonb
) RETURNS TABLE (event_id uuid, event_hash text, previous_hash text, tenant uuid, actor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller text := session_user;
  v_reserved text;
  v_tenant uuid;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();   -- never from the caller: `infinity` was a denial of service
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));

  IF p_action IS NULL OR length(p_action) = 0 OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- An action reserved to another principal cannot be recorded by this one, whatever it claims.
  SELECT r.allowed_principal INTO v_reserved FROM audit_action_registry r WHERE r.action = p_action;
  IF v_reserved IS NOT NULL AND v_reserved <> v_caller THEN
    RAISE EXCEPTION 'action % is reserved to %', p_action, v_reserved USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The actor, from a credential rather than from an assertion. `openppwr_app` cannot read `token_hash`, so
  -- presenting its digest is possession.
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
    -- The maintenance credential records the reset it performed. There is no user behind it, so the tenant
    -- comes from deployment metadata and the actor is unattributed rather than invented.
    IF v_caller <> 'openppwr_maintenance' THEN
      RAISE EXCEPTION 'an audit event requires an actor credential' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT d.tenant_id INTO v_tenant FROM deployment_metadata d WHERE d.singleton;
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'no deployment tenant to attribute the event to' USING ERRCODE = 'no_data_found';
    END IF;
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

ALTER FUNCTION openppwr_audit_canonical_hash_v2(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text)
  OWNER TO openppwr_security_owner;
ALTER FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_audit_canonical_hash_v2(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_audit_canonical_hash_v2(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text)
  TO openppwr_app, openppwr_maintenance, openppwr_worker;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  TO openppwr_app, openppwr_maintenance, openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- Assertions

DO $$
DECLARE v_problem text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='public' AND p.proname='append_openppwr_audit_event'
                AND pg_get_function_identity_arguments(p.oid) LIKE '%timestamp with time zone%') THEN
    v_problem := 'the caller-supplied timestamp signature still exists';
  ELSIF has_table_privilege('openppwr_app', 'audit_action_registry', 'UPDATE')
     OR has_table_privilege('openppwr_worker', 'audit_action_registry', 'INSERT') THEN
    v_problem := 'a runtime principal can rewrite the action registry';
  ELSIF openppwr_audit_canonical_hash_v2(
          '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, NULL,
          E'a\nb', 'c', 'x', '{}'::jsonb, '2026-01-01T00:00:00Z'::timestamptz, 'GENESIS')
        = openppwr_audit_canonical_hash_v2(
          '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, NULL,
          'a', E'b\nc', 'x', '{}'::jsonb, '2026-01-01T00:00:00Z'::timestamptz, 'GENESIS') THEN
    v_problem := 'the canonical encoding still collides across field boundaries';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'Audit attribution and retention fencing assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
