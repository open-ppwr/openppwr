# Worker Health and Retry Semantics

Status: implemented and enforced.

Scope: `apps/worker/src/health.mjs`, `apps/worker/src/index.mjs`, `apps/worker/src/server.mjs`,
migration `010_scan_retry_isolation.sql`, and the operator surfaces `GET /v1/scan-jobs` and
`POST /v1/scan-jobs/:id/requeue`.

## Health was one boolean, and an empty queue reset it

The whole defect, verbatim from `server.mjs`:

```js
workerHealthy = !result?.errorCode;
```

`processNextScanJob` returns `null` when the queue is empty. `null?.errorCode` is `undefined`, and
`!undefined` is `true`. So a worker whose scanner had just failed declared itself healthy again on the next
empty poll — and an empty poll is exactly what happens when a broken scanner has stopped producing work.
An outage was indistinguishable from an idle queue, which is the one thing a health endpoint exists to
distinguish.

### Four questions, not one

| Question | Answered by | Meaning | Remedy for "no" |
|---|---|---|---|
| Liveness | `GET /health/live` | the process is running and the event loop responds | restart |
| Readiness | `GET /health/ready` | this worker can do its job right now | take out of service |
| Operational health | `GET /health` | full snapshot: status, reasons, counters, faults, queue | depends on the reason |
| Progress | the `counters` block of `/health` | timestamps and counts behind the other three | — |

Liveness is deliberately independent of the scanner. A scanner outage is not a reason to restart the
worker, and a health model that conflates the two produces a restart loop in response to someone else's
outage.

The deployment healthcheck targets `/health/ready`, because readiness is the question a container
healthcheck is asking.

### Three states

`healthy` — ready, with nothing outstanding.

`degraded` — ready and serving, with something a person should see: an evidence item that failed on its own
merits, or jobs parked in the terminal state. Returns `200`. A poisoned upload must not take a working
worker out of service, because that stops every *other* item from being scanned — a self-inflicted outage
in place of one bad file.

`unready` — cannot presently do the job. Returns `503`. Causes: not authenticated, tenancy not checked or
more than one tenant present, a failed poll, an outstanding infrastructure fault, or a stale heartbeat.

### What clears what

This is the rule that replaces the boolean:

| Signal | Clears poll failures | Clears an infrastructure fault | Clears an item fault |
|---|---|---|---|
| Successful **empty** poll | yes | **no** | **no** |
| Successful poll carrying a job | yes | no by itself | no by itself |
| Completed scan (a verdict was reached) | yes | yes | yes |
| Successful scanner probe (`zPING` → `PONG`) | — | yes | no |
| Failed poll | no — sets one | — | — |

An empty poll proves connectivity. It does not prove the scanner recovered, because no scan happened.

### Why the probe exists

Without an active probe, readiness would be restored only by a completed scan — and with an empty queue
there is no scan to complete. A worker with a recovered scanner and no pending work would stay unready for
ever. `ClamAvScanner.ping()` sends `zPING` and expects `PONG`; it resolves `false` rather than throwing,
because a failed probe is an answer. It runs only when the queue is empty *and* an infrastructure fault is
outstanding, so it costs nothing in normal operation.

### Fault classification

| Class | Codes | Effect |
|---|---|---|
| Infrastructure | `MALWARE_SCANNER_UNAVAILABLE`, `MALWARE_SCANNER_MALFORMED_RESPONSE`, `MALWARE_SCAN_TIMEOUT`, `EVIDENCE_STORAGE_UNAVAILABLE` | unready |
| Item | `EVIDENCE_INTEGRITY_MISMATCH`, `MALWARE_SCAN_SIZE_EXCEEDED`, `STORAGE_PATH_INVALID` | degraded |
| Unrecognised | anything else | treated as infrastructure |

An unrecognised code fails closed, because reporting a worker that may not be working is safer than
reporting one that certainly is.

### The stale heartbeat

