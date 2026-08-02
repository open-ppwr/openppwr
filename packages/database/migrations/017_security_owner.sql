-- 017 — stop the privileged functions depending on their owner happening to be a superuser
--
-- Every SECURITY DEFINER function in this schema is owned by whichever credential ran the
-- migrations. In the shipped Compose that is `POSTGRES_USER`, which the PostgreSQL image creates as a
-- superuser, and a superuser is exempt from row-level security. That exemption is the only reason
-- `create_openppwr_tenant` can count `tenants` under its self-only policy, and the only reason anything can
-- read `deployment_metadata`, which carries FORCE RLS and no policy at all.
--
-- Nothing asserted it. An installation whose migrations ran as a non-superuser owner would not fail: the
-- count would return zero, `UPDATE deployment_metadata ... WHERE singleton` would match no row, and
-- `create_openppwr_tenant` would return successfully having recorded nothing. The demonstration reset would
-- then refuse for a reason no log explains, and — worse — the one-tenant guarantee would be enforced by a
-- count that can only ever see one tenant.
--
-- A boundary that works by accident of installation is not a boundary. This makes the authority explicit.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The owner
--
-- NOLOGIN, so it has no credential and nothing can connect as it. Its only effect is the rights a SECURITY
-- DEFINER function runs with.
--
-- NOSUPERUSER, which is the point of the migration. BYPASSRLS instead: that is the single specific authority
-- these functions actually need, it is a distinct attribute rather than a blanket exemption, and it is
-- visible in `pg_roles` for anyone auditing the installation. A superuser owner would also be able to read
-- every file on the host and disable every trigger; this one can read the rows its functions were written
-- to read.
--
-- NOINHERIT and NOCREATEROLE for the same reasons as the runtime principals, and it is granted to nobody.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_security_owner') THEN
    CREATE ROLE openppwr_security_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  ELSE
    ALTER ROLE openppwr_security_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO openppwr_security_owner;

-- ---------------------------------------------------------------------------------------------------
-- 2. Ownership
--
-- `deployment_metadata` is deployment identity: the one table whose contents decide whether a reset may
-- happen at all. It moves to the security owner so that its protection comes from ownership plus the absence
-- of any grant, rather than from the migration credential's cluster attributes.

ALTER TABLE deployment_metadata OWNER TO openppwr_security_owner;

-- Every SECURITY DEFINER function follows, so each runs with the explicit authority above rather than with
-- whatever the installer's migration credential happened to hold. Enumerated from the catalogue rather than
-- listed by hand: a function added by a later migration and missed here would silently keep the old owner,
-- which is exactly the class of defect this migration exists to remove.
DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO openppwr_security_owner', v_function.signature);
  END LOOP;
END $$;

-- The owner is not a superuser, so ownership of the functions does not carry access to the tables they read.
-- Each grant below exists for a named function, and the set is deliberately narrow: this role must not
-- become a second way to reach the data.
GRANT SELECT, INSERT ON tenants TO openppwr_security_owner;                    -- create_openppwr_tenant, openppwr_tenant_count
GRANT SELECT, INSERT, UPDATE ON identities TO openppwr_security_owner;         -- bootstrap, authenticate, rotate/revoke token
GRANT SELECT, INSERT ON demo_users TO openppwr_security_owner;                 -- bootstrap_openppwr_demo_users, lookup
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO openppwr_security_owner;      -- issue/authenticate/revoke session
GRANT SELECT, DELETE ON
  dossier_artifacts, review_snapshots, assessment_results, gaps, assessments,
  scan_jobs, evidence_files, evidence_requirements, bom_lines, boms, packaging, components, materials,
  suppliers, import_row_results, import_runs
  TO openppwr_security_owner;                                                  -- reset_openppwr_demo_tenant

-- ---------------------------------------------------------------------------------------------------
-- 3. Zero rows is not success
--
-- The failure this migration is named for is silent. `UPDATE ... WHERE singleton` matching no row is a
-- successful statement, and the function returned the tenant id as though it had recorded it.
--
-- The cardinality is part of the contract, so it is asserted rather than assumed: exactly one row, and
-- exactly one row updated.

