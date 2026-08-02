import { useEffect } from 'react';
import { LEGAL_ROUTES, processSteps, scopeHeading, SITE_ROUTES, siteCommon, siteLocale, sitePage } from './site-content.js';
import { LEGAL_LAST_UPDATED, PRIVATE_ROUTES, sectionsFor } from './site-sections.js';
import { SampleDownloads } from './Downloads.jsx';
import { applyDocumentMeta } from './site-meta.js';
import { buildLabel, editionLabel, useBuildInfo } from './build-info.js';
import { DOCS_INDEX, docsChrome } from './docs-content.js';
import { localeHref } from './runtime.js';
// The primary entries and their labels are shared with the workbench header, which renders the same
// site-level navigation. See site-nav.js.
import { routeLabel, SITE_NAV } from './site-nav.js';

const navPrimary=SITE_NAV;
const family=['community','cloud','enterprise','connect','regulatory','services'];

// The address is a page that does not exist.
//
// `sitePage` falls back to the home copy for any route it does not know, so `/{locale}/anything` served
// the marketing homepage under the wrong URL — with the homepage's title and description, and a
// canonical link naming the address that does not exist. The page is now stated as missing and asks not
// to be indexed. The HTTP status is still 200: the static server answers every unmatched path with the
// application shell (apps/web/server.mjs), and only that server can set a status code.
function applyNotFoundMeta(lang,title,description){
  if(typeof document==='undefined')return;
  document.title=title;
  document.documentElement.lang=lang;
  for(const [name,content] of [['description',description],['robots','noindex']]){
    let element=document.head.querySelector(`meta[name="${name}"]`);
    if(!element){element=document.createElement('meta');element.setAttribute('name',name);document.head.appendChild(element);}
    element.setAttribute('content',content);
  }
}

export function Site({locale='en',route='home'}){
  const lang=siteLocale(locale);
  const copy=sitePage(lang,route);
  const common=(key)=>siteCommon(lang,key);
  const known=route==='home'||SITE_ROUTES.includes(route)||LEGAL_ROUTES.includes(route);
  const legal=LEGAL_ROUTES.includes(route);
  const label=(key)=>routeLabel(lang,key);
  const href=(target)=>`/${lang}${target==='home'?'':`/${target}`}`;
  const sections=sectionsFor(lang,route);
  // These two routes carry the sample files on a single-host deployment, where they are the pages a
  // reader reaches. On a mapped deployment both redirect off this host, so they are no longer the only
  // place the files are offered — see Downloads.jsx.
  const downloads=['demo','docs'].includes(route);
  const build=useBuildInfo();
  const withheld=PRIVATE_ROUTES.includes(route);
  useEffect(()=>{
    if(known)applyDocumentMeta(lang,route);
    else applyNotFoundMeta(lang,siteCommon(lang,'notFound'),siteCommon(lang,'notFoundBody'));
  },[lang,route,known]);
  return <div className="site-shell">
    {/* WCAG 2.4.1. Two navigation landmarks precede the content on every page, so a keyboard user
        would otherwise tab through the whole header before reaching what they came for. */}
    <a className="skip-link" href="#site-main">{common('skipToContent')}</a>
    <header className="site-header">
      <a className="wordmark" href={href('home')} aria-label={common('backHome')}><strong>{common('brand')}</strong><span>{editionLabel(build,common('edition'))}</span></a>
      <nav aria-label={common('nav')}>{navPrimary.map((item)=><a key={item} className={route===item?'active':''} href={href(item)}>{label(item)}</a>)}</nav>
      <div className="site-tools"><a className="workbench-link" href={localeHref('app',lang)}>{common('openWorkbench')}</a><LocaleLinks locale={lang} route={route}/></div>
    </header>
    <main className="site-main" id="site-main">
      {!known?<NotFoundPage common={common} href={href}/>:withheld?<WithheldPage common={common} href={href}/>:legal?<LegalPage copy={copy} common={common} sections={sections}/>:<>
        <section className="site-hero">
          <div><p className="site-eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p className="site-summary">{copy.summary}</p><div className="hero-actions"><a className="primary-link" href={route==='community'?localeHref('app',lang):href('community')}>{route==='community'?common('openWorkbench'):common('viewCommunity')}</a><StatusBadge value={copy.status} common={common}/></div></div>
          <EvidencePlate locale={lang} build={build}/>
        </section>
        <section className="scope-grid"><div><h2>{scopeHeading(lang,route,common('scope'))}</h2><ul>{copy.points.map((point)=><li key={point}>{point}</li>)}</ul></div><ProductFamily locale={lang} route={route} common={common} label={label} href={href}/></section>
        {(route==='home'||route==='product'||route==='community')&&<ProcessLedger locale={lang} common={common}/>}
        {route==='docs'&&<DocsSignpost locale={lang} common={common}/>}
        {sections&&<PageSections sections={sections}/>}
        {downloads&&<SampleDownloads locale={lang}/>}
      </>}
    </main>
    <footer className="site-footer"><div><strong>{common('brand')}</strong><p>{common('assurance')}</p><p>{common('fiction')}</p>{build&&<p className="build-stamp" data-testid="build-stamp">{editionLabel(build,common('edition'))} · {buildLabel(build,lang)}</p>}</div><nav>{[...SITE_ROUTES.filter((item)=>!navPrimary.includes(item)),...LEGAL_ROUTES].filter((item)=>!PRIVATE_ROUTES.includes(item)).map((item)=><a key={item} href={href(item)}>{label(item)}</a>)}</nav></footer>
  </div>;
}

