# ADR 0005: Persisted assessment, gap and remediation model

- Status: Accepted for Phase 4 implementation
- Date: 2026-07-28
- Human review: Regulatory and security review required

## Decision

Assessments persist immutable input, evidence and rule-version snapshots. Results are append-only. `FAIL` and `UNKNOWN` results create tenant-scoped gaps with deterministic deduplication keys. Assignment, remediation, closure and reopening are status-history events; gaps are never deleted. Reassessment creates a new assessment linked to the superseded assessment and may close or reopen existing gaps.

## Consequences

- Current state is derived from persisted history, not a dashboard calculation.
- `READY_FOR_REVIEW` is rejected while any current blocking gap remains open.
- Every mutation shares a transaction with actor-attributed audit output.

