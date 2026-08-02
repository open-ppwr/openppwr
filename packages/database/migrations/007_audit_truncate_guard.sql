-- Audit immutability did not cover TRUNCATE.
--
-- `audit_events` has carried an immutability guard since migration 001:
--
--   CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
--   FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
--
-- PostgreSQL does not fire row-level triggers on TRUNCATE. There are no rows to iterate, so a
-- FOR EACH ROW trigger is never consulted, and `TRUNCATE audit_events` removed the entire audit chain
-- without raising anything.
--
-- This was not theoretical. The project's own global demonstration reset used
-- `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` across the domain tables, `audit_events` among them, so
-- every global reset had been erasing audit history while the guard reported nothing. It surfaced on
-- 2026-07-30 only because a newly written tenant-scoped reset used DELETE instead and was immediately
-- refused by the row trigger — the guard worked, and its silence on the other path was the finding.
--
-- This migration closes it with a statement-level trigger, which is the only kind TRUNCATE consults: a
-- row trigger has no rows to iterate over, so TRUNCATE never fires one.
--
-- Trust boundary, stated so the guarantee is not overclaimed: this makes the audit chain immutable
-- against every operation available to the OpenPPWR runtime roles and against standard database
-- operations. A fully privileged database superuser can still disable a trigger, and therefore remains
-- outside this boundary. That is a property of PostgreSQL, not a gap we can close in SQL.

CREATE OR REPLACE FUNCTION reject_audit_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only: TRUNCATE is not permitted on audit_events'
    USING ERRCODE = 'raise_exception',
          HINT = 'Clear business data per tenant instead; audit history is retained deliberately.';
END $$;

-- FOR EACH STATEMENT, not FOR EACH ROW: a TRUNCATE has no rows to iterate, which is exactly why the
-- original guard did not fire.
DROP TRIGGER IF EXISTS audit_events_truncate_guard ON audit_events;
CREATE TRIGGER audit_events_truncate_guard
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();

REVOKE TRUNCATE ON audit_events FROM PUBLIC;
