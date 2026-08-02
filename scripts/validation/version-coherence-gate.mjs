// SPDX-License-Identifier: Apache-2.0
//
// Version coherence gate — one version, said once, in every place that declares it.
//
//   node scripts/validation/version-coherence-gate.mjs
//
// A version bump is not one edit. It is fourteen manifests, a lockfile, a build argument, a release
// workflow that names the version in eight separate places, a deployment example an operator copies, a
// documentation portal in three languages, and a machine-checked contract that states which version it
// was verified against. Nothing compared them. The bump from `0.2.0-beta.1` to `1.0.0` was performed
// against a tree in which the release notes and upgrade notes for `1.0.0` had already been written and
// merged while every manifest, workflow and gate still said `0.2.0-beta.1` — a repository describing two
// different releases at once, with no check able to notice.
//
// The failure this prevents is not cosmetic. `validate-release-ref.mjs` derives the canonical image
// reference from `package.json`, so a manifest that disagrees with the workflow produces an image built
// under one identity and published under another, with an SBOM named after a third.
//
// Two questions are asked, and they are different questions.
//
// 1. **Coherence.** Every place that *declares* the current version says exactly what `package.json` says.
//    Read from the manifest rather than from a constant here, so this file never becomes a fifteenth
//    place that has to be edited during a bump.
//
// 2. **Residue.** No superseded version survives in a construct that would deploy, publish or identify
//    something. This deliberately does not look at prose. "Verified on 0.2.0-beta.1", "the defect that
//    broke the first bump to 0.2.0-beta.1", and a release-notes heading naming the release it describes
//    are all true sentences about the past, and a gate that deleted them would be falsifying a record to
//    make itself pass. So the residue scan matches only the syntactic forms in which this repository
//    states a *deployable or publishable identity* — an image reference, an archive name, a build
//    argument, a manifest field, an SBOM filename, a release tag. A sentence never matches one.
//
// ## The exemptions are derived, not listed
//
// A hand-maintained exemption list is how this class of gate dies: a document lands, somebody adds its
// path, and after a year the list is longer than the rule. Every exemption below is computed from the
// file itself, so a new historical record is exempt on the day it is written and a new *current* document
// is not:
//
//   1. **The file's own name contains a version.** `RELEASE_NOTES_0.2.0-beta.1.md` is that release's
//      document; saying `0.2.0-beta.1` inside it is its entire purpose.
//   2. **A path segment is a date stamp.** `docs/internal/audits/.../20260730-1744/` and the
//      `SESSION_REPORT_<date>_<time>.md` series are named after the moment they record. Written as a shape
//      rather than as one real file name: naming a withheld document is a disclosure even in a comment, and
//      the shape is what the rule is about anyway.
//   3. **The file is a test.** A literal in `*.test.mjs` is an input to an assertion — the rejected
//      references in `validate-release-ref.test.mjs` are the point of the test.
//   4. **The document pins itself to a past moment** in its own head matter: it names a full
//      forty-character commit SHA, carries a dated `Built`/`Run`/`Prepared`/`Date:` line, or declares
//      itself `SUPERSEDED`. A scan report of one image, an approval pack for one revision and a
//      supply-chain evidence record are records by their own first paragraph.
//
// Rule 4 is the weakest of the four and is stated as such: a *current* document that happens to quote a
// commit SHA near the top would be exempted with it. It is still a property of the document rather than a
// path somebody typed, and it fails in the safe direction — towards examining a file rather than towards
// trusting a list.
//
// Also asserted: the release notes and upgrade notes for the current version must exist. Enumerating them
// per release has been walked into once already — the `1.0.0` notes were written, passed every gate, and
// were reachable by nobody, because nothing connected "a release exists" to "its notes do".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ROOT_MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const DOCKERFILE = 'Dockerfile';
const WORKFLOW = '.github/workflows/release-image.yml';
const ENV_EXAMPLE = 'deploy/community/openppwr.env.example';
const CONTRACT = 'docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md';
const PORTAL = ['apps/web/src/docs-content.js', 'apps/web/src/docs-content-pl.js', 'apps/web/src/docs-content-de.js'];

const findings = [];
const fail = (message) => findings.push(message);
const read = (path) => readFileSync(path, 'utf8');
const quote = (value) => value.replaceAll('.', String.raw`\.`);

const version = JSON.parse(read(ROOT_MANIFEST)).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
  console.error(`VERSION_COHERENCE_FAIL findings=1\n  ${ROOT_MANIFEST} does not carry an exact SemVer version: ${JSON.stringify(version)}`);
  process.exit(1);
}
const V = quote(version);

