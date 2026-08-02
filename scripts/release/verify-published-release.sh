#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Post-publication verification, performed from the position of a stranger.
#
# Everything here runs anonymously, with no credential, against whatever the public internet serves.
# That is the whole point: every gate this project ran before publication measured artefacts on a
# machine that already held them. None of them could establish that a person with no relationship to
# this project receives the same bytes. This script can, and it is the only thing that can.
#
# It is read-only. It clones into a temporary directory, pulls images, starts throwaway containers on
# a throwaway network, and removes all of it. It pushes nothing, tags nothing, logs in to nothing and
# writes nothing into the repository it is run from. It is safe to run repeatedly.
#
# WHY NOTHING IS HARD-CODED
#
# The expected values arrive as arguments or environment variables, and the values that a published
# artefact can vouch for are read from the *cloned* manifest rather than from this file. An earlier
# revision of the smoke plan pinned "339 files at revision <x>" as literals and both were stale within
# a day, which would have had an operator abort a correct publication on the plan's own arithmetic. A
# harness carrying a literal goes stale exactly the same way, and it goes stale silently, because a
# stale literal still produces a confident green or a confident red.
#
# The one class of value that must come from outside is the one the published tree cannot vouch for:
# the commit SHA, the repository URL and the tag. A manifest sitting inside a tree cannot establish
# which commit that tree belongs to, so taking those from the clone would be circular.
#
# WHAT A GREEN FROM THIS SCRIPT DOES NOT MEAN
#
# Read the notes below before quoting any line as evidence. Several checks here can only ever be evidence *against*
# something, and one of them - the absence of forbidden tags - cannot be evidence at all without a
# positive control, for reasons that cost this project a documented mistake.
#
# OUTPUT CONTRACT
#
# Every check prints exactly one line beginning with the token OPENPPWR_VERIFY, so a later report can
# quote it without transcribing it:
#
#   OPENPPWR_VERIFY <CHECK_NAME> <PASS|FAIL|SKIP|INCONCLUSIVE> <detail>
#
# PASS          the assertion was made and held.
# FAIL          the assertion was made and did not hold.
# INCONCLUSIVE  the script wanted to make the assertion and could not. This is NOT a pass. It is the
#               state that a 401, a 403 or a 404 from a registry actually puts you in, and it exits
#               non-zero on purpose so that nobody reads a wall of green and infers a measurement.
# SKIP          the operator asked for this to be skipped with a flag. The only benign non-PASS.
#
# Exit: 0 all checks PASS or were skipped by request; 1 any FAIL; 2 any INCONCLUSIVE and no FAIL.
#
# Requires: sh, git, curl, jq, sha256sum (or shasum), and docker for the registry and runtime checks.
# Targets Debian 13 and WSL. POSIX sh throughout - no arrays, no [[, no local, no process substitution.

set -eu

# ---------------------------------------------------------------------------------------------
# Defaults. Every one of these is overridable, and the ones that are assertions rather than
# addresses have no default at all.
# ---------------------------------------------------------------------------------------------

REPO_URL="${OPENPPWR_VERIFY_REPO_URL:-https://github.com/open-ppwr/openppwr.git}"
TAG="${OPENPPWR_VERIFY_TAG:-v1.0.0}"
EXPECT_COMMIT="${OPENPPWR_VERIFY_EXPECT_COMMIT:-}"
EXPECT_FILE_COUNT="${OPENPPWR_VERIFY_EXPECT_FILE_COUNT:-}"
MANIFEST_PATH="${OPENPPWR_VERIFY_MANIFEST_PATH:-docs/release/PUBLIC_RELEASE_MANIFEST_1_0_0.json}"
GHCR_IMAGE="${OPENPPWR_VERIFY_GHCR_IMAGE:-ghcr.io/open-ppwr/openppwr}"
HUB_IMAGE="${OPENPPWR_VERIFY_HUB_IMAGE:-docker.io/openppwr/openppwr}"
IMAGE_TAG="${OPENPPWR_VERIFY_IMAGE_TAG:-}"
FORBIDDEN_TAGS="${OPENPPWR_VERIFY_FORBIDDEN_TAGS:-1 latest 1.0 v1.0.0}"
SMOKE_PORT="${OPENPPWR_VERIFY_SMOKE_PORT:-18080}"
WORK_DIR="${OPENPPWR_VERIFY_WORK_DIR:-}"
SKIP_REGISTRY=0
SKIP_RUNTIME=0
KEEP_WORK=0

usage() {
  cat <<'USAGE'
verify-published-release.sh - verify a completed OpenPPWR publication anonymously.

  --repo-url URL          public git URL              (env OPENPPWR_VERIFY_REPO_URL)
  --tag TAG               git tag to verify           (env OPENPPWR_VERIFY_TAG)
  --expect-commit SHA     REQUIRED. The root commit the release announced.
  --expect-file-count N   file count; defaults to the cloned manifest's publicExport.fileCount
  --manifest-path PATH    path to the release manifest inside the tree
  --ghcr-image REF        GHCR repository, without a tag
  --hub-image REF         Docker Hub repository, without a tag
  --image-tag TAG         image tag; defaults to the cloned manifest's version
  --forbidden-tags "A B"  image tags that must NOT exist on either registry
  --smoke-port PORT       host port for the runtime smoke
  --work-dir DIR          scratch directory; a temporary one is made and removed if omitted
  --skip-registry         skip checks 4, 5, 6 and 8 (no docker, or no published image)
  --skip-runtime          skip check 7
  --github-only           equivalent to --skip-registry --skip-runtime
  --keep-work             leave the scratch directory behind for inspection
  -h, --help              this text

The commit is not defaulted on purpose. It is the one value the published tree cannot vouch for,
so it must arrive from the release record rather than from the thing being verified.
USAGE
}

