// SPDX-License-Identifier: Apache-2.0
//
// Documentation language-policy gate.
//
// The owner approved a specific, asymmetric policy on 2026-07-29: sixteen areas complete in English,
// nine of them additionally complete in Polish and German, and the remaining seven carrying a
// localized notice that says so. Each half of that can fail silently — a missing translation looks
// like an English page, and a stale notice on a translated page is a false statement about the page
// the reader is looking at.
//
// Section 6 checks a different kind of drift, added after the published ACME walkthrough was found
// describing a demonstration that no longer exists: it opened by telling the reader to import a
// catalogue `bootstrap-acme` had already imported for them, and quoted a 32-record catalogue and its
// 20/1/1/10 outcome as the state of a fresh deployment, when a fresh deployment holds 28 records and
// reads 16/1/1/10. Nothing compared the published figures to the product, in any language, so the
// page could be — and was — confidently wrong in three of them at once.
//
//   node scripts/validation/docs-language-gate.mjs

import { readFileSync } from 'node:fs';
import { createAcmeCatalog, createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';
import { CRITICAL_SLUGS, DOCS_PAGES, docsChrome, docsIndexFor, docsPage, isTranslated } from '../../apps/web/src/docs-content.js';

const LOCALES = ['en', 'pl', 'de'];
const TRANSLATED_LOCALES = ['pl', 'de'];
const findings = [];

// 1. Sixteen areas, complete in English. "Complete" is checked structurally rather than by length:
// a page with a purpose, an audience and a body containing at least one heading and one instruction
// is a page; a stub is not.
if (DOCS_PAGES.length !== 16) findings.push(`expected 16 documentation areas, found ${DOCS_PAGES.length}`);
for (const page of DOCS_PAGES) {
  if (!page.purpose) findings.push(`${page.slug}: no purpose`);
  if (!page.audience) findings.push(`${page.slug}: no audience`);
  const headings = page.body.filter((block) => block.kind === 'h').length;
  const substance = page.body.filter((block) => block.kind === 'p' || block.kind === 'ul' || block.kind === 'code').length;
  if (headings < 2) findings.push(`${page.slug}: fewer than two sections`);
  if (substance < 3) findings.push(`${page.slug}: too little content to be a page`);
  if (!page.related?.length) findings.push(`${page.slug}: no related pages`);
}

// 2. The nine critical areas exist, and are translated into both languages.
for (const slug of CRITICAL_SLUGS) {
  if (!DOCS_PAGES.some((page) => page.slug === slug)) {
    findings.push(`critical slug "${slug}" does not exist in the documentation set`);
    continue;
  }
  for (const locale of TRANSLATED_LOCALES) {
    if (!isTranslated(slug, locale)) findings.push(`${slug}: required translation missing for ${locale}`);
  }
}

// 3. A translation is whole or it is not a translation. A page whose title is Polish and whose body
// is English is worse than an honest English page, because nothing tells the reader which they have.
for (const locale of TRANSLATED_LOCALES) {
  for (const slug of CRITICAL_SLUGS) {
    const page = docsPage(slug, locale);
    if (!page?.translated) continue;
    const english = docsPage(slug, 'en');
    if (page.title === english.title && slug !== 'quickstart') findings.push(`${slug}/${locale}: title is not translated`);
    if (page.purpose === english.purpose) findings.push(`${slug}/${locale}: purpose is not translated`);
    if (page.body === english.body) findings.push(`${slug}/${locale}: body is the English one`);
    const codeBlocks = page.body.filter((block) => block.kind === 'code').map((block) => block.text);
    const englishCode = english.body.filter((block) => block.kind === 'code').map((block) => block.text);
    // Commands must survive translation untouched. A translated flag is a broken instruction.
    for (const [index, block] of codeBlocks.entries()) {
      const source = englishCode[index];
      if (source === undefined) continue;
      const strip = (text) => text.replace(/#.*$/gmu, '').replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim();
      if (strip(block) !== strip(source)) {
        findings.push(`${slug}/${locale}: a command differs from the English original`);
      }
    }
  }
}

// 4. The notice exists in every locale, and the non-English ones are not the English string.
for (const locale of LOCALES) {
  const chrome = docsChrome[locale];
  if (!chrome) { findings.push(`${locale}: no portal chrome`); continue; }
  for (const key of ['englishOnly', 'englishBody', 'heading', 'contents', 'search', 'previous', 'next']) {
    if (!chrome[key]) findings.push(`${locale}: portal chrome is missing "${key}"`);
  }
  if (locale !== 'en' && chrome.englishOnly === docsChrome.en.englishOnly) {
    findings.push(`${locale}: the language notice is still the English string`);
  }
}

// 5. Every untranslated page in a translated locale must be reachable and flagged; every translated
// one must not be flagged. This is the assertion that catches the notice drifting out of step.
for (const locale of TRANSLATED_LOCALES) {
  const contents = docsIndexFor(locale);
  if (contents.length !== DOCS_PAGES.length) findings.push(`${locale}: contents list is incomplete`);
  const translated = contents.filter((entry) => entry.translated).map((entry) => entry.slug).sort();
  const expected = [...CRITICAL_SLUGS].sort();
  if (JSON.stringify(translated) !== JSON.stringify(expected)) {
    findings.push(`${locale}: translated set is ${translated.join(',')}, expected ${expected.join(',')}`);
  }
}

// 6. The ACME walkthrough states the figures the product actually produces, in every language.
//
// Nothing here is written down twice. The catalogue counts come from the dataset generator that feeds
// the shipped sample files; the rule's scope and its recycled-content minimum are read out of the API
// source that seeds the demonstration rule; the outcome split is computed from those two, and is then
// checked against the frozen constant the installer's own seeding test asserts against a real run. A
// figure on the page that no longer matches any of them fails here rather than on someone's screen.

const RULE_SOURCE = 'apps/api/src/app.mjs';
const SEED_TEST = 'scripts/installer/seed-demonstration.test.mjs';
const apiSource = readFileSync(RULE_SOURCE, 'utf8');
const scopeMatch = /packagingTypes:\[([^\]]*)\]/u.exec(apiSource);
const thresholdMatch = /id:'minimum-recycled-content',input:'recycledContentPct',operator:'gte',value:(\d+)/u.exec(apiSource);
if (!scopeMatch || !thresholdMatch) findings.push(`could not read the demonstration rule from ${RULE_SOURCE}`);

const ruleTypes = (scopeMatch?.[1] ?? '').split(',').map((entry) => entry.trim().replace(/^'|'$/gu, '')).filter(Boolean);
const ruleMinimum = Number(thresholdMatch?.[1] ?? NaN);

// The rule the product runs, restated over the generator's records. UNKNOWN is a record in scope whose
// required input is absent; FAIL is one below the minimum; NOT_APPLICABLE is a packaging type the rule
// does not cover, which is why that number does not move when in-scope records are added.
function outcomesOver(records) {
  const inScope = records.filter((record) => ruleTypes.includes(record.packagingType));
  const unknown = inScope.filter((record) => record.recycledContentPct === null || record.recycledContentPct === undefined);
  const failed = inScope.filter((record) => typeof record.recycledContentPct === 'number' && record.recycledContentPct < ruleMinimum);
  return {
    requirements: inScope.length,
    initial: [inScope.length - unknown.length - failed.length, failed.length, unknown.length, records.length - inScope.length],
    remediated: [inScope.length, 0, 0, records.length - inScope.length],
    blocking: [...failed, ...unknown].map((record) => record.id).sort(),
    lowest: failed.map((record) => record.recycledContentPct).sort((a, b) => a - b)[0],
  };
}

const catalog = createAcmeCatalog();
const seededRecords = createAcmeValidJsonImport().packaging;
const seeded = outcomesOver(seededRecords);
const complete = outcomesOver(catalog.packaging);
const supplementalRows = createAcmeSupplementalCsv().split('\n').filter((line) => line && !line.startsWith('#')).length - 1;
const invalidRows = createAcmeInvalidImport().packaging.length;

// The installer asserts the seeded outcome against a real run of the real product. If that constant and
// the computation above ever disagree, one of them is lying and the page cannot be trusted either way.
const frozen = /EXPECTED_OUTCOMES = Object\.freeze\(\{ PASS: (\d+), FAIL: (\d+), UNKNOWN: (\d+), NOT_APPLICABLE: (\d+) \}\)/u.exec(readFileSync(SEED_TEST, 'utf8'));
if (!frozen) findings.push(`could not read the seeded outcome constant from ${SEED_TEST}`);
else if (frozen.slice(1, 5).map(Number).join(',') !== seeded.initial.join(',')) {
  findings.push(`${SEED_TEST} asserts ${frozen.slice(1, 5).join('/')} for the seeded demonstration; the dataset and the rule produce ${seeded.initial.join('/')}`);
}

// Every outcome split the page prints, in the order it prints them. The seeded state is quoted twice —
// once where it is introduced and once under the expected result — so the page cannot describe the
// seeded deployment in one section and the full catalogue in another without saying which is which.
const OUTCOME_SEQUENCE = [seeded.initial, seeded.initial, seeded.remediated, complete.initial, complete.remediated];
const OUTCOME_PATTERN = /(\d+) PASS, (\d+) FAIL, (\d+) UNKNOWN (?:and|i|und) (\d+) NOT APPLICABLE/gu;

// Each claim is a figure the reader acts on, pinned to the sentence that carries it. A rewrite that
// drops the sentence fails as loudly as a rewrite that changes the number, which is the point: the
// figures may not quietly leave the page either.
const FIGURE_CLAIMS = [
  {
    what: 'the catalogue a bootstrapped deployment starts with',
    expected: [seededRecords.length, catalog.materials.length, catalog.components.length, seededRecords.length, catalog.suppliers.length],
    en: /(\d+) packaging records, (\d+) materials, (\d+) components, (\d+) bills of material and (\d+) suppliers/u,
    pl: /(\d+) rekordów opakowań, (\d+) materiałów, (\d+) komponentów, (\d+) struktur BOM i (\d+) dostawców/u,
    de: /(\d+) Verpackungsdatensätze, (\d+) Materialien, (\d+) Komponenten, (\d+) Stücklisten und (\d+) Lieferanten/u,
  },
  {
    what: 'the complete portfolio and what the supplemental file adds',
    expected: [catalog.packaging.length, catalog.packaging.length, supplementalRows],
    en: /complete fictional portfolio is (\d+) packaging records and (\d+) bills of material\. The remaining (\d+) records/u,
    pl: /Pełne fikcyjne portfolio liczy (\d+) rekordy opakowań i (\d+) struktury BOM\. Pozostałe (\d+) rekordy/u,
    de: /vollständige fiktive Portfolio umfasst (\d+) Verpackungsdatensätze und (\d+) Stücklisten\. Die übrigen (\d+) Datensätze/u,
  },
  {
    what: 'the evidence the seeding accepted, and the requirements it answered',
    expected: [catalog.suppliers.length, seeded.requirements, seededRecords.length],
    en: /(\d+) of them, against the (\d+) evidence requirements the rule derives from those (\d+) records/u,
    pl: /(\d+) sztuki, wobec (\d+) wymagań dowodowych, które reguła wyprowadza z tych (\d+) rekordów/u,
    de: /(\d+) Stück, gegenüber den (\d+) Nachweisanforderungen, die die Regel aus diesen (\d+) Datensätzen ableitet/u,
  },
  {
    what: 'the declared recycled content that fails, and the minimum it fails against',
    expected: [seeded.lowest, ruleMinimum],
    en: /declares (\d+)% recycled content against the rule minimum of (\d+)%/u,
    pl: /deklaruje (\d+)% zawartości z recyklingu wobec minimum reguły wynoszącego (\d+)%/u,
    de: /weist (\d+)% Rezyklatanteil gegenüber dem Regelminimum von (\d+)% aus/u,
  },
  {
    what: 'the rows the invalid sample rejects',
    expected: [invalidRows],
    en: /All (\d+) rows are rejected/u,
    pl: /Wszystkie (\d+) wierszy zostaje odrzuconych/u,
    de: /Alle (\d+) Zeilen werden abgelehnt/u,
  },
  {
    what: 'what the supplemental import merges into a populated catalogue',
    expected: [supplementalRows, catalog.packaging.length, catalog.packaging.length, complete.requirements - seeded.requirements],
    en: /Its (\d+) rows merge into the populated catalogue, taking it to (\d+) packaging records and (\d+) bills of material, and (\d+) further evidence requirements/u,
    pl: /Jego (\d+) wiersze scalają się z zapełnionym katalogiem, doprowadzając go do (\d+) rekordów opakowań i (\d+) struktur BOM, a reguła wyprowadza (\d+) kolejne wymagania dowodowe/u,
    de: /Seine (\d+) Zeilen fügen sich in den gefüllten Katalog ein und bringen ihn auf (\d+) Verpackungsdatensätze und (\d+) Stücklisten; (\d+) weitere Nachweisanforderungen/u,
  },
  {
    what: 'which catalogue each expected result belongs to',
    expected: [seededRecords.length, catalog.packaging.length],
    en: /On the (\d+) records bootstrap-acme leaves behind[\s\S]*?complete (\d+)-record catalogue/u,
    pl: /Na (\d+) rekordach pozostawionych przez bootstrap-acme[\s\S]*?pełnym katalogu (\d+) rekordów/u,
    de: /Auf den (\d+) Datensätzen, die bootstrap-acme hinterlässt[\s\S]*?vollständigen Katalog aus (\d+) Datensätzen/u,
  },
];

// Not a figure, but the statement a reader loses money on if it is wrong: reset empties the
// environment, and nothing puts the seeded demonstration back, because bootstrap cannot run twice.
const RESET_CLAIM = {
  what: 'that reset empties the environment and nothing re-seeds it',
  en: /Reset empties the environment\.[\s\S]*?nothing re-seeds it afterwards/u,
  pl: /Reset opróżnia środowisko\.[\s\S]*?nic go później nie zasiewa ponownie/u,
  de: /Zurücksetzen leert die Umgebung\.[\s\S]*?nichts befüllt sie danach erneut/u,
};

for (const locale of LOCALES) {
  const page = docsPage('acme-walkthrough', locale);
  if (!page) { findings.push(`acme-walkthrough/${locale}: page missing`); continue; }
  const text = page.body
    .map((block) => (block.kind === 'ul' ? block.items.join('\n') : block.text))
    .join('\n');

  const printed = [...text.matchAll(OUTCOME_PATTERN)].map((match) => match.slice(1, 5).map(Number));
  if (JSON.stringify(printed) !== JSON.stringify(OUTCOME_SEQUENCE)) {
    findings.push(`acme-walkthrough/${locale}: assessment outcomes read ${printed.map((row) => row.join('/')).join(' then ') || '(none)'}; the dataset and the rule produce ${OUTCOME_SEQUENCE.map((row) => row.join('/')).join(' then ')}`);
  }

  for (const claim of FIGURE_CLAIMS) {
    const match = claim[locale].exec(text);
    if (!match) { findings.push(`acme-walkthrough/${locale}: no longer states ${claim.what}`); continue; }
    const stated = match.slice(1).map(Number);
    if (stated.join(',') !== claim.expected.join(',')) {
      findings.push(`acme-walkthrough/${locale}: states ${stated.join('/')} for ${claim.what}; the product produces ${claim.expected.join('/')}`);
    }
  }

  for (const id of seeded.blocking) {
    if (!text.includes(id)) findings.push(`acme-walkthrough/${locale}: does not name ${id}, one of the records the seeded assessment leaves open`);
  }

  if (!RESET_CLAIM[locale].test(text)) findings.push(`acme-walkthrough/${locale}: no longer states ${RESET_CLAIM.what}`);
}

if (findings.length) {
  console.error(`DOCS_LANGUAGE_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`DOCS_LANGUAGE_PASS areas=${DOCS_PAGES.length} translated=${CRITICAL_SLUGS.length} locales=${LOCALES.join(',')} acme_figures=${(FIGURE_CLAIMS.length + 1) * LOCALES.length + LOCALES.length} seeded=${seeded.initial.join('/')} complete=${complete.initial.join('/')}`);
}
