// The documentation portal.
//
// This replaces sixteen cards whose only body text was "Repository documentation" — an accurate
// statement that helped nobody who had come to the portal to read the documentation.

import { useEffect, useMemo, useState } from 'react';
import { DOCS_LAST_VALIDATED, docsChrome, docsIndexFor, docsPage } from './docs-content.js';
import { localeHref } from './runtime.js';

function CodeBlock({ text, copyLabel, copiedLabel }) {
  const [copied, setCopied] = useState(false);
  // Clipboard access is unavailable on an insecure origin and in some embedded browsers. The button
  // reports failure by simply not claiming success, rather than throwing into an unhandled promise.
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return <div className="doc-code">
    <button type="button" className="quiet doc-copy" onClick={copy}>{copied ? copiedLabel : copyLabel}</button>
    <pre><code>{text}</code></pre>
  </div>;
}

function Block({ block, chrome }) {
  if (block.kind === 'h') return <h2 id={block.text.toLowerCase().replaceAll(' ', '-')}>{block.text}</h2>;
  if (block.kind === 'p') return <p>{block.text}</p>;
  if (block.kind === 'ul') return <ul>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
  if (block.kind === 'code') return <CodeBlock text={block.text} copyLabel={chrome.copy} copiedLabel={chrome.copied} />;
  return null;
}

export function DocsPortal({ locale, slug }) {
  const chrome = docsChrome[locale] || docsChrome.en;
  const [query, setQuery] = useState('');
  const contents = useMemo(() => docsIndexFor(locale), [locale]);
  const page = slug ? docsPage(slug, locale) : null;
  const index = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return contents;
    return contents.filter((entry) => `${entry.title} ${entry.purpose}`.toLowerCase().includes(needle));
  }, [query, contents]);
  const position = page ? contents.findIndex((entry) => entry.slug === page.slug) : -1;
  const previous = position > 0 ? contents[position - 1] : null;
  const next = position >= 0 && position < contents.length - 1 ? contents[position + 1] : null;
  // The notice belongs on the pages that are actually English, and nowhere else. Showing it on a
  // translated page would be a false statement about the page the reader is looking at.
  const untranslated = locale !== 'en' && page && !page.translated;
  const anyUntranslated = locale !== 'en' && contents.some((entry) => !entry.translated);
  useEffect(() => {
    document.title = page ? `${page.title} — OpenPPWR ${chrome.heading}` : `${chrome.heading} — OpenPPWR`;
  }, [page, chrome.heading]);
  // An unrecognised slug is a wrong URL, not a reason to render an empty page. The index is the
  // useful answer, and the address bar already shows what was asked for.
  const headings = page ? page.body.filter((block) => block.kind === 'h') : [];
  return <div className="docs-portal">
    <aside className="docs-sidebar" aria-label={chrome.contents}>
      <h2>{chrome.contents}</h2>
      <label className="docs-search">
        <span className="visually-hidden">{chrome.search}</span>
        <input type="search" value={query} placeholder={chrome.search} data-testid="docs-search"
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ol>
        {index.map((entry, order) => <li key={entry.slug}>
          <a className={entry.slug === slug ? 'active' : ''} href={localeHref('docs',locale,entry.slug)}>
            <span>{String(contents.findIndex((item) => item.slug === entry.slug) + 1).padStart(2, '0')}</span>{entry.title}
          </a>
        </li>)}
      </ol>
      {!index.length && <p>{chrome.noResults}</p>}
    </aside>
    <article className="docs-body">
      {!page && <>
        <h1>{chrome.heading}</h1>
        <p className="site-summary">{chrome.intro}</p>
        {anyUntranslated && <p className="docs-notice" data-testid="docs-language-notice">{chrome.englishOnly}</p>}
        <div className="docs-cards">
          {contents.map((entry, order) => <a key={entry.slug} href={localeHref('docs',locale,entry.slug)}>
            <span>{String(order + 1).padStart(2, '0')}</span>
            <strong>{entry.title}</strong>
            <small>{entry.purpose}</small>
            {locale !== 'en' && !entry.translated && <em className="docs-lang-tag">{chrome.englishBody}</em>}
          </a>)}
        </div>
      </>}
      {page && <>
        <h1>{page.title}</h1>
        {untranslated && <p className="docs-notice" data-testid="docs-language-notice">{chrome.englishOnly}</p>}
        <dl className="doc-meta">
          <dt>{chrome.purpose}</dt><dd>{page.purpose}</dd>
          <dt>{chrome.audience}</dt><dd>{page.audience}</dd>
          {page.prerequisites.length > 0 && <>
            <dt>{chrome.prerequisites}</dt>
            <dd><ul>{page.prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></dd>
          </>}
        </dl>
        {headings.length > 1 && <nav className="doc-toc" aria-label={chrome.onThisPage}>
          <h2>{chrome.onThisPage}</h2>
          <ul>{headings.map((block) => <li key={block.text}>
            <a href={`#${block.text.toLowerCase().replaceAll(' ', '-')}`}>{block.text}</a>
          </li>)}</ul>
        </nav>}
        {page.body.map((block, order) => <Block key={`${block.kind}-${order}`} block={block} chrome={chrome} />)}
        <h2>{chrome.related}</h2>
        <ul className="doc-related">{page.related.map((target) => {
          const entry = contents.find((candidate) => candidate.slug === target);
          return entry ? <li key={target}><a href={localeHref('docs',locale,target)}>{entry.title}</a></li> : null;
        })}</ul>
        <p className="doc-validated"><small>{chrome.lastValidated}: {DOCS_LAST_VALIDATED}</small></p>
        <nav className="doc-pager" aria-label={chrome.contents}>
          {previous && <a href={localeHref('docs',locale,previous.slug)}>← {chrome.previous}: {previous.title}</a>}
          {next && <a href={localeHref('docs',locale,next.slug)}>{chrome.next}: {next.title} →</a>}
        </nav>
      </>}
    </article>
  </div>;
}
