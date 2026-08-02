// The surfaces that are not the marketing site.
//
// Each of these hostnames previously rendered the marketing homepage, because the application chose
// its page from the URL path alone and never read the host. The server now states the resolved
// surface in the document and these components render it.

import { useEffect } from 'react';
import { buildLabel, editionLabel, useBuildInfo } from './build-info.js';
import { localeHref, RUNTIME, surfaceHref } from './runtime.js';
import { siteNavItems, surfaceLinkItems } from './site-nav.js';
import { communityCopy, demoCopy, statusCopy, surfaceCommon, SURFACE_LOCALES, surfaceText } from './surface-content.js';
import { RoleMatrix } from './RoleMatrix.jsx';
import { DocsPortal } from './DocsPortal.jsx';
import { SampleDownloads } from './Downloads.jsx';

// Shared chrome. Every surface carries the same way back to the product, the same language switch and
// the same build stamp, so a reader can always tell which of the seven places they are in and which
// build produced it.
function SurfaceShell({ locale, surface, label, children, within = '' }) {
  const t = (key) => surfaceText(surfaceCommon, locale)[key];
  const build = useBuildInfo();
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <div className="site-shell surface-shell" data-surface={surface}>
    <a className="skip-link" href="#surface-main">{t('skipToContent') || 'Skip to main content'}</a>
    {/* The site-level navigation, above the surface's own — the same declaration the marketing header
        and the workbench header render. These four surfaces previously offered four links between
        themselves and nothing else, so Product, Community, Cloud, Connect, Regulatory and Services
        existed for a reader only if they happened to be standing on the marketing site. */}
    <nav aria-label={t('siteNav')} className="surface-nav-site" data-testid="surface-nav-site">
      {siteNavItems(locale).map((item) => <a key={item.key} href={item.href}>{item.label}</a>)}
    </nav>
    <header className="site-header">
      <a className="wordmark" href={surfaceHref('marketing', `/${locale}`)}>
        <strong>OpenPPWR</strong><span data-testid="surface-label">{label}</span>
      </a>
      {/* The other surfaces. Documentation is not among them: the site-level navigation above carries
          it at the identical address, and one header naming it twice reads as a defect. */}
      <nav aria-label={label}>
        {surfaceLinkItems(locale).map((item) => <a key={item.surface} href={item.href}>{t(item.key)}</a>)}
      </nav>
      <div className="site-tools">
        <div className="locale-links" aria-label={t('language')}>
          {/* Built through localeHref so the switch stays on this surface in both deployment shapes.
              A bare `/${item}` lands on the marketing root when one host serves everything. */}
          {SURFACE_LOCALES.map((item) => <a key={item} className={item === locale ? 'active' : ''}
            href={localeHref(surface, item, within)}>{item.toUpperCase()}</a>)}
        </div>
      </div>
    </header>
    <main className="site-main" id="surface-main">{children}</main>
    <footer className="site-footer">
      <div>
        <strong>OpenPPWR</strong>
        <p>{t('assurance')}</p>
        {build && <p className="build-stamp" data-testid="build-stamp">
          {editionLabel(build, 'Community')} · {buildLabel(build, locale)}
        </p>}
      </div>
    </footer>
  </div>;
}

export function DemoSurface({ locale }) {
  const copy = surfaceText(demoCopy, locale);
  const t = (key) => surfaceText(surfaceCommon, locale)[key];
  useEffect(() => { document.title = `${copy.title} — OpenPPWR`; }, [copy.title]);
  return <SurfaceShell locale={locale} surface="demo" label={t('demoLabel')}>
    <section className="site-hero">
      <div>
        <p className="site-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p className="site-summary">{copy.summary}</p>
        <div className="hero-actions">
          {/* The demonstration hint is a plain flag in the path. No token, session identifier or
              secret is ever placed in a URL that crosses a host boundary. */}
          <a className="primary-link" data-testid="enter-workbench"
            href={localeHref('app', locale)}>{copy.enter}</a>
        </div>
        <p className="fiction">{t('fiction')}</p>
      </div>
    </section>
    <section className="process-ledger">
      <header><div><p className="site-eyebrow">E2E</p><h2>{copy.stepsTitle}</h2></div></header>
      <ol>{copy.steps.map(([name, detail], index) => <li key={name}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{name}</strong>
        <p>{detail}</p>
      </li>)}</ol>
    </section>
    {/* The first of those steps is "load 32 packaging records from JSON or CSV", and until now this
        page named the files and offered none of them. On a mapped deployment it is worse than an
        omission: `openppwr.eu/{locale}/demo` redirects here, and the marketing page it redirects away
        from is one of only two that carried the download list at all. */}
    <SampleDownloads locale={locale} />
    <section className="page-sections">
      <article><h2>{copy.rolesTitle}</h2><p>{copy.rolesIntro}</p></article>
    </section>
    <RoleMatrix locale={locale} />
    <section className="page-sections">
      <article><h2>{copy.resetTitle}</h2><p>{copy.resetBody}</p></article>
      <article><h2>{copy.accessTitle}</h2><p>{copy.accessBody}</p></article>
    </section>
  </SurfaceShell>;
}

