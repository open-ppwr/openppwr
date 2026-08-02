// SPDX-License-Identifier: Apache-2.0
//
// Live version parity gate.
//
// The owner reported still seeing an old version after work had been committed for several sessions.
// The deployment really was old — but "is the running deployment the build I think it is?" had no
// answer short of reading container labels over SSH, which is not a check anybody performs routinely.
//
// This makes the question answerable in one command, and makes a mismatch a failure rather than
// something a person has to notice. A deployment is not complete until this passes.
//
//   OPENPPWR_VERIFY_BASE_URL=http://127.0.0.1:31114 \
//   OPENPPWR_VERIFY_VERSION=1.0.0 \
//   OPENPPWR_VERIFY_REVISION=<full-sha> \
//   node scripts/validation/verify-deployed-version.mjs
//
// Runs against the origin by default, so it needs no edge authentication and can be executed from the
// deployment host itself as the final step of a release.

const baseUrl = (process.env.OPENPPWR_VERIFY_BASE_URL || '').replace(/\/$/u, '');
const expected = {
  version: process.env.OPENPPWR_VERIFY_VERSION || '',
  revision: process.env.OPENPPWR_VERIFY_REVISION || '',
  channel: process.env.OPENPPWR_VERIFY_CHANNEL || '',
  migrationLevel: process.env.OPENPPWR_VERIFY_MIGRATION_LEVEL || '',
};
if (!baseUrl) throw new Error('OPENPPWR_VERIFY_BASE_URL is required.');
if (!expected.version || !expected.revision) throw new Error('OPENPPWR_VERIFY_VERSION and OPENPPWR_VERIFY_REVISION are required.');

const findings = [];
const checks = [];

async function fetchText(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  return { response, text: await response.text() };
}

// 1. The API is the source of truth: it reports what the running process was built from.
const versionResponse = await fetchText('/v1/version');
if (!versionResponse.response.ok) {
  findings.push(`/v1/version returned ${versionResponse.response.status}`);
} else {
  let build;
  try { build = JSON.parse(versionResponse.text); } catch { build = null; }
  if (!build) findings.push('/v1/version did not return JSON');
  else {
    checks.push(`api version=${build.version} revision=${build.revisionShort} channel=${build.channel} migrations=${build.migrationLevel}`);
    if (build.version !== expected.version) findings.push(`version: expected ${expected.version}, running ${build.version}`);
    // Either form may be a prefix of the other, since a short revision is a legitimate way to name a commit.
    if (!(expected.revision.startsWith(build.revision) || build.revision.startsWith(expected.revision))) {
      findings.push(`revision: expected ${expected.revision.slice(0, 12)}, running ${String(build.revision).slice(0, 12)}`);
    }
    if (expected.channel && build.channel !== expected.channel) findings.push(`channel: expected ${expected.channel}, running ${build.channel}`);
    if (expected.migrationLevel && build.migrationLevel !== expected.migrationLevel) {
      findings.push(`migrationLevel: expected ${expected.migrationLevel}, running ${build.migrationLevel}`);
    }
    // The declared level against the applied one. Every check above compares the deployment to what the
    // operator intended; this compares the deployment to itself, which is the one disagreement the operator
    // cannot see by reading their own release notes. A deployment reporting a schema it does not have is a
    // failure of this gate's whole premise — that what the process says about itself can be relied on.
    checks.push(`schema declared=${build.migrationLevel} applied=${build.appliedMigrationLevel}`);
    if (build.migrationLevelVerified !== true) {
      findings.push(`the deployment reports migration level ${build.migrationLevel} and its database is at ${build.appliedMigrationLevel}`);
    }
    // The image cannot contain its own digest, so an unknown value here means the operator did not
    // supply it at run time. That is a gap in provenance, not a mismatch, and is reported as such.
    if (!build.imageDigest || build.imageDigest === 'unknown') checks.push('image digest not supplied at runtime (OPENPPWR_IMAGE_DIGEST unset)');
  }
}

// 2. Every HTML surface must revalidate, or a correct deployment can still show a stale page.
// Each surface is addressed by its own hostname. Asking the marketing host for the workbench is not a
// stale-content failure — it is a correct cross-host redirect, and treating it as a defect would make
// this gate cry wolf on working routing.
const htmlSurfaces = [
  { label: 'marketing', path: '/en', host: process.env.OPENPPWR_VERIFY_MARKETING_HOST || 'openppwr.eu' },
  { label: 'workbench', path: '/en', host: process.env.OPENPPWR_VERIFY_APP_HOST || 'app.openppwr.eu' },
];
for (const { label, path, host } of htmlSurfaces) {
  const { response, text } = await fetchText(path, { 'x-forwarded-host': host });
  if (!response.ok) { findings.push(`${label} (${path}) returned ${response.status}`); continue; }
  const cacheControl = response.headers.get('cache-control') || '';
  if (!/no-cache|no-store|must-revalidate/u.test(cacheControl)) {
    findings.push(`${label}: HTML must revalidate, got cache-control "${cacheControl}"`);
  }
  // The shell names the hashed assets, so a shell referencing assets that are no longer on disk is
  // the signature of a stale cached page.
  const assets = [...text.matchAll(/\/assets\/([A-Za-z0-9._-]+\.(?:js|css))/gu)].map((match) => match[1]);
  if (!assets.length) findings.push(`${label}: no hashed assets referenced`);
  for (const asset of assets) {
    const probe = await fetch(`${baseUrl}/assets/${asset}`, { headers: { 'x-forwarded-host': host } });
    if (!probe.ok) findings.push(`${label}: references missing asset ${asset} (${probe.status}) — the served HTML is stale`);
  }
  checks.push(`${label} cache-control="${cacheControl}" assets=${assets.length}`);
}

// 3. A superseded version string must not survive anywhere a reader can see it. Every version this
// product has carried is listed, not only the one immediately before the current release: a stale
// surface can be several generations old, and naming one predecessor made the check blind to the rest.
const SUPERSEDED_VERSIONS = ['0.1.0-beta.1', '0.2.0-beta.1'];
const stale = await fetchText('/en', { 'x-forwarded-host': htmlSurfaces[0].host });
for (const superseded of SUPERSEDED_VERSIONS) {
  if (stale.response.ok && expected.version !== superseded && stale.text.includes(superseded)) {
    findings.push(`the marketing shell still contains the superseded version string ${superseded}`);
  }
}

for (const line of checks) console.log(`  ${line}`);
if (findings.length) {
  console.error(`DEPLOYED_VERSION_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`DEPLOYED_VERSION_PASS version=${expected.version} revision=${expected.revision.slice(0, 7)} base=${baseUrl}`);
}
