# Copy review — PL / EN / DE

Editorial review of all user-visible copy against
`PROFESSIONAL_LANGUAGE_STYLE_GUIDE.md`, performed 2026-07-28.

Method: `scripts/validation/copy-style-gate.mjs` inspects every string in the shipped copy model —
site pages, expanded sections, download labels, common copy and the workbench catalogue — **1704
strings across three locales**. Findings were corrected in the source model, not suppressed.

Result: **`COPY_STYLE_PASS`**, 0 findings.

Technically accurate pages were not rewritten. Only defective wording was changed.

## Findings and corrections

31 defects were found and fixed, all in Polish. English and German required no correction.

### Polish — lowercase direct address (20 corrections)

The style standard requires respectful capitalised forms when addressing the reader. Corrected on:
Trust (4), Privacy (5), Terms (3), Cookies (3), Partners (3), Demo (1), Company information (1).

| Before | After |
|---|---|
| `Twoje dane są twoje` | `Twoje dane pozostają Twoje` |
| `pozostają na twojej infrastrukturze` | `pozostają w Twojej infrastrukturze` |
| `zostaje ci działający system` | `pozostaje Ci działający system` |
| `przysługują ci prawa dostępu` | `przysługują Ci prawa dostępu` |
| `Nie śledzimy cię` | `Nie śledzimy Cię` |
| `wkładem do twojego procesu zgodności` | `stanowią wkład do Twojego procesu zgodności` |

### Polish — colloquial connectors (6 corrections)

`bo` replaced with `ponieważ` throughout, and the surrounding sentences raised to business register.

| Before | After |
|---|---|
| `Dlaczego brak cen? Bo nie zostały ustalone.` | `Dlaczego nie publikujemy cen? Ponieważ nie zostały jeszcze ustalone.` |
| `nie angażuje żadnego podprocesora, bo nie angażuje żadnej usługi z naszej strony` | `nie angażuje żadnego podprocesora, ponieważ nie obejmuje żadnej usługi świadczonej przez nas` |
| `bo to byłaby nieprawda` | `ponieważ byłoby to niezgodne ze stanem faktycznym` |
| `bo jeszcze nie istnieją` | `ponieważ nie zostały jeszcze udostępnione` |
| `do tego czasu jej nie ma, bo dokument jest projektem` | `do tego czasu nie została określona, ponieważ dokument stanowi wersję roboczą` |

### Polish — register and terminology (5 corrections)

| Before | After |
|---|---|
| `Uploady i żądania są objęte limitami.` | `Przesyłanie plików oraz żądania są objęte limitami częstotliwości.` |
| `System zwracający wyłącznie PASS albo FAIL coś ukrywa.` | `System zwracający wyłącznie PASS albo FAIL pomija istotną informację.` |
| `sprawy prywatności kierujemy na kontakt administratora` | `sprawy dotyczące prywatności należy kierować na adres kontaktowy administratora` |
| `Jesteś wtedy administratorem wszystkiego w swoim wdrożeniu` | `W takim przypadku administratorem danych w tym wdrożeniu jesteś Ty` |
| `wgrane pliki` (demo, privacy) | `przesłane pliki` / `wgrane przez Ciebie pliki` |

### English

No defects. Already free of hype, absolute claims and casual idiom.

### German

No defects. Formal `Sie` used consistently; no `du`, `dein` or `euch` anywhere.

## False positives corrected in the gate itself

Two rules were wrong on first run and were fixed so the gate stays trustworthy:

1. **Negated disclaimers were flagged as unsupported claims.** `zertifiziert` inside
   *„Es zertifiziert oder garantiert keine Rechtskonformität."* is exactly the wording the standard
   requires. The gate now treats a sentence containing both a claim word and a negation as a
   disclaimer. Verified: the disclaimer passes, while `OpenPPWR ist ISO 27001 zertifiziert` and
   `Produkt certyfikowany przez jednostkę` are still rejected.
2. **Polish `ci` was matched inside `ciągu`.** JavaScript's `\b` is ASCII-only, so a diacritic ends
   a "word". The boundary now excludes Latin-Extended characters. Verified against seven cases
   including `w ciągu`, `ciasteczka`, `zostaje ci` and `Ciebie`.

## Review status

| Item | Status |
|---|---|
| Automated style conformance, all locales | **PASS** — 0 findings across 1704 strings |
| Claim discipline | **PASS** — no certification, guarantee, uptime or SLA claim |
| Polish product review | **OPEN — human gate.** Idiom and industry terminology need a native reviewer |
| German regulatory review | **OPEN — human gate.** Regulatory wording still marked `REQUIRES HUMAN DE REGULATORY REVIEW`; AI translation is not an approval |
| Legal review of privacy / terms / cookies | **OPEN — human gate.** Drafts remain labelled |

The gate proves consistency and claim discipline. It cannot judge whether the Polish reads naturally
to a Polish packaging professional, or whether the German is regulatorily sound. Those remain human
reviews.
