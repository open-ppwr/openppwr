// SPDX-License-Identifier: Apache-2.0
//
// Cross-host link and route gate.
//
// Stage 1 gave each hostname its own surface. That created a new way to be wrong: a link built for
// the wrong deployment shape, pointing at a hostname the reader does not have, or at a legacy
// unlocalized route that now redirects. Neither breaks a test that only renders one host.
//
// This checks the link *contracts* rather than the network: what `localeHref` produces in both
// deployment shapes, that no navigation entry points at a withheld route, and that nothing in the
// site content hard-codes a hostname or an unlocalized product path.
//
//   node scripts/validation/link-gate.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LEGAL_ROUTES, SITE_ROUTES } from '../../apps/web/src/site-content.js';
import { PRIVATE_ROUTES, pageSections } from '../../apps/web/src/site-sections.js';
import { hostFor, legacyRedirect, marketingRedirect, parseHostMap, runtimeConfig } from '../../apps/web/src/surfaces.mjs';
import { siteNavItems, SITE_NAV, surfaceLinkItems } from '../../apps/web/src/site-nav.js';

const LOCALES = ['pl', 'en', 'de'];
const findings = [];

const MAP = parseHostMap([
  'marketing:openppwr.eu', 'app:app.openppwr.eu', 'demo:demo.openppwr.eu', 'docs:docs.openppwr.eu',
  'api:api.openppwr.eu', 'status:status.openppwr.eu', 'community:community.openppwr.eu',
].join(','));

// 1. The canonical cross-host targets the owner specified, in every locale.
for (const locale of LOCALES) {
  const expected = {
    [`/${locale}/app`]: `https://app.openppwr.eu/${locale}/app`,
    [`/${locale}/demo`]: `https://demo.openppwr.eu/${locale}`,
    [`/${locale}/docs`]: `https://docs.openppwr.eu/${locale}`,
  };
  for (const [from, to] of Object.entries(expected)) {
    const actual = marketingRedirect(MAP, from);
    if (actual !== to) findings.push(`${from} redirects to ${actual}, expected ${to}`);
  }
}

// 2. Every surface the navigation offers has a host in the map.
for (const surface of ['marketing', 'app', 'demo', 'docs', 'status', 'community']) {
  if (!hostFor(MAP, surface)) findings.push(`no hostname configured for the ${surface} surface`);
}

// 3. Legacy unlocalized routes resolve, and resolve exactly once — a redirect whose target is itself
// a redirect is a chain, and a chain that loops is an outage.
for (const route of [...SITE_ROUTES, ...LEGAL_ROUTES]) {
  const target = legacyRedirect(MAP, `/${route}`);
  if (!target) { findings.push(`/${route} does not resolve to a canonical location`); continue; }
  if (target.startsWith('/')) {
    if (legacyRedirect(MAP, target)) findings.push(`/${route} redirects to ${target}, which redirects again`);
  } else if (!/^https:\/\/[a-z.]+openppwr\.eu\//u.test(target)) {
    findings.push(`/${route} redirects off the product domain: ${target}`);
  }
}

// 4. A withheld route must not be reachable from navigation. It stays addressable — someone may hold
// the link — but nothing on the site may send a new reader there.
for (const route of PRIVATE_ROUTES) {
  if (SITE_ROUTES.includes(route)) findings.push(`withheld route "${route}" is in the primary navigation list`);
  for (const locale of LOCALES) {
    for (const [page, sections] of Object.entries(pageSections[locale] || {})) {
      const text = (sections || []).map((section) => `${section.h} ${section.p || ''} ${(section.items || []).join(' ')}`).join(' ');
      if (new RegExp(`/${locale}/${route}\\b`, 'u').test(text)) {
        findings.push(`${locale}/${page}: links to the withheld route /${locale}/${route}`);
      }
    }
  }
}

