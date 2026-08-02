-- 037 — give each tenant its own audit chain, because verification already reads one tenant
--
-- Found in the two-tenant recovery rehearsal at 4caa45e and reproduced here before anything was changed.
-- The hash chain was written globally and verified per tenant, so the two only agreed when the database
-- held exactly one tenant.
--
--   * `append_openppwr_audit_event` (028) and `complete_openppwr_retention` (026) both took the link with
--     `SELECT a.event_hash FROM audit_events a ORDER BY a.sequence DESC LIMIT 1` — no tenant predicate —
--     inside a SECURITY DEFINER function owned by `openppwr_security_owner`, which is BYPASSRLS. "Previous"
--     therefore meant previous in the whole table, whoever wrote it.
--   * `verifyAuditChain` (packages/database/src/index.mjs) runs inside a tenant transaction as
--     `openppwr_app`, which is NOBYPASSRLS against a FORCE-RLS table, so it walks one tenant's rows and
--     starts from the constant 'GENESIS'.
--
-- Measured on an embedded PostgreSQL 18 with two tenants and three events each. Written in blocks, the way
-- the rehearsal provisions them, tenant A verified `valid: true` and tenant B `valid: false` at its own
-- first event, whose previous_hash was tenant A's newest event hash. Written interleaved, the way two
-- tenants sharing a deployment actually write, *both* tenants verified `valid: false` — A at its second
-- event, B at its first. Nothing was tampered with in either run. A broken integrity signal on an intact
-- record is worse than no signal, because it teaches the reader to disbelieve the control.
--
-- ---------------------------------------------------------------------------------------------------
-- The choice, and the one that was rejected
--
-- Two shapes close this, and they are not equivalent.
--
--   (a) Make the chain per-tenant — taken here. The previous-hash selection gains a tenant predicate; each
--       tenant's chain runs from its own 'GENESIS'. Verification already works exactly this way, so it
--       becomes correct with no change to any application file.
--
--   (b) Make verification follow the global sequence — rejected. Verifying a hash means recomputing it, and
--       recomputing it means holding every input: event_id, actor_id, action, entity_type, entity_id,
--       payload and occurred_at of every event in the chain. Under (b) a tenant's read-only auditor cannot
--       verify the deployment's chain without being handed every other tenant's audit record in full. There
--       is no partial form of this: a digest you cannot recompute is a digest you are asked to trust.
--       Getting there requires either dropping the tenant_isolation policy on `audit_events` — the isolation
--       guarantee this programme spent its whole length proving — or wrapping verification in a definer
--       function that returns one boolean across all tenants. That second form does not fail safe either: it
--       answers "is the deployment's chain intact", never "is my record intact", so tenant B's auditor is
--       still shown `valid: false` for an event tenant B cannot see, did not write and cannot explain. It
--       relocates the failure this migration exists to remove rather than removing it.
--
-- A third shape was considered and rejected for the pre-existing rows discussed below: record each tenant's
-- first observed previous_hash as a per-tenant anchor and have verification start from the anchor instead of
-- from 'GENESIS'. That repairs the grafted demonstration chains, and it destroys the control while doing it.
-- 'GENESIS' is a constant nobody can choose. An anchor is a value derived, at upgrade time, from the very
-- rows whose integrity is in question — so a chain whose first event had already been altered would be
-- certified by the repair. An anchor that blesses whatever it finds is not an anchor.
--
-- An earlier internal review named this same fork from the lock side: use one global advisory-lock key for
-- a global chain, or make both chain and verification tenant-local. This is the second of those two, and the
-- advisory lock deliberately stays global — see the note at the append function below.
--
-- ---------------------------------------------------------------------------------------------------
-- What this does to a chain that already exists
--
-- No row is read back, rewritten or re-hashed. `audit_events` refuses UPDATE, DELETE and TRUNCATE by trigger
-- (001 and 007) and this migration neither disables nor weakens those; the assertion block below fails the
-- migration if either trigger is missing or disabled when it finishes. There is no backfill because the
-- design does not need one, and a backfill is the one thing an append-only evidentiary record must not have.
--
--   A supported deployment — one tenant, which `/v1/bootstrap` and `create_openppwr_tenant` enforce and the
--   worker refuses to start against a violation of — is entirely unaffected. When the table holds one
--   tenant, that tenant's newest event *is* the table's newest event, so the new rule selects the same link
--   the old rule selected. The existing chain still verifies, the next event written after the upgrade
--   carries the pre-upgrade head as its previous_hash, and the chain continues unbroken across the
--   migration. This is demonstrated rather than asserted, in
--   packages/database/test/audit-chain-tenant-scope.integration.test.mjs.
--
--   A demonstration stack provisioned with scripts/acme/provision-synthetic-tenant.mjs holds more than one
--   tenant, and its later tenants' chains were already grafted onto an earlier tenant's before this
--   migration ran. Those rows are immutable and stay exactly as written: the historical break at such a
--   tenant's first event remains reported, which is the honest answer, because the record really does not
--   begin at a genesis. What changes is that nothing further is grafted — each tenant's next event links to
--   its own tail — so a tenant created after the upgrade starts at 'GENESIS' and verifies cleanly even
--   though the table is not empty. Any already-grafted tenant is named in a NOTICE below so an operator
--   upgrading such a stack learns it from the upgrade rather than from a failing verification later.

