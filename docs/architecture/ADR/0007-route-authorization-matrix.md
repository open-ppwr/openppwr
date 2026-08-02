# ADR 0007: Route-level authorization matrix

- Status: Accepted for Phase 4 implementation
- Date: 2026-07-28
- Human review: Security approval required

## Decision

Bearer credentials are verified server-side from hashes; tenant, actor, role and supplier scope never come from client headers. Every route declares a permission and denies by default. Human roles and machine roles are distinct. Supplier users are additionally constrained by supplier ownership. PostgreSQL `FORCE ROW LEVEL SECURITY` is the second enforcement layer inside each transaction.

## Consequences

- Denials return the same not-found response where object existence would leak.
- Evidence approval/rejection requires `evidence:review` and cannot be performed by a supplier contributor.
- Workers receive only narrow job-processing capabilities.

