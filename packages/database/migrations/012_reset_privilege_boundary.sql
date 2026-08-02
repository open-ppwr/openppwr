-- The demonstration reset accepted any tenant identifier from any caller holding the application role.
--
-- `reset_openppwr_demo_tenant(p_tenant_id uuid)` is SECURITY DEFINER, granted to `openppwr_app`, and deleted
-- every row of a tenant's domain data. The three things that made it safe lived in the HTTP wrapper: the
-- demonstration-mode check, the permission check, and the audit event. A caller holding the application role
-- could call the function directly and get none of them.
--
-- The severity is not "the application can delete data" — it
-- already holds `DELETE` on those tables and could do it row by row. The severity is that a *privileged*
-- helper accepted a target from the caller and left no trace, so a single call could erase a tenant the
-- caller was never scoped to, with nothing in the audit chain to show it happened.
--
-- So the rules move into the function, where a caller cannot skip them:
--
--   1. the target is the session's own tenant, not a parameter;
--   2. the tenant must be a demonstration tenant, proven by the presence of demonstration users;
--   3. an actor must be set, so the caller is identified even when the wrapper is bypassed.
--
-- What this does **not** do, stated rather than implied: the audit event is still appended by the caller.
-- The chain is hash-linked in application code over a canonical JSON encoding, and reimplementing that in
-- PL/pgSQL would risk two encoders drifting and silently breaking chain verification — a worse outcome than
-- the gap it closes. The residual is therefore "a direct caller can reset its own demonstration tenant
-- without appending an event", which is a far smaller claim than the one this migration removes, and it is
-- recorded in the risk register rather than described as closed.
--
-- The grant to `openppwr_app` stays. Revoking it would break the demonstration reset the product ships,
-- because the API *is* that role; moving the reset to a separate credential is a deployment change rather
-- than a schema one, and is recorded as follow-up work.

DROP FUNCTION IF EXISTS reset_openppwr_demo_tenant(uuid);

CREATE FUNCTION reset_openppwr_demo_tenant()
RETURNS TABLE (packaging_remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_actor text;
  v_demo_users integer;
BEGIN
  -- The target is whatever tenant this session is already scoped to. A caller cannot name another one,
  -- because there is no longer a parameter to name it with.
  v_tenant := openppwr_current_tenant();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'reset requires a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := nullif(current_setting('openppwr.actor_id', true), '');
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'reset requires an actor context' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A demonstration tenant is one that has demonstration users. That is the same fact the product uses to
  -- decide whether demonstration sign-in is possible at all, so it cannot drift from the feature it guards,
  -- and it is a property of the data rather than of an environment variable a caller might not have set.
  SELECT count(*)::int INTO v_demo_users FROM demo_users WHERE tenant_id = v_tenant;
  IF v_demo_users = 0 THEN
    RAISE EXCEPTION 'reset is available only for a demonstration tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM dossier_artifacts WHERE tenant_id = v_tenant;
  DELETE FROM review_snapshots  WHERE tenant_id = v_tenant;
  DELETE FROM assessment_results WHERE tenant_id = v_tenant;
  -- Before assessments: gaps reference them.
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
  RETURN QUERY SELECT count(*)::int FROM packaging WHERE tenant_id = v_tenant;
END;
$$;

REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant() TO openppwr_app;
