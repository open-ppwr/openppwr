# Security Requirements

Status: Mandatory baseline; human security approval required for P0 authorization/RLS design.

## Identity and authorization

- Production-grade login/session or OIDC; fail closed when provider unavailable.
- MFA for privileged administrators.
- No identity/tenant/role from client headers.
- Explicit route permission matrix; deny by default.
- Human roles and machine scopes remain separate.
- Secrets never stored plaintext; rotation/revocation auditable.

## Tenant isolation

- Every tenant table contains tenant ID, enables RLS and FORCE RLS.
- API sets tenant and actor only inside transaction.
- Cross-tenant worker/service lookup uses narrow reviewed policies, never general bypass.
- Integration tests attempt cross-tenant read/write/update/delete.

## Evidence

- Streaming upload with strict byte limit, normalized filename, allowlisted type and content-signature validation.
- Private storage, non-guessable keys, tenant/supplier authorization on every download.
- Quarantine until clean malware result; fail closed on unavailable/inconclusive scanner.
- Orphan/quarantine retention and cleanup policy.
- Checksums at ingestion and dossier packaging.

## Audit

- Append-only events, actor/tenant/correlation attribution, per-tenant tamper evidence.
- Audit write occurs in same transaction as business mutation.
- Verification detects mutation, deletion and chain discontinuity.

## Supply chain

- Lockfile installs, dependency audit, SAST, secret scan, container/IaC scan, SBOM and provenance.
- CI actions pinned to full SHA.
- Non-root minimal images; no secret build arguments/layers.
- OIDC/keyless publication; no long-lived publish tokens.
