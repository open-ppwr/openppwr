#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Manifest classification and platform normalisation for the GHCR -> Docker Hub mirror.
#
# This lives outside the workflow because the first version of it lived inside one, as forty lines of
# inline shell that no test could reach, and it held two defects:
# an unparseable registry response was indistinguishable from a single-platform manifest, and an
# empty platform set compared equal to another empty platform set and reported parity. Both were in
# branches nothing exercised. Logic that decides whether two published images are the same artifact
# has to be testable, so it is a script with fixtures rather than a heredoc.
#
# Every subcommand reads files and writes stdout. None of them contacts a registry: the workflow
# performs the registry reads and hands the responses over as files, so the parser can be tested
# without credentials, without a network and without a published image.
#
# Exit codes:
#   0  success
#   1  validation failure - the caller must treat this as fail-closed
#
# Usage:
#   verify-registry-mirror.sh media-type        <manifest.json>
#   verify-registry-mirror.sh platforms         <manifest.json> [image-config.json]
#   verify-registry-mirror.sh attestation-count <manifest.json>
#   verify-registry-mirror.sh digest            <descriptor.json>
#   verify-registry-mirror.sh classify-inspect  <exit-code> <stderr-file>
#   verify-registry-mirror.sh compare-platforms <a.txt> <b.txt>

set -Eeuo pipefail

readonly SINGLE_MANIFEST_TYPES=(
  'application/vnd.oci.image.manifest.v1+json'
  'application/vnd.docker.distribution.manifest.v2+json'
)
readonly INDEX_TYPES=(
  'application/vnd.oci.image.index.v1+json'
  'application/vnd.docker.distribution.manifest.list.v2+json'
)

