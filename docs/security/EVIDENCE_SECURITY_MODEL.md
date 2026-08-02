# Evidence Security Model

Status: Phase 4 implementation; production ClamAV execution still requires deployment validation.

## Ingress

- Authenticated multipart streaming only; exactly one file and an effective 10 MiB byte limit.
- Unicode-normalized basename; traversal, control characters, double extensions and non-allowlisted extensions fail.
- Declared MIME, extension and byte signature must agree. CSV is detected as safe UTF-8 text then retained as `text/csv`.
- Empty input and partial/oversized streams fail before database registration.

## Storage and scan

- Mode-restricted tenant quarantine under `OPENPPWR_EVIDENCE_STORAGE_ROOT`; random storage names never use the submitted filename.
- SHA-256 is calculated while streaming. Metadata and a durable scan job commit together with an audit event.
- `pending`, `infected`, `error` and `timeout` files cannot be reviewed as accepted or downloaded through normal routes.
- Production scanner adapters fail closed. The deterministic adapter refuses to instantiate outside the test runtime.

## Authorization and lifecycle

- Supplier users are constrained to their supplier after route permission evaluation and again by tenant RLS.
- Only `evidence_reviewer` or tenant admin may accept/reject; contributors, service accounts and workers cannot review.
- Expired evidence cannot be accepted. Replacements create a new version; records are not overwritten.
- Cleanup of retained infected/error/orphan files remains a Phase 4 open item and must be audited.

