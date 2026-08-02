#!/bin/sh
set -eu
PATH="$HOME/.local/bin:$PATH"
export PATH

# The version comes from package.json, not from a literal. Both supply-chain gates hardcoded
# 0.1.0-beta.1, so building the 0.2.0-beta.1 candidate with them would have produced an image
# labelled with the previous version and SBOM filenames naming a release that was not being scanned.
version="$(node -p 'require("./package.json").version')"
image="${1:-ghcr.io/open-ppwr/openppwr:$version}"
output_directory="${2:-artifacts/supply-chain/run-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
expected_trivy_version='0.72.0'

# Grype and syft are required, not optional, and this is the whole reason the container gate was wrong.
#
# This script ran trivy alone, with --severity HIGH,CRITICAL. The PowerShell path does run
# `grype --fail-on high`, but native Windows has no grype, so this is the path that actually executes — and
# it reported PASS on an image carrying three CVEs that grype rates Critical and High.
#
# Trivy was not blind to them. Re-run on the identical image with the severity filter removed it finds all
# three and rates them MEDIUM, because neither Debian nor NVD supplies it a severity for those records, so it
# falls back to Red Hat's CVSS while grype inherits NVD's. One set of bytes, one set of findings, two
# inherited opinions about severity — and a gate that only ever asked the scanner with the lower opinion.
#
# Both scanners are therefore required and both blocking. Agreement between them is not the point; the point
# is that a finding either one can see cannot be filtered away by the other's severity mapping.
for tool in docker trivy grype syft git sha256sum node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required WSL tool missing: $tool" >&2
    exit 1
  fi
done

actual_trivy_version="$(trivy version 2>/dev/null | sed -n 's/^Version: //p' | head -1)"
if [ "$actual_trivy_version" != "$expected_trivy_version" ]; then
  echo "Trivy version mismatch: expected $expected_trivy_version, received $actual_trivy_version" >&2
  exit 1
fi

grype_version="$(grype version 2>/dev/null | sed -n 's/^Version: *//p' | head -1)"
syft_version="$(syft version 2>/dev/null | sed -n 's/^Version: *//p' | head -1)"

docker info >/dev/null
if [ -e "$output_directory" ] && [ -n "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Supply-chain output directory must be new or empty: $output_directory" >&2
  exit 1
fi
mkdir -p "$output_directory"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
source_revision="$(git rev-parse HEAD)"

# Build metadata the running deployment reports at /v1/version. Passing only version and revision
# left builtAt and migrationLevel reading "unknown" on a freshly built image — the same provenance
# gap the version endpoint was added to close.
build_timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
migration_level="$(ls packages/database/migrations/*.sql | sed 's|.*/||;s|_.*||' | sort | tail -1)"
release_channel="${OPENPPWR_RELEASE_CHANNEL:-private-rc}"

docker build --pull \
  --build-arg "OPENPPWR_VERSION=$version" \
  --build-arg "OPENPPWR_REVISION=$source_revision" \
  --build-arg "OPENPPWR_BUILD_TIMESTAMP=$build_timestamp" \
  --build-arg "OPENPPWR_RELEASE_CHANNEL=$release_channel" \
  --build-arg "OPENPPWR_MIGRATION_LEVEL=$migration_level" \
  --tag "$image" .
image_id="$(docker image inspect --format '{{.Id}}' "$image")"

trivy image --timeout 20m --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --format json --output "$output_directory/trivy-image.json" "$image"
# --timeout, explicitly, on both scans. The config scan hit Trivy's five-minute default and died with
# `context deadline exceeded` mid-Dockerfile-analysis -- a timeout, not a finding, but one that fails the
# gate identically and would be read as a security result by anyone skimming the exit code. Trivy's own
# message asks for a higher value. Twenty minutes is far past the ~5.5 minutes observed, so a genuine hang
# still terminates rather than blocking a release run for ever.
# Skip patterns are anchored with `**/` because the unanchored form matches only the repository root.
# A run failed with `walk dir error ... apps/api/.runtime-test/.../base/32029: no such file or directory`
# -- the scanner had walked into an embedded-PostgreSQL data directory belonging to a test suite running
# at the same time, and the file vanished underneath it. `--skip-dirs .runtime-test` did not cover it
# because the directory was one level down.
#
# The failure mode is the reason this matters more than the tidiness. A scanner that aborts because an
# unrelated process deleted a temporary file exits non-zero and reports FATAL, which is indistinguishable
# from a genuine finding to anyone reading the gate's verdict rather than its log. This repository has
# already read one scanner timeout as a security failure. A supply-chain scan of a live working tree has
# to be immune to whatever else is running in it, or its result is a statement about timing.
trivy config --timeout 20m --skip-dirs '.git' --skip-dirs '**/.git' --skip-dirs '.work-private' --skip-dirs '**/node_modules' --skip-dirs 'node_modules' --skip-dirs 'artifacts' --skip-dirs '**/artifacts' --skip-dirs '**/.runtime-test' --skip-dirs '.runtime-test' --skip-dirs '**/.runtime' --skip-dirs '.runtime' --skip-dirs 'apps/web/dist' --severity HIGH,CRITICAL --exit-code 1 --format json --output "$output_directory/trivy-config.json" .
# `--fail-on high` is what makes this a gate rather than a report. Verified by hand against both images
# before this line landed: it exits 2 on the previous glibc base, listing all three findings, and 0 on the
# current one. A scanner invocation whose failing branch has never been observed is not evidence of anything.
grype "$image" --fail-on high -o json --file "$output_directory/grype-image.json"

# SBOMs from syft, which is what every document in this repository already claims produces them. This script
# was emitting trivy's SBOMs under filenames the evidence described as syft output.
syft "$image" -o spdx-json="$output_directory/openppwr-$version.spdx.json"
syft "$image" -o cyclonedx-json="$output_directory/openppwr-$version.cyclonedx.json"

docker_version="$(docker version --format '{{.Client.Version}} client; {{.Server.Version}} server')"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf 'status=PASS\n'
  printf 'started_at=%s\n' "$started_at"
  printf 'finished_at=%s\n' "$finished_at"
  printf 'source_revision=%s\n' "$source_revision"
  printf 'image=%s\n' "$image"
  printf 'image_id=%s\n' "$image_id"
  printf 'docker_version=%s\n' "$docker_version"
  printf 'trivy_version=%s\n' "$actual_trivy_version"
  printf 'grype_version=%s\n' "$grype_version"
  printf 'syft_version=%s\n' "$syft_version"
  printf 'build_timestamp=%s\n' "$build_timestamp"
  printf 'migration_level=%s\n' "$migration_level"
  printf 'release_channel=%s\n' "$release_channel"
  printf 'published=false\n'
  printf 'provenance=NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN\n'
  printf 'signing=NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN\n'
} > "$output_directory/supply-chain-evidence.txt"

sha256sum \
  "$output_directory/trivy-image.json" \
  "$output_directory/trivy-config.json" \
  "$output_directory/grype-image.json" \
  "$output_directory/openppwr-$version.spdx.json" \
  "$output_directory/openppwr-$version.cyclonedx.json" \
  "$output_directory/supply-chain-evidence.txt" > "$output_directory/SHA256SUMS"
printf 'SUPPLY_CHAIN_WSL_GATE_PASS image=%s imageId=%s trivy=%s grype=%s syft=%s published=false output=%s\n' "$image" "$image_id" "$actual_trivy_version" "$grype_version" "$syft_version" "$output_directory"
