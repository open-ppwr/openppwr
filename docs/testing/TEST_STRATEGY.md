# Test Strategy

## Test pyramid

- Unit: pure domain validation, rules, transitions, deterministic manifests.
- Contract: OpenAPI/JSON Schema, integration envelopes, compatibility.
- Integration: real PostgreSQL migrations, repositories, transactions, FORCE RLS, audit and queue.
- E2E: clean database, actual APIs, worker jobs, evidence files and dossier downloads.
- Browser: critical journey in PL/EN/DE, accessibility and responsive states.

## Mandatory negative tests

- Cross-tenant and supplier-scope access.
- Missing/invalid auth, roles and scopes.
- Import replay/rollback/invalid references.
- Upload traversal, double extension, content mismatch, malware and scanner outage.
- Rule missing metadata/evidence, date boundaries and withdrawn versions.
- Gap duplicate/unauthorized closure/reopening.
- Dossier unauthorized access, nondeterminism and checksum tampering.

## Evidence

CI records command, exit code, runtime and artifact checksums. Skipped/unsupported gate is BLOCKED, never PASS. P0 author cannot self-approve.
