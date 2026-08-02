// Enforces the professional-language rules in docs/website/PROFESSIONAL_LANGUAGE_STYLE_GUIDE.md
// against the shipped copy model. Deliberately narrow: it flags patterns that are wrong in
// published business copy, not every informal-looking word, so it stays trustworthy.
import { commonCopy, pageCopy } from '../../apps/web/src/site-content.js';
import { DEPLOYMENT_PROVIDERS, downloadCopy, pageSections } from '../../apps/web/src/site-sections.js';
import { catalogs } from '../../apps/web/src/i18n.js';
import { communityCopy, demoCopy, statusCopy, surfaceCommon } from '../../apps/web/src/surface-content.js';

const failures = [];
const fail = (where, rule, detail) => failures.push(`${where}: ${rule}${detail ? ` — ${detail}` : ''}`);

// Every copy model that reaches a rendered page. `surface-content.js` was missing and was checked by
// nothing at all, which is how the demonstration and status pages came to describe one particular
// deployment — behind a named edge provider, reachable by arrangement — to every operator who
// installs the software.
const MODELS = (locale) => [
  [`common.${locale}`, commonCopy[locale]],
  [`pages.${locale}`, pageCopy[locale]],
  [`sections.${locale}`, pageSections[locale]],
  [`downloads.${locale}`, downloadCopy[locale]],
  [`app.${locale}`, catalogs[locale]],
  [`surface.common.${locale}`, surfaceCommon[locale]],
  [`surface.demo.${locale}`, demoCopy[locale]],
  [`surface.status.${locale}`, statusCopy[locale]],
  [`surface.community.${locale}`, communityCopy[locale]],
];

// Collect every user-visible string, with a label describing where it came from.
function collect() {
  const strings = [];
  const walk = (value, where) => {
    if (typeof value === 'string') { strings.push({ where, text: value }); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${where}[${index}]`)); return; }
    if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`); }
  };
  for (const locale of ['en', 'pl', 'de']) for (const [where, model] of MODELS(locale)) walk(model, where);
  return strings;
}