// 5. No source file may hard-code a product hostname in a link. Those are what `localeHref` exists to
// build, and a hard-coded one is wrong on every single-domain self-hosted deployment.
const sources = ['Site.jsx', 'Surfaces.jsx', 'AppNav.jsx', 'DocsPortal.jsx', 'site-sections.js', 'site-content.js', 'site-nav.js'];
for (const name of sources) {
  const path = fileURLToPath(new URL(`../../apps/web/src/${name}`, import.meta.url));
  const content = await readFile(path, 'utf8');
  for (const [index, line] of content.split('\n').entries()) {
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
    const match = /href=\{?["'`]https:\/\/[a-z]+\.openppwr\.eu/u.exec(line);
    if (match) findings.push(`${name}:${index + 1}: hard-coded cross-host link — use localeHref`);
  }
}

// 6. The site-level navigation is rendered by more than one surface. It was private to the marketing
// header, so the workbench offered no route to the rest of the product at all; now that both headers
// read the same declaration, every entry has to resolve from either of them, in every locale, in both
// deployment shapes. An entry that lands on a redirect or on a bare path from the workbench host is
// the same defect in a new place.
const NAV_HOSTS = runtimeConfig(MAP, 'app').hosts;
for (const locale of LOCALES) {
  const multi = siteNavItems(locale, NAV_HOSTS);
  const single = siteNavItems(locale, {});
  if (!multi.length) findings.push('the site-level navigation is empty');
  for (const [index, item] of multi.entries()) {
    if (!item.label || item.label === item.key) findings.push(`${locale} navigation: no label for "${item.key}"`);
    if (PRIVATE_ROUTES.includes(item.key)) findings.push(`the site navigation offers the withheld route "${item.key}"`);
    if (!SITE_ROUTES.includes(item.key)) findings.push(`the site navigation offers "${item.key}", which is not a published route`);
    // Multi-host: absolute, on a hostname the operator declared, and final rather than a redirect.
    let url;
    try { url = new URL(item.href); } catch { findings.push(`${locale} navigation: "${item.key}" is not an absolute link from another host — ${item.href}`); continue; }
    if (![...MAP.keys()].includes(url.hostname)) findings.push(`${locale} navigation: "${item.key}" points at the undeclared host ${url.hostname}`);
    if (url.hostname === hostFor(MAP, 'marketing') && marketingRedirect(MAP, url.pathname)) {
      findings.push(`${locale} navigation: "${item.key}" points at ${item.href}, which redirects again`);
    }
    // Single host: a path on this origin, never an absolute link to a hostname that operator lacks.
    const path = single[index].href;
    if (!path.startsWith(`/${locale}/`)) findings.push(`${locale} navigation: "${item.key}" is ${path} on a single-host deployment`);
  }
}

// 7. Every surface that renders a header renders it.
//
// The list being shared is not the same thing as the list being displayed: it was shared with the
// workbench and still absent from the demonstration, status, Community and documentation surfaces,
// which showed four links between themselves and no route to the product at all. A surface that stops
// rendering it fails here rather than being noticed by a reader.
//
// The API surface is deliberately not in this list and must never be: it serves no HTML.
const HEADERS = { 'Site.jsx': 'marketing', 'AppNav.jsx': 'app', 'Surfaces.jsx': 'demo, status, community and docs' };
for (const [name, surfaces] of Object.entries(HEADERS)) {
  const content = await readFile(fileURLToPath(new URL(`../../apps/web/src/${name}`, import.meta.url)), 'utf8');
  if (!/from '\.\/site-nav\.js'/u.test(content)) findings.push(`${name}: the ${surfaces} header does not read the shared site-level navigation`);
  // The marketing header renders the entries through its own relative href builder, which is why it
  // is checked for the list rather than for the item helper.
  const renders = name === 'Site.jsx' ? /navPrimary\.map\(/u : /siteNavItems\(locale\)\.map\(/u;
  if (!renders.test(content)) findings.push(`${name}: the ${surfaces} header does not render the site-level navigation`);
}

// 8. No surface header may repeat a destination the site-level navigation already carries. Two links
// with one word and one target in a single header is a defect, and it is the defect this rule caught
// on both the workbench and the surface shell.
for (const locale of LOCALES) {
  for (const hosts of [NAV_HOSTS, {}]) {
    const shape = hosts === NAV_HOSTS ? 'multi-host' : 'single-host';
    const nav = new Set(siteNavItems(locale, hosts).map((item) => item.href));
    for (const item of surfaceLinkItems(locale, hosts)) {
      if (nav.has(item.href)) findings.push(`${locale} ${shape}: the surface header repeats ${item.href}, which the site navigation already carries`);
      if (hosts === NAV_HOSTS && !item.href.startsWith('https://')) findings.push(`${locale}: the surface header link to ${item.surface} is a bare path across a host boundary`);
      if (hosts !== NAV_HOSTS && item.href.includes('openppwr.eu')) findings.push(`${locale}: the surface header link to ${item.surface} names a host a single-host deployment does not have`);
    }
  }
}

// 9. The sample import files are reachable from a rendered page, in both deployment shapes.
//
// They were not. `Site.jsx` offered them on exactly two marketing routes, `demo` and `docs`, and those
// are exactly the two routes section 1 above asserts a mapped deployment redirects off the marketing
// host — so on openppwr.eu the only two pages carrying the links were the only two pages that answer
// `301`. The demonstration surface the first of them lands on rendered no downloads at all, and step 01
// of the workbench cannot be completed without a file. Every previous check passed: the files were
// served (`/downloads/acme-import-valid.csv` answers 200 on every host), the copy existed and was
// translated, and the redirect was correct. Nothing compared the redirect against the page.
//
// This renders the pages rather than reading them, because what failed was not a link contract but
// which component a reader arrives at. Sections 6 and 8 already iterate both shapes; this iterates the
// two components a reader actually reaches, one per shape.
const { register } = await import('node:module');
// The loader is esbuild's JSX transform — the same one Vite runs for the production bundle — so what
// renders here is what ships. It carries no fixtures and no test doubles.
register('../../apps/web/test/jsx-loader.mjs', import.meta.url);
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { acmeDownloads, downloadCopy } = await import('../../apps/web/src/site-sections.js');
const { DemoSurface } = await import('../../apps/web/src/Surfaces.jsx');
const { Site } = await import('../../apps/web/src/Site.jsx');

// The demonstration entry point, per shape. Section 1 pins `/{locale}/demo` to the demonstration host,
// whose page is `DemoSurface`; with no host map configured the same address renders `Site` at route
// `demo`. A reader reaches one or the other and must be offered the files either way.
const DEMO_ENTRY = [
  ['multi-host', (locale) => createElement(DemoSurface, { locale })],
  ['single-host', (locale) => createElement(Site, { locale, route: 'demo' })],
];
for (const locale of LOCALES) {
  for (const [shape, build] of DEMO_ENTRY) {
    const markup = renderToStaticMarkup(build(locale));
    for (const item of acmeDownloads) {
      if (!markup.includes(`href="/downloads/${item.file}"`)) {
        findings.push(`${locale} ${shape}: the demonstration entry point does not offer /downloads/${item.file}`);
      }
    }
    // Root-relative is what makes one markup correct on both shapes and on every host: the same static
    // tree is served from the marketing, demonstration, documentation and workbench hosts alike. An
    // absolute link would name a hostname a single-domain operator does not have; a localized one would
    // name a path that does not exist.
    for (const href of [...markup.matchAll(/href="([^"]*downloads\/[^"]*)"/gu)].map((match) => match[1])) {
      if (!/^\/downloads\/[A-Za-z0-9._-]+$/u.test(href)) findings.push(`${locale} ${shape}: sample link ${href} is not a bare /downloads/ path`);
    }
  }
}

// The workbench carries them too, inside the import step — the one place a reader is looking at an
// empty payload box and a disabled button. Checked in the source, in the manner of section 7: the
// workbench cannot be rendered without a document, and what matters here is the placement rather than
// the markup.
const appSource = await readFile(fileURLToPath(new URL('../../apps/web/src/App.jsx', import.meta.url)), 'utf8');
const importStep = /<section id="import">([\s\S]*?)<\/section>/u.exec(appSource);
if (!importStep) findings.push('App.jsx: the import step could not be read');
else if (!/<SampleDownloads\b/u.test(importStep[1])) findings.push('App.jsx: the import step offers no sample files, so step 01 cannot be completed on a fresh deployment');

// Every file offered is one the exporter actually writes. A label for a file that is not generated is
// a link to a 404, and the list and the generator live in different trees.
const exporterSource = await readFile(fileURLToPath(new URL('../../scripts/acme/acme-dataset.mjs', import.meta.url)), 'utf8');
const exported = new Set([...exporterSource.matchAll(/'([A-Za-z0-9._-]+\.(?:json|csv|md))'/gu)].map((match) => match[1]));
if (exported.size < acmeDownloads.length) findings.push(`sample files: the exporter parse produced only ${exported.size} filenames`);
for (const item of acmeDownloads) {
  if (!exported.has(item.file)) findings.push(`sample files: /downloads/${item.file} is offered but scripts/acme/acme-dataset.mjs does not produce it`);
}

// Every offered file is named in every locale. `i18n-gate.mjs` covers the workbench catalog and the
// page sections; the download labels are in neither, so a file added with an English label only would
// have shipped a mixed-language list.
for (const locale of LOCALES) {
  const copy = downloadCopy[locale];
  if (!copy) { findings.push(`sample files: no copy for ${locale}`); continue; }
  for (const key of ['heading', 'intro', 'inlineIntro', ...acmeDownloads.map((item) => item.key)]) {
    if (!copy[key]) findings.push(`sample files: ${locale} has no label for "${key}"`);
  }
}

if (findings.length) {
  console.error(`LINK_GATE_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`LINK_GATE_PASS locales=${LOCALES.join(',')} routes=${SITE_ROUTES.length + LEGAL_ROUTES.length} site_nav=${SITE_NAV.length} withheld=${PRIVATE_ROUTES.join(',') || 'none'} sample_files=${acmeDownloads.length} shapes=${DEMO_ENTRY.map(([shape]) => shape).join(',')}`);
}
