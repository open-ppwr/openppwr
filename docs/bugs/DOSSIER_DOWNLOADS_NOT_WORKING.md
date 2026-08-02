# Dossier downloads did not work

**Severity:** P0 — the workflow could be completed but its output could not be collected.
**Status:** fixed.
**Found:** during owner review of the Community release candidate, on the deployed environment.

## What the user saw

After freezing a review and generating a dossier, the workbench listed the artifacts it had just
produced. Clicking a download did nothing at all: no file, no error, no entry in the activity pane.

## Two independent defects

### 1. The role that generates a dossier could not download it

`compliance_manager` held `dossier:generate` but not `dossier:download`. The role that runs the
entire workflow — import, assess, remediate, freeze, generate — was refused the artifact it had just
created. `service_account` had the same gap.

The refusal was correct in mechanism and wrong in policy. `requirePermission` deliberately answers
`404 RESOURCE_NOT_FOUND` rather than `403`, so an unauthorised caller cannot use the error to confirm
that an artifact exists. That behaviour is unchanged. What changed is the matrix: a role that may
generate a dossier may now retrieve it.

Reproduced on the deployed environment before the fix:

```
compliance_manager  download status=404
read_only_auditor   download status=200
```

`read_only_auditor` already held `dossier:download`, which is why the defect was not caught earlier —
whoever tested downloads had tested them with the auditor.

### 2. A refused download produced no visible result

The download handler ran outside the `act()` wrapper used by every other operation, so a rejected
request threw into an unhandled promise. The user got no error message, no correlation ID and no
activity entry. The two defects compounded: the authorisation gap was invisible.

## Fixes

- `apps/api/src/permissions.mjs` — `dossier:download` added to `compliance_manager` and
  `service_account`. Roles with no dossier responsibility are unchanged and still denied.
- `apps/web/src/App.jsx` — the download is routed through `act()`, so success and failure both appear
  in the activity pane, with the localized message and support reference every other operation gets.
- The artifact list now shows a business-readable name, the filename, the size and the leading bytes
  of the SHA-256, instead of the raw `artifactType` string and a byte count.

## Tests

`apps/api/test/permissions.test.mjs` gains two regression tests:

- **a role that can generate a dossier can retrieve it** — asserted over the whole matrix, not over a
  named role, so a future role with `dossier:generate` cannot reintroduce the gap. This test found
  the `service_account` instance of the same defect.
- **dossier download stays denied to roles with no dossier responsibility** — `packaging_editor`,
  `evidence_contributor`, `evidence_reviewer`, `supplier_user` and `worker` remain denied, and
  `read_only_auditor` keeps download without gaining generate.

## What this does not change

Downloads remain tenant-scoped, audited and subject to rate limiting. The authorisation decision is
still made server-side per request; the client change only makes the outcome visible.
