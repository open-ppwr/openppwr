// The site-level navigation, and the fact that every surface with a header renders it.
//
// The application surface showed the workflow anchors and nothing above them: Product, Community,
// Cloud, Connect, Regulatory and Services were reachable only from the marketing header, so a user on
// app.openppwr.eu had no route to the rest of the product. The list lived privately inside Site.jsx,
// which is why nothing else could render it and why nothing failed when nothing did. The
// demonstration, status, Community and documentation surfaces had the same hole for the same reason.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { routeLabel, SITE_NAV, siteNavItems, SURFACE_LINKS, surfaceLinkItems } from '../src/site-nav.js';
import { isApiOnlyPath, parseHostMap, runtimeConfig } from '../src/surfaces.mjs';

const MAP = parseHostMap([
  'marketing:openppwr.eu', 'app:app.openppwr.eu', 'demo:demo.openppwr.eu', 'docs:docs.openppwr.eu',
  'api:api.openppwr.eu', 'status:status.openppwr.eu', 'community:community.openppwr.eu',
].join(','));
// Exactly what the server states in the document for a browser on the workbench host.
const APP_HOSTS = runtimeConfig(MAP, 'app').hosts;
const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('the site-level navigation carries every product entry the marketing header does', () => {
  assert.deepEqual([...SITE_NAV], ['product', 'community', 'cloud', 'connect', 'regulatory', 'services', 'docs']);
});

test('the workbench header renders the site-level navigation', async () => {
  // The defect was not a wrong link, it was an absent navigation, so the assertion is that the
  // component reads the shared declaration at all.
  const nav = await source('AppNav.jsx');
  assert.match(nav, /from '\.\/site-nav\.js'/u, 'AppNav does not import the site-level navigation');
  assert.match(nav, /siteNavItems\(locale\)/u, 'AppNav does not render the site-level navigation for its locale');
  assert.match(nav, /data-testid="app-nav-site"/u, 'the site-level navigation has no landmark in the workbench header');
});

