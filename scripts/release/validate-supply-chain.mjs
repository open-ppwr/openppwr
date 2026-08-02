import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalImage, releaseVersion, validateReleaseImageRef } from './validate-release-ref.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFile(resolve(repositoryRoot, path), 'utf8');
const [workflow, dockerfile, rootPackage, lockfile] = await Promise.all([
  read('.github/workflows/release-image.yml'),
  read('Dockerfile'),
  read('package.json').then(JSON.parse),
  read('package-lock.json').then(JSON.parse),
]);

const failures = [];
const requireMatch = (name, value, expression) => {
  if (!expression.test(value)) failures.push(name);
};

validateReleaseImageRef(canonicalImage);
if (rootPackage.version !== releaseVersion || lockfile.version !== releaseVersion) failures.push('root package/lock version mismatch');
if (rootPackage.license !== 'Apache-2.0') failures.push('root package Apache-2.0 metadata');

const workspacePackages = Object.entries(lockfile.packages).filter(([path]) => path === '' || path.startsWith('apps/') || path.startsWith('packages/'));
for (const [path, metadata] of workspacePackages) {
  if (metadata.version !== releaseVersion) failures.push(`${path || 'root'} version mismatch`);
  if (metadata.license !== 'Apache-2.0') failures.push(`${path || 'root'} Apache-2.0 metadata`);
}

for (const line of workflow.split(/\r?\n/u)) {
  const match = line.match(/^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)/u);
  if (match && !/^[a-f0-9]{40}$/u.test(match[1])) failures.push(`unpinned action: ${line.trim()}`);
}

