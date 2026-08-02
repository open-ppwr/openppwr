-- 036 — let the running process read the migration level the database actually carries
--
-- `GET /v1/version` reported `migrationLevel` from `OPENPPWR_MIGRATION_LEVEL`, an argument baked into the
-- image at build time. Nothing compared it to the schema, so the one number a reader could use to tell
-- which schema a deployment is on was the one number nothing verified: an image built with the wrong
-- build-arg reports confidently, and so does a database whose migration run stopped halfway.
--
-- The applied level lives in `openppwr_schema_migrations`, which `packages/database/src/migrate.mjs`
-- creates and writes as the migration principal. `openppwr_app` held nothing on it, so the request-serving
-- process could not read the fact it was being asked to report.
--
-- SELECT, and only SELECT, and only for the two runtime principals that report a version. The table holds
-- migration filenames and the time each was applied: no tenant data, no credential, no hostname. It is
-- global infrastructure rather than tenant-scoped, exactly as `rate_limit_buckets` is, so no row-level
-- policy applies to it and none is added here.
--
-- Not a SECURITY DEFINER function. A definer function is how this schema lends the owner's rights for an
-- operation a principal must not hold outright; reading a schema version is not that shape — there is no
-- privileged side effect to fence and nothing to derive from the caller. A plain grant is the smaller
-- change and the one a reader can check in one line.

BEGIN;

GRANT SELECT ON openppwr_schema_migrations TO openppwr_app;
-- The worker reports no version today. It is included because the alternative is a second migration the
-- first time it does, and because SELECT on this table is the same nothing for either principal.
GRANT SELECT ON openppwr_schema_migrations TO openppwr_worker;

DO $$
DECLARE
  v_problem text;
BEGIN
  IF NOT has_table_privilege('openppwr_app', 'openppwr_schema_migrations', 'SELECT') THEN
    v_problem := 'openppwr_app still cannot read the applied migration level it is asked to report';
  -- The read must stay a read. A principal that can write this table can make a deployment claim any
  -- schema version, which is the defect this migration exists to close rather than to relocate.
  ELSIF has_table_privilege('openppwr_app', 'openppwr_schema_migrations', 'INSERT')
     OR has_table_privilege('openppwr_app', 'openppwr_schema_migrations', 'UPDATE')
     OR has_table_privilege('openppwr_app', 'openppwr_schema_migrations', 'DELETE')
     OR has_table_privilege('openppwr_worker', 'openppwr_schema_migrations', 'INSERT')
     OR has_table_privilege('openppwr_worker', 'openppwr_schema_migrations', 'UPDATE')
     OR has_table_privilege('openppwr_worker', 'openppwr_schema_migrations', 'DELETE') THEN
    v_problem := 'a runtime principal can rewrite the applied migration level';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem;
  END IF;
END $$;

COMMIT;
