# The canonical OpenPPWR Community demonstration

One scenario, run end to end, that shows what the product is for: a packaging portfolio is assessed
against a rule set, the failures are given owners and fixed, the review is frozen, and an evidence
package comes out that a third party can verify.

It takes about fifteen minutes. Everything in it is fictional ACME data.

## Before you start

You need a running Community deployment with demonstration sign-in enabled
(`OPENPPWR_DEMO_LOGIN=true`). Open `/en/app`, `/pl/app` or `/de/app`. The **Demonstration accounts**
panel lists the roles; each card fills in the sign-in form.

This page walks the whole workflow from an empty environment, so that every stage is seen once. A
deployment set up with `openppwr-installer bootstrap-acme` is **not** empty: it already holds 28 of the
32 packaging records, four accepted supplier declarations and one assessment reading 16 / 1 / 1 / 10,
with the same two blocking findings open. If that is your deployment, start at step 6 — the shortest
honest path to a dossier — and read
[the reference workflow](../user/REFERENCE_WORKFLOW.md) for the figures a fresh install starts with.

**Reset environment to initial state** empties the environment; it does not restore what
`bootstrap-acme` set up, and nothing re-seeds it afterwards. Use it only if you want to walk this page
from step 1.

## The scenario

The complete ACME portfolio is 32 packaging records: 28 in `acme-import-valid.json` and 4 more in
`acme-import-supplemental.csv`. The rule set finds one hard failure and one item it cannot judge
because a supplier document is missing. Both are fixed. The reassessed portfolio is fully compliant,
and only then can the review be frozen and a dossier produced.

| Stage | Compliant | Non-compliant | Not determined | Not applicable |
| --- | --- | --- | --- | --- |
| First assessment | 20 | 1 | 1 | 10 |
| After remediation | 22 | 0 | 0 | 10 |

These counts are for all 32 records. Import only the JSON file and the same run reads 16 / 1 / 1 / 10
and then 18 / 0 / 0 / 10: the 4 supplemental records are all in rule scope, so they add four passes and
move nothing else.

The two blocking outcomes become compliant; the ten not-applicable results stay not applicable,
because a rule that does not apply to a packaging type does not become a pass when something else is
fixed.

## Walking it

### 1. Import the portfolio — *packaging editor*

Sign in as the packaging editor and import `acme-import-valid.json` — 28 records — then
`acme-import-supplemental.csv` for the remaining 4. The idempotency key means a repeated import is
recognised rather than duplicated: submit the same payload twice and the second call reports the first
result. On a deployment set up by `bootstrap-acme` the JSON half is already done; import only the CSV.

### 2. Read the catalogue — *any role*

Load the catalogue summary and open packaging, materials, components, bills of materials and
suppliers. This is the data the assessment will run against.

### 3. Upload evidence — *evidence contributor*

Sign in as the evidence contributor, load the evidence requirements and upload a document against
one. The upload is accepted with `202`: it is scanned for malware before it becomes usable, and the
scan status moves from *awaiting scan* to *no threat found*. Nothing is trusted until it has been
scanned — a failed or timed-out scan leaves the document quarantined rather than available.

Uploading a second document against the same requirement creates **version 2**. Version 1 stays,
marked superseded, and can no longer be approved. History is kept; it is not overwritten.

### 4. Approve the evidence — *evidence reviewer*

Sign in as the evidence reviewer and approve the uploaded document. The contributor cannot approve
their own upload, and the reviewer cannot upload — the separation is enforced by the server, not by
hiding buttons.

### 5. Assess — *compliance manager*

Sign in as the compliance manager and run the assessment. The result is the first row of the table
above: 20 compliant, 1 non-compliant, 1 not determined, 10 not applicable.

### 6. Fix what failed — *compliance manager*

Each blocking outcome becomes a gap. For each one: assign an owner, record the remediation, then
reassess that gap. The outcome moves to compliant.

Reassessment is per gap and deliberate. Nothing is silently re-run in the background, so the record
shows who decided that a specific finding was resolved, and when.

### 7. Freeze the review — *compliance manager*

Freeze the review. This fails with `409 READY_FOR_REVIEW_BLOCKED` while any gap is still open, and
with `409 READY_FOR_REVIEW_INCOMPLETE` if a packaging record carries no current assessment at all —
you cannot freeze a review that is not finished. Once frozen, the snapshot is immutable.

### 8. Generate and collect the dossier — *compliance manager*

Generate the dossier. Four artifacts are produced from the frozen snapshot:

| Artifact | What it is for |
| --- | --- |
| Structured data (JSON) | Machine-readable record of the frozen review |
| Review report (PDF) | The human-readable report |
| Complete evidence package (ZIP) | Report, data and every approved evidence file |
| SHA-256 checksum manifest | Lets anyone verify the package was not altered |

Download each one. The role that generated the dossier can retrieve it, and so can the read-only
auditor.

### 9. Verify — *read-only auditor*

Sign in as the read-only auditor and verify the audit chain. Every action in this walkthrough is a
hash-chained entry; verification proves none of them was altered or removed after the fact. The
auditor can confirm all of it and change none of it.

## What the demonstration is meant to show

- **Evidence is scanned before it counts.** A document that cannot be scanned cleanly is quarantined,
  not accepted.
- **Roles are separated by the server.** Uploading, approving and freezing are different
  responsibilities, enforced per request.
- **A review cannot be frozen while findings are open.** The freeze is a real gate.
- **The dossier is verifiable by someone who does not trust you.** The manifest is the point.
- **The record is tamper-evident.** The audit chain is verifiable by a role that cannot write to it.

## What it deliberately does not show

The dataset is fictional and the deployment is self-hosted and single-tenant. Multi-tenant operation,
managed hosting, upstream system connectors, maintained regulatory rule content and support
commitments are not part of Community and are not demonstrated here.

## Resetting

**Reset environment to initial state** clears imported packaging, evidence, assessments, gaps and
dossiers. Tenants, identities, sign-in accounts and the audit history are preserved, so the reset
cannot lock you out of the environment it just cleared.

"Initial state" means empty. It is not the state `bootstrap-acme` left behind, and nothing re-seeds it:
bootstrap is a one-time, whole-deployment operation and the API refuses it once a tenant exists. After
a reset the environment is rebuilt by hand from the sample files on the Downloads page.
