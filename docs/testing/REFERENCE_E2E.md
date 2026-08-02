# ACME Reference API E2E

Status: API journey passed twice from separate clean databases; browser journey passed separately in EN, PL and DE.

Run from repository root:

```powershell
npm ci
npm run test:e2e
```

API-only and locale-specific browser commands:

```powershell
npm run test:e2e:api
npm run build --workspace=@openppwr/web
node scripts/validation/browser-e2e.mjs en
node scripts/validation/browser-e2e.mjs pl
node scripts/validation/browser-e2e.mjs de
```

The gate starts a fresh embedded PostgreSQL 18 instance for each of two runs, applies migrations, creates a non-superuser runtime role, starts the real Express API, and uses only HTTP writes for the business journey. A deterministic malware adapter is injected only under the test runtime; production scanning remains fail-closed.

Each run verifies:

1. one-time ACME tenant/identity bootstrap;
2. eight invalid import rows and zero domain writes;
3. 28-row JSON import, idempotent replay and four-row CSV import;
4. exact 32 packaging, 18 materials, 40 components and 32 BOM totals;
5. evidence quarantine, clean scan/approval, expired declaration/replacement and MIME-mismatch/resubmission;
6. `PASS`, `FAIL`, `UNKNOWN` and `NOT_APPLICABLE` from rule `OPENPPWR-DEMO-RC` `1.0.0`;
7. gap assignment, remediation, reassessment and retained closure history;
8. blocked then successful ready-for-review gate;
9. frozen JSON/PDF/ZIP/manifest creation and download checksum verification;
10. audit-chain reconstruction and automated adversarial RLS read denial.

Disposable evidence and dossier output is written only under ignored `artifacts/e2e/`. Reports contain no credentials or database connection strings.

Synthetic ACME fixtures are fictional and independently generated. Results demonstrate software behavior only; they do not certify or guarantee legal compliance.
