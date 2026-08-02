// What the server decided about this request, read back in the browser.
//
// The server resolves the surface from the configured host map; the browser cannot, because a
// self-hosted deployment serves every surface from one domain and a subdomain label would be a guess.
// The answer travels in a meta tag rather than an inline script, because the content security policy
// is `script-src 'self'`.
//
// Absent or unreadable configuration means single-host mode — the historical behaviour, where the path
// alone selects the page. That is the ordinary self-hosted shape and must keep working untouched.

const FALLBACK = { surface: 'all', hosts: {} };

function read() {
  if (typeof document === 'undefined') return FALLBACK;
  const raw = document.querySelector('meta[name="openppwr-runtime"]')?.getAttribute('content');
  if (!raw) return FALLBACK;
  try {
    const parsed = JSON.parse(raw);
    return { surface: parsed.surface || 'all', hosts: parsed.hosts || {} };
  } catch {
    return FALLBACK;
  }
}

export const RUNTIME = read();

// Where a surface lives *within* its own host. The workbench is at `/{locale}/app` on the application
// host; the demonstration, documentation, status and Community surfaces are the whole of theirs, so
// they sit at `/{locale}`. This mirrors the segment rule in `surfaces.mjs` and has to agree with it,
// or a link and its redirect target disagree.
const WITHIN_HOST = { app: 'app' };

// A link to another surface, correct in both deployment shapes.
//
// On a multi-host deployment it is absolute and crosses hosts. On a single-host deployment — the
// ordinary self-hosted shape, where one domain serves everything — the surface is a path segment on
// this origin instead. Building `https://docs.openppwr.eu/...` there would point at a host that does
// not exist for that operator; building `/{locale}/quickstart` would point at nothing.
export function surfaceHref(surface, path = '') {
  const host = RUNTIME.hosts[surface];
  const suffix = path.startsWith('/') ? path : path ? `/${path}` : '';
  if (!host) return suffix || '/';
  return `https://${host}${suffix}`;
}

// `rest` is the path within the surface, not within the host — the caller should not have to know
// which segment a given surface occupies on its own host.
export function localeHref(surface, locale, rest = '') {
  return buildLocaleHref(RUNTIME.hosts, surface, locale, rest);
}

// The same rule, with the host table passed in rather than read from the document. `RUNTIME` is
// resolved once at module load from a meta tag that only a browser has, so a test — and any caller
// that has to reason about both deployment shapes at once — cannot exercise the multi-host branch
// through `localeHref` alone. The behaviour is stated here and `localeHref` is the browser's binding
// of it, so the two cannot disagree.
export function buildLocaleHref(hosts, surface, locale, rest = '') {
  const host = hosts?.[surface];
  const tail = rest ? `/${rest.replace(/^\//u, '')}` : '';
  if (host) {
    const within = WITHIN_HOST[surface] ? `/${WITHIN_HOST[surface]}` : '';
    return `https://${host}/${locale}${within}${tail}`;
  }
  // One host serves everything: the surface name is the segment that distinguishes it. Marketing is
  // the root, so it contributes no segment.
  const segment = surface === 'marketing' || surface === 'all' ? '' : `/${surface}`;
  return `/${locale}${segment}${tail}`;
}

// The origin a page should declare as canonical. Six hosts served the same document and each
// declared itself canonical for it, which is the definition of duplicate indexable content.
export function canonicalOrigin(surface) {
  const host = RUNTIME.hosts[surface];
  if (host) return `https://${host}`;
  return typeof window !== 'undefined' && window.location ? window.location.origin : 'https://openppwr.eu';
}
