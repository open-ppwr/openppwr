-- The tenant registry had no row-level security of its own.
--
-- Migration 001 enables RLS and FORCE RLS on every tenant-scoped table, and `tenants` is not one of them:
-- it has no `tenant_id`, it *is* the tenant. So it was left with plain grants —
-- `GRANT SELECT, INSERT ON tenants TO openppwr_app` — and no policy.
--
-- That is the one table whose contents define every other table's boundary, and the application role could
-- read the whole tenant registry and insert into it. Every other table's isolation is expressed in terms of
-- a row in this one, so the table defining the boundary was the table without a boundary.
--
-- The fix is not simply "enable RLS on tenants", and getting that wrong would be worse than the gap.
-- Bootstrap counts *all* tenants to refuse a second one:
--
--   SELECT count(*) FROM tenants   -- must be 0 for bootstrap to proceed
--
-- It runs as `openppwr_app`. Under a self-only RLS policy that count would always return 0, bootstrap
-- would always believe the database is empty, and the one-tenant-per-deployment guarantee — owner decision
-- enforced at exactly two points — would silently become no guarantee at all.
--
-- So the global question moves into a SECURITY DEFINER function that answers it without granting the
-- application role a view of the registry. The function is the only path that can create a tenant, and it
-- performs the count itself under the same advisory lock the application used.

-- Self-only visibility. A tenant row is visible to a session whose tenant context is that row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_only ON tenants;
CREATE POLICY tenants_self_only ON tenants
  USING (id = openppwr_current_tenant())
  WITH CHECK (id = openppwr_current_tenant());

-- Tenant creation is now a privileged operation with the one-tenant rule inside it, rather than a plain
-- INSERT preceded by a count the caller could not be trusted to have performed.
--
-- SECURITY DEFINER with a fixed search_path: without the fixed path, a caller controlling search_path could
-- resolve `tenants` to a table of their own and have this function populate it instead.
CREATE OR REPLACE FUNCTION create_openppwr_tenant(
  p_id uuid, p_slug text, p_name text, p_disclaimer text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing integer;
BEGIN
  -- Same advisory lock the application used, so two concurrent bootstraps cannot both see an empty table.
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-bootstrap'));
  SELECT count(*) INTO v_existing FROM tenants;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'bootstrap has already been completed'
      USING ERRCODE = 'unique_violation',
            HINT = 'OpenPPWR Community supports one tenant per deployment.';
  END IF;
  INSERT INTO tenants (id, slug, name, disclaimer) VALUES (p_id, p_slug, p_name, p_disclaimer);
  RETURN p_id;
END $$;

REVOKE ALL ON FUNCTION create_openppwr_tenant(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_openppwr_tenant(uuid, text, text, text) TO openppwr_app;

-- Whether a deployment has been bootstrapped is a yes/no question, and answering it does not require
-- reading the registry. The worker's tenancy guard needs the count, so it gets the count and nothing else.
CREATE OR REPLACE FUNCTION openppwr_tenant_count() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM tenants
$$;

REVOKE ALL ON FUNCTION openppwr_tenant_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_tenant_count() TO openppwr_app;

-- INSERT is no longer reachable directly; creation goes through the function above. SELECT remains, now
-- constrained by the self-only policy, because a session legitimately reads its own tenant's disclaimer
-- and name.
REVOKE INSERT ON tenants FROM openppwr_app;
