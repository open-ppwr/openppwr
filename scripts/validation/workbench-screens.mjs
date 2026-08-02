// What a populated workbench screen must show, asserted from the rendered DOM.
//
// The 26-stage gate verified API status codes and content-model completeness, and the one browser journey
// walked a single golden path. Nothing rendered a screen a human would reach next, and the catalog table
// — step 02 of the reference workflow — had never been rendered by any automated run in any locale. That
// is precisely why a Polish and a German catalog shipped English column headers and raw database enum
// values: every gate that could have seen it was looking at JSON.
//
// These assertions are deliberately written against what a *reader* would notice, not against what the
// component happens to call its helpers:
//
//   * a header must be the label of this locale, and must not be the English one unless English and this
//     locale genuinely share that string (`SHARED_WITH_ENGLISH`, which is checked for staleness by
//     `workbench-screens.test.mjs` rather than trusted);
//   * a closed-enum cell must be a localized badge, and must never be the value as the database stores it;
//   * a table that holds fewer rows than exist must say so and offer the rest;
//   * a disabled control must carry a reason, and the reason must be a string of this locale's catalog.
//
// The English-leak check is the load-bearing one. `translate()` falls back to the English catalog when a
// key is missing from a locale, so a missing Polish translation does not throw and does not render a key
// — it renders English, silently, and an assertion that only compares the DOM against `translate(locale, …)`
// agrees with it. Comparing against the *English* rendering is what makes that visible.

import assert from 'node:assert/strict';
import { catalogs, columnLabel, enumLabel, errorMessageKey, translate } from '../../apps/web/src/i18n.js';
import { countLine } from '../../apps/web/src/paging.js';

// The columns each table is required to show, restated here rather than imported from `App.jsx`.
// Importing them would make this file agree with the component by construction: a column silently
// dropped from the catalog table would change both sides at once and assert nothing.
export const CATALOG_RESOURCES = Object.freeze(['packaging', 'materials', 'components', 'boms', 'suppliers']);
export const CATALOG_COLUMNS = Object.freeze({
  packaging: ['id', 'name', 'packaging_type', 'country', 'supplier_id', 'status'],
  materials: ['id', 'name', 'family', 'recycled_content_pct'],
  components: ['id', 'name', 'material_id', 'supplier_id', 'mass_g'],
  boms: ['id', 'packaging_id', 'version', 'status'],
  suppliers: ['id', 'name', 'status'],
});
export const EVIDENCE_COLUMNS = Object.freeze(['supplier_id', 'evidence_type', 'version', 'currency', 'scan_status', 'review_status']);
export const GAP_COLUMNS = Object.freeze(['packaging_id', 'deduplication_key', 'status', 'owner_id']);
export const SCAN_JOB_COLUMNS = Object.freeze(['evidence_id', 'status', 'attempts', 'last_error_code']);

// Every value the schema's CHECK constraints permit in a column whose contents are a closed set
// (packages/database/migrations/001_phase4_foundation.sql), plus the client-derived `currency`. These are
// the strings that must never reach a screen: they are how the database spells the value, not how a
// compliance officer reads it. `status` is one union across the five tables that use the name, which is
// weaker than one set per table and enough for the property being asserted.
export const ENUM_VALUES = Object.freeze({
  packaging_type: Object.freeze(['sales', 'grouped', 'transport', 'ecommerce', 'reusable']),
  status: Object.freeze(['active', 'inactive', 'draft', 'approved', 'superseded', 'open', 'assigned',
    'remediated', 'closed', 'reopened', 'pending', 'running', 'completed', 'failed', 'dead']),
  scan_status: Object.freeze(['pending', 'clean', 'infected', 'error', 'timeout']),
  review_status: Object.freeze(['pending', 'accepted', 'rejected']),
  currency: Object.freeze(['current', 'superseded']),
});

