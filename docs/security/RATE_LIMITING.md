# Rate limiting

Implements `OPP-CODE-019` (limits) and `OPP-CODE-020` (rate limiting) from Attentus's internal security standard.

Status: **IMPLEMENTED** (engineering). Human security review outstanding.

## Design

| Decision | Choice | Reason |
|---|---|---|
| Backend | PostgreSQL table `rate_limit_buckets` | Community ships Postgres and nothing else. Adding Redis would add a service to every self-hosted install; adding a hosted limiter would add a paid dependency. Neither is justified for the current single-node deployment. |
| Counter model | Fixed window per `(operation, dimension, identifier)` | Simple, auditable, and sufficient for abuse control. Not a token bucket — burst smoothing is not required at this scale. |
| Scope | Applied in the API (`apps/api/src/app.mjs`) | The API is the only component that performs privileged work. Edge controls are additive, never a replacement (§4.3). |

Counters are keyed `operation:dimension:identifier:windowIndex`. Rows older than one hour are opportunistically deleted (~1% of requests) so the table cannot grow without bound.

Because state lives in Postgres rather than process memory, limits hold across restarts and remain correct if the deployment is ever scaled to multiple replicas. The shipped `deploy/community/docker-compose.yml` runs a single `api` instance; the shared store means that is a deployment choice, not a correctness assumption.

## Dimensions

| Dimension | Identifier | Applies when |
|---|---|---|
| `ip` | `req.ip` (Express, one trusted proxy hop) | Always available; the only dimension for unauthenticated endpoints |
| `subject` | authenticated `actorId` | After bearer authentication |
| `tenant` | authenticated `tenantId` | After bearer authentication |

API keys and service accounts are identities in the same `identities` table and carry an `actorId`, so they are limited by the `subject` dimension without a separate code path.

A rule whose identifier is not yet known (for example a `tenant` rule on an unauthenticated request) is skipped rather than blocking — the request is still covered by its `ip` rule, and authentication rejects it independently.

## Limits

Defined in `packages/security/src/rate-limit.mjs` (`DEFAULT_RATE_LIMIT_RULES`).

| Operation | Endpoint(s) | Limit |
|---|---|---|
| `bootstrap` | `POST /v1/bootstrap` | 5 / 15 min per IP |
| `read` | catalog, evidence list, requirements, assessments, gaps | 300 / min per subject |
| `import` | `POST /v1/imports` | 20 / 5 min per tenant; 60 / 5 min per IP |
| `evidenceUpload` | `POST /v1/evidence` | 30 / min per subject; 100 / min per tenant |
| `evidenceReview` | `POST /v1/evidence/:id/review` | 60 / min per subject |
| `evidenceDownload` | `GET /v1/evidence/:id/download` | 60 / min per subject |
| `scanRequeue` | `POST /v1/scan-jobs/:id/requeue` | 10 / min per subject |
| `assessmentRun` | `POST /v1/assessments/run`, `POST /v1/gaps/:id/reassess` | 20 / min per tenant |
| `gapWrite` | gap assign / remediate | 60 / min per subject |
| `reviewFreeze` | `POST /v1/review-snapshots` | 10 / min per tenant |
| `dossierGenerate` | `POST /v1/review-snapshots/:id/dossier` | 10 / min per tenant |
| `dossierDownload` | `GET /v1/dossiers/:id/download` | 30 / min per subject |
| `auditVerify` | `GET /v1/audit/verify` | 30 / min per subject |
| `credentialRotate` | `POST /v1/identities/:id/rotate-credential` | 10 / hour per subject; 30 / hour per tenant |

Authentication, dossier generation, review freezing, scan requeue and credential rotation carry the strictest budgets, per §4.2.

Credential rotation is counted per hour rather than per minute, and on both dimensions. A legitimate
operator rotates a credential when one leaks or when it is about to expire — a rare, deliberate act, so a
tight budget costs nothing. An attacker holding a stolen administrator token would use the same route to
churn every credential in the tenant and lock the real operators out of their own deployment; the tenant
ceiling is what bounds that, and the per-subject one alone would not, because the administrator is one
subject rotating many identities.

