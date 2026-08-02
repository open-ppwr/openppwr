# Gap Identifier Contract

Status: implemented and enforced.

Scope: the `gaps.id` column, the `:id` path segment of `/v1/gaps/:id/assign`, `/v1/gaps/:id/remediate` and
`/v1/gaps/:id/reassess`, and every place a gap identifier appears in an audit record, a log line or a
dossier reference.

## Why this is not a UUID

The obvious remedy for "an identifier with no format check" is to make it a UUID, and that would be the
wrong change here. A gap identifier is **derived, not minted**:

```
GAP- || upper(left(sha256('<tenant_id>:<packaging_id>:<rule_id>:<discriminator>'), 24))
```

`gapIdentity` in `apps/api/src/assessment-service.mjs` produces it, and `createGaps` in
`packages/assessment/src/index.mjs` produces the same shape from an assessment. The derivation is a
correctness property, not a convenience: the same defect found on the same packaging record under the same
rule resolves to the same identifier, which is how re-assessment reopens an existing gap instead of
creating a second one. `gaps` carries `UNIQUE (tenant_id, packaging_id, rule_id, deduplication_key)` for
the same reason.

A random UUID would satisfy a validator and destroy that property. So the type stays textual and the
format is specified instead.

## The contract

| Property | Value |
|---|---|
| Type | `text` (ASCII) |
| Pattern | `^GAP-[0-9A-F]{24}$` |
| Length | exactly 28 characters |
| Alphabet | `GAP-` prefix, then uppercase hexadecimal `0-9A-F` |
| Case | significant; the canonical form is uppercase |
| Normalisation | none — see below |
| Uniqueness scope | one tenant |
| Tenant scope | the tenant identifier is an input to the derivation, so the same defect in two tenants yields two identifiers |
| Packaging scope | the packaging identifier is an input; a gap belongs to exactly one packaging record |
| Mutability | immutable; a gap's identifier is never rewritten, and status changes leave it unchanged |
| External exposure | yes — it appears in API responses, dossier artifacts and audit events |

## Case is refused, not folded

Mixed or lower case is **rejected**, not normalised to the canonical form.

Folding would be friendlier and wrong. If `gap-1a2b…` and `GAP-1A2B…` both address one row, then one
object has two spellings, and those two spellings appear in audit events, log lines and dossier references
— which makes an audit trail ambiguous about which record was touched. A single accepted form keeps the
identifier usable as evidence.

The same reasoning rules out Unicode normalisation. A Cyrillic `А`, a fullwidth `Ａ` and a Latin `A` must
not be three ways of writing one identifier, so a value containing any of them is refused rather than
folded. `NFKC` is never applied: applying it would turn a refused value into an accepted one, which is the
opposite of a boundary.

## Where validation happens

`requireGapId` in `apps/api/src/app.mjs`, called on the path segment **before** the transaction opens and
before the value reaches any query, filesystem path, service call or log line. A malformed value is refused
with the same `RESOURCE_NOT_FOUND` / `404` as an unknown one, so the response distinguishes neither case
— the same uniform-refusal rule the UUID-keyed routes follow.

A canonical identifier belonging to another tenant is *accepted by this validator* on purpose. It is
well-formed; refusing it here would require reading another tenant's data to know that it exists. It is
refused one layer down, by row-level security and the query's empty result, with the identical code and
status. That is what makes the two indistinguishable from outside.

## What was actually wrong

`gaps.id` is `text`, so no cast to `uuid` occurred, so a malformed value produced an ordinary empty result
and a 404. Nothing broke — and the reasoning stopped there for three routes.

`scripts/validation/route-validation-gate.mjs` states the property it enforces as: *no untrusted identifier
reaches a database query, filesystem lookup, artifact lookup or business service before successful type and
format validation.* Those three routes were listed in its inventory with `validator: null`, which exempted
them from the property the gate exists to assert. The gate passed, and the property did not hold.

`validator: null` is no longer accepted for any non-enum entry:
the gate now fails if an inventory entry has no validator, and additionally checks that the gap pattern is
anchored at both ends, has an upper length bound, and is not case-insensitive.

## Evidence

| Check | Where |
|---|---|
| Producers emit identifiers the validator accepts | `apps/api/test/gap-identifier.test.mjs` — tested against `gapIdentity` and `createGaps`, not against a copy of the formula |
| Determinism and tenant scoping | same file: the same defect twice yields one identifier; two tenants yield two |
| Length, empty, traversal, control characters, confusables, case, SQL fragments, non-string | same file, one test each |
| Malformed and foreign refusals are identical | same file |
| Route-level enforcement before any query | `scripts/validation/route-validation-gate.mjs` — `ROUTE_VALIDATION_PROPERTY_PASS` |
| Pattern is anchored, bounded and case-exact | same gate |
| Documented pattern equals enforced pattern | `apps/api/test/gap-identifier.test.mjs` reads both this document and `app.mjs` |

## Gate

`GAP_IDENTIFIER_CONTRACT_PASS` — satisfied when `apps/api/test/gap-identifier.test.mjs` and
`scripts/validation/route-validation-gate.mjs` both exit `0`.
