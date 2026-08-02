# ADR 0001 — Clean-room extraction and new history

Status: Accepted
Date: 2026-07-28

## Decision

OpenPPWR uses new Git history. Legacy source is read-only and reused only through exact-file allowlist plus private sensitive-pattern scans. Customer-shaped fixtures, docs, deployments and artifacts are replaced.

## Consequences

- Provenance stays private.
- Broad repository copies are forbidden.
- Reusable code may require rebranding/refactoring after extraction.
- Every baseline/public export needs repeatable negative scan evidence.
