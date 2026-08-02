-- 014 — separate the principals that hold credential, provisioning and reset capability
-- from the principal that serves requests.
--
-- Migrations 012 and 013 tried to close the same findings by moving checks into privileged-looking places.
-- Both were broken, and the attacker tests in apps/api/test/privilege-attack.integration.test.mjs
-- reproduce it by execution: the application role reset a tenant it chose, minted a session with no
-- credential, and created a tenant_admin whose token then authenticated with status 200.
--
-- The common error was treating an input the caller controls as authority:
--
--   * `openppwr_current_tenant()` reads a GUC that `openppwr_app` sets for itself, so deriving the reset
--     target from it made the target implicit, not trusted;
--   * `demo_users` is writable by `openppwr_app`, so the "this is a demonstration tenant" marker the reset
--     checked was forgeable by the same caller;
--   * revoking INSERT on `auth_sessions` closed the table while `issue_openppwr_session` — SECURITY DEFINER,
--     validating nothing — offered the identical write;
--   * `INSERT` on `identities`, kept for bootstrap, was a standing grant to create an administrator.
--
-- A GUC is a request-scoping hint for row-level security. It is not authentication, not authorization, and
-- not deployment identity. This migration makes that structural rather than advisory.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. Principals
--
-- Created NOLOGIN with no password, exactly as `openppwr_app` is in migration 001. The installer gives each
-- one LOGIN and a distinct password; the migration must not invent credentials it would then have to store.
--
-- Neither role is granted to `openppwr_app`, and `openppwr_app` is NOCREATEROLE and NOINHERIT, so the
-- request-serving connection cannot become either one — not by inheritance and not by SET ROLE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_auth') THEN
    CREATE ROLE openppwr_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_maintenance') THEN
    CREATE ROLE openppwr_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO openppwr_auth, openppwr_maintenance;

-- ---------------------------------------------------------------------------------------------------
-- 2. Trusted deployment metadata
--
-- Whether a deployment is a demonstration is an operator decision taken at install time, not something the
-- application may assert at runtime and not something inferable from rows the application can write.
--
-- `deployment_mode` defaults to 'production' and is writable only by the migration credential. A deployment
-- that never runs the demonstration installer step can never be reset, whatever the application claims.

