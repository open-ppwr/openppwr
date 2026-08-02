// The workbench truncated at 100 rows and said nothing.
//
// `GET /v1/catalog/:resource` was called with no parameters, answered with a server-side `LIMIT 100` and
// an envelope carrying only `{items}`, and the result was rendered directly beneath a summary tile stating
// the true count — so a tenant with 480 packaging records read "Packaging 480" above a table of 100, with
// nothing explaining the difference and no request that could reach row 101. `GET /v1/gaps` had reported
// `hasMore` since pagination was added to it; the browser discarded the field.
//
// These three functions are what the table now uses: what a request asks for, what happens to the rows
// already on screen, and what the user is told about the gap between the two.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendPage, countLine, PAGE_SIZE, pagePath } from '../src/paging.js';

test('a listing request states the page it wants instead of accepting a silent truncation', () => {
  assert.equal(PAGE_SIZE, 100);
  assert.equal(pagePath('/v1/catalog/packaging'), '/v1/catalog/packaging?limit=100&offset=0');
  assert.equal(pagePath('/v1/gaps'), '/v1/gaps?limit=100&offset=0');
  // Row 101 — the row the hard cap made unreachable — is one ordinary request away.
  assert.equal(pagePath('/v1/catalog/packaging', { offset: 100 }), '/v1/catalog/packaging?limit=100&offset=100');
  assert.equal(pagePath('/v1/catalog/materials', { limit: 500, offset: 250 }), '/v1/catalog/materials?limit=500&offset=250');
  // An existing query string is extended, not corrupted into a second '?'.
  assert.equal(pagePath('/v1/gaps?status=open', { offset: 40 }), '/v1/gaps?status=open&limit=100&offset=40');
});

test('a fetched page is added to the rows already held, so the offset keeps counting up', () => {
  const first = appendPage(null, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(first.map((row) => row.id), ['a', 'b']);
  const second = appendPage(first, [{ id: 'c' }]);
  assert.deepEqual(second.map((row) => row.id), ['a', 'b', 'c']);
  // The next request must ask for offset 3, which is exactly the length of what is held.
  assert.equal(pagePath('/v1/catalog/packaging', { offset: second.length }), '/v1/catalog/packaging?limit=100&offset=3');
  // The held rows are not mutated, so a failed page cannot corrupt what the user is already looking at.
  assert.deepEqual(first.map((row) => row.id), ['a', 'b']);
  assert.deepEqual(appendPage(undefined, undefined), []);
  assert.deepEqual(appendPage([{ id: 'a' }], []).map((row) => row.id), ['a']);
});

test('the table states how much of the catalog it is showing, in the reader’s language', () => {
  // The exact case from the defect: the summary tile says 480, the table holds 100.
  assert.equal(countLine('en', { shown: 100, total: 480, hasMore: true }),
    'Showing 100 of 480 records. Further records exist beyond those shown.');
  assert.equal(countLine('pl', { shown: 100, total: 480, hasMore: true }),
    'Wyświetlono 100 z 480 rekordów. Poza wyświetlonymi istnieją kolejne rekordy.');
  assert.equal(countLine('de', { shown: 100, total: 480, hasMore: true }),
    'Angezeigt werden 100 von 480 Datensätzen. Über die angezeigten hinaus existieren weitere Datensätze.');
});

test('once every row is on screen the line stops claiming more exist', () => {
  assert.equal(countLine('en', { shown: 480, total: 480, hasMore: false }), 'Showing 480 of 480 records.');
  assert.equal(countLine('pl', { shown: 480, total: 480, hasMore: false }), 'Wyświetlono 480 z 480 rekordów.');
  assert.equal(countLine('de', { shown: 480, total: 480, hasMore: false }), 'Angezeigt werden 480 von 480 Datensätzen.');
});

test('with no known total the line reports what is shown rather than inventing a denominator', () => {
  // `/v1/gaps` reports hasMore but no count, so there is no honest "of N" to write.
  assert.equal(countLine('en', { shown: 100, hasMore: true }), 'Showing 100 records. Further records exist beyond those shown.');
  assert.equal(countLine('pl', { shown: 12, hasMore: false }), 'Wyświetlono 12 rekordów.');
  assert.equal(countLine('de', { shown: 12, total: undefined, hasMore: false }), 'Angezeigt werden 12 Datensätze.');
  for (const locale of ['en', 'pl', 'de']) {
    assert.equal(countLine(locale, { shown: 5, total: null, hasMore: false }).includes('null'), false);
    assert.equal(countLine(locale, { shown: 5, total: undefined, hasMore: false }).includes('undefined'), false);
    // No placeholder may survive into the rendered sentence.
    assert.equal(/\{(?:shown|total)\}/u.test(countLine(locale, { shown: 5, total: 9, hasMore: true })), false);
  }
});
