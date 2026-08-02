-- 020 — one way into the audit chain, and it checks the link before it writes
--
-- `openppwr_maintenance` kept `INSERT` on `audit_events` so the demonstration reset could record
-- itself on its own connection, by the one application-side encoder, in the same transaction as the
-- deletion. That reasoning still holds — a second hash-chain encoder in PL/pgSQL could drift and silently
-- break verification — but the grant it justified was far wider than the need.
--
-- With a direct `INSERT` that principal can write a plausible event about something that never happened,
-- write an event whose `previous_hash` links to nothing and breaks verification for every event after it,
-- and race a legitimate append because nothing obliges it to take the advisory lock. The immutability
-- triggers stop `UPDATE` and `DELETE`; they were never going to stop a malicious or careless `INSERT`.
--
-- The fix keeps one encoder and removes the direct write. The function below does not recompute the content
-- hash — that stays in the application, exactly once — but it takes the lock itself, verifies that the
-- supplied link matches the current tail, and refuses an action the calling principal has no business
-- recording.

BEGIN;

CREATE OR REPLACE FUNCTION append_openppwr_audit_event(
  p_tenant_id uuid, p_event_id uuid, p_actor_id uuid, p_action text,
  p_entity_type text, p_entity_id text, p_payload jsonb, p_occurred_at timestamptz,
  p_previous_hash text, p_event_hash text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tail text;
  v_caller text := current_user;
BEGIN
  -- Taken here rather than trusted to the caller. An append that skipped the lock could interleave with a
  -- legitimate one and produce two events claiming the same predecessor.
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text));

  IF p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'audit event hash is not a sha256 digest' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_previous_hash IS NULL OR (p_previous_hash <> 'GENESIS' AND p_previous_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'audit previous hash is not a sha256 digest' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action IS NULL OR length(p_action) = 0 OR p_tenant_id IS NULL OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The chain is global, not per tenant, so the tail is the last event of the whole table. An event whose
  -- link does not match it would verify as broken for every event after it, which is the failure a caller
  -- could previously produce with one INSERT.
  SELECT event_hash INTO v_tail FROM audit_events ORDER BY sequence DESC LIMIT 1;
  IF coalesce(v_tail, 'GENESIS') <> p_previous_hash THEN
    RAISE EXCEPTION 'audit event does not link to the current chain tail'
      USING ERRCODE = 'serialization_failure',
            HINT = 'The chain moved between reading the tail and appending; retry the operation.';
  END IF;

  -- What each principal is allowed to say happened. The maintenance credential exists to reset a
  -- demonstration environment and to record that it did; it has no business writing an evidence review or a
  -- sign-in. Without this it could produce a plausible history of events that never occurred.
  IF v_caller = 'openppwr_maintenance' AND p_action <> 'demo.reset' THEN
    RAISE EXCEPTION 'the maintenance principal may only record its own reset'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash)
  VALUES (p_tenant_id, p_event_id, p_actor_id, p_action, p_entity_type, p_entity_id,
          coalesce(p_payload, '{}'::jsonb), p_occurred_at, p_previous_hash, p_event_hash);
END $$;

ALTER FUNCTION append_openppwr_audit_event(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text, text)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(uuid, uuid, uuid, text, text, text, jsonb, timestamptz, text, text)
  TO openppwr_app, openppwr_maintenance;

-- The owner performs the write, so it needs what the write needs and the callers no longer do.
GRANT SELECT, INSERT ON audit_events TO openppwr_security_owner;
GRANT USAGE, SELECT ON SEQUENCE audit_events_sequence_seq TO openppwr_security_owner;

-- The direct route. Reading stays: the API verifies the chain and the maintenance path reads the tail
-- before computing a hash. Writing goes through the function.
REVOKE INSERT ON audit_events FROM openppwr_app;
REVOKE INSERT ON audit_events FROM openppwr_maintenance;
REVOKE USAGE, SELECT ON SEQUENCE audit_events_sequence_seq FROM openppwr_maintenance;

DO $$
DECLARE
  v_problem text;
BEGIN
  IF has_table_privilege('openppwr_app', 'audit_events', 'INSERT') THEN
    v_problem := 'the request-serving role can still write the chain directly';
  ELSIF has_table_privilege('openppwr_maintenance', 'audit_events', 'INSERT') THEN
    v_problem := 'the maintenance role can still write the chain directly';
  ELSIF has_table_privilege('openppwr_app', 'audit_events', 'UPDATE')
     OR has_table_privilege('openppwr_app', 'audit_events', 'DELETE') THEN
    v_problem := 'the request-serving role can alter recorded history';
  ELSIF NOT has_table_privilege('openppwr_app', 'audit_events', 'SELECT') THEN
    v_problem := 'the request-serving role can no longer verify the chain';
  ELSIF NOT has_function_privilege('openppwr_app',
      'append_openppwr_audit_event(uuid,uuid,uuid,text,text,text,jsonb,timestamptz,text,text)', 'EXECUTE') THEN
    v_problem := 'the request-serving role can no longer record anything';
  ELSIF has_function_privilege('public',
      'append_openppwr_audit_event(uuid,uuid,uuid,text,text,text,jsonb,timestamptz,text,text)', 'EXECUTE') THEN
    v_problem := 'PUBLIC can append to the audit chain';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'canonical audit append assertion failed: %', v_problem;
  END IF;
END $$;

COMMIT;
