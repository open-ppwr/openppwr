-- SPDX-License-Identifier: Apache-2.0
-- 039 — a machine identity has no password, on a deployment that already gave it one
--
-- The demonstration bootstrap created a password account for all nine roles while `/v1/demo/accounts`
-- announced seven. `worker@<domain>` and `service-account@<domain>` therefore held the published
-- demonstration password at a predictable address, on the default demonstration posture, announced by
-- nothing. Probed over real HTTP before the application fix:
--
--   login worker@<domain>          -> 200  role=worker           permissions=scan:process
--   login service-account@<domain> -> 200  role=service_account
--                                    permissions=read, assessment:run, dossier:generate, dossier:download
--
-- `service_account` is the worse of the two: it reads the whole tenant, runs assessments, and generates and
-- downloads the dossiers.
--
-- That fix stopped the accounts from being *created*. It could not touch a deployment that was bootstrapped
-- before it, and two of this project's own deployments are in exactly that state right now: the rows are
-- still there, and neither half of sign-in has ever asked what kind of identity is signing in. So this
-- migration does the two things application code cannot do for a database that already exists.
--
--   1. **The rows go.** The account is what grants the access, so the account is what must not exist. A
--      refusal layered over a live credential is one forgotten check away from being no refusal at all —
--      which is precisely the history above.
--   2. **The credential becomes unreachable for a machine role in the database.** Deleting alone is a
--      one-time repair with no memory: an older image's bootstrap, a restored backup, or one hand-written
--      INSERT puts the row back, and nothing would refuse it. `openppwr_demo_login_salt` and
--      `authenticate_openppwr_demo_login` — the two functions sign-in actually consists of — now resolve a
--      machine identity the way they resolve an address that does not exist. Both, not one: the salt
--      function answers "does this account exist" to anyone who can compute the decoy, so filtering only
--      the verifier would leave an oracle for the account it refuses.
--
-- No audit event is appended for the deletion, and that is deliberate rather than overlooked.
-- `append_openppwr_audit_event` resolves its actor from a presented credential (migration 020); a migration
-- presents none, and attributing this to an invented actor is the caller-chosen-actor defect that migration
-- removed. The record that this happened is `openppwr_schema_migrations`, which is where the record of a
-- schema change belongs.
--
-- ---------------------------------------------------------------------------------------------------
-- Which roles are machine roles, and why they are written here at all
--
-- The database already knows the *nine* roles: `identities.role` carries a CHECK that enumerates them, and
-- the assertions below read that enumeration rather than repeat it. What the database has never known is
-- which of the nine a person signs in as. That split lives in `apps/api/src/permissions.mjs`
-- (`HUMAN_ROLES` / `MACHINE_ROLES`) and in nothing else, and a boundary this migration is enforcing cannot
-- be enforced against a list held only in a process that is not running.
--
-- So it is stated once, in `openppwr_machine_roles()`, and every use in this migration and afterwards reads
-- that function. Not repeated in the DELETE, not repeated in either sign-in function, not repeated in the
-- assertions. What the assertions then check is that the list is *not* free-floating: every role it names
-- must be a role the CHECK permits, so a typo or a renamed role fails here rather than silently protecting
-- nothing; and it must leave roles behind, so a list that grew to cover everything would fail rather than
-- quietly disable sign-in for the whole product. `apps/api/test/login.integration.test.mjs` closes the
-- remaining direction by comparing this function to `MACHINE_ROLE_NAMES`, so the two cannot drift apart.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 0. The authority this migration needs, stated rather than assumed
--
-- `demo_users` carries FORCE ROW LEVEL SECURITY and a policy keyed on `openppwr.tenant_id`, which a
-- migration does not set. Without the ability to bypass that policy, the DELETE below would match no row
-- and the assertion that no row remains would also match no row: the migration would report success having
-- done nothing, on precisely the deployments it exists to repair. That is the failure mode migration 017
-- was written about, and it is silent, so it is checked before anything else happens.
--
-- Both shipped paths satisfy this — the Compose stack migrates as `openppwr_migrator`, created by the
-- PostgreSQL image as the cluster superuser, and the test harness migrates as `postgres` — so this is a
-- guard against an installation that is not those, not a new requirement.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migration 039 must be applied by a credential that can see every tenant''s rows: % can neither bypass row-level security nor is it a superuser, so the removal below would silently affect nothing', current_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The machine roles, as a fact the database holds
--
-- SECURITY INVOKER, deliberately. It reads nothing and decides nothing on anybody's behalf; it is a
-- constant with a name. Making it a definer function would add an owner-privileged entry point to the
-- schema in exchange for nothing at all.
--
-- Owned by `openppwr_security_owner` because the two sign-in functions that consult it are, and revoked
-- from PUBLIC because PostgreSQL grants EXECUTE to PUBLIC by default and a grant nobody needs is a grant
-- nobody reviews. The owner is the only caller that matters: both sign-in functions are SECURITY DEFINER
-- and owned by it, so the call is made with its rights.
CREATE OR REPLACE FUNCTION openppwr_machine_roles() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['service_account', 'worker']::text[]
$$;

