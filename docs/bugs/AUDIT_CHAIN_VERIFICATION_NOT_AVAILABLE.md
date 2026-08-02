# Audit-chain verification was refused to the role that runs the review

**Severity:** P0 — the product's central integrity claim could not be exercised by the user who needs it.
**Status:** fixed.
**Found:** owner review of the Community release candidate, Polish interface.

## What the user saw

```text
Sprawdź łańcuch audytu

Nie można wykonać tej operacji. Zasób nie istnieje albo nie jest dostępny dla Twojej roli.

RESOURCE_NOT_FOUND
```

## Root cause

`compliance_manager` did not hold `audit:verify`. Only `tenant_admin` (via the wildcard) and
`read_only_auditor` did.

The demonstration signs in as `demo@…`, which is the compliance manager — the role that imports, runs
the assessment, remediates the findings, freezes the review and generates the dossier. That role could
do all of it and then not confirm that the record behind it was intact.

The response itself was correct: `requirePermission` answers `404 RESOURCE_NOT_FOUND` rather than
`403` so that an unauthorised caller cannot use the error to confirm that something exists. That
behaviour is unchanged.

The defect was made visible by a second, more general fault: **the interface offered the action to
every signed-in role.** The user was invited to press a button that their role could never use. This
is the same shape as the dossier-download defect (`DOSSIER_DOWNLOADS_NOT_WORKING.md`) — twice is a
pattern, not a coincidence.

## Fixes

### The permission

`audit:verify` is granted to `compliance_manager`. Verification reads only the caller's own tenant
chain and returns no other subject's detail, so it discloses nothing the role cannot already read.
Roles with no review responsibility — packaging editor, evidence contributor, evidence reviewer,
supplier user, worker, service account — remain denied.

### The interface stops inviting refusals

`GET /v1/session` now reports the permissions the role actually holds, and the workbench offers only
the actions in that list. Server-side authorisation is unchanged and remains the control; this
removes the invitation, not the check.

The general test is the important part: **every role that can freeze a review must be able to verify
the record behind it**, asserted over the whole matrix rather than a named role, so a future role
cannot reintroduce the gap.

### The result is stated, not dumped

Verification now reports how many events were checked and the period they cover, and the interface
states the outcome in the user's language:

```text
Łańcuch audytu został zweryfikowany.
Wszystkie zdarzenia (60) tworzą spójny, niezmieniony zapis procesu.
Zakres czasu: … — …
```

and on failure:

```text
Nie można zweryfikować łańcucha audytu.
Zapisana sekwencja nie zgadza się z własnymi skrótami. Potraktuj powiązany przegląd jako
niewiarygodny i zgłoś sprawę.
```

The raw payload stays behind the technical-details disclosure. A bare `valid: true` asks the reader to
take the result on faith; stating the count and the range is what makes it inspectable.

## Tests

Unit, over the whole authorization matrix:

- every role that can freeze a review can verify the audit chain;
- roles with no review responsibility remain denied;
- reported capabilities match enforced decisions, the wildcard expands rather than leaking `*`, and an
  unknown role reports nothing.

Integration, against real PostgreSQL:

- the compliance manager verifies successfully and receives count, first and last event timestamps;
- an unentitled role receives `404 RESOURCE_NOT_FOUND`, not `403`;
- the session reports `audit:verify` for the entitled role and not for the worker.

Browser, in the canonical journey:

- the compliance manager verifies the chain immediately after generating the dossier — the exact step
  that failed;
- the result appears as prose, asserted not to contain the raw payload;
- the read-only auditor verifies as well, and is not offered freeze or generate.

## Not changed

Cross-tenant isolation, the non-enumerating `404`, RLS, and the hash-chain algorithm itself. This was
an authorisation and presentation defect, not an integrity defect: no chain was ever wrong, it simply
could not be checked by the person running the process.
