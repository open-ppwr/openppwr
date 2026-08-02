-- 035 — make credential rotation reachable in the posture that holds real data
--
-- Migration 034 added the supported way to replace one identity's bearer credential and granted it to
-- `openppwr_auth`. That grant is correct and it is also unreachable where it matters. `openppwr_auth` is the
-- session-issuing credential, and `apps/api/src/server.mjs` refuses to start when
-- `OPENPPWR_AUTH_DATABASE_URL` is present while demonstration sign-in is off — deliberately, because
-- separated grants in PostgreSQL achieve nothing if the request-serving credential and the session-issuing
-- credential both sit in the same long-running API process. So on every production deployment the route
-- backed by 034 answered 404, and 034's own stated reason for existing — "for a self-hoster whose credential
-- leaks it is not a recovery story, it is the absence of one" — was still true of the shipped product. It
-- was true of it for exactly as long as nobody ran the tests with the demonstration switched off.
--
-- Permitting `openppwr_auth` into production would be the wrong repair. What makes that credential dangerous
-- in a request-serving process is `issue_openppwr_session`: EXECUTE on it is *authority by itself*. A caller
-- holding it names an identity and receives a working session, having proved nothing. An attacker who
-- reaches the process reaches every identity in the deployment.
--
-- `rotate_openppwr_identity_credential` is not that shape. It takes the actor's credential and resolves the
-- actor from the store; EXECUTE grants nothing to a caller that cannot already present a live credential,
-- and what it can then do is bounded by what that credential already authorises — its own identity, or its
-- tenant if it is a tenant administrator. Holding rotation is therefore not equivalent to holding session
-- issuance, and the two do not have to travel together.
--
-- This migration separates them. `openppwr_rotation` holds EXECUTE on the rotation function and nothing
-- else: no session issuance, no demonstration-user lookup, no table grant, no column grant, no membership.
-- It is the narrowest principal in the schema, and a deployment may load it in production without loading
-- the credential migration 014 exists to keep out. The startup refusal protecting `OPENPPWR_AUTH_DATABASE_URL`
-- and `OPENPPWR_MAINTENANCE_DATABASE_URL` is unchanged.
--
-- `openppwr_auth` keeps its own EXECUTE. Removing it would break nothing that matters and would rewrite the
-- demonstration's working path for no gain; what changes is that production no longer depends on it.
--
-- Section 3 repairs an assertion in 034 that proved less than its message claimed.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The principal
--
-- Created NOLOGIN and without a password, exactly as migration 014 creates `openppwr_auth` and migration 022
-- creates `openppwr_worker`: a migration must not invent a credential it would then have to store.
-- `packages/database/src/prepare.mjs` gives it LOGIN and a distinct password when
-- OPENPPWR_ROTATION_DATABASE_PASSWORD is set, and retires it — NOLOGIN, PASSWORD NULL — when it is not. A
-- deployment that does not want a rotation route therefore does not merely decline to use the credential;
-- the credential cannot log in.
--
-- Not granted to `openppwr_app`, and `openppwr_app` is NOCREATEROLE and NOINHERIT, so the request-serving
-- connection can become this role neither by inheritance nor by SET ROLE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_rotation') THEN
    CREATE ROLE openppwr_rotation NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- USAGE on the schema and nothing else. Without it the role cannot name the function; with it alone the role
-- still cannot read a single row, because every object in `public` had its PUBLIC grants revoked and this
-- role appears in no ACL below.
GRANT USAGE ON SCHEMA public TO openppwr_rotation;

-- The one capability. Everything the caller could get wrong is derived inside the function (migration 034):
-- the actor from the credential presented, the tenant from that actor, the replacement from
-- `gen_random_bytes`. The UPDATE names three columns, so there is no parameter that could carry a role and
-- no branch that writes one.
GRANT EXECUTE ON FUNCTION rotate_openppwr_identity_credential(text, uuid, integer) TO openppwr_rotation;

