# OpenPPWR Community Dossier Schema

Status: Phase 4 base-locale schema `1.0.0`; PL/DE rendering is Phase 5 work.

## Frozen input

The persisted review snapshot contains exact organization, packaging, versioned BOM lines, suppliers, material references, accepted evidence versions/checksums, rule versions, current assessments/results, retained gaps/remediation history, locale, generator version and audit verification head. Generation is rejected while blocking gaps or `FAIL`/`UNKNOWN` current results remain.

## Artifacts

- `dossier.json`: canonical, recursively key-sorted JSON with a trailing newline.
- `dossier.pdf`: base-locale human summary generated from the same snapshot.
- `dossier.zip`: deterministic package containing JSON, PDF, evidence bytes and checksum manifest.
- `checksum-manifest.json`: stable-order SHA-256 and byte length for JSON, PDF and evidence entries packaged in the ZIP.

Artifact metadata stores the frozen snapshot ID, type, private storage key, SHA-256, size, creator and creation time. Downloads require explicit dossier permission and tenant RLS.

## Determinism boundary

Byte determinism includes the persisted snapshot, exact evidence bytes, locale and generator version. `frozenAt` is an input fixed before generation. Live database state, filesystem timestamps, random ZIP metadata and wall-clock generation time are excluded from rendering. Generating twice from the same snapshot returns the previously persisted artifacts.

Every dossier carries the ACME fiction disclaimer and makes no claim of guaranteed or certified compliance.

## Integrity and provenance

The checksum manifest proves that the packaged bytes are unaltered. It does not prove who produced them,
and the artifacts are deliberately not digitally signed. `ARTIFACT_INTEGRITY_AND_PROVENANCE.md` records
what each artifact proves, what answers a provenance question instead, and the reasoning behind that
decision.

