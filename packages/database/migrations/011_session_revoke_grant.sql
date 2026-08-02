-- `revoke_openppwr_session` was left with PostgreSQL's default EXECUTE grant to PUBLIC.
--
-- Migration 005 created the function and granted EXECUTE to `openppwr_app` without revoking first. PostgreSQL
-- grants EXECUTE on a new function to PUBLIC by default, so the explicit grant added nothing the function did
-- not already have, and any role with a database connection could end a session given a tenant and a session
-- identifier. Every other SECURITY DEFINER function in this schema revokes from PUBLIC before granting; this
-- one was the exception, and an exception inside a pattern is exactly what nobody re-reads.
--
-- The reachable impact is small — an attacker needs a database connection and two identifiers — and the
-- inconsistency with every sibling function is the part that mattered.
REVOKE ALL ON FUNCTION revoke_openppwr_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_openppwr_session(uuid, uuid) TO openppwr_app;

-- Checking the same property everywhere rather than only where it was reported. A finding is a sample of a
-- property; fixing the sample leaves the property untested. Three more functions turned out to carry the
-- default PUBLIC grant, and none was in the finding.
--
-- Correction, established afterwards by `apps/api/test/security-definer.integration.test.mjs` against the
-- built schema: the three below are **SECURITY INVOKER**, not SECURITY DEFINER. Revoking their default PUBLIC
-- grant is still correct — it removes a call nobody needs — but it is ordinary tightening rather than closing
-- an owner-privileged hole, and it was described as the latter when this migration was written. The schema
-- defines exactly nine SECURITY DEFINER functions, and `revoke_openppwr_session` was the only one of those
-- that was exposed.
--
-- `openppwr_current_tenant` is read by every row-level-security policy in this schema. RLS expressions are
-- evaluated as the *querying* role, so the application role must keep EXECUTE or every policy fails closed on
-- a permission error — which would be an outage, not a safeguard.
REVOKE ALL ON FUNCTION openppwr_current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION openppwr_current_tenant() TO openppwr_app;

-- The audit guards are trigger functions. PostgreSQL checks EXECUTE when a trigger is *created*, not when it
-- fires, so revoking after creation leaves the guards working while removing a direct call nobody needs.
REVOKE ALL ON FUNCTION reject_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_audit_truncate() FROM PUBLIC;

-- And the property, asserted rather than described. A SECURITY DEFINER function runs with its owner's rights;
-- one callable by PUBLIC hands those rights to anyone who can connect. `proacl IS NULL` means the defaults are
-- still in force, which includes EXECUTE for PUBLIC; an aclitem whose grantee is empty is an explicit PUBLIC
-- grant. Either one fails this migration.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
    INTO leaked
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM unnest(p.proacl) AS entry WHERE entry::text LIKE '=%'));
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions are still executable by PUBLIC: %', leaked;
  END IF;
END $$;