// ---- 1. Manifests -------------------------------------------------------------------------------------
//
// Resolved from the workspace globs rather than from a count, so a package added tomorrow is checked
// tomorrow. The cross-dependencies matter as much as the versions: an `@openppwr/*` range that still names
// the previous version resolves to nothing on a clean install, which is a failure at `npm ci` time on
// somebody else's machine rather than here.
const workspaceDirectories = execFileSync('git', ['ls-files', '-z', 'apps/*/package.json', 'packages/*/package.json'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .sort();
const manifestPaths = [ROOT_MANIFEST, ...workspaceDirectories];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

for (const path of manifestPaths) {
  const manifest = JSON.parse(read(path));
  if (manifest.version !== version) {
    fail(`${path}: version is ${JSON.stringify(manifest.version)}, expected ${version}`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith('@openppwr/')) continue;
      if (range !== version) fail(`${path}: ${field}.${name} is ${JSON.stringify(range)}, expected ${version}`);
    }
  }
}
if (manifestPaths.length < 2) fail('no workspace manifests were resolved; the gate would pass by seeing nothing');

// ---- 2. Lockfile --------------------------------------------------------------------------------------
//
// A lockfile left behind by a manifest bump is not a cosmetic mismatch: `npm ci` refuses to install
// against it, so the first person to build from a clean checkout meets the failure, not the person who
// caused it.
const lockfile = JSON.parse(read(LOCKFILE));
if (lockfile.version !== version) fail(`${LOCKFILE}: top-level version is ${JSON.stringify(lockfile.version)}, expected ${version}`);
for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
  const isWorkspace = key === '' || key.startsWith('apps/') || key.startsWith('packages/');
  if (!isWorkspace || entry.link) continue;
  if (entry.version !== version) fail(`${LOCKFILE}: ${key || '<root>'} is ${JSON.stringify(entry.version)}, expected ${version}`);
}

// ---- 3. The image, and everything that names it -------------------------------------------------------
const declarations = [
  [DOCKERFILE, new RegExp(String.raw`^ARG OPENPPWR_VERSION=${V}$`, 'mu'), `ARG OPENPPWR_VERSION=${version}`],
  [WORKFLOW, new RegExp(String.raw`^\s*OPENPPWR_VERSION:\s*${V}\s*$`, 'mu'), `OPENPPWR_VERSION: ${version}`],
  [WORKFLOW, new RegExp(String.raw`^\s*OPENPPWR_RELEASE_TAG:\s*v${V}\s*$`, 'mu'), `OPENPPWR_RELEASE_TAG: v${version}`],
  [WORKFLOW, new RegExp(String.raw`^\s*OPENPPWR_IMAGE:\s*ghcr\.io/open-ppwr/openppwr:${V}\s*$`, 'mu'), `OPENPPWR_IMAGE: ghcr.io/open-ppwr/openppwr:${version}`],
  [WORKFLOW, new RegExp(String.raw`group:\s*community-image-${V}\s*$`, 'mu'), `concurrency group community-image-${version}`],
  [WORKFLOW, new RegExp(String.raw`tags:\s*type=raw,value=${V}\s*$`, 'mu'), `tags: type=raw,value=${version}`],
  [WORKFLOW, new RegExp(String.raw`OPENPPWR_VERSION=${V}\s*$`, 'mu'), `build argument OPENPPWR_VERSION=${version}`],
  [WORKFLOW, new RegExp(String.raw`openppwr-${V}\.spdx\.json`, 'u'), `SBOM name openppwr-${version}.spdx.json`],
  [WORKFLOW, new RegExp(String.raw`openppwr-${V}\.cyclonedx\.json`, 'u'), `SBOM name openppwr-${version}.cyclonedx.json`],
  [ENV_EXAMPLE, new RegExp(String.raw`^OPENPPWR_IMAGE=ghcr\.io/open-ppwr/openppwr:${V}$`, 'mu'), `OPENPPWR_IMAGE=ghcr.io/open-ppwr/openppwr:${version}`],
  ['apps/web/src/docs-content.js', new RegExp(String.raw`^export const DOCS_LAST_VALIDATED = '${V}';$`, 'mu'), `DOCS_LAST_VALIDATED = '${version}'`],
  [CONTRACT, new RegExp(String.raw`\|\s*Verified against version\s*\|\s*\x60${V}\x60\s*\|`, 'u'), `contract fact: verified against version ${version}`],
];
for (const path of PORTAL) {
  declarations.push([path, new RegExp(String.raw`docker build -t openppwr:${V} `, 'u'), `portal build command tagged openppwr:${version}`]);
}
for (const [path, expression, description] of declarations) {
  if (!expression.test(read(path))) fail(`${path}: does not declare ${description}`);
}

// ---- 4. The release's own notes ------------------------------------------------------------------------
for (const kind of ['RELEASE', 'UPGRADE']) {
  const path = `docs/release/${kind}_NOTES_${version}.md`;
  if (!existsSync(path)) fail(`${path}: the current release has no ${kind.toLowerCase()} notes`);
}

