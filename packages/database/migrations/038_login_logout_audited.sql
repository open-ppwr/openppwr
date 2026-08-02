-- 038 — sign-in and sign-out are mutations too
--
-- Migration 034 recorded credential rotation because rotation replaces a credential, and a credential change
-- with no record is not accountable. Sign-in and sign-out are the same class of event by the same argument:
-- one mints a session and one ends it, and both were silent. An operator reading the audit chain could see a
-- credential rotated, a tenant reset, an import accepted, a gap remediated — and nothing about who was signed
-- in when any of it happened, or who signed out and when. `identity.credential.rotated` proved the pattern
-- works for a security-sensitive identity operation; this applies it to the two that predate it.
--
-- Both append inside the SECURITY DEFINER function that already performs the write, in the same transaction,
-- for the reason 026 gives for retention completion and 034 gives for rotation: an append recorded afterwards,
-- from application code on a separate round trip, can succeed while the write it describes fails, or the
-- reverse. One transaction or none was ever the honest choice.
--
-- Neither needed a new capability. `append_openppwr_audit_event` already resolves an actor from a presented
-- credential hash against `identities` or `auth_sessions` — that is exactly the lookup sign-in and sign-out
-- already do to authenticate, or, for sign-in, the row it has just inserted in this same transaction.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The actions, registered
--
-- `auth.login.succeeded` for `openppwr_auth` alone: that is the only login role and the only session_user a
-- successful demonstration sign-in ever runs as. `session.revoked` for `openppwr_app`: `/v1/logout` runs on
-- the request-serving pool, never on the authentication credential.
INSERT INTO audit_action_registry (action_pattern, allowed_principal) VALUES
  ('auth.login.succeeded', 'openppwr_auth'),
  ('session.revoked', 'openppwr_app')
