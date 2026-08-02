# Demonstration role journeys

What each demonstration role can do, and what it is refused, proven against the running API rather than
copied from the permission table.

Verified at source `3580eb8` by `test:demo:full-e2e`. Fourteen probes, seven roles, each with at least
one allowed and one denied action. The authorization model itself is
`docs/security/AUTHORIZATION_MATRIX.md`; `permissions:gate` keeps the published matrix and the
enforcing registry in agreement.

## Why a denied action per role is required

A role table proves nothing about a server. The permission registry could grant exactly the right
things and a route could forget to consult it — which is how three `:id` defects reached a deployment
that 49 passing tests had not caught. So every role is made to attempt something it must not be
allowed to do, and the refusal is recorded as evidence.

## The matrix

| Role | Allowed action | Result | Denied action | Result |
|---|---|---|---|---|
| Tenant Administrator | `GET /v1/session` | `200` | `GET /v1/dossiers/{another tenant's artifact}/download` | `404 RESOURCE_NOT_FOUND` |
| Compliance Manager | `POST /v1/assessments/run` | `201` | `POST /v1/evidence` | `404 RESOURCE_NOT_FOUND` |
| Packaging Editor | `POST /v1/imports` | `200` | `POST /v1/assessments/run` | `404 RESOURCE_NOT_FOUND` |
| Evidence Contributor | `GET /v1/evidence-requirements` | `200` | `POST /v1/evidence/{id}/review` | `404 RESOURCE_NOT_FOUND` |
| Evidence Reviewer | `GET /v1/evidence/{id}/download` | `200` | `POST /v1/imports` | `404 RESOURCE_NOT_FOUND` |
| Supplier User | `GET /v1/evidence-requirements` (own supplier only) | `200` | `POST /v1/evidence` for **another** supplier | `404 RESOURCE_NOT_FOUND` |
| Read-only Auditor | `GET /v1/audit/verify` | `200` | `POST /v1/imports` | `404 RESOURCE_NOT_FOUND` |

## Every refusal is `404`, and that is deliberate

No probe returns `403`. The product hides existence rather than confirming it: a caller who may not
read a thing is told the thing is not there. `requirePermission` raises `RESOURCE_NOT_FOUND` with
status `404` for every denial, so an unauthorized caller cannot map the system by collecting the
difference between "forbidden" and "absent".

The gate accepts `403` or `404` and the product returns `404` throughout. If a route ever answered
`403`, the gate would still pass and this table would change — which is the honest way round, because
the policy is documented in `docs/security/INPUT_VALIDATION_AND_ERROR_MODEL.md` and enforced there.

## The two probes that needed care

**Tenant Administrator holds `*`.** There is no permission it lacks, so a permission-based denial
cannot exist for it. Its refusal is the tenant boundary instead: the gate copies a real dossier
artifact into a second tenant, asserts the copy exists, and then has tenant A's administrator request
it by its true identifier. The refusal is `404`.

This matters because the weaker version of the same test — request a random UUID — proves only that an
absent value is absent. The setup deliberately carries no `catch`: if the copy cannot be made, the gate
fails rather than quietly degrading into the weaker test.

**Supplier User is scoped, not just permitted.** It holds `evidence:upload`, so a permission check
alone would let it upload against any supplier. `isAllowed` additionally compares
`identity.supplierId` against the resource, and `evidence-service.mjs` refuses a mismatch with `404`.
The probe uploads a well-formed file against a supplier that is not its own; the permission passes and
the scope check refuses it.

## Sign-in

Every role signs in with a password against `POST /v1/login` and receives a session credential
(`opp_sess_…`), then confirms it with `GET /v1/session`. Bootstrap bearer tokens are not used for the
role journeys — an evaluator uses the password path, so the password path is what is proven.

Demonstration accounts exist only when the operator sets `OPENPPWR_DEMO_LOGIN=true`. With it off, the
`/v1/demo/accounts` route does not exist and a production deployment discloses nothing. A self-hosted
deployment holding real data must never come up with a known password.

Session revocation is proven in the same run: logout returns `204`, and the revoked credential then
returns `401` on both a read and a write. The credential is dead server-side, not merely forgotten by
a client.
