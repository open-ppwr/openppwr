// SPDX-License-Identifier: Apache-2.0
//
// The site-level navigation, stated once for every surface that renders it.
//
// The marketing header carried this list privately, so it existed on exactly one of the seven
// surfaces. On the workbench — the surface a user spends the working day on — the header offered the
// workflow anchors and nothing above them: no Product, no Community, no Cloud, Connect, Regulatory or
// Services. A user who arrived at `app.openppwr.eu` could not reach the rest of the product from the
// page they were standing on, in any locale.
//
// The list, its labels and its cross-host targets therefore live here rather than inside one
// component. Two copies of a navigation drift, and the copy that drifts is the one nobody is looking
// at; the marketing header and the workbench header now read the same declaration.

import { buildLocaleHref, RUNTIME } from './runtime.js';

// The site-level entries, in the order the marketing header has always shown them.
export const SITE_NAV = Object.freeze([
  'product', 'community', 'cloud', 'connect', 'regulatory', 'services', 'docs',
]);

// Which surface an entry addresses. Everything here is a page on the marketing site except the
// documentation, which is a surface of its own.
//
// Naming the documentation surface directly matters on a multi-host deployment: the marketing host
// answers `/{locale}/docs` with a 301 to the documentation host (see `CROSS_HOST` in surfaces.mjs),
// so building this entry as a marketing path would send every reader through a redirect to reach the
// same place. On a single-host deployment both spellings are `/{locale}/docs`, so the entry is
// identical there and nothing about the self-hosted shape changes.
const NAV_SURFACE = Object.freeze({ docs: 'docs' });

// Route labels for the whole site, not only the primary entries: the marketing footer lists the
// remaining routes and takes its wording from the same table, so a route can never be named one thing
// in the header and another below it.
export const ROUTE_LABELS = {
  en: { product: 'Product', community: 'Community', enterprise: 'Enterprise', cloud: 'Cloud', connect: 'Connect', regulatory: 'Regulatory', services: 'Services', pricing: 'Pricing', demo: 'Demo', docs: 'Docs', roadmap: 'Roadmap', security: 'Security', trust: 'Trust', partners: 'Partners', privacy: 'Privacy', terms: 'Terms', cookies: 'Cookies', imprint: 'Company' },
  pl: { product: 'Produkt', community: 'Community', enterprise: 'Enterprise', cloud: 'Cloud', connect: 'Connect', regulatory: 'Regulatory', services: 'Usługi', pricing: 'Cennik', demo: 'Demo', docs: 'Dokumentacja', roadmap: 'Roadmap', security: 'Bezpieczeństwo', trust: 'Zaufanie', partners: 'Partnerzy', privacy: 'Prywatność', terms: 'Warunki', cookies: 'Cookies', imprint: 'Informacje o firmie' },
  de: { product: 'Produkt', community: 'Community', enterprise: 'Enterprise', cloud: 'Cloud', connect: 'Connect', regulatory: 'Regulatory', services: 'Services', pricing: 'Preise', demo: 'Demo', docs: 'Dokumentation', roadmap: 'Roadmap', security: 'Sicherheit', trust: 'Trust', partners: 'Partner', privacy: 'Datenschutz', terms: 'Bedingungen', cookies: 'Cookies', imprint: 'Unternehmen' },
};

export function routeLabel(locale, key) {
  return ROUTE_LABELS[locale]?.[key] ?? ROUTE_LABELS.en[key] ?? key;
}

// The rendered entries: a key, the label in this locale, and an address that is correct in both
// deployment shapes. `hosts` is a parameter so the multi-host shape can be exercised without a
// browser; in the browser it defaults to what the server stated in the document.
export function siteNavItems(locale, hosts = RUNTIME.hosts) {
  return SITE_NAV.map((key) => ({
    key,
    label: routeLabel(locale, key),
    href: NAV_SURFACE[key]
      ? buildLocaleHref(hosts, NAV_SURFACE[key], locale)
      : buildLocaleHref(hosts, 'marketing', locale, key),
  }));
}

// What a non-marketing surface header carries *in addition* to the site-level navigation: the other
// surfaces, each addressed at its own root. The documentation is deliberately absent — the site-level
// navigation already carries it, at the identical address in both deployment shapes, and a header that
// offers the same word twice for the same destination reads as a defect rather than as a convenience.
//
// It is data rather than markup so the no-duplicate property can be checked rather than reviewed:
// link-gate compares these addresses against the site-level ones on every locale and both shapes.
export const SURFACE_LINKS = Object.freeze([
  ['marketing', 'productSite'], ['demo', 'demoLabel'], ['status', 'statusLabel'],
]);

export function surfaceLinkItems(locale, hosts = RUNTIME.hosts) {
  return SURFACE_LINKS.map(([surface, key]) => ({ surface, key, href: buildLocaleHref(hosts, surface, locale) }));
}