BEGIN;

-- ---------------------------------------------------------------------------------------------------
-- 1. The rule, in one place
--
-- The chain head was selected inline in two different functions, and the two had to agree. They did agree —
-- on the wrong thing, identically — which is the argument for naming it once rather than for trusting two
-- copies to stay in step. This is the same instinct that put the canonical encoder in
-- `openppwr_audit_canonical_hash_v2` and had the writer and the verifier share it.
--
-- Not SECURITY DEFINER. It lends nothing: called from inside the two definer functions it already runs with
-- the owner's rights, and there is no reason for it to carry any of its own. `search_path` is pinned anyway,
-- because a function reached from a definer context must not be resolvable to a caller-supplied table.
--
-- 'GENESIS' for a tenant with no events, so the constant that anchors every chain is written once too.
CREATE OR REPLACE FUNCTION openppwr_audit_chain_head(p_tenant_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT a.event_hash FROM audit_events a
      WHERE a.tenant_id = p_tenant_id
      ORDER BY a.sequence DESC LIMIT 1),
    'GENESIS')
$$;

-- Owned by the definer owner and granted to nobody. The two callers are definer functions that run as this
-- owner, so no runtime principal needs EXECUTE — and none gets it, because a principal that could ask for an
-- arbitrary tenant's head hash would have a one-argument read across the isolation boundary. Functions are
-- executable by PUBLIC unless revoked, so the REVOKE is the grant statement that matters here.
ALTER FUNCTION openppwr_audit_chain_head(uuid) OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION openppwr_audit_chain_head(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------
-- 2. The generic append path
--
-- Reproduced from 028 with one line changed: the tail selection becomes the call above. Everything else —
-- the action registry check, the credential resolution, the maintenance-principal branch, the canonical
-- hash, the insert — is byte-for-byte what 028 established, because none of it is what was wrong.
--
-- The advisory lock stays global and stays where it is. It exists to make "read the tail, then insert"
-- atomic, and a global key over per-tenant chains is strictly stronger than the chains require: it
-- serialises appends that no longer need serialising. Scoping the key per tenant would be a throughput
-- change with no correctness content — in the one configuration this product supports there is one tenant,
-- so the two keys are the same key — and it would have to move below the credential resolution to know the
-- tenant, which changes the order in which an unauthenticated caller is refused. This was a chain and a
-- lock disagreeing about scope; the safe direction out of that is the broader lock, not the narrower one.
CREATE OR REPLACE FUNCTION append_openppwr_audit_event(
  p_actor_token_hash text, p_action text, p_entity_type text, p_entity_id text, p_payload jsonb
) RETURNS TABLE (event_id uuid, event_hash text, previous_hash text, tenant uuid, actor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller text := session_user;
  v_tenant uuid;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));

  IF p_action IS NULL OR length(p_action) = 0 OR p_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit event is incomplete' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_action_registry r
     WHERE r.allowed_principal = v_caller AND p_action LIKE r.action_pattern
  ) THEN
    RAISE EXCEPTION 'action % is not registered for %', p_action, v_caller
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_actor_token_hash IS NOT NULL THEN
    SELECT i.tenant_id, i.id INTO v_tenant, v_actor
      FROM identities i
     WHERE i.token_hash = p_actor_token_hash AND i.active = true
       AND (i.token_expires_at IS NULL OR i.token_expires_at > now());
    IF v_actor IS NULL THEN
      SELECT i.tenant_id, i.id INTO v_tenant, v_actor
        FROM auth_sessions s
        JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
       WHERE s.token_hash = p_actor_token_hash AND s.revoked_at IS NULL
         AND s.expires_at > now() AND i.active = true;
    END IF;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'audit actor credential is not valid' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_caller = 'openppwr_maintenance'
        AND p_action IN ('demo.reset', 'demo.reset.completed')
        AND p_entity_type = 'tenant'
        AND p_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_tenant := p_entity_id::uuid;
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = v_tenant) THEN
      RAISE EXCEPTION 'maintenance audit tenant does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;
    v_actor := md5('openppwr_maintenance')::uuid;
    v_payload := v_payload || jsonb_build_object('servicePrincipal', v_caller);
  ELSE
    RAISE EXCEPTION 'an audit event requires an actor credential' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The one changed line. `v_tenant` is derived above from the presented credential or from the registered
  -- maintenance callsite, never from an argument, so the chain a caller extends is not a caller's choice.
  v_previous := openppwr_audit_chain_head(v_tenant);
  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, v_tenant, v_actor, p_action, p_entity_type, p_entity_id,
    v_payload, v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (v_tenant, v_event_id, v_actor, p_action, p_entity_type, p_entity_id,
          v_payload, v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN QUERY SELECT v_event_id, v_hash, v_previous, v_tenant, v_actor;
END $$;

-- CREATE OR REPLACE keeps the existing owner and ACL, so these restate rather than change. They are written
-- out because a reader checking who may append should not have to go back to 028 to find out, and because
-- the assertion block below checks exactly this set.
ALTER FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  FROM openppwr_auth;
GRANT EXECUTE ON FUNCTION append_openppwr_audit_event(text, text, text, text, jsonb)
  TO openppwr_app, openppwr_maintenance, openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- 3. The second append path, which is the one a fix could easily have missed
--
-- `complete_openppwr_retention` (026) does not call the generic append. It writes `evidence.retention.deleted`
-- inline, deliberately: 025 moved the record inside the completion so a deletion cannot be recorded
-- separately from the state change, and 025's own assertion requires the INSERT to stay in this body. It
-- carried its own copy of the unscoped tail selection, so a worker completing a retention deletion would
-- have gone on grafting the chain even after the generic path was corrected. Reproduced from 026 with the
-- same single line changed, and the catalogue scan in section 4 is what makes "did I find every callsite"
-- an answered question rather than a remembered one.
CREATE OR REPLACE FUNCTION complete_openppwr_retention(
  p_tenant_id uuid, p_evidence_id uuid, p_owner uuid, p_generation integer,
  p_cutoff timestamptz, p_actor_token_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_storage_key text;
  v_actor uuid;
  v_event_id uuid := gen_random_uuid();
  v_previous text;
  v_hash text;
  v_occurred timestamptz := now();
  v_cutoff timestamptz := least(coalesce(p_cutoff, now()), now());
BEGIN
  -- The actor is whoever presented a credential, resolved the same way the canonical append resolves it.
  -- The worker holds its own token; nobody else's identity is attributed to work it did not do.
  IF p_actor_token_hash IS NULL OR p_actor_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'a completion must be attributed to a presented credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT i.id INTO v_actor
    FROM identities i
   WHERE i.tenant_id = p_tenant_id AND i.token_hash = p_actor_token_hash AND i.active = true
     AND (i.token_expires_at IS NULL OR i.token_expires_at > now());

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'completion actor credential is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- One statement. The claim is checked and consumed together, so nothing can reclaim the row between the
  -- two — there is no between.
  UPDATE evidence_files
     SET retention_status = 'deleted', deleted_at = v_occurred,
         retention_lease_owner = NULL, retention_lease_expires_at = NULL
   WHERE tenant_id = p_tenant_id AND id = p_evidence_id AND retention_status = 'deleting'
     AND retention_lease_owner = p_owner AND retention_generation = p_generation
     AND retention_lease_expires_at >= now()
  RETURNING storage_key INTO v_storage_key;

  IF v_storage_key IS NULL THEN
    RETURN false;
  END IF;

  -- The tenant here is an argument rather than a credential-derived value, which is safe for the same reason
  -- the UPDATE above is: the actor was resolved against this very tenant two statements ago, so a caller
  -- naming a tenant it holds no credential for has already been refused.
  PERFORM pg_advisory_xact_lock(hashtext('openppwr-audit-chain'));
  v_previous := openppwr_audit_chain_head(p_tenant_id);

  v_hash := openppwr_audit_canonical_hash_v2(
    v_event_id, p_tenant_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
    jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff),
    v_occurred, v_previous);

  INSERT INTO audit_events (tenant_id, event_id, actor_id, action, entity_type, entity_id,
                            payload, occurred_at, previous_hash, event_hash, hash_algorithm)
  VALUES (p_tenant_id, v_event_id, v_actor, 'evidence.retention.deleted', 'evidence', p_evidence_id::text,
          jsonb_build_object('storageKey', v_storage_key, 'completedBy', p_owner, 'cutoff', v_cutoff),
          v_occurred, v_previous, v_hash, 'sql-canonical-v2');

  RETURN true;
END $$;

ALTER FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text)
  OWNER TO openppwr_security_owner;