while [ $# -gt 0 ]; do
  # Accept both `--name value` and `--name=value`; POSIX sh has no getopt_long.
  case "$1" in
    *=*) OPT="${1%%=*}"; VAL="${1#*=}"; HAS_VAL=1 ;;
    *)   OPT="$1"; VAL="${2:-}"; HAS_VAL=0 ;;
  esac
  case "$OPT" in
    --repo-url)         REPO_URL="$VAL";         [ "$HAS_VAL" = 1 ] || shift ;;
    --tag)              TAG="$VAL";              [ "$HAS_VAL" = 1 ] || shift ;;
    --expect-commit)    EXPECT_COMMIT="$VAL";    [ "$HAS_VAL" = 1 ] || shift ;;
    --expect-file-count) EXPECT_FILE_COUNT="$VAL"; [ "$HAS_VAL" = 1 ] || shift ;;
    --manifest-path)    MANIFEST_PATH="$VAL";    [ "$HAS_VAL" = 1 ] || shift ;;
    --ghcr-image)       GHCR_IMAGE="$VAL";       [ "$HAS_VAL" = 1 ] || shift ;;
    --hub-image)        HUB_IMAGE="$VAL";        [ "$HAS_VAL" = 1 ] || shift ;;
    --image-tag)        IMAGE_TAG="$VAL";        [ "$HAS_VAL" = 1 ] || shift ;;
    --forbidden-tags)   FORBIDDEN_TAGS="$VAL";   [ "$HAS_VAL" = 1 ] || shift ;;
    --smoke-port)       SMOKE_PORT="$VAL";       [ "$HAS_VAL" = 1 ] || shift ;;
    --work-dir)         WORK_DIR="$VAL";         [ "$HAS_VAL" = 1 ] || shift ;;
    --skip-registry)    SKIP_REGISTRY=1 ;;
    --skip-runtime)     SKIP_RUNTIME=1 ;;
    --github-only)      SKIP_REGISTRY=1; SKIP_RUNTIME=1 ;;
    --keep-work)        KEEP_WORK=1 ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "unknown option: $OPT" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------------------------
# Reporting. One line per check, one token, one verdict.
# ---------------------------------------------------------------------------------------------

N_PASS=0
N_FAIL=0
N_SKIP=0
N_INCONCLUSIVE=0

report() {
  # $1 check name, $2 verdict, rest detail
  _name="$1"; _verdict="$2"; shift 2
  printf 'OPENPPWR_VERIFY %s %s %s\n' "$_name" "$_verdict" "$*"
  case "$_verdict" in
    PASS)         N_PASS=$((N_PASS + 1)) ;;
    FAIL)         N_FAIL=$((N_FAIL + 1)) ;;
    SKIP)         N_SKIP=$((N_SKIP + 1)) ;;
    INCONCLUSIVE) N_INCONCLUSIVE=$((N_INCONCLUSIVE + 1)) ;;
  esac
}

# Diagnostics go to stderr so that stdout stays quotable as a pure list of verdicts.
note() { printf '  %s\n' "$*" >&2; }

fatal() {
  printf 'OPENPPWR_VERIFY HARNESS FAIL %s\n' "$*"
  exit 1
}

# ---------------------------------------------------------------------------------------------
# Tool discovery. A missing tool must never silently narrow the run.
# ---------------------------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

if have sha256sum; then
  sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
  sha256_stdin() { sha256sum | cut -d' ' -f1; }
elif have shasum; then
  sha256_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
  sha256_stdin() { shasum -a 256 | cut -d' ' -f1; }
else
  fatal "neither sha256sum nor shasum is available; the content digest cannot be recomputed"
fi

have git  || fatal "git is not available"
have curl || fatal "curl is not available"
have jq   || fatal "jq is not available; the manifest and image metadata are JSON and this script will not parse JSON with sed"

[ -n "$EXPECT_COMMIT" ] || fatal "--expect-commit is required; see --help for why it is not defaulted"

case "$EXPECT_COMMIT" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) fatal "--expect-commit must be a full 40-character lowercase SHA-1, got '$EXPECT_COMMIT'" ;;
esac

# ---------------------------------------------------------------------------------------------
# Scratch space and teardown. The trap must survive an early exit under `set -e`, because a
# half-finished run that leaves a postgres container and a docker network behind turns the next
# run's port bind into a mystery.
# ---------------------------------------------------------------------------------------------

CREATED_WORK=0
if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openppwr-verify.XXXXXX")"
  CREATED_WORK=1
else
  mkdir -p "$WORK_DIR"
fi
CLONE_DIR="$WORK_DIR/clone"

SMOKE_NET=""
SMOKE_PG=""
SMOKE_API=""

