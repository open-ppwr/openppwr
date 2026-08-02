# ADR 0004: Transactional packaging import

- Status: Accepted for Phase 4 implementation
- Date: 2026-07-28
- Human review: Required before Community Beta

## Decision

CSV and JSON imports use one tenant-scoped PostgreSQL transaction. The API validates schema, every row, uniqueness and all material/component/BOM references before domain writes. An import checksum plus tenant-scoped idempotency key identifies replay. A valid replay returns the persisted result; conflicting content is rejected. Invalid input persists only its import run and row report in one transaction and writes no packaging-domain rows.

## Consequences

- Partial domain imports and manual repair are forbidden.
- Import-run metadata and domain writes cannot disagree.
- Row errors use stable codes and deterministic ordering.
- Rollback is application rollback; schema migrations remain forward-only and additive until a reviewed down migration exists.

