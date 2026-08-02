-- 033 — the reset's returned storage keys can miss a row it actually deleted
--
-- 031 captured the storage keys to clean up with a SELECT, then deleted the rows with a separate DELETE a
-- few statements later. Under READ COMMITTED, each statement sees a fresh snapshot as of its own start —
-- so a row inserted and committed by another transaction (a concurrent evidence upload) after 031's SELECT
-- but before its DELETE is still caught by the DELETE's own WHERE clause and removed from the database, but
-- was never in the array the SELECT captured. The row is gone; the caller was never told to remove its
-- file. Found by re-reading 031 rather than by any test — every test in this programme drives the reset
-- without a concurrent writer racing it.
--
-- The fix is to capture the keys in the same statement that removes the rows, not a separate one before
-- it: `DELETE ... RETURNING` cannot miss a row it deletes, because there is no gap between the two.

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

  -- The deletion order of migration 012, unchanged: gaps reference assessments, and the rest follow
  -- referential integrity. Reordering this is how a reset starts failing halfway through.
  --
  -- `dossier_artifacts` and `evidence_files` capture their storage keys via `RETURNING` in the same
  -- statement that deletes them, rather than a `SELECT` beforehand — the set returned is therefore exactly
  -- the set of rows this call removed, with no window in which a row could be deleted without its key ever
  -- having been captured.
  WITH deleted AS (DELETE FROM dossier_artifacts WHERE tenant_id = v_tenant RETURNING storage_key)
    SELECT coalesce(array_agg(storage_key), '{}') INTO v_dossier_keys FROM deleted;
  DELETE FROM review_snapshots  WHERE tenant_id = v_tenant;
  DELETE FROM assessment_results WHERE tenant_id = v_tenant;
  DELETE FROM gaps              WHERE tenant_id = v_tenant;
  DELETE FROM assessments       WHERE tenant_id = v_tenant;
  DELETE FROM scan_jobs         WHERE tenant_id = v_tenant;
  WITH deleted AS (DELETE FROM evidence_files WHERE tenant_id = v_tenant RETURNING storage_key)
    SELECT coalesce(array_agg(storage_key), '{}') INTO v_evidence_keys FROM deleted;
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