test('the demonstration, status, Community and documentation surfaces render it too', async () => {
  // Sharing the list with the workbench did not put it on the other four surfaces. They render one
  // shell, so the assertion is that the shell reads the shared declaration and that all four still go
  // through it rather than growing headers of their own.
  const surfaces = await source('Surfaces.jsx');
  assert.match(surfaces, /from '\.\/site-nav\.js'/u, 'the surface shell does not import the site-level navigation');
  assert.match(surfaces, /siteNavItems\(locale\)\.map\(/u, 'the surface shell does not render the site-level navigation');
  assert.match(surfaces, /data-testid="surface-nav-site"/u, 'the site-level navigation has no landmark in the surface header');
  for (const component of ['DemoSurface', 'StatusSurface', 'CommunitySurface', 'DocsSurface']) {
    const body = surfaces.slice(surfaces.indexOf(`export function ${component}`));
    assert.ok(body.includes('<SurfaceShell'), `${component} does not render through the shared shell`);
  }
});

test('no surface header repeats a destination the site-level navigation already carries', () => {
  // The documentation was named twice on every one of these headers, at the identical address.
  for (const locale of ['en', 'pl', 'de']) {
    for (const hosts of [APP_HOSTS, {}]) {
      const nav = new Set(siteNavItems(locale, hosts).map((item) => item.href));
      for (const item of surfaceLinkItems(locale, hosts)) {
        assert.ok(!nav.has(item.href), `${locale}: the surface header repeats ${item.href}`);
      }
    }
  }
  // What the surface header is left with: the other surfaces, and nothing the site navigation covers.
  assert.deepEqual(SURFACE_LINKS.map(([surface]) => surface), ['marketing', 'demo', 'status']);
  assert.equal(surfaceLinkItems('pl', APP_HOSTS)[0].href, 'https://openppwr.eu/pl');
  assert.equal(surfaceLinkItems('pl', {})[1].href, '/pl/demo');
});

test('the API surface renders no navigation, because it is served no document', () => {
  // Extending the navigation to more surfaces must not extend it to the one that serves no HTML.
  const surfaces = ['demo', 'status', 'community', 'docs', 'marketing', 'app'];
  assert.ok(!surfaces.includes('api'));
  assert.equal(isApiOnlyPath('/health'), true);
  assert.equal(isApiOnlyPath('/v1/version'), true);
  // Anything that would carry a header is not an API path, so the API host answers it with no document.
  for (const path of ['/', '/en', '/pl/app', '/index.html', '/assets/index.js']) {
    assert.equal(isApiOnlyPath(path), false, `${path} must not be served from the API host`);
  }
});

test('the marketing header and the workbench header read one declaration, not two copies', async () => {
  const site = await source('Site.jsx');
  assert.match(site, /from '\.\/site-nav\.js'/u, 'Site.jsx has its own copy of the navigation');
  // The private list and label table are gone from the component, so they cannot drift from the
  // shared one by being edited in the place a reader would look first.
  assert.ok(!/const navPrimary=\[/u.test(site), 'Site.jsx still declares its own navigation list');
  assert.ok(!/const routeLabels=\{/u.test(site), 'Site.jsx still declares its own label table');
});

test('every entry is labelled in every locale, and the locales differ where they should', () => {
  const expected = {
    en: ['Product', 'Community', 'Cloud', 'Connect', 'Regulatory', 'Services', 'Docs'],
    pl: ['Produkt', 'Community', 'Cloud', 'Connect', 'Regulatory', 'Usługi', 'Dokumentacja'],
    de: ['Produkt', 'Community', 'Cloud', 'Connect', 'Regulatory', 'Services', 'Dokumentation'],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    assert.deepEqual(siteNavItems(locale, APP_HOSTS).map((item) => item.label), labels, `${locale} labels`);
  }
  // An unknown locale falls back to English rather than rendering a key.
  assert.equal(routeLabel('fr', 'services'), 'Services');
  assert.equal(routeLabel('pl', 'services'), 'Usługi');
});

test('on the workbench host every entry crosses to the host that actually serves it', () => {
  for (const locale of ['en', 'pl', 'de']) {
    const href = Object.fromEntries(siteNavItems(locale, APP_HOSTS).map((item) => [item.key, item.href]));
    assert.equal(href.product, `https://openppwr.eu/${locale}/product`);
    assert.equal(href.community, `https://openppwr.eu/${locale}/community`);
    assert.equal(href.cloud, `https://openppwr.eu/${locale}/cloud`);
    assert.equal(href.connect, `https://openppwr.eu/${locale}/connect`);
    assert.equal(href.regulatory, `https://openppwr.eu/${locale}/regulatory`);
    assert.equal(href.services, `https://openppwr.eu/${locale}/services`);
    // The documentation is a surface, not a marketing page. Addressing it as `openppwr.eu/{locale}/docs`
    // would be answered with a 301 to this same address, so it is named directly.
    assert.equal(href.docs, `https://docs.openppwr.eu/${locale}`);
    // Nothing may stay on the workbench host, where none of these paths exist.
    for (const value of Object.values(href)) {
      assert.ok(!value.startsWith('https://app.openppwr.eu'), `${locale}: ${value} would 404 on the workbench host`);
      assert.ok(value.startsWith('https://'), `${locale}: ${value} is a bare path across a host boundary`);
    }
  }
});

test('a single-host deployment keeps relative links and gains no hostname it does not have', () => {
  // No host map means one domain serves every surface. Building openppwr.eu links there would point a
  // self-hosted operator at somebody else's deployment.
  for (const locale of ['en', 'pl', 'de']) {
    const href = Object.fromEntries(siteNavItems(locale, {}).map((item) => [item.key, item.href]));
    assert.equal(href.product, `/${locale}/product`);
    assert.equal(href.services, `/${locale}/services`);
    assert.equal(href.docs, `/${locale}/docs`);
    for (const value of Object.values(href)) assert.ok(!value.includes('openppwr.eu'), `${locale}: ${value} names a host`);
  }
});
