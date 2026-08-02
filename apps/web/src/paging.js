import { translate } from './i18n.js';

// Listing pagination for the workbench, kept out of the component so the three decisions it makes are
// testable on their own: what a request asks for, what happens to the rows already on screen, and what
// the user is told about the difference between the two.
//
// The catalog table used to make none of them. `GET /v1/catalog/:resource` was called with no parameters,
// answered with a server-side `LIMIT 100` and an envelope carrying no `hasMore`, and the result was
// rendered under a summary tile stating the true total — so "Packaging 480" sat directly above a table of
// 100 rows, with nothing explaining the difference and no way to reach row 101. `GET /v1/gaps` had
// reported `hasMore` since pagination was added to it; this screen discarded it.

// One page. The API's own default, stated in the request rather than left to a truncation the client
// cannot observe.
export const PAGE_SIZE = 100;

// The page size for a control that is not a table: the evidence-requirement selector in step 03.
//
// A `<select>` is the one place the table pattern must not simply be copied. A table that holds 100 of
// 480 rows and says so is a shorter answer; a dropdown that holds 100 of 480 options is a *wrong* one,
// because the user's requirement is either in the list or, as far as the interface tells them, does not
// exist — they have no reason to suspect there is a page two, and the upload they need is unreachable
// with nothing on screen to explain why. Silent truncation is worse in a chooser than a long list is.
//
// So the selector asks for the largest page the API will serve — `PAGE_LIMIT_MAX` in
// `apps/api/src/app.mjs`, which refuses a larger `limit` with a 400 rather than clamping it — and when
// the server still reports `hasMore`, the interface says so under the control and offers to load the
// rest, which appends to the same list instead of replacing it. A deployment whose requirements fit in
// one page (every one this product has been run against, and the whole ACME demonstration) is unchanged;
// one that does not gets a statement and a control rather than a list that quietly stops.
//
// A search field would be the answer for a genuinely large collection, and is not built here: it needs a
// server-side filter this API does not have, and inventing a client-side one over a truncated list would
// search the part that was already visible.
export const SELECT_PAGE_SIZE = 500;

export function pagePath(path, { limit = PAGE_SIZE, offset = 0 } = {}) {
  return `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`;
}

// Rows already held, then the page just fetched. Held rows are never replaced, so `rows.length` remains
// both the offset of the next page and the number the count line reports.
export function appendPage(existing, items) {
  return [...(existing || []), ...(items || [])];
}

// What the table can account for, in the reader's language. A table holding 100 of 480 rows and saying
// nothing is not a shorter answer than the whole catalog — it is a wrong one.
//
// `total` is the count the catalog summary already returns. Where no total is known — gaps, whose route
// reports `hasMore` but no count — the line states what is shown and, when more remain, says so, rather
// than inventing a denominator.
export function countLine(locale, { shown, total, hasMore }) {
  const counted = Number.isFinite(total)
    ? translate(locale, 'catalogShowing').replace('{shown}', String(shown)).replace('{total}', String(total))
    : translate(locale, 'rowsShowing').replace('{shown}', String(shown));
  return hasMore ? `${counted} ${translate(locale, 'moreRows')}` : counted;
}
