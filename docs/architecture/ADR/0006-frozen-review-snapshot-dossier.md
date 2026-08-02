# ADR 0006: Frozen review snapshot and dossier generation

- Status: Accepted for Phase 4 implementation
- Date: 2026-07-28

## Decision

Dossier generation consumes only a persisted, immutable review snapshot created after the ready-for-review gate. The snapshot contains exact tenant, packaging, material, BOM, supplier, evidence-version, rule-version, assessment, result, gap, remediation, audit-verification, locale and generator references. JSON is canonicalized; PDF and ZIP use stable ordering and normalized timestamps; a SHA-256 manifest covers packaged files.

## Determinism boundary

The same frozen snapshot, evidence bytes, locale and generator version produce byte-identical artifacts. Live database state, wall-clock time and filesystem metadata are outside generation inputs and cannot affect bytes.