REVOKE ALL ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_openppwr_retention(uuid, uuid, uuid, integer, timestamptz, text)
  TO openppwr_worker;

-- ---------------------------------------------------------------------------------------------------
-- 4. Assertions
--
-- A migration that changes how a control works and does not check that it now works that way is the defect
-- class this repository has removed four times. Each check below is the property in its own terms, evaluated
-- against the rows and the catalogue this deployment actually has.

DO $$
DECLARE
  v_problem text;
  v_unscoped text;
  v_absent uuid := gen_random_uuid();
  v_grafted text;
BEGIN
  -- 4.1 Every callsite, from the catalogue rather than from memory. Any function in `public` whose body
  -- inserts into `audit_events` must take its link through the named head. Enumerating by hand is how
  -- `complete_openppwr_retention` came within one edit of being left behind.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_unscoped
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%INSERT INTO audit_events%'
     AND p.prosrc NOT LIKE '%openppwr_audit_chain_head%';
  IF v_unscoped IS NOT NULL THEN
    v_problem := format('a function still links the audit chain without the tenant-scoped head: %s', v_unscoped);

  -- 4.2 The head is anchored for a tenant that has written nothing. If this returned NULL the canonical hash
  -- would take a NULL previous_hash and the NOT NULL column would refuse the insert; if it returned some
  -- other tenant's hash we would be back where we started.
  ELSIF openppwr_audit_chain_head(v_absent) <> 'GENESIS' THEN
    v_problem := 'a tenant with no events does not start from GENESIS';

  -- 4.3 The head never belongs to somebody else. This is the defect this migration exists to close, stated
  -- directly and evaluated over every tenant row this database holds. It fails under the pre-037 rule as
  -- soon as a second tenant has written.
  ELSIF EXISTS (
    SELECT 1 FROM tenants t
      JOIN audit_events a ON a.event_hash = openppwr_audit_chain_head(t.id)
     WHERE a.tenant_id <> t.id
  ) THEN
    v_problem := 'the chain head selected for a tenant belongs to a different tenant';

  -- 4.4 Immutability is untouched. Both guards present, both enabled ('O' is origin-enabled; 'D' is
  -- disabled, which is how a tamperer with table ownership would arrange to write). A migration that made
  -- the chain per-tenant by making the table mutable would have fixed nothing.
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'audit_events'::regclass AND tgname = 'audit_events_immutable'
       AND NOT tgisinternal AND tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'audit_events'::regclass AND tgname = 'audit_events_truncate_guard'
       AND NOT tgisinternal AND tgenabled = 'O'
  ) THEN
    v_problem := 'the audit immutability guards are missing or disabled after this migration';

  -- 4.5 The head function lends nothing to anybody. Granted to no runtime principal and revoked from PUBLIC,
  -- so the only way to reach it is through the two definer functions that own the operation.
  ELSIF has_function_privilege('public', 'openppwr_audit_chain_head(uuid)', 'EXECUTE')
     OR has_function_privilege('openppwr_app', 'openppwr_audit_chain_head(uuid)', 'EXECUTE')
     OR has_function_privilege('openppwr_auth', 'openppwr_audit_chain_head(uuid)', 'EXECUTE')
     OR has_function_privilege('openppwr_worker', 'openppwr_audit_chain_head(uuid)', 'EXECUTE')
     OR has_function_privilege('openppwr_maintenance', 'openppwr_audit_chain_head(uuid)', 'EXECUTE')
     OR has_function_privilege('openppwr_rotation', 'openppwr_audit_chain_head(uuid)', 'EXECUTE') THEN
    v_problem := 'a principal can ask for an arbitrary tenant''s chain head directly';

  -- 4.6 Replacing the two function bodies did not move the boundary either function stands on. Restating
  -- 028's and 026's grants above should have been a no-op; this is the check that it was.
  ELSIF NOT has_function_privilege('openppwr_app', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('openppwr_worker', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('openppwr_maintenance', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('openppwr_auth', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('public', 'append_openppwr_audit_event(text,text,text,text,jsonb)', 'EXECUTE') THEN
    v_problem := 'the audit append boundary changed while the chain was being scoped';
  ELSIF NOT has_function_privilege('openppwr_worker', 'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('openppwr_app', 'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('public', 'complete_openppwr_retention(uuid,uuid,uuid,integer,timestamptz,text)', 'EXECUTE') THEN
    v_problem := 'the retention completion boundary changed while the chain was being scoped';

  -- 4.7 Both functions are still definer functions owned by the explicit owner. 017 requires this of every
  -- definer function; CREATE OR REPLACE preserves ownership, and this is the check that it did.
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('append_openppwr_audit_event', 'complete_openppwr_retention')
       AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'openppwr_security_owner')
  ) THEN
    v_problem := 'an audit-writing function lost its definer status or its explicit owner';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'per-tenant audit chain assertion failed: %', v_problem;
  END IF;

  -- Not a failure, and deliberately not one: refusing here would block the upgrade of exactly the
  -- multi-tenant demonstration stack that most needs it. A tenant whose earliest event does not begin at
  -- 'GENESIS' was grafted onto another tenant's chain before this migration ran. Those rows are immutable
  -- and stay as written, so that tenant's verification keeps reporting the break at its first event. It is
  -- named here so an operator hears it from the upgrade rather than from a support ticket.
  SELECT string_agg(x.tenant_id::text, ', ' ORDER BY x.tenant_id::text) INTO v_grafted
    FROM (
      SELECT DISTINCT ON (a.tenant_id) a.tenant_id, a.previous_hash
        FROM audit_events a ORDER BY a.tenant_id, a.sequence
    ) x
   WHERE x.previous_hash <> 'GENESIS';
  IF v_grafted IS NOT NULL THEN
    RAISE NOTICE 'audit chains written before 037 begin mid-chain for tenant(s) %; those events are immutable and their verification still reports the break at the first event. Every event written from now on links within its own tenant.', v_grafted;
  END IF;
END $$;

COMMIT;
