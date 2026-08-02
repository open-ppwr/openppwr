-- 034 — a supported way to replace one identity's bearer credential
--
-- Until now, recovering from a leaked bearer token meant destroying the tenant. Tokens are stored as SHA-256
-- digests and nothing else, so no operator, and not the function owner either, can read one back out to hand
-- the holder a replacement. Provisioning is one-time: `bootstrap_openppwr_identities` refuses the moment any
-- identity exists, so a second bootstrap cannot mint a fresh credential. That is acceptable for a
-- demonstration deployment holding fictional data, and it was documented as such; for a self-hoster whose
-- credential leaks it is not a recovery story, it is the absence of one.
--
-- `rotate_openppwr_identity_token` from migration 009 is not that story either, for three reasons that
-- together are the design of what replaces it:
--
--   * it takes the *new hash* from the caller, so the caller chooses the credential. Migration 018 settled
--     this question for sign-in — the caller presents a derived value instead of receiving the stored one —
--     and the same answer applies here: the replacement is minted with `gen_random_bytes` inside the
--     function, where nobody can choose it;
--   * it takes the *old hash* as proof of possession, which only ever works for rotating your own credential.
--     An administrator recovering somebody else's leaked token does not hold the hash being replaced, and
--     could not obtain it, so the one case that matters was the one case the function could not serve;
--   * it writes no audit event and ends no session. A credential change with no record is not accountable,
--     and a rotation that leaves the identity's live sessions running has not revoked anything.
--
-- The old function stays in the schema for the migration credential, which is how an operator with database
-- access already repairs a deployment by hand. What it loses is the request-serving role's EXECUTE: two doors
-- into a credential write is one more than the boundary allows, and the supported door is below.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The action, registered
--
-- The registry added in migration 024 defaults to deny: an action nobody registered is an action nobody
-- authorised, and `append_openppwr_audit_event` refuses it whatever the caller holds. The lookup is against
-- `session_user`, which stays the connecting login role inside a SECURITY DEFINER function, so this row names
-- the principal the rotation route connects as rather than the function's owner.
--
-- Registered for `openppwr_auth` alone. The request-serving role has no rotation callsite and must not
-- acquire the authority to claim one happened.
INSERT INTO audit_action_registry (action_pattern, allowed_principal)
VALUES ('identity.credential.rotated', 'openppwr_auth')
ON CONFLICT (action_pattern, allowed_principal) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 2. Rotation
--
-- Everything the caller could get wrong is derived rather than accepted:
--
--   actor      from the credential presented, verified against the store, never from a parameter. A caller
--              that names its own actor names its own authority.
--   tenant     from that actor. The target must already be inside it, so a rotation cannot cross tenants
--              even if the caller knows an identifier in another one.
--   credential from `gen_random_bytes`, returned once in the clear and stored only as a digest — the same
--              shape as the session token minted in migration 018, and for the same reason.
--   validity   bounded to 1..365 days by server policy. The HTTP route does not expose it at all.
--
-- What is deliberately *not* written: role, tenant and supplier scope. The UPDATE names three columns, so
-- rotation cannot be a privilege-escalation path by construction rather than by review — there is no
-- parameter that could carry a role, and no branch that writes one.
CREATE OR REPLACE FUNCTION rotate_openppwr_identity_credential(
  p_actor_credential text, p_identity_id uuid, p_valid_days integer DEFAULT 90
) RETURNS TABLE (new_credential text, credential_expires_at timestamptz, revoked_sessions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_id uuid;
  v_actor_tenant uuid;
  v_actor_role text;
  v_target_id uuid;
  v_target_role text;
  v_target_supplier text;
  v_token text;
  v_expires timestamptz;
  v_revoked integer := 0;
BEGIN
  IF p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 365 THEN
    RAISE EXCEPTION 'credential validity must be between 1 and 365 days'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_actor_credential IS NULL OR length(p_actor_credential) = 0 THEN
    RAISE EXCEPTION 'rotation requires the credential of the identity performing it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The operator bearer branch first, then the interactive session branch, exactly as
  -- `authenticate_openppwr_token` resolves them. Both are accepted on purpose: the realistic recovery is an
  -- administrator whose bearer token leaked signing in with a password and replacing it, and refusing a
  -- session here would close the one path a compromised operator actually has.
  SELECT i.id, i.tenant_id, i.role INTO v_actor_id, v_actor_tenant, v_actor_role
    FROM identities i
   WHERE i.token_hash = p_actor_credential AND i.active = true AND i.token_expires_at > now();

  IF v_actor_id IS NULL THEN
    SELECT i.id, i.tenant_id, i.role INTO v_actor_id, v_actor_tenant, v_actor_role
      FROM auth_sessions s
      JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
     WHERE s.token_hash = p_actor_credential AND s.revoked_at IS NULL
       AND s.expires_at > now() AND i.active = true;
  END IF;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'the rotating credential is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT i.id, i.role, i.supplier_id INTO v_target_id, v_target_role, v_target_supplier
    FROM identities i
   WHERE i.id = p_identity_id AND i.tenant_id = v_actor_tenant AND i.active = true;

  -- One refusal for three different situations: the target does not exist, the target is in another tenant,
  -- and the actor is not entitled to rotate it. A caller that may not act on a target must not learn whether
  -- the target exists, and three distinguishable errors are three oracles.
  --
  -- The rule, stated once: an identity may replace its own credential, and a tenant administrator may replace
  -- any credential in its tenant. Self-service is not an entitlement anyone can be denied — it is proof of
  -- possession, and the holder already has everything the credential grants. Rotating on somebody else's
  -- behalf is an administrative act, and `credential:rotate` in apps/api/src/permissions.mjs names who holds
  -- it. This branch is the same rule enforced where it cannot be skipped.
  --
  -- `no_data_found` rather than `insufficient_privilege` on purpose. PostgreSQL raises 42501 for a missing
  -- grant as well, so mapping that to a not-found would hide a misconfigured deployment behind a route that
  -- appears not to exist.
  IF v_target_id IS NULL
     OR (v_actor_id <> v_target_id AND v_actor_role <> 'tenant_admin') THEN
    RAISE EXCEPTION 'no identity available to rotate' USING ERRCODE = 'no_data_found';
  END IF;

  v_expires := now() + make_interval(days => p_valid_days);
  v_token := 'opp_rot_' || encode(gen_random_bytes(24), 'hex');

  -- Recorded before the write, not after, and inside the same transaction as it. The actor's credential is
  -- still resolvable at this point; a self-service rotation would have destroyed its own attribution by
  -- appending afterwards. If the write below fails, the whole transaction goes and the event goes with it.
  --
  -- The payload carries no credential and no digest. It says who rotated what, and whether it was
  -- self-service, which is what an operator reading the record needs and the most an attacker reading it
  -- should get.
  PERFORM append_openppwr_audit_event(
    p_actor_credential, 'identity.credential.rotated', 'identity', v_target_id::text,
    jsonb_build_object(
      'targetRole', v_target_role,
      'targetSupplierId', v_target_supplier,
      'selfService', (v_actor_id = v_target_id),
      'validDays', p_valid_days
    )
  );

  UPDATE identities
     SET token_hash = encode(digest(v_token, 'sha256'), 'hex'),
         token_expires_at = v_expires,
         token_rotated_at = now()
   WHERE tenant_id = v_actor_tenant AND id = v_target_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no identity available to rotate' USING ERRCODE = 'no_data_found';
  END IF;

  -- The credential is compromised, so the identity is compromised. A session outlives the bearer token it
  -- accompanies — it carries its own hash and its own expiry — so replacing the token alone would leave the
  -- attacker holding a working credential for up to another twelve hours.
  UPDATE auth_sessions
     SET revoked_at = now()
   WHERE tenant_id = v_actor_tenant AND identity_id = v_target_id
     AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  RETURN QUERY SELECT v_token, v_expires, v_revoked;
END $$;

-- Migration 017's rule applies to everything added since: a definer function owned by the installer's
-- credential runs with whatever that credential happens to hold.
ALTER FUNCTION rotate_openppwr_identity_credential(text, uuid, integer)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION rotate_openppwr_identity_credential(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION rotate_openppwr_identity_credential(text, uuid, integer)
  FROM openppwr_app, openppwr_maintenance, openppwr_worker;

-- The credential principal, and nobody else. `openppwr_auth` is the role migration 014 created to hold
-- credential operations away from the role that serves requests, it holds no table grants at all after
-- migration 016, and `openppwr_app` can neither inherit it nor SET ROLE to it. Granting this to the
-- request-serving role would put a credential write back on the connection that answers every HTTP request,
-- which is the boundary migrations 013, 014 and 016 each restored in turn.
GRANT EXECUTE ON FUNCTION rotate_openppwr_identity_credential(text, uuid, integer) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 3. The unaudited door
--
-- Revoked, not dropped. The migration credential still needs a way to repair a deployment by hand, and
-- `scripts/acme/demo-reset.test.mjs` exercises it on that credential. What it must not be is a second route
-- to a credential write from the connection that serves requests — one that records nothing and revokes no
-- session, sitting beside the one that does both.
REVOKE EXECUTE ON FUNCTION rotate_openppwr_identity_token(uuid, uuid, text, text, integer) FROM openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- Written as the reviewer's questions rather than as the migration's intent, and failing here rather than at
-- the next install.

DO $$
DECLARE
  v_problem text;
BEGIN
  IF has_function_privilege('public', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'PUBLIC may rotate a credential';
  ELSIF has_function_privilege('openppwr_app', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the request-serving role may rotate a credential';
  ELSIF has_function_privilege('openppwr_worker', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the worker principal may rotate a credential';
  ELSIF has_function_privilege('openppwr_maintenance', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the maintenance principal may rotate a credential';
  ELSIF has_function_privilege('openppwr_app', 'rotate_openppwr_identity_token(uuid,uuid,text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the request-serving role kept the unaudited rotation path';
  ELSIF has_table_privilege('openppwr_app', 'identities', 'UPDATE') THEN
    v_problem := 'the request-serving role may write a credential directly';
  ELSIF has_table_privilege('openppwr_auth', 'identities', 'UPDATE') THEN
    v_problem := 'the credential principal may write a credential without the function';
  ELSIF has_table_privilege('openppwr_auth', 'auth_sessions', 'UPDATE') THEN
    v_problem := 'the credential principal may revoke sessions without the function';

  -- The capability that must survive, so the boundary cannot be satisfied by revoking everything.
  ELSIF NOT has_function_privilege('openppwr_auth', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the credential principal cannot perform the rotation it exists for';
  ELSIF NOT EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'identity.credential.rotated' AND allowed_principal = 'openppwr_auth'
  ) THEN
    v_problem := 'the rotation action is not registered and every rotation would be refused';
  ELSIF EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'identity.credential.rotated' AND allowed_principal <> 'openppwr_auth'
  ) THEN
    v_problem := 'a principal with no rotation callsite may claim a rotation happened';
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner'
  ) THEN
    v_problem := 'a definer function is owned by something other than the security owner';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'credential rotation assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
