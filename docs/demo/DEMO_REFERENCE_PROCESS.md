# The reference demonstration process

The one complete, real business process OpenPPWR Community demonstrates, stated normatively so that a
reader can check the product against it rather than against a description of it.

`docs/demo/GUIDED_E2E_DEMO.md` narrates this process for an operator following along. This document is
the contract: the ordered steps, who performs each one, and what evidence proves it. Where the two
disagree, this one governs.

Canonical process: **ACME packaging compliance readiness**. Owner-selected; any replacement requires
owner approval.

- Verified at source `3580eb8` (this audit), gate `test:demo:full-e2e`
- Implemented by `scripts/validation/demo-full-e2e.mjs`
- Evidence: recorded in an internal evidence file that is not part of the public export, because it
  describes a private environment. The result table below carries the gate outcomes it holds.
- Data: synthetic ACME fixtures only. Every environment and dossier carries the fiction disclaimer.

## Why this is a separate gate from `test:e2e`

`test:e2e` runs the reference workflow twice and compares the two runs. It proves the product is
deterministic. It asserted `outcomes.PASS > 0`, which cannot tell a reader whether the demonstration
produces the figures we publish.

This gate asserts the published figures exactly, and covers four things a determinism check has no
reason to exercise: a password sign-in for every interactive role, a revoked session refused
afterwards, an infected upload stopped by the scanner rather than by content typing, and one denied
action per role.

Both are kept. Neither replaces the other.

## Where this process starts, and where a real deployment starts

They are not the same place, and conflating them is how the published walkthrough came to describe a
demonstration that no longer existed.

This gate starts from an **empty tenant** and imports the whole catalogue itself — 28 rows of JSON plus
4 of CSV — because it must exercise the import path, the invalid-row path and the whole assessment over
the complete 32-record portfolio. Every figure below is the figure for that catalogue.

A deployment set up with `openppwr-installer bootstrap-acme` starts somewhere else. Its seeding imports
only `acme-import-valid.json`, so it holds **28 packaging records and 28 BOMs**, four accepted supplier
declarations against 18 derived requirements, and one assessment reading **16 PASS / 1 FAIL / 1 UNKNOWN
/ 10 NOT_APPLICABLE**, with the same two gaps open. The 4 remaining records — all `reusable`, all in
rule scope — arrive only when an operator imports `acme-import-supplemental.csv` themselves, which is
what turns 16 into 20 and 18 into 22. That state is pinned by
`scripts/installer/seed-demonstration.test.mjs` and described for readers in
`docs/user/REFERENCE_WORKFLOW.md` and the `acme-walkthrough` documentation page.

Neither figure is wrong. Each belongs to a different catalogue, and a document that quotes one without
naming which is a defect regardless of which number it picked.

## The process

Twenty verified steps, in order. Each row is asserted by the gate; none is narrated.

| # | Step | Actor | What is proven |
|---|---|---|---|
| 1 | Clean / reset synthetic tenant | operator | A reset tenant holds zero packaging records — the gate's own starting point, not a bootstrapped deployment's |
| 2 | Sign in as each demonstration role | 7 roles | Password sign-in issues a session credential; a wrong password and an unknown address are indistinguishable |
| 3 | Import invalid records | Packaging Editor | 8 rows rejected, **0 rows persisted** — no partial write |
| 4 | Import valid JSON and CSV | Packaging Editor | 28 + 4 rows accepted → packaging 32, materials 18, components 40, BOM 32; a replayed idempotency key does not double-import |
| 5 | Link suppliers, derive requirements | system | 4 suppliers, 22 evidence requirements derived from the rule, not authored by hand |
| 6 | Reject unsafe evidence | Evidence Contributor | A non-PDF declared as PDF → `422 EVIDENCE_MIME_MISMATCH` |
| 7 | Malware scan and quarantine | worker | A structurally valid PDF carrying the EICAR pattern → `scan_status=infected`, stored under `/quarantine/`, accept refused `409 EVIDENCE_NOT_CLEAN`, download `404` |
| 8 | Review, approve and reject | Evidence Reviewer | 4 accepted, 1 rejected on the reviewer's decision, 1 refused as expired (`409 EVIDENCE_EXPIRED`) |
| 9 | Assessment | Compliance Manager | **20 PASS / 1 FAIL / 1 UNKNOWN / 10 NOT_APPLICABLE** over 32 results |
| 10 | Explanation trace | system | All 32 results carry an explanation key or code |
| 11 | Deduplicated gaps | system | 2 open gaps, 2 distinct deduplication keys; freezing refused `409` while a gap is open |
| 12 | Ownership, remediation, reassessment | Compliance Manager | Both gaps assigned, remediated, reassessed to PASS |
| 13 | Remediated assessment | Compliance Manager | **22 PASS / 0 FAIL / 0 UNKNOWN / 10 NOT_APPLICABLE** |
| 14 | Freeze the review | Compliance Manager | `READY_FOR_REVIEW` with a snapshot digest |
| 15 | Dossier and manifest | Compliance Manager | 4 artifacts — JSON, PDF, manifest, ZIP — each digest recomputed from the downloaded bytes and matched against the manifest |
| 16 | Business-language explanation | system | 32 explanations rendered as sentences beside their keys; a key echoed as its own message fails the gate |
| 17 | Audit chain reconstruction | Read-only Auditor | 95 events, chain verifies |
| 18 | Logout, then reuse the credential | Packaging Editor | Logout `204`; the same token then `401` on read **and** `401` on write |
| 19 | Read-only auditor access | Read-only Auditor | Frozen review `200` with the freeze's own digest, all 4 artifacts visible, dossier `200`, write refused `404` |
| 20 | Role matrix | 7 roles | 14 probes: every role one allowed and one denied action |

