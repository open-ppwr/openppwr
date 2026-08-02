# Mixed-language workbench, misleading errors and apparently duplicate evidence rows

**Severity:** P0 — the product read as unfinished in Polish and German, and one defect could cause a
wrong compliance decision.
**Status:** fixed.
**Found:** during owner review of the Community release candidate.

## 1. Raw database values reached translated screens

Table headings and status cells were rendered from the database column and value directly. A user who
had selected Polish saw `supplier_id`, `scan_status`, `infected`, `pending` and `PASS` sitting between
Polish sentences. The interface chrome was translated; the data was not.

This was never a missing-translation-key problem — the gate reported every key present — because the
values were never passed through translation at all.

### Fix

`apps/web/src/i18n.js` gains `columnLabel(locale, column)` and `enumLabel(locale, value)`, and
catalogs for every column heading and every status value the schema permits, in all three locales.
`DataTable` translates headings, and translates cells for columns whose values are a closed set.

Identifiers and free text are **not** translated. A supplier ID that changed with the interface
language could not be matched against the source data, which would be worse than showing it raw.

### Test

`scripts/validation/i18n-gate.mjs` now parses the status `CHECK` constraints out of
`packages/database/migrations/001_phase4_foundation.sql`, adds the assessment outcomes and the derived
version states, and requires that every one of those 25 values has a label in every locale **and that
the Polish and German labels differ from English**. An untranslated fallback is precisely the
mixed-language defect being fixed, so silently falling back to English would have let it reappear.
The same check covers every column heading used by a table in `App.jsx` and every demonstration role
card.

The gate proved itself on introduction by failing on a genuinely missing `col_currency`.

## 2. The forbidden-error message described the wrong cause

The interface said, in effect, "your role does not permit this action — sign in with a role that has
the required permission". The API deliberately answers `404 RESOURCE_NOT_FOUND` for an unauthorised
request so that the error cannot be used to confirm that a resource exists. The message contradicted
that design: it told the user the resource exists and only the role is wrong, which is exactly the
inference the status code exists to prevent, and it was simply wrong whenever the resource really was
absent.

### Fix

All three locales now say that the operation could not be completed because the resource does not
exist or is not available to that role — true in both cases, and disclosing neither.

## 3. Evidence rows looked duplicated

Uploading a document against a requirement creates a **new version**; it does not replace the previous
one. The evidence table listed supplier, document type and the two statuses — none of which differ
between versions — so two uploads produced two rows that looked identical.

The cosmetic complaint hid a real risk: a reviewer could approve a superseded version while believing
they were approving the current one.

### Fix

The version column is displayed, and the highest version per requirement is labelled current while the
rest are labelled superseded and dimmed. Approve and reject are disabled on superseded rows.

Currency is derived in the client from the listed rows. This is a presentation fix; it does not change
what the server stores or which version an assessment consumes.

## Residual limitation

Currency is derived from the rows currently loaded. If the list were ever paginated, a version outside
the loaded page could be mislabelled. The Community evidence list is unpaginated, so this cannot occur
today; pagination must move the derivation to the server.
