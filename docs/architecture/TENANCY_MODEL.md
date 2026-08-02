# Tenancy model

The supported tenant model for OpenPPWR Community, and the boundary between what the data model can do
and what the deployment is declared to support.

Decided by the owner on 2026-07-30.

## The declaration

```text
OpenPPWR Community Public Beta supports one tenant per deployment.

The application data model is tenant-aware and uses verified PostgreSQL RLS/FORCE RLS.
Multi-tenant deployment orchestration is not included in the Community Public Beta.
```

That wording is deliberate and is used verbatim in the README, the installation guide and the website.
Two claims are being kept apart, because conflating them is how a product ends up advertising a capability
its operations cannot deliver:

| Claim | Status |
|---|---|
| The data model isolates tenants | **Proven.** Tenant context, RLS, `FORCE RLS`, tenant-aware authorization, 36/36 cross-tenant refusals in both directions, plus database-level checks |
| A single Community deployment operates several tenants | **Not supported in Beta.** `Planned` for Cloud/Enterprise |

## Why one tenant per deployment

The honest reason, in the order it was discovered rather than the order that sounds tidiest.

The deployment runs **one** worker, holding **one** `OPENPPWR_WORKER_TOKEN`. `processNextScanJob` claims
scan jobs inside `withTenantTransaction`, so RLS scopes the worker to its own token's tenant. A second
tenant's evidence is therefore never scanned; it stays `pending`; accepting evidence requires `clean`; so
the core business loop is permanently dead for that tenant.

This was found by running the demonstration on a second tenant in an internal deployed-lifecycle
rehearsal, and then confirmed by starting a dedicated worker for that tenant, after which the identical
21-step chain passed in full.

That confirmation is what makes the decision a scope decision rather than a bug fix: **the per-tenant code
path is correct and complete.** What is missing is deployment orchestration — worker lifecycle, per-tenant
credential issuance, rotation, health, teardown — and none of that belongs in a Community installer that
is meant to be operable by one administrator.

## What enforces the boundary

Documentation is not enforcement. Two mechanisms make the declaration true at runtime.

**1. Bootstrap refuses a second tenant.** `/v1/bootstrap` counts tenants under
`pg_advisory_xact_lock` and raises `BOOTSTRAP_ALREADY_COMPLETED` if any exists. This predates the
decision — the product already behaved this way, and the decision states it truthfully rather than
introducing it.

**2. The worker refuses to start on a multi-tenant database.** `assertSingleTenantDeployment` runs before
any job is claimed and raises `WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED` when more than one tenant
exists. Failing closed turns a silent, permanent processing gap into a refusal an operator sees at once.

Zero tenants is explicitly **not** an error: the worker may legitimately start before an operator has
bootstrapped.

### The opt-out, and why it is ugly on purpose

```text
OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE=true
```

Only that exact string enables it. Not `TRUE`, not `1`, not `yes`; and the internal check requires
`=== true` rather than any truthy value, so a direct caller cannot switch off a safety check by passing a
non-empty string. A test found that weakness in the first version of this code, which is the argument for
having written the test.

The variable is verbose because a deployment that sets it is running an unsupported topology, and that
should be conspicuous in a configuration review. Its only intended users are this project's own
verification suites, which deliberately create additional synthetic tenants.

## What was not weakened

Nothing about tenant isolation was relaxed because the supported model is single-tenant. Retained in full:

- tenant context on every request, derived from the verified session and never from a client header
- RLS and `FORCE RLS` on every tenant table
- tenant-aware authorization, including supplier scoping
- the cross-tenant negative suite, both directions
- `404` rather than `403` on every denial, so nothing becomes an existence oracle

These stay for three reasons: they are defence in depth against a bug elsewhere; they keep the
architecture future-safe for Cloud/Enterprise; and a control removed because "it cannot happen in the
supported configuration" is a control missing in the configuration nobody predicted.

## What must not be claimed

Not in marketing, documentation, or the website, unless explicitly labelled `Planned`,
`Cloud/Enterprise`, or `not included in Community Beta`:

- multi-tenant Community deployment
- several organizations in one Community installation
- shared managed tenancy

## Future direction

Multi-tenant operation returns as a Cloud/Enterprise concern, and the shape is already known from the
verification work: one dedicated worker and one scoped service identity per tenant, with issuance,
rotation, expiry, health checking and teardown managed by the platform rather than by an operator. The
alternative — a single worker iterating tenants — was considered and is not recommended before a design
and threat model exist, because the failure mode is tenant-context bleed, which is the one failure this
product must never have.
