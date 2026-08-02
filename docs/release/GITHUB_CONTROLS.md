# GitHub control preparation

No source has been pushed to GitHub. This document states the controls the public repository is to be
configured with, so that the posture is reviewable before it exists rather than inferred from it
afterwards.

After owner approval, organization owners must verify 2FA, owners-only visibility/delete/transfer,
protected `main`, PR plus one approval, CODEOWNER review, stale approval dismissal, required checks,
conversation resolution, blocked force-push/deletion, secret scanning/push protection, Dependabot,
dependency review, CodeQL, private vulnerability reporting, minimal Actions permissions and a protected
`public-release` environment.

**Three of those are worthless unless they exist before the first push, and saying so is the point of
listing them separately.** Secret scanning with push protection only blocks a push that has not happened
yet. The Actions policy — a read-only default workflow token, and approval required for workflows on pull
requests from forks — has to be in force before the first push, because that push carries the workflow
files and immediately starts two runs. Branch protection on `main` is the opposite case: there is nothing
to protect until the first push has created the branch, so it is applied immediately afterwards rather
than configured with a bypass actor that would then have to be remembered and removed.

All committed third-party actions are pinned to full 40-character commit SHAs — twenty-eight `uses:`
references across the three workflows, checked as bytes rather than assumed. That pinning is asserted
automatically for `.github/workflows/release-image.yml`, by both
`scripts/validation/validate-release-workflow.mjs` and `scripts/release/validate-supply-chain.mjs`. It is
**not** asserted for `ci.yml` or `security.yml`: both validators read the release workflow and nothing
else, so the pins in the other two files are correct today and are held there by review rather than by a
gate. That is a known gap, stated here rather than left for a reader to discover from the validator source.

Publication uses the ephemeral GitHub token for GHCR and GitHub OIDC for keyless signing; no long-lived
registry or signing credential is prepared. Plan-specific availability remains `OWNER ACTION REQUIRED`
until the organization is inspected after the first-push gate.

## What no gate in this repository can verify

The release workflow declares `environment: public-release` on the only job that can push an image, and
`scripts/validation/validate-release-workflow.mjs` fails the build if that declaration is removed or
renamed. What it cannot check is whether the environment exists on GitHub, whether it has a required
reviewer, or whether that reviewer is a person — an environment name that names nothing is not an error,
and the job simply runs. The same applies to branch protection, the tag ruleset, the Actions policy and
the visibility of the published package: all of them live on GitHub, and this repository can state them,
assert the workflow's side of them, and verify none of them.

So each is read back from the GitHub API after being configured, and the reading is the evidence. Nothing
in this repository should be read as proof that any of them is in place.

## Registries and the Docker Hub mirror

`ghcr.io/open-ppwr/openppwr` is canonical. `docker.io/openppwr/openppwr` is a mirror of the same
versioned image and nothing more.

The release workflow builds once. It publishes to GHCR, records the canonical digest, and only then
copies that manifest — referenced by digest, never by tag — to Docker Hub. The copy runs with
`--prefer-index=false` so the source manifest format is preserved rather than wrapped in a new index,
which would change the digest. It re-reads both references afterwards and fails the release if the
digests, the media types or the platform sets differ. There is no second build, no Docker Hub Automated
Build, no Docker Hub connection to GitHub and no webhook.

The mirror is idempotent. A destination tag that already holds the canonical digest is resumed and
re-validated rather than copied again, so a run that failed after a successful copy can simply be
re-run. A destination tag holding a different digest is a collision: the release stops, and the tag is
neither overwritten nor deleted — the mirror token has no delete permission. A destination whose state
cannot be established — an authorization failure, a rate limit, a timeout — is never read as "the tag
is free"; only a confirmed absence permits a copy.

Manifest classification and platform normalisation are in `scripts/release/verify-registry-mirror.sh`
rather than inline in the workflow, so they are covered by fixture tests that need no registry.

GHCR is the canonical registry for signatures, attestations and provenance. Docker Hub is a
convenience mirror of the same versioned image digest; the workflow does not claim, and does not
create, a separate Docker Hub signature. Copying OCI referrers to Docker Hub is a separate decision
and is not part of this release path.

The mirror uses one repository-scoped Docker Hub token held as the `DOCKERHUB_TOKEN` Actions secret,
in a job that holds no write scope of its own. That token carries read and write but deliberately **not**
delete: the absent permission is what makes it impossible for any step in the workflow to remove or
overwrite a published mirror tag, and the cost is that correcting a mirror tag is a manual act by a human
rather than something the workflow can do for itself. Removing the mirror does not affect GHCR.

The Git tag carries a `v` prefix so that a `refs/tags/v*` ruleset protects it. The image tag is the
bare SemVer, because the release reference validator accepts exactly one image reference. Both values
are stated explicitly in the workflow and asserted by `scripts/release/validate-supply-chain.mjs`, so
they cannot drift apart unnoticed.

## The published package must be made public separately

A container package published from GitHub Actions is private by default, and a private package cannot be
pulled anonymously. Until its visibility is changed, the repository is public and the software is not
installable — a state that is invisible from the release workstation, because the workstation is
authenticated to the registry. Making the package public, linking it to the repository, and proving an
anonymous `docker pull` from a host that has never authenticated to GHCR is therefore a step in its own
right and not an implied consequence of publishing the image.

## Refusing to overwrite a published tag

The publish step inspects `ghcr.io/open-ppwr/openppwr:1.0.0` and refuses to proceed if it resolves, and
it refuses equally if the inspection fails in a way that does not prove absence. This is a check followed
by an act, not registry-enforced immutability, and the distinction matters: between the inspection and
the push, nothing in the registry itself prevents the tag appearing. What actually closes that window is
that the workflow serialises its own runs through a non-cancelling concurrency group, that every run
needs a human approval on a protected environment, and that no other workflow in this repository holds
`packages: write`. Those are the controls. "The registry refuses" is not one of them.

## DCO enforcement

OpenPPWR selects Developer Certificate of Origin 1.1, not a contributor license
agreement. After approved first push and before public contributions are
accepted, install or enable the GitHub DCO check for `open-ppwr/openppwr`, make
its status context required by `main` branch protection, and verify unsigned
test commits fail while `Signed-off-by` commits pass. Do not make the context required before the app is
installed: a required check that never reports leaves every pull request permanently pending, which
presents as a broken repository rather than as a misconfiguration. Do not rewrite private
clean-room history solely to add trailers; enforcement applies to new public
contributions. Repository policy and contributor instructions are in `DCO.md`
and `CONTRIBUTING.md`.
