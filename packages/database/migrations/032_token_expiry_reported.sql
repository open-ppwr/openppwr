-- 032 — a static token's own expiry was discarded, not merely unreported
--
-- authenticate_openppwr_token's static-identity-token branch enforces `i.token_expires_at > now()` in its
-- WHERE clause, then returns a literal NULL::timestamptz for the same row's expiry column — so every caller
-- of this function, including the API's own /v1/session response, has reported "no automatic expiry" for a
-- credential the database will reject the moment that timestamp passes. The column is still
-- named session_expires_at for the session branch it was written for; it now carries the effective expiry
-- of whichever credential kind actually authenticated, which is what every caller of this function already
-- assumed it meant.

BEGIN;

CREATE OR REPLACE FUNCTION authenticate_openppwr_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, actor_id uuid, actor_role text, supplier_id text, session_id uuid, session_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.role, i.supplier_id, NULL::uuid, i.token_expires_at
  FROM identities i
  WHERE i.token_hash = p_token_hash
    AND i.active = true
    AND i.token_expires_at > now()
  UNION ALL
  SELECT i.tenant_id, i.id, i.role, i.supplier_id, s.id, s.expires_at
  FROM auth_sessions s
  JOIN identities i ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND i.active = true
$$;

COMMIT;