// The screen a tenant sees *before* it has any data, and the reason none of these six had ever been
// rendered by an automated run: every journey in this repository imports the ACME fixture in its first
// step, so by the time any assertion looks at a panel the panel is populated. The empty state is not a
// corner case — it is what every operator of a fresh installation sees on their first day, in all three
// languages, and it is the only screen that tells them which step produces the missing records.
//
// `selector` is what the same panel shows when it *does* hold data. Asserting its absence is what
// distinguishes "the empty state is displayed" from "the empty state is in the DOM behind a table".
//
// `operation` is the catalog key the activity panel labels the load with, and it is how this file waits.
// Waiting on the empty state itself would turn the defect `DataTable` was written to fix — a load that
// finds nothing and renders *nothing at all* — into a twenty-second timeout with no message. Waiting on
// the panel instead means that defect reaches an assertion that can name it.
export const EMPTY_STATES = Object.freeze([
  Object.freeze({ name: 'catalog', testid: 'catalog-empty', key: 'emptyCatalog', operation: 'packaging', selector: '#catalog table' }),
  Object.freeze({ name: 'requirements', testid: 'requirements-empty', key: 'emptyRequirements', operation: 'loadRequirements', selector: '#evidence [data-testid="requirement"] option' }),
  Object.freeze({ name: 'evidence', testid: 'evidence-empty', key: 'emptyEvidence', operation: 'refreshEvidence', selector: '#evidence table' }),
  Object.freeze({ name: 'gaps', testid: 'gaps-empty', key: 'emptyGaps', operation: 'loadGaps', selector: '#gaps table' }),
  Object.freeze({ name: 'artifacts', testid: 'artifacts-empty', key: 'emptyArtifacts', operation: 'loadDossiers', selector: '#dossier .artifact-list' }),
  Object.freeze({ name: 'scanJobs', testid: 'scan-jobs-empty', key: 'emptyScanJobs', operation: 'loadScanJobs', selector: '#scan-queue table' }),
]);

// The refusals this suite provokes for real and then reads back off the screen. A failed operation was
// only ever asserted through its JSON payload, which is written by the server and is the same bytes in
// every locale — so nothing had established that a Polish or German reader is told what went wrong in
// their own language. Both codes below are reached by pressing an *enabled* control in the ordinary
// order of the workflow, which is how a user reaches them; `operation` is the label the activity panel
// gives that control, and is how the wait is pinned to the attempt just made.
//
// `key` is written out rather than obtained from `errorMessageKey(code, status)`. That distinction is the
// whole point and it was learned the hard way: deriving the expectation from the product's own mapping
// made this check agree with itself, and deleting `GAP_OWNER_INVALID` from that mapping — which puts the
// generic "check the values you entered" sentence in front of a user whose owner identifier was the
// problem — passed a full three-locale run. It is the same self-agreement as comparing a rendered string
// with `translate(locale, …)`, one level further up. Stated here, the mapping is something this file
// checks instead of something it inherits.
export const REFUSALS = Object.freeze([
  Object.freeze({ code: 'GAP_OWNER_INVALID', status: 422, key: 'errGapOwnerInvalid', operation: 'assign' }),
  Object.freeze({ code: 'READY_FOR_REVIEW_BLOCKED', status: 409, key: 'errReviewBlocked', operation: 'freeze' }),
]);

// Every catalog key these assertions read from a rendered screen. The unit test recomputes
// `SHARED_WITH_ENGLISH` from exactly this set, so the allowlist cannot rot in either direction.
export function checkedKeys() {
  const keys = new Set(['actions', 'catalogShowing', 'rowsShowing', 'moreRows', 'loadMore', ...CATALOG_RESOURCES]);
  const columns = [...Object.values(CATALOG_COLUMNS).flat(), ...EVIDENCE_COLUMNS, ...GAP_COLUMNS, ...SCAN_JOB_COLUMNS];
  for (const column of columns) keys.add(`col_${column}`);
  for (const values of Object.values(ENUM_VALUES)) for (const value of values) keys.add(`val_${value}`);
  for (const state of EMPTY_STATES) keys.add(state.key);
  for (const refusal of REFUSALS) keys.add(refusal.key);
  return keys;
}

