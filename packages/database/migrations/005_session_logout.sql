-- Signing out.
--
-- Until now a session could only end by expiring. A user who finished working, or who wanted to
-- continue as a different role, had no way to end the session they held: closing the tab discarded
-- the token from the browser but left it valid on the server for the remainder of its twelve hours.
-- That is not a sign-out, it is forgetting.

-- Authentication now also reports which session authorised the request and when it expires. The
-- session identifier is needed so a sign-out can revoke exactly the credential that was presented
-- rather than every session the identity holds, and the expiry is needed so the interface can tell
-- the user how long they have. Identity tokens have neither: they are static operator credentials,
-- and both columns are NULL for them, which is how the application distinguishes the two.
-- The result columns change, and PostgreSQL refuses to replace a set-returning function whose return
-- type differs. Dropping first is therefore required rather than tidy. It is safe because the
-- function is stateless and recreated in the same transaction, so no request can observe its absence.
DROP FUNCTION IF EXISTS authenticate_openppwr_token(text);

CREATE FUNCTION authenticate_openppwr_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, actor_id uuid, actor_role text, supplier_id text, session_id uuid, session_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.role, i.supplier_id, NULL::uuid, NULL::timestamptz
  FROM identities i
  WHERE i.token_hash = p_token_hash AND i.active = true
  UNION ALL
  SELECT i.tenant_id, i.id, i.role, i.supplier_id, s.id, s.expires_at
  FROM auth_sessions s
  JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND i.active = true
$$;

-- Revocation.
--
-- SECURITY DEFINER for the same reason as the other pre-context helpers: the caller has already been
-- authenticated, but revoking runs before any tenant context is established, and auth_sessions
-- enforces FORCE row level security. The tenant is passed in from the verified identity rather than
-- taken from the row, so a session can never be revoked across a tenant boundary even if a session
-- identifier were guessed.
--
-- Revoking an already-revoked or expired session reports false rather than raising: signing out twice
-- is not an error, and the honest answer is that nothing was revoked this time.
CREATE OR REPLACE FUNCTION revoke_openppwr_session(p_tenant_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE auth_sessions
     SET revoked_at = now()
   WHERE id = p_session_id
     AND tenant_id = p_tenant_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION revoke_openppwr_session(uuid, uuid) TO openppwr_app;
