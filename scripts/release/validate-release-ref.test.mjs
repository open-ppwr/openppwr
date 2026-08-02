import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalImage, releaseVersion, validateReleaseImageRef } from './validate-release-ref.mjs';

test('accepts the canonical exact version tag', () => {
  assert.equal(validateReleaseImageRef(canonicalImage), canonicalImage);
  // Pinned deliberately: this is the one place that states, in a test, which version the release
  // tooling believes it is building. It must be updated as part of a version bump, so a bump that
  // forgot a surface fails here rather than shipping two builds under one number.
  assert.equal(releaseVersion, '1.0.0');
});

for (const imageRef of [
  'ghcr.io/open-ppwr/openppwr:latest',
  'ghcr.io/open-ppwr/openppwr:0.1.0-beta.1',
  'ghcr.io/open-ppwr/openppwr:0.2.0-beta.1',
  'ghcr.io/open-ppwr/openppwr:0.1.0',
  'docker.io/open-ppwr/openppwr:1.0.0',
  'ghcr.io/open-ppwr/openppwr@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
]) {
  test(`rejects non-candidate image reference ${imageRef}`, () => {
    assert.throws(() => validateReleaseImageRef(imageRef));
  });
}

// A pre-release suffix is permitted and not required, so what is asserted here is the property that
// survives both: the version has to be a complete release identity. Anything a registry would read as
// a moving or partial tag is refused before the reference is even compared.
for (const version of ['latest', '1.0', '1', 'v1.0.0', '1.0.0.1', '']) {
  test(`rejects package version that is not an exact SemVer release: '${version}'`, () => {
    assert.throws(() => validateReleaseImageRef(canonicalImage, version));
  });
}

test('accepts a pre-release version when that is what the package carries', () => {
  assert.equal(
    validateReleaseImageRef('ghcr.io/open-ppwr/openppwr:2.0.0-rc.1', '2.0.0-rc.1'),
    'ghcr.io/open-ppwr/openppwr:2.0.0-rc.1',
  );
});
