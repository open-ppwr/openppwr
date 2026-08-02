# Web security headers, CORS and CSRF

Implements `OPP-CODE-006`, `OPP-CODE-007` and `OPP-CODE-012` from Attentus's internal security standard.

Status: **IMPLEMENTED** (engineering). Human security review outstanding.

Source: `packages/security/src/index.mjs`, applied by `apps/api/src/app.mjs` and `apps/web/server.mjs`.

## Header values

Both services send:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=15768000` (6 months) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |

The API additionally sends `Cache-Control: no-store` on every response, because every API response is tenant data. The web service does not override the per-asset caching it already applied (`no-cache` for `index.html`, `public, max-age=3600` for fingerprinted assets), none of which is authenticated content.

### CSP

API (`API_CSP`) — the API renders no HTML at all:

```
default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

Web (`WEB_CSP`) — serves the React SPA and its own fingerprinted assets:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' https://api.openppwr.eu; object-src 'none';
frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

Requirements from §5.1:

- no `unsafe-eval` — absent, asserted by test.
- no broad `unsafe-inline` — absent, asserted by test. No nonce or hash is needed: the Vite build emits an external module script and an external stylesheet, and the SPA uses no inline `<script>`, no inline `<style>` and no inline event handlers.
- every directive listed in §5.1 is explicit, including `frame-ancestors`, `base-uri` and `form-action`.
- no wildcard origins.

`connect-src` names `https://api.openppwr.eu` in addition to `'self'`. In the shipped topology the browser only ever talks to its own origin — `/v1/*` is proxied server-side by the web service — so `'self'` alone is sufficient today. The API host is listed so that a deployment choosing to address the API directly does not require a policy change.

The CSP is verified against the real built SPA: `npm run test:e2e:browser` drives the full journey in EN/PL/DE with the policy active and asserts zero page errors, which a CSP violation would produce.

### HSTS

`max-age=15768000` (six months), with **no** `includeSubDomains` and **no** `preload`.

Raised from the initial one-day value on 2026-07-29 with owner approval, after all seven OpenPPWR hostnames were verified HTTPS-only behind the edge. Six months is a normal production posture and satisfies §5.2 now that HTTPS is proven for every affected hostname.

`includeSubDomains` and `preload` remain deliberately absent, and were explicitly not approved:

- `includeSubDomains` binds every current and future `*.openppwr.eu` subdomain to HTTPS-only for the lifetime of the cached policy;
- `preload` is effectively irreversible on a human timescale — removal requires a browser-vendor delisting cycle.

Neither is required to protect the hostnames that exist today.

## CORS

Explicit allowlist, no reflection of arbitrary origins, no credentialed wildcard.

Default allowlist: `openppwr.eu`, `app.`, `demo.`, `docs.`, `api.`, `status.`, `community.` (all `https://`). Overridable per deployment with `OPENPPWR_CORS_ALLOWED_ORIGINS` (comma-separated).

Allowed methods: `GET,POST,OPTIONS`. Allowed headers: `Authorization,Content-Type,Idempotency-Key,X-Correlation-ID,X-Openppwr-Bootstrap-Token`. Preflight cached 600s.

`Access-Control-Allow-Credentials` is never sent — no credential is ever carried by a cookie (see CSRF below).

### Same-origin handling

An `Origin` whose host equals the host the request was actually addressed to (via `X-Forwarded-Host`, falling back to `Host`) is treated as same-origin and allowed.

This is required for correctness, not convenience: browsers attach `Origin` to same-origin `POST` requests, so a strict allowlist would reject the application's own traffic on any self-hosted domain the allowlist cannot know in advance. A foreign `Origin` is still rejected on such a host — covered by test.

`apps/web/server.mjs` forwards `X-Forwarded-Host` for this reason, since it rewrites `Host` when proxying to the API.

## CSRF — NOT_APPLICABLE

Assessed per §5.4 against the actual authentication model.

Evidence:

1. Authentication is bearer-only. `apps/api/src/app.mjs` accepts credentials solely from the `Authorization: Bearer …` header.
2. No cookie is ever set. There is no `Set-Cookie` anywhere in the codebase, and no cookie parsing or session middleware.
3. The browser client attaches the token explicitly from application state (`apps/web/src/App.jsx`); it is not persisted to `localStorage` or `sessionStorage` and is never attached automatically by the browser.

A cross-site page therefore cannot cause an authenticated request: it has no mechanism to attach the credential. This is the condition under which §5.4 permits `NOT_APPLICABLE`.

Regression tests (`apps/api/test/security-headers.integration.test.mjs`) assert that no response carries `Set-Cookie` and that an authenticated route rejects a request bearing only `Origin`/`Referer`. **If cookie authentication is ever introduced, these tests fail and CSRF protection becomes mandatory.**

Cloudflare Access issues its own cookies at the edge. Those authenticate to Access, not to OpenPPWR, and grant no application privilege — an Access-authenticated request without a bearer token still receives `401`.

## Tests

| Requirement (§5.5) | Covered by |
|---|---|
| headers present on every response, including errors | `apps/api/test/security-headers.integration.test.mjs`, `apps/web/test/security-headers.test.mjs` |
| CSP browser smoke | `npm run test:e2e:browser` EN/PL/DE, asserts no page errors |
| HSTS | asserted in both header tests |
| CORS allow/deny | all seven approved origins allowed; untrusted origin `403`; same-origin and foreign-origin-on-selfhosted cases |
| CSRF N/A proof | `CSRF is not applicable: auth is bearer-only…` |
| authenticated cache behaviour | API asserts `Cache-Control: no-store` |
| EN/PL/DE browser E2E | `BROWSER_E2E_PASS` for each locale |

## Not verified here

- **HTTP→HTTPS redirect and TLS**: terminated at Cloudflare, outside the application. Verified per-hostname during deployment validation, not by these tests.
- **Cloudflare Access compatibility**: verified against the private deployment, not in unit/integration tests.

Neither is claimed as passing on the strength of the application test suite.

## Owner decisions outstanding

| Decision | Status |
|---|---|
| Raise HSTS `max-age` to 6 months | **APPROVED and applied** 2026-07-29 |
| `includeSubDomains` | **Deferred by owner.** Would bind every current and future `*.openppwr.eu` name to HTTPS-only for the cached lifetime |
| HSTS `preload` | **Deferred by owner.** Effectively irreversible; removal requires a browser-vendor delisting cycle |
