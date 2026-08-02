# Website translation review

Scope: the localized marketing site (`apps/web/src/site-content.js`, `site-sections.js`,
`site-meta.js`) in EN, PL and DE, after the 2026-07-28 expansion.

Status: **machine-verified for completeness and consistency. Human language review outstanding.**

## What is verified automatically

`npm run i18n:gate`:

- every application string key exists in all three locales, with no missing, extra or empty values;
- every route has page copy in all three locales;
- every expanded page has the **same number of sections** in all three locales, so a partially
  translated page fails rather than silently falling back;
- no section is missing a heading or a body;
- every route has a localized SEO title and description, and PL/DE metadata is not identical to
  EN (which would indicate untranslated copy);
- the German regulatory-review marker is present.

`npm run website:gate` additionally rejects fragment sections and unapproved claims in any locale.

`npm run website:browser` renders all 57 localized pages and asserts the correct `html lang`,
title, description, canonical and hreflang alternates.

Verified: **no mixed-language pages, no untranslated critical strings, no fragments, no missing
metadata.** This is a structural guarantee, not a judgement about how the text reads.

## What is NOT verified automatically

No automated check can confirm that the translations are idiomatic, that terminology is right for
the industry, or that regulatory phrasing is legally sound. The following require named humans.

### Polish — product review (release gate)

Reviewer: **not yet named.** Please check:

- packaging and compliance terminology reads correctly to a Polish packaging professional
  (`opakowanie`, `dowody`, `luki`, `ocena`, `dokumentacja`);
- retained English technical terms — `Private Beta`, `self-hosted`, `backup`, `rollback`,
  `fail-closed`, `Design Partner` — are the right choice rather than translation gaps. They were
  kept deliberately because the Polish IT industry uses them, but that is a judgement call;
- the legal pages read as Polish legal prose, not as translated English;
- `Prezes Urzędu Ochrony Danych Osobowych` is correctly named on the privacy page.

### German — regulatory review (release gate)

Reviewer: **not yet named.** This is the strictest gate, because German regulatory wording is
explicitly flagged `REQUIRES HUMAN DE REGULATORY REVIEW`.

Please check:

- **every PPWR and compliance statement on `/de/security`, `/de/trust`, `/de/regulatory` and
  `/de/demo`.** AI translation is explicitly not a regulatory approval;
- the no-legal-advice and no-compliance-guarantee clause in `/de/terms` carries the intended legal
  weight in German;
- `Verpackungsbereitschaft` is the right term, or should be replaced;
- data-protection vocabulary on `/de/privacy` matches German GDPR usage
  (`Verantwortlicher`, `Auftragsverarbeitung`, `berechtigtes Interesse`);
- formal register (`Sie`) is used consistently — it is, but confirm it fits the audience.

### English

Recommended proofread. No blocking concerns known.

## Terminology decisions applied

| Concept | EN | PL | DE |
|---|---|---|---|
| Packaging readiness | packaging readiness | gotowość opakowaniowa | Verpackungsbereitschaft |
| Evidence | evidence | dowody | Nachweise |
| Gap | gap | luka | Lücke |
| Assessment | assessment | ocena | Bewertung |
| Dossier | dossier | dokumentacja | Dossier |
| Remediation | remediation | działania naprawcze | Abhilfe |
| Tenant isolation | tenant isolation | izolacja tenantów | Tenant-Isolation |
| Self-hosted | self-hosted | self-hosted | selbst gehostet |

Deliberately **not** translated in any locale, because they are product names or status labels
with fixed meaning: OpenPPWR, Community, Cloud, Connect, Regulatory, Enterprise, Services,
`Private Beta`, `Private Alpha`, `PASS`, `FAIL`, `UNKNOWN`, `NOT_APPLICABLE`, `READY_FOR_REVIEW`,
Apache-2.0, SBOM, `Design Partner`.

## Known limitations

- Status labels are localized in the UI (`Dostępne`, `Verfügbar`) but the underlying status
  vocabulary is English in the content model. This is intentional and consistent.
- Legal pages are drafts in all three locales. Translation review of legal text should happen
  **after** legal review of the English source, otherwise the same corrections get made three times.
- Addresses and registration identifiers are deliberately identical across locales, with only the
  country name localized.
