// The evidence collections were rendered whole.
//
// `GET /v1/evidence` and `GET /v1/evidence-requirements` returned every row with no `LIMIT` until
// 2026-08-01, and the workbench asked for them with no parameters: a tenant with ten thousand evidence
// files received ten thousand rows and rendered ten thousand table rows, and the requirement `<select>`
// was filled from the same unbounded answer. `/v1/catalog/:resource` and `/v1/gaps` had been paginated
// on both sides since the catalog defect; these two were missed.
//
// The selector is the reason this file exists separately from `paging.test.mjs`. A table may hold a page
// and state that more rows exist, because the reader can see what it holds. A dropdown may not: the
// option the user needs is either in it or, as far as the screen says, does not exist. So the two
// controls are paginated on deliberately different terms, and this asserts both.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appendPage, pagePath, PAGE_SIZE, SELECT_PAGE_SIZE } from '../src/paging.js';

register('./jsx-loader.mjs', import.meta.url);
const { RequirementsFooter, withCurrency } = await import('../src/App.jsx');
const { SUPPORTED_LOCALES, translate } = await import('../src/i18n.js');

const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../../api/src/app.mjs', import.meta.url), 'utf8');
const render = (props) => renderToStaticMarkup(createElement(RequirementsFooter, { t: (key) => key, busy: false, onMore: () => {}, ...props }));

test('the selector asks for the largest page the API will actually serve', () => {
  // Not a number chosen here. `parsePagination` in the API refuses a `limit` above its maximum with a
  // 400 rather than clamping it — deliberately, so a caller who asked for 5 000 and received 500 cannot
  // read that as "there are only 500" — which means a client that guesses high does not get a big page,
  // it gets a refusal and an empty dropdown.
  const declared = /export const PAGE_LIMIT_MAX = (\d+);/u.exec(apiSource);
  assert.ok(declared, 'PAGE_LIMIT_MAX is no longer exported from the API; the selector page size now rests on nothing');
  assert.equal(SELECT_PAGE_SIZE, Number(declared[1]));
  assert.equal(pagePath('/v1/evidence-requirements', { limit: SELECT_PAGE_SIZE }), '/v1/evidence-requirements?limit=500&offset=0');
  // The table keeps the ordinary page size: the trade-off that justifies a larger page for a chooser
  // does not apply to rows the reader can count.
  assert.equal(SELECT_PAGE_SIZE > PAGE_SIZE, true);
  assert.equal(pagePath('/v1/evidence'), '/v1/evidence?limit=100&offset=0');
});

test('a requirement list that stops short says so, and offers the rest', () => {
  // The defect this prevents is silence. A dropdown holding 500 of 900 requirements, with nothing on
  // screen to say so, tells the user their requirement does not exist.
  const truncated = render({ hasMore: true });
  assert.match(truncated, /data-testid="requirements-truncated"/u);
  assert.match(truncated, /requirementsTruncated/u);
  assert.match(truncated, /data-testid="requirements-load-more"/u, 'the statement without a remedy is only half an answer');
  assert.match(truncated, /role="status"/u, 'a screen reader is told too');
});

test('a complete requirement list is not decorated with a warning it has not earned', () => {
  // Every deployment this product has been run against fits in one page, and on those the interface must
  // say nothing at all — a permanent notice about truncation that never applies is noise, and noise is
  // what makes a real notice unreadable.
  assert.equal(render({ hasMore: false }), '');
  assert.equal(render({}), '');
});

test('the truncation is stated in every supported language', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ['requirementsTruncated', 'loadMoreRequirements']) {
      const text = translate(locale, key);
      assert.notEqual(text, key, `${locale} has no ${key} and would render the key`);
      assert.ok(text.trim().length > 0);
    }
  }
  // An identical Polish or German string is an untranslated fallback, which is the mixed-language defect
  // rather than a translation of it.
  for (const locale of ['pl', 'de']) {
    for (const key of ['requirementsTruncated', 'loadMoreRequirements']) {
      assert.notEqual(translate(locale, key), translate('en', key), `${locale}:${key}`);
    }
  }
});

test('currency is re-derived across pages, not decided once per page', () => {
  // Version 2 of a requirement arrives on the second page. Marking currency per page would leave version
  // 1 badged "current" on screen beside the version that superseded it — and the accept and reject
  // controls are rendered from that badge, so a reviewer would be invited to accept a superseded file.
  const first = withCurrency([
    { id: 'a', requirement_id: 'REQ-1', version: 1 },
    { id: 'b', requirement_id: 'REQ-2', version: 1 },
  ]);
  assert.deepEqual(first.map((row) => row.currency), ['current', 'current']);
  const second = withCurrency(appendPage(first, [{ id: 'c', requirement_id: 'REQ-1', version: 2 }]));
  assert.deepEqual(second.map((row) => `${row.id}:${row.currency}`), ['a:superseded', 'b:current', 'c:current']);
  // The rows already held are not mutated by the recompute, so a failed page cannot corrupt the table.
  assert.equal(first[0].currency, 'current');
  assert.deepEqual(withCurrency(null), []);
});

test('no paginated collection is still requested as a whole', () => {
  // The class, not the instance. Both defects here were one missing `pagePath(...)` at a call site, and
  // a route paginated on the server while the client asks for everything is a client that receives page
  // one and calls it the collection.
  // A call with a path and no options object is a GET, which is what a listing is. `POST /v1/evidence`
  // is the upload and passes a body, so it is not one of these and must not be counted as one.
  const bare = [...source.matchAll(/api\('(\/v1\/[^']+)'\s*\)/gu)].map((match) => match[1]);
  assert.ok(bare.length > 0, 'the call sites could not be read from App.jsx, so this proved nothing');
  for (const path of ['/v1/evidence', '/v1/evidence-requirements', '/v1/gaps']) {
    assert.equal(bare.includes(path), false, `${path} is paginated by the server and requested unpaginated`);
  }
  // And each of the four paginated collections reads `hasMore` rather than discarding it, which is what
  // the gaps table did for as long as `/v1/gaps` had been reporting it.
  for (const state of ['setCatalogMore', 'setGapsMore', 'setRequirementsMore', 'setEvidenceMore']) {
    assert.match(source, new RegExp(`${state}\\(Boolean\\(result\\.hasMore\\)\\)`, 'u'), `${state} is not fed from the server's own answer`);
  }
});
