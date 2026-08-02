import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalHostRedirect, injectRuntimeConfig, isApiOnlyPath, legacyRedirect, marketingRedirect, parseHostMap, requestHostname, resolveSurface, runtimeConfig } from '../src/surfaces.mjs';

const MAP = parseHostMap([
  'marketing:openppwr.eu',
  'app:app.openppwr.eu',
  'demo:demo.openppwr.eu',
  'docs:docs.openppwr.eu',
  'api:api.openppwr.eu',
  'status:status.openppwr.eu',
  'community:community.openppwr.eu',
].join(','));

test('an unset map keeps a single-host deployment working exactly as before', () => {
  assert.equal(parseHostMap(''), null);
  assert.equal(parseHostMap(undefined), null);
  // "all" means serve every surface from this host, which is the ordinary self-hosted shape.
  assert.equal(resolveSurface(null, 'openppwr.example'), 'all');
  assert.equal(marketingRedirect(null, '/pl/app'), null);
});

test('a typo in the host map is rejected rather than silently disabling a hostname', () => {
  assert.throws(() => parseHostMap('marketng:openppwr.eu'), /Unknown surface/u);
  assert.throws(() => parseHostMap('app:'), /Missing hostname/u);
  assert.throws(() => parseHostMap('nocolon'), /Invalid/u);
});

test('each declared hostname resolves to its own surface', () => {
  assert.equal(resolveSurface(MAP, 'openppwr.eu'), 'marketing');
  assert.equal(resolveSurface(MAP, 'app.openppwr.eu'), 'app');
  assert.equal(resolveSurface(MAP, 'demo.openppwr.eu'), 'demo');
  assert.equal(resolveSurface(MAP, 'docs.openppwr.eu'), 'docs');
  assert.equal(resolveSurface(MAP, 'api.openppwr.eu'), 'api');
  assert.equal(resolveSurface(MAP, 'status.openppwr.eu'), 'status');
  assert.equal(resolveSurface(MAP, 'community.openppwr.eu'), 'community');
});

test('an undeclared host is refused, not treated as the marketing site', () => {
  assert.equal(resolveSurface(MAP, 'openppwr.eu.attacker.example'), null);
  assert.equal(resolveSurface(MAP, 'random.invalid'), null);
  assert.equal(resolveSurface(MAP, ''), null);
});

test('a www spelling of a declared host resolves to that host instead of being refused', () => {
  // The name every browser still offers to complete reached the fail-closed refusal and told a visitor who
  // typed the domain correctly that the site does not exist.
  assert.equal(canonicalHostRedirect(MAP, 'www.openppwr.eu'), 'openppwr.eu');
  assert.equal(canonicalHostRedirect(MAP, 'www.docs.openppwr.eu'), 'docs.openppwr.eu');
  // Everything else stays refused. The rule rewrites one prefix off a hostname the operator declared; it
  // does not make an undeclared name reachable, which is the property the host map exists for.
  assert.equal(canonicalHostRedirect(MAP, 'openppwr.eu'), null, 'a declared host is served, not redirected');
  assert.equal(canonicalHostRedirect(MAP, 'www.attacker.example'), null);
  assert.equal(canonicalHostRedirect(MAP, 'www.openppwr.eu.attacker.example'), null);
  assert.equal(canonicalHostRedirect(MAP, 'wwwopenppwr.eu'), null, 'the prefix is a label, not a substring');
  assert.equal(canonicalHostRedirect(MAP, 'www.'), null);
  assert.equal(canonicalHostRedirect(MAP, ''), null);
  // A single-host deployment has no map, so there is no canonical host to name and nothing to redirect to.
  assert.equal(canonicalHostRedirect(null, 'www.openppwr.eu'), null);
});

test('an operator whose canonical host is the www one is served there, not bounced to a host they may not have', () => {
  const wwwCanonical = parseHostMap('marketing:www.example.com');
  assert.equal(resolveSurface(wwwCanonical, 'www.example.com'), 'marketing');
  assert.equal(canonicalHostRedirect(wwwCanonical, 'www.example.com'), null);
});

test('www is a redirect rather than a second host-map entry, because a second entry decides canonicality by ordering', () => {
  // This is the evidence for that choice, not a test of www itself. `runtimeConfig` keeps the *first*
  // hostname it sees for a surface, and `site-meta.js` builds every canonical and hreflang URL from it.
  // Two marketing entries would therefore make the site's declared canonical host a property of the order
  // of two comma-separated values in an environment variable — and would publish the same pages under two
  // hostnames either way, which is the duplicate content the canonical tag is supposed to prevent.
  const wwwFirst = parseHostMap('marketing:www.openppwr.eu,marketing:openppwr.eu,app:app.openppwr.eu');
  assert.equal(runtimeConfig(wwwFirst, 'marketing').hosts.marketing, 'www.openppwr.eu');
  const apexFirst = parseHostMap('marketing:openppwr.eu,marketing:www.openppwr.eu,app:app.openppwr.eu');
  assert.equal(runtimeConfig(apexFirst, 'marketing').hosts.marketing, 'openppwr.eu');
});