-- ---------------------------------------------------------------------------------------------------
-- 2. The action, registered for the new principal
--
-- `append_openppwr_audit_event` resolves the caller as `session_user`, which stays the connecting login role
-- inside a SECURITY DEFINER function. Rotation records itself through that function, so without this row
-- every rotation performed on the new principal would raise `action identity.credential.rotated is not
-- registered for openppwr_rotation` and roll back — the audit append is inside the rotation transaction, so
-- the credential write would go with it. Fail-closed, and useless.
--
-- The rule from migration 024 is unchanged: a principal may claim only what it has a callsite for. This row
-- is added because `openppwr_rotation` now has one.
INSERT INTO audit_action_registry (action_pattern, allowed_principal)
VALUES ('identity.credential.rotated', 'openppwr_rotation')
ON CONFLICT (action_pattern, allowed_principal) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------
-- 3. An assertion that proved less than it claimed
--
-- Migration 034 line 211 asked `has_table_privilege('openppwr_app', 'identities', 'UPDATE')` under the
-- message "the request-serving role may write a credential directly". Column-level grants are invisible to
-- that function. With `GRANT UPDATE (token_hash) ON identities TO openppwr_app` it returns false, so the
-- migration installs cleanly and reports the boundary intact — while `openppwr_app` can then execute
-- `UPDATE identities SET token_hash = '…'`, which is the whole finding.
--
-- This is not hypothetical arithmetic about ACLs. Migration 014 *already* replaced the table-level SELECT on
-- `identities` with a column-level grant list, so the schema this assertion guards is one where column-level
-- grants on that exact table are ordinary. The one question the assertion was written to answer was the one
-- it could not see.
--
-- Restated per column, over both credential-bearing tables and every principal that must not write them.
-- `has_column_privilege` returns true for a table-level grant as well, so this is strictly stronger than
-- what it replaces rather than a different check beside it.

DO $$
DECLARE
  v_role text;
  v_column text;
  v_problem text;
BEGIN
  -- Every principal that must never write a credential verifier or a session, whatever the route.
  -- `openppwr_auth` and `openppwr_rotation` are in this list too: both reach rotation through the definer
  -- function, which runs as its owner, so neither needs — or may hold — the write the function performs.
  FOREACH v_role IN ARRAY ARRAY['openppwr_app', 'openppwr_auth', 'openppwr_maintenance', 'openppwr_worker', 'openppwr_rotation']
  LOOP
    FOREACH v_column IN ARRAY ARRAY['token_hash', 'token_expires_at', 'token_rotated_at', 'role', 'tenant_id', 'supplier_id', 'active']
    LOOP
      IF has_column_privilege(v_role, 'identities', v_column, 'UPDATE') THEN
        v_problem := format('%s may write identities.%s directly, which no grant matrix reading table privileges would show', v_role, v_column);
        EXIT;
      END IF;
    END LOOP;
    EXIT WHEN v_problem IS NOT NULL;

    IF has_column_privilege(v_role, 'identities', 'token_hash', 'SELECT') THEN
      v_problem := format('%s may read the credential verifier it may be asked to present', v_role);
      EXIT;
    END IF;

    IF has_table_privilege(v_role, 'identities', 'INSERT') THEN
      v_problem := format('%s may create an identity, and therefore an administrator', v_role);
      EXIT;
    END IF;

    -- A rotation that does not end the identity's sessions has revoked nothing, so the ability to write
    -- `auth_sessions` outside the function is the same defect wearing a different table name. `openppwr_auth`
    -- legitimately holds INSERT for sign-in (migration 014) and must still not hold UPDATE.
    IF has_column_privilege(v_role, 'auth_sessions', 'revoked_at', 'UPDATE')
       OR has_column_privilege(v_role, 'auth_sessions', 'expires_at', 'UPDATE')
       OR has_column_privilege(v_role, 'auth_sessions', 'token_hash', 'UPDATE') THEN
      v_problem := format('%s may rewrite a session outside the function that constrains it', v_role);
      EXIT;
    END IF;
  END LOOP;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'credential write boundary assertion failed: %', v_problem;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- Written as the reviewer's questions, and failing here rather than at the next install.

DO $$
DECLARE
  v_problem text;
  v_extra text;
