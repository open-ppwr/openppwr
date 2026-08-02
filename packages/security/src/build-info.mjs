// SPDX-License-Identifier: Apache-2.0
//
// Build metadata, resolved once at process start from the values baked into the image.
//
// The site used to print a version string typed into a content file. It stayed at 0.1.0-beta.1 while
// the deployment moved through a dozen commits, so the one number a user could see was the one number
// nobody was maintaining. Anything displayed as a version now comes from here, and here comes from
// the build.
//
// Nothing in this record identifies infrastructure: no hostnames, no paths, no credentials. The image
// digest is a content address that a reader can compare against a published artifact, which is the
// point of showing it.

const unknown = 'unknown';

function value(name) {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : null;
}

export function buildInfo() {
  const revision = value('OPENPPWR_REVISION') || unknown;
  return Object.freeze({
    product: 'OpenPPWR Community',
    version: value('OPENPPWR_VERSION') || unknown,
    // Both forms are reported. The short revision is what a person reads and quotes; the full one is
    // what they check out.
    revision,
    revisionShort: revision === unknown ? unknown : revision.slice(0, 7),
    builtAt: value('OPENPPWR_BUILD_TIMESTAMP') || unknown,
    channel: value('OPENPPWR_RELEASE_CHANNEL') || 'private-release-candidate',
    imageDigest: value('OPENPPWR_IMAGE_DIGEST') || unknown,
    migrationLevel: value('OPENPPWR_MIGRATION_LEVEL') || unknown,
    docsVersion: value('OPENPPWR_DOCS_VERSION') || value('OPENPPWR_VERSION') || unknown,
  });
}

// A deployment that cannot say what it is running has not been verified, it has been assumed. The
// verification step compares what the operator intended to deploy against what the process reports,
// and any disagreement is a failure rather than a warning.
export function buildMismatches(actual, expected = {}) {
  const findings = [];
  for (const [field, wanted] of Object.entries(expected)) {
    if (!wanted) continue;
    const found = actual[field];
    if (field === 'revision' && typeof found === 'string' && typeof wanted === 'string') {
      // A short revision is a legitimate way to name a commit, so either may be a prefix of the other.
      if (!found.startsWith(wanted) && !wanted.startsWith(found)) findings.push(`${field}: expected ${wanted}, running ${found}`);
      continue;
    }
    if (found !== wanted) findings.push(`${field}: expected ${wanted}, running ${found}`);
  }
  return findings;
}