// ---- 5. Residue ----------------------------------------------------------------------------------------
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const OWN_NAMESPACE = String.raw`(?:ghcr\.io|docker\.io)/(?:open-ppwr|openppwr)`;
const OWN_REPOSITORY = String.raw`${OWN_NAMESPACE}/openppwr`;
// A trailing `-<hex>` is a local build tag naming one commit's image — `openppwr:0.2.0-beta.1-9faeb00` is
// a specific artefact that was built, not a reference anybody would deploy today, and every occurrence of
// one is a provenance record.
const NOT_A_BUILD_TAG = String.raw`(?![-.\w])`;
const CONSTRUCTS = [
  // Only a workspace `package.json`. A lockfile's `"version"` fields are overwhelmingly third-party, and
  // the workspace entries inside it are compared structurally above rather than by text.
  ['manifest version field', new RegExp(String.raw`"version"\s*:\s*"(${SEMVER})"`, 'gu'), (path) => /(?:^|\/)package\.json$/u.test(path)],
  ['workspace dependency range', new RegExp(String.raw`"@openppwr/[a-z-]+"\s*:\s*"(${SEMVER})"`, 'gu'), () => true],
  ['build argument', new RegExp(String.raw`OPENPPWR_VERSION[:=]\s*"?(${SEMVER})`, 'gu'), () => true],
  ['release tag variable', new RegExp(String.raw`OPENPPWR_RELEASE_TAG:\s*v(${SEMVER})`, 'gu'), () => true],
  // The repository is named, not just the image: `ghcr.io/example/openppwr:0.9.0` is the installer
  // validator's synthetic fixture and names no release of this product.
  ['image variable', new RegExp(String.raw`OPENPPWR_IMAGE[:=]\s*(?:${OWN_NAMESPACE}/)?openppwr:(${SEMVER})${NOT_A_BUILD_TAG}`, 'gu'), () => true],
  ['registry image reference', new RegExp(String.raw`${OWN_REPOSITORY}:(${SEMVER})${NOT_A_BUILD_TAG}`, 'gu'), () => true],
  ['image metadata tag', new RegExp(String.raw`type=raw,value=(${SEMVER})`, 'gu'), () => true],
  ['portal build command', new RegExp(String.raw`docker build -t openppwr:(${SEMVER})${NOT_A_BUILD_TAG}`, 'gu'), () => true],
  ['portal validated version', new RegExp(String.raw`DOCS_LAST_VALIDATED\s*=\s*'(${SEMVER})'`, 'gu'), () => true],
  ['release archive name', new RegExp(String.raw`openppwr-(${SEMVER})\.tar\.gz`, 'gu'), () => true],
  ['SBOM artefact name', new RegExp(String.raw`openppwr-(${SEMVER})\.(?:spdx|cyclonedx)\.json`, 'gu'), () => true],
  ['contract verified-against fact', new RegExp(String.raw`\|\s*Verified against version\s*\|\s*\x60(${SEMVER})\x60`, 'gu'), () => true],
];

const DATE_STAMP = /(?:^|[^0-9])(?:20\d{6}|20\d{2}-\d{2}-\d{2})(?:[^0-9]|$)/u;
const RECORD_HEAD_LINES = 40;

export function isDerivedExemption(path, text) {
  const segments = path.split('/');
  const basename = segments.at(-1);
  // 1. The file's own name carries a version.
  if (new RegExp(String.raw`(?:^|[_-])${SEMVER}(?:[_.-]|$)`, 'u').test(basename)) return 'named after a version';
  // 2. A path segment — directory or file — is a date stamp.
  if (segments.some((segment) => DATE_STAMP.test(segment))) return 'dated record path';
  // 3. A test file's literals are inputs to assertions.
  if (/\.test\.(?:mjs|js|cjs)$/u.test(basename)) return 'test fixture';
  // 4. The document pins itself to one past moment in its own head matter. Prose documents only: a
  // forty-character hexadecimal string near the top of a workflow is an action pinned to a commit, which
  // is the opposite of a historical record, and exempting `release-image.yml` on that basis would have
  // removed the single most important file from the scan.
  if (!basename.endsWith('.md')) return null;
  const head = text.split('\n').slice(0, RECORD_HEAD_LINES).join('\n');
  if (/\b[0-9a-f]{40}\b/u.test(head)) return 'record pinned to a commit';
  if (/\bSUPERSEDED\b/u.test(head)) return 'self-declared superseded';
  if (/\b(?:Built|Run|Prepared|Generated|Date:|Executed)\b[^\n]{0,40}20\d{2}-\d{2}-\d{2}/u.test(head)) return 'dated record';
  return null;
}

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let scanned = 0;
let exempted = 0;
for (const path of trackedFiles) {
  let text;
  try {
    text = read(path);
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  const exemption = isDerivedExemption(path, text);
  if (exemption) {
    exempted += 1;
    continue;
  }
  scanned += 1;
  for (const [description, expression, applies] of CONSTRUCTS) {
    if (!applies(path)) continue;
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      if (match[1] === version) continue;
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${path}:${line}: ${description} names ${match[1]}, but this release is ${version} — ${match[0].trim()}`);
    }
  }
}

if (findings.length) {
  console.error(`VERSION_COHERENCE_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`VERSION_COHERENCE_PASS version=${version} manifests=${manifestPaths.length} declarations=${declarations.length} scanned=${scanned} exempt=${exempted}`);
}
