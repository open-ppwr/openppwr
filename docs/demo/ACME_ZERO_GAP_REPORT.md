# ACME zero-gap report

Final feature-to-data audit: does every Community feature that actually exists have deterministic
fictional data exercising it?

Performed 2026-07-29 against repository HEAD `f83d4dc`, deployed application source `bc80d5d`.

Method: the feature inventory was **enumerated from source**, not taken from the previous matrix —
routes from `apps/api/src/app.mjs`, controls from `apps/web/src/App.jsx`, roles from
`apps/api/src/permissions.mjs`, error codes by scanning every `code:` literal, and package
reachability by computing the transitive import closure from the running apps.

## Result

| Status | Count |
|---|---|
| COVERED | 78 |
| PARTIAL | 0 |
| **MISSING** | **0** |
| NOT APPLICABLE (justified) | 9 |

**No fixtures were added**, because the audit found no real gap. Adding records purely to raise a
count would be fabricating coverage, which the brief explicitly forbids.

## The finding that changes the shape of the audit

Eleven packages ship in the public export. Only **six are reachable** from the running applications:

```
@openppwr/assessment  @openppwr/database  @openppwr/dossier
@openppwr/evidence (packages/supplier-evidence)  @openppwr/security  @openppwr/testing
```

**Five are never loaded at runtime:**

| Package | Directory | Contains |
|---|---|---|
| `@openppwr/core` | `packages/compliance-core` | unreferenced domain helpers |
| `@openppwr/evidence-storage` | `packages/evidence-storage` | an alternate storage/scanner implementation |
| `@openppwr/observability` | `packages/observability` | the redacting structured logger |
| `@openppwr/packaging-domain` | `packages/packaging-master` | unreferenced packaging helpers |
| `@openppwr/reconciliation` | `packages/reconciliation` | unreferenced reconciliation helpers |

This is why the audit reports zero missing data rather than a long tail of gaps: **capabilities in
unreachable packages are not Community features.** Generating ACME data for a supplier-invitation
flow, a reconciliation report or an alternate storage backend would manufacture evidence for code
that no deployment can execute.

Note that directory names differ from package names, which is how this was previously
under-reported: `packages/supplier-evidence` publishes `@openppwr/evidence` and *is* reachable
through `@openppwr/dossier`, while `packages/packaging-master` publishes `@openppwr/packaging-domain`
and is not.

This is recorded as an open engineering item, not an ACME gap — see "Referred out" below.

## Coverage by dimension

### API routes — 22 of 22 COVERED

Every route in `apps/api/src/app.mjs` is exercised by the reference E2E, the deployed E2E or a
targeted integration test: `/health`, `/v1/session`, `/v1/bootstrap`, `/v1/imports`,
`/v1/catalog/summary`, `/v1/catalog/:resource`, `/v1/evidence-requirements`, `/v1/evidence` (POST and
GET), `/v1/evidence/:id/review`, `/v1/evidence/:id/download`, `/v1/scan-jobs/:id/requeue`,
`/v1/assessments/run`, `/v1/assessments`, `/v1/gaps`, `/v1/gaps/:id/assign`,
`/v1/gaps/:id/remediate`, `/v1/gaps/:id/reassess`, `/v1/review-snapshots`,
`/v1/review-snapshots/:id/dossier`, `/v1/dossiers/:id/download`, `/v1/audit/verify`.

### Roles — 9 of 9 COVERED

All nine identities are created by bootstrap and each is exercised in a permitted and a denied
action. `service_account` is covered by the session test (it can establish a session) and the
authorization matrix; it has no dedicated endpoint, so there is nothing further to exercise.

### Authentication and onboarding states — COVERED

Unauthenticated, valid session, invalid/expired credential, insufficient role, cross-tenant denial,
supplier-scope denial, bootstrap resume after partial failure, and localized PL/EN/DE error copy.
The reported `/pl/app` failure is itself encoded as a regression test.

### Packaging, materials, components, BOM — COVERED