test('by default the addressed host is Host, not a client-supplied forwarding header', () => {
  // Unconditionally preferring X-Forwarded-Host let any caller who could reach this loopback port choose
  // its own surface with a header it controls. Untrusted by default; Host is this server's
  // own hop and cannot be forged past whatever set it.
  assert.equal(requestHostname({ headers: { host: 'web:8080', 'x-forwarded-host': 'app.openppwr.eu' } }), 'web');
  assert.equal(requestHostname({ headers: { host: 'openppwr.eu:443' } }), 'openppwr.eu');
  assert.equal(requestHostname({ headers: { 'x-forwarded-host': 'docs.openppwr.eu' } }), '');
  assert.equal(requestHostname({ headers: {} }), '');
});

test('X-Forwarded-Host is honoured only once the operator explicitly trusts their proxy chain', () => {
  const trustForwardedHost = { trustForwardedHost: true };
  assert.equal(requestHostname({ headers: { host: 'web:8080', 'x-forwarded-host': 'app.openppwr.eu' } }, trustForwardedHost), 'app.openppwr.eu');
  assert.equal(requestHostname({ headers: { 'x-forwarded-host': 'Docs.OpenPPWR.EU' } }, trustForwardedHost), 'docs.openppwr.eu');
  // Only the first hop is the address the browser used.
  assert.equal(requestHostname({ headers: { 'x-forwarded-host': 'app.openppwr.eu, proxy.internal' } }, trustForwardedHost), 'app.openppwr.eu');
  assert.equal(requestHostname({ headers: {} }, trustForwardedHost), '');
});

test('the marketing host redirects to the canonical route on the canonical host', () => {
  // This assertion previously read `https://app.openppwr.eu/pl` — the segment that identifies the
  // workbench was dropped, so the product's own "open the workbench" link delivered the marketing
  // homepage. The test asserted the defect, which is why review kept confirming it.
  //
  // The workbench is a surface *within* its host, so `/app` must survive the jump. The demonstration
  // and the documentation are the whole of their hosts, so their canonical root is `/{locale}` and
  // carrying the segment would create a second URL for one page.
  assert.equal(marketingRedirect(MAP, '/pl/app'), 'https://app.openppwr.eu/pl/app');
  assert.equal(marketingRedirect(MAP, '/en/app'), 'https://app.openppwr.eu/en/app');
  assert.equal(marketingRedirect(MAP, '/de/app'), 'https://app.openppwr.eu/de/app');
  assert.equal(marketingRedirect(MAP, '/en/demo'), 'https://demo.openppwr.eu/en');
  assert.equal(marketingRedirect(MAP, '/de/docs'), 'https://docs.openppwr.eu/de');
  // Deeper paths are preserved so a link into the documentation still lands where it pointed.
  assert.equal(marketingRedirect(MAP, '/en/docs/quickstart'), 'https://docs.openppwr.eu/en/quickstart');
  assert.equal(marketingRedirect(MAP, '/en/app/gaps'), 'https://app.openppwr.eu/en/app/gaps');
});

test('no redirect target carries a query string across a host boundary', () => {
  // The redirect is computed from the path alone and the server never forwards the query, so a
  // credential, session identifier or service-token value that ended up in a URL cannot cross to
  // another host. Asserting it here keeps that property from being "improved" away later.
  for (const path of ['/pl/app', '/en/demo', '/de/docs', '/en/docs/quickstart', '/en/app/gaps']) {
    const target = marketingRedirect(MAP, path);
    assert.ok(target && !target.includes('?'), `${path} produced a redirect with a query string`);
    assert.ok(!/token|secret|password|session/iu.test(target), `${path} produced a credential-bearing redirect`);
  }
});

test('unlocalized legacy paths resolve to one canonical location', () => {
  // `/product` and `/docs` answered 200 with content, so every page existed under two indexable URLs.
  assert.equal(legacyRedirect(MAP, '/product'), '/en/product');
  assert.equal(legacyRedirect(MAP, '/pricing'), '/en/pricing');
  assert.equal(legacyRedirect(MAP, '/terms'), '/en/terms');
  assert.equal(legacyRedirect(MAP, '/docs'), 'https://docs.openppwr.eu/en');
  assert.equal(legacyRedirect(MAP, '/demo'), 'https://demo.openppwr.eu/en');
  assert.equal(legacyRedirect(MAP, '/app'), 'https://app.openppwr.eu/en/app');
  // A locale is already canonical, and an unknown single segment is a 404, not a guess.
  assert.equal(legacyRedirect(MAP, '/pl'), null);
  assert.equal(legacyRedirect(MAP, '/nonsense'), null);
  assert.equal(legacyRedirect(MAP, '/pl/product'), null);
});

test('legacy paths still resolve when no host map is configured', () => {
  // A single-host deployment has nowhere else to send them, so they stay on this origin.
  assert.equal(legacyRedirect(null, '/product'), '/en/product');
  assert.equal(legacyRedirect(null, '/docs'), '/en/docs');
  assert.equal(legacyRedirect(null, '/app'), '/en/app');
});