ON CONFLICT (action_pattern, allowed_principal) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 2. Sign-in records itself
--
-- Reproduced from migration 018 with three additions: the token hash is computed once into a variable
-- instead of inline in the `INSERT`, so the same value can be presented to the append below; and the append
-- itself, placed after the session row exists rather than before it — the actor here is the session just
-- issued, and `append_openppwr_audit_event`'s session branch can only resolve a row that is already there.
-- Failure to record is failure to sign in: both statements are one transaction, and a broken registry entry
-- must refuse the sign-in rather than issue a credential nothing will ever show was issued.
--
-- Nothing here weakens the one-message-per-failure property above it: every failing branch still `RETURN`s
-- before a token exists, so no audit event is ever produced for a wrong password or an unknown address —
-- there is no identity yet for such an event to name, and inventing one attributed to nobody would be the
-- caller-chosen-actor defect migration 020 removed.
CREATE OR REPLACE FUNCTION authenticate_openppwr_demo_login(
  p_email text, p_derived_hash text, p_ttl_seconds integer DEFAULT 43200
) RETURNS TABLE (session_token text, expires_at timestamptz, actor_role text, tenant uuid, identity uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user record;
  v_token text;
  v_token_hash text;
  v_expires timestamptz;
  v_ceiling constant interval := interval '24 hours';
BEGIN
  IF p_email IS NULL OR p_derived_hash IS NULL OR length(p_derived_hash) = 0 THEN
    RETURN;
  END IF;

  SELECT u.tenant_id, u.identity_id, u.password_hash, i.role
    INTO v_user
    FROM demo_users u
    JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
   WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true;

  -- One outcome for an unknown address and a wrong credential: no rows. The caller emits one message.
  IF NOT FOUND OR v_user.password_hash IS DISTINCT FROM p_derived_hash THEN
    RETURN;
  END IF;

  -- Bounded by server policy, never by the caller. A caller may ask for less and never for more.
  v_expires := least(now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 43200), 60)), now() + v_ceiling);

  v_token := 'opp_sess_' || encode(gen_random_bytes(24), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

  PERFORM set_config('openppwr.tenant_id', v_user.tenant_id::text, true);
  INSERT INTO auth_sessions (tenant_id, id, identity_id, token_hash, expires_at)
  VALUES (v_user.tenant_id, gen_random_uuid(), v_user.identity_id, v_token_hash, v_expires);

  -- The actor is the session just minted, resolved by `append_openppwr_audit_event` the same way any other
  -- caller of this session token will be resolved. The payload carries the role that signed in and nothing
  -- that could be replayed as a credential.
  PERFORM append_openppwr_audit_event(
    v_token_hash, 'auth.login.succeeded', 'identity', v_user.identity_id::text,
    jsonb_build_object('role', v_user.role)
  );

  RETURN QUERY SELECT v_token, v_expires, v_user.role, v_user.tenant_id, v_user.identity_id;
END $$;

-- CREATE OR REPLACE keeps the existing owner and ACL because the signature is unchanged; restated so a
-- reader does not have to return to migration 018 to find out who may call this.
ALTER FUNCTION authenticate_openppwr_demo_login(text, text, integer) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 3. Sign-out records itself
--
-- Reproduced from migration 005 with one addition. The session's own `token_hash` is read before it is
-- revoked — not a new parameter threaded up through `revokeSession` and the `/v1/logout` route, because the
-- row already holds exactly the credential that authenticated this request, and reading it here is the same
-- lookup `authenticate_openppwr_token` already performs against the same table. Recorded before the `UPDATE`,
-- in the same transaction, for the reason migration 034 gives for rotation: appending after `revoked_at` is
-- set would ask the resolver to find an actor in a session it had just ended, and it would not find one.
--
-- Firing only when a row was actually found and not already revoked keeps the existing property that signing
-- out twice, or presenting a session identifier for a session that has already ended, is not an error and
-- produces no event — there is nothing new happening for such an event to describe.
CREATE OR REPLACE FUNCTION revoke_openppwr_session(p_tenant_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
  v_token_hash text;
  v_identity_id uuid;
BEGIN
  SELECT token_hash, identity_id INTO v_token_hash, v_identity_id
    FROM auth_sessions
   WHERE id = p_session_id AND tenant_id = p_tenant_id AND revoked_at IS NULL;

  IF v_token_hash IS NULL THEN
    RETURN false;
  END IF;

  PERFORM append_openppwr_audit_event(
    v_token_hash, 'session.revoked', 'identity', v_identity_id::text,
    jsonb_build_object('sessionId', p_session_id)
  );

  UPDATE auth_sessions
     SET revoked_at = now()
   WHERE id = p_session_id
     AND tenant_id = p_tenant_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

ALTER FUNCTION revoke_openppwr_session(uuid, uuid) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION revoke_openppwr_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_openppwr_session(uuid, uuid) TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- Written as the reviewer's questions, and failing here rather than at the next install.

DO $$
DECLARE
  v_problem text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'auth.login.succeeded' AND allowed_principal = 'openppwr_auth'
  ) THEN
    v_problem := 'sign-in would be refused: the audit append inside it has nothing to register against';
  ELSIF EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'auth.login.succeeded' AND allowed_principal <> 'openppwr_auth'
  ) THEN
    v_problem := 'a principal with no sign-in callsite may claim a sign-in happened';
  ELSIF NOT EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'session.revoked' AND allowed_principal = 'openppwr_app'
  ) THEN
    v_problem := 'sign-out would be refused: the audit append inside it has nothing to register against';
  ELSIF EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'session.revoked' AND allowed_principal <> 'openppwr_app'
  ) THEN
    v_problem := 'a principal with no sign-out callsite may claim a sign-out happened';
  ELSIF NOT has_function_privilege('openppwr_auth', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the authentication role lost its ability to sign a user in';
  ELSIF NOT has_function_privilege('openppwr_app', 'revoke_openppwr_session(uuid,uuid)', 'EXECUTE') THEN
    v_problem := 'the request-serving role lost its ability to sign a user out';
  ELSIF has_function_privilege('public', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE')
     OR has_function_privilege('public', 'revoke_openppwr_session(uuid,uuid)', 'EXECUTE') THEN
    v_problem := 'PUBLIC may sign a user in or out';
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('authenticate_openppwr_demo_login', 'revoke_openppwr_session')
       AND p.prosecdef AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner'
  ) THEN
    v_problem := 'a definer function is owned by something other than the security owner';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'login/logout audit assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