COMMENT ON FUNCTION openppwr_machine_roles() IS
  'The identity roles no person signs in as. Mirrors MACHINE_ROLES in apps/api/src/permissions.mjs; sign-in resolves an identity holding one of these as though the address did not exist.';

ALTER FUNCTION openppwr_machine_roles() OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_machine_roles() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------
-- 2. The rows that already exist
--
-- Across every tenant, because a deployment may hold more than the demonstration one and the defect is a
-- property of the role rather than of a particular tenant. `identities` is joined rather than trusted from
-- `demo_users`, which carries no role of its own — the role has always been the identity's.
--
-- The identity itself stays. The worker and the service account authenticate with bearer credentials an
-- operator holds and a deployment needs; what they must not have is a password at a predictable address.
DELETE FROM demo_users u
 USING identities i
 WHERE i.tenant_id = u.tenant_id
   AND i.id = u.identity_id
   AND i.role = ANY (openppwr_machine_roles());

-- ---------------------------------------------------------------------------------------------------
-- 3. The salt lookup stops confirming the account exists
--
-- Reproduced from migration 021 with one added predicate. The decoy branch is why this matters: an address
-- with no account returns a deterministic decoy salt of the same length, so the shape of the answer reveals
-- nothing. An address whose account was refused elsewhere but still resolved here would return a *real*
-- salt, and the decoy is derived from a published formula — so anyone could tell the two apart and learn
-- that the machine account is present. Filtered here, a machine identity is an unknown address, which is
-- what it now is.
CREATE OR REPLACE FUNCTION openppwr_demo_login_salt(p_email text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT u.password_salt FROM demo_users u
      JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
      WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true
        AND i.role <> ALL (openppwr_machine_roles())),
    substring(encode(digest('openppwr-decoy-salt:' || lower(coalesce(p_email, '')), 'sha256'), 'hex') from 1 for 32)
  )
$$;

-- CREATE OR REPLACE keeps the existing owner and ACL because the signature is unchanged; restated so a
-- reader does not have to return to migration 021 to find out who may call this.
ALTER FUNCTION openppwr_demo_login_salt(text) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_demo_login_salt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_demo_login_salt(text) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 4. Verification refuses a machine identity, in the same breath as an unknown address
--
-- Reproduced from migration 038 with one added predicate, in the lookup rather than as a branch after it.
-- That placement is the point: a machine identity produces *no row*, so it takes the path an unknown
-- address takes and reaches the same single `RETURN`. A separate `IF ... THEN RETURN` below the password
-- comparison would be a third outcome with its own cost and its own timing, in a function whose stated
-- property since migration 018 is that a wrong password and an unknown address are one outcome.
--
-- Everything else is migration 038 unchanged: the same TTL ceiling, the same session insert, the same
-- `auth.login.succeeded` append inside the same transaction, attributed to the session just minted.
-- Nothing here can produce an audit event for a refused sign-in, because every refusing branch returns
-- before a token exists.
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

  -- A machine identity is excluded here rather than refused later, so that it is indistinguishable from an
  -- address that was never provisioned. This is the boundary: it holds against a row reinstated by an older
  -- bootstrap, by a restored backup, or by hand.
  SELECT u.tenant_id, u.identity_id, u.password_hash, i.role
    INTO v_user
    FROM demo_users u
    JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
   WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true
     AND i.role <> ALL (openppwr_machine_roles());

  -- One outcome for an unknown address, a machine identity and a wrong credential: no rows. The caller
  -- emits one message.
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

