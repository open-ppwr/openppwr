import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

export const releaseVersion = packageJson.version;
export const canonicalImage = `ghcr.io/open-ppwr/openppwr:${releaseVersion}`;

export function validateReleaseImageRef(imageRef, expectedVersion = releaseVersion) {
  // An exact SemVer release, with or without a pre-release suffix. The guard exists to reject an
  // incomplete version, a floating tag or a digest — not to freeze the product on one line. It has now
  // been written too narrowly twice: a hardcoded minor broke the first bump to 0.2.0-beta.1, and the
  // `-beta.N` requirement that replaced it refused 1.0.0, which is the version the product reaches when
  // it stops being a beta at all. A pre-release is permitted, not required.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(expectedVersion)) {
    throw new Error(`Release version must be an exact SemVer release; received ${expectedVersion}`);
  }
  if (imageRef.includes('@') || imageRef.endsWith(':latest')) {
    throw new Error(`Release build reference must use the exact version tag, not digest/latest: ${imageRef}`);
  }
  const expected = `ghcr.io/open-ppwr/openppwr:${expectedVersion}`;
  if (imageRef !== expected) {
    throw new Error(`Release image must be exactly ${expected}; received ${imageRef}`);
  }
  return imageRef;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const imageRef = process.argv[2] ?? canonicalImage;
  validateReleaseImageRef(imageRef);
  console.log(`RELEASE_IMAGE_REF_PASS image=${imageRef}`);
}
