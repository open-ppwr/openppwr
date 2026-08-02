// The sample import files, and the pages that offer them.
//
// The defect these cover: on a deployment with the production host map, no reachable page offered the
// sample files at all. `Site.jsx` rendered the list on exactly two marketing routes, `demo` and `docs`,
// and `CROSS_HOST` in `surfaces.mjs` sends exactly those two routes off the marketing host — so
// `openppwr.eu/en/demo` answered `301 https://demo.openppwr.eu/en`, and `DemoSurface` rendered no
// downloads. Step 01 of the workbench cannot be completed without a file, and the ACME walkthrough
// tells a first-time evaluator to import one.
//
// Nothing caught it because every part in isolation was correct: the files were generated, served, and
// translated, and the redirect went where it was supposed to. What was missing was any check that the
// page carrying the links and the page a reader lands on are the same page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.mjs', import.meta.url);
const { DemoSurface } = await import('../src/Surfaces.jsx');
const { Site } = await import('../src/Site.jsx');
const { SampleDownloads, downloadHref } = await import('../src/Downloads.jsx');
const { acmeDownloads, downloadCopy, downloadsFor } = await import('../src/site-sections.js');

const LOCALES = ['en', 'pl', 'de'];
const hrefs = (markup) => [...markup.matchAll(/href="([^"]*\/downloads\/[^"]*)"/gu)].map((match) => match[1]);

// The two components a reader actually arrives at, one per deployment shape. On a mapped deployment
// `/{locale}/demo` is a redirect to the demonstration host, whose page is `DemoSurface`; with no host
// map the same address renders `Site` at route `demo`.
const DEMO_ENTRY = {
  'multi-host': (locale) => createElement(DemoSurface, { locale }),
  'single-host': (locale) => createElement(Site, { locale, route: 'demo' }),
};

test('the demonstration entry point offers every sample file in both deployment shapes', () => {
  for (const [shape, build] of Object.entries(DEMO_ENTRY)) {
    for (const locale of LOCALES) {
      const markup = renderToStaticMarkup(build(locale));
      const offered = hrefs(markup);
      for (const item of acmeDownloads) {
        assert.ok(offered.includes(`/downloads/${item.file}`), `${shape}/${locale} offers ${item.file}`);
      }
      // The label a reader clicks, not just the address. A list of eight identical filenames would
      // satisfy the check above and tell nobody which file is the valid one.
      const copy = downloadCopy[locale];
      assert.ok(markup.includes(copy.validCsv), `${shape}/${locale} names the valid CSV in its own language`);
      assert.ok(markup.includes(copy.invalidCsv), `${shape}/${locale} names the invalid CSV in its own language`);
    }
  }
});

test('the workbench import step offers the files, where the payload box is empty', async () => {
  // Rendered directly: the workbench itself needs a document, and what is under test is the block the
  // import step renders, in the form it renders it.
  for (const locale of LOCALES) {
    const markup = renderToStaticMarkup(createElement(SampleDownloads, { locale, variant: 'inline' }));
    for (const item of acmeDownloads) assert.ok(hrefs(markup).includes(`/downloads/${item.file}`), `${locale} inline offers ${item.file}`);
    assert.ok(markup.includes(downloadCopy[locale].inlineIntro), `${locale} tells the reader to paste the contents into the payload box`);
    // The step already owns an h2 through SectionHead, so a second one here would break the outline.
    assert.match(markup, /<h3>/u, `${locale} inline uses a subordinate heading`);
    assert.ok(!/<h2>/u.test(markup), `${locale} inline does not repeat the step's heading level`);
  }
  // Placement is the whole point, and it cannot be rendered here: a block correct in isolation but
  // attached to the catalog step would leave step 01 exactly as unusable as it was.
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const step = /<section id="import">([\s\S]*?)<\/section>/u.exec(source);
  assert.ok(step, 'the import step is readable');
  assert.match(step[1], /<SampleDownloads\b/u, 'the import step renders the sample files');
  assert.match(step[1], /data-testid="import-payload"/u, 'and it is the step holding the payload box');
});

test('a sample link resolves on every host and in both deployment shapes', () => {
  // Root-relative, always. Every surface is served out of the same static tree, so this one form is
  // correct on the marketing, demonstration, documentation and workbench hosts and on the single
  // domain a self-hosted deployment runs. An absolute link would name a host that operator does not
  // have; a localized one would name a path that does not exist.
  for (const item of acmeDownloads) {
    assert.equal(downloadHref(item.file), `/downloads/${item.file}`);
  }
  for (const [shape, build] of Object.entries(DEMO_ENTRY)) {
    for (const locale of LOCALES) {
      for (const href of hrefs(renderToStaticMarkup(build(locale)))) {
        assert.match(href, /^\/downloads\/[A-Za-z0-9._-]+$/u, `${shape}/${locale}: ${href} is a bare path`);
      }
    }
  }
});

test('every file offered is one the exporter actually writes', async () => {
  // The list of links and the generator that produces the files live in different trees, so a label
  // for a file nobody generates is a link to a 404 that no rendering test can see.
  const exporter = await readFile(new URL('../../../scripts/acme/acme-dataset.mjs', import.meta.url), 'utf8');
  const produced = new Set([...exporter.matchAll(/'([A-Za-z0-9._-]+\.(?:json|csv|md))'/gu)].map((match) => match[1]));
  assert.ok(produced.size >= acmeDownloads.length, `the exporter parse found ${produced.size} filenames`);
  for (const item of acmeDownloads) assert.ok(produced.has(item.file), `${item.file} is produced by scripts/acme/acme-dataset.mjs`);
});

test('every offered file is named in all three locales', () => {
  // Neither the i18n gate nor the copy-style gate requires a label to exist: one covers the workbench
  // catalog and the page sections, the other checks the wording of strings that are already there.
  // A file added with an English label only would have shipped a half-translated list.
  for (const locale of LOCALES) {
    const { copy, items } = downloadsFor(locale);
    assert.equal(items, acmeDownloads, `${locale} offers the one canonical list`);
    for (const key of ['heading', 'intro', 'inlineIntro', ...acmeDownloads.map((item) => item.key)]) {
      assert.ok(copy[key], `${locale} has a label for ${key}`);
    }
    if (locale === 'en') continue;
    assert.notEqual(copy.inlineIntro, downloadCopy.en.inlineIntro, `${locale} translates the import-step wording`);
    assert.notEqual(copy.heading, downloadCopy.en.heading, `${locale} translates the heading`);
  }
});