ALTER FUNCTION authenticate_openppwr_demo_login(text, text, integer) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 5. Assertions
--
-- Written as the reviewer's questions, and failing here rather than at the next install.

DO $$
DECLARE
  v_problem text;
  v_permitted text[];
  v_machine text[] := openppwr_machine_roles();
BEGIN
  -- The nine roles the schema itself permits, read out of the CHECK on `identities.role` rather than
  -- retyped. This is what makes the list above checkable instead of merely stated.
  SELECT array_agg(DISTINCT m[1]) INTO v_permitted
    FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') AS m
   WHERE c.conrelid = 'public.identities'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%role%';

  IF v_permitted IS NULL OR array_length(v_permitted, 1) IS NULL THEN
    v_problem := 'the enumeration of permitted identity roles could not be read from the schema, so the machine-role list is checked against nothing';
  ELSIF v_machine IS NULL OR array_length(v_machine, 1) IS NULL THEN
    v_problem := 'openppwr_machine_roles() names no role, so sign-in is filtered against an empty list and this migration protects nothing';
  ELSIF NOT (v_machine <@ v_permitted) THEN
    v_problem := 'openppwr_machine_roles() names a role the identities CHECK does not permit, so it guards a role that cannot exist';
  ELSIF array_length(v_machine, 1) >= array_length(v_permitted, 1) THEN
    v_problem := 'openppwr_machine_roles() covers every role the schema permits, which would leave no person able to sign in';

  -- The rows themselves. This SELECT and the DELETE above see the same rows, and section 0 is what makes
  -- that true: without the authority checked there, both would be empty for the wrong reason.
  ELSIF EXISTS (
    SELECT 1 FROM demo_users u
      JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
     WHERE i.role = ANY (v_machine)
  ) THEN
    v_problem := 'a machine identity still holds a demonstration password account';

  -- Removal without refusal is a repair, not a boundary. Both halves of sign-in must consult the list, and
  -- the check is against the function bodies the database actually holds rather than against this file.
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'authenticate_openppwr_demo_login'
       AND p.prosrc LIKE '%openppwr_machine_roles%'
  ) THEN
    v_problem := 'sign-in does not consult the machine-role list, so a reinstated row would authenticate again';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'openppwr_demo_login_salt'
       AND p.prosrc LIKE '%openppwr_machine_roles%'
  ) THEN
    v_problem := 'the salt lookup does not consult the machine-role list, so it still confirms whether a machine account exists';

  -- Nothing else may have moved. A migration that repairs one thing and widens another is a worse trade
  -- than the defect, so the grants and ownership migrations 014, 016, 017, 021 and 038 established are
  -- restated as questions here.
  ELSIF NOT has_function_privilege('openppwr_auth', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('openppwr_auth', 'openppwr_demo_login_salt(text)', 'EXECUTE') THEN
    v_problem := 'the authentication role lost its ability to sign a person in';
  ELSIF has_function_privilege('public', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE')
     OR has_function_privilege('public', 'openppwr_demo_login_salt(text)', 'EXECUTE')
     OR has_function_privilege('public', 'openppwr_machine_roles()', 'EXECUTE') THEN
    v_problem := 'PUBLIC may sign a person in, ask whether an account exists, or read the machine-role list';
  ELSIF has_function_privilege('openppwr_app', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE')
     OR has_function_privilege('openppwr_app', 'openppwr_demo_login_salt(text)', 'EXECUTE') THEN
    v_problem := 'the request-serving role can mint a session, which is the split migration 014 created';
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('authenticate_openppwr_demo_login', 'openppwr_demo_login_salt', 'openppwr_machine_roles')
       AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner'
  ) THEN
    v_problem := 'a function sign-in depends on is owned by something other than the security owner';
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'openppwr_machine_roles' AND p.prosecdef
  ) THEN
    v_problem := 'the machine-role list became an owner-privileged entry point, which it has no reason to be';
  ELSIF has_table_privilege('openppwr_app', 'demo_users', 'INSERT')
     OR has_table_privilege('openppwr_app', 'demo_users', 'UPDATE')
     OR has_table_privilege('openppwr_app', 'demo_users', 'DELETE')
     OR has_table_privilege('openppwr_auth', 'demo_users', 'SELECT') THEN
    v_problem := 'a runtime principal gained direct access to the sign-in accounts';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'machine sign-in assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
