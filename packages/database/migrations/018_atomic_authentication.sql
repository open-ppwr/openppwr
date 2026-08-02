-- 018 — one atomic sign-in operation, and no generic session-minting primitive anywhere
--
-- Migration 016 revoked the application role's direct `INSERT` on `auth_sessions`, and that was
-- necessary but not sufficient. Sign-in was still two primitives held by one principal:
--
--   * `lookup_openppwr_demo_user(email)` returned the identity id, the password hash and the salt, having
--     authenticated nothing;
--   * `issue_openppwr_session(...)` accepted an identity and minted a session, having verified nothing.
--
-- A caller holding both needs neither. It reads a verifier for any address, then issues a session for the
-- identity that verifier belongs to — or for any other identity it likes. Splitting one operation into two
-- primitives and giving both to the same role does not create a boundary; it describes one.
--
-- This replaces them with a single operation that verifies and issues in one call, and removes the generic
-- issuer from the schema entirely. The scrypt derivation stays in the application, because PostgreSQL has no
-- scrypt — but the caller now *presents* a derived value instead of *receiving* the stored one, which is the
-- difference between proving possession and being told the answer.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------------
-- 1. The salt, which is not a secret
--
-- A caller cannot derive anything without the salt the stored hash was made with, so this has to be
-- readable. It is a salt: its purpose is to be unique per user, not hidden.
--
-- An unknown address gets a deterministic decoy derived from the address itself, so it is stable across
-- calls and indistinguishable from a real one. Returning nothing would turn this into an address oracle,
-- which is what the existing sign-in path takes care to avoid.
CREATE OR REPLACE FUNCTION openppwr_demo_login_salt(p_email text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT u.password_salt FROM demo_users u
      JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
      WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true),
    encode(digest('openppwr-decoy-salt:' || lower(coalesce(p_email, '')), 'sha256'), 'hex')
  )
$$;

REVOKE ALL ON FUNCTION openppwr_demo_login_salt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_demo_login_salt(text) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 2. Verify and issue, in one call
--
-- Everything the caller used to choose is derived here: the identity from the address, the tenant and role
-- from that identity, the expiry from server policy, and the session token from `gen_random_bytes`. The
-- caller supplies a credential and receives a session, and has no way to ask for a session it did not earn.
--
-- The token is returned once, in the clear, because that is what a session token is. Only its SHA-256 is
-- stored, matching `tokenHash` in the application so both sides agree on what a stored session looks like.
--
-- Residual, stated rather than hidden: the comparison below is not constant-time. The value compared is a
-- scrypt output rather than a password, recovering it by timing would take many thousands of attempts
-- against a limiter that counts every one, and the design it replaces handed the same value to the caller
-- outright. This is a smaller residual than the one it removes, and it is recorded as a residual.
CREATE OR REPLACE FUNCTION authenticate_openppwr_demo_login(
  p_email text, p_derived_hash text, p_ttl_seconds integer DEFAULT 43200
) RETURNS TABLE (session_token text, expires_at timestamptz, actor_role text, tenant uuid, identity uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user record;
  v_token text;
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

  PERFORM set_config('openppwr.tenant_id', v_user.tenant_id::text, true);
  INSERT INTO auth_sessions (tenant_id, id, identity_id, token_hash, expires_at)
  VALUES (v_user.tenant_id, gen_random_uuid(), v_user.identity_id,
          encode(digest(v_token, 'sha256'), 'hex'), v_expires);

  RETURN QUERY SELECT v_token, v_expires, v_user.role, v_user.tenant_id, v_user.identity_id;
END $$;

REVOKE ALL ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 3. The primitives that made the split possible
--
-- Dropped, not revoked. A revoked function is one GRANT away from returning, and there is no longer any
-- caller for either of these.
DROP FUNCTION IF EXISTS issue_openppwr_session(uuid, uuid, uuid, text, timestamptz);
DROP FUNCTION IF EXISTS lookup_openppwr_demo_user(text);

-- ---------------------------------------------------------------------------------------------------
-- 4. Token revocation needs an actor
--
-- `revoke_openppwr_identity_token(tenant, identity)` was callable by the application role for any identity
-- in the tenant, with no actor and no permission check. That is a denial of service against every operator
-- credential in the deployment, available to the role the API already holds.
--
-- The old signature is dropped so a caller cannot reach the unauthorised version, and the replacement takes
-- the actor explicitly: an identity may retire its own credential, and a tenant administrator may retire
-- another's. Anything else is refused as not-found, because a caller that may not act on a target must not
-- learn whether the target exists.
DROP FUNCTION IF EXISTS revoke_openppwr_identity_token(uuid, uuid);

CREATE OR REPLACE FUNCTION revoke_openppwr_identity_token(
  p_tenant_id uuid, p_actor_id uuid, p_identity_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_role text;
BEGIN
  SELECT i.role INTO v_actor_role
    FROM identities i
   WHERE i.tenant_id = p_tenant_id AND i.id = p_actor_id AND i.active = true;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_actor_id <> p_identity_id AND v_actor_role <> 'tenant_admin' THEN
    RAISE EXCEPTION 'not permitted to revoke another identity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE identities SET active = false
   WHERE tenant_id = p_tenant_id AND id = p_identity_id AND active = true;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION revoke_openppwr_identity_token(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_openppwr_identity_token(uuid, uuid, uuid) TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 5. Ownership and grants for the new functions
--
-- Migration 017's rule applies to everything added since: a definer function owned by the installer's
-- credential runs with whatever that credential holds.
ALTER FUNCTION openppwr_demo_login_salt(text) OWNER TO openppwr_security_owner;
ALTER FUNCTION authenticate_openppwr_demo_login(text, text, integer) OWNER TO openppwr_security_owner;
ALTER FUNCTION revoke_openppwr_identity_token(uuid, uuid, uuid) OWNER TO openppwr_security_owner;

-- ---------------------------------------------------------------------------------------------------
-- 6. Assertions

DO $$
DECLARE
  v_problem text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'issue_openppwr_session') THEN
    v_problem := 'the generic session-minting primitive still exists';
  ELSIF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'lookup_openppwr_demo_user') THEN
    v_problem := 'the verifier-returning lookup still exists';
  ELSIF has_function_privilege('openppwr_app', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the request-serving role can sign in on behalf of a user';
  ELSIF has_function_privilege('openppwr_app', 'openppwr_demo_login_salt(text)', 'EXECUTE') THEN
    v_problem := 'the request-serving role can enumerate sign-in salts';
  ELSIF has_function_privilege('public', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'PUBLIC can sign in';
  ELSIF NOT has_function_privilege('openppwr_auth', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the authentication role cannot sign a user in';
  ELSIF NOT has_function_privilege('openppwr_app', 'revoke_openppwr_identity_token(uuid,uuid,uuid)', 'EXECUTE') THEN
    v_problem := 'the request-serving role cannot retire a credential through the authorised path';
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner'
  ) THEN
    v_problem := 'a definer function is owned by something other than the security owner';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'atomic authentication assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
