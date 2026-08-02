// Every disabled control in the workbench says why it is disabled.
//
// The defect these cover was found twice on a live deployment by the product owner. The workbench
// rendered twenty-seven `disabled=` expressions and one explanation, and that explanation covered only
// "not signed in" — so a greyed-out control could not be told apart from a broken one. Signed in as a
// compliance manager, a role that does hold `dossier:generate`, the owner found "Generate dossier" grey
// and reported it as broken; it was waiting for the freeze in step 06, and nothing on the screen said so.
//
// The first test is the one that stops it returning: it reads every component this application ships
// and fails on any `disabled=` that is not `Locked`'s own, so a control cannot be added in a disabled
// state without an explanation attached to it.
//
// It is derived twice over — the file list comes from the directory and the one file permitted to
// disable anything is identified by defining the mechanism, not by being named here. Both matter. A
// list of controls kept by hand is what a new control gets left off; a list of *files* kept by hand is
// what a new component gets left off, and that is not hypothetical: the first version of this guard
// read `App.jsx` alone, and `AppNav.jsx` held the one control in the product still disabled with no
// reason — invisible to the very test written to forbid it.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.mjs', import.meta.url);
const { CommunityWorkbench } = await import('../src/App.jsx');
const { AppNav } = await import('../src/AppNav.jsx');
const { Locked, lockMessage, lockOf } = await import('../src/Locked.jsx');
const { catalogs, describeError, SUPPORTED_LOCALES, translate } = await import('../src/i18n.js');
const { permissionLabel } = await import('../src/RoleMatrix.jsx');
const { PERMISSION_CATALOGUE } = await import('../../api/src/permissions.mjs');

// Prose is removed before any check looks at a file: several comments describe this defect and quote
// `disabled=` while doing so. Line comments go first, because one of them contains the path
// `/v1/catalog/*` — removing block comments ahead of it treats that as an opening delimiter and swallows
// ninety lines of the interface, including four gated controls. That is exactly the kind of silently
// shrinking parse the floors below exist to catch.
const strip = (text) => text.replace(/^\s*\/\/.*$/gmu, '').replace(/\/\*[\s\S]*?\*\//gu, '');
const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const sources = new Map();
for (const name of (await readdir(sourceDir)).filter((entry) => entry.endsWith('.jsx')).sort()) {
  sources.set(name, strip(await readFile(sourceDir + name, 'utf8')));
}
// The module that declares the mechanism, found by declaring it. Naming it here would make this guard
// depend on a file name, and renaming that file would quietly turn the guard off.
const mechanism = [...sources].filter(([, text]) => /export function Locked\b/u.test(text)).map(([name]) => name);
const code = sources.get('App.jsx');
// An element's attribute list, stopping at the tag's own `>` rather than at the one inside an arrow
// function — several controls pass `onClick={()=>…}`.
const elements = (text, tag) => [...text.matchAll(new RegExp(`<${tag}\\b(?:=>|[^>])*?>`, 'gu'))].map((match) => match[0]);

test('no control this application ships can be disabled without stating why', () => {
  // The directory has to have been read, or every check below passes by finding nothing.
  assert.ok(sources.size >= 6, `only ${sources.size} components were read out of src/`);
  assert.deepEqual(mechanism, ['Locked.jsx'], 'exactly one module declares the mechanism');

  // One `disabled=` in the whole application, and it belongs to the component that also renders the
  // reason. A control added anywhere with its own `disabled=` expression fails here, which is the point.
  for (const [name, text] of sources) {
    const raw = [...text.matchAll(/disabled=/gu)].length;
    const permitted = name === mechanism[0] ? 1 : 0;
    assert.equal(raw, permitted, `${name}: controls must be disabled only through Locked; found ${raw} disabled= expression(s), expected ${permitted}`);
  }

  const declaration = sources.get(mechanism[0]);
  assert.match(declaration, /<button data-testid=\{id\}[^>]*disabled=\{Boolean\(reason\)\}/u, "Locked's button is disabled by the presence of a reason and by nothing else");
  // Visible beside the control, in the accessible description, and in the tooltip. A disabled button
  // dispatches no mouse events in some browsers, so `title` alone would not be an explanation.
  assert.match(declaration, /title=\{reason\|\|undefined\}/u);
  assert.match(declaration, /aria-describedby=\{reason\?hintId:undefined\}/u);
  assert.match(declaration, /<span className="lock-reason" id=\{hintId\}/u);

  // The counts above also pass on an application that disables nothing at all, so the mechanism has to
  // be shown to be in use — in both files that hold workflow controls, not only the larger one — and
  // every use of it has to carry both the lock and the identity that binds the reason to the control.
  const gated = [...sources].flatMap(([name, text]) => elements(text, 'Locked').map((element) => [name, element]));
  assert.ok(gated.length >= 26, `only ${gated.length} controls render through Locked; the application has at least 26`);
  for (const file of ['App.jsx', 'AppNav.jsx']) {
    assert.ok(gated.some(([name]) => name === file), `${file} renders no control through the mechanism`);
  }
  for (const [name, element] of gated) {
    assert.match(element, /\sid=/u, `${name}: a gated control declares no id: ${element.slice(0, 90)}`);
    assert.match(element, /\slock=\{/u, `${name}: a gated control declares no lock: ${element.slice(0, 90)}`);
  }
});

test('a locked control carries its reason where a reader and a screen reader can both find it', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key) => translate(locale, key);
    const locked = renderToStaticMarkup(createElement(Locked, {
      t, id: 'generate', lock: lockOf({ precondition: 'lockNeedsSnapshot' }), children: 'Generate',
    }));
    const reason = translate(locale, 'lockNeedsSnapshot');
    assert.match(locked, /<button[^>]*\sdisabled=""/u, `${locale}: the control is disabled`);
    assert.ok(locked.includes(reason), `${locale}: the reason is rendered beside the control`);
    assert.ok(locked.includes('id="generate-lock"'), `${locale}: the reason is addressable`);
    assert.ok(locked.includes('aria-describedby="generate-lock"'), `${locale}: the control points at it`);
    assert.ok(locked.includes(`title="${reason}"`), `${locale}: and states it as a tooltip too`);

    // An available control claims nothing. A permanent `aria-describedby` would have a screen reader
    // announce a lock reason for a button that is not locked.
    const open = renderToStaticMarkup(createElement(Locked, { t, id: 'generate', lock: null, children: 'Generate' }));
    assert.ok(!open.includes('disabled'), `${locale}: an available control is not disabled`);
    assert.ok(!open.includes('aria-describedby'), `${locale}: and describes no reason`);
    assert.ok(!open.includes('title='), `${locale}: and shows no tooltip`);
  }
});