// A reader does not read a heading apart from its bullets, so the deployment rules below are applied
// to whole sections rather than to individual strings: a list may name Cloudflare in one item and say
// which deployment it means in another, and that is a correct disclosure, not an evasion.
function collectUnits() {
  const units = [];
  const walk = (value, where) => {
    if (typeof value === 'string') { units.push({ where, text: value }); return; }
    if (Array.isArray(value)) {
      // A `{h, p}` / `{h, items}` section, or a `[label, detail]` pair: one statement, read together.
      const section = value.every((item) => typeof item === 'string');
      if (section) { units.push({ where, text: value.join(' ') }); return; }
      value.forEach((item, index) => walk(item, `${where}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      if (typeof value.h === 'string') {
        units.push({ where, text: `${value.h} ${value.p || ''} ${(value.items || []).join(' ')}` });
        return;
      }
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
    }
  };
  for (const locale of ['en', 'pl', 'de']) for (const [where, model] of MODELS(locale)) walk(model, where);
  return units;
}

const strings = collect();
const localeOf = (where) => where.split('.')[1];

// Polish colloquial connectors and informal register. Word-boundary matched, so they cannot
// fire inside longer legitimate words.
const POLISH_COLLOQUIAL = [
  { pattern: /\bbo\b/iu, hint: 'use "ponieważ" / "z uwagi na"' },
  { pattern: /\bpo prostu\b/iu, hint: 'remove, or state the mechanism' },
  { pattern: /\btak naprawdę\b/iu, hint: 'remove' },
  { pattern: /\bfajn[ay]\w*\b/iu, hint: 'use a factual quality statement' },
  { pattern: /\bogarnia\w*\b/iu, hint: 'use "obsługuje" / "zapewnia"' },
  { pattern: /\błatwy w użyciu\b/iu, hint: 'state what it does instead' },
  { pattern: /\bsuper\b/iu, hint: 'remove' },
];

// Informal second-person address in German must never appear in business copy.
const GERMAN_INFORMAL = [
  { pattern: /\bdu\b/u, hint: 'use the formal "Sie"' },
  { pattern: /\bdein(e|en|em|er|es)?\b/iu, hint: 'use "Ihr" / "Ihre"' },
  { pattern: /\beuch\b/iu, hint: 'use "Ihnen"' },
];

// Claims that are not supported by evidence and are forbidden by the owner decisions.
const UNSUPPORTED_CLAIMS = [
  { pattern: /\bzgodny z PPWR\b/iu, hint: 'use "wspiera proces oceny zgodności"' },
  { pattern: /\bgwarantuje zgodność\b/iu, hint: 'compliance may never be guaranteed' },
  { pattern: /\bcertyfikowan\w*\b/iu, hint: 'no certification exists' },
  { pattern: /\b100% (?:bezpieczn\w*|secure)\b/iu, hint: 'absolute security claims are forbidden' },
  { pattern: /\bguarantees compliance\b/iu, hint: 'compliance may never be guaranteed' },
  { pattern: /\bfully compliant\b/iu, hint: 'use "supports compliance processes"' },
  { pattern: /\bISO ?27001\b/iu, hint: 'no certification exists' },
  { pattern: /\bgarantiert (?:die )?Konformität\b/iu, hint: 'compliance may never be guaranteed' },
  { pattern: /\bzertifiziert\b/iu, hint: 'no certification exists' },
];

// Statements about what a regulation requires, in any of the three languages.
//
// The project already decided this rule twice — Stage 3 withheld two German statements about the state of
// the legislation, and a later decision withdrew their English and Polish twins — and both times it was
// enforced by someone reading the copy. Two statements asserting what Regulation (EU) 2025/40 *requires*
// survived both passes and reached 1.0 live in all three locales, which is what an unenforced rule looks
// like from the outside.
//
// Nobody here is a qualified regulatory reviewer, so no sentence in shipped copy may put a regulation in
// the subject position of a requiring verb — including the negative form, because "the regulation does not
// require X" is still a reading of the regulation and a reader may act on it.
//
// Enumerated rather than generalised, deliberately. A rule matching "requirement" or "Anforderung" near
// "PPWR" would flag the product's own honest disclaimers — "OpenPPWR does not certify or guarantee legal
// compliance with PPWR or any other regulation" — and a gate that cries wolf on the sentences we most want
// to keep is a gate people learn to bypass. These patterns match the named actor plus the verb, nothing
// else. The negation escape used by `UNSUPPORTED_CLAIMS` deliberately does **not** apply here: there, a
// negated claim is the wording we want; here, the negated form is exactly the defect.
const REGULATORY_ASSERTIONS = [
  { pattern: /\b(?:PPWR|Regulation \(EU\) 2025\/40)\b[^.!?]{0,40}?\b(?:does not |doesn't |do not )?\brequires?\b/iu, hint: 'say what OpenPPWR does or does not need; a claim about the regulation needs a qualified reviewer' },
  { pattern: /\b(?:PPWR|rozporządzenie \(UE\) 2025\/40)\b[^.!?]{0,40}?\b(?:nie )?wymaga\w*\b/iu, hint: 'napisz, czego wymaga OpenPPWR; twierdzenie o rozporządzeniu wymaga wykwalifikowanego recenzenta' },
  { pattern: /\b(?:PPWR|Verordnung \(EU\) 2025\/40)\b[^.!?]{0,40}?\b(?:verlangt|fordert|verlangen|fordern)\b/iu, hint: 'sagen Sie, was OpenPPWR benötigt; eine Aussage über die Verordnung braucht eine qualifizierte Prüfung' },
];

// Statements that are true of one deployment and false on every other one.
//
// The shipped bundle is installed by operators we will never meet. A sentence naming the hosting
// provider, the edge access layer or the access arrangement describes Attentus's own deployment; the
// same sentence rendered on someone else's server is a false statement, and in the privacy and cookie
// notices it is a false statement about who processes their users' data.
//
// The rule is not "never mention a provider" — the owner approved that disclosure and a privacy
// notice that hid its subprocessors would be worse. The rule is that the section must name the
// deployment it is describing, so the sentence stays true wherever it is read.
//
// The provider names themselves are imported rather than written here: the public-export validator
// refuses to let most files name them, and a gate that had to be exempted in order to police the rule
// would be its own counter-example.
const DEPLOYMENT_CLAIMS = [
  { pattern: new RegExp(`\\b(?:${DEPLOYMENT_PROVIDERS.map((name) => name.replaceAll(' ', '[ -]?')).join('|')})\\b`, 'iu'), hint: 'name the deployment: a provider or edge posture is a fact about one installation' },
  { pattern: /\brelease candidate\b|\bkandydat\w* wydania\b|\brelease-kandidat\b/iu, hint: 'read the release channel from /v1/version instead of writing it into copy' },
  { pattern: /\bby arrangement\b|\bpo uzgodnieniu\b|\bnach Absprache\b/iu, hint: 'who may reach a deployment is decided by its operator, not by this bundle' },
];
// The escape hatch, and the only one: a unit that says which deployment it is about.
const NAMES_DEPLOYMENT = /openppwr\.eu/iu;

for (const { where, text } of collectUnits()) {
  if (NAMES_DEPLOYMENT.test(text)) continue;
  for (const rule of DEPLOYMENT_CLAIMS) {
    if (rule.pattern.test(text)) fail(where, `deployment-specific claim ${rule.pattern}`, rule.hint);
  }
}

// Polish direct address must use the respectful capitalized forms in published copy.
// A trailing \b would be wrong here: JavaScript's \b is ASCII-only, so it treats "ci" inside
// "ciągu" as a complete word and reports a false positive. The right-hand boundary is therefore
// stated explicitly and includes the Latin-Extended ranges carrying Polish diacritics.
const POLISH_LOWERCASE_ADDRESS = /(?:^|[\s(„"'-])(ty|ci|cię|ciebie|tobie|twój|twoja|twoje|twojego|twojej|twoim|twoich)(?![\wÀ-ɏ])/u;

// A disclaimer that denies certification is the wording we want, not a violation. Flagging
// "it does not certify compliance" would train people to ignore this gate, so negated forms are
// recognised explicitly rather than suppressed by hand.
// Negation may precede or follow the claim depending on the language — German in particular puts
// it after ("zertifiziert oder garantiert keine Rechtskonformität") — so the whole sentence is
// examined rather than a fixed direction.
const NEGATION = /\b(?:nie|keine[rnms]?|kein|nicht|no|never|not|without|ohne|bez)\b/iu;
const CLAIM_WORD = /\b(?:certyfikuje|certyfikowan\w*|zertifiziert|certified|certification|gwarantuje|garantiert|guarantees?|compliant)\b/iu;
const isNegatedClaim = (text) => text
  .split(/(?<=[.!?])\s+/u)
  .some((sentence) => CLAIM_WORD.test(sentence) && NEGATION.test(sentence));

for (const { where, text } of strings) {
  const locale = localeOf(where);
  for (const rule of UNSUPPORTED_CLAIMS) {
    if (rule.pattern.test(text) && !isNegatedClaim(text)) fail(where, 'unsupported claim', rule.hint);
  }
  for (const rule of REGULATORY_ASSERTIONS) {
    if (rule.pattern.test(text)) fail(where, 'statement about what a regulation requires', rule.hint);
  }
  if (locale === 'pl') {
    for (const rule of POLISH_COLLOQUIAL) {
      if (rule.pattern.test(text)) fail(where, `colloquial Polish ${rule.pattern}`, rule.hint);
    }
    const match = POLISH_LOWERCASE_ADDRESS.exec(text);
    if (match) fail(where, 'lowercase Polish direct address', `"${match[1]}" must be capitalized`);
  }
  if (locale === 'de') {
    for (const rule of GERMAN_INFORMAL) {
      if (rule.pattern.test(text)) fail(where, `informal German ${rule.pattern}`, rule.hint);
    }
  }
}

if (failures.length) { console.error(`COPY_STYLE_FAIL findings=${failures.length}\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log(`COPY_STYLE_PASS strings=${strings.length} units=${collectUnits().length} locales=en,pl,de rules=${UNSUPPORTED_CLAIMS.length + POLISH_COLLOQUIAL.length + GERMAN_INFORMAL.length + DEPLOYMENT_CLAIMS.length + REGULATORY_ASSERTIONS.length + 1}`);
