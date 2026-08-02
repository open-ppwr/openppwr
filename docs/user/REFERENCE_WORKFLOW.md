# Community reference workflow

## Where a fresh demonstration starts

A deployment bootstrapped by `openppwr-installer bootstrap-acme` does not start empty. It already
holds the fictional ACME catalogue — 28 packaging records, 18 materials, 40 components, 28 bills of
material, 4 suppliers — one accepted recycled-content declaration for each supplier, and one completed
assessment reading 16 PASS, 1 FAIL, 1 UNKNOWN and 10 NOT APPLICABLE.

Two gaps are open, deliberately, and they are the two that no document can close: one packaging record
declares 5% recycled content against the demonstration rule's 30% minimum, and one declares none at
all. Correcting them — assign, remediate, reassess — is the work that unlocks the freeze, because a
review cannot be frozen while any gap is open. That is the shortest honest path from a fresh install
to a dossier.

The rest of the workflow is unchanged and still available from the beginning: the invalid sample still
demonstrates the validation report, the supplemental sample still merges into a populated catalogue,
and evidence can still be uploaded, scanned, accepted and rejected.

Resetting the environment empties it. Nothing re-seeds afterwards, so a reset demonstration is rebuilt
by hand from the sample files on the Downloads page.

## The workflow

Use a role-appropriate credential to import a schema-versioned JSON or CSV catalog. Invalid imports return every row error and persist no domain rows; replaying an accepted idempotency key returns the existing result. Evidence contributors upload private files into quarantine. A worker scans them; only clean files can be accepted or rejected by an evidence reviewer.

Compliance managers run the exact demonstration rule version, inspect PASS/FAIL/UNKNOWN/NOT_APPLICABLE results, assign gaps, record remediation and reassess. Blocking gaps prevent ready-for-review. Once closed, freeze a review snapshot and generate canonical JSON, Unicode PDF, ZIP and SHA-256 manifest. Read-only auditors can download permitted artifacts and verify the audit chain.

All ACME companies, products, materials, suppliers and documents are fictional and generated exclusively for demonstration and testing. Results support readiness work; they do not certify or guarantee legal compliance.
