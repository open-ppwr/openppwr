-- 030 — the requeue function cannot read its own tenant scope
--
-- requeue_openppwr_scan_job (migration 028) is SECURITY DEFINER, owned by openppwr_security_owner. Its body
-- calls openppwr_current_tenant() to scope the job lookup — but that call runs as the DEFINER, not the
-- original caller, and openppwr_current_tenant() was granted explicitly to openppwr_app, openppwr_worker
-- and openppwr_maintenance (migrations 011/014/022) and never to openppwr_security_owner itself. Every real
-- call to /v1/scan-jobs/:id/requeue therefore failed with `permission denied for function
-- openppwr_current_tenant`, caught only once a test exercising this exact path ran with correctly wired
-- pools — masked until now by an unrelated pool-wiring defect in the test itself.

BEGIN;

GRANT EXECUTE ON FUNCTION openppwr_current_tenant() TO openppwr_security_owner;

DO $$
BEGIN
  IF NOT has_function_privilege('openppwr_security_owner', 'openppwr_current_tenant()', 'EXECUTE') THEN
    RAISE EXCEPTION 'openppwr_security_owner still cannot read the tenant scope its own definer functions need';
  END IF;
END $$;

COMMIT;
