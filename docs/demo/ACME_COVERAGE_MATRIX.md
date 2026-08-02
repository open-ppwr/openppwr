# ACME sample-data coverage matrix

Maps every shipped surface — API endpoint, workbench control, role, workflow transition, download
and public demo claim — to the fictional ACME data or scenario that exercises it.

Purpose: generate only what is genuinely missing, instead of regenerating a dataset that already
satisfies its contract.

Dataset: seed `ACME-EU-DEMO`, schema version `1.0`, generator version `1.0.0`.
Verified counts (`npm run acme:validate`): 4 organizations, 4 suppliers, 32 packaging, 18 materials,
40 components, 32 BOMs, 28 valid import rows, 8 invalid import rows.

Status: `COVERED`, `PARTIAL`, `MISSING`, `NOT APPLICABLE`.

Final audit 2026-07-29: **COVERED 78 · PARTIAL 0 · MISSING 0 · NOT APPLICABLE 9**.
Full method and the package-reachability finding: `ACME_ZERO_GAP_REPORT.md`.

## API endpoints

| Endpoint | Sample / scenario | Status |
|---|---|---|
| `POST /v1/bootstrap` | Creates tenant `ACME-EU-DEMO` and all nine role identities | COVERED |
| `POST /v1/imports` (JSON) | 28 valid rows | COVERED |
| `POST /v1/imports` (CSV) | Supplemental CSV, 4 rows | COVERED |
| `POST /v1/imports` (invalid) | 8 invalid rows: empty id, duplicate id, negative quantity, unsupported unit, unknown component reference, invalid packaging type, null BOM | COVERED |
| `POST /v1/imports` (replay) | Same idempotency key returns `replayed` | COVERED |
| `GET /v1/catalog/summary` | 32/18/40/32/4 | COVERED |
| `GET /v1/catalog/:resource` | packaging, materials, components, boms, suppliers | COVERED |
| `GET /v1/evidence-requirements` | Derived from rule `OPENPPWR-DEMO-RC` v1.0.0 | COVERED |
| `POST /v1/evidence` | Clean, infected, MIME-mismatched, expired, oversized, empty | COVERED |
| `GET /v1/evidence` | Listed per role, supplier-scoped for `supplier_user` | COVERED |
| `POST /v1/evidence/:id/review` | Accept and reject; refused while quarantined | COVERED |
| `GET /v1/evidence/:id/download` | Authorized and unauthorized paths | COVERED |
| `POST /v1/scan-jobs/:id/requeue` | Dead job requeued by `tenant_admin`, denied for contributor | COVERED |
| `POST /v1/assessments/run` | Produces all four outcomes on a fresh tenant | COVERED |
| `GET /v1/assessments` | Includes explanation and evidence references | COVERED |
| `GET /v1/gaps` | Open, assigned, remediated, closed with history | COVERED |
| `POST /v1/gaps/:id/assign` | Owner assignment | COVERED |
| `POST /v1/gaps/:id/remediate` | Notes, evidence ids, packaging patch | COVERED |
| `POST /v1/gaps/:id/reassess` | Supersession chain, closes gap | COVERED |
| `POST /v1/review-snapshots` | Refused while blocking gaps exist; frozen when clear | COVERED |
| `POST /v1/review-snapshots/:id/dossier` | JSON, PDF, ZIP, manifest | COVERED |
| `GET /v1/dossiers/:id/download` | Checksum-verified download | COVERED |
| `GET /v1/audit/verify` | Chain verification, 170 events on the private deployment | COVERED |

## Workbench controls

Every control in `apps/web/src/App.jsx` is exercised by the browser E2E in EN, PL and DE:
`credential`, `import-format`, `import-key`, `import-payload`, `run-import`, `load-catalog`,
`load-requirements`, `requirement`, `evidence-file`, `upload-evidence`, `refresh-evidence`,
`run-assessment`, `gap-owner`, `load-gaps`, assign/remediate/reassess per gap, `freeze`,
`generate`, download, `verify-audit`, `locale`, `activity`. — **COVERED**

## Roles

| Role | Exercised by | Status |
|---|---|---|
| `tenant_admin` | Scan requeue authorization | COVERED |
| `compliance_manager` | Assessment, gaps, freeze, dossier | COVERED |
| `packaging_editor` | Imports; denied evidence review | COVERED |
| `evidence_contributor` | Uploads; denied review | COVERED |
| `evidence_reviewer` | Accept/reject | COVERED |
| `read_only_auditor` | Reads, downloads, audit verify; denied mutations | COVERED |
| `supplier_user` | Own supplier only; cross-supplier denied with 404 | COVERED |
| `service_account` | Establishes a session (session test) and is present in the authorization matrix | COVERED — no dedicated endpoint exists, so there is nothing further to exercise |
| `worker` | Scan job processing | COVERED |