Evidence upload is deliberately not the tightest limit. It was originally 10/minute per subject,
which deployed testing showed turns ordinary batch work into `429`s — the reference journey alone
performs eight uploads within a few seconds, and a compliance user uploading supplier documents for
many packaging records would exceed it routinely. It was raised to 30/minute per subject and
100/minute per tenant on 2026-07-28 with owner approval: sustained upload at that rate is not human
behaviour, so abuse remains impractical, while the intended workflow is no longer penalised.

### Endpoint classes that do not exist yet

`MFA/recovery`, dedicated API-key management, contact forms and partner application forms have no endpoints in this codebase. They are therefore **NOT_APPLICABLE** today, not deferred. Adding any of them requires adding a rule in the same table — the limiter throws on an unknown operation name, so a new endpoint cannot silently ship unlimited.

`demo reset` is served by `POST /v1/bootstrap`, which is limited above and additionally refuses once a tenant exists.

## Response

Exceeding a limit returns `429` with `Retry-After` in seconds:

```json
{"error":{"code":"RATE_LIMITED","message":"Too many requests.","retryAfterSeconds":42}}
```

### Enumeration resistance

`POST /v1/bootstrap` is throttled on the IP dimension *before* the token is compared. Once the bucket is exhausted, a correct token and an incorrect token both receive an identical `429`. The response therefore carries no signal about token validity. Covered by test.

## Proxy and edge safety

The API sets `trust proxy` to exactly `1` — one hop, the `web` service. It does not trust an arbitrary chain.

`apps/web/server.mjs` strips every client-supplied forwarding header (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, `forwarded`) before proxying, then sets `x-forwarded-for` itself from the true socket peer. A client cannot therefore choose its own rate-limit bucket.

`CF-Connecting-IP` is honoured only when the operator sets `OPENPPWR_TRUST_CF_CONNECTING_IP=true`, which asserts that all traffic genuinely arrives through their Cloudflare deployment. It is off by default: trusting that header without the guarantee would let a direct-to-origin client spoof its IP.

Cloudflare WAF and Cloudflare rate limiting remain available as an additional edge layer. They are **not** a substitute for these controls, and no paid Cloudflare feature has been enabled.

## Tests

`packages/security/test/rate-limit.test.mjs` (unit) and `apps/api/test/rate-limit.integration.test.mjs` (real Postgres, real HTTP).

| Requirement (§4.4) | Covered by |
|---|---|
| normal traffic | `requests under the threshold pass through`; expensive-endpoint test |
| threshold exceeded | `exceeding the threshold returns 429 with Retry-After` |
| window reset | `window reset allows traffic again`; bootstrap window-reset integration test |
| separate authenticated users | `read limit is enforced per authenticated subject…` |
| separate tenants | `import limit is enforced per tenant…` |
| separate API keys | Same `subject` dimension as users — service accounts are identities with their own `actorId` |
| IP spoof / forwarded-header attempts | `IP spoofing via a client-supplied X-Forwarded-For…`; web-tier `client-supplied X-Forwarded-For / CF-Connecting-IP are stripped…` |
| normal E2E unaffected | `npm run test:e2e:api` (2 clean runs), `npm run test:e2e:browser` (EN/PL/DE) |
| expensive endpoints protected | Rules table above; dossier/assessment/upload rules |
| login enumeration resistance | Bootstrap test asserts a valid token also receives `429` |
| multi-process behaviour | Shared Postgres store; single-replica deployment documented above |

## Known limitations

- Fixed-window counters permit up to 2× the nominal rate across a window boundary. Accepted for abuse control; not a fairness mechanism.
- Each limited request performs one `INSERT … ON CONFLICT`. At current Community scale this is negligible; a high-traffic Cloud deployment should revisit the backend.
- Limits are global defaults, not per-tenant configurable. Cloud/Enterprise tiering is out of scope for Community.
