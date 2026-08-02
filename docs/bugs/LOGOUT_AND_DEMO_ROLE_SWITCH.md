# There was no way to sign out

**Severity:** P0 — a session could only end by expiring, and trying a second role meant reloading the page.
**Status:** fixed.
**Found:** owner review of the Community release candidate.

## What was wrong

The workbench had no sign-out. A user who finished working, or who wanted to look at the product as a
different role, had to reload the page. Closing the tab discarded the token from browser memory but
left it **valid on the server for the remaining twelve hours**. That is forgetting a credential, not
revoking one.

For a demonstration whose whole point is walking the same workflow as several roles, this made the
central journey awkward. For anything holding real data it would be a security defect.

## What was added

### Server-side revocation

`POST /v1/logout` revokes the `auth_sessions` row for the session that was presented. The credential
is dead the moment the call returns.

It sits **after** the authentication middleware on purpose: a caller must prove which session it is
ending, otherwise anyone could revoke a session identifier they guessed. The database function takes
the tenant from the verified identity rather than from the row, so a session can never be revoked
across a tenant boundary even if an identifier leaked.

Migration `005_session_logout.sql` adds `revoke_openppwr_session` and extends
`authenticate_openppwr_token` to report which session authorised the request and when it expires.
The function had to be dropped and recreated rather than replaced, because PostgreSQL refuses to
change the return type of an existing set-returning function; migrations run inside a transaction, so
no request can observe its absence.

### An honest answer for operator tokens

A bootstrap-issued identity token is static and **cannot** be revoked in place — that limitation is
already documented and unchanged. Signing out with one returns `200` and:

```json
{ "revoked": false, "reason": "STATIC_CREDENTIAL_NOT_REVOCABLE" }
```

rather than the `204` a real revocation returns. The client still discards the credential. Reporting a
sign-out that did not happen would be worse than the limitation.

This is a deliberate deviation from a plain "always 204": the status distinguishes *ended* from
*forgotten*, which is exactly the distinction this defect was about.

### The account panel

Once signed in, the workbench shows the role, the tenant, and either the session expiry or a note that
the credential is a static operator one with no automatic expiry. It carries **Log out / Wyloguj /
Abmelden** and **Switch demo role / Zmień rolę demo / Demo-Rolle wechseln**.

Signing out clears every loaded record — catalogue, evidence, assessment, gaps, snapshot, artifacts,
the import payload and the audit result — so nothing from the previous role stays on screen. None of
it was ever written to `localStorage` or any other persistent store, which is why a back navigation
cannot resurrect it: there is nothing to resurrect.

No cookie is introduced. The CSRF assessment remains `NOT_APPLICABLE` and its regression tests are
untouched.

### Role switching

Switching demo role signs out and returns to the sign-in panel with the role cards, so the next role
gets a **new application session** rather than reusing the previous one. No page reload is involved.

## Tests

Integration, against real PostgreSQL:

- sign-out returns `204`, and the same token then fails `401` — the session is revoked, not forgotten;
- signing out twice is not an error;
- revoking one session leaves a second session for the same identity working, and the identity can
  sign in again — signing out on one machine does not sign you out everywhere;
- a static operator credential reports `revoked: false` with the reason, and keeps working;
- sign-out without a credential is refused `401`, so a guessed session identifier revokes nothing;
- the session reports its capabilities and a future expiry.

Browser, in the canonical journey: the compliance manager signs out, the workbench returns to the
locked state with the credential field cleared, and the auditor signs in immediately — no reload.

## Rate limiting

Sign-out has a deliberately generous budget (60/minute per subject). A user who cannot end a session
because they are throttled is left holding a live credential, which is worse than the abuse a tight
limit would prevent.

## Residual limitation

Multi-tab behaviour is defined but not clever: each tab holds its own token in memory, so signing out
in one tab does not clear another tab's copy — though that copy is already revoked server-side and its
next request will fail with `401`, which returns that tab to the signed-out state. Per-identity
rotation for static operator tokens remains unimplemented and stays on the post-release list.