cleanup() {
  _rc=$?
  if [ -n "$SMOKE_API" ]; then docker rm -f "$SMOKE_API" >/dev/null 2>&1 || true; fi
  if [ -n "$SMOKE_PG" ];  then docker rm -f "$SMOKE_PG"  >/dev/null 2>&1 || true; fi
  if [ -n "$SMOKE_NET" ]; then docker network rm "$SMOKE_NET" >/dev/null 2>&1 || true; fi
  if [ "$CREATED_WORK" = 1 ] && [ "$KEEP_WORK" = 0 ]; then rm -rf "$WORK_DIR"; fi
  exit "$_rc"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------------------------
# Anonymity. A stored credential is the failure mode this whole script exists to catch: a package
# published from Actions is private by default, and a stale token in ~/.docker/config.json makes a
# private package pull cleanly here and fail for every stranger. Detected rather than corrected -
# running `docker logout` would mutate the operator's machine, and this script mutates nothing.
# ---------------------------------------------------------------------------------------------

GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=/bin/echo
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null
export GIT_TERMINAL_PROMPT GIT_ASKPASS GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM

docker_config_file() { printf '%s/config.json\n' "${DOCKER_CONFIG:-$HOME/.docker}"; }

registry_host() { printf '%s\n' "${1%%/*}"; }

# True when the local docker config holds an auth entry that could apply to this registry.
has_stored_credential() {
  _cfg="$(docker_config_file)"
  [ -f "$_cfg" ] || return 1
  _host="$1"
  # Docker Hub is stored under a legacy index URL rather than under docker.io.
  jq -e --arg h "$_host" '
    ((.auths // {}) | keys[]) as $k
    | select(($k | contains($h)) or ($h == "docker.io" and ($k | contains("index.docker.io"))))
  ' "$_cfg" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------------------------
# CHECK 1 - ANONYMOUS CLONE
#
# "Does the repository exist" is not the question. The question is whether a person with no
# relationship to this project receives the announced commit, and only that commit. A repository
# published with its full private history, or with a second commit nobody intended, is a disclosure
# that no pre-publication gate could have seen, because before publication there was nothing to look
# at.
#
# core.autocrlf and core.eol are forced off. The export carries a .gitattributes that pins eol=lf,
# so this is redundant today - but if a future export ever drops that file, the checkout bytes would
# become host-dependent and check 2 would start failing on Windows hosts and passing on Linux ones
# for reasons that have nothing to do with the publication. Pinned here so that never becomes a
# mystery, and the presence of .gitattributes is asserted separately below.
# ---------------------------------------------------------------------------------------------

CLONE_OK=0
if git -c core.autocrlf=false -c core.eol=lf -c core.quotePath=false -c credential.helper= \
     clone --quiet "$REPO_URL" "$CLONE_DIR" >"$WORK_DIR/clone.log" 2>&1; then
  CLONE_OK=1
  report CLONE_ANONYMOUS PASS "cloned $REPO_URL without a credential"
else
  report CLONE_ANONYMOUS FAIL "clone failed or demanded a credential; see $WORK_DIR/clone.log"
  note "$(tail -n 5 "$WORK_DIR/clone.log" 2>/dev/null || true)"
fi

git_in_clone() { git -C "$CLONE_DIR" -c core.quotePath=false "$@"; }

if [ "$CLONE_OK" = 1 ]; then
  ACTUAL_COMMIT="$(git_in_clone rev-parse HEAD)"
  if [ "$ACTUAL_COMMIT" = "$EXPECT_COMMIT" ]; then
    report CLONE_ROOT_COMMIT PASS "HEAD=$ACTUAL_COMMIT"
  else
    report CLONE_ROOT_COMMIT FAIL "HEAD=$ACTUAL_COMMIT expected=$EXPECT_COMMIT"
  fi

  COMMIT_COUNT="$(git_in_clone log --format=%H | wc -l | tr -d ' ')"
  if [ "$COMMIT_COUNT" = "1" ]; then
    report CLONE_SINGLE_COMMIT PASS "git log shows 1 commit"
  else
    report CLONE_SINGLE_COMMIT FAIL "git log shows $COMMIT_COUNT commits; the export was meant to be a single squashed root"
  fi

  # A single commit and a single root are different claims. A tree can hold one commit that is not a
  # root (a graft), and a repository can hold one root plus a merged branch.
  ROOT_COUNT="$(git_in_clone rev-list --max-parents=0 HEAD | wc -l | tr -d ' ')"
  ROOT_SHA="$(git_in_clone rev-list --max-parents=0 HEAD | head -n 1)"
  if [ "$ROOT_COUNT" = "1" ] && [ "$ROOT_SHA" = "$EXPECT_COMMIT" ]; then
    report CLONE_SINGLE_ROOT PASS "1 root commit, equal to HEAD"
  else
    report CLONE_SINGLE_ROOT FAIL "roots=$ROOT_COUNT root=$ROOT_SHA expected=$EXPECT_COMMIT"
  fi

  TRACKED_COUNT="$(git_in_clone ls-files | wc -l | tr -d ' ')"

  # The manifest inside the clone is the authority for everything it can measure about itself.
  CLONED_MANIFEST="$CLONE_DIR/$MANIFEST_PATH"
  MANIFEST_OK=0
  if [ -f "$CLONED_MANIFEST" ] && jq empty "$CLONED_MANIFEST" >/dev/null 2>&1; then
    MANIFEST_OK=1
    report MANIFEST_PRESENT PASS "$MANIFEST_PATH is present in the published tree and is valid JSON"
  else
    report MANIFEST_PRESENT FAIL "$MANIFEST_PATH is missing or unparseable in the published tree"
  fi

  mfield() { jq -r "$1 // empty" "$CLONED_MANIFEST" 2>/dev/null || true; }

  if [ -z "$EXPECT_FILE_COUNT" ] && [ "$MANIFEST_OK" = 1 ]; then
    EXPECT_FILE_COUNT="$(mfield '.publicExport.fileCount')"
  fi

  if [ -z "$EXPECT_FILE_COUNT" ]; then
    report CLONE_FILE_COUNT INCONCLUSIVE "tracked=$TRACKED_COUNT but no expected count was supplied and none could be read from the manifest"
  elif [ "$TRACKED_COUNT" = "$EXPECT_FILE_COUNT" ]; then
    report CLONE_FILE_COUNT PASS "tracked=$TRACKED_COUNT"
  else
    report CLONE_FILE_COUNT FAIL "tracked=$TRACKED_COUNT expected=$EXPECT_FILE_COUNT"
  fi
else
  report CLONE_ROOT_COMMIT    INCONCLUSIVE "no clone"
  report CLONE_SINGLE_COMMIT  INCONCLUSIVE "no clone"
  report CLONE_SINGLE_ROOT    INCONCLUSIVE "no clone"
  report MANIFEST_PRESENT     INCONCLUSIVE "no clone"
  report CLONE_FILE_COUNT     INCONCLUSIVE "no clone"
  MANIFEST_OK=0
fi

# ---------------------------------------------------------------------------------------------
# CHECK 2 - RECOMPUTE THE EXPORT CONTENT DIGEST
#
# This is the one check a stranger can perform that proves the published tree is the tree the
# manifest describes. Everything else in this script is a property of an artefact; this is the
# binding between two artefacts, and it is the only reason the manifest is worth publishing.
#
# The algorithm has to match the generator exactly, byte for byte, or it proves nothing:
#
#   1. every exported path, sorted
#   2. minus the manifest itself - it cannot contain its own digest, so it is excluded by name
#   3. each rendered as "<path> <sha256-of-contents>"
#   4. joined with a single LF and NO trailing newline
#   5. SHA-256 of that string
#
# Step 4 is where a reimplementation goes wrong. `sha256sum < file` over a file written with a
# trailing newline gives a different answer, and the difference is invisible in the output.
#
# Two guards fail the check closed rather than let it produce a confident wrong answer:
#   - a path containing a newline cannot be read by POSIX `read`, so the NUL-separated and
#     line-separated listings are counted against each other;
#   - a non-ASCII path is refused because the generator sorts in JavaScript, whose sort is by UTF-16
#     code unit, and that stops agreeing with byte order above the BMP. No such path exists today;
#     the point is that if one ever appears, this reports a refusal rather than a mismatch.
# ---------------------------------------------------------------------------------------------

recompute_content_digest() {
  _exclude="$1"
  git_in_clone ls-files | LC_ALL=C sort | {
    _sep=''
    while IFS= read -r _path; do
      # `if` rather than `[ ... ] && continue`: under `set -e` an AND-OR list whose test fails yields a
      # non-zero status at statement level, and shells have historically disagreed about whether that
      # terminates the script. The digest loop is the last place to accept an ambiguity like that.
      if [ "$_path" != "$_exclude" ]; then
        _h="$(sha256_file "$CLONE_DIR/$_path")"
        printf '%s%s %s' "$_sep" "$_path" "$_h"
        _sep='
'
      fi
    done
  } | sha256_stdin
}

if [ "$CLONE_OK" = 1 ] && [ "$MANIFEST_OK" = 1 ]; then
  RECORDED_DIGEST="$(mfield '.publicExport.contentDigest')"
  DIGEST_EXCLUDES="$(mfield '.publicExport.digestExcludes')"
  [ -n "$DIGEST_EXCLUDES" ] || DIGEST_EXCLUDES="$MANIFEST_PATH"

  # The pinned-EOL guard described above: if this file is ever dropped from the export, say so,
  # because from that moment the digest becomes a property of the host rather than of the release.
  if [ -f "$CLONE_DIR/.gitattributes" ]; then
    report EXPORT_EOL_PINNED PASS ".gitattributes is exported, so checkout bytes are host-independent"
  else
    report EXPORT_EOL_PINNED FAIL ".gitattributes is absent from the export; checkout line endings are now host-dependent and the content digest is not reproducible"
  fi

  PATHS_NL="$(git_in_clone ls-files | wc -l | tr -d ' ')"
  PATHS_NUL="$(git_in_clone ls-files -z | tr -dc '\000' | wc -c | tr -d ' ')"
  PATH_GUARD_OK=1
  if [ "$PATHS_NL" != "$PATHS_NUL" ]; then
    PATH_GUARD_OK=0
    report EXPORT_PATHS_SAFE FAIL "a tracked path contains a newline ($PATHS_NL line-separated vs $PATHS_NUL NUL-separated); the digest cannot be recomputed safely in sh"
  elif git_in_clone ls-files | LC_ALL=C grep -q '[^ -~]'; then
    PATH_GUARD_OK=0
    report EXPORT_PATHS_SAFE FAIL "a tracked path contains a non-ASCII byte; the generator's UTF-16 sort order and this script's byte order may disagree"
  else
    report EXPORT_PATHS_SAFE PASS "$PATHS_NL tracked paths, all printable ASCII, none containing a newline"
  fi

  if [ "$PATH_GUARD_OK" = 1 ] && [ -n "$RECORDED_DIGEST" ]; then
    COMPUTED_DIGEST="$(recompute_content_digest "$DIGEST_EXCLUDES")"
    if [ "$COMPUTED_DIGEST" = "$RECORDED_DIGEST" ]; then
      report EXPORT_CONTENT_DIGEST PASS "recomputed=$COMPUTED_DIGEST equals the manifest's contentDigest over $PATHS_NL paths excluding $DIGEST_EXCLUDES"
    else
      report EXPORT_CONTENT_DIGEST FAIL "recomputed=$COMPUTED_DIGEST manifest=$RECORDED_DIGEST excluded=$DIGEST_EXCLUDES paths=$PATHS_NL"
      note "The published tree is not the tree the manifest describes, OR the manifest recorded a digest of"
      note "something other than the revision it names. Check which before concluding the export is wrong:"
      note "  - the manifest names source.revision=$(mfield '.source.revision')"
      note "  - the published root commit is $EXPECT_COMMIT"
      note "  - if the digest was generated over the generator's WORKING TREE rather than over that revision,"
      note "    the published tree can be perfectly correct while this check fails. That is a defect in the"
      note "    manifest generator, not in the publication, and it is the known failure mode for this field."
    fi
  elif [ -z "$RECORDED_DIGEST" ]; then
    report EXPORT_CONTENT_DIGEST FAIL "the published manifest records no publicExport.contentDigest"
  else
    report EXPORT_CONTENT_DIGEST INCONCLUSIVE "path guard refused; see EXPORT_PATHS_SAFE"
  fi
else
  report EXPORT_EOL_PINNED     INCONCLUSIVE "no clone or no manifest"
  report EXPORT_PATHS_SAFE     INCONCLUSIVE "no clone or no manifest"
  report EXPORT_CONTENT_DIGEST INCONCLUSIVE "no clone or no manifest"
fi

# ---------------------------------------------------------------------------------------------
# CHECK 3 - TAG
#
# Annotated rather than lightweight matters because a lightweight tag carries no tagger, no date and
# nothing to sign. A release referred to by a lightweight tag has no record of who created it, and
# the distinction is invisible in the GitHub web interface, which renders both identically.
# ---------------------------------------------------------------------------------------------

if [ "$CLONE_OK" = 1 ]; then
  # Clone fetches tags by default, but a shallow or mirror-configured remote may not have; ask again
  # rather than assume, and treat a failure here as inconclusive rather than as an absent tag.
  git_in_clone fetch --quiet --tags origin >/dev/null 2>&1 || true

  if git_in_clone rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null 2>&1; then
    TAG_OBJ="$(git_in_clone rev-parse "refs/tags/$TAG")"
    TAG_TYPE="$(git_in_clone cat-file -t "$TAG_OBJ")"
    TAG_COMMIT="$(git_in_clone rev-parse "refs/tags/$TAG^{commit}")"

    if [ "$TAG_TYPE" = "tag" ]; then
      report TAG_ANNOTATED PASS "$TAG is an annotated tag object $TAG_OBJ tagger=$(git_in_clone for-each-ref "refs/tags/$TAG" --format='%(taggername) %(taggerdate:iso)')"
    else
      report TAG_ANNOTATED FAIL "$TAG is a $TAG_TYPE, not an annotated tag; it carries no tagger and cannot be signed"
    fi

    if [ "$TAG_COMMIT" = "$EXPECT_COMMIT" ]; then
      report TAG_DEREFERENCES PASS "$TAG -> $TAG_COMMIT"
    else
      report TAG_DEREFERENCES FAIL "$TAG -> $TAG_COMMIT expected=$EXPECT_COMMIT"
    fi
  else
    report TAG_ANNOTATED     FAIL "tag $TAG does not exist in the published repository"
    report TAG_DEREFERENCES  FAIL "tag $TAG does not exist in the published repository"
  fi
else
  report TAG_ANNOTATED    INCONCLUSIVE "no clone"
  report TAG_DEREFERENCES INCONCLUSIVE "no clone"
fi

# The image tag defaults to the version the published manifest declares, never to a literal.
if [ -z "$IMAGE_TAG" ] && [ "$MANIFEST_OK" = 1 ]; then
  IMAGE_TAG="$(mfield '.version')"
fi

# ---------------------------------------------------------------------------------------------
# Registry helpers. All anonymous; all read-only; none of them is evidence of absence.
# ---------------------------------------------------------------------------------------------

ACCEPT_MANIFEST='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

# An anonymous pull token. GHCR and Docker Hub both issue one to anybody who asks; possession of one
# says nothing about what it can reach.
anon_token() {
  case "$1" in
    ghcr.io/*)   _repo="${1#ghcr.io/}";   _url="https://ghcr.io/token?service=ghcr.io&scope=repository:${_repo}:pull" ;;
    docker.io/*) _repo="${1#docker.io/}"; _url="https://auth.docker.io/token?service=registry.docker.io&scope=repository:${_repo}:pull" ;;
    *) return 1 ;;
  esac
  curl -fsS --max-time 30 "$_url" 2>/dev/null | jq -r '.token // .access_token // empty' 2>/dev/null || true
}

registry_base() {
  case "$1" in
    ghcr.io/*)   printf 'https://ghcr.io/v2/%s\n' "${1#ghcr.io/}" ;;
    docker.io/*) printf 'https://registry-1.docker.io/v2/%s\n' "${1#docker.io/}" ;;
    *) return 1 ;;
  esac
}

# HTTP status of an anonymous HEAD for one tag's manifest. Returns the code on stdout.
#
# The token-present and token-absent calls are written out in full rather than assembled with
# ${tok:+...}. An unquoted parameter expansion carrying `-H "Authorization: Bearer <tok>"` is split on
# spaces into four arguments, and curl then receives `-H Authorization:` followed by two stray URLs -
# which fails in a way that looks exactly like a registry saying no.
tag_http_status() {
  _image="$1"; _tag="$2"
  _base="$(registry_base "$_image")" || { printf '000\n'; return 0; }
  _tok="$(anon_token "$_image")" || _tok=''
  if [ -n "$_tok" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 30 -I \
      -H "Accept: $ACCEPT_MANIFEST" -H "Authorization: Bearer $_tok" \
      "$_base/manifests/$_tag" 2>/dev/null || printf '000'
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 30 -I \
      -H "Accept: $ACCEPT_MANIFEST" \
      "$_base/manifests/$_tag" 2>/dev/null || printf '000'
  fi
}

# ---------------------------------------------------------------------------------------------
# CHECK 4 - ANONYMOUS PULL FROM GHCR, AND THE REAL REGISTRY DIGEST
#
# RepoDigests is captured rather than assumed. The distinction it carries is the one this project has
# already been caught by: for a locally built image the containerd store computes a manifest digest at
# build time and reports it in RepoDigests anyway, and that value is EQUAL to the image Id. A registry
# digest is not - it is the digest of the manifest the registry actually stored, over a manifest that
# did not exist at build time. So `RepoDigest == Id` is the tell that nothing was ever pushed, and the
# release manifest's own `localImageId` field exists because that exact confusion happened here once.
#
# The pull is run against whatever credentials the host holds, and the presence of any is reported,
# because a stale GHCR token makes a private package pull cleanly for the operator and fail for every
# stranger. That failure is invisible from inside.
# ---------------------------------------------------------------------------------------------

GHCR_DIGEST=''
HUB_DIGEST=''
PULLED_REF=''

if [ "$SKIP_REGISTRY" = 1 ]; then
  report GHCR_ANONYMOUS_PULL SKIP "--skip-registry"
  report GHCR_REGISTRY_DIGEST SKIP "--skip-registry"
  report HUB_ANONYMOUS_PULL SKIP "--skip-registry"
  report REGISTRY_DIGEST_PARITY SKIP "--skip-registry"
  report IMAGE_OCI_LABELS SKIP "--skip-registry"
  report FORBIDDEN_TAGS_ABSENT SKIP "--skip-registry"
elif ! have docker; then
  report GHCR_ANONYMOUS_PULL INCONCLUSIVE "docker is not available on this host"
  report GHCR_REGISTRY_DIGEST INCONCLUSIVE "docker is not available on this host"
  report HUB_ANONYMOUS_PULL INCONCLUSIVE "docker is not available on this host"
  report REGISTRY_DIGEST_PARITY INCONCLUSIVE "docker is not available on this host"
  report IMAGE_OCI_LABELS INCONCLUSIVE "docker is not available on this host"
  report FORBIDDEN_TAGS_ABSENT INCONCLUSIVE "docker is not available on this host"
elif [ -z "$IMAGE_TAG" ]; then
  report GHCR_ANONYMOUS_PULL INCONCLUSIVE "no image tag supplied and none readable from the published manifest"
  report GHCR_REGISTRY_DIGEST INCONCLUSIVE "no image tag"
  report HUB_ANONYMOUS_PULL INCONCLUSIVE "no image tag"
  report REGISTRY_DIGEST_PARITY INCONCLUSIVE "no image tag"
  report IMAGE_OCI_LABELS INCONCLUSIVE "no image tag"
  report FORBIDDEN_TAGS_ABSENT INCONCLUSIVE "no image tag"
else
  # Named per registry so a report can quote one line without ambiguity about which registry it
  # concerns; two lines sharing one check name are not quotable.
  for _reg in "$(registry_host "$GHCR_IMAGE")" "$(registry_host "$HUB_IMAGE")"; do
    _anon_name="REGISTRY_ANONYMITY_$(printf '%s' "$_reg" | tr 'a-z.-' 'A-Z__')"
    if has_stored_credential "$_reg"; then
      report "$_anon_name" FAIL "$(docker_config_file) holds an auth entry for $_reg; this run is not anonymous and a private package would pull cleanly here and fail for every stranger"
    else
      report "$_anon_name" PASS "no stored credential for $_reg in $(docker_config_file)"
    fi
  done

  GHCR_REF="$GHCR_IMAGE:$IMAGE_TAG"
  if docker pull --quiet "$GHCR_REF" >"$WORK_DIR/ghcr-pull.log" 2>&1; then
    PULLED_REF="$GHCR_REF"
    report GHCR_ANONYMOUS_PULL PASS "pulled $GHCR_REF anonymously"

    IMAGE_ID="$(docker image inspect "$GHCR_REF" --format '{{.Id}}' 2>/dev/null || true)"
    # Select the RepoDigest belonging to this repository rather than index 0: a host that has pulled
    # the mirror as well carries two, and taking the first would silently compare a registry against
    # itself.
    GHCR_DIGEST="$(docker image inspect "$GHCR_REF" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null \
      | grep "^${GHCR_IMAGE}@" | head -n 1 | sed 's/.*@//' || true)"

    if [ -z "$GHCR_DIGEST" ]; then
      report GHCR_REGISTRY_DIGEST FAIL "the pulled image carries no RepoDigest for $GHCR_IMAGE"
    elif [ "$GHCR_DIGEST" = "$IMAGE_ID" ]; then
      # Equal only in the local-build case. See the block comment above.
      report GHCR_REGISTRY_DIGEST FAIL "RepoDigest $GHCR_DIGEST equals the image Id; this is a locally built image, not one resolved from a registry"
    else
      report GHCR_REGISTRY_DIGEST PASS "RepoDigest=$GHCR_DIGEST distinct from image Id=$IMAGE_ID"
    fi
  else
    report GHCR_ANONYMOUS_PULL FAIL "anonymous pull of $GHCR_REF failed; see $WORK_DIR/ghcr-pull.log"
    report GHCR_REGISTRY_DIGEST INCONCLUSIVE "no pull"
    note "$(tail -n 3 "$WORK_DIR/ghcr-pull.log" 2>/dev/null || true)"
  fi

  # -------------------------------------------------------------------------------------------
  # CHECK 5 - DOCKER HUB, AND DIGEST PARITY
  #
  # Parity is the only thing that makes a mirror trustworthy. A tag that exists on both registries
  # establishes nothing on its own: two registries can serve two different images under one name,
  # and the person who pulls the mirror has no way to notice. Only equality of the manifest digest
  # says that the mirror is the same artefact rather than merely a thing with the same label. A
  # mirror holding a different digest is a collision, not a retry.
  # -------------------------------------------------------------------------------------------

  HUB_REF="$HUB_IMAGE:$IMAGE_TAG"
  if docker pull --quiet "$HUB_REF" >"$WORK_DIR/hub-pull.log" 2>&1; then
    report HUB_ANONYMOUS_PULL PASS "pulled $HUB_REF anonymously"
    HUB_DIGEST="$(docker image inspect "$HUB_REF" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null \
      | grep -E "^(docker\.io/)?${HUB_IMAGE#docker.io/}@" | head -n 1 | sed 's/.*@//' || true)"
  else
    report HUB_ANONYMOUS_PULL FAIL "anonymous pull of $HUB_REF failed; see $WORK_DIR/hub-pull.log"
    note "$(tail -n 3 "$WORK_DIR/hub-pull.log" 2>/dev/null || true)"
  fi

  if [ -n "$GHCR_DIGEST" ] && [ -n "$HUB_DIGEST" ]; then
    if [ "$GHCR_DIGEST" = "$HUB_DIGEST" ]; then
      report REGISTRY_DIGEST_PARITY PASS "ghcr=$GHCR_DIGEST hub=$HUB_DIGEST"
    else
      report REGISTRY_DIGEST_PARITY FAIL "ghcr=$GHCR_DIGEST hub=$HUB_DIGEST - the mirror serves a different artefact under the same tag"
    fi
  else
    report REGISTRY_DIGEST_PARITY INCONCLUSIVE "ghcr=${GHCR_DIGEST:-none} hub=${HUB_DIGEST:-none}; parity cannot be asserted without both"
  fi

  # -------------------------------------------------------------------------------------------
  # CHECK 6 - OCI LABELS
  #
  # Compared against the published manifest and the published Dockerfile, never against literals
  # here. version and revision are build arguments, so their authority is the manifest; title,
  # description, licenses and source are fixed strings in the Dockerfile, so the authority for those
  # is the Dockerfile in the clone - which makes this a genuine cross-artefact check rather than a
  # restatement of a constant.
  #
  # `created` has no authority anywhere: nothing records the build timestamp. It is checked for the
  # thing that actually goes wrong, which is the Dockerfile's own ARG default of "unknown" surviving
  # into a published image because the build did not pass --build-arg.
  # -------------------------------------------------------------------------------------------

  # Pull the fixed label value out of the cloned Dockerfile. Refuses to answer for a value that is a
  # build argument, because then the Dockerfile is not the authority for it.
  dockerfile_label() {
    _key="$1"
    _v="$(sed -n "s/.*org\.opencontainers\.image\.${_key}=\"\([^\"]*\)\".*/\1/p" "$CLONE_DIR/Dockerfile" 2>/dev/null | head -n 1)"
    case "$_v" in
      *'$'*) return 1 ;;
      '')    return 1 ;;
      *)     printf '%s\n' "$_v" ;;
    esac
  }

  if [ -n "$PULLED_REF" ] && [ "$MANIFEST_OK" = 1 ]; then
    docker image inspect "$PULLED_REF" --format '{{json .Config.Labels}}' >"$WORK_DIR/labels.json" 2>/dev/null || echo '{}' >"$WORK_DIR/labels.json"
    label() { jq -r --arg k "org.opencontainers.image.$1" '.[$k] // empty' "$WORK_DIR/labels.json"; }

    LABEL_FAILURES=''
    add_failure() { LABEL_FAILURES="$LABEL_FAILURES $1"; }

    # revision and version: the manifest is the authority.
    L_REV="$(label revision)"; M_REV="$(mfield '.source.revision')"
    [ -n "$L_REV" ] && [ "$L_REV" = "$M_REV" ] || add_failure "revision(image=${L_REV:-none},manifest=${M_REV:-none})"

    L_VER="$(label version)"; M_VER="$(mfield '.version')"
    [ -n "$L_VER" ] && [ "$L_VER" = "$M_VER" ] || add_failure "version(image=${L_VER:-none},manifest=${M_VER:-none})"

    # created: no authority exists, so assert the shape and reject the ARG default.
    L_CREATED="$(label created)"
    case "$L_CREATED" in
      ''|unknown) add_failure "created(${L_CREATED:-none} - the Dockerfile ARG default survived; the build did not pass OPENPPWR_BUILD_TIMESTAMP)" ;;
      [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T*) : ;;
      *) add_failure "created($L_CREATED is not an RFC 3339 timestamp)" ;;
    esac

    # title, description, licenses, source: the cloned Dockerfile is the authority.
    for _k in title description licenses source; do
      _actual="$(label "$_k")"
      if _expected="$(dockerfile_label "$_k")"; then
        [ "$_actual" = "$_expected" ] || add_failure "$_k(image=${_actual:-none},Dockerfile=$_expected)"
      else
        add_failure "$_k(no fixed value in the published Dockerfile to compare against)"
      fi
    done

    if [ -z "$LABEL_FAILURES" ]; then
      report IMAGE_OCI_LABELS PASS "revision=$L_REV version=$L_VER created=$L_CREATED title/description/licenses/source match the published Dockerfile"
    else
      report IMAGE_OCI_LABELS FAIL "mismatched:$LABEL_FAILURES"
      note "Note the known ambiguity in 'revision': the manifest names the PRIVATE source revision, which"
      note "does not exist in the public repository. An image built by CI from the public repository will"
      note "stamp the PUBLIC root commit instead. Decide which one the label is meant to carry before"
      note "treating a mismatch here as a build defect."
    fi
  else
    report IMAGE_OCI_LABELS INCONCLUSIVE "no pulled image or no published manifest"
  fi

  # -------------------------------------------------------------------------------------------
  # CHECK 8 - FORBIDDEN TAGS ABSENT
  #
  # This check is worthless without a positive control, and saying so is the point of it.
  #
  # An anonymous 404 or 401 from a registry is not evidence of absence. This project proved that
  # experimentally: a package name INVENTED for the test returned exactly the same anonymous response
  # as the real repository. GHCR answers 403 to both. Docker Hub answers 401 to a real private
  # repository and 401 to one that was never created. There is no anonymous request that distinguishes
  # "does not exist" from "exists and you may not see it".
  #
  # So the absence of a forbidden tag is asserted ONLY when a tag known to exist is observable by the
  # same probe on the same registry. If the control is not observable, the probe cannot see anything,
  # and the honest verdict is INCONCLUSIVE - which is not a pass and exits non-zero.
  # -------------------------------------------------------------------------------------------

  FORBIDDEN_RESULT=''
  for _image in "$GHCR_IMAGE" "$HUB_IMAGE"; do
    _control="$(tag_http_status "$_image" "$IMAGE_TAG")"
    if [ "$_control" != "200" ]; then
      FORBIDDEN_RESULT="$FORBIDDEN_RESULT ${_image}=NO_CONTROL(published tag $IMAGE_TAG answered http=$_control)"
      continue
    fi
    for _ftag in $FORBIDDEN_TAGS; do
      _st="$(tag_http_status "$_image" "$_ftag")"
      if [ "$_st" = "200" ]; then
        FORBIDDEN_RESULT="$FORBIDDEN_RESULT ${_image}:${_ftag}=PRESENT"
      fi
    done
  done

  case "$FORBIDDEN_RESULT" in
    '')
      report FORBIDDEN_TAGS_ABSENT PASS "none of [$FORBIDDEN_TAGS] resolves on either registry, and on both the published tag $IMAGE_TAG did resolve, so the probe can see tags that exist"
      ;;
    *NO_CONTROL*)
      report FORBIDDEN_TAGS_ABSENT INCONCLUSIVE "$FORBIDDEN_RESULT - an anonymous non-200 proves nothing about existence; without a positive control this check measures nothing"
      ;;
    *)
      report FORBIDDEN_TAGS_ABSENT FAIL "$FORBIDDEN_RESULT"
      ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