// The labels a locale shares with English *on purpose*. "Status" is the same word in all three; German
// keeps "Version" and "Material". Everything else that reads identically to English is a missing
// translation being served by the fallback, which is the defect this file exists to catch.
export const SHARED_WITH_ENGLISH = Object.freeze({
  en: new Set(),
  pl: new Set(['col_status']),
  de: new Set(['col_status', 'col_version', 'col_material_id']),
});

// The text is this locale's, and it is English only where English is this locale's answer too.
export function assertLocaleOwnsText({ locale, key, text, where }) {
  assert.equal(text, translate(locale, key),
    `${where}: expected the ${locale} label for "${key}", found "${text}"`);
  if (locale === 'en') return;
  const english = catalogs.en[key];
  if (english === undefined) return;
  const identical = text === english;
  const shared = SHARED_WITH_ENGLISH[locale].has(key);
  if (identical && !shared) {
    assert.fail(`${where}: the English text "${english}" is on a ${locale} screen. Either "${key}" has no ${locale} translation and the fallback is serving English, or the interface stopped localizing this position.`);
  }
  if (!identical && shared) {
    assert.fail(`${where}: "${key}" is listed in SHARED_WITH_ENGLISH.${locale}, but "${text}" no longer equals the English "${english}". The translation changed — remove the entry.`);
  }
}

function assertHeader({ locale, column, text, where }) {
  const key = `col_${column}`;
  // `columnLabel` falls back to the database column name with the underscores taken out, which is how
  // "packaging type", "recycled content pct" and "mass g" reached users in all three locales.
  assert.notEqual(translate(locale, key), key,
    `${where}: no label exists for the database column "${column}" in any locale, so the header falls back to the raw column name`);
  assert.notEqual(text, column, `${where}: the raw database column name "${column}" is the header`);
  assert.notEqual(text, column.replaceAll('_', ' '), `${where}: the header is the raw database column name with its underscores removed`);
  assert.equal(text, columnLabel(locale, column), `${where}: the header is not the ${locale} label for "${column}"`);
  assertLocaleOwnsText({ locale, key, text, where: `${where} header` });
}

function assertEnumCell({ locale, column, cell, where }) {
  const values = ENUM_VALUES[column];
  assert.ok(cell.badge,
    `${where}: "${column}" holds a closed set of database values and must render a localized badge; this cell rendered "${cell.text}" outside one`);
  if (values.includes(cell.text)) {
    assert.fail(`${where}: the raw database value "${cell.text}" is shown to the user instead of its ${locale} label "${enumLabel(locale, cell.text)}"`);
  }
  const value = values.find((candidate) => enumLabel(locale, candidate) === cell.text);
  if (value === undefined) {
    const asEnglish = values.find((candidate) => enumLabel('en', candidate) === cell.text);
    assert.fail(asEnglish
      ? `${where}: the English label "${cell.text}" for "${asEnglish}" is on a ${locale} screen`
      : `${where}: "${cell.text}" is not the ${locale} label of any value "${column}" can hold`);
  }
  assertLocaleOwnsText({ locale, key: `val_${value}`, text: cell.text, where });
}

// Reads a rendered table. `DataTable` carries no test id of its own, so the section it belongs to is the
// handle — which is also what a user navigates by.
export async function readTable(page, section) {
  const table = page.locator(`#${section} table`);
  await table.waitFor({ state: 'visible', timeout: 20000 });
  return table.evaluate((node) => ({
    headers: [...node.querySelectorAll('thead th')].map((cell) => cell.textContent.trim()),
    rows: [...node.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => ({
      text: cell.textContent.trim(),
      badge: Boolean(cell.querySelector('span.badge')),
      code: Boolean(cell.querySelector('code')),
    }))),
  }));
}

// The table has settled on the shape this step expects. Waiting on the shape rather than on the header
// text matters: a locale defect must reach an assertion with a message, not expire as a timeout.
export function waitForTableShape(page, section, columns, rows) {
  return page.waitForFunction(([id, headerCount, rowCount]) => {
    const table = document.querySelector(`#${id} table`);
    if (!table) return false;
    return table.querySelectorAll('thead th').length === headerCount
      && table.querySelectorAll('tbody tr').length === rowCount;
  }, [section, columns.length + 1, rows], { timeout: 20000 });
}

