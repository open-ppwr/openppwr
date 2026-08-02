# Accessibility remediation report

Every finding from `ACCESSIBILITY_AUDIT_WCAG22.md`, what was done, and how it is prevented from
returning.

| # | Finding | Criterion | Impact | Status | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | Eyebrow text at 2.7:1 on the dark process ledger | 1.4.3 Contrast (AA) | serious | CLOSED | Light blue on that panel, 7.1:1 |
| 2 | Activity heading pale-on-pale | 1.4.3 Contrast (AA) | serious | CLOSED | Dark teal, 7.6:1 |
| 3 | Shared rule made the masthead eyebrow dark-on-dark | 1.4.3 Contrast (AA) | serious | CLOSED | Rule split; comment records why it must stay split |
| 4 | Workbench reported `lang="en"` for Polish and German | 3.1.1 Language of Page (A) | serious | CLOSED | `documentElement.lang` follows the active locale |
| 5 | No way to bypass repeated navigation | 2.4.1 Bypass Blocks (A) | moderate | CLOSED | Skip link, first focusable element, visible on focus |

No CRITICAL or HIGH finding remains open.

## How regressions are prevented

`npm run a11y:gate` runs axe-core against 19 routes × 3 locales plus the workbench and **fails on any
serious or critical violation**. It is a stage in the full gate with its own timeout, so it cannot be
skipped or silently hang.

The gate proved itself during this work: it caught finding 3, which the fix for finding 2 introduced.
A contrast change that looks obviously safe is exactly the kind that breaks a different surface.

## Deliberately not fixed

**The generated PDF dossier is not accessible.** Tagged-PDF structure, reading order and embedded
metadata are unaddressed. It is a real limitation for a user who relies on assistive technology to
read the dossier, and it is recorded rather than quietly excluded from scope. The JSON and ZIP
artifacts carry the same content in machine-readable form.

**Colour is used as a secondary signal** on badges and outcome counters. Every one also carries text,
so no information is lost — but the palette has not been checked against common colour-vision
deficiencies.

## Not verified

Screen-reader announcement quality, zoom and reflow at 200%, and testing with assistive-technology
users. These are the difference between the 4/5 claimed and the 5/5 not claimed.