## Workflow transitions

| Transition | Scenario | Status |
|---|---|---|
| Evidence quarantined → clean → accepted | Supplier 001 | COVERED |
| Evidence → infected → review refused | EICAR fixture | COVERED |
| Evidence → MIME mismatch → rejected → clean resubmission | Supplier 004 | COVERED |
| Evidence expired → replacement | Supplier 003 | COVERED |
| Evidence missing | Supplier 002 | COVERED |
| Scan error/timeout → retry → dead → requeue | Deterministic scanner fixtures | COVERED |
| Gap open → assigned → remediated → reassessed → closed | Both blocking gaps | COVERED |
| Gap closed with retained history | `closed_by_reassessment` | COVERED |
| Blocked → allowed `READY_FOR_REVIEW` | 409 while blocking, then frozen | COVERED |
| Dossier frozen and unaffected by later live changes | Snapshot integrity test | COVERED |
| Audit tamper detection | Integrity mismatch fixtures | COVERED |

## Assessment outcomes

| Outcome | Source | Status |
|---|---|---|
| `PASS` | Packaging meeting the 30% recycled-content threshold | COVERED |
| `FAIL` | `ACME-PKG-002`, recycled content 5% | COVERED |
| `UNKNOWN` | `ACME-PKG-006`, recycled content null | COVERED |
| `NOT_APPLICABLE` | 10 records outside rule applicability | COVERED |

## Packaging type coverage

`sales` (12), `grouped` (6), `transport` (6), `ecommerce` (4), `reusable` (4) — **COVERED**, asserted
by `acme:validate`.

## Downloads and exports

| Artifact | Command | Status |
|---|---|---|
| Canonical dataset JSON | `npm run acme:export` | COVERED |
| Valid import JSON / CSV | `npm run acme:export` | COVERED |
| Invalid import JSON / CSV | `npm run acme:export` | COVERED |
| Supplemental CSV | `npm run acme:export` | COVERED |
| SHA-256 manifest | `npm run acme:verify-checksums` | COVERED |
| Dossier JSON / PDF / ZIP / manifest | Generated per run | COVERED |

## Gaps against the published demo claims

| Claim on the demo page | Backing data | Status |
|---|---|---|
| Fictional dataset with stated counts | Generator, validated | COVERED |
| Four honest outcomes | Fresh-tenant assessment | COVERED |
| Four supplier scenarios | Supplier 001–004 | COVERED |
| Gap and remediation walkthrough | Both gaps | COVERED |
| Dossier outputs | Four artifacts | COVERED |
| Downloadable samples | Generated by `acme:export` into the web build and linked from the Demo and Documentation pages in EN/PL/DE | COVERED |
| Reset behaviour | `npm run demo:reset`, fail-closed and idempotent (`docs/demo/DEMO_RESET.md`) | COVERED |

## Deliberately absent

| Item | Reason |
|---|---|
| Dashboard KPI widgets, notification centre, expiry reminders, review queue | **NOT APPLICABLE** — no such screens exist in Community. Generating data for them would be inventing coverage for software that has not been built. |
| Active / invited / disabled user states | **NOT APPLICABLE** — no user-management screen exists; identities are issued at bootstrap. |
| Warehouses and plants as first-class records | **NOT APPLICABLE** — represented as a `site` attribute on each organization, which is all any current surface consumes. No screen or endpoint treats them as records. |
| SAP/ERP mapping examples | **NOT APPLICABLE** for Community — Connect has no shipped connector, and publishing a mapping example would imply a capability that does not exist. |
| Reusable demo credentials | **Deliberately absent** — tokens are generated at bootstrap and never committed. |

## Conclusion

**No `MISSING` and no `PARTIAL` entries remain.** The two previously open product-surface gaps were
closed on 2026-07-28: the generated samples are now produced during the web build and linked from
the Demo and Documentation pages in all three locales, and `npm run demo:reset` provides a
fail-closed, idempotent reset of the isolated demonstration tenant.

Every remaining exclusion is `NOT APPLICABLE` because the corresponding feature does not exist in
Community. No sample data was fabricated for software that has not been built.
