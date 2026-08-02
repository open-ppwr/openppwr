# Test Evidence

## 2026-07-28 Phase 4 API checkpoint

- Command: `npm run test:e2e`
- Exit: `0`
- Report: ignored local `artifacts/e2e/reference-e2e-report.json`
- Fresh database runs: `2`
- Run durations: `10.684 s`, `12.138 s`
- ACME counts per run: packaging `32`, materials `18`, components `40`, BOMs `32`
- Invalid rows per run: `8`; domain rows after rejection: `0`
- Outcomes per run: `PASS 20`, `FAIL 1`, `UNKNOWN 1`, `NOT_APPLICABLE 10`
- Blocking gaps remediated per run: `2`
- Audit verification: valid, `90` events per run
- Artifacts: canonical JSON, PDF, ZIP and SHA-256 manifest; API downloads matched persisted checksums
- RLS: cross-tenant supplier read returned zero rows under the non-superuser runtime role

Supporting checkpoint evidence:

- API integration: `9/9` passed before the full E2E was added.
- Database integration: `FORCE RLS` read/write adversarial test passed.
- Unit gate: assessment/dossier/security/evidence/worker and synthetic-generator tests passed.
- Source scan: zero findings before the E2E slice; must be rerun before commit.
- Dependency audit: zero vulnerabilities before the E2E slice; must be rerun before commit.

## 2026-07-28 base-locale browser checkpoint

- Command: `npm run test:e2e:browser`
- Browser: installed Microsoft Edge through repository-local Playwright `1.61.1`; no browser/global installation
- Exit: `0`
- Locale: `en`
- UI actions: invalid/valid JSON import, CSV completion, four evidence uploads, status refresh, four reviewer approvals, assessment, two gap assignments/remediations/reassessments, ready snapshot, dossier generation/download and audit verification
- Report: ignored local `artifacts/e2e/browser/browser-e2e-report.json`
- Screenshot: ignored local `artifacts/e2e/browser/base-locale-reference.png`
- Download: ignored local `artifacts/e2e/browser/browser-dossier.json`
- Page errors: `0`

Not yet evidenced:

- production ClamAV execution;
- PL/EN/DE journeys (Phase 5);
- container/SBOM gates where native tooling is unavailable.