// A route the owner has withheld. It answers, rather than 404s, because the URL is legitimate and a
// reader who followed a link deserves to know the page exists and is not ready — not to be told it
// does not exist. It carries no draft banner and no fragment of the unapproved content.
function WithheldPage({common,href}){
  return <section className="legal-page withheld-page" data-testid="withheld-route">
    <h1>{common('routeUnavailable')}</h1>
    <p className="site-summary">{common('routeUnavailableBody')}</p>
    <div className="hero-actions"><a className="primary-link" href={href('product')}>{common('routeUnavailableAction')}</a></div>
  </section>;
}

// A route that is not published and never was. Distinct from the withheld page, which answers for a
// legitimate address whose content is not approved yet.
function NotFoundPage({common,href}){
  return <section className="legal-page not-found-page" data-testid="not-found">
    <h1>{common('notFound')}</h1>
    <p className="site-summary">{common('notFoundBody')}</p>
    <div className="hero-actions"><a className="primary-link" href={href('home')}>{common('backHome')}</a></div>
  </section>;
}

function LocaleLinks({locale,route}){return <div className="locale-links" aria-label="Language">{['pl','en','de'].map((item)=><a key={item} className={item===locale?'active':''} href={`/${item}${route==='home'?'':`/${route}`}`}>{item.toUpperCase()}</a>)}</div>;}
function StatusBadge({value,common}){return <span className={`status-badge status-${value}`}>{common('status')}: {common(value)}</span>;}
function EvidencePlate({locale,build}){const labels={en:['32 packages','90 audit events','4 outcomes','4 dossier artifacts'],pl:['32 opakowania','90 zdarzeń audytu','4 wyniki','4 artefakty dossier'],de:['32 Verpackungen','90 Audit-Ereignisse','4 Ergebnisse','4 Dossier-Artefakte']}[locale];return <aside className="evidence-plate" aria-label="Reference evidence"><p>REFERENCE RUN / {build?build.revisionShort:'—'}</p>{labels.map((item,index)=><div key={item}><span>{String(index+1).padStart(2,'0')}</span><strong>{item}</strong></div>)}<small>PASS 20 · FAIL 1 · UNKNOWN 1 · N/A 10</small></aside>;}
function ProductFamily({locale,route,common,label,href}){const statuses={community:'beta',cloud:'privateBeta',enterprise:'planned',connect:'planned',regulatory:'regulatoryDependency',services:'available'};return <div><h2>{common('boundary')}</h2><div className="family-list">{family.map((item)=><a key={item} className={route===item?'current':''} href={href(item)}><span>{label(item)}</span><small>{common(statuses[item])}</small></a>)}</div></div>;}
function ProcessLedger({locale,common}){return <section className="process-ledger"><header><div><p className="site-eyebrow">E2E / COMMUNITY</p><h2>{common('process')}</h2></div><p>{common('processNote')}</p></header><ol>{processSteps[locale].map((step,index)=><li key={step}><span>{String(index+1).padStart(2,'0')}</span><strong>{step}</strong></li>)}</ol></section>;}
// The documentation lives on its own host. This is a signpost to it, with each topic linking to the
// page that answers it.
//
// It replaces an inventory of sixteen cards whose entire body read "Repository documentation" — true,
// and useless to a reader who had come here to read the documentation.
function DocsSignpost({locale,common}){
  return <section className="docs-inventory">
    <h2>{docsChrome[locale]?.heading||docsChrome.en.heading}</h2>
    <div>{DOCS_INDEX.map((entry,index)=><article key={entry.slug}>
      <span>{String(index+1).padStart(2,'0')}</span>
      <a href={localeHref('docs',locale,entry.slug)}><strong>{entry.title}</strong></a>
      <small>{entry.purpose}</small>
    </article>)}</div>
  </section>;
}
function PageSections({sections}){return <section className="page-sections" data-testid="page-sections">{sections.map((section)=><article key={section.h}><h2>{section.h}</h2>{section.p&&<p>{section.p}</p>}{section.items&&<ul>{section.items.map((item)=><li key={item}>{item}</li>)}</ul>}</article>)}</section>;}

// Every published legal page is finished. The one that is not is withheld instead, so this component
// no longer needs a draft state at all.
//
// Finished is not the same as reviewed. No qualified legal counsel has read the privacy, cookie or
// company text, and the owner decided on 2026-08-01 that none will before release. The mitigation is
// this notice: it sits above the text it describes, on every legal page and in every locale, because a
// reader who has already read the notice cannot be told afterwards that nobody checked it. It is not a
// draft marker — the text is not a draft, it is finished and unreviewed, which is a different fact and
// is stated as one.
function LegalPage({copy,common,sections}){
  return <section className="legal-page">
    <p className="site-eyebrow">{common('legal')}</p>
    <h1>{copy.title}</h1>
    <p className="site-summary">{copy.summary}</p>
    <aside className="legal-disclaimer" data-testid="legal-disclaimer"><h2>{common('legalNotice')}</h2><p>{common('legalNoticeBody')}</p></aside>
    {sections&&<PageSections sections={sections}/>}
    {/* A finished page carries a date, not a permanent review notice. */}
    <p className="legal-updated" data-testid="legal-updated">{common('lastUpdated')}: {LEGAL_LAST_UPDATED}</p>
    <div className="legal-requirements"><h2>{common('review')}</h2><p>{common('assurance')}</p></div>
  </section>;
}