A loop that stops iterating without throwing leaves a boolean flag reading `true` for ever: nothing ever
set it false, and the last thing recorded was a success. `heartbeatAgeMs` catches that — if neither a poll
nor a failure has been recorded inside `OPENPPWR_WORKER_HEALTH_STALE_MS` (default 300 s, bounded 1 s–1 h),
the worker is unready.

## One counter, three failure modes

`scan_jobs` had a single `attempts` counter, a fixed 60-second delay and a hard limit of three, and the
counter was incremented **at claim time**, before the outcome was known. Three unrelated failure modes
therefore spent from the same budget:

| What happened | Old behaviour | Correct? |
|---|---|---|
| The file is genuinely bad | three attempts, then terminal | yes |
| The scanner is down | three attempts, then terminal | **no** — the item was condemned by a problem that was never its fault |
| The worker crashed mid-scan | the job stayed `running` for ever | **no** — nothing reclaimed it |

### Separate budgets

| Counter | Spent on | Limit | Delay |
|---|---|---|---|
| `attempts` | content failures, and a lease reclaim | 3, not configurable | fixed `OPENPPWR_WORKER_RETRY_DELAY_MS` (60 s) |
| `infrastructure_attempts` | infrastructure failures | `OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS` (12, bounded 1–100) | exponential with jitter |

An infrastructure failure leaves `attempts` untouched, so an outage **delays** an evidence item rather than
condemning it. Both counters are bounded and both end in the same terminal state: an unbounded retry is not
generosity, it is a hot loop that hides a permanent fault.

### Backoff

`retryBackoffMs(attempt)` = `min(base × 2^(attempt−1), maxDelayMs)` ± 20% jitter, never below `base`, never
above `maxDelayMs` (`OPENPPWR_WORKER_MAX_RETRY_DELAY_MS`, default 900 s). From 60 s the ceiling is reached
on the fifth attempt: 60 s, 120 s, 240 s, 480 s, 900 s, 900 s…

The jitter exists because every worker and every job would otherwise retry in lockstep and arrive at a
recovering scanner as one burst. `random` is injectable, so the bounds are asserted at both extremes rather
than sampled and hoped over.

### The lease

A job claimed by a worker that then dies used to stay `running` for ever, because the claim predicate only
looked at `pending` and `failed`. A `running` row older than `OPENPPWR_WORKER_JOB_LEASE_MS` (default 300 s,
bounded 10 s–1 h) is now reclaimable.

The reclaim **is** charged to `attempts`. Dropping the claim-time increment entirely would let a job that
crashes the worker be retried without limit; charging only the reclaim bounds the crash loop without
charging the outage. The lease must exceed the scanner timeout, or a scan still running would be reclaimed
underneath itself — asserted in `apps/worker/test/retry-budget.test.mjs`.

### No starvation

The claim query orders by `available_at`, then `created_at`. A backed-off job therefore stops sitting at the
head of the queue ahead of work that is ready now. `FOR UPDATE ... SKIP LOCKED` remains, so a job another
worker is processing is skipped rather than waited on.

This ordering was found by a test, not by design review: the first version of the poison-job test asserted
that every cycle would claim the poison job, and it failed on cycle two — because the healthy job created
afterwards had become the earliest *due* work. The assertion was wrong; the ordering is the property.

### The terminal state

`status = 'dead'` remains the database value. It is reported through the API as `requiresAttention: true`,
with:

| Field | Meaning |
|---|---|
| `terminalReason` | `content_attempts_exhausted`, `infrastructure_attempts_exhausted`, or `legacy_attempts_exhausted` for rows that predate this migration |
| `lastErrorCode` | what failed |
| `lastFailureClass` | `content` or `infrastructure` |
| `attempts`, `infrastructureAttempts` | which budget was spent |
| `correlationId` | ties the attempt to its log lines |
| `terminalAt` | when it stopped |

