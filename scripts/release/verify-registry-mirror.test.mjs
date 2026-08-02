// SPDX-License-Identifier: Apache-2.0
//
// Direct tests for the mirror manifest parser and inspect classifier.
//
// These exist because the first implementation put this logic inline in a workflow, where no test
// could reach it, and it held two defects in exactly the branches nothing
// exercised: an unparseable registry response was treated as a valid single manifest, and two empty
// platform sets compared equal and reported parity. Static assertions over the YAML text could not
// have caught either. These tests run the real script against fixtures; none of them needs a
// registry, credentials or a published image.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, 'verify-registry-mirror.sh');
const workdir = mkdtempSync(join(tmpdir(), 'openppwr-mirror-'));

const toPosix = (path) => (process.platform === 'win32'
  ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll('\\', '/')}`
  : path);

const bash = process.platform === 'win32'
  ? [process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'].join('\\')
  : '/bin/bash';

// jq ships on the GitHub-hosted runner; on a developer machine it may sit outside the default PATH.
const extraPath = process.platform === 'win32'
  ? `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe`
  : '';

let fixtureCounter = 0;
function fixture(contents) {
  const name = join(workdir, `fixture-${fixtureCounter++}.json`);
  writeFileSync(name, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return name;
}

function run(...args) {
  const result = spawnSync(bash, [toPosix(scriptPath), ...args.map((arg) => (arg.includes('\\') ? toPosix(arg) : arg))], {
    encoding: 'utf8',
    env: { ...process.env, PATH: extraPath ? `${extraPath};${process.env.PATH}` : process.env.PATH },
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

const ociManifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {}, layers: [] };
const dockerManifest = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: {}, layers: [] };
const ociIndex = (manifests) => ({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
const dockerList = (manifests) => ({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json', manifests });
const entry = (os, architecture, variant) => ({ digest: `sha256:${'a'.repeat(64)}`, platform: { os, architecture, ...(variant ? { variant } : {}) } });
const attestationEntry = () => ({
  digest: `sha256:${'b'.repeat(64)}`,
  platform: { os: 'unknown', architecture: 'unknown' },
  annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
});

// -------------------------------------------------------------------------------------------
// 9.1 media type
// -------------------------------------------------------------------------------------------
test('accepts an OCI single manifest', () => {
  const result = run('media-type', fixture(ociManifest));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'application/vnd.oci.image.manifest.v1+json');
});

test('accepts a Docker single manifest', () => {
  const result = run('media-type', fixture(dockerManifest));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'application/vnd.docker.distribution.manifest.v2+json');
});

test('accepts an OCI index', () => {
  const result = run('media-type', fixture(ociIndex([entry('linux', 'amd64')])));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'application/vnd.oci.image.index.v1+json');
});

test('accepts a Docker manifest list', () => {
  const result = run('media-type', fixture(dockerList([entry('linux', 'amd64')])));
  assert.equal(result.status, 0);
});

test('rejects invalid JSON rather than treating it as a single manifest', () => {
  const result = run('media-type', fixture('{"truncated": '));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/u);
});

test('rejects a manifest with no mediaType', () => {
  const result = run('media-type', fixture({ schemaVersion: 2, config: {} }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no mediaType/u);
});

test('rejects an unsupported mediaType', () => {
  const result = run('media-type', fixture({ schemaVersion: 2, mediaType: 'application/vnd.example.thing.v1+json' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported manifest mediaType/u);
});

test('rejects an empty file', () => {
  const result = run('media-type', fixture(''));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty/u);
});

test('rejects a wrong schemaVersion', () => {
  const result = run('media-type', fixture({ schemaVersion: 1, mediaType: 'application/vnd.oci.image.manifest.v1+json' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schemaVersion/u);
});

// -------------------------------------------------------------------------------------------
// 9.2 platforms
// -------------------------------------------------------------------------------------------
test('resolves a single manifest platform from the image config', () => {
  const result = run('platforms', fixture(ociManifest), fixture({ os: 'linux', architecture: 'amd64' }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'linux/amd64');
});

test('includes the variant when the image config carries one', () => {
  const result = run('platforms', fixture(ociManifest), fixture({ os: 'linux', architecture: 'arm64', variant: 'v8' }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'linux/arm64/v8');
});

test('fails when the image config has no os', () => {
  const result = run('platforms', fixture(ociManifest), fixture({ architecture: 'amd64' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no os/u);
});

test('fails when the image config has no architecture', () => {
  const result = run('platforms', fixture(ociManifest), fixture({ os: 'linux' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no architecture/u);
});

// Valid JSON that is not a usable document must be diagnosed as such. `jq -e .` reported
// exit 1 for `null` and for a truncated file alike, so both were called invalid JSON and an operator
// debugging a registry response of valid `null` was sent to the wrong place.
test('a null image config is reported as a null document, not as invalid JSON', () => {
  const result = run('platforms', fixture(ociManifest), fixture('null'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected a JSON object, got null/u);
});

test('a false image config is reported as a boolean document', () => {
  const result = run('platforms', fixture(ociManifest), fixture('false'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected a JSON object, got boolean/u);
});

test('a truncated document is still reported as invalid JSON', () => {
  const result = run('media-type', fixture('{"truncated": '));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /file is not valid JSON/u);
});

test('an empty JSON object parses but fails on the missing fields', () => {
  const result = run('platforms', fixture(ociManifest), fixture({}));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no os/u, 'must reach the field check, not stop at the parse check');
});

test('resolves a single-platform index', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64')])));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'linux/amd64');
});

test('resolves a multi-platform index', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), entry('linux', 'arm64', 'v8')])));
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.split('\n'), ['linux/amd64', 'linux/arm64/v8']);
});

test('excludes attestation manifests from the platform set', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), attestationEntry()])));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'linux/amd64');
});

test('fails when an index contains only attestations', () => {
  const result = run('platforms', fixture(ociIndex([attestationEntry()])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no runtime platform resolved/u);
});

test('fails on an empty manifests array', () => {
  const result = run('platforms', fixture(ociIndex([])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty/u);
});

test('fails when a runtime manifest carries no platform', () => {
  const result = run('platforms', fixture(ociIndex([{ digest: `sha256:${'c'.repeat(64)}` }])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither a runtime platform nor an attestation/u);
});

// The two clauses of the runtime predicate are not interchangeable. They overlap only on
// unknown/unknown, which was the one shape every fixture used -- so either clause could be deleted
// with nothing failing. One fixture per clause, each reachable only by the clause it protects.
test('an entry with an unknown os but a known architecture is rejected', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), entry('unknown', 'amd64')])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither a runtime platform nor an attestation/u);
});

test('an entry with a known os but an unknown architecture is rejected', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), entry('linux', 'unknown')])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither a runtime platform nor an attestation/u);
});

test('an entry with an empty os is rejected', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), { digest: `sha256:${'d'.repeat(64)}`, platform: { os: '', architecture: 'amd64' } }])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither a runtime platform nor an attestation/u);
});

test('the rejection names the offending digest', () => {
  const digest = `sha256:${'7'.repeat(64)}`;
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), { digest, platform: { os: 'linux', architecture: 'unknown' } }])));
  assert.match(result.stderr, new RegExp(digest, 'u'), 'an operator must be told which entry is wrong');
});

// An attestation placeholder is recognised by its platform even when the annotation is absent, which
// is the only case where the unknown/unknown clause of is_attestation carries the decision alone.
test('an unannotated unknown/unknown entry is treated as an attestation, not as malformed', () => {
  const index = fixture(ociIndex([entry('linux', 'amd64'), { digest: `sha256:${'e'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } }]));
  const platforms = run('platforms', index);
  assert.equal(platforms.status, 0);
  assert.equal(platforms.stdout, 'linux/amd64');
  assert.equal(run('attestation-count', index).stdout, '1');
});