// The activity panel has reported *this* operation, and it returned no records. Both halves matter: the
// label pins the wait to the load just requested rather than to whatever the panel still shows from the
// previous one, and `"items": []` is the answer every listing route gives when a tenant holds nothing.
export function waitForEmptyResult(page, locale, operationKey) {
  return page.waitForFunction(([label]) => {
    const panel = document.querySelector('.activity');
    const heading = panel?.querySelector('strong');
    const payload = panel?.querySelector('[data-testid="activity"]');
    return Boolean(heading && heading.textContent.trim() === label && payload && payload.textContent.includes('"items": []'));
  }, [translate(locale, operationKey)], { timeout: 20000 });
}

export async function assertTable({ page, locale, section, columns, where, expectedRows = null }) {
  const snapshot = await readTable(page, section);
  assert.equal(snapshot.headers.length, columns.length + 1,
    `${where}: expected ${columns.length} data columns and an actions column, found ${snapshot.headers.length} headers`);
  columns.forEach((column, index) => assertHeader({ locale, column, text: snapshot.headers[index], where: `${where} column ${index + 1}` }));
  assertLocaleOwnsText({ locale, key: 'actions', text: snapshot.headers.at(-1), where: `${where} actions header` });
  assert.ok(snapshot.rows.length > 0, `${where}: a populated step must actually render rows`);
  snapshot.rows.forEach((cells, rowIndex) => {
    assert.equal(cells.length, columns.length + 1, `${where} row ${rowIndex + 1}: expected ${columns.length + 1} cells, found ${cells.length}`);
    columns.forEach((column, index) => {
      const at = `${where} row ${rowIndex + 1} column "${column}"`;
      const cell = cells[index];
      if (ENUM_VALUES[column]) { assertEnumCell({ locale, column, cell, where: at }); return; }
      assert.ok(cell.text.length > 0, `${at}: the cell is empty; an absent value is stated as "—"`);
      if (expectedRows) {
        assert.equal(cell.text, String(expectedRows[rowIndex][column] ?? '—'),
          `${at}: the table does not show the stored value`);
      }
    });
  });
  return snapshot;
}

// What the table can account for, stated under it. A table holding 100 of 112 rows and saying nothing is
// not a shorter answer than the catalog — it is a wrong one, and the summary tile above it already showed
// the number that contradicted it.
export async function assertCountLine({ page, locale, name, shown, total, hasMore, where }) {
  const text = (await page.getByTestId(`${name}-count`).textContent()).trim();
  assert.equal(text, countLine(locale, { shown, total, hasMore }), `${where}: the count line does not state what the table holds`);
  if (locale !== 'en') {
    assert.notEqual(text, countLine('en', { shown, total, hasMore }), `${where}: the English count line "${text}" is on a ${locale} screen`);
  }
  const more = page.getByTestId(`${name}-load-more`);
  if (!hasMore) {
    assert.equal(await more.count(), 0, `${where}: nothing remains beyond the rows shown, so no "load more" control belongs here`);
    assert.ok(!text.includes(translate(locale, 'moreRows')), `${where}: a complete table must not claim that further records exist`);
    return;
  }
  assert.ok(text.includes(translate(locale, 'moreRows')), `${where}: a truncated table must state that it is truncated — "${text}"`);
  assert.equal(await more.count(), 1, `${where}: a truncated table must offer a way to reach the rest`);
  assert.equal(await more.isDisabled(), false, `${where}: the control that reaches the remaining rows is disabled`);
  assertLocaleOwnsText({ locale, key: 'loadMore', text: (await more.textContent()).trim(), where: `${where} load-more control` });
}

