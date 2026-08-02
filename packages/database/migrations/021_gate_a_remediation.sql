-- 021 — privileged capability moved behind functions, as one package
--
-- Twelve findings, one Critical. Every one is the same shape found before: a control
-- placed where it looks authoritative while the capability it guards stays reachable another way. Two are
-- the recorded habits verbatim, written into the code in the same session the habits were written down.
--
--   * the decoy salt is 64 hex characters and a real one is 32, so `length()` enumerates accounts
--   * the revocation function takes the actor id *from the caller*
--   * renewal has no unexpired predicate, so a lost lease renews itself back into ownership
--   * `openppwr_app` holds table-wide UPDATE on evidence_files and can roll the fence back
--   * `current_user` inside a SECURITY DEFINER function is the *owner*, so the role check never fired
--   * the append function validated the shape of the digests and not their content
--   * the audit lock is per tenant while the chain is global

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- A decoy that is a different length is not a decoy
--
-- The stored salt is 16 random bytes as hex: 32 characters. The decoy was a SHA-256 digest: 64. No timing
-- measurement was needed — `length(salt)` answered "does this account exist".
CREATE OR REPLACE FUNCTION openppwr_demo_login_salt(p_email text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT u.password_salt FROM demo_users u
      JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
      WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true),
    substring(encode(digest('openppwr-decoy-salt:' || lower(coalesce(p_email, '')), 'sha256'), 'hex') from 1 for 32)
  )
$$;
ALTER FUNCTION openppwr_demo_login_salt(text) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_demo_login_salt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_demo_login_salt(text) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- An actor the caller names is not an authenticated actor
--
-- The previous version looked up the role of whatever identity id it was handed. `openppwr_app` supplies a
-- known tenant_admin id and revokes anything. My own "authorised paths still work" test performed exactly
-- that call and read as a demonstration that the boundary worked.
--
-- The actor is now resolved from a credential the caller must possess. `openppwr_app` cannot read
-- `token_hash`, so presenting its digest is proof rather than assertion.
DROP FUNCTION IF EXISTS revoke_openppwr_identity_token(uuid, uuid, uuid);

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

  -- Either an operator token or a live session proves who is asking, exactly as authentication does.
  SELECT i.id, i.role INTO v_actor_id, v_actor_role
    FROM identities i
   WHERE i.tenant_id = p_tenant_id AND i.token_hash = p_actor_token_hash AND i.active = true;

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
-- The fence was in a function and the capability was in a grant
--
-- `openppwr_app` held table-wide UPDATE, so it could roll the generation back, reuse an operation id,
-- rewrite the owner and expiry, or move `integrity_unknown` to any status the CHECK allows. Every retention
-- transition therefore moves behind a function, and the role keeps UPDATE only on the columns the review
-- and scan workflows legitimately write.
REVOKE UPDATE ON evidence_files FROM openppwr_app;
GRANT UPDATE (scan_status, review_status, reviewed_by, reviewed_at, rejection_code)
  ON evidence_files TO openppwr_app;
GRANT SELECT, UPDATE ON evidence_files TO openppwr_security_owner;

-- Claim: compare-and-set from `retained`, taking a fresh operation id.
CREATE OR REPLACE FUNCTION claim_openppwr_retention(
  p_tenant_id uuid, p_cutoff timestamptz, p_owner uuid, p_lease_seconds integer
) RETURNS TABLE (evidence_id uuid, storage_key text, generation integer, operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT e.id INTO v_id FROM evidence_files e
   WHERE e.tenant_id = p_tenant_id AND e.retention_status = 'retained'
     AND e.scan_status IN ('infected','error','timeout')
     AND e.review_status IN ('pending','rejected')
     AND e.created_at < p_cutoff
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

-- Reclaim: only an expired claim, and the operation id is preserved because this pass is finishing the
-- same filesystem operation the abandoned worker started.
CREATE OR REPLACE FUNCTION reclaim_openppwr_retention(
  p_tenant_id uuid, p_owner uuid, p_lease_seconds integer
) RETURNS TABLE (evidence_id uuid, storage_key text, generation integer, operation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT e.id INTO v_id FROM evidence_files e
   WHERE e.tenant_id = p_tenant_id AND e.retention_status = 'deleting'
     AND (e.retention_lease_expires_at IS NULL OR e.retention_lease_expires_at < now())
   ORDER BY e.created_at, e.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE evidence_files e
     SET retention_lease_owner = p_owner,
         retention_lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 3600)),
         retention_generation = e.retention_generation + 1
   WHERE e.tenant_id = p_tenant_id AND e.id = v_id AND e.retention_status = 'deleting'
  RETURNING e.id, e.storage_key, e.retention_generation, e.retention_operation_id;
END $$;

-- The three terminal transitions. Each requires the exact claim, so a worker that lost its lease cannot
-- land any of them.
CREATE OR REPLACE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = p_deleted_at,
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation;
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
     AND retention_lease_owner = p_owner AND retention_generation = p_generation;
  RETURN FOUND;
END $$;

-- Terminal by design: `integrity_unknown` means nobody can assert where the bytes are, and no automatic
-- transition out of it is honest. Only an operator, on the migration credential, can resolve it.
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

-- Renewal must prove the claim is still live. Without the predicate, a worker whose lease
-- expired renewed itself back into ownership, which is the opposite of what a lease is for. The duration is
-- also bounded, so a caller cannot ask for a claim that never expires.
CREATE OR REPLACE FUNCTION renew_openppwr_retention_lease(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer, p_lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE evidence_files
     SET retention_lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 3600))
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now();
  RETURN FOUND;