# CHECK 7 - RUNTIME SMOKE
#
# The published image is started against a throwaway PostgreSQL on a throwaway network, migrated with
# the image's own migration entry point, and asked what it is.
#
# This is the only check that establishes that the artefact runs. Everything above verifies bytes;
# a published image whose bytes are perfect and which exits on start is still a broken release, and
# no digest comparison would notice.
#
# `migrationLevelVerified` is the assertion that matters, and it is why the whole database is worth
# standing up. `migrationLevel` is what the image was BUILT claiming; `appliedMigrationLevel` is what
# the database actually holds. Only the third field says the two agree. Asserting the first alone
# would be taking the image's word for it, which is what this endpoint was changed to stop doing.
#
# The PostgreSQL image is read from the cloned compose file rather than named here, so this cannot
# drift from what the release actually deploys.
# ---------------------------------------------------------------------------------------------

if [ "$SKIP_RUNTIME" = 1 ]; then
  report RUNTIME_HEALTH_LIVE   SKIP "--skip-runtime"
  report RUNTIME_HEALTH_READY  SKIP "--skip-runtime"
  report RUNTIME_VERSION       SKIP "--skip-runtime"
  report RUNTIME_MIGRATION_VERIFIED SKIP "--skip-runtime"
elif [ -z "$PULLED_REF" ]; then
  report RUNTIME_HEALTH_LIVE   INCONCLUSIVE "no image was pulled; nothing to run"
  report RUNTIME_HEALTH_READY  INCONCLUSIVE "no image was pulled; nothing to run"
  report RUNTIME_VERSION       INCONCLUSIVE "no image was pulled; nothing to run"
  report RUNTIME_MIGRATION_VERIFIED INCONCLUSIVE "no image was pulled; nothing to run"