// Whether a piece of user-visible text came from this locale's catalog, allowing for the one kind of
// interpolation the catalog performs. A reason assembled ad hoc — or served by the English fallback —
// is not a value of `catalogs[locale]` and fails here.
export function isCatalogString(locale, text) {
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return Object.values(catalogs[locale]).some((value) => {
    if (typeof value !== 'string') return false;
    if (value === text) return true;
    if (!value.includes('{')) return false;
    return new RegExp(`^${value.split(/\{[a-zA-Z]+\}/u).map(escape).join('(.+)')}$`, 'u').test(text);
  });
}

// A greyed-out control with no reason is indistinguishable from a broken one. The product owner reported
// "Generate dossier" as broken while signed in as a role that holds `dossier:generate`: the button was
// waiting on the freeze in step 06 and said nothing. This asserts the outcome — a reason exists, it is
// attached to the control the way assistive technology reads it, and it is written in the user's language
// — without assuming the markup that provides it.
export async function assertDisabledControlExplained({ page, locale, testid, where }) {
  const control = page.getByTestId(testid);
  assert.equal(await control.count(), 1, `${where}: "${testid}" is not on the screen`);
  assert.equal(await control.isDisabled(), true, `${where}: "${testid}" is expected to be disabled for this role`);
  const found = await control.evaluate((element) => {
    const describedBy = element.getAttribute('aria-describedby');
    const described = describedBy ? element.ownerDocument.getElementById(describedBy) : null;
    const nearby = element.parentElement?.querySelector('.lock-reason, [data-lock-reason]');
    return {
      title: (element.getAttribute('title') || '').trim(),
      described: described ? described.textContent.trim() : '',
      nearby: nearby ? nearby.textContent.trim() : '',
      onScreen: Boolean((described && described.getClientRects().length) || (nearby && nearby.getClientRects().length)),
    };
  });
  const reason = found.described || found.nearby || found.title;
  assert.ok(reason.length > 0,
    `${where}: "${testid}" is disabled and states no reason. A disabled control must say why — by aria-describedby, by adjacent text, or at minimum by title — or the user cannot tell it from a broken one.`);
  assert.ok(reason.includes(' '),
    `${where}: the reason on "${testid}" is "${reason}", which is an identifier rather than a sentence a user can read`);
  assert.ok(isCatalogString(locale, reason),
    `${where}: the reason on "${testid}" — "${reason}" — is not a string of the ${locale} catalog, so it is either untranslated or assembled outside the catalog`);
  return { testid, reason, onScreen: found.onScreen, describedBy: Boolean(found.described) };
}

// A load that found nothing is a result, and it has to be stated. `DataTable` distinguishes "no load has
// been attempted" (`null`) from "loaded, and there is nothing" (`[]`) precisely so that this sentence can
// be shown — and the sentence is the only thing on the screen that names the step which produces the
// missing records. It has to be readable in the reader's language, it has to be announced, and the panel
// must not be showing data at the same time.
export async function assertEmptyState({ page, locale, testid, key, operation, selector, where }) {
  // The load has finished and it found nothing. Established before anything is looked for, so that a
  // panel which renders nothing fails on the assertion below rather than expiring as a timeout.
  if (operation) await waitForEmptyResult(page, locale, operation);
  const element = page.getByTestId(testid);
  assert.equal(await element.count(), 1,
    `${where}: the load returned no records and the interface stated nothing. "No records" is a result and has to be said, or it is indistinguishable from a load that silently failed.`);
  assert.equal(await element.isVisible(), true, `${where}: the empty state is in the document but not on the screen`);
  assert.equal(await page.locator(selector).count(), 0,
    `${where}: the empty state is on the screen while "${selector}" is still showing data, so the panel is stating two different things at once`);
  // `role="status"` is how a screen reader learns that pressing the button produced an answer. Without
  // it the load is silent: the visible table simply never appears and nothing is announced.
  assert.equal(await element.getAttribute('role'), 'status',
    `${where}: the empty state is not announced (role="status"), so a screen reader user is told nothing when the load returns no records`);
  const text = (await element.textContent()).trim();
  assert.ok(text.length > 0, `${where}: the empty state is rendered with no text in it`);
  assertLocaleOwnsText({ locale, key, text, where });
  return text;
}