END $$;

DO $$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'claim_openppwr_retention(uuid,timestamptz,uuid,integer)',
    'reclaim_openppwr_retention(uuid,uuid,integer)',
    'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz)',
    'release_openppwr_retention(uuid,uuid,uuid,integer)',
    'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)',
    'renew_openppwr_retention_lease(uuid,uuid,uuid,integer,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO openppwr_security_owner', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openppwr_app', v_signature);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- The audit chain: content, calling principal, and the scope of the lock
--
-- The append function validated that the digests *looked* like digests. A caller read the tail, supplied it
-- as the link, and then supplied any actor, action and payload with a hash of its choosing: a random one
-- breaks verification permanently, a computed one forges an event attributed to someone else.
--
-- I kept the encoder in the application to avoid two encoders drifting, and defended that twice. The
-- decision was defensible; the consequence I drew from it was not. **Validating linkage without validating
-- content is not integrity.**
--
-- So there is still exactly one encoder — it moves here. The caller supplies the event and no hashes at
-- all, and cannot choose what is recorded about whom. Rows written by the previous encoder keep their
-- algorithm marker and are verified the old way, so no existing chain is invalidated.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS hash_algorithm text NOT NULL DEFAULT 'js-canonical-v1';

-- The canonical bytes, defined once. `jsonb` normalises key order and whitespace, so a payload has exactly
-- one spelling; the timestamp is rendered in UTC with milliseconds; every field is separated by a byte that
-- cannot occur inside the fields themselves.
CREATE OR REPLACE FUNCTION openppwr_audit_canonical_hash(
  p_event_id uuid, p_tenant_id uuid, p_actor_id uuid, p_action text,
  p_entity_type text, p_entity_id text, p_payload jsonb, p_occurred_at timestamptz, p_previous_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(digest(
    concat_ws(E'\n',
      p_event_id::text,
      p_tenant_id::text,
      coalesce(p_actor_id::text, ''),
      p_action,
      p_entity_type,
      p_entity_id,
      coalesce(p_payload, '{}'::jsonb)::text,
      to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      p_previous_hash
    ), 'sha256'), 'hex')
$$;

DROP FUNCTION IF EXISTS append_openppwr_audit_event(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text, text);

CREATE OR REPLACE FUNCTION append_openppwr_audit_event(
  p_tenant_id uuid, p_actor_id uuid, p_action text,
  p_entity_type text, p_entity_id text, p_payload jsonb, p_occurred_at timestamptz
) RETURNS TABLE (event_id uuid, event_hash text, previous_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller text := session_user;   -- inside a definer function `current_user` is the *owner*
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := coalesce(p_occurred_at, now());
BEGIN
  -- The chain is global, so the lock must be. A per-tenant key let concurrent first appends in
  -- two tenants both read the same tail and produce two events claiming the same predecessor.
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));

  IF p_action IS NULL OR length(p_action) = 0 OR p_tenant_id IS NULL OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The maintenance credential exists to reset a demonstration environment and to record that it did.
  IF v_caller = 'openppwr_maintenance' AND p_action <> 'demo.reset' THEN
    RAISE EXCEPTION 'the maintenance principal may only record its own reset'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.event_hash INTO v_previous FROM audit_events a ORDER BY a.sequence DESC LIMIT 1;
  v_previous := coalesce(v_previous, 'GENESIS');

  v_hash := openppwr_audit_canonical_hash(
    v_event_id, p_tenant_id, p_actor_id, p_action, p_entity_type, p_entity_id,
    coalesce(p_payload, '{}'::jsonb), v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (p_tenant_id, v_event_id, p_actor_id, p_action, p_entity_type, p_entity_id,
          coalesce(p_payload, '{}'::jsonb), v_occurred, v_previous, v_hash, 'sql-canonical-v1');

  RETURN QUERY SELECT v_event_id, v_hash, v_previous;
END $$;

ALTER FUNCTION openppwr_audit_canonical_hash(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text)
  OWNER TO openppwr_security_owner;
ALTER FUNCTION append_openppwr_audit_event(uuid, uuid, text, text, text, jsonb, timestamptz)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_audit_canonical_hash(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(uuid, uuid, text, text, text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_audit_canonical_hash(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text)
  TO openppwr_app, openppwr_maintenance;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(uuid, uuid, text, text, text, jsonb, timestamptz)
  TO openppwr_app, openppwr_maintenance;

-- ---------------------------------------------------------------------------------------------------
-- Assertions

DO $$
DECLARE
  v_problem text;
BEGIN
  IF has_table_privilege('openppwr_app', 'evidence_files', 'UPDATE') THEN
    v_problem := 'the request-serving role holds table-wide UPDATE on evidence_files';
  ELSIF has_column_privilege('openppwr_app', 'evidence_files', 'retention_generation', 'UPDATE') THEN
    v_problem := 'the request-serving role can roll the retention generation back';
  ELSIF has_column_privilege('openppwr_app', 'evidence_files', 'retention_status', 'UPDATE') THEN
    v_problem := 'the request-serving role can rewrite retention state directly';
  ELSIF NOT has_column_privilege('openppwr_app', 'evidence_files', 'review_status', 'UPDATE') THEN
    v_problem := 'the review workflow can no longer record a decision';
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prosecdef
                   AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner') THEN
    v_problem := 'a definer function is owned by something other than the security owner';
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'append_openppwr_audit_event'
                   AND pg_get_function_identity_arguments(p.oid) LIKE '%text, text') THEN
    v_problem := 'the caller-supplied-hash append function still exists';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'Privilege separation assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