else
  PG_IMAGE="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\).*/\1/p' "$CLONE_DIR/deploy/community/docker-compose.yml" 2>/dev/null | head -n 1)"
  if [ -z "$PG_IMAGE" ]; then
    report RUNTIME_HEALTH_LIVE   INCONCLUSIVE "could not read the PostgreSQL image from the published compose file"
    report RUNTIME_HEALTH_READY  INCONCLUSIVE "could not read the PostgreSQL image from the published compose file"
    report RUNTIME_VERSION       INCONCLUSIVE "could not read the PostgreSQL image from the published compose file"
    report RUNTIME_MIGRATION_VERIFIED INCONCLUSIVE "could not read the PostgreSQL image from the published compose file"
  else
    _sfx="$$"
    SMOKE_NET="openppwr-verify-$_sfx"
    SMOKE_PG="openppwr-verify-pg-$_sfx"
    SMOKE_API="openppwr-verify-api-$_sfx"

    # Distinct per principal: prepare.mjs refuses a password reused between principals, because shared
    # credentials leave the grants separated while the capability is not. Generated, never fixed - the
    # bootstrap token is additionally length-checked by the application at startup.
    rand_secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
    DB_PW="$(rand_secret)"; RT_PW="$(rand_secret)"; WK_PW="$(rand_secret)"; BOOT="$(rand_secret)"

    RUNTIME_READY=0
    docker network create "$SMOKE_NET" >/dev/null 2>&1 || true

    if docker run -d --name "$SMOKE_PG" --network "$SMOKE_NET" \
        -e POSTGRES_DB=openppwr -e POSTGRES_USER=openppwr_migrator -e POSTGRES_PASSWORD="$DB_PW" \
        "$PG_IMAGE" >/dev/null 2>"$WORK_DIR/pg.log"; then

      # Poll rather than sleep a fixed interval: a slow host makes a fixed wait either flaky or wasteful.
      _waited=0
      while [ "$_waited" -lt 90 ]; do
        if docker exec "$SMOKE_PG" pg_isready -U openppwr_migrator -d openppwr >/dev/null 2>&1; then break; fi
        sleep 2; _waited=$((_waited + 2))
      done

      if docker run --rm --network "$SMOKE_NET" \
          -e OPENPPWR_MIGRATION_DATABASE_URL="postgres://openppwr_migrator:$DB_PW@$SMOKE_PG/openppwr" \
          -e OPENPPWR_RUNTIME_DATABASE_PASSWORD="$RT_PW" \
          -e OPENPPWR_WORKER_DATABASE_PASSWORD="$WK_PW" \
          "$PULLED_REF" packages/database/src/prepare.mjs >"$WORK_DIR/migrate.log" 2>&1; then
        report RUNTIME_MIGRATE PASS "the published image migrated a fresh database using its own migration entry point"

        if docker run -d --name "$SMOKE_API" --network "$SMOKE_NET" \
            -p "127.0.0.1:$SMOKE_PORT:3000" \
            -e OPENPPWR_DATABASE_URL="postgres://openppwr_app:$RT_PW@$SMOKE_PG/openppwr" \
            -e OPENPPWR_BOOTSTRAP_TOKEN="$BOOT" \
            -e OPENPPWR_SERVE_WEB=false \
            "$PULLED_REF" >/dev/null 2>"$WORK_DIR/api.log"; then
          _waited=0
          while [ "$_waited" -lt 90 ]; do
            if curl -fsS --max-time 5 "http://127.0.0.1:$SMOKE_PORT/health/live" >/dev/null 2>&1; then
              RUNTIME_READY=1; break
            fi
            sleep 2; _waited=$((_waited + 2))
          done
        fi
      else
        report RUNTIME_MIGRATE FAIL "the published image could not migrate a fresh database; see $WORK_DIR/migrate.log"
        note "$(tail -n 5 "$WORK_DIR/migrate.log" 2>/dev/null || true)"
      fi
    else
      report RUNTIME_MIGRATE INCONCLUSIVE "the throwaway PostgreSQL container would not start; see $WORK_DIR/pg.log"
    fi

    if [ "$RUNTIME_READY" = 1 ]; then
      if curl -fsS --max-time 10 "http://127.0.0.1:$SMOKE_PORT/health/live" -o "$WORK_DIR/live.json" 2>/dev/null; then
        report RUNTIME_HEALTH_LIVE PASS "/health/live answered 200"
      else
        report RUNTIME_HEALTH_LIVE FAIL "/health/live did not answer 200"
      fi

      if curl -fsS --max-time 10 "http://127.0.0.1:$SMOKE_PORT/health/ready" -o "$WORK_DIR/ready.json" 2>/dev/null \
         && [ "$(jq -r '.ready // false' "$WORK_DIR/ready.json")" = "true" ]; then
        report RUNTIME_HEALTH_READY PASS "/health/ready answered 200 with ready=true"
      else
        report RUNTIME_HEALTH_READY FAIL "/health/ready did not report ready=true: $(jq -c '.reasons // .' "$WORK_DIR/ready.json" 2>/dev/null || echo 'no body')"
      fi

      if curl -fsS --max-time 10 "http://127.0.0.1:$SMOKE_PORT/v1/version" -o "$WORK_DIR/version.json" 2>/dev/null; then
        V_VERSION="$(jq -r '.version // empty' "$WORK_DIR/version.json")"
        V_MIG="$(jq -r '.migrationLevel // empty' "$WORK_DIR/version.json")"
        V_APPLIED="$(jq -r '.appliedMigrationLevel // empty' "$WORK_DIR/version.json")"
        V_VERIFIED="$(jq -r '.migrationLevelVerified // false' "$WORK_DIR/version.json")"

        M_VERSION="$(mfield '.version')"
        M_MIG="$(mfield '.source.migrationLevel')"

        VER_FAILURES=''
        [ -n "$V_VERSION" ] && [ "$V_VERSION" = "$M_VERSION" ] || VER_FAILURES="$VER_FAILURES version(reported=${V_VERSION:-none},manifest=${M_VERSION:-none})"
        [ -n "$V_MIG" ] && [ "$V_MIG" = "$M_MIG" ] || VER_FAILURES="$VER_FAILURES migrationLevel(reported=${V_MIG:-none},manifest=${M_MIG:-none})"
        [ -n "$V_APPLIED" ] && [ "$V_APPLIED" = "$M_MIG" ] || VER_FAILURES="$VER_FAILURES appliedMigrationLevel(reported=${V_APPLIED:-none},manifest=${M_MIG:-none})"

        if [ -z "$VER_FAILURES" ]; then
          report RUNTIME_VERSION PASS "version=$V_VERSION migrationLevel=$V_MIG appliedMigrationLevel=$V_APPLIED all agree with the published manifest"
        else
          report RUNTIME_VERSION FAIL "mismatched:$VER_FAILURES"
        fi

        # Asserted separately and last. It is the only field that says the image's claim about its
        # schema and the database's actual schema were compared rather than merely both reported.
        if [ "$V_VERIFIED" = "true" ]; then
          report RUNTIME_MIGRATION_VERIFIED PASS "migrationLevelVerified=true"
        else
          report RUNTIME_MIGRATION_VERIFIED FAIL "migrationLevelVerified=$V_VERIFIED; the running image's declared schema and the database's applied schema do not agree"
        fi
      else
        report RUNTIME_VERSION INCONCLUSIVE "/v1/version did not answer"
        report RUNTIME_MIGRATION_VERIFIED INCONCLUSIVE "/v1/version did not answer"
      fi
    else
      report RUNTIME_HEALTH_LIVE   FAIL "the published image did not become live within 90s; see $WORK_DIR/api.log and docker logs $SMOKE_API"
      report RUNTIME_HEALTH_READY  INCONCLUSIVE "the container never became live"
      report RUNTIME_VERSION       INCONCLUSIVE "the container never became live"
      report RUNTIME_MIGRATION_VERIFIED INCONCLUSIVE "the container never became live"
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------
# Summary. INCONCLUSIVE is reported separately from FAIL and separately from PASS, because the
# entire reason this script exists is that a green which was never measured is worse than a red.
# ---------------------------------------------------------------------------------------------

printf 'OPENPPWR_VERIFY SUMMARY %s pass=%d fail=%d inconclusive=%d skipped=%d\n' \
  "$( [ "$N_FAIL" -gt 0 ] && echo FAIL || { [ "$N_INCONCLUSIVE" -gt 0 ] && echo INCONCLUSIVE || echo PASS; } )" \
  "$N_PASS" "$N_FAIL" "$N_INCONCLUSIVE" "$N_SKIP"

if [ "$N_FAIL" -gt 0 ]; then exit 1; fi
if [ "$N_INCONCLUSIVE" -gt 0 ]; then exit 2; fi
exit 0