// What the user is told when the server refuses. The payload is the same bytes in every language, so an
// assertion that reads the payload proves nothing about the reader; this reads the message the interface
// puts in front of them, and compares it to English rather than to `translate(locale, …)` — which would
// agree with a missing translation, because the fallback degrades the DOM and the expectation together.
//
// The refusal is also confirmed to be the one this step provoked. Otherwise any failure at all —
// including a network fault or an unrelated 500 — would satisfy "an error message is displayed".
export async function assertRefusalExplained({ page, locale, code, status, key, operation, where }) {
  // Waited for here rather than by the caller, and on the *panel* rather than on the code inside it.
  // Waiting for the expected code to appear would make every assertion below unreachable: a refusal that
  // reported the wrong code, or none, would expire as a timeout instead of being named. The label pins
  // the wait to the operation just attempted, so the previous step's refusal cannot satisfy it.
  await page.waitForFunction(([label]) => {
    const panel = document.querySelector('.activity');
    if (!panel?.classList.contains('error')) return false;
    const heading = panel.querySelector('strong');
    return Boolean(heading && heading.textContent.trim() === label);
  }, [translate(locale, operation)], { timeout: 20000 });
  const payload = JSON.parse(await page.getByTestId('activity').textContent());
  assert.equal(payload?.error?.code, code,
    `${where}: expected the interface to have provoked ${code}; the operation reported "${payload?.error?.code}" instead, so this step is not exercising the refusal it claims to`);
  const message = page.getByTestId('activity-message');
  // Counted, not waited for. The caller has already waited for this refusal to reach the activity panel,
  // so a message that is simply absent — the state before the refusal was explained at all, when the raw
  // payload behind a collapsed disclosure was the whole user experience — fails here with a sentence.
  assert.equal(await message.count(), 1,
    `${where}: the operation was refused (${code}) and the interface put no explanation in front of the user; the payload behind the technical-details disclosure is not an explanation`);
  assert.equal(await message.isVisible(), true, `${where}: the refusal is explained in the document but not on the screen`);
  // The sentence this refusal is supposed to carry, checked against the mapping rather than taken from
  // it. Folding a named failure back into a status-code default is not a translation defect and would
  // never fail a locale check: the user is simply told something true about a different problem.
  assert.equal(errorMessageKey(code, status), key,
    `${where}: ${code} is no longer explained with "${key}" but with "${errorMessageKey(code, status)}", so the user is given a sentence written for a different failure`);
  const text = (await message.textContent()).trim();
  assertLocaleOwnsText({ locale, key, text, where: `${where} refusal message` });
  return { code, key, text };
}

// A narrowed screen is proved by what it does *not* hold.
//
// `supplier_user` is the only role in this product whose view is a subset rather than a set of buttons,
// and it had never rendered a screen in any browser test. "The screen rendered" is not the property that
// matters: a screen showing every supplier's evidence renders perfectly well. Three things are asserted,
// and the middle one is what keeps this check honest — if the fixture happens to contain nothing outside
// the role's scope, a component that withheld nothing would pass, so that case fails loudly instead.
export function assertNarrowedView({ shown, permitted, all, label, where }) {
  const allowed = new Set(permitted);
  const outside = [...new Set(shown)].filter((value) => !allowed.has(value));
  assert.deepEqual(outside, [],
    `${where}: the ${label} screen of this role shows ${outside.length} record(s) outside its scope: ${outside.join(', ')}`);
  const withheld = [...new Set(all)].filter((value) => !allowed.has(value));
  assert.ok(withheld.length > 0,
    `${where}: every ${label} record in this tenant is inside this role's scope, so a screen that withheld nothing would pass this check. The narrowing is not under test.`);
  assert.ok(shown.length > 0,
    `${where}: the ${label} screen shows nothing at all, so "it withheld the other suppliers' records" is indistinguishable from "it failed to load"`);
  return { shown: shown.length, withheld: withheld.length };
}
