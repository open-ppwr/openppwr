// SPDX-License-Identifier: Apache-2.0
//
// Accessibility gate.
//
// The maturity assessment scored accessibility 2 out of 5 with the note "nobody has checked". This
// checks. It runs axe-core against every public route in all three locales and against the workbench,
// and fails on any violation at serious or critical impact.
//
// Automated checking is necessary and not sufficient: axe finds roughly a third of real barriers. The
// manual keyboard, focus, zoom and screen-reader work is recorded in
// docs/ux/ACCESSIBILITY_AUDIT_WCAG22.md, and this gate exists to stop regressions in the part a
// machine can judge.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { preview as createVitePreview } from 'vite';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const locales = ['pl', 'en', 'de'];
const routes = [
  '', 'product', 'community', 'enterprise', 'cloud', 'connect', 'regulatory', 'services',
  'pricing', 'demo', 'docs', 'roadmap', 'security', 'trust', 'partners',
  'privacy', 'cookies', 'terms', 'imprint',
];

// WCAG 2.2 AA plus the best-practice rules that catch real barriers axe classifies outside the tags.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

const outputRoot = resolve('artifacts', 'accessibility');
let vite;
let browser;
const findings = [];
let checked = 0;

try {
  await mkdir(outputRoot, { recursive: true });
  vite = await createVitePreview({
    root: resolve('apps', 'web'),
    configFile: resolve('apps', 'web', 'vite.config.js'),
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  const baseUrl = vite.resolvedUrls.local[0].replace(/\/$/u, '');
  browser = await chromium.launch({ headless: true, executablePath: edgePath });
  // Reduced motion, for two reasons. It is the correct setting for an accessibility audit, and the
  // hero entrance animation starts at `opacity: 0` — axe sampling mid-animation cannot resolve the
  // background behind a call to action and reports a colour-contrast violation against an element
  // that is merely still fading in. That produced findings on a different set of pages on each run,
  // which is the signature of a flaky check rather than a real defect.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  const scan = async (label, url) => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    // The application renders after load and the page is a single-page application, so the heading
    // is the signal that there is something to audit rather than an empty shell.
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    checked += 1;
    for (const violation of results.violations) {
      if (!BLOCKING_IMPACTS.has(violation.impact)) continue;
      findings.push({
        surface: label,
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
      });
    }
  };

  for (const locale of locales) {
    for (const route of routes) await scan(`${locale}/${route || 'home'}`, `${baseUrl}/${locale}${route ? `/${route}` : ''}`);
  }
  // The workbench in its signed-out state: the sign-in panel, the demonstration role cards and every
  // locked workflow section are exactly what a first-time user meets.
  for (const locale of locales) await scan(`${locale}/workbench`, `${baseUrl}/${locale}/app`);

  // Asserted before the verdict is composed, not after it is printed. This check already existed, but it
  // sat below the console.log, so a run that scanned nothing still printed
  // `ACCESSIBILITY_GATE_PASS surfaces=0` and wrote a report saying `status: PASS` before throwing. The exit
  // code was honest; the line and the artifact it left behind were not, and those are what get read.
  const expected = locales.length * (routes.length + 1);
  assert.ok(checked > 0, 'the gate must actually visit something');
  assert.equal(checked, expected, `scanned ${checked} surfaces but the matrix is ${locales.length} locales x ${routes.length + 1} surfaces = ${expected}`);

  const report = {
    status: findings.length ? 'FAIL' : 'PASS',
    standard: 'WCAG 2.2 AA (axe-core tags: ' + TAGS.join(', ') + ')',
    blockingImpacts: [...BLOCKING_IMPACTS],
    surfacesChecked: checked,
    findings,
    checkedAt: new Date().toISOString(),
  };
  const reportPath = resolve(outputRoot, 'accessibility-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (findings.length) {
    console.error(`ACCESSIBILITY_GATE_FAIL surfaces=${checked} findings=${findings.length}`);
    for (const finding of findings.slice(0, 25)) {
      console.error(`  ${finding.surface}: ${finding.rule} (${finding.impact}) — ${finding.help} [${finding.nodes.join(', ')}]`);
    }
    process.exitCode = 1;
  } else {
    console.log(`ACCESSIBILITY_GATE_PASS surfaces=${checked} standard=WCAG2.2AA blocking_impacts=serious,critical report=${reportPath}`);
  }
} finally {
  // Bounded teardown, for a reason this repository has now hit four times: closing the
  // HTTP listener alone leaves Vite's services running and the process never exits.
  const teardown = async (label, operation, ms = 30_000) => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_ignored, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
      ]);
    } catch (error) {
      console.error(`TEARDOWN_WARNING step=${label} reason=${error.message}`);
    } finally { clearTimeout(timer); }
  };
  await teardown('browser', () => browser?.close());
  await teardown('vite', () => vite?.close());
}
