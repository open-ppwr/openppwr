// SPDX-License-Identifier: Apache-2.0
//
// Which product surface a request is addressing.
//
// Seven hostnames were pointed at one origin that served the same single-page application to all of
// them. `api.openppwr.eu/anything` returned marketing HTML, `docs.openppwr.eu` returned the same page
// as the apex, and a request for a host nobody had configured was answered as though it were the
// marketing site. The hostnames existed; the surfaces did not.
//
// Host routing is **opt-in**. A self-hosted Community deployment usually runs on one domain, and
// forcing seven would be a hostile default, so with no map configured the server behaves exactly as
// before and serves every surface from one host. Fail-closed behaviour applies only once an operator
// has declared which host is which — at that point an unrecognised host is a misconfiguration or a
// probe, and answering it with content would be wrong.

export const SURFACES = Object.freeze(['marketing', 'app', 'demo', 'docs', 'api', 'status', 'community']);

// `OPENPPWR_HOST_MAP=marketing:openppwr.eu,app:app.openppwr.eu,...`
// Unknown surface names are rejected rather than ignored: a typo that silently disables routing for
// one hostname is exactly the failure this map exists to prevent.
export function parseHostMap(raw) {
  if (!raw || !raw.trim()) return null;
  const map = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index < 1) throw new Error(`Invalid OPENPPWR_HOST_MAP entry: ${trimmed}`);
    const surface = trimmed.slice(0, index).trim().toLowerCase();
    const hostname = trimmed.slice(index + 1).trim().toLowerCase();
    if (!SURFACES.includes(surface)) throw new Error(`Unknown surface in OPENPPWR_HOST_MAP: ${surface}`);
    if (!hostname) throw new Error(`Missing hostname for surface ${surface}`);
    map.set(hostname, surface);
  }
  return map.size ? map : null;
}

// The host the browser actually addressed. `Host` is always this server's own hop — whatever the
// operator's reverse proxy or tunnel set it to when connecting here — and cannot be forged by the
// client past that hop. `X-Forwarded-Host` is client-influenced: it exists to carry the *original*
// hostname across a proxy chain that rewrites `Host` to the upstream's own name, and unconditionally
// preferring it let any caller who could reach this loopback port choose which surface it answered as,
// with no check that the proxy actually intended to forward one. Trusted only when the
// operator explicitly confirms their proxy chain requires it — same pattern already used for
// `OPENPPWR_TRUST_CF_CONNECTING_IP` a few lines below in server.mjs, extended here for consistency.
// Cloudflare Tunnel does not need it: cloudflared sets `Host` directly per hostname
// (`httpHostHeader` in its own ingress config), so `Host` alone is already correct for that topology.
export function requestHostname(request, { trustForwardedHost = false } = {}) {
  const forwarded = trustForwardedHost ? request.headers['x-forwarded-host'] : null;
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || request.headers.host || '';
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:\d+$/u, '');
}

// Returns the surface, or null when a map is configured and the host is not in it. Null means refuse.
export function resolveSurface(hostMap, hostname) {
  if (!hostMap) return 'all';
  return hostMap.get(hostname) || null;
}

// `www.<host>` is a spelling of `<host>`, not a surface of its own.
//
// Fail-closed host routing refuses every hostname the operator did not declare, which is right for a name
// nobody configured and wrong for the one name every browser still offers to complete. A `www` host that
// reaches this server was pointed here deliberately — by a zone record and a virtual host that name it as
// an alias of the site — so answering it with `404 UNKNOWN_HOST` tells a visitor who typed the domain
// correctly that the site does not exist.
//
// The answer is a redirect rather than a second entry in the host map, and the difference is not cosmetic.
// A second entry would make the same pages reachable under two hostnames, which is duplicate indexable
// content; worse, `runtimeConfig` keeps the *first* hostname it sees for a surface, so whether the site
// declared itself canonical at the apex or at `www` would depend on the order of two entries in an
// environment variable. A redirect has one canonical host by construction and no ordering to get wrong.
//
// Only the undeclared spelling is rewritten. An operator whose canonical host really is `www.example.com`
// declares it in the map and is served there; this never overrides a declaration.
export function canonicalHostRedirect(hostMap, hostname) {
  if (!hostMap || !hostname.startsWith('www.')) return null;
  if (hostMap.has(hostname)) return null;
  const bare = hostname.slice(4);
  return bare && hostMap.has(bare) ? bare : null;
}