## The published outcome

```text
32-record catalogue, this gate:
initial:            20 PASS /  1 FAIL /  1 UNKNOWN / 10 NOT_APPLICABLE
after remediation:  22 PASS /  0 FAIL /  0 UNKNOWN / 10 NOT_APPLICABLE

28-record catalogue, what bootstrap-acme leaves behind:
initial:            16 PASS /  1 FAIL /  1 UNKNOWN / 10 NOT_APPLICABLE
after remediation:  18 PASS /  0 FAIL /  0 UNKNOWN / 10 NOT_APPLICABLE
```

The second pair is not asserted by this gate; it is asserted by
`scripts/installer/seed-demonstration.test.mjs`, which drives the same product over the same rule with
only `acme-import-valid.json` imported. It is repeated here so that a reader comparing a fresh
deployment against this document does not conclude the product is broken.

Asserted with `deepEqual`, not with `> 0`. Reproduced identically on two consecutive runs. If product
behaviour changes, this gate fails and the published figure is corrected — the figure is never
re-derived from whatever a run happened to produce.

The 10 `NOT_APPLICABLE` are packaging types outside the demonstration rule's scope, and they stay
`NOT_APPLICABLE` after remediation. A demonstration in which everything eventually passes would
misrepresent what the rule does.

## What the process is required to use

Real PostgreSQL, real transactions, tenant context with `FORCE RLS`, the real API, the real worker and
scanner contract, real artifacts, the real audit chain and real authorization.

No mock business endpoint, no manual database state, no hardcoded success, no pre-generated dossier.
The gate boots an embedded PostgreSQL, migrates it, starts the API in-process and drives it over HTTP.

One deliberate exception, named because hiding it would be the dishonest choice: the malware scanner is
`VerdictStubScanner`, which refuses to construct outside `NODE_ENV=test`. ClamAV itself is
verified separately in `docs/security/CLAMAV_RUNTIME_REPORT.md`. What this gate proves is the
product's own behaviour around a scanner verdict — quarantine placement, refusal to accept, refusal to
serve — which is the part that is ours.

## Gates

| Gate | State | Source |
|---|---|---|
| `DEMO_FULL_E2E_PASS` | **PASS** | `test:demo:full-e2e` at `3580eb8`, twice |
| `DEMO_ROLE_MATRIX_PASS` | **PASS** | same run, 14 probes |
| `DEMO_DATA_ZERO_GAP_PASS` | **PASS** | `docs/demo/ACME_ZERO_GAP_REPORT.md`, `acme:validate` |
| `DEMO_DEPLOYED_E2E_PARTIAL_PASS` | **PASS** — 14 steps, `edge_blocked=0` | deployed harness at deployed `3580eb8` |
| `DEMO_DEPLOYED_ROLE_MATRIX_PASS` | **PASS** — 7 roles, 14 probes | same run |
| `DEMO_DEPLOYED_E2E_PASS` | **NOT CLAIMED** | see below |

The deployed verification ran 2026-07-30 against the private release-candidate deployment, through its
real hostname and real TLS, under a recorded owner decision. Every step reached the application; nothing
was counted as a result on the strength of an edge response, and the edge credential was proven **not** to
be an application credential — an authenticated-looking request carrying it and no application credential
still returns `401`.

Fourteen of the fifteen required deployed items are verified, including the remediated
`22/0/0/10` exactly, 417 audit events, all four dossier artifacts with recomputed digests, the full role
matrix and session revocation.

Deployment topology, the exact command and the full result table are deliberately **not** in this
document: they describe a private environment. They are held in an internal evidence file that is denied
from the public export. The row above named the runner script until 2026-08-02; that script is denied too,
so the name has gone the same way as the command that invokes it.

`DEMO_DEPLOYED_E2E_PASS` is **withheld** for one reason: the initial `20/1/1/10` cannot be reproduced on
the deployment, because that tenant is fully remediated and remediation is permanent. Reproducing it
requires resetting the demonstration tenant — a destructive operation on a deployed system, and therefore
an owner decision that has been asked rather than assumed.

## Roles

All seven interactive roles, each with a verified allowed and denied action:
`docs/demo/DEMO_ROLE_JOURNEYS.md`.

The two machine identities, `service_account` and `worker`, hold no demonstration sign-in and are
excluded on purpose. Inventing one to complete a table would misrepresent the product.
