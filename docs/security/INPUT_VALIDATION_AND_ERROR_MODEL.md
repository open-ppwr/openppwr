# Input validation and the error model

The identifier inventory, the property that governs it, and what a caller is allowed to learn from a
failure.

Verified at source `3580eb8` by `npm run routes:gate`
(`scripts/validation/route-validation-gate.mjs`): **29 routes, 9 parameterised, 5 uuid-keyed**.

## Why this is a property and not a list of fixes

Three `:id` defects reached a deployment. Each was fixed individually, and the next audit found another
one, because the method was "fix the route that failed". Forty-nine passing tests had found none of
them; an inventory-driven audit found three in one pass.

So the rule is stated once, over every route, and the gate fails when the shape is wrong rather than
when a particular route is wrong:

```text
No untrusted identifier reaches a database query, filesystem lookup, artifact lookup or business
service before successful type and format validation.
```

The gate checks the property structurally — that a validator is present, and that it appears *above*
every use of the raw value. Position is the whole point: a validator called three lines below the query
that already received the raw parameter is not a validator, and that exact shape shipped and returned
`500` on a malformed identifier.

## The identifier inventory

Every external identifier, its real column type, and therefore whether a format validator applies.

| Route | Parameter | Table | Column type | Validator |
|---|---|---|---|---|
| `POST /v1/evidence/:id/review` | `id` | `evidence_files` | `uuid` | `requireUuid` |
| `GET /v1/evidence/:id/download` | `id` | `evidence_files` | `uuid` | `requireUuid` |
| `POST /v1/review-snapshots/:id/dossier` | `id` | `review_snapshots` | `uuid` | `requireUuid` |
| `GET /v1/dossiers/:id/download` | `id` | `dossier_artifacts` | `uuid` | `requireUuid` |
| `POST /v1/scan-jobs/:id/requeue` | `id` | `scan_jobs` | `uuid` | `requireUuid` |
| `POST /v1/gaps/:id/assign` | `id` | `gaps` | `text` | `requireGapId` |
| `POST /v1/gaps/:id/remediate` | `id` | `gaps` | `text` | `requireGapId` |
| `POST /v1/gaps/:id/reassess` | `id` | `gaps` | `text` | `requireGapId` |
| `GET /v1/catalog/:resource` | `resource` | — | enum | allowlist |

The inventory and the code are checked against each other in both directions: a parameterised route
absent from the inventory fails the gate, and an inventory entry naming a route that no longer exists
fails it too. Neither can drift silently.

## The three routes that must not validate a UUID, and must still validate

`gaps.id` is `text`. Its values look like `GAP-<hash>`, because a gap identifier is derived from what the
gap is about, so that the same finding reassessed produces the same identifier rather than a new row.

Applying `requireUuid` there refuses every legitimate identifier. It was applied, and it broke all three
gap routes — a validation "fix" that turned working endpoints into unconditional refusals. The lesson
recorded here is that a validator has to match the column, not the parameter's name: `:id` is not a type.

**Corrected 2026-07-30.** This section previously ended by concluding that the three routes needed no
format check at all, because "the format is unconstrained". That was wrong in both halves.

The format is not unconstrained: it is `^GAP-[0-9A-F]{24}$`, exactly 28 characters, produced by a SHA-256
derivation in `gapIdentity`. And "these routes are not unvalidated — they are parameterised queries inside
a tenant transaction with `FORCE RLS`" answered a question nobody asked. The property this document and
`route-validation-gate.mjs` assert is that *no untrusted identifier reaches a query before validation*, not
that an unvalidated one causes no visible damage. A `text` column accepts a traversal segment, a null byte,
a 4 KB string or a Cyrillic homoglyph, carries it into a query, and then into a log line and an audit
record. Nothing breaks, and the property does not hold.

All three routes now call `requireGapId` before the transaction
opens. The gate no longer accepts `validator: null` for any non-enum inventory entry, so a future route
cannot be exempted from the property by describing it as text-keyed. The full contract — alphabet, length,
case policy, why case and Unicode forms are refused rather than normalised, and where the tenant boundary
takes over — is `docs/security/GAP_IDENTIFIER_CONTRACT.md`.

## The error model

What a caller learns from a failure, and what it must not.

| Condition | Status | Body | Reasoning |
|---|---|---|---|
| No credential | `401` | `AUTHENTICATION_REQUIRED` | |
| Bad credential, unknown user, revoked session | `401` | `AUTHENTICATION_FAILED` | One code for all three. An unknown address and a wrong password are indistinguishable, and the timing is equalised by hashing a decoy. |
| Permission denied | `404` | `RESOURCE_NOT_FOUND` | Existence hiding, everywhere. See below. |
| Resource in another tenant | `404` | `RESOURCE_NOT_FOUND` | Identical to "absent", by construction |
| Malformed identifier | `404` | `RESOURCE_NOT_FOUND` | Never `500`, and never the driver's `22P02` |
| Invalid payload | `422` | specific code | The caller owns the input, so it may know what was wrong |
| Deliberate business conflict | `409` | specific code | `EVIDENCE_EXPIRED`, `EVIDENCE_NOT_CLEAN`, `EVIDENCE_INTEGRITY_MISMATCH`, `BOOTSTRAP_ALREADY_COMPLETED` |
| Unexpected | `500` | no code | Correlation id only |

### `404` everywhere, not `403`

Every authorization denial is `404`. `requirePermission` raises `RESOURCE_NOT_FOUND` with status `404`,
so an unauthorized caller cannot map the system by collecting the difference between "forbidden" and
"absent". All 14 role-matrix probes return `404`
(`docs/demo/DEMO_ROLE_JOURNEYS.md`).

### Why deliberate codes survive and driver codes do not

The API error handler echoes `error.code` **only when the error carries an explicit `status`**. Every
error this codebase raises deliberately sets one; a PostgreSQL driver error never does.

That single condition is what keeps `EVIDENCE_INTEGRITY_MISMATCH` reaching the caller that needs to act
on it, while `22P02` — the driver's "invalid input syntax for type uuid", which discloses both the
column type and that the value reached the database — does not.

The failure mode to watch, and the reason it is written down: a *deliberate* error raised without a
`status` would now be flattened to a bare `500`. That is the trade this design makes, and it is the
first thing a reviewer should try to break.

## Tests that must fail

The gate is only worth its runtime if it can fail. Each of these must be caught:

- a raw parameter used before validation, including a validator placed below the first use
- `requireUuid` applied to a `text`-keyed route
- an inventory entry with no validator at all
- a PostgreSQL `22P02` reaching a caller
- a stack trace, query text or filesystem path in a response body
- a `403` where the `404` policy applies
- a deliberate code such as `EVIDENCE_INTEGRITY_MISMATCH` flattened into a generic `500`
- a parameterised route missing from the inventory, or an inventory entry for a deleted route

Two guards in this programme passed while the defect they guarded was live. A guard that has never been
seen to fail is a guard of unknown value, and the review pack asks a reviewer to break each one.

## Gate

| Gate | State | Source |
|---|---|---|
| `ROUTE_VALIDATION_PROPERTY_PASS` | **PASS** — 29 routes, 9 parameterised, 5 uuid-keyed | `routes:gate` at `3580eb8` |
