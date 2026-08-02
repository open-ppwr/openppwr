# Workbench UX audit

An audit of the Community workbench as a product a stranger has to use, not as a set of endpoints
with a form in front of them. Findings are ordered by how badly they damage the first fifteen minutes.

Fixed findings are marked as such and carry a regression test. Open findings are stated plainly rather
than rounded off.

## Severity 1 — the user cannot complete the job

### 1.1 Dossier downloads did not work — **fixed**

The role that runs the workflow was refused the artifact it had just generated, and the refusal was
invisible. See `docs/bugs/DOSSIER_DOWNLOADS_NOT_WORKING.md`. Regression tests assert over the whole
role matrix, not a named role.

### 1.2 There were no discoverable credentials — **fixed**

The workbench asked for a credential and gave no way to obtain one. A user who opened the
demonstration could not get past the first screen. The sign-in panel now lists the demonstration
accounts with a card per role, describing what each role is for, and a button that fills the form in.
The panel appears only when the operator has enabled demonstration sign-in.

### 1.3 A failed operation could produce no feedback at all — **fixed**

Only operations routed through `act()` reported anything. The download handler was not, so its failure
vanished into an unhandled promise. Everything now reports through one path: a localized message, a
support reference, and the raw payload behind a disclosure.

## Severity 2 — the product reads as unfinished

### 2.1 Raw database values on translated screens — **fixed**

`supplier_id`, `scan_status`, `infected`, `pending` and `PASS` appeared verbatim between Polish and
German sentences. Column headings and closed-set values are now translated, and the `i18n:gate`
derives the required labels from the database schema and rejects an English fallback in Polish or
German. See `docs/bugs/DEMO_I18N_AND_EVIDENCE_ROWS.md`.

### 2.2 Artifacts were listed as storage details — **fixed**

The dossier list showed `zip`, `json`, `manifest`, `pdf` and a byte count. It now shows what each
artifact is for, its filename, a human-readable size and the leading bytes of its SHA-256.

### 2.3 Evidence versions looked like duplicate rows — **fixed**

Two uploads against one requirement produced two visually identical rows. The version is now shown,
the current version is marked, and superseded versions are dimmed and cannot be approved — which also
closes a path to approving an outdated document by mistake.

## Severity 3 — the interface explains itself poorly

### 3.1 The forbidden-error message contradicted the API — **fixed**

It told the user their role was wrong, on a status code chosen specifically not to reveal whether the
resource exists. All three locales now describe the outcome without disclosing which cause applied.

### 3.2 Errors lead with the technical payload — **fixed earlier, retained**

The activity pane leads with a localized sentence and a support reference; the JSON is behind a
disclosure. Support can still get everything it needs.

### 3.3 The workflow rail is a list, not a state — **open**

The left rail numbers the six stages but does not show which are done, which is current, or which are
blocked. A user who steps away cannot tell where they were. Adding stage state is a contained change
and is the strongest remaining improvement.

### 3.4 Section numbering does not match the rail — **open**

The reset panel renders as step 07 and sits above the dossier section, which is step 06. Reset is not
a workflow step at all and should not carry a step number.

### 3.5 Nothing states which role can do what, in the workbench — **partly addressed**

The role cards now describe each role at sign-in. Once signed in, an action that the current role
cannot perform is simply absent, with no explanation. This is deliberate — presenting an action that
would certainly fail is worse — but the user is left to infer the rule.

## Severity 4 — smaller friction

### 4.1 The import payload is an empty textarea — **open**

The first step of the demonstration asks the user to paste a JSON or CSV document, with no sample
available in the interface. The ACME dataset exists but must be found on disk. A "load the sample
payload" action would remove the single largest stall in the walkthrough.

### 4.2 Evidence upload requires choosing a requirement first — **open**

The requirement selector shows `packaging_id · supplier_id`, which is precise and unreadable. It
should show what document is being asked for.

### 4.3 Assessment outcomes are counters with no route into the detail — **open**

The four totals are shown, but there is no way to move from "1 non-compliant" to the record that
failed. The gaps section holds that information and is reached separately.

### 4.4 The reset confirmation is a browser dialog — **open**

Destructive confirmation uses `window.confirm`. It is honest and unstyled. It states what will be
deleted and what is preserved, so this is cosmetic rather than a safety issue.

## What was checked and found sound

- No credential is written to `localStorage` or persisted; it lives in the tab.
- A credential that stops working mid-session returns the user to the signed-out state instead of
  leaving an authenticated-looking workbench that silently fails.
- Every failure carries a correlation ID that support can tie to a server log entry.
- Actions are disabled while an operation is in flight, so a double click cannot double-submit.
- The fiction notice and the German regulatory-review notice are present on every screen.

## Not in scope

Visual design, mobile layout beyond not breaking, and accessibility beyond semantic markup and
`aria-live` on the activity pane. A full accessibility audit is a separate piece of work and is not
claimed here.