# One classification of index entries, defined once and used by every caller.
#
# There were two predicates before, and they disagreed: the platform filter excluded an entry when
# either os or architecture was "unknown", while the attestation counter counted it when os was
# "unknown". An entry with a known os and an unknown architecture therefore satisfied neither -- it
# was dropped from the platform set, absent from the attestation count, and raised nothing. Two
# manifests could go in and one platform plus zero attestations come out.
#
# Separately, review recorded the platform filter's two clauses as mutually redundant. They are not:
# they overlap only on unknown/unknown, which is the one shape the fixtures used. Each clause was the
# sole exclusion for a distinct input, and calling them redundant invites deleting one.
#
# Both problems are the same problem -- duplicated classification -- so there is now one definition.
# Every manifest is an attestation or a runtime platform; anything else fails closed rather than
# vanishing from the accounting.
readonly JQ_CLASSIFY='
  def is_attestation:
    ((.annotations["vnd.docker.reference.type"] // "") == "attestation-manifest")
    or (((.platform.os // "") == "unknown") and ((.platform.architecture // "") == "unknown"));
  def is_runtime:
    (is_attestation | not)
    and ((.platform.os // "") != "") and ((.platform.os // "") != "unknown")
    and ((.platform.architecture // "") != "") and ((.platform.architecture // "") != "unknown");
'

fail() {
  echo "MIRROR_VERIFY_FAIL $*" >&2
  exit 1
}

require_file() {
  local file="$1"
  [[ -n "$file" ]] || fail "no file given"
  [[ -f "$file" ]] || fail "file does not exist: $file"
  [[ -s "$file" ]] || fail "file is empty: $file"
}

# Strict parse first, questions afterwards. A parser error must never fall through into a branch that
# happens to describe one valid shape.
#
# `jq empty` rather than `jq -e .`: -e reports exit 1 when the *value* is null or false, which is
# indistinguishable from the exit it gives for a truncated document. Both are failures here, but they
# are different failures, and an operator told "not valid JSON" about a registry response of valid
# `null` looks in the wrong place. `empty` fails only on a parse error.
require_json() {
  local file="$1"
  require_file "$file"
  jq empty "$file" >/dev/null 2>&1 || fail "file is not valid JSON: $file"
}

# Valid JSON is not necessarily a usable document. `imagetools inspect --format '{{json .Image}}'`
# emits `null` when there is no image config, and that deserves its own diagnosis.
require_json_object() {
  local file="$1"
  require_json "$file"
  jq -e 'type == "object"' "$file" >/dev/null 2>&1 \
    || fail "expected a JSON object, got $(jq -r 'type' "$file" 2>/dev/null || echo unknown): $file"
}

# ----------------------------------------------------------------------------------------------
# media-type: validate the envelope and echo the media type.
# ----------------------------------------------------------------------------------------------
cmd_media_type() {
  local file="$1"
  require_json "$file"

  local schema
  schema="$(jq -r 'if has("schemaVersion") then (.schemaVersion|tostring) else "" end' "$file")"
  [[ "$schema" == "2" ]] || fail "unsupported schemaVersion: '${schema:-<missing>}'"

  local media
  media="$(jq -r 'if has("mediaType") then (.mediaType // "") else "" end' "$file")"
  [[ -n "$media" ]] || fail "manifest has no mediaType"

  local supported
  for supported in "${SINGLE_MANIFEST_TYPES[@]}" "${INDEX_TYPES[@]}"; do
    if [[ "$media" == "$supported" ]]; then
      printf '%s\n' "$media"
      return 0
    fi
  done
  fail "unsupported manifest mediaType: $media"
}

is_index_type() {
  local media="$1" candidate
  for candidate in "${INDEX_TYPES[@]}"; do
    [[ "$media" == "$candidate" ]] && return 0
  done
  return 1
}

# ----------------------------------------------------------------------------------------------
# platforms: emit the sorted, de-duplicated runtime platform set.
#
# Attestation manifests are not platforms. They are excluded by both signals docker uses - the
# unknown/unknown placeholder platform and the reference-type annotation - and counted separately by
# `attestation-count`, so they are never silently dropped.
# ----------------------------------------------------------------------------------------------
cmd_platforms() {
  local manifest="$1" image_config="${2:-}"
  local media
  media="$(cmd_media_type "$manifest")"

  local platforms
  if is_index_type "$media"; then
    jq -e 'has("manifests")' "$manifest" >/dev/null 2>&1 \
      || fail "index has no manifests array"
    jq -e '.manifests | type == "array"' "$manifest" >/dev/null 2>&1 \
      || fail "index manifests is not an array"
    jq -e '.manifests | length > 0' "$manifest" >/dev/null 2>&1 \
      || fail "index manifests array is empty"

    # Every entry must land in exactly one bucket. An entry that is neither a recognised attestation
    # nor a well-formed runtime platform -- no platform key, an empty field, or half "unknown" -- is a
    # malformed index, and it fails here rather than disappearing from both totals.
    local unaccounted
    unaccounted="$(jq -r "$JQ_CLASSIFY"'
      [ .manifests[] | select((is_attestation or is_runtime) | not) | (.digest // "<no digest>") ]
      | join(", ")
    ' "$manifest")"
    if [[ -n "$unaccounted" ]]; then
      fail "index entry is neither a runtime platform nor an attestation: $unaccounted"
    fi

    platforms="$(jq -r "$JQ_CLASSIFY"'
      .manifests[]
      | select(is_runtime)
      | [.platform.os, .platform.architecture, (.platform.variant // empty)]
      | join("/")
    ' "$manifest")"
  else
    # A single manifest does not carry its platform; the image config does.
    [[ -n "$image_config" ]] || fail "single manifest requires an image config file"
    require_json_object "$image_config"

    jq -e '(.os // "") != ""' "$image_config" >/dev/null 2>&1 \
      || fail "image config has no os"
    jq -e '(.architecture // "") != ""' "$image_config" >/dev/null 2>&1 \
      || fail "image config has no architecture"

    platforms="$(jq -r '[.os, .architecture, (.variant // empty)] | join("/")' "$image_config")"
  fi

  # Blank lines are removed before, not after, the comparison: two empty sets must never compare
  # equal and be reported as parity.
  platforms="$(printf '%s\n' "$platforms" | grep -Eve '^[[:space:]]*$' | sort -u || true)"
  [[ -n "$platforms" ]] || fail "no runtime platform resolved"

  while IFS= read -r entry; do
    [[ "$entry" =~ ^[a-z0-9._-]+/[a-z0-9._-]+(/[a-z0-9._-]+)?$ ]] \
      || fail "malformed platform entry: '$entry'"
  done <<<"$platforms"

  printf '%s\n' "$platforms"
}

# ----------------------------------------------------------------------------------------------
# attestation-count: how many entries were excluded as attestations. Reported, never assumed.
# ----------------------------------------------------------------------------------------------
cmd_attestation_count() {
  local manifest="$1"
  local media
  media="$(cmd_media_type "$manifest")"

  if is_index_type "$media"; then
    # Same predicate the platform set uses, so the two totals cannot disagree about one entry.
    jq -r "$JQ_CLASSIFY"'[ .manifests[]? | select(is_attestation) ] | length' "$manifest"
  else
    printf '0\n'
  fi
}

# ----------------------------------------------------------------------------------------------
# digest: the top-level descriptor digest, never a platform submanifest digest.
# ----------------------------------------------------------------------------------------------
cmd_digest() {
  local file="$1"
  require_json "$file"

  local digest
  digest="$(jq -er '.digest' "$file" 2>/dev/null)" || fail "descriptor has no digest"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "malformed digest: $digest"
  printf '%s\n' "$digest"
}

# ----------------------------------------------------------------------------------------------
# classify-inspect: NOT_FOUND only for a confirmed absent manifest. Everything else is an error.
#
# A non-zero exit code on its own proves nothing: an expired token, a rate limit and a 502 all
# produce one, and treating any of them as "the tag is free" is how a mirror overwrites an image.
# ----------------------------------------------------------------------------------------------
cmd_classify_inspect() {
  local exit_code="$1" stderr_file="$2"
  [[ "$exit_code" =~ ^[0-9]+$ ]] || fail "exit code is not numeric: $exit_code"

  if [[ "$exit_code" == "0" ]]; then
    printf 'PRESENT\n'
    return 0
  fi

  local text=''
  if [[ -n "$stderr_file" && -f "$stderr_file" ]]; then
    text="$(tr '[:upper:]' '[:lower:]' <"$stderr_file")"
  fi

  # Deny list wins. These are transient or permission conditions, never evidence of absence.
  if grep -Eq 'unauthorized|authentication required|forbidden|denied|access to the resource|rate limit|too many requests|toomanyrequests|429|timeout|timed out|deadline exceeded|connection refused|connection reset|no such host|temporary failure|eof|500 |502|503|504|internal server error|bad gateway|service unavailable|gateway timeout' <<<"$text"; then
    printf 'INSPECT_ERROR\n'
    return 0
  fi

  if grep -Eq 'not found|manifest unknown|manifest_unknown|no such manifest|does not exist|404' <<<"$text"; then
    printf 'NOT_FOUND\n'
    return 0
  fi

  printf 'INSPECT_ERROR\n'
}

# ----------------------------------------------------------------------------------------------
# compare-platforms: both sets must be non-empty and identical.
# ----------------------------------------------------------------------------------------------
cmd_compare_platforms() {
  local a="$1" b="$2"
  local name
  for name in "$a" "$b"; do
    require_file "$name"
    local count
    count="$(grep -cve '^[[:space:]]*$' "$name" || true)"
    [[ "${count:-0}" -gt 0 ]] || fail "platform set is empty: $name"
  done

  if ! diff -u <(grep -Eve '^[[:space:]]*$' "$a" | sort -u) <(grep -Eve '^[[:space:]]*$' "$b" | sort -u); then
    fail "platform sets differ"
  fi
  printf 'PLATFORM_PARITY_PASS\n'
}

main() {
  local command="${1:-}"
  shift || true
  case "$command" in
    media-type)        cmd_media_type "${1:-}" ;;
    platforms)         cmd_platforms "${1:-}" "${2:-}" ;;
    attestation-count) cmd_attestation_count "${1:-}" ;;
    digest)            cmd_digest "${1:-}" ;;
    classify-inspect)  cmd_classify_inspect "${1:-}" "${2:-}" ;;
    compare-platforms) cmd_compare_platforms "${1:-}" "${2:-}" ;;
    *)                 fail "unknown command: '${command:-<none>}'" ;;
  esac
}

main "$@"
