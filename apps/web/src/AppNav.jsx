// Application navigation for the workbench.
//
// The workbench previously had a title, a language selector and a fiction notice. There was no way to
// reach the documentation, the product site or the status page, no statement of which build was
// running, and no visible session expiry — so a user whose session had quietly ended had nothing to
// read that explained it.

import { useState } from 'react';
import { buildLabel, editionLabel } from './build-info.js';
import { Locked, lockOf } from './Locked.jsx';
import { localeHref } from './runtime.js';
import { siteNavItems } from './site-nav.js';
import { SUPPORTED_LOCALES, translate } from './i18n.js';

const WORKFLOW_ANCHORS = [
  ['import', 'importTitle'], ['catalog', 'catalogTitle'], ['evidence', 'evidenceTitle'],
  ['assessment', 'assessmentTitle'], ['gaps', 'gapsTitle'], ['dossier', 'dossierTitle'],
];

export function AppNav({ locale, onLocaleChange, identity, build, onSignOut, busy }) {
  const t = (key) => translate(locale, key);
  const [open, setOpen] = useState(false);
  return <header className="app-nav" data-testid="app-nav">
    {/* The site-level navigation, above the workbench's own. The workbench is one surface of a
        product whose other surfaces were reachable only from the marketing header, so a user working
        here had no route to Product, Community, Cloud, Connect, Regulatory or Services at all. It sits
        outside the collapsible panels because it is the superior navigation: it does not belong behind
        the same control as the workflow anchors it precedes. */}
    <nav aria-label={t('navSite')} className="app-nav-site" data-testid="app-nav-site">
      {siteNavItems(locale).map((item) => <a key={item.key} href={item.href}>{item.label}</a>)}
    </nav>
    <div className="app-nav-bar">
      <a className="wordmark" href="#workspace">
        <strong>OpenPPWR</strong><span>{editionLabel(build, 'Community')}</span>
      </a>
      {/* One control reveals both menus on a narrow viewport. Two independent disclosures in a
          header this small produce a menu that opens on top of another menu. */}
      <button type="button" className="quiet app-nav-toggle" aria-expanded={open}
        aria-controls="app-nav-panels" onClick={() => setOpen((value) => !value)}>
        {open ? t('navClose') : t('navMenu')}
      </button>
      <div className={`app-nav-panels${open ? ' open' : ''}`} id="app-nav-panels">
        <nav aria-label={t('navPrimary')} className="app-nav-primary">
          {WORKFLOW_ANCHORS.map(([anchor, key]) => <a key={anchor} href={`#${anchor}`}>{t(key)}</a>)}
        </nav>
        <nav aria-label={t('navProduct')} className="app-nav-product">
          <a href="#roles">{t('navRoles')}</a>
          <a href={localeHref('demo', locale)}>{t('navDemoProcess')}</a>
          {/* Documentation is not repeated here. The site-level navigation above already carries it,
              at the identical address in both deployment shapes, and one header offering the same word
              twice for the same destination reads as a defect rather than as a convenience. */}
          <a href={localeHref('marketing', locale)}>{t('navProductSite')}</a>
          <a href={localeHref('status', locale)}>{t('navStatus')}</a>
        </nav>
        <div className="app-nav-account" aria-label={t('navAccount')}>
          <label>{t('language')}
            <select data-testid="locale" value={locale} onChange={(event) => onLocaleChange(event.target.value)}>
              {SUPPORTED_LOCALES.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
            </select>
          </label>
          {identity && <div className="app-nav-identity" data-testid="nav-identity">
            <span>{t('role')}: <strong>{t(`role_${identity.role}`)}</strong></span>
            <span>{t('tenant')}: <code>{identity.tenantId}</code></span>
            {identity.expiresAt && <span>{t('sessionExpires')}: {new Date(identity.expiresAt).toLocaleString(locale)}</span>}
            {/* The workbench's one remaining unexplained dead button. It is only ever locked while
                another operation runs, which is the least interesting of the four reasons — and exactly
                why it was the one left behind: nobody looks twice at a control that is grey for a
                second. It reads the same declaration as the twenty-seven in the workflow, so the guard
                covers it and a future control added to this header cannot avoid the same rule. */}
            <Locked t={t} id="nav-sign-out" className="quiet" lock={lockOf({busy})} onClick={onSignOut}>{t('signOut')}</Locked>
          </div>}
        </div>
      </div>
    </div>
    {build && <p className="app-nav-build" data-testid="nav-build">
      {t('navBuild')}: <code>{build.revisionShort}</code> · {buildLabel(build, locale)} · {build.migrationLevel}
    </p>}
  </header>;
}