test('the surface travels to the browser as inert attribute content', () => {
  const config = runtimeConfig(MAP, 'demo');
  assert.equal(config.surface, 'demo');
  assert.equal(config.hosts.app, 'app.openppwr.eu');
  const html = injectRuntimeConfig('<html><head><title>x</title></head><body></body></html>', config);
  assert.ok(html.includes('name="openppwr-runtime"'));
  // The policy is `script-src 'self'`, so this must never become a script tag.
  assert.ok(!/<script/u.test(html), 'the surface must not be injected as an inline script');
  // The attribute delimiter and the tag opener are the two characters that could escape the value.
  const hostile = injectRuntimeConfig('<head></head>', { surface: '"><script>alert(1)</script>', hosts: {} });
  assert.ok(!hostile.includes('<script'), 'injected configuration escaped its attribute');
});

test('a deployment with no host map reports a single-host runtime', () => {
  const config = runtimeConfig(null, 'all');
  assert.equal(config.surface, 'all');
  assert.deepEqual(config.hosts, {});
});

test('the Community product page is not redirected to the community entry point', () => {
  // /{locale}/community is a page about the Community edition. Redirecting it would send a reader
  // looking for the product to a landing page instead.
  assert.equal(marketingRedirect(MAP, '/pl/community'), null);
  assert.equal(marketingRedirect(MAP, '/en/community'), null);
});

test('redirects never fire for paths that are not a locale-prefixed surface', () => {
  assert.equal(marketingRedirect(MAP, '/pl'), null);
  assert.equal(marketingRedirect(MAP, '/app'), null, 'an unlocalized path must not jump hosts');
  assert.equal(marketingRedirect(MAP, '/fr/app'), null, 'fr is not a supported locale');
  assert.equal(marketingRedirect(MAP, '/pl/pricing'), null);
});

test('a redirect never points at the host that issued it, so no loop can form', () => {
  for (const path of ['/pl/app', '/en/demo', '/de/docs', '/en/docs/quickstart']) {
    const target = marketingRedirect(MAP, path);
    assert.ok(target, `${path} should redirect`);
    assert.ok(!target.startsWith('https://openppwr.eu/'), `${path} redirected back to the marketing host`);
  }
});

test('the API host serves the API and nothing else', () => {
  assert.equal(isApiOnlyPath('/v1/version'), true);
  assert.equal(isApiOnlyPath('/health'), true);
  assert.equal(isApiOnlyPath('/'), false);
  assert.equal(isApiOnlyPath('/en'), false);
  assert.equal(isApiOnlyPath('/assets/index.js'), false);
  // "/v1" without a trailing path is not an API call; it must not open the HTML fallback either.
  assert.equal(isApiOnlyPath('/v1'), false);
});

test('cross-surface links are correct in both deployment shapes', async () => {
  // The self-hosted default serves every surface from one domain. A link built as though the
  // documentation had its own host would point at a hostname that operator does not have, and a link
  // built as a bare path would point at nothing on a multi-host deployment. Both shapes are exercised
  // here because only one of them is ever visible in the private deployment.
  const { localeHref } = await import('../src/runtime.js');
  const single = localeHref('docs', 'pl', 'quickstart');
  assert.equal(single, '/pl/docs/quickstart', 'single-host documentation link');
  assert.equal(localeHref('app', 'pl'), '/pl/app', 'single-host workbench link');
  assert.equal(localeHref('marketing', 'de'), '/de', 'marketing is the root on a single host');
  assert.equal(localeHref('status', 'en'), '/en/status');
});

test('a withheld route is unreachable from navigation but still addressable', async () => {
  // Terms of use is withheld until the legal review signs it. Two properties have to hold together:
  // nothing on the site sends a new reader there, and the URL still answers for someone holding the
  // link — a 404 would tell them the page does not exist, which is not true.
  const { PRIVATE_ROUTES, pageSections } = await import('../src/site-sections.js');
  const { SITE_ROUTES, LEGAL_ROUTES } = await import('../src/site-content.js');
  assert.deepEqual(PRIVATE_ROUTES, ['terms']);
  assert.ok(!SITE_ROUTES.includes('terms'), 'a withheld route must not be in the primary navigation');
  // The content is gone from the bundle entirely, not merely hidden behind a flag.
  for (const locale of ['en', 'pl', 'de']) {
    assert.equal(pageSections[locale].terms, undefined, `${locale}: withheld content is still in the bundle`);
    // And no other page links to it.
    for (const [route, sections] of Object.entries(pageSections[locale])) {
      const text = (sections || []).map((s) => `${s.h} ${s.p || ''} ${(s.items || []).join(' ')}`).join(' ');
      assert.ok(!text.includes(`/${locale}/terms`), `${locale}/${route} links to the withheld route`);
    }
  }
  // LEGAL_ROUTES still names it, because the route exists and must render its withheld state.
  assert.ok(LEGAL_ROUTES.includes('terms'));
});