export function StatusSurface({ locale }) {
  const copy = surfaceText(statusCopy, locale);
  const t = (key) => surfaceText(surfaceCommon, locale)[key];
  const build = useBuildInfo();
  useEffect(() => { document.title = `${copy.title} — OpenPPWR`; }, [copy.title]);
  return <SurfaceShell locale={locale} surface="status" label={t('statusLabel')}>
    <section className="site-hero">
      <div>
        <p className="site-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p className="site-summary">{copy.summary}</p>
      </div>
      <aside className="evidence-plate" aria-label={t('build')} data-testid="status-build">
        <p>{t('build')}</p>
        {build ? <>
          <div><span>{t('version')}</span><strong>{build.version}</strong></div>
          <div><span>Build</span><strong>{build.revisionShort}</strong></div>
          <div><span>{t('channel')}</span><strong>{build.channel}</strong></div>
          <div><span>{t('migrations')}</span><strong>{build.migrationLevel}</strong></div>
          <small>{t('builtAt')}: {build.builtAt}</small>
        {/* An em-dash said nothing at all: the one moment this page exists for — the deployment not
            answering — read as a blank field. It states that the build could not be read from here and
            claims no cause, because the page cannot tell an unreachable service from a proxy refusing
            the route. */}
        </> : <div><strong>{t('unavailable')}</strong></div>}
      </aside>
    </section>
    <section className="page-sections">
      <article><h2>{copy.componentsTitle}</h2>
        <ul>{copy.components.map(([name, detail]) => <li key={name}><strong>{name}</strong> — {detail}</li>)}</ul>
      </article>
      <article><h2>{copy.incidentsTitle}</h2><p>{copy.incidentsBody}</p></article>
      <article><h2>{copy.notClaimedTitle}</h2>
        <ul>{copy.notClaimed.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>
    </section>
  </SurfaceShell>;
}

export function CommunitySurface({ locale }) {
  const copy = surfaceText(communityCopy, locale);
  const t = (key) => surfaceText(surfaceCommon, locale)[key];
  useEffect(() => { document.title = `${copy.title} — OpenPPWR`; }, [copy.title]);
  return <SurfaceShell locale={locale} surface="community" label={t('communityLabel')}>
    <section className="site-hero">
      <div>
        <p className="site-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p className="site-summary">{copy.summary}</p>
      </div>
    </section>
    <section className="page-sections">
      <article><h2>{copy.stateTitle}</h2>
        <ul>{copy.state.map(([name, detail]) => <li key={name}><strong>{name}</strong> — {detail}</li>)}</ul>
      </article>
      <article><h2>{copy.contentsTitle}</h2>
        <ul>{copy.contents.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>
      <article><h2>{copy.excludedTitle}</h2>
        <ul>{copy.excluded.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>
    </section>
  </SurfaceShell>;
}

export function DocsSurface({ locale, path }) {
  const t = (key) => surfaceText(surfaceCommon, locale)[key];
  const slug = path[0] || '';
  return <SurfaceShell locale={locale} surface="docs" label={t('docsLabel')} within={slug}>
    <DocsPortal locale={locale} slug={slug} />
  </SurfaceShell>;
}

export const SURFACE_COMPONENTS = { demo: DemoSurface, status: StatusSurface, community: CommunitySurface };

export function isKnownSurface(name) {
  return Object.keys(RUNTIME.hosts).includes(name);
}