All five packaging types (`sales` 12, `grouped` 6, `transport` 6, `ecommerce` 4, `reusable` 4),
single-material and composite compositions, versioned BOMs with mass reconciliation, threshold pass
and fail cases, a null-value case producing `UNKNOWN`, and eight controlled invalid rows covering
empty id, duplicate id, negative quantity, unsupported unit, unknown component reference, invalid
packaging type and a null BOM.

### Suppliers and evidence — COVERED

Four supplier scenarios: complete and accepted; missing recycled-content evidence; expired
declaration plus replacement; MIME-mismatched rejection followed by clean resubmission. Plus
quarantine-until-reviewed, EICAR infected rejection, scanner error/timeout/dead-job/requeue,
integrity mismatch, oversized and empty uploads, and authorized versus unauthorized download.

### Assessment lifecycle — COVERED

All four outcomes on a fresh tenant (`PASS 20`, `FAIL 1`, `UNKNOWN 1`, `NOT_APPLICABLE 10`), gap
open → assigned → remediated → reassessed → closed with retained history, supersession chain, and
`READY_FOR_REVIEW` both refused while blocking gaps exist and permitted once clear.

### Dossier and audit — COVERED

PL/EN/DE dossiers, canonical JSON, PDF, ZIP, SHA-256 manifest, audit-chain verification, tamper
detection, and a frozen snapshot proven unaffected by later live-data changes.

### Demo product surface — COVERED

Valid and invalid CSV and JSON, canonical dataset, checksum manifest, sample-data notice — all
generated during the web build, linked from Demo and Documentation in three locales, served with
correct content types, each carrying the fiction marker. One-command fail-closed demo reset with six
safety tests.

### Error states — COVERED

Every error code reachable from a Community route has a fixture or behavioural test. Three are
covered by behaviour rather than by code name and were verified individually rather than assumed:
`IDEMPOTENCY_CONFLICT` (409 on a conflicting replay), `UPLOAD_DOUBLE_EXTENSION` and traversal
(filename normalization test), and `BOOTSTRAP_ALREADY_COMPLETED` (409 on the live tenant, and the
installer's resume path).

## NOT APPLICABLE — 9, each justified

| Item | Why |
|---|---|
| Dashboard KPI widgets | No dashboard exists in Community |
| Notification centre, expiry reminders, overdue alerts | No notification feature exists |
| Review queue screen | No such screen; review happens per evidence row |
| User invitation / active-invited-disabled states | The invitation code lives in a package reachable only for dossier helpers; no invitation endpoint or screen exists |
| Reconciliation reports | `@openppwr/reconciliation` is not loaded at runtime |
| Alternate evidence storage backend | `@openppwr/evidence-storage` is not loaded at runtime |
| SAP/ERP mapping example | Connect has no shipped connector; publishing a mapping would imply a capability that does not exist |
| Warehouses/plants as first-class records | Represented as a `site` attribute, which is all any surface consumes |
| Reusable demo credentials | Deliberately absent; credentials are issued at bootstrap and never committed |

## Referred out — engineering, not data

**Five unreachable packages ship in the public export.** This is not an ACME gap and no data should
be generated for it, but it is a real release-quality concern: a reader of the public repository
would reasonably assume those capabilities are part of the product, and `@openppwr/observability`
in particular contains the redacting logger that the security profile already notes is implemented
but unwired.

Recommended disposition before or shortly after public release: wire `@openppwr/observability` into
the API and worker, and either remove the remaining four or mark them explicitly as
not-yet-integrated. Recorded as an open item in the internal release-readiness record.

## Verification

`npm run acme:validate` — `ACME_VALIDATE_PASS organizations=4 suppliers=4 packaging=32 materials=18
components=40 boms=32 validImportRows=28 invalidImportRows=8`.

`npm run acme:verify-checksums` — manifest verified; regeneration remains byte-identical.

Secret scan and public-export validation pass; no customer data, no credential in any sample.
