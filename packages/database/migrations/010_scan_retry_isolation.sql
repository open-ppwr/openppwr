-- One failing item could consume the whole retry budget, and an infrastructure outage consumed every
-- item's.
--
-- `scan_jobs` had a single `attempts` counter, a fixed 60-second retry delay and a hard limit of three.
-- The counter was incremented at claim time, before the outcome was known, so all three failure modes
-- spent from the same budget:
--
--   * a genuinely bad file — correct, three tries and then a terminal state;
--   * a scanner that was down — wrong, because every evidence item uploaded during the outage burned its
--     three attempts against an infrastructure problem and then needed a person, even though nothing was
--     ever wrong with the file;
--   * a worker that crashed mid-scan — the job stayed `running` for ever, because nothing reclaimed it.
--
-- The fix separates the budgets by what failed.
-- `attempts` stays the evidence item's budget and is spent only on a content failure. Infrastructure
-- failures spend `infrastructure_attempts` instead, on exponential backoff with jitter and a much larger
-- bound, so an outage delays work rather than condemning it.
--
-- Both counters remain bounded, and both end in the same terminal state. An unbounded retry is not
-- generosity; it is a hot loop that hides a permanent fault.

ALTER TABLE scan_jobs
  ADD COLUMN IF NOT EXISTS infrastructure_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_class text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS terminal_reason text,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz;

-- Existing terminal rows are labelled `legacy_attempts_exhausted`, not `content_attempts_exhausted`.
--
-- Under the old schema a scanner outage and a bad file both reached `dead` through the same counter, so
-- the history cannot say which happened. Picking either specific label would invent a distinction the
-- old data does not carry, in a table that is read as evidence.
UPDATE scan_jobs
   SET terminal_reason = 'legacy_attempts_exhausted',
       terminal_at = coalesce(updated_at, now())
 WHERE status = 'dead' AND terminal_reason IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_failure_class_check') THEN
    ALTER TABLE scan_jobs
      ADD CONSTRAINT scan_jobs_failure_class_check
      CHECK (last_failure_class IS NULL OR last_failure_class IN ('content', 'infrastructure'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_terminal_reason_check') THEN
    ALTER TABLE scan_jobs
      ADD CONSTRAINT scan_jobs_terminal_reason_check
      CHECK (terminal_reason IS NULL OR terminal_reason IN (
        'content_attempts_exhausted', 'infrastructure_attempts_exhausted', 'legacy_attempts_exhausted'
      ));
  END IF;

  -- A terminal job must say why it is terminal, and a non-terminal one must not claim to be. `dead` is
  -- the existing terminal value and keeps its name in the database; the API reports it as
  -- `requiresAttention` so an operator reads a remedy rather than a tombstone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_terminal_consistency_check') THEN
    ALTER TABLE scan_jobs
      ADD CONSTRAINT scan_jobs_terminal_consistency_check
      CHECK ((status = 'dead') = (terminal_reason IS NOT NULL));
  END IF;
END $$;

-- The claim query orders by `available_at`, so a backed-off job stops sitting at the head of the queue
-- ahead of work that is ready to run. Without this index that ordering is a sort over the whole table.
CREATE INDEX IF NOT EXISTS scan_jobs_claim_idx
  ON scan_jobs (tenant_id, available_at, created_at)
  WHERE status IN ('pending', 'failed', 'running');

-- Terminal jobs are the operator's queue, read by tenant, so they get their own index rather than sharing
-- the claim index whose predicate excludes them.
CREATE INDEX IF NOT EXISTS scan_jobs_terminal_idx
  ON scan_jobs (tenant_id, terminal_at)
  WHERE status = 'dead';
