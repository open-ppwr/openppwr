# OpenPPWR

OpenPPWR Community is an open-core, self-hosted platform under active development for structuring packaging data, evidence, assessments, remediation and review dossiers.

Current status: released as Community 1.0.0 under Apache-2.0. A transactional ACME reference E2E covers import, evidence, assessment, gaps, reassessment, frozen JSON/PDF/ZIP dossiers and audit verification in EN, PL and DE. A human security review binds this release and is internal rather than third-party; legal and German regulatory review remain outstanding with the risk accepted and disclosed in the product itself. What is and is not supported is stated in [known limitations](docs/release/KNOWN_LIMITATIONS.md), and the gates a release must pass in [release gates](docs/release/RELEASE_GATES.md).

OpenPPWR supports PPWR readiness and packaging compliance processes. It does not certify or guarantee legal compliance.

## Tenancy

**OpenPPWR Community Public Beta supports one tenant per deployment.**

The application data model is tenant-aware and uses verified PostgreSQL RLS/FORCE RLS. Multi-tenant deployment orchestration is not included in the Community Public Beta.

Run one deployment per organization. The installer enforces this — bootstrap refuses a second tenant, and the worker refuses to start against a database holding more than one — because a single worker processes only its own tenant's evidence, so any additional tenant's uploads would never be scanned. Rationale and evidence: [tenancy model](docs/architecture/TENANCY_MODEL.md).

## Baseline commands

```powershell
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run i18n:gate
npm run build
```

## Reproduce complete Community workflow

Prerequisites: Node.js 20+ (release gates use Node.js 24), npm 11 and enough local disk for disposable PostgreSQL test clusters. Then run:

```powershell
npm ci
npm run test:e2e
```

This starts clean PostgreSQL databases and executes real HTTP workflows for fictional ACME tenants: invalid and idempotent CSV/JSON imports, persisted packaging/BOM/supplier data, versioned demonstration rules, quarantined evidence and durable scan jobs, review authorization, four assessment outcomes, gap remediation and reassessment, frozen review snapshot, JSON/PDF/ZIP/SHA-256 dossier artifacts, audit reconstruction, RLS isolation, and EN/PL/DE browser journeys. No manual SQL or customer data is used. See [reference E2E](docs/testing/REFERENCE_E2E.md), [architecture](docs/architecture/ARCHITECTURE.md), [security model](docs/security/SECURITY_REQUIREMENTS.md), [self-hosted installation](docs/deployment/SELF_HOSTED_INSTALL.md), and [known limitations](docs/release/KNOWN_LIMITATIONS.md).

## Safety and licensing

All committed demonstrations will use independently generated fictional ACME data. Customer and production data are prohibited.

Attentus-owned OpenPPWR Community source, public documentation, examples and
synthetic ACME assets are licensed under Apache License 2.0. Third-party
components keep their own licenses. Public distribution of this release
candidate still requires consolidated owner/legal approval of the exact export.

No container image has been published to GHCR or Docker Hub, and no package has been published to npm.
Any registry reference in this documentation describes the contract publication will follow, not an
artifact you can pull today. Publication of each artifact requires explicit owner approval and is
announced when it happens.
