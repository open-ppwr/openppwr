# Accessibility audit — WCAG 2.2 AA

**Performed:** 2026-07-29, at commit `7e8ac4f` plus the fixes recorded here.
**Scope:** 19 public routes × 3 locales, plus the workbench in its signed-out state — 60 surfaces.
**Previous score:** 2/5, with the honest note that nobody had checked. This is the check.

## Method

**Automated.** axe-core via Playwright, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`.
Findings at *serious* or *critical* impact fail the gate. Run with `npm run a11y:gate`; it is part of
the full gate.

**Structural.** A scripted pass over the same routes measuring what a machine can judge reliably:
document language, heading order, landmark presence, controls without accessible names, form fields
without labels, tables without header cells, live regions, and the size of the tab order.

Automated tooling finds roughly a third of real barriers. What it cannot judge is recorded under
limitations rather than claimed as passing.

## Findings and fixes

### 1. Colour contrast on the process ledger — *serious*, fixed

`.site-eyebrow` uses the brand blue, which is legible on a light background and fails badly on the
dark process-ledger panel: **2.7:1** against a 4.5:1 requirement. Affected home, product and community
in all three locales — 9 of the 12 original findings.

Fixed with a light blue on that panel (**7.1:1**).

### 2. Colour contrast in the activity pane — *serious*, fixed

`.activity > p` was a pale mint on a pale background. Fixed to the dark teal already in the palette
(**7.6:1**).

Fixing this one introduced a second failure, caught by rerunning the gate: `.eyebrow` and
`.activity > p` shared a rule, and the masthead eyebrow sits on the dark ink panel, so the shared
colour was then dark-on-dark. The rule is now split, with a comment saying why it must stay split.

### 3. The workbench never set the document language — WCAG 3.1.1 Level A, fixed

`/pl/app` and `/de/app` both reported `lang="en"`. Every visible string changed with the locale
selector; the document language did not. A screen reader would announce Polish and German content
with English pronunciation rules — the kind of defect that is invisible in a screenshot and makes the
interface unusable by ear.

The workbench now sets `documentElement.lang` from the active locale. The marketing site already did
this correctly.

### 4. No mechanism to bypass repeated navigation — WCAG 2.4.1 Level A, fixed

Every marketing page presents two navigation landmarks before the content, and the workbench presents
the masthead and the workflow rail. A keyboard user had to traverse all of it on every page.

A skip link is now the first focusable element on both the site and the workbench, visible only when
focused.

## Verified sound

Measured across all 60 surfaces, in all three locales:

| Check | Result |
| --- | --- |
| Exactly one `h1` per page | 60/60 |
| No skipped heading levels | 60/60 |
| `main` landmark present | 60/60 |
| Controls with no accessible name | 0 |
| Form fields with no label | 0 |
| Tables without header cells | 0 |
| Document language matches content | 60/60 after fix |
| Live region for asynchronous results | present in the workbench |
| axe serious/critical violations | 0 |

The activity pane is `aria-live="polite"`, so the outcome of an operation is announced without moving
focus. Errors carry `role="alert"`. Status is never conveyed by colour alone — every badge carries
text, which is why the localisation work also served accessibility.

## Limitations — what this audit does not establish

Stated plainly rather than folded into a score:

- **No screen-reader session was run.** NVDA, JAWS and VoiceOver behaviour is inferred from markup, not
  observed. Reading order and announcement quality are unverified.
- **No test with assistive-technology users.** Nothing here says the product is *usable*, only that it
  meets the checkable criteria.
- **Zoom and reflow at 200%** were not measured; the layout uses relative units and flexible grids,
  which is a reason to expect it to hold, not evidence that it does.
- **Motion preferences** are honoured on the marketing site only.
- **PDF dossier accessibility is not assessed.** A generated PDF has its own tagging requirements and
  almost certainly does not meet them.
- The workbench was audited **signed out**. Tables, gap rows and the dossier list appear only after
  authentication and are covered structurally by the browser journey, not by axe.

## Score

**4/5 — publication-ready Community beta.**

Justified by: every automated serious/critical finding closed, two Level A failures found and fixed,
structural criteria verified across 60 surfaces, and a gate that fails the build on regression.

Not 5/5, and deliberately so: no screen-reader session, no user testing, no zoom measurement and an
unassessed PDF. A 5 would require evidence that does not exist.
