# Privacy and cookie notice template for a self-hosted deployment

If you run OpenPPWR on your own infrastructure, you are the controller of the personal data inside it.
Nobody else can write your privacy notice for you, and the notices published on `openppwr.eu` are not
it: they describe a deployment that Attentus operates, name Attentus as the controller, name Attentus's
own hosting and edge providers as the processors, and state Polish law. Every one of those sentences is
false on your installation. That is why they say so, and why this template exists.

**This template is not legal advice, and it was not written by a lawyer.** It gives you a structure, and
it gives you the facts about the software that we can establish from its source code, so that you and
your adviser spend the time on the questions that are actually yours. Everywhere a real notice needs a
legal judgement — a lawful basis, a retention period, a rights statement, a transfer mechanism — this
template leaves a blank and says what has to go in it. Do not publish it with the blanks still in it, and
do not publish it without somebody qualified in the law that applies to you having read it.

## How to read this document

Statements come in two kinds, and they are marked differently.

- **`[OPERATOR: …]`** — you must supply this. It depends on who you are, where you run the software, whom
  you have contracted with, and which law applies to you. OpenPPWR cannot know any of it.
- **`(product fact)`** — this is determined by the software itself and is the same on every installation
  of this version. You can take it as given. Each one is traceable to the code in
  [the product-fact appendix](#appendix-where-each-product-fact-comes-from), so you or your adviser can
  check it rather than trust it.

A third category exists and is worth naming: things that are neither. Where the product does something
whose *privacy consequence* depends on a decision you have not made yet — retention of accepted evidence
is the clearest case — the product fact is stated and the decision is left to you as an `[OPERATOR: …]`
blank immediately after it. Those are the paragraphs to take to your adviser first.

Version: this template describes OpenPPWR Community `1.0.0`. If you upgrade, re-check the appendix
against the version you are running.

---

## Part 1 — Privacy notice

### 1. Who is responsible

`[OPERATOR: your legal entity name, registered address, company/registration number, and the address a
data subject can write to. If you have appointed a data protection officer, their contact details; if you
have not, say that no DPO is appointed rather than leaving it unclear.]`

`[OPERATOR: the URL or hostname this notice applies to, and a sentence saying that it applies to your
installation of OpenPPWR and to nothing else.]`

### 2. What this notice covers

This notice covers `[OPERATOR: your hostname(s)]`, which runs OpenPPWR, an open-source packaging
compliance application. It does not cover the OpenPPWR project's own website or its demonstration
environment, which are operated by a different organisation and have their own notice.

The application is self-contained: it makes no outbound call to the OpenPPWR project or to any analytics,
advertising, error-tracking or marketing service, so none of them receives anything from your
installation (product fact). Whatever else your users' requests pass through — a reverse proxy, a content
delivery network, an access gateway, a WAF — is something you placed there, and only you can describe it.

`[OPERATOR: name every hop in front of the application: hosting provider, CDN, edge or access provider,
reverse proxy, mail relay, backup destination, monitoring or log-shipping service. Each is a processor or
a separate controller and needs to be listed as one.]`

### 3. Cookies and browser storage

The application sets no cookie at all. Authentication uses a bearer token that the browser client holds
in the memory of the open tab; nothing is written to `localStorage`, `sessionStorage` or `document.cookie`,
which is why closing the tab discards the credential (product fact).

`[OPERATOR: if anything in front of the application sets a cookie — an access gateway, a CDN, a load
balancer, a consent tool you added — list each one with its name, purpose, lifetime and who sets it.
Those cookies are yours to disclose, not the application's. If you added an analytics or marketing
technology, this is where a lawful basis and a consent mechanism become your problem rather than a
formality.]`

`[OPERATOR: whether a consent banner is required on your deployment. Do not copy a conclusion from
anywhere. It follows from what *you* have put in front of the application, not from what the application
does.]`

### 4. What the application stores about a person

The tables below are what OpenPPWR itself writes. Everything in them is on your own database server; none
of it reaches the OpenPPWR project (product fact).

| What | Fields the software records | Note |
|---|---|---|
| User accounts | display name, role, optional supplier scope, a hash of the access token, active flag, creation time (product fact) | The account table holds no email address and no password |
| Password sign-in accounts | email address, password hash, password salt, linked account, active flag, creation time (product fact) | Exists only if you switch demonstration sign-in on — see §5 |
| Sessions | account identifier, a hash of the session token, issue time, expiry, revocation time (product fact) | Session tokens are stored hashed, never in the clear |
| Uploaded evidence | original filename, declared and detected file type, size, SHA-256, storage key, the account that uploaded it, the account that reviewed it and when (product fact) | The file contents are whatever your users upload, and may themselves contain personal data |
| Audit records | tenant, actor account, action, entity type and identifier, an event payload, timestamp, and hash-chain fields (product fact) | Append-only — see §7 |
| Rate-limit counters | a bucket key that, for the sign-in, bootstrap and import endpoints, contains the caller's IP address in the clear (product fact) | See §6 |
| Application log lines | on a refused request: error code, HTTP status, method, route pattern, correlation identifier, actor identifier, tenant identifier (product fact) | No IP address, no request body, no filename, no token |

`[OPERATOR: a lawful basis for each of these processing operations. This template deliberately proposes
none. Which basis applies depends on why you are running the system, on your relationship with the people
whose data is in it — your own staff, your suppliers' staff — and on your jurisdiction, and getting it
wrong is exactly the failure a template cannot save you from.]`

`[OPERATOR: whether the evidence your suppliers upload contains personal data in practice, and what that
means for your notice. The application cannot tell you: it stores files, and what is inside them is your
process.]`

### 5. Sign-in

Access to the application is by an access token that you issue when you set the deployment up (product
fact).

Email-and-password sign-in exists only when the deployment is explicitly started with demonstration
sign-in enabled; with that setting off, the sign-in endpoint does not answer, and any session already
issued through it stops working (product fact). Demonstration accounts share a published password and are
meant for fictional sample data.

`[OPERATOR: state whether demonstration sign-in is enabled on your deployment. If it is enabled on a
system holding real data, that is a decision to reconsider before it is a sentence to write.]`

A session lasts 12 hours from sign-in, and signing out marks it revoked immediately (product fact).

**The session row is not deleted.** Signing out and expiry both stop the credential working, but the
record — account identifier, token hash, issue time, expiry, revocation time — stays in the database, and
no part of the product removes it (product fact).

`[OPERATOR: how long you keep session records, and how they are removed. The product will not do it for
you, so this is a housekeeping job you have to define and perform.]`

### 6. IP addresses

The application's own log lines contain no IP address (product fact). One place does record it: the
rate-limit counters for sign-in, initial bootstrap and data import store the caller's IP address in the
clear as part of the counter key, so that repeated attempts from one address can be counted (product
fact).

Those rows are deleted opportunistically once they are more than an hour old — the cleanup runs on
roughly one in a hundred requests rather than on a schedule, so an address can persist for longer than an
hour on a quiet system (product fact). It is a best-effort cleanup, and describing it as a guaranteed
one-hour retention would be wrong.

`[OPERATOR: your web server, reverse proxy, gateway and operating-system logs almost certainly record IP
addresses as well, and OpenPPWR neither configures nor rotates them. State what they capture and how long
you keep it — and make sure the period you state is one your system actually enforces, not one you
intend.]`

### 7. Audit records, and why they cannot simply be deleted

Every critical action is written to an append-only audit chain. `UPDATE` and `DELETE` on the audit table
are rejected by a database trigger, `TRUNCATE` is rejected by a second one, and the records are
hash-chained so that a gap or an alteration is detectable (product fact). This is deliberate: it is the
property that makes a generated compliance dossier evidence rather than a report.

The consequence for a privacy notice is direct, and you should not discover it after receiving a request:
an audit record naming an actor cannot be erased through the product, because the product refuses the
operation by design. Audit records identify an actor by an internal account identifier rather than by
name or email (product fact), which is not the same thing as anonymity — the account table resolves it.

`[OPERATOR: this needs a decision taken with your adviser, not a paragraph copied from here. It is the
one place where the product's integrity guarantee and a data subject's erasure expectation genuinely
pull against each other, and no wording in this template resolves that for you.]`

### 8. Retention

Evidence that was never accepted — an upload whose scan came back infected, errored or timed out, and
which is still pending or has been rejected — is deleted automatically once it is older than a
configurable retention period, by default 30 days, checked hourly (product fact).

**Nothing else is deleted automatically.** Accepted evidence, packaging and supplier records, assessments,
gaps, dossiers, user accounts and audit records have no scheduled deletion in the product (product fact).

`[OPERATOR: your retention period for each category above, how it is enforced, and by what. If it is
enforced by somebody remembering to run something, say so honestly to your adviser — a published
retention period that nothing enforces is worse than no published period, because a reader takes it as a
guarantee.]`

`[OPERATOR: your backup retention. Backups outlive deletions, and a record deleted from the live database
is still in yesterday's backup.]`

### 9. Security

`[OPERATOR: describe the measures on your deployment — transport encryption, disk encryption, access
control on the host, patching, who administers the database.]`

What the software contributes, on every installation (product facts): access tokens and passwords are
stored only as hashes, and passwords are hashed with a per-account salt; tenant data is protected by
PostgreSQL row-level security enforced in addition to server-side authorisation; uploaded files are
type-checked from their content rather than from what the uploader declares, are held outside any web
root, are quarantined until they have been both scanned and reviewed, and are re-verified against their
recorded hash on every read; scanning fails closed, so an error, a timeout or an unavailable scanner
never yields a clean result; and the API is served with a restrictive Content-Security-Policy and
`Cache-Control: no-store`. The evidence handling model is documented in
[docs/security/EVIDENCE_SECURITY_MODEL.md](../security/EVIDENCE_SECURITY_MODEL.md).

Encryption at rest is not implemented by the application. Whether the disks, the database and the backups
are encrypted is a property of the infrastructure you chose.

`[OPERATOR: say which of those you have, rather than implying all of them.]`

### 10. Recipients, transfers and sub-processors

`[OPERATOR: everyone who can reach the data — your hosting provider, anyone you have given administrative
access, any support arrangement, any monitoring or backup service. For each: what they process and on
what contractual footing.]`

`[OPERATOR: whether any of them processes outside your own jurisdiction or outside the EEA, and on what
transfer mechanism. Name the mechanism you have actually put in place, not the one that is usually used.]`

### 11. Rights, complaints and changes

`[OPERATOR: the rights available to a data subject under the law that applies to you, how to exercise
them with you, your response time, and the supervisory authority they may complain to. This template
proposes no wording: rights language is jurisdiction-specific and is the part of a privacy notice most
often copied from a jurisdiction that does not apply.]`

`[OPERATOR: how you will notify changes to this notice, and the date it was last updated.]`

---

## Part 2 — Cookie notice

If nothing in front of your deployment sets a cookie, this notice is short and honest, and you should
resist padding it out.

### What the application sets

Nothing. OpenPPWR sets no cookie, and writes nothing to `localStorage` or `sessionStorage`. Authentication
uses a bearer token held in the memory of the open browser tab, which is discarded when the tab closes
(product fact).

### What else may set a cookie on your deployment

`[OPERATOR: one row per cookie that anything in your stack sets. If the answer is genuinely none, say
that — a cookie notice listing cookies you do not set is as wrong as one omitting cookies you do.]`

| Name | Set by | Purpose | Lifetime | Strictly necessary? |
|---|---|---|---|---|
| `[OPERATOR]` | `[OPERATOR]` | `[OPERATOR]` | `[OPERATOR]` | `[OPERATOR]` |

### Consent

`[OPERATOR: whether consent is required, and how it is obtained and withdrawn. This follows from the
table above and from your jurisdiction. If every entry is strictly necessary to deliver a service the
user asked for, the analysis is different from one where it is not — and that analysis is your adviser's,
not this template's.]`

### Controlling cookies

`[OPERATOR: what happens if a user blocks the cookies in the table. On a deployment with an access
gateway in front, blocking its cookie usually prevents sign-in; with nothing in front, blocking cookies
changes nothing, because the application sets none.]`

---

## Appendix — where each product fact comes from

Every statement marked *(product fact)* above is here with the code that establishes it, so it can be
verified rather than believed. Line numbers are as of OpenPPWR Community `0.2.0-beta.1`, and each one is
given with the symbol or statement it points at, so a citation that has drifted by a few lines is still
findable. If you are reading a later version, check the code rather than the number.

| Product fact | Source |
|---|---|
| Sign-in returns a bearer token and deliberately sets no cookie | `apps/api/src/app.mjs:232` — the comment on the `/v1/login` handler, and the handler itself |
| The browser client keeps the token in component state, never a cookie and never persisted | `apps/web/src/App.jsx:84` (`useState`), `apps/web/src/App.jsx:251` |
| Nothing is written to `localStorage`, `sessionStorage` or `document.cookie` | No occurrence anywhere in `apps/web/src` outside the copy that says so |
| A session lasts 12 hours | `packages/database/src/index.mjs:227` — `SESSION_TTL_MS` |
| The session record holds account identifier, token hash, issue time, expiry and revocation time | `packages/database/migrations/004_demo_login.sql:30` — `CREATE TABLE auth_sessions` |
| Signing out marks the session revoked | `packages/database/migrations/005_session_logout.sql:44` — `revoke_openppwr_session` |
| No code path deletes a session row; the request-serving database role is not even permitted to | `packages/database/migrations/013_credential_write_boundary.sql:47` — the `has_table_privilege` assertion; and no `DELETE FROM auth_sessions` exists anywhere under `apps`, `packages` or `scripts` |
| Password sign-in exists only when demonstration sign-in is enabled, and disabling it also invalidates sessions already issued | `apps/api/src/app.mjs:74` (`demoLoginEnabled`), `apps/api/src/app.mjs:246` (the `/v1/login` refusal), `apps/api/src/app.mjs:269` (the session refusal) |
| Account records hold display name, role, supplier scope and a token hash — no email, no password | `packages/database/migrations/001_phase4_foundation.sql:21` — `CREATE TABLE identities` |
| Demonstration accounts hold an email address with a password hash and salt | `packages/database/migrations/004_demo_login.sql:11` — `CREATE TABLE demo_users`; hashing in `packages/database/src/index.mjs:220` (`verifyPassword`) |
| Evidence metadata includes the original filename, declared and detected type, size, SHA-256, storage key, uploader and reviewer | `packages/database/migrations/001_phase4_foundation.sql:167` — `CREATE TABLE evidence_files` |
| Only never-accepted evidence is deleted by retention: scan status infected, error or timeout, and review status pending or rejected | `packages/database/migrations/024_gadd_remediation.sql:98` — the selection predicate inside `claim_openppwr_retention` |
| The retention period defaults to 30 days and is bounded between 1 and 3650; the sweep runs hourly by default | `apps/worker/src/index.mjs:486` (`OPENPPWR_EVIDENCE_RETENTION_DAYS`), `apps/worker/src/index.mjs:487` (`OPENPPWR_WORKER_RETENTION_SWEEP_MS`) |
| Audit records are append-only: `UPDATE` and `DELETE` are refused by trigger | `packages/database/migrations/001_phase4_foundation.sql:333` — `audit_events_immutable` |
| `TRUNCATE` on the audit table is refused by a statement-level trigger | `packages/database/migrations/007_audit_truncate_guard.sql:37` — `audit_events_truncate_guard` |
| Audit records identify the actor by internal identifier, with the action, entity and a payload | `packages/database/migrations/001_phase4_foundation.sql:290` — `CREATE TABLE audit_events` |
| Application log lines on a refused request carry code, status, method, route pattern, correlation identifier, actor and tenant — and no IP address, body or filename | `apps/api/src/app.mjs:648` — the `api.request.refused` call in the error handler |
| The logger strips credential-shaped keys and values | `packages/observability/src/index.mjs:11` — `redact` |
| Rate limiting resolves the caller's IP address and puts it into the counter key in the clear | `packages/security/src/rate-limit.mjs:50` (`resolveIdentifier`), `packages/security/src/rate-limit.mjs:83` (`bucketKey`) |
| The endpoints counted per IP address are sign-in, bootstrap and import | `packages/security/src/rate-limit.mjs:7`, `:11`, `:19` — the `dimension: 'ip'` entries in `DEFAULT_RATE_LIMIT_RULES` |
| Counter rows older than an hour are cleaned up on roughly one request in a hundred, not on a schedule | `packages/security/src/rate-limit.mjs:70` — the `Math.random() < 0.01` sweep |
| The counter table stores the key as text | `packages/database/migrations/003_rate_limiting.sql:5` — `CREATE TABLE rate_limit_buckets` |
| The application makes no outbound call to the project or to any third-party service | No external host is contacted by `apps/api/src` or `apps/web/src`; the browser client calls its own origin |
| Uploads are content-type-checked, quarantined until scanned and reviewed, stored outside any web root, and re-verified against their hash on read; scanning fails closed | [docs/security/EVIDENCE_SECURITY_MODEL.md](../security/EVIDENCE_SECURITY_MODEL.md); the read-time hash comparison is `apps/api/src/evidence-service.mjs:207` |
| Security headers, including the API's restrictive policy and `no-store` caching | `packages/security/src/index.mjs:21` — `buildSecurityHeaders` |

One observation that is neither a blank nor quite a product fact: the browser policy shipped with the web
application permits connections to its own origin and to the project's API hostname
(`packages/security/src/index.mjs:8` — `WEB_CSP`). It permits, it does not perform — the client only ever
calls its own origin — but if you serve the API from a different hostname you will be changing that line
anyway.

## What this template does not do

It does not name a lawful basis, a retention period, a supervisory authority, a transfer mechanism or a
rights statement, and it does not tell you whether you need a consent banner. Those are legal
determinations. This document was written by the engineers who can read the source, which is exactly the
qualification needed for the appendix and exactly the wrong one for the rest.

Related: [docs/deployment/SELF_HOSTED_INSTALL.md](SELF_HOSTED_INSTALL.md) for what a deployment consists
of, and [docs/security/EVIDENCE_SECURITY_MODEL.md](../security/EVIDENCE_SECURITY_MODEL.md) for how
uploaded files are handled.
