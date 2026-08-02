# Professional language standard — PL / EN / DE

Applies to every user-visible string: website pages, workbench, navigation, footer, calls to
action, download labels, status labels and error messages.

Enforced where practical by `npm run copy:gate` (`scripts/validation/copy-style-gate.mjs`).

## Universal rules

1. **Claims must be supported.** Never state or imply certification, guaranteed compliance,
   completed penetration testing, an uptime figure or an SLA. Approved claims are listed
   exhaustively in the owner's content-decision record, which is internal and is not part of this
   distribution.
2. **Describe mechanism, not marketing.** Say what the software does and what evidence exists.
3. **No fragments in body copy.** Every section is at least one complete sentence.
4. **Product names, statuses and outcome values are never translated**: OpenPPWR, Community, Cloud,
   Connect, Regulatory, Enterprise, Services, `Private Beta`, `PASS`, `FAIL`, `UNKNOWN`,
   `NOT_APPLICABLE`, `READY_FOR_REVIEW`, Apache-2.0, SBOM, Design Partner.
5. **Legal drafts carry their marker** in the locale: `DRAFT — REQUIRES OWNER/LEGAL REVIEW`,
   `PROJEKT — WYMAGA PRZEGLĄDU WŁAŚCICIELA/PRAWNIKA`,
   `ENTWURF — PRÜFUNG DURCH INHABER/RECHTSBERATUNG ERFORDERLICH`.

## Polish

**Direct address uses respectful capitalised forms.** In published copy addressing the reader:
`Ty, Ci, Cię, Ciebie, Tobie, Twój, Twoja, Twoje, Twojego, Twojej, Twoim, Twoich`.

Lowercase forms are a defect and are rejected by the gate. Prefer neutral imperative constructions
where they read better:

```
Wybierz plik.
Sprawdź dane przed importem.
Pobierz przykładowy pakiet.
```

**Avoid colloquial connectors and register:** `bo`, `no`, `po prostu`, `tak naprawdę`, `fajny`,
`łatwy w użyciu`, `ogarniamy`, `super`.

Use instead: `ponieważ`, `z uwagi na`, `dlatego że`, `w celu`, `umożliwia`, `zapewnia`, `upraszcza`,
`ogranicza ryzyko`.

Example — incorrect:

```
Dokument jest oznaczony jako projekt, bo wymaga jeszcze akceptacji.
```

Preferred:

```
Dokument jest oznaczony jako wersja robocza, ponieważ wymaga zatwierdzenia przez Właściciela
oraz przeglądu prawnego.
```

**Terminology:** opakowanie · materiał · komponent · zestawienie materiałowe (BOM) · dowód /
dokument dowodowy · wymaganie dowodowe · ocena · wynik oceny · luka · działanie naprawcze · ponowna
ocena · pakiet dokumentacyjny (dossier) · gotowe do przeglądu.

**Never write:** `zgodny z PPWR`, `gwarantuje zgodność`, `certyfikowany`, `bezpieczny w 100%`.
**Write instead:** `wspiera proces oceny zgodności`, `pomaga dokumentować wymagania`,
`umożliwia przygotowanie materiału do przeglądu`, `zawiera mechanizmy bezpieczeństwa opisane w
dokumentacji`.

## English

Concise professional B2B English. No hype, no casual idiom, no absolute claim.

Prefer: *supports*, *helps organisations prepare*, *provides an auditable workflow*,
*available in Beta*, *requires regulatory review*.

Avoid: *guarantees compliance*, *fully compliant*, *100% secure*, *effortless*, *just*, *simply*.

## German

Professional business German with **consistent formal address**: `Sie, Ihnen, Ihr, Ihre, Ihren`.
`du`, `dein` and `euch` must never appear; the gate rejects them.

Regulatory and legal German remains marked `REQUIRES HUMAN DE REGULATORY REVIEW` until a named
German regulatory reviewer approves it. AI translation is not a regulatory approval.

Negated disclaimers such as *„Es zertifiziert oder garantiert keine Rechtskonformität."* are the
required wording, not a violation.

## What the gate checks

| Rule | Scope |
|---|---|
| Unsupported claims (certification, guaranteed compliance, ISO 27001, absolute security) | all locales |
| Colloquial Polish connectors and register | `pl` |
| Lowercase Polish direct address | `pl` |
| Informal German `du` / `dein` / `euch` | `de` |

Two deliberate precision measures keep the gate trustworthy:

- **Negated claims are recognised, not flagged.** A sentence containing both a claim word and a
  negation is a disclaimer. Flagging *„nie certyfikuje ani nie gwarantuje zgodności"* would teach
  people to ignore the gate.
- **Polish word boundaries respect diacritics.** JavaScript's `\b` is ASCII-only, so a naive
  pattern reports `ci` inside `ciągu`. The boundary is stated explicitly instead.

The gate cannot judge idiom, tone or regulatory correctness. Those remain human review gates, per
`docs/i18n/WEBSITE_TRANSLATION_REVIEW.md`.
