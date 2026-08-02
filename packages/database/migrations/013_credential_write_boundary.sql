-- The application role could set a token hash and mint a session without holding any credential.
--
-- Migration 001 granted `UPDATE` on `identities` to `openppwr_app`, and migration 004 granted
-- `SELECT, INSERT, UPDATE` on `auth_sessions`. Row-level security limits which rows the role sees; it does
-- not limit which columns it may write. So the role could:
--
--   * overwrite `identities.token_hash` for any identity in its tenant, seizing an operator identity; or
--   * insert an `auth_sessions` row with a token hash and expiry of its choosing, minting a session for any
--     identity, with no password and no existing credential.
--
-- `rotate_openppwr_identity_token` asks for the current hash as proof of possession. Against this role that
-- proof is a formality: it holds `SELECT` on `identities` and can read the verifier it is being asked to
-- present. **A stored hash is not a proof of possession when the caller can read it.**
--
-- No owner decision was needed, because the architecture had already answered the question and the grants
-- were left over from before it did. Every credential operation in this product goes through a
-- SECURITY DEFINER function inside the authentication boundary:
--
--   authenticate_openppwr_token   resolves a bearer token or a session token
--   issue_openppwr_session        creates a session after `signIn` has verified a password
--   revoke_openppwr_session       ends one
--   rotate_openppwr_identity_token / revoke_openppwr_identity_token   operator credential lifecycle
--
-- Verified before revoking: no application code updates `identities`, and no application code touches
-- `auth_sessions` at all. The only direct writers are operator scripts, which connect with the migration
-- credential rather than the application role. The grants below were therefore reachable capability that
-- nothing used — the worst kind, because nothing fails when it is removed and nothing warns while it stays.
--
-- `INSERT` on `identities` is kept: bootstrap creates the identity rows, as the application role, once.
-- `SELECT` is kept: it is needed to answer for the caller's own identity. Neither lets a caller install a
-- credential.

REVOKE UPDATE ON identities FROM openppwr_app;
REVOKE SELECT, INSERT, UPDATE ON auth_sessions FROM openppwr_app;

-- The property, asserted here rather than left to a test that might not be run. `has_table_privilege`
-- reports the effective privilege, so this catches a grant arriving by any route, including PUBLIC or a role
-- membership rather than a direct grant.
DO $$
DECLARE
  problems text := '';
BEGIN
  IF has_table_privilege('openppwr_app', 'identities', 'UPDATE') THEN
    problems := problems || 'openppwr_app may UPDATE identities; ';
  END IF;
  FOR i IN 1..1 LOOP
    IF has_table_privilege('openppwr_app', 'auth_sessions', 'INSERT')
       OR has_table_privilege('openppwr_app', 'auth_sessions', 'UPDATE')
       OR has_table_privilege('openppwr_app', 'auth_sessions', 'DELETE') THEN
      problems := problems || 'openppwr_app may write auth_sessions; ';
    END IF;
  END LOOP;
  -- Bootstrap must keep working, so the capability it genuinely needs is asserted in the same place as the
  -- ones removed. A migration that quietly took away too much would be discovered at the next install.
  IF NOT has_table_privilege('openppwr_app', 'identities', 'INSERT') THEN
    problems := problems || 'openppwr_app can no longer INSERT identities, which bootstrap requires; ';
  END IF;
  IF NOT has_function_privilege('openppwr_app', 'issue_openppwr_session(uuid, uuid, uuid, text, timestamp with time zone)', 'EXECUTE') THEN
    problems := problems || 'openppwr_app can no longer issue a session; ';
  END IF;
  IF problems <> '' THEN
    RAISE EXCEPTION 'credential write boundary is wrong: %', problems;
  END IF;
END $$;
