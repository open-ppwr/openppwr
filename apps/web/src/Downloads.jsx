// The sample import files, rendered wherever a reader actually needs them.
//
// The list existed and the files were served, and on a multi-host deployment no reachable page offered
// them. `Site.jsx` rendered it on exactly two marketing routes — `demo` and `docs` — and those are
// exactly the two routes `CROSS_HOST` in `surfaces.mjs` redirects off the marketing host, so
// `openppwr.eu/en/demo` answered `301 https://demo.openppwr.eu/en` and the demonstration surface
// rendered no downloads at all. A first-time evaluator following the ACME walkthrough ("import the
// valid dataset, then import the invalid one") arrived at an empty payload box with the import button
// disabled and nothing anywhere to fill it with.
//
// The fix is not another page. It is this block, rendered at the two places the need arises: the
// demonstration surface, which is where the redirect lands, and the workbench import step, which is
// where the reader is looking at the empty box.
//
// The list itself is not restated here. `downloadsFor` in `site-sections.js` is the single declaration
// of which files exist and what each is called in each locale, so a file added there appears on every
// surface at once and cannot appear on one and not another.

import { downloadsFor } from './site-sections.js';

// Root-relative, deliberately. Every surface is served out of the same static tree by
// `apps/web/server.mjs`, so `/downloads/{file}` resolves on whichever host the reader is standing on —
// marketing, demonstration, documentation or workbench — and is identical in both deployment shapes.
// This is the one class of link that must *not* go through `localeHref`: an absolute
// `https://<host>/downloads/...` would name a hostname a single-domain operator does not have, and a
// locale segment would name a path that does not exist.
export function downloadHref(file) {
  return `/downloads/${file}`;
}

// `variant="inline"` is the form used inside a step that already owns the page's heading level and its
// spacing: an h3 rather than an h2, and the tighter panel styling the workbench uses for its own lists.
export function SampleDownloads({ locale, variant = 'page' }) {
  const { copy, items } = downloadsFor(locale);
  const inline = variant === 'inline';
  const Heading = inline ? 'h3' : 'h2';
  return <section className={inline ? 'downloads downloads-inline' : 'downloads'} data-testid="downloads" data-variant={variant}>
    <Heading>{copy.heading}</Heading>
    <p>{inline ? copy.inlineIntro : copy.intro}</p>
    <ul>{items.map((item) => <li key={item.file}>
      <a href={downloadHref(item.file)} download>{copy[item.key]}</a>
      <code>{item.file}</code>
    </li>)}</ul>
  </section>;
}