CREATE TABLE IF NOT EXISTS deployment_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_mode text NOT NULL DEFAULT 'production' CHECK (deployment_mode IN ('demo', 'production')),
  synthetic_tenant boolean NOT NULL DEFAULT false,
  tenant_id uuid,
  established_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO deployment_metadata (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

-- Row-level security with no policy at all, and FORCE, so the table is unreadable and unwritable through a
-- direct connection by any non-superuser role. Everything that legitimately needs it — the reset resolving
-- its target, bootstrap recording which tenant exists — goes through a SECURITY DEFINER function owned by
-- the migration credential.
--
-- The isolation gate flagged this table for having a `tenant_id` column and no policy, and it was right to.
-- The answer is not an exception in the gate: it is that nothing outside the owner needs to read this at
-- all. A SELECT grant added speculatively is how a table that is authority for one decision becomes an
-- input to another.
ALTER TABLE deployment_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_metadata FORCE ROW LEVEL SECURITY;
REVOKE ALL ON deployment_metadata FROM PUBLIC;

-- Bootstrap records *which* tenant exists. It cannot record *that the deployment is a demonstration*: the
-- mode is left exactly as the installer set it. Filling in a tenant identifier on a production deployment
-- therefore unlocks nothing.
CREATE OR REPLACE FUNCTION create_openppwr_tenant(
  p_id uuid, p_slug text, p_name text, p_disclaimer text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-bootstrap'));
  SELECT count(*) INTO v_existing FROM tenants;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'bootstrap has already been completed'
      USING ERRCODE = 'unique_violation',
            HINT = 'OpenPPWR Community supports one tenant per deployment.';
  END IF;
  INSERT INTO tenants (id, slug, name, disclaimer) VALUES (p_id, p_slug, p_name, p_disclaimer);
  UPDATE deployment_metadata
     SET tenant_id = p_id,
         synthetic_tenant = (deployment_mode = 'demo')
   WHERE singleton;
  RETURN p_id;
END $$;

REVOKE ALL ON FUNCTION create_openppwr_tenant(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_openppwr_tenant(uuid, text, text, text) TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. Identity provisioning — the request role could mint a privileged identity
--
-- The proven attack: INSERT a row into `identities` with role 'tenant_admin' and a token hash of the
-- attacker's choosing, then present the matching token. It authenticated.
--
-- Provisioning becomes one-time and self-closing. The function refuses once any identity exists anywhere,
-- so after a successful bootstrap there is no second call. It runs as the owner, which is not subject to
-- FORCE ROW LEVEL SECURITY, so the count is global rather than filtered to the caller's tenant — the same
-- reason `create_openppwr_tenant` can count `tenants`.

CREATE OR REPLACE FUNCTION bootstrap_openppwr_identities(p_tenant_id uuid, p_identities jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing integer;
  v_created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-bootstrap'));

  SELECT count(*) INTO v_existing FROM identities;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'identity provisioning is closed'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Identities exist; provisioning runs once per deployment.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'unknown tenant' USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO identities (tenant_id, id, display_name, role, supplier_id, token_hash)
  SELECT p_tenant_id,
         (entry ->> 'id')::uuid,
         entry ->> 'display_name',
         entry ->> 'role',
         nullif(entry ->> 'supplier_id', ''),
         entry ->> 'token_hash'
    FROM jsonb_array_elements(p_identities) AS entry;

  GET DIAGNOSTICS v_created = ROW_COUNT;
  RETURN v_created;
END $$;

REVOKE ALL ON FUNCTION bootstrap_openppwr_identities(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_openppwr_identities(uuid, jsonb) TO openppwr_app;

-- Demonstration sign-in accounts are provisioned in the same one-time window, for the same reason: a
-- standing INSERT on `demo_users` is what let the attacker forge the marker the old reset trusted.
CREATE OR REPLACE FUNCTION bootstrap_openppwr_demo_users(p_tenant_id uuid, p_users jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing integer;
  v_created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-bootstrap'));

  SELECT count(*) INTO v_existing FROM demo_users;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'demonstration account provisioning is closed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO demo_users (tenant_id, id, identity_id, email, password_hash, password_salt)
  SELECT p_tenant_id,
         (entry ->> 'id')::uuid,
         (entry ->> 'identity_id')::uuid,
         entry ->> 'email',
         entry ->> 'password_hash',
         entry ->> 'password_salt'
    FROM jsonb_array_elements(p_users) AS entry;

  GET DIAGNOSTICS v_created = ROW_COUNT;
  RETURN v_created;
END $$;

REVOKE ALL ON FUNCTION bootstrap_openppwr_demo_users(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_openppwr_demo_users(uuid, jsonb) TO openppwr_app;

-- The standing grants that made the attack possible.
REVOKE INSERT ON identities FROM openppwr_app;
REVOKE INSERT, UPDATE ON demo_users FROM openppwr_app;

-- A verifier the caller can read is not a secret, and a rotation function that asks the caller to present
-- one it can read proves nothing. Column-level SELECT keeps every legitimate read — display name, role,
-- supplier scope, active flag — and removes the two credential columns.
REVOKE SELECT ON identities FROM openppwr_app;
GRANT SELECT (tenant_id, id, display_name, role, supplier_id, active, created_at, token_expires_at)
  ON identities TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Session issuance — the issuer validated none of what it was handed
--
-- The proven attack: call `issue_openppwr_session` with a chosen identity, a chosen tenant, a chosen token
-- hash and a ten-year expiry. It validated none of them and installed the supplied tenant context itself.
--
-- Two changes, because either alone would be insufficient. The function now derives what it must not accept,
-- and the request-serving role loses the right to call it at all.

-- Dropped rather than replaced: it now returns the expiry it actually granted, and a caller that asked for
-- more must be able to see what it got. PostgreSQL will not change a return type in place.
DROP FUNCTION IF EXISTS issue_openppwr_session(uuid, uuid, uuid, text, timestamptz);

CREATE FUNCTION issue_openppwr_session(
  p_tenant_id uuid, p_identity_id uuid, p_session_id uuid, p_token_hash text, p_expires_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant_id uuid;
  v_ceiling timestamptz := now() + interval '24 hours';
  v_expires_at timestamptz;
BEGIN
  -- The tenant comes from the identity, not from the caller. The parameter is retained for call
  -- compatibility and checked for agreement rather than trusted.
  SELECT i.tenant_id INTO v_tenant_id
    FROM identities i
   WHERE i.id = p_identity_id
     AND i.active = true;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'unknown or inactive identity' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_tenant_id IS NOT NULL AND p_tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION 'tenant does not match the identity' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 THEN
    RAISE EXCEPTION 'invalid session token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A caller may ask for less than the ceiling, never more.
  v_expires_at := least(coalesce(p_expires_at, v_ceiling), v_ceiling);
  IF v_expires_at <= now() THEN
    RAISE EXCEPTION 'session expiry is in the past' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM set_config('openppwr.tenant_id', v_tenant_id::text, true);
  INSERT INTO auth_sessions (tenant_id, id, identity_id, token_hash, expires_at)
  VALUES (v_tenant_id, p_session_id, p_identity_id, p_token_hash, v_expires_at);

  RETURN v_expires_at;
END $$;

-- The request-serving role must not hold a session-minting primitive under any circumstances, however well
-- it validates. Sign-in runs on the authentication credential.
REVOKE ALL ON FUNCTION issue_openppwr_session(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_openppwr_session(uuid, uuid, uuid, text, timestamptz) FROM openppwr_app;
GRANT EXECUTE ON FUNCTION issue_openppwr_session(uuid, uuid, uuid, text, timestamptz) TO openppwr_auth;

-- The demonstration-user lookup hands the caller a password hash and salt to verify. That is a credential
-- verifier, and it belongs on the authentication credential for the same reason as the session primitive.
REVOKE ALL ON FUNCTION lookup_openppwr_demo_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_openppwr_demo_user(text) FROM openppwr_app;
GRANT EXECUTE ON FUNCTION lookup_openppwr_demo_user(text) TO openppwr_auth;

-- Sign-in writes one session row; the authentication role needs exactly that and nothing else.
GRANT SELECT, INSERT ON auth_sessions TO openppwr_auth;
GRANT SELECT ON identities TO openppwr_auth;
GRANT SELECT ON demo_users TO openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 5. Demonstration reset — the target came from a context the caller sets for itself
--
-- The proven attack: set `openppwr.tenant_id` to a victim, insert a row into `demo_users` to satisfy the
-- demonstration check, call the reset. The victim's data went.
--
-- The target now comes from deployment metadata the caller cannot write, the demonstration property comes
-- from an installer decision rather than from rows, and the capability leaves the request-serving role.

-- Also dropped rather than replaced: it now returns the tenant it resolved, because the caller no longer
-- supplies one and must not have to guess which tenant its audit event describes.
DROP FUNCTION IF EXISTS reset_openppwr_demo_tenant();

-- The output column is not called `tenant_id`: RETURNS TABLE names become PL/pgSQL variables, and one named
-- `tenant_id` would shadow the column of every table below.
CREATE FUNCTION reset_openppwr_demo_tenant()
RETURNS TABLE (packaging_remaining integer, demo_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT d.tenant_id INTO v_tenant
    FROM deployment_metadata d
   WHERE d.singleton
     AND d.deployment_mode = 'demo'
     AND d.synthetic_tenant = true
     AND d.tenant_id IS NOT NULL;

  IF v_tenant IS NULL THEN
    -- A distinct SQLSTATE, deliberately not insufficient_privilege. PostgreSQL raises 42501 for "permission
    -- denied for table" as well, so a missing grant and "this is not a demonstration deployment" would be
    -- indistinguishable to the caller -- and the API, mapping 42501 to 404, would hide a misconfigured
    -- deployment behind a not-found. That is the same mistake as trusting a caller-controlled input:
    -- reading an ambiguous signal as if it carried one meaning.
    RAISE EXCEPTION 'this deployment has no synthetic demonstration tenant'
      USING ERRCODE = 'no_data_found',
            HINT = 'deployment_mode must be demo, set by the installer, and bootstrap must have run.';
  END IF;

  PERFORM set_config('openppwr.tenant_id', v_tenant::text, true);

  -- The deletion order of migration 012, unchanged: gaps reference assessments, and the rest follow
  -- referential integrity. Reordering this is how a reset starts failing halfway through.
  DELETE FROM dossier_artifacts WHERE tenant_id = v_tenant;
  DELETE FROM review_snapshots  WHERE tenant_id = v_tenant;
  DELETE FROM assessment_results WHERE tenant_id = v_tenant;
  DELETE FROM gaps              WHERE tenant_id = v_tenant;
  DELETE FROM assessments       WHERE tenant_id = v_tenant;
  DELETE FROM scan_jobs         WHERE tenant_id = v_tenant;
  DELETE FROM evidence_files    WHERE tenant_id = v_tenant;
  DELETE FROM evidence_requirements WHERE tenant_id = v_tenant;
  DELETE FROM bom_lines         WHERE tenant_id = v_tenant;
  DELETE FROM boms              WHERE tenant_id = v_tenant;
  DELETE FROM packaging         WHERE tenant_id = v_tenant;
  DELETE FROM components        WHERE tenant_id = v_tenant;
  DELETE FROM materials         WHERE tenant_id = v_tenant;
  DELETE FROM suppliers         WHERE tenant_id = v_tenant;
  DELETE FROM import_row_results WHERE tenant_id = v_tenant;
  DELETE FROM import_runs       WHERE tenant_id = v_tenant;

  RETURN QUERY SELECT count(*)::integer, v_tenant FROM packaging WHERE tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM openppwr_app;
GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant() TO openppwr_maintenance;

GRANT SELECT, DELETE ON dossier_artifacts, review_snapshots, assessment_results, gaps, assessments,
  scan_jobs, evidence_files, evidence_requirements, bom_lines, boms, packaging, components, materials,
  suppliers, import_row_results, import_runs TO openppwr_maintenance;

-- The reset's audit event is written on this same connection, in the same transaction, by the one
-- application-side encoder. The alternative — appending from the request connection afterwards — would put
-- the record in a different transaction from the deletion it describes, and a second encoder in PL/pgSQL
-- would risk silent hash-chain divergence. One encoder, one transaction.
GRANT SELECT, INSERT ON audit_events TO openppwr_maintenance;
-- appendAudit resolves the tenant through this function, so the maintenance role needs it too.
-- Migration 011 revoked the default PUBLIC grant, which is correct; the consequence is that every new
-- principal must be granted it deliberately.
GRANT EXECUTE ON FUNCTION openppwr_current_tenant() TO openppwr_maintenance;
-- The chain's sequence is part of writing an audit row, and a grant on the table does not carry it.
GRANT USAGE, SELECT ON SEQUENCE audit_events_sequence_seq TO openppwr_maintenance;

-- ---------------------------------------------------------------------------------------------------
-- 6. Assertions
--
-- A migration that quietly grants less than intended is a boundary nobody notices until an install fails.
-- These fail here rather than in production, and they are written as the attacker's questions.

DO $$
DECLARE
  v_problem text;
BEGIN
  -- The capabilities the request role must not hold.
  IF has_table_privilege('openppwr_app', 'identities', 'INSERT') THEN
    v_problem := 'openppwr_app may still INSERT identities';
  ELSIF has_table_privilege('openppwr_app', 'identities', 'UPDATE') THEN
    v_problem := 'openppwr_app may still UPDATE identities';
  ELSIF has_column_privilege('openppwr_app', 'identities', 'token_hash', 'SELECT') THEN
    v_problem := 'openppwr_app may still read the credential verifier';
  ELSIF has_table_privilege('openppwr_app', 'demo_users', 'INSERT') THEN
    v_problem := 'openppwr_app may still forge a demonstration marker';
  ELSIF has_function_privilege('openppwr_app', 'issue_openppwr_session(uuid,uuid,uuid,text,timestamptz)', 'EXECUTE') THEN
    v_problem := 'openppwr_app may still mint sessions';
  ELSIF has_function_privilege('openppwr_app', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'openppwr_app may still reset a tenant';
  ELSIF has_function_privilege('openppwr_app', 'lookup_openppwr_demo_user(text)', 'EXECUTE') THEN
    v_problem := 'openppwr_app may still read password verifiers';
  ELSIF has_function_privilege('public', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'PUBLIC may reset a tenant';
  ELSIF has_function_privilege('public', 'issue_openppwr_session(uuid,uuid,uuid,text,timestamptz)', 'EXECUTE') THEN
    v_problem := 'PUBLIC may mint sessions';
  ELSIF has_table_privilege('openppwr_app', 'deployment_metadata', 'UPDATE') THEN
    v_problem := 'openppwr_app may rewrite deployment metadata';
  ELSIF has_table_privilege('openppwr_app', 'deployment_metadata', 'INSERT') THEN
    v_problem := 'openppwr_app may insert deployment metadata';

  -- The capabilities that must survive, so the boundary cannot be satisfied by revoking everything.
  ELSIF NOT has_column_privilege('openppwr_app', 'identities', 'display_name', 'SELECT') THEN
    v_problem := 'openppwr_app can no longer read identity metadata it needs';
  ELSIF NOT has_function_privilege('openppwr_app', 'authenticate_openppwr_token(text)', 'EXECUTE') THEN
    v_problem := 'openppwr_app can no longer authenticate a bearer token';
  ELSIF NOT has_function_privilege('openppwr_app', 'bootstrap_openppwr_identities(uuid,jsonb)', 'EXECUTE') THEN
    v_problem := 'bootstrap cannot provision identities';
  ELSIF NOT has_function_privilege('openppwr_auth', 'issue_openppwr_session(uuid,uuid,uuid,text,timestamptz)', 'EXECUTE') THEN
    v_problem := 'the authentication role cannot issue sessions';
  ELSIF NOT has_function_privilege('openppwr_maintenance', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'the maintenance role cannot reset the demonstration tenant';

  -- Separation itself: the request role must not be able to become either privileged principal.
  ELSIF pg_has_role('openppwr_app', 'openppwr_auth', 'USAGE') THEN
    v_problem := 'openppwr_app can assume the authentication role';
  ELSIF pg_has_role('openppwr_app', 'openppwr_maintenance', 'USAGE') THEN
    v_problem := 'openppwr_app can assume the maintenance role';
  ELSIF pg_has_role('openppwr_app', 'openppwr_auth', 'MEMBER') THEN
    v_problem := 'openppwr_app is a member of the authentication role';
  ELSIF pg_has_role('openppwr_app', 'openppwr_maintenance', 'MEMBER') THEN
    v_problem := 'openppwr_app is a member of the maintenance role';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'privilege separation assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
