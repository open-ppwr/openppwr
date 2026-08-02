# ADR 0008: Evidence quarantine and cleanup lifecycle

- Status: Accepted for Phase 4 implementation
- Date: 2026-07-28
- Human review: Security approval required

## Decision

Multipart uploads stream to tenant-scoped private quarantine with a hard 10 MiB limit. Empty files, unsafe names, disallowed extensions, signature/MIME mismatches and ambiguous content are rejected before registration. Accepted uploads create a durable scan job and remain inaccessible for review or normal download until a fail-closed scanner records `clean`. Infected/error/timeout files remain quarantined for audited retention and scheduled cleanup.

## Consequences

- Scanner unavailability never means clean.
- A deterministic scanner adapter is allowed only under the test runtime.
- Cleanup operates on explicit retained states and records audit events; it never removes approved evidence.