test('the most useful reason wins, and step 06 is the case that decides it', () => {
  // Signed out first: `can()` reads the identity's permissions, so before anyone signs in every
  // permission test is false. Were permission to outrank this, a visitor would be told their role
  // lacks thirteen permissions when they have no role at all.
  assert.deepEqual(lockOf({ signedOut: true, permission: 'Generate dossier', precondition: 'lockNeedsSnapshot', busy: true }), { key: 'lockSignedOut' });

  // The first incident exactly: a compliance manager holds `dossier:generate`, so the reason is the
  // missing snapshot and it names the control that produces one.
  const manager = lockOf({ signedOut: false, permission: null, precondition: 'lockNeedsSnapshot', busy: false });
  assert.deepEqual(manager, { key: 'lockNeedsSnapshot' });
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(lockMessage((key) => translate(locale, key), manager), translate(locale, 'lockNeedsSnapshot'));
  }

  // And the case that settles the order between the two: a read-only auditor is missing the permission
  // *and* the snapshot. "Freeze a snapshot first" would send them to a second control they also may not
  // press, so the terminal reason outranks the actionable one.
  const auditor = lockOf({ permission: 'Generate dossier', precondition: 'lockNeedsSnapshot' });
  assert.deepEqual(auditor, { key: 'lockPermission', permission: 'Generate dossier' });
  assert.ok(lockMessage((key) => translate('en', key), auditor).includes('Generate dossier'));

  // Transient last, so a hint does not flicker between two truths while an operation runs.
  assert.deepEqual(lockOf({ precondition: 'lockNeedsNote', busy: true }), { key: 'lockNeedsNote' });
  assert.deepEqual(lockOf({ busy: true }), { key: 'lockBusy' });
  assert.equal(lockOf({}), null, 'a control with no condition is available and claims nothing');
  assert.equal(lockOf(), null);

  // The second incident. Pressing freeze with blocking gaps open answers 409, which used to reach the
  // user as the generic conflict sentence, naming neither the gaps nor the step that closes them.
  for (const locale of SUPPORTED_LOCALES) {
    const message = describeError(locale, { code: 'READY_FOR_REVIEW_BLOCKED', status: 409 });
    assert.equal(message, translate(locale, 'errReviewBlocked'), `${locale}: a blocked freeze is explained as blocked`);
    assert.notEqual(message, translate(locale, 'errConflict'), `${locale}: not as an unexplained conflict`);
    assert.equal(describeError(locale, { code: 'READY_FOR_REVIEW_INCOMPLETE', status: 409 }), translate(locale, 'errReviewIncomplete'));
  }
});

// Every disabled button in a rendered page, with the reason a reader sees and the reason assistive
// technology is pointed at — which must be the same one, and must be on the page at all.
function lockedButtons(markup, where) {
  const buttons = (markup.match(/<button\b[^>]*>/gu) || []).filter((tag) => tag.includes('disabled=""'));
  for (const tag of buttons) {
    const described = /aria-describedby="([^"]+)"/u.exec(tag);
    const title = /title="([^"]+)"/u.exec(tag);
    const which = /data-testid="([^"]+)"/u.exec(tag)?.[1] || tag;
    assert.ok(title?.[1], `${where}: ${which} is disabled and states no reason`);
    assert.ok(described?.[1], `${where}: ${which} is disabled and describes no reason`);
    const target = new RegExp(`id="${described[1]}"[^>]*>([^<]+)<`, 'u').exec(markup);
    assert.ok(target?.[1]?.trim(), `${where}: ${which} points at ${described[1]}, which is not on the page`);
    assert.equal(target[1], title[1], `${where}: ${which} shows one reason and announces another`);
  }
  return buttons;
}