BEGIN
  -- The capability that must exist, or this migration achieved nothing and production still cannot recover
  -- from a leaked credential.
  IF NOT has_function_privilege('openppwr_rotation', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the rotation principal cannot perform the rotation it exists for';
  ELSIF NOT EXISTS (
    SELECT 1 FROM audit_action_registry
     WHERE action_pattern = 'identity.credential.rotated' AND allowed_principal = 'openppwr_rotation'
  ) THEN
    v_problem := 'rotation on the new principal would be refused by the audit registry and roll back';

  -- Narrowness is the entire justification for letting this credential into a production process. A role that
  -- accumulates the session primitive is `openppwr_auth` under another name.
  ELSIF has_function_privilege('openppwr_rotation', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the rotation principal may verify a password';
  ELSIF has_function_privilege('openppwr_rotation', 'openppwr_demo_login_salt(text)', 'EXECUTE') THEN
    v_problem := 'the rotation principal may read a password salt';
  ELSIF has_function_privilege('openppwr_rotation', 'rotate_openppwr_identity_token(uuid,uuid,text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the rotation principal holds the unaudited rotation path as well as the audited one';
  ELSIF has_function_privilege('openppwr_rotation', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE') THEN
    v_problem := 'the rotation principal may write an audit event outside the rotation that produced it';
  ELSIF has_function_privilege('openppwr_rotation', 'bootstrap_openppwr_identities(uuid,jsonb)', 'EXECUTE') THEN
    v_problem := 'the rotation principal may provision identities';
  ELSIF has_function_privilege('openppwr_rotation', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'the rotation principal may reset a tenant';

  -- The request-serving role gained nothing, restated positively because it is the boundary this whole
  -- design is arranged around.
  ELSIF has_function_privilege('openppwr_app', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'the request-serving role may rotate a credential';
  ELSIF has_function_privilege('public', 'rotate_openppwr_identity_credential(text,uuid,integer)', 'EXECUTE') THEN
    v_problem := 'PUBLIC may rotate a credential';

  -- Separation: NOINHERIT stops implicit inheritance, only the absence of membership stops SET ROLE.
  ELSIF pg_has_role('openppwr_app', 'openppwr_rotation', 'USAGE')
     OR pg_has_role('openppwr_app', 'openppwr_rotation', 'MEMBER') THEN
    v_problem := 'the request-serving role can assume the rotation principal';
  ELSIF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles r ON r.oid = m.member
     WHERE g.rolname = 'openppwr_rotation' OR r.rolname = 'openppwr_rotation'
  ) THEN
    v_problem := 'the rotation principal is entangled in a role membership';

  -- Cluster-level attributes, checked rather than assumed from the DDL above: a role that already existed
  -- when this migration ran was not created by it.
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'openppwr_rotation'
       AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
  ) THEN
    v_problem := 'the rotation principal holds a cluster-level attribute that bypasses the schema';
  END IF;

  -- No table or column grant at all. Enumerated from the catalogue rather than asked object by object, so a
  -- grant added by a later migration fails here instead of being invisible to a list nobody updated.
  IF v_problem IS NULL THEN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type)
      INTO v_extra
      FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND grantee = 'openppwr_rotation';
    IF v_extra IS NOT NULL THEN
      v_problem := format('the rotation principal holds table privileges it reaches through the function or not at all: %s', v_extra);
    END IF;
  END IF;

  IF v_problem IS NULL THEN
    SELECT string_agg(format('%s.%s:%s', table_name, column_name, privilege_type), ', ' ORDER BY table_name, column_name, privilege_type)
      INTO v_extra
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND grantee = 'openppwr_rotation';
    IF v_extra IS NOT NULL THEN
      v_problem := format('the rotation principal holds column privileges: %s', v_extra);
    END IF;
  END IF;

  -- Exactly one EXECUTE, derived from the catalogue for the same reason.
  IF v_problem IS NULL THEN
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
      INTO v_extra
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND has_function_privilege('openppwr_rotation', p.oid, 'EXECUTE')
       AND coalesce(array_to_string(p.proacl, ','), '') LIKE '%openppwr_rotation=X%'
       AND p.proname <> 'rotate_openppwr_identity_credential';
    IF v_extra IS NOT NULL THEN
      v_problem := format('the rotation principal holds EXECUTE beyond the one capability it exists for: %s', v_extra);
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'rotation principal assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
