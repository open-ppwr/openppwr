// SPDX-License-Identifier: Apache-2.0
//
// Live content-marker gate.
//
// `REQUIRES HUMAN DE REGULATORY REVIEW` was rendered on a public page in all three locales, and every
// documentation card read `Repository documentation`. Both reached a deployed, owner-visible surface,
// and no check existed that would have objected.
//
// The scan runs against the **built bundle**, not the source tree, because a marker composed at
// runtime from a translation key is invisible to a grep of the component that renders it — which is
// exactly how the German workbench marker survived every earlier review.
//
//   npm run build --workspace=@openppwr/web && node scripts/validation/content-marker-gate.mjs

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../apps/web/dist/client', import.meta.url));

// Anything here must never reach a rendered page.
const FORBIDDEN = [
  'REQUIRES HUMAN',
  'REQUIRES OWNER',
  'DRAFT —',
  'PROJEKT —',
  'ENTWURF —',
  'WYMAGA PRZEGL',
  'PRÜFUNG DURCH INHABER',
  'Repository documentation',
  'documentation inventory',
  'PLACEHOLDER',
  'TODO:',
  'FIXME',
  'Lorem ipsum',
  'coming soon',
  'Coming soon',
];

// Empty, and it should stay empty.
//
// It previously held the three Terms draft banners, on the reasoning that an unreviewed Terms page
// which says so is better than one which hides it. The owner decided the stronger position: an
// unreviewed Terms page is not published at all. Its content was removed from the bundle entirely
// and lives in the legal review pack, where the reviewer needs it and no visitor sees
// it, so there is nothing left to permit.
//
// Adding an entry here means shipping an admission of unfinished work to a reader. Withhold the page
// instead.
const PERMITTED = [];

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (['.js', '.html', '.css'].includes(extname(entry.name))) yield path;
  }
}

const findings = [];
let scanned = 0;

for await (const path of files(root)) {
  const content = await readFile(path, 'utf8');
  scanned += 1;
  for (const marker of FORBIDDEN) {
    if (!content.includes(marker)) continue;
    // A permitted string may contain a forbidden substring. Remove every permitted occurrence first,
    // then ask again — otherwise the Terms banner would trip the `REQUIRES HUMAN` rule forever.
    let residue = content;
    for (const { text } of PERMITTED) residue = residue.replaceAll(text, '');
    if (residue.includes(marker)) findings.push(`${path.slice(root.length + 1)}: ${marker}`);
  }
}

if (!scanned) {
  console.error('CONTENT_MARKER_FAIL nothing was scanned — build the web workspace first');
  process.exitCode = 1;
} else if (findings.length) {
  console.error(`CONTENT_MARKER_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('  A marker that genuinely must be shown belongs in PERMITTED with a reason and a route to removal.');
  process.exitCode = 1;
} else {
  console.log(`CONTENT_MARKER_PASS files=${scanned} permitted=${PERMITTED.length}`);
  for (const { text, why } of PERMITTED) console.log(`  permitted: "${text}" — ${why}`);
}