CREATE OR REPLACE FUNCTION create_openppwr_tenant(
  p_id uuid, p_slug text, p_name text, p_disclaimer text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing integer;
  v_metadata integer;
  v_updated integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-bootstrap'));

  SELECT count(*) INTO v_existing FROM tenants;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'bootstrap has already been completed'
      USING ERRCODE = 'unique_violation',
            HINT = 'OpenPPWR Community supports one tenant per deployment.';
  END IF;

  -- Checked before the insert, so a deployment whose metadata row is missing or duplicated fails before it
  -- has created anything rather than half way through.
  SELECT count(*) INTO v_metadata FROM deployment_metadata;
  IF v_metadata <> 1 THEN
    RAISE EXCEPTION 'deployment metadata holds % rows, expected exactly 1', v_metadata
      USING ERRCODE = 'raise_exception',
            HINT = 'The installation is incomplete or the privileged function owner cannot read the table.';
  END IF;

  INSERT INTO tenants (id, slug, name, disclaimer) VALUES (p_id, p_slug, p_name, p_disclaimer);

  UPDATE deployment_metadata
     SET tenant_id = p_id,
         synthetic_tenant = (deployment_mode = 'demo')
   WHERE singleton;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'deployment metadata update affected % rows, expected exactly 1', v_updated
      USING ERRCODE = 'raise_exception',
            HINT = 'The privileged function owner cannot write deployment_metadata; the deployment identity would be unrecorded.';
  END IF;

  RETURN p_id;
END $$;

ALTER FUNCTION create_openppwr_tenant(uuid, text, text, text) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION create_openppwr_tenant(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_openppwr_tenant(uuid, text, text, text) TO openppwr_app;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- Written as the installation contract, so a deployment that does not satisfy it fails here rather than
-- succeeding quietly and enforcing nothing.

DO $$
DECLARE
  v_problem text;
  v_owner_attributes record;
  v_wrongly_owned text;
BEGIN
  SELECT rolsuper, rolcanlogin, rolbypassrls, rolcreaterole, rolinherit
    INTO v_owner_attributes FROM pg_roles WHERE rolname = 'openppwr_security_owner';

  IF v_owner_attributes IS NULL THEN
    v_problem := 'the privileged function owner does not exist';
  ELSIF v_owner_attributes.rolsuper THEN
    v_problem := 'the privileged function owner is a superuser, which is the assumption this migration removes';
  ELSIF v_owner_attributes.rolcanlogin THEN
    v_problem := 'the privileged function owner can log in; it must lend its rights only through definer functions';
  ELSIF NOT v_owner_attributes.rolbypassrls THEN
    v_problem := 'the privileged function owner cannot see the rows its functions must read';
  ELSIF v_owner_attributes.rolcreaterole THEN
    v_problem := 'the privileged function owner may create roles';
  ELSIF v_owner_attributes.rolinherit THEN
    v_problem := 'the privileged function owner inherits privileges of roles granted to it';
  END IF;

  IF v_problem IS NULL THEN
    -- No SECURITY DEFINER function may be left owned by anything else, or it keeps running with whatever
    -- the installer's credential holds.
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_wrongly_owned
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND pg_get_userbyid(p.proowner) <> 'openppwr_security_owner';
    IF v_wrongly_owned IS NOT NULL THEN
      v_problem := format('definer functions still owned elsewhere: %s', v_wrongly_owned);
    END IF;
  END IF;

  IF v_problem IS NULL AND pg_get_userbyid((SELECT relowner FROM pg_class WHERE relname = 'deployment_metadata')) <> 'openppwr_security_owner' THEN
    v_problem := 'deployment_metadata is not owned by the privileged function owner';
  END IF;

  -- The runtime principals must not have gained anything, and must not be able to become the owner.
  IF v_problem IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m
        JOIN pg_roles member ON member.oid = m.member
        JOIN pg_roles granted ON granted.oid = m.roleid
       WHERE granted.rolname = 'openppwr_security_owner'
    ) THEN
      v_problem := 'a role is a member of the privileged function owner and can assume it';
    ELSIF has_table_privilege('openppwr_app', 'deployment_metadata', 'SELECT')
       OR has_table_privilege('openppwr_auth', 'deployment_metadata', 'SELECT')
       OR has_table_privilege('openppwr_maintenance', 'deployment_metadata', 'SELECT') THEN
      v_problem := 'a runtime principal can read deployment identity directly';
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'privileged function owner assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
