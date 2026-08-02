-- 027 — exact audit authority and recoverable retention failures
--
-- Applied migrations remain unchanged. This migration replaces
-- guessed audit authority with the exact append callsite census, reserves a storage namespace for
-- per-evidence tombstones, and lets the current fenced owner record uncertainty after its lease expires.

BEGIN;

-- A registry row is authority, not documentation. Every row below has a matching appendAudit callsite.
-- `evidence.retention.deleted` is intentionally absent: completion writes that fixed action internally and
-- no principal needs authority to submit it through the generic append function.
DELETE FROM audit_action_registry;

INSERT INTO audit_action_registry (action_pattern, allowed_principal) VALUES
  ('demo.reset',                       'openppwr_maintenance'),
  ('demo.reset.completed',             'openppwr_maintenance'),

  ('evidence.scan.clean',              'openppwr_worker'),
  ('evidence.scan.infected',           'openppwr_worker'),
  ('evidence.scan.error',              'openppwr_worker'),
  ('evidence.scan.timeout',            'openppwr_worker'),
  ('evidence.scan.requires_attention', 'openppwr_worker'),

  ('tenant.bootstrapped',              'openppwr_app'),
  ('evidence.quarantined',             'openppwr_app'),
  ('evidence.accepted',                'openppwr_app'),
  ('evidence.rejected',                'openppwr_app'),
  ('evidence.scan.requeued',           'openppwr_app'),
  ('assessment.completed',             'openppwr_app'),
  ('gap.assigned',                     'openppwr_app'),
  ('gap.remediated',                   'openppwr_app'),
  ('import.accepted',                  'openppwr_app'),
  ('import.rejected',                  'openppwr_app'),
  ('review_snapshot.frozen',           'openppwr_app'),
  ('dossier.generated',                'openppwr_app');

-- New tombstones live below this reserved root, then below the evidence id. A storage key may not claim
-- that namespace: uniqueness alone did not stop one row's valid original filename from looking exactly
-- like another row's suffix-based tombstone.
ALTER TABLE evidence_files
  DROP CONSTRAINT IF EXISTS evidence_files_retention_namespace_reserved;
ALTER TABLE evidence_files
  ADD CONSTRAINT evidence_files_retention_namespace_reserved
  CHECK (
    storage_key <> '.openppwr-retention-tombstones'
    AND storage_key NOT LIKE '.openppwr-retention-tombstones/%'
  );

CREATE OR REPLACE FUNCTION mark_openppwr_retention_uncertain(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- A storage failure can finish after the lease time passes. Expiry alone must not strand `deleting`.
  -- Owner and generation remain the fence: if another worker reclaimed the row, this update affects zero
  -- rows and the caller must report lease loss instead of overwriting the new claim.
  UPDATE evidence_files
     SET retention_status = 'integrity_unknown',
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation;
  RETURN FOUND;
END $$;

ALTER FUNCTION mark_openppwr_retention_uncertain(uuid, uuid, uuid, integer)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION mark_openppwr_retention_uncertain(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_openppwr_retention_uncertain(uuid, uuid, uuid, integer)
  FROM openppwr_app, openppwr_auth, openppwr_maintenance;
GRANT EXECUTE ON FUNCTION mark_openppwr_retention_uncertain(uuid, uuid, uuid, integer)
  TO openppwr_worker;

DO $$
DECLARE
  v_expected text[] := ARRAY[
    'openppwr_maintenance:demo.reset',
    'openppwr_maintenance:demo.reset.completed',
    'openppwr_worker:evidence.scan.clean',
    'openppwr_worker:evidence.scan.infected',
    'openppwr_worker:evidence.scan.error',
    'openppwr_worker:evidence.scan.timeout',
    'openppwr_worker:evidence.scan.requires_attention',
    'openppwr_app:tenant.bootstrapped',
    'openppwr_app:evidence.quarantined',
    'openppwr_app:evidence.accepted',
    'openppwr_app:evidence.rejected',
    'openppwr_app:evidence.scan.requeued',
    'openppwr_app:assessment.completed',
    'openppwr_app:gap.assigned',
    'openppwr_app:gap.remediated',
    'openppwr_app:import.accepted',
    'openppwr_app:import.rejected',
    'openppwr_app:review_snapshot.frozen',
    'openppwr_app:dossier.generated'
  ];
  v_actual text[];
BEGIN
  SELECT array_agg(allowed_principal || ':' || action_pattern ORDER BY allowed_principal, action_pattern)
    INTO v_actual
    FROM audit_action_registry;

  SELECT array_agg(entry ORDER BY entry) INTO v_expected
    FROM unnest(v_expected) AS expected(entry);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'audit action registry differs from the reviewed append callsite census';
  END IF;

  IF has_function_privilege(
       'openppwr_app',
       'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'openppwr_maintenance',
       'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'public',
       'mark_openppwr_retention_uncertain(uuid,uuid,uuid,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'retention uncertainty transition is callable outside the worker principal';
  END IF;
END $$;

COMMIT;
