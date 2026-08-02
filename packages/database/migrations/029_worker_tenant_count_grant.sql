-- 029 — the worker cannot start on any real deployment
--
-- `openppwr_tenant_count()` (migration 008) was granted only to `openppwr_app`. Migration 022 split the
-- worker into its own login principal, `openppwr_worker`, but the grant was never extended: every
-- integration test exercises `assertSingleTenantDeployment` and the retention/scan functions directly
-- against a pool, never through the actual `apps/worker/src/server.mjs` startup sequence connecting as the
-- real worker principal against a fully migrated schema — so no gate caught it. On an actual Debian 13
-- installer deployment the worker container crash-loops at startup with `42501 permission denied for
-- function openppwr_tenant_count`, found only by running the real installer against a real host.

BEGIN;

GRANT EXECUTE ON FUNCTION openppwr_tenant_count() TO openppwr_worker;

DO $$
BEGIN
  IF NOT has_function_privilege('openppwr_worker', 'openppwr_tenant_count()', 'EXECUTE') THEN
    RAISE EXCEPTION 'openppwr_worker still cannot call its own startup tenancy guard';
  END IF;
END $$;

COMMIT;
