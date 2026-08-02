#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Verify a deployment's audit chain from outside it, on a schedule, and fail loudly when it does not hold.
#
# OpenPPWR verifies the audit chain on demand: `GET /v1/audit/verify` recomputes every event's hash and its
# link to the previous one, and answers. That makes tampering *detectable*. It does not make it *detected* —
# nothing runs the check, so a broken chain waits for somebody to ask. Continuous verification with alerting
# is Cloud-edition scope and is not in this repository.
#
# What is in scope, and what this is: the on-demand check turned into something an operator can put in cron
# without writing a parser. It needs `curl` and a POSIX shell, which the installer's own preflight already
# requires, and nothing else — no `jq`, no Node, no Python. It prints one line of JSON and returns an exit
# code, so the operator's existing alerting decides what to do about it.
#
#   OPENPPWR_AUDIT_TOKEN=... sh scripts/validation/verify-audit-chain.sh --base-url=http://127.0.0.1:8080
#
#   0  the chain verified
#   1  the chain did NOT verify — the record has been altered, or an event is missing. This is the alert.
#   2  this script was called wrongly (no token, bad argument)
#   3  the deployment could not be reached, or answered something this cannot read
#   4  the credential was refused, or lacks permission to verify
#
# Every non-zero code is a failure to *establish* that the record is intact, which is deliberately not the
# same claim as "the record is broken". An operator alerting only on 1 would treat an unreachable API or an
# expired token as good news; the codes are separated so the two can be routed differently, not so that one
# of them can be ignored.
#
# The credential must belong to a role that may verify — `compliance_manager` or `read_only_auditor`. A role
# without that permission is refused with `404`, not `403`, because the product hides existence rather than
# confirming it; that is why exit 4 covers 401, 403 and 404 together and says so in its message.
#
# Nothing here prints the token, and the response is written to a file inside a directory created with the
# umask this script sets, so a scheduled run does not leave the record of what it verified world-readable.

set -eu
umask 077

BASE_URL="${OPENPPWR_BASE_URL:-http://127.0.0.1:8080}"
TOKEN="${OPENPPWR_AUDIT_TOKEN:-}"
TIMEOUT="${OPENPPWR_AUDIT_TIMEOUT:-30}"
OUTPUT=""

for argument in "$@"; do
  case "$argument" in
    --base-url=*) BASE_URL="${argument#--base-url=}" ;;
    --output=*) OUTPUT="${argument#--output=}" ;;
    --timeout=*) TIMEOUT="${argument#--timeout=}" ;;
    --help|-h)
      sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '{"check":"audit-chain","result":"usage","exitCode":2,"message":"unknown argument %s"}\n' "$argument" >&2
      exit 2
      ;;
  esac
done

BASE_URL="${BASE_URL%/}"

# The result is emitted exactly once, from one place, so that no failure path can exit without saying what it
# found. A silent non-zero exit in a cron job is indistinguishable from cron not having run.
emit() {
  result="$1"; code="$2"; message="$3"; extra="$4"
  line=$(printf '{"check":"audit-chain","result":"%s","exitCode":%s,"baseUrl":"%s","checkedAt":"%s","message":"%s"%s}' \
    "$result" "$code" "$BASE_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$message" "$extra")
  printf '%s\n' "$line"
  if [ -n "$OUTPUT" ]; then
    printf '%s\n' "$line" > "$OUTPUT.partial" && mv "$OUTPUT.partial" "$OUTPUT"
  fi
  exit "$code"
}

if [ -z "$TOKEN" ]; then
  emit usage 2 "set OPENPPWR_AUDIT_TOKEN to a bearer token for a role that may verify the audit chain" ""
fi

body=$(mktemp) || { printf '{"check":"audit-chain","result":"error","exitCode":3}\n' >&2; exit 3; }
trap 'rm -f "$body" "$body.headers"' EXIT INT TERM

# `--fail` is deliberately NOT used: this needs the body and the status of a refusal, and --fail discards
# both. The status is captured through -w so a 401 can be told apart from a 500 and from no answer at all.
status=$(curl --silent --show-error --max-time "$TIMEOUT" \
  --header "authorization: Bearer $TOKEN" \
  --header 'accept: application/json' \
  --output "$body" --write-out '%{http_code}' \
  "$BASE_URL/v1/audit/verify" 2>"$body.headers") || status="000"

case "$status" in
  200) ;;
  401|403|404)
    emit unauthorized 4 "the deployment refused the credential, or the role may not verify the audit chain (HTTP $status; the product answers 404 rather than 403 when a role lacks permission)" ",\"httpStatus\":$status"
    ;;
  000)
    emit unreachable 3 "no answer from the deployment within ${TIMEOUT}s" ",\"httpStatus\":0"
    ;;
  *)
    emit unreachable 3 "the deployment answered HTTP $status" ",\"httpStatus\":$status"
    ;;
esac

# Field extraction without jq. Each pattern is anchored to the field name and takes the first match, so an
# identifier appearing inside a message cannot be read as the value of a different field.
field() {
  grep -o "\"$1\":[[:space:]]*\"[^\"]*\"" "$body" | head -n 1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/'
}
number() {
  grep -o "\"$1\":[[:space:]]*[0-9][0-9]*" "$body" | head -n 1 | sed 's/.*:[[:space:]]*//'
}

count=$(number count)
first=$(field firstEventAt)
last=$(field lastEventAt)
details=",\"httpStatus\":200,\"events\":${count:-null},\"firstEventAt\":\"$first\",\"lastEventAt\":\"$last\""

# `"valid":true` and nothing else counts as verified. A body that says neither true nor false — a proxy's
# error page, a truncated response, a future field rename — is reported as unreadable rather than assumed
# good, because "could not tell" and "intact" must never produce the same exit code.
if grep -q '"valid"[[:space:]]*:[[:space:]]*true' "$body"; then
  emit valid 0 "audit chain verified over ${count:-0} events" "$details"
elif grep -q '"valid"[[:space:]]*:[[:space:]]*false' "$body"; then
  failed=$(field failedEventId)
  emit invalid 1 "AUDIT CHAIN VERIFICATION FAILED — the recorded history no longer hashes to itself" "$details,\"failedEventId\":\"$failed\""
else
  emit unreadable 3 "the deployment answered 200 but the body carries no verification verdict" ",\"httpStatus\":200"
fi
