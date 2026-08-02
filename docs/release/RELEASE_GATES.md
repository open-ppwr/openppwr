# Release Gates

## First baseline

- New history, explicit allowlist, no customer/secret/private content, build/tests/scans pass, private push only. DONE at commit recorded in project status.

## Community release candidate

- Clean install and repeatable ACME E2E.
- Real DB/API/transactions; tenant/RLS/auth tests.
- Four assessment outcomes, gaps/remediation/reassessment, ready-for-review.
- Deterministic PL/EN/DE PDF/ZIP/JSON dossier and checksum manifest.
- Audit verification, backup/restore, upgrade/rollback.
- Dependency/SAST/secret/container scans, SBOM and provenance evidence.
- Documentation/feature status accurate; support/security disclosure prepared.
- License and German regulatory review status explicit.

Supply-chain validation commands:

```powershell
npm run release:image:validate
npm run release:image:gate
```

First command validates pinned workflow, exact `1.0.0` metadata, non-root digest-pinned image, scans, dual SBOMs, attestations, signing guard and `latest` rejection. Second requires Docker, Grype, Syft, Trivy and Cosign; missing tools or findings fail gate. Runtime output under `artifacts/supply-chain` is evidence only after command exits zero.

## Public release hard gate

Explicit owner approval required before GitHub push/visibility, npm or GHCR publication, Wiki publication, DNS/deployment or announcement. Legal approval required before final license.