export const LOCALES = ['pl', 'en', 'de'];
export const DEFAULT_LOCALE = 'en';

// Cross-host redirects from the marketing site. The workbench, the demonstration and the
// documentation each have their own canonical host, and `openppwr.eu/pl/app` must lead there rather
// than serving a second copy of the application under a second URL.
//
// `/{locale}/community` is deliberately absent: on the marketing site it is a product page about the
// Community edition, which is not the same thing as the community.openppwr.eu entry point. Confusing
// the two would send a reader looking for the product to a redirect.
//
// `keepSegment` is the difference between a working link and a broken one. The workbench lives at
// `/{locale}/app` on its own host, so the segment identifies the surface *within* that host and must
// survive the jump. The demonstration and the documentation are the whole of their hosts, so their
// canonical root is `/{locale}` and carrying the segment would produce `/pl/docs` on `docs.` — a
// second name for the same page.
//
// This previously dropped the segment for all three, so `/pl/app` arrived at `app.openppwr.eu/pl`,
// which the application rendered as the marketing homepage. The test suite asserted that as correct.
const CROSS_HOST = {
  app: { surface: 'app', keepSegment: true },
  demo: { surface: 'demo', keepSegment: false },
  docs: { surface: 'docs', keepSegment: false },
};

export function hostFor(hostMap, surface) {
  if (!hostMap) return null;
  return [...hostMap.entries()].find(([, name]) => name === surface)?.[0] || null;
}

export function marketingRedirect(hostMap, pathname) {
  if (!hostMap) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !LOCALES.includes(segments[0])) return null;
  const crossing = CROSS_HOST[segments[1]];
  if (!crossing) return null;
  const target = hostFor(hostMap, crossing.surface);
  if (!target) return null;
  const kept = crossing.keepSegment ? segments.slice(1) : segments.slice(2);
  const rest = kept.join('/');
  return `https://${target}/${segments[0]}${rest ? `/${rest}` : ''}`;
}

// Unlocalized legacy paths. `/product` and `/docs` answered `200` with content, so every product page
// existed under two URLs and both were indexable. They resolve to one canonical location instead.
//
// The locale is not negotiated here. A redirect that varies by Accept-Language is uncacheable and
// makes a shared link mean different things to different readers, so legacy paths land on the default
// locale and the reader can switch.
const LEGACY_MARKETING = new Set([
  'product', 'community', 'enterprise', 'cloud', 'connect', 'regulatory', 'services',
  'pricing', 'roadmap', 'security', 'trust', 'partners', 'privacy', 'terms', 'cookies', 'imprint',
]);

export function legacyRedirect(hostMap, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const [segment] = segments;
  if (LOCALES.includes(segment)) return null;
  const crossing = CROSS_HOST[segment];
  if (crossing) {
    const target = hostFor(hostMap, crossing.surface);
    if (!target) return `/${DEFAULT_LOCALE}/${segment}`;
    return `https://${target}/${DEFAULT_LOCALE}${crossing.keepSegment ? `/${segment}` : ''}`;
  }
  if (LEGACY_MARKETING.has(segment)) return `/${DEFAULT_LOCALE}/${segment}`;
  return null;
}

// How the browser learns which surface it is on.
//
// The application cannot derive this from the hostname alone. A self-hosted Community deployment runs
// every surface on one domain, and guessing a surface from a subdomain label would break it. The
// server already resolved the question, so it states the answer in the document.
//
// A meta tag rather than an inline script: the content security policy is `script-src 'self'`, so an
// injected inline script would be blocked by the very header that protects this page. Meta content is
// inert data and needs no exception.
export function runtimeConfig(hostMap, surface) {
  const hosts = {};
  if (hostMap) for (const [hostname, name] of hostMap) if (!hosts[name]) hosts[name] = hostname;
  return { surface, hosts };
}

// The value is HTML-attribute content, so the quote character that would end the attribute is the one
// that must not survive. `<` is escaped as well, because a serialiser that ever moved this out of an
// attribute would otherwise carry an injection with it.
export function injectRuntimeConfig(html, config) {
  const encoded = JSON.stringify(config).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const tag = `<meta name="openppwr-runtime" content="${encoded}">`;
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`;
}

// The API host serves the API and nothing else. Serving an HTML application from it would invite
// clients to treat it as a browser surface and would put application markup behind a name that is
// meant to be a stable machine contract.
export function isApiOnlyPath(pathname) {
  return pathname === '/health' || pathname.startsWith('/v1/');
}
