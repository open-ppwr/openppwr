-- 031 — a demo reset clears the rows and leaves the bytes
--
-- reset_openppwr_demo_tenant() deletes evidence_files and dossier_artifacts rows for the synthetic tenant,
-- but the underlying quarantine and dossier files on disk were never removed — a PL/pgSQL function cannot
-- touch the filesystem, and nothing on the caller's side did either. The database rows disappear while the
-- bytes remain, to be picked up by the next backup and to survive indefinitely on disk. This
-- migration only changes what the function reports: it now returns the exact storage keys it is about to
-- delete, captured before the DELETE, so the caller can remove the corresponding files after the
-- transaction commits. It does not and cannot delete files itself.

BEGIN;

DROP FUNCTION IF EXISTS reset_openppwr_demo_tenant();

CREATE FUNCTION reset_openppwr_demo_tenant()
RETURNS TABLE (
  packaging_remaining integer, demo_tenant_id uuid,
  evidence_storage_keys text[], dossier_storage_keys text[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_evidence_keys text[];
  v_dossier_keys text[];
BEGIN
  SELECT d.tenant_id INTO v_tenant
    FROM deployment_metadata d
   WHERE d.singleton
     AND d.deployment_mode = 'demo'
     AND d.synthetic_tenant = true
     AND d.tenant_id IS NOT NULL;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'this deployment has no synthetic demonstration tenant'
      USING ERRCODE = 'no_data_found',
            HINT = 'deployment_mode must be demo, set by the installer, and bootstrap must have run.';
  END IF;

  PERFORM set_config('openppwr.tenant_id', v_tenant::text, true);

  -- Captured before the corresponding DELETE, so a caller that cleans up files from this return value is
  -- acting on exactly the set of rows this call removed — not a set that could have changed since.
  SELECT coalesce(array_agg(storage_key), '{}') INTO v_evidence_keys FROM evidence_files WHERE tenant_id = v_tenant;
  SELECT coalesce(array_agg(storage_key), '{}') INTO v_dossier_keys FROM dossier_artifacts WHERE tenant_id = v_tenant;

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

  RETURN QUERY SELECT count(*)::integer, v_tenant, v_evidence_keys, v_dossier_keys FROM packaging WHERE tenant_id = v_tenant;
END $$;

ALTER FUNCTION reset_openppwr_demo_tenant() OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant() FROM openppwr_app;
GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant() TO openppwr_maintenance;

COMMIT;