test('the signed-out workbench explains every control it locks, in the reader language', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const markup = renderToStaticMarkup(createElement(CommunityWorkbench, { initialLocale: locale }));
    const buttons = lockedButtons(markup, locale);
    assert.ok(buttons.length >= 12, `${locale}: only ${buttons.length} controls are locked on the signed-out workbench`);
    // In this reader's language, not in English by default.
    assert.ok(markup.includes(translate(locale, 'lockSignedOut')), `${locale}: the locks are localized`);
    // And step 06 states the freeze precondition whether or not anything is disabled, because a
    // blocking gap is a refusal the client cannot predict.
    assert.ok(markup.includes(translate(locale, 'freezeBlockedNote')), `${locale}: the freeze precondition is stated`);
  }
});

test('the application header explains the control it locks too', () => {
  // The one the first guard could not see, because the first guard read one file. It locks only while
  // an operation runs, so the signed-in header mid-operation is the state that renders it.
  const identity = { role: 'compliance_manager', tenantId: 'acme', permissions: ['read'] };
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key) => translate(locale, key);
    const busy = renderToStaticMarkup(createElement(AppNav, { locale, identity, busy: true, onLocaleChange: () => {}, onSignOut: () => {} }));
    const buttons = lockedButtons(busy, `${locale}/nav`);
    assert.equal(buttons.length, 1, `${locale}: the header locks exactly the sign-out control while busy`);
    assert.match(buttons[0], /data-testid="nav-sign-out"/u);
    assert.ok(busy.includes(t('lockBusy')), `${locale}: and says an operation is running`);

    // And claims nothing once the operation finishes.
    const idle = renderToStaticMarkup(createElement(AppNav, { locale, identity, busy: false, onLocaleChange: () => {}, onSignOut: () => {} }));
    assert.equal(lockedButtons(idle, `${locale}/nav idle`).length, 0, `${locale}: nothing is locked when no operation is running`);
    assert.ok(!idle.includes('lock-reason'), `${locale}: and no reason is left on the page`);
  }
});

test('every reason the workbench can give is written in all three languages', () => {
  // Read out of the source, so a reason added in English only fails here rather than falling back to
  // English on a Polish screen. `translate` returns the key itself when nothing is written for it.
  const keys = new Set([...code.matchAll(/'(lock[A-Z]\w*)'/gu)].map((match) => match[1]));
  keys.add('lockPermission');
  keys.add('freezeBlockedNote');
  assert.ok(keys.size >= 12, `only ${keys.size} reason keys were read out of App.jsx`);
  for (const key of keys) {
    for (const locale of SUPPORTED_LOCALES) {
      const text = catalogs[locale][key];
      assert.ok(text && text !== key, `${locale}: no text for ${key}`);
      if (locale !== 'en') assert.notEqual(text, catalogs.en[key], `${locale}: ${key} is still the English sentence`);
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(catalogs[locale].lockPermission.includes('{permission}'), `${locale}: the permission reason names the permission`);
  }
});

test('a lock reason states a rule, never a record', () => {
  // The API answers 404 rather than 403 where a 403 would confirm that an object exists. A hint may
  // therefore say which permission is missing — `/v1/permissions` is unauthenticated and the role
  // matrix renders the whole registry to a reader who has not signed in — but it must not say anything
  // about a particular record. Every permission this file names is one of those published entries.
  const named = new Set([...code.matchAll(/needs\('([^']+)'\)/gu)].map((match) => match[1]));
  assert.ok(named.size >= 7, `only ${named.size} permissions were read out of App.jsx`);
  for (const permission of named) {
    assert.ok(Object.hasOwn(PERMISSION_CATALOGUE, permission), `${permission} is named to the user but is not in the published registry`);
  }
  // The only value ever interpolated is that permission's label, and it is the label the matrix itself
  // renders — not the raw registry identifier, which would be the one untranslated string on the page.
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key) => translate(locale, key);
    for (const permission of named) {
      const label = permissionLabel(locale, permission);
      assert.notEqual(label, permission, `${locale}: ${permission} reaches the user as its raw identifier`);
      assert.equal(lockMessage(t, lockOf({ permission: label })), translate(locale, 'lockPermission').replace('{permission}', label));
    }
    // Nothing else is substitutable: a reason is a catalog sentence, so no record identifier, filename
    // or count can be carried into one.
    for (const key of Object.keys(catalogs[locale]).filter((entry) => entry.startsWith('lock'))) {
      const placeholders = [...catalogs[locale][key].matchAll(/\{(\w+)\}/gu)].map((match) => match[1]);
      assert.deepEqual(placeholders.filter((name) => name !== 'permission'), [], `${locale}: ${key} interpolates something other than the permission`);
    }
  }
});
