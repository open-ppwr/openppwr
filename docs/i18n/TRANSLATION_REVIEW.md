# Translation review

## Current status

- EN: engineering-reviewed base catalog.
- PL: AI-assisted engineering draft; human product review required.
- DE: AI-assisted engineering draft; **REQUIRES HUMAN DE REGULATORY REVIEW**.
- EN remains the deterministic fallback for unsupported or malformed locale values.

## Automated evidence

`npm run i18n:gate` verifies catalog parity for EN/PL/DE, fallback configuration, all UI key references, and the mandatory German review marker. `npm run test:e2e:browser` executes the complete reference browser workflow on a clean database once per locale and verifies the selected dossier locale.

Localized dossier PDFs embed DejaVu Sans for Polish and German glyphs. Creation and modification dates derive from the frozen snapshot; font subsetting and object ordering are deterministic for identical input.

## Human gate

Before public release, reviewers must approve product terminology, errors, rule explanations, gap language, PDF output, accessibility, and line wrapping. German regulatory wording cannot be marked approved by an engineering agent.

