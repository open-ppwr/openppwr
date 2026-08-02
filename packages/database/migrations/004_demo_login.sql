-- SPDX-License-Identifier: Apache-2.0
-- Interactive sign-in for the demonstration environment.
--
-- Design note: sign-in issues a short-lived **bearer** token, not a cookie. A cookie session would
-- make CSRF applicable and invalidate the documented NOT_APPLICABLE assessment and its regression
-- tests. Keeping the credential in a header preserves that property while still giving users a real
-- login, and adds token expiry, which bootstrap-issued identity tokens do not have.

-- Sign-in accounts. Each maps to exactly one existing identity, so authorisation continues to flow
-- from the role model rather than from a parallel permission system.
CREATE TABLE IF NOT EXISTS demo_users (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  identity_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
-- identity_id deliberately carries no foreign key, matching gaps.owner_id and audit_events.actor_id.
-- identities enforces FORCE ROW LEVEL SECURITY, and referential-integrity checks against it cannot
-- see rows without a tenant in scope, so a constraint here would reject valid inserts. Integrity is
-- instead guaranteed by lookup_openppwr_demo_user, which only ever returns a real identity, and by
-- the join in authenticate_openppwr_token, which ignores a session whose identity is absent.

-- Issued sessions. Hash-only, exactly like identity tokens: a stolen database row cannot be
-- replayed as a credential.
CREATE TABLE IF NOT EXISTS auth_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions (expires_at);

ALTER TABLE demo_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_users FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

-- Dropped first so the migration can be re-applied safely after a partial failure, matching the
-- idempotency of migration 003.
DROP POLICY IF EXISTS demo_users_tenant_isolation ON demo_users;
CREATE POLICY demo_users_tenant_isolation ON demo_users
  USING (tenant_id = current_setting('openppwr.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('openppwr.tenant_id', true)::uuid);
DROP POLICY IF EXISTS auth_sessions_tenant_isolation ON auth_sessions;
CREATE POLICY auth_sessions_tenant_isolation ON auth_sessions
  USING (tenant_id = current_setting('openppwr.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('openppwr.tenant_id', true)::uuid);

-- Sign-in happens before any tenant context exists, so lookup runs through a SECURITY DEFINER
-- function exactly like token authentication. It returns the stored hash and salt for the caller to
-- verify; it never performs the comparison itself and never returns a usable credential.
CREATE OR REPLACE FUNCTION lookup_openppwr_demo_user(p_email text)
RETURNS TABLE (tenant_id uuid, user_id uuid, identity_id uuid, password_hash text, password_salt text, actor_role text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT u.tenant_id, u.id, u.identity_id, u.password_hash, u.password_salt, i.role
  FROM demo_users u
  JOIN identities i ON i.tenant_id = u.tenant_id AND i.id = u.identity_id
  WHERE lower(u.email) = lower(p_email) AND u.active = true AND i.active = true
$$;
REVOKE ALL ON FUNCTION lookup_openppwr_demo_user(text) FROM PUBLIC;

-- Session issuance also predates tenant context, so it runs SECURITY DEFINER and sets the tenant
-- transaction-locally for the row-level policy on auth_sessions.
CREATE OR REPLACE FUNCTION issue_openppwr_session(
  p_tenant_id uuid, p_identity_id uuid, p_session_id uuid, p_token_hash text, p_expires_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('openppwr.tenant_id', p_tenant_id::text, true);
  INSERT INTO auth_sessions (tenant_id, id, identity_id, token_hash, expires_at)
  VALUES (p_tenant_id, p_session_id, p_identity_id, p_token_hash, p_expires_at);
END
$$;
REVOKE ALL ON FUNCTION issue_openppwr_session(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;

-- Token authentication now accepts either a bootstrap-issued identity token or a live session
-- token. Expired and revoked sessions are excluded here rather than in application code, so no
-- caller can forget the check.
CREATE OR REPLACE FUNCTION authenticate_openppwr_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, actor_id uuid, actor_role text, supplier_id text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.role, i.supplier_id
  FROM identities i
  WHERE i.token_hash = p_token_hash AND i.active = true
  UNION ALL
  SELECT i.tenant_id, i.id, i.role, i.supplier_id
  FROM auth_sessions s
  JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND i.active = true
$$;

GRANT SELECT, INSERT, UPDATE ON demo_users TO openppwr_app;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO openppwr_app;
GRANT EXECUTE ON FUNCTION lookup_openppwr_demo_user(text) TO openppwr_app;
GRANT EXECUTE ON FUNCTION issue_openppwr_session(uuid, uuid, uuid, text, timestamptz) TO openppwr_app;

-- Demonstration reset.
--
-- The application role deliberately holds no DELETE grant on domain tables, which is a control the
-- security profile relies on: a compromised application cannot erase evidence or audit history.
-- Granting DELETE to make a reset button work would remove that control for every table, permanently.
--
-- Instead the reset runs as one owner-privileged function that deletes only the caller's own tenant,
-- only from domain tables, and never touches tenants, identities, demo_users, auth_sessions or
-- audit_events. The application role gains the ability to reset a tenant, and nothing else.
CREATE OR REPLACE FUNCTION reset_openppwr_demo_tenant(p_tenant_id uuid)
RETURNS TABLE (packaging_remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM dossier_artifacts WHERE tenant_id = p_tenant_id;
  DELETE FROM review_snapshots  WHERE tenant_id = p_tenant_id;
  DELETE FROM assessment_results WHERE tenant_id = p_tenant_id;
  DELETE FROM assessments       WHERE tenant_id = p_tenant_id;
  DELETE FROM gaps              WHERE tenant_id = p_tenant_id;
  DELETE FROM scan_jobs         WHERE tenant_id = p_tenant_id;
  DELETE FROM evidence_files    WHERE tenant_id = p_tenant_id;
  DELETE FROM evidence_requirements WHERE tenant_id = p_tenant_id;
  DELETE FROM bom_lines         WHERE tenant_id = p_tenant_id;
  DELETE FROM boms              WHERE tenant_id = p_tenant_id;
  DELETE FROM packaging         WHERE tenant_id = p_tenant_id;
  DELETE FROM components        WHERE tenant_id = p_tenant_id;
  DELETE FROM materials         WHERE tenant_id = p_tenant_id;
  DELETE FROM suppliers         WHERE tenant_id = p_tenant_id;
  DELETE FROM import_row_results WHERE tenant_id = p_tenant_id;
  DELETE FROM import_runs       WHERE tenant_id = p_tenant_id;
  RETURN QUERY SELECT count(*)::int FROM packaging WHERE tenant_id = p_tenant_id;
END
$$;
REVOKE ALL ON FUNCTION reset_openppwr_demo_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_openppwr_demo_tenant(uuid) TO openppwr_app;
