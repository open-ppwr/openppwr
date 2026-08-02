# ADR 0002 — Monorepo and runtime boundaries

Status: Accepted
Date: 2026-07-28

## Decision

Retain npm workspaces. Target runtime comprises web, API and worker plus focused domain packages. PostgreSQL is system of record; worker queue is durable database state.

## Consequences

- Shared packages need real consumers; no speculative framework.
- API owns transaction orchestration.
- Worker handles asynchronous scan/notification/integration jobs with idempotency and DLQ.
- Web never bypasses API for writes.
