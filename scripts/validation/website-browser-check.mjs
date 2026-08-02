// Renders every localized marketing route in a real browser and asserts the expanded
// content, SEO head tags and hreflang alternates are actually present in the DOM.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { preview as createVitePreview } from 'vite';
import { LEGAL_ROUTES, SITE_ROUTES } from '../../apps/web/src/site-content.js';
import { pageSections } from '../../apps/web/src/site-sections.js';
import { metaFor } from '../../apps/web/src/site-meta.js';
// Bounded, because a teardown that cannot finish must not become the thing that hangs the gate.
import { boundedStep } from '../testing/bounded-teardown.mjs';

const edgePath='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const locales=['en','pl','de'];
const routes=['home',...SITE_ROUTES,...LEGAL_ROUTES];
let vite;
let browser;
const failures=[];
let checked=0;

try{
  vite=await createVitePreview({root:resolve('apps','web'),configFile:resolve('apps','web','vite.config.js'),preview:{host:'127.0.0.1',port:0,strictPort:false}});
  const base=vite.resolvedUrls.local[0].replace(/\/$/,'');
  browser=await chromium.launch({headless:true,executablePath:edgePath});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',(error)=>pageErrors.push(`${error.message}`));

  for(const locale of locales){
    for(const route of routes){
      const path=`/${locale}${route==='home'?'':`/${route}`}`;
      const response=await page.goto(`${base}${path}`,{waitUntil:'networkidle'});
      if(!response||response.status()>=400){failures.push(`${path}: HTTP ${response?.status()}`);continue;}

      const expected=metaFor(locale,route);
      const title=await page.title();
      if(title!==expected.t)failures.push(`${path}: title "${title}" != "${expected.t}"`);
      const description=await page.getAttribute('meta[name="description"]','content');
      if(description!==expected.d)failures.push(`${path}: description mismatch`);
      const canonical=await page.getAttribute('link[rel="canonical"]','href');
      if(!canonical||!canonical.endsWith(path))failures.push(`${path}: canonical "${canonical}" does not match route`);
      for(const alternate of locales){
        const href=await page.getAttribute(`link[rel="alternate"][hreflang="${alternate}"]`,'href');
        const expectedPath=`/${alternate}${route==='home'?'':`/${route}`}`;
        if(!href||!href.endsWith(expectedPath))failures.push(`${path}: hreflang ${alternate} missing or wrong`);
      }
      const htmlLang=await page.getAttribute('html','lang');
      if(htmlLang!==locale)failures.push(`${path}: html lang "${htmlLang}" != "${locale}"`);

      if(await page.locator('h1').count()!==1)failures.push(`${path}: expected exactly one h1`);

      const sections=pageSections[locale]?.[route];
      if(sections){
        const rendered=await page.locator('[data-testid="page-sections"] article').count();
        if(rendered!==sections.length)failures.push(`${path}: rendered ${rendered} sections, expected ${sections.length}`);
        const text=await page.locator('[data-testid="page-sections"]').innerText();
        if(text.trim().length<600)failures.push(`${path}: rendered section text is too thin (${text.trim().length} chars)`);
      }
      checked+=1;
    }
  }
  if(pageErrors.length)failures.push(`page errors: ${[...new Set(pageErrors)].join(' | ')}`);
}finally{
  await boundedStep('browser close', () => browser?.close(), 30_000);
  // `vite.httpServer.close()` closes the HTTP listener and nothing else. Vite keeps an esbuild service
  // running as a child process, and closing the listener leaves it alive — which is the first recorded
  // instance of the hang class this repository has now hit five times, present here verbatim in a stage
  // that was only wired into the gate today. `vite.close()` is the call that tears the server down,
  // bounded because a teardown that cannot finish must not become the thing that hangs the gate.
  await boundedStep('vite close', () => vite?.close(), 30_000);
}

if(failures.length){console.error(`WEBSITE_BROWSER_FAIL\n${failures.join('\n')}`);process.exitCode=1;}
else{
  // `pages=0` was reachable and printed PASS: nothing here required the loop to have run. If the route
  // or locale lists ever come back empty — a bad import, a renamed export — every check is skipped and
  // `failures` stays empty, which is the empty-input shape of the same lie a crashed gate tells. A clean
  // run must have visited the whole matrix, so the count is asserted against it rather than merely printed.
  const expected=locales.length*routes.length;
  assert.ok(checked>0,'WEBSITE_BROWSER visited no pages — the route matrix was empty');
  assert.equal(checked,expected,`WEBSITE_BROWSER visited ${checked} pages but the matrix is ${locales.length} locales x ${routes.length} routes = ${expected}`);
  console.log(`WEBSITE_BROWSER_PASS pages=${checked} locales=${locales.join(',')} routes=${routes.length}`);
}
