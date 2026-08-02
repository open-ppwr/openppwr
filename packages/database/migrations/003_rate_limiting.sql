-- SPDX-License-Identifier: Apache-2.0
-- Shared, deployment-safe rate-limit counter store (OPP-CODE-020).
-- Infra-only: keys are namespaced strings (operation:dimension:identifier:window),
-- not tenant business data, so this table is intentionally outside RLS scope.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_start_idx ON rate_limit_buckets (window_start);

-- openppwr_app is the least-privilege runtime role the API connects as (OPP-CODE-030);
-- it needs read/write on this table to enforce limits, and UPDATE for the increment path.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO openppwr_app;
