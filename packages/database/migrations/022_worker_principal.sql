-- 022 — the worker gets its own identity, and the request path loses the retention state machine
--
-- The retention boundary regressed, and the cause was not in a migration. Migration 021 took the retention
-- transitions out of a table grant and put them behind six SECURITY DEFINER functions — then granted those
-- functions to `openppwr_app`, because that is the role the worker connects as. It is also the role the API
-- connects as: `deploy/community/docker-compose.yml` gives both services the same `OPENPPWR_DATABASE_URL`.
--
-- So the capability left through one door and returned through another, and the request-serving process
-- could claim a retention job and record a deletion that had not happened. Separating operations in the
-- schema achieves nothing while the deployment collapses two services into one identity.
--
-- This is the fourth appearance of the same shape. What is new is where it was hiding: not in a grant, in a
-- compose file.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The principal
--
-- Created NOLOGIN and without a password, as the others are; `prepareRuntime` gives it a credential. Not a
-- member of anything, so it cannot SET ROLE into the API's identity or the reverse.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_worker') THEN
    CREATE ROLE openppwr_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- 2. What the worker needs
--
-- It authenticates its own bearer token, reads the rows it must act on, records scan outcomes, and drives
-- the retention state machine. Nothing else.

GRANT EXECUTE ON FUNCTION authenticate_openppwr_token(text) TO openppwr_worker;
GRANT EXECUTE ON FUNCTION openppwr_current_tenant() TO openppwr_worker;

-- Scan work.
GRANT SELECT ON scan_jobs TO openppwr_worker;
GRANT UPDATE (status, attempts, infrastructure_attempts, correlation_id, last_error_code, last_failure_class,
              available_at, terminal_at, terminal_reason, updated_at) ON scan_jobs TO openppwr_worker;
GRANT SELECT ON evidence_files TO openppwr_worker;
GRANT UPDATE (scan_status) ON evidence_files TO openppwr_worker;

-- It resolves its own identity when authenticating, and reads nothing else about anyone. `token_hash` is
-- excluded for the same reason the request role cannot read it.
GRANT SELECT (tenant_id, id, display_name, role, supplier_id, active, created_at, token_expires_at)
  ON identities TO openppwr_worker;

-- The retention transitions move to the worker, and only the worker.
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
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM openppwr_app', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openppwr_worker', v_signature);
  END LOOP;
END $$;

-- Its audit events go through the one canonical path, like everyone else's.
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(uuid, uuid, text, text, text, jsonb, timestamptz)
  TO openppwr_worker;
GRANT SELECT ON audit_events TO openppwr_worker;
-- Verification recomputes with the one canonical encoder, so a principal that may read the chain must
-- be able to check it. The function computes a digest from its arguments and reads nothing.
GRANT EXECUTE ON FUNCTION openppwr_audit_canonical_hash(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text)
  TO openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- 3. What the worker must not have
--
-- Enumerated rather than assumed. A role that accumulates grants stops being a boundary, and the point of
-- this migration is that a capability reachable from the wrong process is a capability nobody separated.

REVOKE ALL ON FUNCTION authenticate_openppwr_demo_login(text, text, integer) FROM openppwr_worker;
REVOKE ALL ON FUNCTION openppwr_demo_login_salt(text) FROM openppwr_worker;
REVOKE ALL ON FUNCTION revoke_openppwr_identity_token(uuid, text, uuid) FROM openppwr_worker;
REVOKE ALL ON FUNCTION rotate_openppwr_identity_token(uuid, uuid, text, text, integer) FROM openppwr_worker;
REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM openppwr_worker;
REVOKE ALL ON FUNCTION bootstrap_openppwr_identities(uuid, jsonb) FROM openppwr_worker;
REVOKE ALL ON FUNCTION bootstrap_openppwr_demo_users(uuid, jsonb) FROM openppwr_worker;
REVOKE ALL ON FUNCTION create_openppwr_tenant(uuid, text, text, text) FROM openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- Written as the two questions the review asked: can the request path drive the worker's machine, and can
-- the worker do the product's job?

DO $$
DECLARE
  v_problem text;
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
    IF has_function_privilege('openppwr_app', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'worker principal assertion failed: openppwr_app can still call %', v_signature;
    END IF;
    IF NOT has_function_privilege('openppwr_worker', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'worker principal assertion failed: the worker cannot call %', v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege('openppwr_worker', 'authenticate_openppwr_demo_login(text,text,integer)', 'EXECUTE') THEN
    v_problem := 'the worker can sign a user in';
  ELSIF has_function_privilege('openppwr_worker', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'the worker can reset a deployment';
  ELSIF has_function_privilege('openppwr_worker', 'revoke_openppwr_identity_token(uuid,text,uuid)', 'EXECUTE') THEN
    v_problem := 'the worker can retire a credential';
  ELSIF has_column_privilege('openppwr_worker', 'identities', 'token_hash', 'SELECT') THEN
    v_problem := 'the worker can read a credential verifier';
  ELSIF has_table_privilege('openppwr_worker', 'packaging', 'DELETE')
     OR has_table_privilege('openppwr_worker', 'suppliers', 'INSERT') THEN
    v_problem := 'the worker can mutate business data';
  ELSIF has_column_privilege('openppwr_worker', 'evidence_files', 'review_status', 'UPDATE') THEN
    v_problem := 'the worker can decide a review';
  ELSIF has_column_privilege('openppwr_worker', 'evidence_files', 'retention_status', 'UPDATE') THEN
    v_problem := 'the worker can write retention state around its own functions';
  ELSIF has_table_privilege('openppwr_worker', 'audit_events', 'INSERT') THEN
    v_problem := 'the worker can write the audit chain directly';
  ELSIF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles granted ON granted.oid = m.roleid
     WHERE member.rolname = 'openppwr_worker' OR granted.rolname = 'openppwr_worker'
  ) THEN
    v_problem := 'the worker principal is entangled in a role membership';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'worker principal assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