Rows that predate migration 010 are labelled `legacy_attempts_exhausted` rather than
`content_attempts_exhausted`. Under the old schema an outage and a bad file reached `dead` through the same
counter, so the history cannot say which happened, and picking a specific label would invent a distinction
the data does not carry — in a table read as evidence.

A database constraint enforces that a terminal job states a reason and a non-terminal one does not, so the
two cannot disagree.

### Operator surfaces

`GET /v1/scan-jobs` — the queue, `?requiresAttention=true` for the terminal subset. Held behind
`scan:requeue`, not `read`: it reports infrastructure state, and the operator who acts on it is the one who
may requeue. Before this route existed, the terminal state was actionable only by someone who already knew
the job identifier, which the product gave them no way to obtain — a remedy with no diagnosis.

`POST /v1/scan-jobs/:id/requeue` — resets **both** budgets and clears the terminal fields. Leaving the
infrastructure counter at its limit would have made the requeue a no-op that reported success. Requeueing a
job that is not terminal is refused with `409 SCAN_JOB_NOT_DEAD`.

### Audit

Every attempt appends `evidence.scan.<status>` carrying attempt counts, failure class and correlation
identifier. Reaching the terminal state appends a **separate** `evidence.scan.requires_attention` event,
because "this has stopped and needs a person" is a different fact from "this attempt failed", and an
operator searching for the first should not have to reconstruct it from a count of the second. A requeue
appends `evidence.scan.requeued` recording what was reset. Nothing is dropped silently.

## Configuration

| Variable | Default | Bounds |
|---|---|---|
| `OPENPPWR_WORKER_MAX_ATTEMPTS` | 3 | 3–3 (not widenable) |
| `OPENPPWR_WORKER_RETRY_DELAY_MS` | 60 000 | 1–86 400 000 |
| `OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS` | 12 | 1–100 |
| `OPENPPWR_WORKER_MAX_RETRY_DELAY_MS` | 900 000 | 1 000–86 400 000 |
| `OPENPPWR_WORKER_JOB_LEASE_MS` | 300 000 | 10 000–3 600 000 |
| `OPENPPWR_WORKER_HEALTH_STALE_MS` | 300 000 | 1 000–3 600 000 |
| `OPENPPWR_WORKER_TENANCY_RECHECK_MS` | 60 000 | 1 000–3 600 000 |

Every one is bounded on both sides. An unbounded setting is a way to switch a safety property off by
configuration without anyone recording a decision.

## Evidence

| Claim | Where |
|---|---|
| An empty poll does not clear a scanner fault | `apps/worker/test/health.test.mjs` — ten empty polls, still unready |
| The replaced boolean would have said healthy | same file, last test, computes the old expression alongside the new answer |
| A completed scan or a successful probe clears it; a failed probe does not | same file |
| Auth, database, tenancy and stale-heartbeat failures are unready | same file |
| An item fault degrades and stays visible | same file |
| Backoff doubles, is bounded both ways, and the jitter varies | `apps/worker/test/retry-budget.test.mjs` |
| Every budget bound is enforced by configuration | same file |
| A poison item goes terminal while a healthy item still completes | `apps/api/test/scan-retry.integration.test.mjs` |
| An outage spends none of the item budget across five cycles | same file |
| Counters survive a restart, and recovery is possible afterwards | same file |
| The infrastructure budget is bounded and ends terminal | same file, and `apps/api/test/evidence.integration.test.mjs` |
| The terminal state is visible in API, queue snapshot and audit chain, and the chain still verifies | same file |
| Requeue resets both budgets; a non-terminal job cannot be requeued | same file |
| A crashed worker's job is reclaimed after its lease, and the reclaim is charged | same file |
| The listing is denied to every role without the operator permission | same file |

## Gates

`WORKER_HEALTH_SEMANTICS_PASS` — `apps/worker/test/health.test.mjs` exits `0`.

`WORKER_RETRY_ISOLATION_PASS` — `apps/worker/test/retry-budget.test.mjs` and
`apps/api/test/scan-retry.integration.test.mjs` both exit `0`.