// The mirror image of the previous case: an entry the annotation alone identifies as an attestation.
// Referrers layouts exist that give an attestation manifest the platform of its subject, and without
// this fixture the annotation clause could be deleted with nothing failing.
test('an annotated attestation carrying a real platform is not counted as one', () => {
  const index = fixture(ociIndex([
    entry('linux', 'amd64'),
    { digest: `sha256:${'f'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
  ]));
  const platforms = run('platforms', index);
  assert.equal(platforms.status, 0);
  assert.equal(platforms.stdout, 'linux/amd64', 'the annotated entry must not appear as a runtime platform');
  assert.equal(run('attestation-count', index).stdout, '1');
});

// The platform filter and the attestation counter used different predicates, so an entry
// could be counted by neither and disappear from the evidence without a diagnostic.
test('every manifest is accounted for as either a platform or an attestation', () => {
  const manifests = [entry('linux', 'amd64'), entry('linux', 'arm64', 'v8'), attestationEntry()];
  const index = fixture(ociIndex(manifests));
  const platforms = run('platforms', index);
  const attestations = run('attestation-count', index);
  assert.equal(platforms.status, 0);
  const platformCount = platforms.stdout.split('\n').filter(Boolean).length;
  assert.equal(
    platformCount + Number(attestations.stdout),
    manifests.length,
    'platforms plus attestations must equal the manifests in the index',
  );
});

test('de-duplicates repeated platforms', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux', 'amd64'), entry('linux', 'amd64')])));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'linux/amd64');
});

// These pass every presence check and are caught only by the shape validation, which is what makes
// them worth asserting: without them, removing that check breaks nothing visible.
test('rejects a platform whose fields are present but malformed', () => {
  const result = run('platforms', fixture(ociIndex([entry('Linux', 'amd64')])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed platform entry/u);
});

test('rejects a platform field containing whitespace', () => {
  const result = run('platforms', fixture(ociIndex([entry('linux x', 'amd64')])));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed platform entry/u);
});

test('rejects a malformed platform coming from the image config', () => {
  const result = run('platforms', fixture(ociManifest), fixture({ os: 'linux', architecture: 'amd64 ' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed platform entry/u);
});

test('counts attestation manifests separately', () => {
  const result = run('attestation-count', fixture(ociIndex([entry('linux', 'amd64'), attestationEntry()])));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '1');
});

test('reports zero attestations for a single manifest', () => {
  const result = run('attestation-count', fixture(ociManifest));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0');
});

// -------------------------------------------------------------------------------------------
// platform set comparison
// -------------------------------------------------------------------------------------------
function platformFile(lines) {
  const name = join(workdir, `platforms-${fixtureCounter++}.txt`);
  writeFileSync(name, lines.join('\n') + (lines.length ? '\n' : ''));
  return name;
}

test('two empty platform sets are rejected rather than compared equal', () => {
  const result = run('compare-platforms', platformFile(['']), platformFile(['']));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform set is empty/u);
});

test('differing platform sets fail', () => {
  const result = run('compare-platforms', platformFile(['linux/amd64']), platformFile(['linux/arm64']));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform sets differ/u);
});

test('the same platforms in a different order pass', () => {
  const result = run('compare-platforms', platformFile(['linux/arm64', 'linux/amd64']), platformFile(['linux/amd64', 'linux/arm64']));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'PLATFORM_PARITY_PASS');
});

// -------------------------------------------------------------------------------------------
// digest
// -------------------------------------------------------------------------------------------
test('reads the top-level descriptor digest', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const result = run('digest', fixture({ mediaType: 'application/vnd.oci.image.index.v1+json', digest, size: 4654, manifests: [{ digest: `sha256:${'e'.repeat(64)}` }] }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, digest, 'must be the index digest, not the submanifest digest');
});

test('rejects a malformed digest', () => {
  const result = run('digest', fixture({ digest: 'sha256:NOTHEX' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed digest/u);
});

test('rejects a descriptor with no digest', () => {
  const result = run('digest', fixture({ mediaType: 'application/vnd.oci.image.index.v1+json' }));
  assert.equal(result.status, 1);
});

// -------------------------------------------------------------------------------------------
// 9.3 inspect classification and retry
// -------------------------------------------------------------------------------------------
function stderrFile(text) {
  const name = join(workdir, `stderr-${fixtureCounter++}.txt`);
  writeFileSync(name, text);
  return name;
}

test('a successful inspect reports the tag as present', () => {
  const result = run('classify-inspect', '0', stderrFile(''));
  assert.equal(result.stdout, 'PRESENT');
});

for (const [label, text] of [
  ['manifest unknown', 'ERROR: manifest unknown'],
  ['not found', 'error: docker.io/x/y:1 not found'],
  ['404', 'unexpected status code 404'],
]) {
  test(`a confirmed absence is classified NOT_FOUND: ${label}`, () => {
    const result = run('classify-inspect', '1', stderrFile(text));
    assert.equal(result.stdout, 'NOT_FOUND');
  });
}

for (const [label, text] of [
  ['401', 'unexpected status from HEAD request: 401 Unauthorized'],
  ['403', 'error: 403 Forbidden: access denied'],
  ['429', 'toomanyrequests: You have reached your pull rate limit'],
  ['timeout', 'context deadline exceeded (Client.Timeout exceeded)'],
  ['502', 'unexpected status: 502 Bad Gateway'],
  ['503', '503 Service Unavailable'],
  ['network', 'dial tcp: lookup registry-1.docker.io: no such host'],
  ['empty stderr', ''],
]) {
  test(`an ambiguous or transient failure is classified INSPECT_ERROR: ${label}`, () => {
    const result = run('classify-inspect', '1', stderrFile(text));
    assert.equal(result.stdout, 'INSPECT_ERROR', `"${text}" must never be read as absence`);
  });
}

test('a 404 mentioned alongside an authorization failure is not treated as absence', () => {
  const result = run('classify-inspect', '1', stderrFile('401 Unauthorized (server also returned 404 for the token endpoint)'));
  assert.equal(result.stdout, 'INSPECT_ERROR');
});

test('an unknown subcommand fails closed', () => {
  const result = run('definitely-not-a-command');
  assert.equal(result.status, 1);
});