requireMatch('workflow exact release tag', workflow, new RegExp(`type=raw,value=${releaseVersion.replaceAll('.', '\\.')}`, 'u'));
requireMatch('workflow protected release environment', workflow, /^\s*environment:\s*public-release\s*$/mu);
// Built from the version rather than hardcoded, so a version bump cannot leave these checks
// silently asserting the previous release's identity.
const versionPattern = releaseVersion.replaceAll('.', String.raw`\.`);
requireMatch('workflow immutable-tag concurrency', workflow, new RegExp(String.raw`concurrency:[\s\S]*group:\s*community-image-${versionPattern}[\s\S]*cancel-in-progress:\s*false`, 'u'));
requireMatch('workflow publish default false', workflow, /^\s*default:\s*false\s*$/mu);
requireMatch('workflow build cannot publish', workflow, /^\s*push:\s*false\s*$/mu);
requireMatch('workflow exact-image publish guard', workflow, /name:\s*Publish exact scanned image[\s\S]*if:\s*inputs\.publish[\s\S]*docker push "\$OPENPPWR_IMAGE"/u);
requireMatch('workflow existing-tag fail-closed guard', workflow, /imagetools inspect "\$OPENPPWR_IMAGE"[\s\S]*Refusing to overwrite existing immutable release tag[\s\S]*Unable to prove the release tag is unused/u);
requireMatch('workflow high vulnerability failure', workflow, /fail-build:\s*true[\s\S]*severity-cutoff:\s*high/u);
requireMatch('workflow Trivy configuration scan', workflow, /scan-type:\s*config[\s\S]*scanners:\s*misconfig[\s\S]*severity:\s*HIGH,CRITICAL[\s\S]*exit-code:\s*['"]?1/u);
requireMatch('workflow SPDX JSON SBOM', workflow, /format:\s*spdx-json/u);
requireMatch('workflow CycloneDX JSON SBOM', workflow, /format:\s*cyclonedx-json/u);
requireMatch('workflow GitHub provenance attestation', workflow, /uses:\s*actions\/attest-build-provenance@[a-f0-9]{40}[\s\S]*subject-digest:\s*\$\{\{ steps\.publish\.outputs\.digest \}\}[\s\S]*push-to-registry:\s*true/u);
requireMatch('workflow SPDX SBOM attestation', workflow, new RegExp(String.raw`uses:\s*actions/attest-sbom@[a-f0-9]{40}[\s\S]*sbom-path:\s*artifacts/supply-chain/openppwr-${versionPattern}\.spdx\.json[\s\S]*push-to-registry:\s*true`, 'u'));
requireMatch('workflow keyless digest signing', workflow, /cosign sign --yes ghcr\.io\/open-ppwr\/openppwr@\$\{\{ steps\.publish\.outputs\.digest \}\}/u);
requireMatch('workflow signature verification', workflow, /cosign verify[\s\S]*--certificate-oidc-issuer[\s\S]*steps\.publish\.outputs\.digest/u);
if (/(?:value=latest|openppwr:latest)/u.test(workflow)) failures.push('latest image tag forbidden');

// The Docker Hub mirror. GHCR stays canonical; Docker Hub receives a copy of the manifest GHCR already
// holds. Every assertion below exists because its absence would let a Docker Hub image exist that no GHCR
// publication produced, or let one exist whose bytes differ from the image that was scanned and signed.
requireMatch('workflow mirror job', workflow, /^\s{2}mirror-dockerhub:\s*$/mu);
requireMatch('workflow mirror depends on GHCR publication', workflow, /^\s{2}mirror-dockerhub:[\s\S]*needs:[\s\S]*- build-scan-publish-ghcr/mu);
requireMatch('workflow mirror gated on publish input', workflow, /^\s{2}mirror-dockerhub:[\s\S]*^\s{4}if:\s*inputs\.publish\s*$/mu);
requireMatch('workflow mirror copies by digest', workflow, /source_ref="\$\{GHCR_IMAGE\}@\$\{GHCR_DIGEST\}"/u);
requireMatch('workflow mirror uses imagetools copy', workflow, /docker buildx imagetools create[\s\S]*--tag "\$target"[\s\S]*"\$source_ref"/u);
requireMatch('workflow mirror hard digest comparison', workflow, /if \[\[ "\$dest_digest" != "\$GHCR_DIGEST" \]\]; then[\s\S]*digest parity not proven[\s\S]*exit 1/u);
requireMatch('workflow mirror evidence records parity', workflow, /"digest_parity=[\s\S]*"platform_parity=[\s\S]*"dockerhub_rebuild=NO"/u);
requireMatch('workflow release evidence refuses unproven parity', workflow, /RELEASE_EVIDENCE_FAIL parity was not proven[\s\S]*exit 1/u);

// The copy must preserve the source manifest format. --prefer-index defaults to true, which prefers
// wrapping a lone manifest in a new index and would change the digest, so the flag is not optional and
// the hard comparison stays regardless: Docker documents the flag as an attempt, not a guarantee.
requireMatch('workflow mirror preserves the source manifest format', workflow, /docker buildx imagetools create[\s\S]{0,200}--prefer-index=false/u);
// Counted as an argument on its own line, not as a string: the flag is also named in a comment and in
// the diagnostic that fires when the digests disagree, and neither of those is a second invocation.
if ((workflow.match(/^\s*--prefer-index=false(\s|\\|$)/gmu) ?? []).length !== 1) {
  failures.push('--prefer-index=false must be passed exactly once, on the copy command');
}

// Manifest classification and platform normalisation live in a tested script rather than inline shell.
// Inline, they were unreachable by any test, and two defects were duly found in exactly the branches
// nothing exercised.
requireMatch('workflow mirror uses the verified manifest parser', workflow, /scripts\/release\/verify-registry-mirror\.sh media-type/u);
requireMatch('workflow mirror resolves platforms through the parser', workflow, /scripts\/release\/verify-registry-mirror\.sh platforms/u);
requireMatch('workflow mirror compares platforms through the parser', workflow, /scripts\/release\/verify-registry-mirror\.sh compare-platforms/u);
requireMatch('workflow mirror classifies the destination probe', workflow, /scripts\/release\/verify-registry-mirror\.sh classify-inspect/u);
requireMatch('workflow mirror reads the top-level descriptor digest', workflow, /scripts\/release\/verify-registry-mirror\.sh digest/u);
requireMatch('workflow mirror fails closed on an unresolved destination', workflow, /INSPECT_ERROR[\s\S]*destination state could not be established[\s\S]*exit 1/u);
requireMatch('workflow mirror rejects a colliding destination tag', workflow, /existing tag collision[\s\S]*is not overwritten or deleted here[\s\S]*exit 1/u);
requireMatch('workflow mirror resumes a matching destination', workflow, /mirror_state=ALREADY_PRESENT_MATCHING/u);
requireMatch('workflow mirror compares media types', workflow, /media type changed during the copy[\s\S]*exit 1/u);
requireMatch('workflow mirror records a failure state', workflow, /mirror_may_exist=\$\{may_exist\}/u);
if (!/if: failure\(\)/u.test(workflow)) failures.push('mirror failure evidence must be recorded on failure');

// A rebuild for the second registry is the failure this whole design exists to prevent.
if (/docker\/build-push-action@[a-f0-9]{40}/gu.test(workflow)
  && (workflow.match(/uses:\s*docker\/build-push-action@/gu) ?? []).length !== 1) {
  failures.push('exactly one image build expected');
}
if (/docker\.io\/[^\s"']*openppwr[^\s"']*/u.test(workflow.replace(/docker\.io\/\$\{DOCKERHUB_IMAGE\}:\$\{OPENPPWR_VERSION\}/gu, ''))) {
  failures.push('Docker Hub reference outside the mirror target expression');
}
if (/continue-on-error/u.test(workflow)) failures.push('continue-on-error forbidden in release workflow');
if (/imagetools create[\s\S]{0,400}--(?:append|annotation)/u.test(workflow)) {
  failures.push('mirror copy must not rewrite the manifest');
}

// The mirror moves no bytes of its own: it needs to read GHCR and write Docker Hub with a repository
// token, and nothing else. Write scopes here would let a compromised copy step re-attest or re-publish.
const mirrorJob = workflow.match(/^\s{2}mirror-dockerhub:[\s\S]*?(?=^\s{2}[a-z][a-z0-9-]*:\s*$)/mu)?.[0] ?? '';
if (!mirrorJob) failures.push('mirror job block not found');
for (const forbidden of ['packages: write', 'attestations: write', 'id-token: write', 'security-events: write', 'pull-requests: write', 'contents: write']) {
  if (mirrorJob.includes(forbidden)) failures.push(`mirror job must not request ${forbidden}`);
}

// One secret, named once. Anything else referenced here is either an unreviewed credential or a typo that
// silently resolves to an empty string at runtime.
const secretReferences = [...workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]);
for (const reference of new Set(secretReferences)) {
  if (reference !== 'DOCKERHUB_TOKEN') failures.push(`unexpected secret reference: secrets.${reference}`);
}
if (/secrets\.GITHUB_TOKEN/u.test(workflow)) failures.push('use github.token rather than secrets.GITHUB_TOKEN');

// The Git tag carries the "v" prefix so refs/tags/v* protects it; the image tag stays bare SemVer because
// validateReleaseImageRef accepts exactly one reference. Both are asserted so they cannot drift apart.
requireMatch('workflow release tag is v-prefixed', workflow, new RegExp(String.raw`OPENPPWR_RELEASE_TAG:\s*v${versionPattern}\s*$`, 'mu'));
requireMatch('workflow publication requires the release tag', workflow, /refs\/tags\/\$\{OPENPPWR_RELEASE_TAG\}/u);

if (rootPackage.scripts['release:image:gate:wsl'] !== 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release/run-supply-chain-gate.ps1 -UseWsl') {
  failures.push('WSL release image gate script');
}

requireMatch('Dockerfile digest-pinned build base', dockerfile, /^FROM\s+node:[^\s]+@sha256:[a-f0-9]{64}/mu);
// The runtime base is `distroless/static`, which carries no libc at all, rather than
// `distroless/nodejs24-debian13`, which carries Debian's `libc6` and with it CVE-2026-5450,
// CVE-2026-5928 and CVE-2026-5435. Moving the runtime back to any glibc-bearing base returns all
// three, so the base is asserted here and not merely chosen in the Dockerfile.
requireMatch('Dockerfile digest-pinned libc-free runtime base', dockerfile, /^FROM\s+gcr\.io\/distroless\/static-debian13:nonroot@sha256:[a-f0-9]{64}\s+AS\s+runtime$/mu);
// A libc-free base cannot run Node on its own: the musl interpreter and the two C++ runtime libraries
// have to be copied in, and the interpreter has to be named as the entrypoint because
// `distroless/static` declares none.
requireMatch('Dockerfile musl loader copied into the runtime', dockerfile, /^COPY\s+--from=nodejs\s+\/lib\/ld-musl-x86_64\.so\.1\s+\/lib\/ld-musl-x86_64\.so\.1$/mu);
requireMatch('Dockerfile musl Node binary copied into the runtime', dockerfile, /^COPY\s+--from=nodejs\s+\/usr\/local\/bin\/node\s+\/nodejs\/bin\/node$/mu);
requireMatch('Dockerfile names the Node interpreter as entrypoint', dockerfile, /^ENTRYPOINT\s+\["\/nodejs\/bin\/node"\]$/mu);
// The build stage must stay on the same libc as the runtime, and the shipped tree must contain no
// glibc-linked ELF. Without both, a native dependency would be resolved for glibc and the image would
// fail to start on a deployment rather than in this build.
requireMatch('Dockerfile musl build base', dockerfile, /^FROM\s+node:24-alpine@sha256:[a-f0-9]{64}\s+AS\s+build$/mu);
requireMatch('Dockerfile refuses glibc-linked binaries in the shipped tree', dockerfile, /scanelf\s+--recursive\s+--nobanner\s+--format\s+'%i %F'\s+\/workspace[\s\S]*?grep\s+'ld-linux'/u);
requireMatch('Dockerfile numeric non-root runtime', dockerfile, /^USER\s+65532:65532\s*$/mu);
requireMatch('Dockerfile version label', dockerfile, /org\.opencontainers\.image\.version="\$OPENPPWR_VERSION"/u);
requireMatch('Dockerfile revision label', dockerfile, /org\.opencontainers\.image\.revision="\$OPENPPWR_REVISION"/u);
// Every ARG the Dockerfile declares must be passed by the workflow that builds the release image.
//
// Passing a subset does not fail a build -- Docker silently uses the declared default -- so the published
// 1.0.0 image shipped with OPENPPWR_RELEASE_CHANNEL=private-release-candidate, OPENPPWR_BUILD_TIMESTAMP
// =unknown and OPENPPWR_MIGRATION_LEVEL=unknown baked in. /v1/version therefore told every user that the
// released artefact was a private candidate which could not verify its own schema level, while the OCI
// `created` label was simultaneously correct because metadata-action overwrites it. One image, two answers
// to "when were you built", and the label assertion passed throughout.
//
// Derived from the Dockerfile rather than listed here, so a new ARG is covered the day it is added.
{
  const declared = [...dockerfile.matchAll(/^ARG\s+(OPENPPWR_[A-Z_]+)/gmu)].map((match) => match[1]);
  for (const name of declared) {
    if (!new RegExp(`^\\s+${name}=`, 'mu').test(workflow)) {
      failures.push(`workflow does not pass build arg ${name}, so the image ships the Dockerfile default`);
    }
  }
}

requireMatch('Dockerfile created label', dockerfile, /org\.opencontainers\.image\.created="\$OPENPPWR_BUILD_TIMESTAMP"/u);
// The published image does not necessarily carry the labels the Dockerfile sets, and the two assertions
// above would not have noticed. `build-push-action` receives `labels:` from `docker/metadata-action`, and
// anything it emits overrides the Dockerfile -- so a locally built image can be inspected, found correct,
// and still differ from what a registry would serve. Left to derive them, metadata-action reads the
// GitHub repository's own title, description and licence, which are settings on a web page rather than
// facts about the software, and which nothing in this repository controls or checks.
//
// So the workflow must pin them, and that is asserted here rather than trusted, because the failure is
// invisible in every local check: the image on this machine is right and only the published one is wrong.
requireMatch('workflow pins the OCI title label', workflow, /org\.opencontainers\.image\.title=OpenPPWR/u);
requireMatch('workflow pins the OCI description label', workflow, /org\.opencontainers\.image\.description=Open-source packaging compliance platform for Europe/u);
requireMatch('workflow pins the OCI licenses label', workflow, /org\.opencontainers\.image\.licenses=Apache-2\.0/u);
requireMatch('Dockerfile license artifacts', dockerfile, /COPY\s+--chown=65532:65532\s+LICENSE\s+NOTICE\s+THIRD_PARTY_NOTICES\.md\s+docs\/audit\/LICENSE_INVENTORY\.md\s+docs\/audit\/THIRD_PARTY_LICENSE_INVENTORY\.md\s+\/app\/licenses\//u);

if (failures.length) {
  console.error(`SUPPLY_CHAIN_STATIC_FAIL findings=${failures.length}\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`SUPPLY_CHAIN_STATIC_PASS version=${releaseVersion} image=${canonicalImage} workspaces=${workspacePackages.length} latest_tags=0`);
}
