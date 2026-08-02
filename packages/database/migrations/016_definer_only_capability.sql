-- 016 — take back the table grants that made migration 014's boundary decorative
--
-- Two of the three boundaries 014 claimed to close were still reachable, and the cause is one mistake
-- made in two places:
--
--   I granted the new principals the underlying table privileges "so the function would work".
--
-- A SECURITY DEFINER function runs with its *owner's* rights. It needs nothing from the caller beyond
-- EXECUTE. Granting the caller the same capability directly does not enable the function — it bypasses it.
--
--   * `openppwr_maintenance` held SELECT and DELETE on every domain table. It could set a tenant context and
--     issue the DELETEs itself, against a production deployment, with no deployment-metadata check, no demo
--     check and no audit event. The reset function's entire purpose was optional.
--   * `openppwr_auth` held SELECT and INSERT on `auth_sessions`. It could insert a session row directly with
--     a chosen identity, a chosen token hash and a ten-year expiry — which is precisely the credential-write
--     boundary migration 013 closed, moved to a different role rather than removed.
--
-- This is the third appearance of one habit: adding a capability somewhere that looks contained, without
-- asking what that capability can reach on its own. The question to ask of every grant to a principal that
-- calls a definer function is not "does the function need this" but "what can the caller do with it without
-- the function".

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The maintenance principal keeps EXECUTE and nothing else
--
-- `reset_openppwr_demo_tenant()` is SECURITY DEFINER and owned by the migration credential, so it performs
-- its own DELETEs with the owner's rights. The role that calls it needs no reach into the tables at all.

REVOKE SELECT, DELETE ON
  dossier_artifacts, review_snapshots, assessment_results, gaps, assessments,
  scan_jobs, evidence_files, evidence_requirements, bom_lines, boms, packaging, components, materials,
  suppliers, import_row_results, import_runs
FROM openppwr_maintenance;

-- The audit grants stay, and deliberately so. The reset's audit event is appended on this connection, in
-- the same transaction as the deletion, by the one application-side encoder — the alternative is a second
-- hash-chain encoder in PL/pgSQL, which can drift and silently break chain verification.
--
-- The residual is therefore: this principal can append an audit event. It cannot alter or remove one
-- (audit_events carries mutation and truncate guards), and it can no longer delete anything to write an
-- event about. That is a smaller residual than a divergent encoder, and it is recorded rather than closed.

-- ---------------------------------------------------------------------------------------------------
-- 2. The authentication principal keeps EXECUTE and nothing else
--
-- `issue_openppwr_session` derives the tenant, bounds the expiry and validates the identity. None of that
-- binds anything while the caller can write the same row directly.

REVOKE SELECT, INSERT ON auth_sessions FROM openppwr_auth;

-- `lookup_openppwr_demo_user` and `issue_openppwr_session` are both SECURITY DEFINER and read these
-- themselves. A direct SELECT on `identities` would hand this role the credential verifier that the request
-- role was deliberately denied.
REVOKE SELECT ON identities FROM openppwr_auth;
REVOKE SELECT ON demo_users FROM openppwr_auth;

-- ---------------------------------------------------------------------------------------------------
-- 3. Assertions
--
-- Written as the reviewer's question rather than as the migration's intent: not "was the revoke issued" but
-- "can this principal still reach the capability without the function".

DO $$
DECLARE
  v_problem text;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'dossier_artifacts','review_snapshots','assessment_results','gaps','assessments','scan_jobs',
    'evidence_files','evidence_requirements','bom_lines','boms','packaging','components','materials',
    'suppliers','import_row_results','import_runs'
  ] LOOP
    IF has_table_privilege('openppwr_maintenance', v_table, 'DELETE') THEN
      RAISE EXCEPTION 'privilege assertion failed: openppwr_maintenance may DELETE % without the reset function', v_table;
    END IF;
    IF has_table_privilege('openppwr_maintenance', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'privilege assertion failed: openppwr_maintenance may read %', v_table;
    END IF;
  END LOOP;

  IF has_table_privilege('openppwr_auth', 'auth_sessions', 'INSERT') THEN
    v_problem := 'openppwr_auth may insert a session without the issuing function';
  ELSIF has_table_privilege('openppwr_auth', 'auth_sessions', 'SELECT') THEN
    v_problem := 'openppwr_auth may read session token hashes';
  ELSIF has_column_privilege('openppwr_auth', 'identities', 'token_hash', 'SELECT') THEN
    v_problem := 'openppwr_auth may read the credential verifier directly';
  ELSIF has_table_privilege('openppwr_auth', 'demo_users', 'SELECT') THEN
    v_problem := 'openppwr_auth may read password verifiers directly';

  -- What must still work, so the boundary cannot be satisfied by revoking everything.
  ELSIF NOT has_function_privilege('openppwr_maintenance', 'reset_openppwr_demo_tenant()', 'EXECUTE') THEN
    v_problem := 'the maintenance principal can no longer perform the reset it exists for';
  ELSIF NOT has_function_privilege('openppwr_auth', 'issue_openppwr_session(uuid,uuid,uuid,text,timestamptz)', 'EXECUTE') THEN
    v_problem := 'the authentication principal can no longer issue a session';
  ELSIF NOT has_function_privilege('openppwr_auth', 'lookup_openppwr_demo_user(text)', 'EXECUTE') THEN
    v_problem := 'the authentication principal can no longer resolve a sign-in';
  ELSIF NOT has_table_privilege('openppwr_maintenance', 'audit_events', 'INSERT') THEN
    v_problem := 'the reset can no longer record what it did';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'privilege assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
