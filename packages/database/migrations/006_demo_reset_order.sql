-- Demonstration reset deleted assessments before the gaps that reference them.
--
-- `gaps.assessment_id` is a foreign key into `assessments`. The reset removed assessments at step 4
-- and gaps at step 5, so any tenant that had actually produced a gap could not be reset: the function
-- raised foreign_key_violation (SQLSTATE 23503) and the operator saw a 500.
--
-- It survived review because the order looks right at a glance — snapshots, results, assessments,
-- gaps reads like a dependency chain — and because a reset on a tenant with no remediation history
-- succeeds. The demonstration only produces gaps once an assessment has failed, which is exactly the
-- state a user reaches just before wanting to reset.
--
-- Every other pair in this order was re-derived from the live foreign-key catalogue and is correct:
-- scan_jobs before evidence_files, evidence_files before evidence_requirements, bom_lines before
-- boms and components, components before materials, dossier_artifacts before review_snapshots, and
-- everything that references packaging before packaging itself.
-- Recreated rather than replaced only because the original returns a row set; PostgreSQL refuses to
-- change a function's return type in place. The signature and return shape are unchanged, so callers
-- are unaffected, and migrations run in a transaction so no request observes its absence.
DROP FUNCTION IF EXISTS reset_openppwr_demo_tenant(uuid);

CREATE FUNCTION reset_openppwr_demo_tenant(p_tenant_id uuid)
RETURNS TABLE (packaging_remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM dossier_artifacts WHERE tenant_id = p_tenant_id;
  DELETE FROM review_snapshots  WHERE tenant_id = p_tenant_id;
  DELETE FROM assessment_results WHERE tenant_id = p_tenant_id;
  -- Before assessments: gaps reference them.
  DELETE FROM gaps              WHERE tenant_id = p_tenant_id;
  DELETE FROM assessments       WHERE tenant_id = p_tenant_id;
  DELETE FROM scan_jobs         WHERE tenant_id = p_tenant_id;
  DELETE FROM evidence_files    WHERE tenant_id = p_tenant_id;
  DELETE FROM evidence_requirements WHERE tenant_id = p_tenant_id;
  DELETE FROM bom_lines         WHERE tenant_id = p_tenant_id;
  DELETE FROM boms              WHERE tenant_id = p_tenant_id;
  DELETE FROM packaging         WHERE tenant_id = p_tenant_id;
  DELETE FROM components        WHERE tenant_id = p_tenant_id;
  DELETE FROM materials         WHERE tenant_id = p_tenant_id;
  DELETE FROM suppliers         WHERE tenant_id = p_tenant_id;
  DELETE FROM import_row_results WHERE tenant_id = p_tenant_id;
  DELETE FROM import_runs       WHERE tenant_id = p_tenant_id;
  RETURN QUERY SELECT count(*)::int FROM packaging WHERE tenant_id = p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant(uuid) TO openppwr_app;
