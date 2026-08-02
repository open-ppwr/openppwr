# OpenPPWR Community 1.0 — release contract

This is what OpenPPWR Community 1.0 promises, what it does not promise, and what stays stable for the
whole 1.x line. It is written for somebody who is about to run this software on their own hardware and
needs to know, before they start, which properties they may build a process on.

It is not a version number. Renaming `0.2.0-beta.1` to `1.0.0` would change a string; this document
changes what may be relied upon, and what has to keep being true for the next release to still be 1.x.

## How to read a promise here

Every promise in this document names the thing that enforces it: a source file, a migration, a test, or
a validation gate. A promise with nothing behind it is marketing, and this project does not ship
marketing as documentation. Where a promise has no enforcement, it is listed in
[Promises without enforcement](#promises-without-enforcement) instead of being stated as a guarantee.

`npm run release:contract:gate` reads this file and checks it against the code. What it checks is worth
stating exactly, because the difference matters to anyone deciding how much to rely on it:

- **Every number in the Status table is resolved from the thing that produces it** — the migration range
  from the migration directory, the permission count from the registry, the sign-in roles from the role
  list the server authorises against, the unreachable-package count from the import graph. A number that
  disagrees fails by name.
- **Every table is compared cell by cell** with its source: the database principals against
  `packages/database/src/prepare.mjs`, the roles against the permission registry, the unreachable packages
  against the graph, the published files against the filesystem.
- **Every file path this document cites in backticks must exist**, in the prose as well as in the tables.
- **Every row of the enforcement table must still cite something real**: the file exists and contains the
  anchor, and the anchor is specific enough to mean anything — a symbol, a literal or a marker the file
  emits, at least six characters, not an ordinary word, not ambient in the file it cites, and not shared
  with another row.

**What it does not check is the prose.** The enforcement table is a citation check, not a reading: the gate
can tell you the evidence a promise names is still there, and it cannot tell you that the evidence supports
the promise. `LICENSE` contains the words "Apache License", so a row claiming FIPS certification and citing
them would pass — that is not hypothetical, it was measured on this document, and it is why the anchor rules
above exist and why they are not enough on their own. The sentences here are kept true by people reading
them; the gate is what stops the *citations under them* rotting quietly while nobody looks.

So: if you are evaluating this software, that one command tells you whether every number, table and citation
in this document still resolves against the code. Whether the words around them are true is a question to
answer by following the citations, which is what they are for.

## Status

<!-- contract:facts -->
| Fact | Value |
|---|---|
| Verified against version | `1.0.0` |
| First migration | `001` |
| Last migration | `039` |
| Named permissions | `16` |
| Login principals | `5` |
| Roles in the registry | `9` |
| Roles a person can sign in as | `7` |
| Runtime-unreachable packages | `3` |
<!-- /contract:facts -->

1.0 has not been published. This contract was verified against the candidate named above, on the tree
it was written in, and the gate that checks it runs on every subsequent change. Publication is a
separate decision and is not recorded here.

---

## 1. Product contract

**The whole path from packaging data to a compliance dossier works in one deployment, unattended.**
Import packaging records, raise the evidence requirements they imply, upload evidence, have it scanned
and reviewed, run an assessment, manage the resulting gaps, freeze a review snapshot, and generate the
dossier from that snapshot. `scripts/validation/demo-full-e2e.mjs` drives that entire sequence over the
product's own HTTP API and asserts the published outcome counts rather than "some of each"; it is a
stage of `npm run full-gate`, so a change that breaks any step of it fails the build.

**A clean first run on your own host.** `scripts/installer/openppwr-installer` takes an unprepared
Debian 13 machine to a serving deployment: `preflight`, `install`, `configure`, `start`, `verify`. It
refuses rather than improvises — wrong operating system, wrong architecture, too little memory, too
little disk, a port already taken. `scripts/validation/installer-docs-gate.mjs` compares the documented
first-run sequence against the installer's own dispatch table, so a page naming a subcommand the script
does not have fails the build rather than the reader.

**The shipped data is synthetic, and stays synthetic.** ACME Packaging Europe GmbH and everything
belonging to it is generated fiction. `scripts/acme/acme-dataset.mjs` regenerates it deterministically
and verifies it against a checksum manifest; `packages/dossier/src/index.mjs` carries the disclaimer
into every dossier the product builds, so an artifact produced from demonstration data says so in the
artifact rather than only on the page that offered it.

**One tenant per deployment.** This is enforced, not documented. `create_openppwr_tenant` in migration
`008` counts the registry inside a privileged function and refuses a second tenant; the worker reads
`openppwr_tenant_count()` at startup and on a periodic recheck and stops if the database holds more than
one. The data model stays tenant-aware with row-level security throughout — that is what makes the
single-tenant rule a decision rather than an absence — but a second tenant is refused at both ends.

**Seven roles a person signs in as, two the machine uses.**

<!-- contract:roles -->
| Role | A person can sign in as it |
|---|---|
| `tenant_admin` | yes |
| `compliance_manager` | yes |
| `packaging_editor` | yes |
| `evidence_contributor` | yes |
| `evidence_reviewer` | yes |
| `read_only_auditor` | yes |
| `supplier_user` | yes |
| `service_account` | no |
| `worker` | no |
<!-- /contract:roles -->

"A person can sign in as it" means a password and a session. `service_account` and `worker` authenticate —
each holds a bearer credential an operator was given at bootstrap — and neither is a person, so neither is
given a password. On the demonstration deployment that is a rule about what exists rather than about what is
offered: `bootstrap` provisions demonstration accounts for the seven and for no one else, and the column
above is resolved from `HUMAN_ROLES` in `apps/api/src/permissions.mjs`, the same list the registry uses to
refuse a machine permission to a person. It was resolved from the interface's role-matrix columns until
2026-08-02, which is a different question with a different answer, and the contract stated eight.

Correcting `bootstrap` only governs a deployment created after it. A deployment bootstrapped earlier still
held those two accounts, at a predictable address, with the published demonstration password, because
sign-in had never asked what kind of identity was signing in. Migration
`packages/database/migrations/039_machine_identities_cannot_sign_in.sql` removes the rows and makes both
halves of sign-in — the salt lookup and the verification — resolve a machine role the way they resolve an
address that does not exist. That second part is the one that lasts: a row reinstated by an older image, a
restored backup or one hand-written `INSERT` still does not authenticate.

Sixteen named permissions, no wildcard, and no inheritance. `apps/api/src/permissions.mjs` declares
which roles hold each permission and checks its own soundness at import time — not in a test, in the
process that is about to authorise requests. `scripts/validation/permission-matrix-gate.mjs` then
compares the registry against the interface that displays it and against
`docs/security/AUTHORIZATION_MATRIX.md` cell by cell, in both directions. A permission the server grants
and the matrix omits fails the build; so does a cell the document claims and the server does not grant.

**The dossier is deterministic and carries its own manifest.** The same frozen snapshot produces
byte-identical JSON, PDF and ZIP, and a SHA-256 manifest covering every member. Determinism is not
incidental: JSON is canonicalised with sorted keys, the PDF is emitted uncompressed with timestamps
taken from the snapshot rather than from the clock, and members are sorted before the archive is built.
`packages/dossier/test/index.test.mjs` asserts the byte-for-byte property, including for the Polish and
German locales, whose glyph coverage is a separate test.

**An audit record you can reconstruct.** Every audit event is chained to its predecessor per tenant, and
`GET /v1/audit/verify` walks the whole chain and reports whether it holds. Chain verification is a
product capability with a permission of its own, not an internal debugging route.

**Backup, restore, upgrade and rollback are installer subcommands, not a wiki page.** `backup` stops both
writers for the width of the snapshot so the database dump and the evidence archive describe one moment,
checks the dump's exit status before compressing, and includes the bootstrap identities file. `restore`
confines its source to the deployment's own backups directory. `upgrade` takes a backup first and records
which directory it took. `rollback` restores that generation.

**The limitations are published.** `docs/release/KNOWN_LIMITATIONS.md` ships with the source, in the
public export, and is a release gate of its own rather than a courtesy.

---

## 2. Compatibility contract

<!-- contract:pinned -->
| Component | Pinned in the shipped stack | Where |
|---|---|---|
| PostgreSQL | `postgres:18.4-alpine` | `deploy/community/docker-compose.yml` |
| ClamAV | `clamav/clamav:1.4` | `deploy/community/docker-compose.yml` |
| Runtime base | `gcr.io/distroless/static-debian13:nonroot` | `Dockerfile` |
| Image platform | `linux/amd64` | `.github/workflows/release-image.yml` |
<!-- /contract:pinned -->

**Host.** Debian 13 on x86_64. The installer's `preflight` reads `/etc/os-release` and `uname -m` and
refuses anything else outright, so this is a supported platform rather than a recommended one.

**Container runtime.** Docker with Compose v2. `preflight` requires `docker compose version` to answer,
and requires `openssl`, `sha256sum`, `tar`, `gzip`, `curl` and `realpath` to be present before it will
proceed.

**Minimum resources.** 4 GB RAM and 15 GB free disk, checked by `preflight` and refused below either
figure. Per-service caps in the shipped Compose file total 5.5 GB of memory and 7.5 CPUs across
PostgreSQL, ClamAV, API, worker and web; ClamAV alone is allotted 2 GB, because a malware scanner with
loaded signatures is the largest single consumer in this stack. These are ceilings, not a sizing
recommendation — see [Promises without enforcement](#promises-without-enforcement).

**Browsers.** The product is a server-rendered application with a client bundle; the automated browser
evidence — end-to-end journeys, accessibility, and the rendered-page check across all localized pages —
is driven through Chromium in `scripts/validation/browser-e2e.mjs`,
`scripts/validation/accessibility-gate.mjs` and `scripts/validation/website-browser-check.mjs`. Current
Chromium-based browsers are therefore the tested target. Firefox and Safari are not exercised by any
gate, and no claim is made about them; see [Promises without enforcement](#promises-without-enforcement).

**Migration compatibility.** Migrations are applied in filename order, each in its own transaction,
recorded in `openppwr_schema_migrations`, and skipped if already applied — so re-running the migration
step on a current database is a no-op rather than a hazard. `apps/api/src/server.mjs` reads the applied
level at startup and refuses to serve when the database is *behind* the image. A database *ahead* of the
image is a warning rather than a refusal, because that is what an upgrade window and a deliberate
rollback both look like from inside a container.

**Upgrade path.** `openppwr-installer upgrade IMAGE`, which refreshes the Compose file from the new
release tree rather than swapping only the image reference, and generates any principal password that
did not exist when the deployment was first configured.

**Rollback is restore-based.** Not image-only. This is a property of the upgrade mechanism rather than of
any particular schema delta, and it was written here while the schema was not moving at all: even with an
identical schema on both sides, rollback was restore-based. The schema now advances by exactly one
migration across this release — `038` to `039`, which removes the demonstration password accounts a machine
identity should never have held and makes sign-in refuse those roles in the database. That adds a second,
weaker reason and changes nothing about the mechanism or the procedure. The first reason is stated directly
above: `upgrade` refreshes the
Compose file from the new release tree, so the deployment's health checks, dependency conditions and
credential wiring become that release's. Putting the old image reference back leaves all of them in place,
against an application that predates them; a container failing the new release's health check then holds
back every service whose `depends_on` waits on it. Rolling back means restoring the Compose file, the
database, the evidence volume and the environment file of the pre-upgrade generation **together**, which is
what `openppwr-installer rollback` does. Without a pre-upgrade backup there is no way back, which is why
`upgrade` takes one before it starts.

A version string is also not an artifact. `0.2.0-beta.1` covered builds ranging from migration level `006`
to `038`, so "roll back to the previous version" does not identify a schema level. The rollback target is
the generation `upgrade` recorded, not a version name.

---

## 3. Security contract

### Five login principals, and one owner that cannot log in

<!-- contract:principals -->
| Principal | Configuration | What it is for |
|---|---|---|
| `openppwr_app` | required | Serves requests. Holds no capability to write credentials, provision identities or reset a tenant. |
| `openppwr_worker` | required | Scans evidence and drives the retention state machine. A database identity of its own, not the API's. |
| `openppwr_auth` | optional | Verifies a password and issues a session. Absent on a deployment holding real data, which then has no password sign-in at all. |
| `openppwr_maintenance` | optional | Resets a demonstration deployment. Absent means the capability does not exist, rather than existing with a default. |
| `openppwr_rotation` | optional | Replaces one identity's bearer credential and does nothing else. |
<!-- /contract:principals -->

`packages/database/src/prepare.mjs` is the authority on this list and the gate reads it from there.
Optional does not mean dormant: a principal whose password is absent is **retired** — set `NOLOGIN` with
its password nulled — so removing a variable removes the credential rather than only the deployment's use
of it.

Each principal needs its own password, at least 32 characters, and reusing one across two principals is
refused: separated grants with a shared credential is the appearance of a boundary rather than a
boundary. After every provisioning statement the role's attributes are read back from `pg_roles` and
checked — not superuser, not `CREATEROLE`, not `INHERIT`, not `BYPASSRLS`, not `REPLICATION`, no
role-level settings, no expired password — because a claim about a security boundary that is never read
back is a claim nobody is checking. Membership of any other role is refused separately, since `NOINHERIT`
stops implicit inheritance but only the absence of membership stops `SET ROLE`.

A sixth role, `openppwr_security_owner`, exists and cannot log in. It owns `deployment_metadata` and every
`SECURITY DEFINER` function, and holds `BYPASSRLS` because that is the one specific authority those
functions need. It is granted to nobody and has no credential. Before migration `017` those functions ran
with whatever the migration credential happened to be, which in the shipped Compose was a superuser — a
boundary that worked by accident of installation.

At startup each pool is asked `current_user` and compared to the principal its URL claims. A deployment
pointing every variable at the same credential would satisfy every grant assertion in the schema while
having no separation at all, and nothing else would notice.

### Row-level security

Every tenant-scoped table carries `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` with a
`tenant_isolation` policy keyed to the session's tenant, applied in a loop in migration `001` so a table
added to the list cannot be missed by hand. `FORCE` is the part that matters: without it the table owner
is exempt from its own policy. The tenant registry itself gained self-only row-level security in
migration `008`, and tenant creation moved inside a privileged function so that the one-tenant count is
not performed by a role that can only ever see one tenant.

Supplier scoping is a second boundary inside one tenant: `supplier_user` holds narrowed `read-own` and
`evidence:download-own` permissions, and `isAllowed` refuses a resource belonging to another supplier.
`scripts/security/supplier-isolation-matrix.mjs` drives that boundary over real HTTP and is a stage of
the local gate — separate from the cross-tenant suite on purpose, because every isolation test in this
project once asked the cross-tenant question and none asked this one.

### Authentication boundary and session lifecycle

Password sign-in runs only on `openppwr_auth`, through a `SECURITY DEFINER` function, and issues a
session row with its own expiry. Signing out revokes the session server-side in the same transaction that
records it, so the credential is invalid immediately rather than merely forgotten by the browser. Both
sign-in and sign-out append to the audit chain inside the function that performs the write — an append
recorded afterwards on a separate round trip can succeed while the write it describes fails, or the
reverse.

Bearer credentials issued at bootstrap carry an expiry (`token_expires_at`, defaulting to 90 days).
Before migration `009` they were valid for ever and a static credential's own expiry was discarded rather
than enforced.

### Operator credential lifecycle

One identity's bearer credential can be replaced without touching anything else. An identity may replace
its own — the caller has already proved possession by presenting it — and replacing another's requires
`credential:rotate`, held by the tenant administrator alone. The replacement is returned once, every
session derived from the old credential ends in the same transaction, and the rotation is appended to the
audit chain. Rotation cannot change a role, a tenant or a supplier scope.

Rotation runs on `openppwr_rotation`, which holds `EXECUTE` on that one function and nothing else. That
is what makes it safe for a deployment holding real data to load, where the session-issuing credential
deliberately is not: issuing a session is authority by itself, while rotation requires the caller to
present a live credential first and grants nothing beyond what that credential already authorises.

### Worker isolation

The worker has its own principal, its own pool, its own network membership and its own health surface.
It reaches PostgreSQL and ClamAV and nothing else; the API reaches PostgreSQL and not the scanner; the
one internet-facing container reaches the API and neither the database nor the scanner. Before migration
`022` the worker shared the API's database identity, which meant the retention state machine — moved
behind functions precisely so that no role could write the fence directly — was callable from the
request-serving process.

### Upload control and malware scanning

Uploads are bounded at 10 MiB by the parser rather than after the fact, restricted to an allowlist of
extensions, and refused unless the declared MIME type, the extension and the leading content signature
all agree. Double extensions are refused. Filenames are normalised; the stored name is derived from the
evidence identifier rather than from anything the uploader chose.

Scanning fails closed. Evidence cannot be reviewed until it has been scanned, so a `clamd` that is
unavailable stops review rather than waving files through, and a scanner response that is neither `clean`
nor `infected` is an error rather than a default. The item retry budget is fixed at exactly three
attempts — `OPENPPWR_WORKER_MAX_ATTEMPTS` is bounded to a minimum and maximum of 3 and cannot be tuned —
and is spent on content failures only; scanner outages consume a separate infrastructure budget with
bounded exponential backoff, so one clamd outage does not exhaust an evidence item's three attempts.

### Retention fencing

A retention deletion has an owner, a lease and a fencing token. The tombstone is named after the
*operation* rather than after the file, so a worker that has become slow rather than dead cannot remove or
restore bytes belonging to the attempt that replaced it: it holds the previous operation identifier and
the file under that name no longer exists. The structural constraint is described as structural — liveness
cannot be a `CHECK`, because `now()` is not immutable and a row constraint cannot see time passing.

### Audit immutability

`audit_events` is append-only against every operation available to the runtime roles. A row-level trigger
refuses `UPDATE` and `DELETE`; a **statement-level** trigger refuses `TRUNCATE`, which the row trigger
never saw because a truncate has no rows to iterate. There is one canonical way into the chain,
`append_openppwr_audit_event`, which verifies the previous link before writing and resolves the actor from
the credential presented rather than from a parameter, and an action registry constrains which database
principal may append which action.

Stated so the guarantee is not overclaimed: a fully privileged database superuser can disable a trigger
and therefore remains outside this boundary. That is a property of PostgreSQL, not something closable in
SQL.

### Secret handling

The example environment file ships `REPLACE_WITH_…` placeholders, and Compose checks only that a variable
is non-empty — so a file copied unchanged would start a deployment whose bootstrap token is a string
published in this repository. `packages/security/src/secret-strength.mjs` refuses values that are
certainly not secrets: the placeholders this repository publishes, obvious non-secrets, and lengths no
generator would produce. It deliberately does not score entropy, because an estimator that rejects a
legitimate random secret is an outage and one that accepts `Password123!` is theatre. The supported
installer generates its own secrets and writes the environment file mode `0600`.

Logging redacts in one place. `packages/observability/src/index.mjs` has a single emission path, so
secret assignments and `Bearer` presentations are replaced with `[REDACTED]` at the one point where
redaction can be got right or wrong.

### Production and demonstration are separate postures

A deployment that is not running the demonstration must not load the sign-in or reset credentials, and
`apps/api/src/server.mjs` refuses to start if they are present — refused rather than ignored, because
silently declining to use a credential still leaves it in the environment, in the process, and in
anything that reads either. The mirror is fatal too: demonstration sign-in declared on with nothing able
to perform it fails at startup rather than at the first person who tries to sign in.

### Vulnerability posture

As of 2026-08-01, the runtime image contains no C library at all: the base is `distroless/static-debian13`
running a musl-linked Node taken from `node:24-alpine`, and both Grype and Trivy report nothing at any
severity. The three Critical/High findings that preceded this were glibc issues with no fixed package
available on Debian; they were removed by construction rather than argued away. The scan output and the
trade-offs accepted are in `docs/security/CONTAINER_SCAN_REPORT.md`.

`npm run secret:scan`, `npm run gate:sast` and `npm run dependency:audit` (at `--audit-level=high`) are
stages of the local gate, and `scripts/validation/dast-scan.mjs` runs black-box probes against a running
deployment as part of the deployment gate.

The three are not comparable in depth and were listed as though they were. `gate:sast` is five regular
expressions applied to the text of every tracked `.js`, `.jsx` and `.mjs` file — dynamic evaluation, shell
execution, a client-supplied tenant header and a disabled TLS check. It parses nothing, follows no value
from an input to a query, crosses no module boundary, and does not read `.sql`, `.sh`, `.yml`, the installer
or the `Dockerfile`. Until 2026-08-02 its pass line ended `semgrep=unavailable`, printed by a script that
had never looked for semgrep; the field is gone, and the line now names all five rules and what they cannot
reach. No semgrep-class analysis has been run on this repository.

### Human review that a program cannot supply

1.0 requires three human readings that no tool substitutes for: security, by a named person who did not
write the code; Polish product wording; and German regulatory wording. Automated analysis is supplementary
technical evidence — a program is not a named person, and a passing scan is not somebody's judgement. The
state of those readings is a release gate in its own right, tracked outside this document; nothing here
should be read as asserting that they are complete.

---

## 4. Operational contract

**Installer.** One script, `scripts/installer/openppwr-installer`, with a fixed dispatch table:
`preflight`, `install`, `verify-archive`, `configure`, `start`, `bootstrap`, `bootstrap-acme`, `verify`,
`credentials`, `backup-key init|show`, `journal-retention apply|show`, `backup`, `restore`, `upgrade`,
`rollback`, `status`, `stop`, `uninstall`. `bootstrap` creates an operator's own tenant and
`bootstrap-acme` creates the fictional demonstration one; they differ in whether the tenant is marked as a
demonstration and whether the synthetic catalogue is loaded, which is why they are two commands rather than
a flag. `scripts/installer/validate-installer.mjs` and `scripts/validation/installer-docs-gate.mjs` keep
the script and its documentation from drifting apart.

`bootstrap` was absent from the list above until 2026-08-02, and it was the newest command and the one that
decides whether a deployment's dossiers carry the fiction marker. Nothing caught it: the docs gate failed a
document naming a subcommand the script lacks, and compared the dispatch table with `usage()`, but no rule
required a dispatched subcommand to appear anywhere at all — so a new command could ship undocumented
indefinitely while every gate stayed green. The gate now reads this list and compares it with the dispatch
table in both directions, which makes the sentence above a checked assertion rather than a description.

**Configuration validation.** Compose refuses to interpolate an unset required variable; the API refuses
to start on a placeholder secret, on a pool that connects as the wrong principal, on a privileged
credential present in a production posture, or on a database behind the image. Each of these is a startup
refusal rather than a warning.

**Health and readiness.** The worker distinguishes them: `/health/live` answers "restart me",
`/health/ready` answers "take me out of service", and `/health` returns the full operational snapshot
including the degraded state that a boolean cannot express. `/health/ready` stays 503 while an
infrastructure fault is outstanding and returns to 200 only on evidence — a completed scan or a successful
scanner probe. Until this distinction existed, the worker reported healthy again after any empty poll, so
a dead scanner looked exactly like an idle queue.

The API now makes the same distinction. `/health/live` consults nothing; `/health/ready` returns `200` when
the database answers through the connection pool and `503` with a single closed-set reason code when it does
not, bounded so that a probe cannot hang. `/health` keeps its published meaning as liveness, because the
defect was that the container healthcheck asked the wrong question rather than that the answer to this one
was wrong — and an orchestrator restarting on failed liveness would restart a healthy API on every database
blink, which is the failure this separation exists to prevent. The container healthcheck, in both the image
and the Compose file, probes `/health/ready`.

**Logs and redaction.** Every service logs to `journald` with a per-service tag. Retention is bounded by
both age and size — `scripts/validation/log-retention-gate.mjs` fails the build if a service loses its
journald block, which would silently fall back to the daemon default and stop having any age bound at all,
and equally if the shipped wording drifts to an age-only promise. Redaction happens on the single emission
path described above.

**Backup and restore.** Backup sets are encrypted to a public key: AES-256-GCM content encryption with
RSA-OAEP/SHA-256 key transport, through `openssl cms`. The host keeps only the certificate; the private
key is written wherever the operator says and never under the deployment root, because the backups
directory is what leaves the machine. The plaintext member never outlives the ciphertext beside it, and a
failed encryption removes the partial output rather than leaving a half-written archive that looks
complete. Restore and rollback need that key — including at the worst possible moment, which is the real
cost of this design and is stated rather than discovered.

**Recovery from total loss.** `scripts/release/rehearse-recovery.mjs` rehearses the immutable path: full
teardown of containers, named volumes and the deployment root, a fresh install and configure against the
same pinned image, then restore from a backup copy held outside the deployment tree.

**Upgrade and rollback.** As in the compatibility contract: forward by `upgrade`, backward by restoring
the pre-upgrade generation. `upgrade` records which backup directory it took, so a later `rollback`
restores that generation rather than whichever backup happens to sort last.

**Diagnostics.** `openppwr-installer status` and `verify`; `GET /v1/version` reports version, revision,
build timestamp, channel, image digest, the migration level baked into the image, the
`appliedMigrationLevel` read from the database on each request, and `migrationLevelVerified`, true only
when both are known and equal. Until that pair existed the reported level came from a build argument and
nothing compared it to the schema, so the one number a reader could use to tell which schema a deployment
was on was the one number nothing verified.

**Credential rotation.** As in the security contract. A deployment that sets no rotation password has no
supported way to replace a leaked bearer credential — which is a decision an operator may take, but must
not take by accident, so absence retires the role rather than leaving it dormant.

**Checksums, SBOMs and image digest.** The release workflow builds once, generates both an SPDX and a
CycloneDX SBOM, attests build provenance and the SBOM to the published digest, signs the digest with
Cosign under GitHub OIDC, verifies that signature, and writes `SHA256SUMS` over every supply-chain
artifact. The digest recorded is read back from the push output and refused unless it matches
`sha256:` followed by 64 hex characters. `scripts/validation/validate-release-workflow.mjs` and
`scripts/release/validate-supply-chain.mjs` check the workflow's own shape, and both have tests.

---

## 5. Public-project contract

<!-- contract:public-files -->
| File | What it settles |
|---|---|
| `LICENSE` | Apache License 2.0, canonical text |
| `NOTICE` | First-party copyright and the pointer to third-party notices |
| `THIRD_PARTY_NOTICES.md` | Third-party attributions |
| `TRADEMARKS.md` | What the name and marks may be used for |
| `CONTRIBUTING.md` | How to contribute, and the sign-off requirement |
| `DCO.md` | Developer Certificate of Origin 1.1 |
| `CODE_OF_CONDUCT.md` | Conduct expected of participants |
| `SECURITY.md` | How to report a vulnerability, and what happens then |
| `SUPPORT.md` | What support exists, what does not, and where each kind of question belongs |
| `CODEOWNERS` | Who reviews what |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Bug report template |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Feature request template |
| `.github/pull_request_template.md` | Pull request template |
| `docs/architecture/OPEN_CORE_BOUNDARY.md` | What is Community and what is not |
| `docs/release/KNOWN_LIMITATIONS.md` | The limitations, published rather than discovered |
<!-- /contract:public-files -->

**Licence.** Apache-2.0, for the source and for every workspace manifest in it. The export validator
checks that `LICENSE` carries the canonical Apache text, that `NOTICE` carries the first-party copyright
and the third-party pointer, and that every exported `package.json` declares `Apache-2.0` — because a
repository can carry a licence file and still ship a manifest saying something else.

**Contributions are DCO sign-off, not a CLA.** `Signed-off-by` on each commit; the text of the
certificate is in `DCO.md` rather than referenced.

**Security reporting.** `SECURITY.md` states the channel and the handling. It is the only service-level
commitment 1.0 makes, and it is about disclosure handling rather than about availability. `SUPPORT.md`
states the other side of that plainly — Community support is best effort with no response time, no
remediation time and no queue — because the absence of a support file is read by most people as an
unstated commitment rather than as none.

**Community and commercial boundary.** `docs/architecture/OPEN_CORE_BOUNDARY.md` states what belongs to
Community. The permission registry enforces one half of it directly: every permission declares an
`edition`, and one belonging to a commercial edition is refused by the registry's own soundness check at
import time rather than by review.

**Release and upgrade notes ship with the source.** They are written for whoever runs the software, not
for whoever decides to publish it, and withholding them would ship a release whose own upgrade path is
undocumented.

---

## 6. What 1.0 does not promise

Each of these is a real limit, verified rather than repeated.

- **No certification of any kind.** OpenPPWR supports a readiness process. It does not certify anyone,
  and no output of it is a certificate.
- **No guarantee of regulatory compliance.** The shipped rule pack is a demonstration pack, deliberately
  small and non-authoritative, and requires human regulatory review before any conclusion is drawn from
  it.
- **No independent penetration test.** None has been performed.
- **No third-party audit.** No external party has audited this code, this deployment or this process.
- **No SLA**, other than the security-disclosure handling in `SECURITY.md`. No uptime or availability
  figure is offered, because none has been measured.
- **No high availability and no zero-downtime upgrade.** The shipped stack is a single instance of each
  service. An upgrade stops the writers.
- **No `arm64`.** The image is built `linux/amd64` only and the installer refuses any architecture other
  than x86_64.
- **No multi-tenant orchestration.** One tenant per deployment, refused at startup rather than merely
  unsupported.
- **No browsers other than Chromium are exercised.** See the compatibility contract.
- **No secret-manager bootstrap command.** Bootstrap returns bearer credentials on the wire; capturing
  them through an approved process, and then removing and rotating the bootstrap capability, is the
  operator's job.
- **Three packages ship in the source tree and are never loaded at runtime.**

<!-- contract:unreachable-packages -->
| Package | Directory |
|---|---|
| `@openppwr/core` | `packages/compliance-core` |
| `@openppwr/packaging-domain` | `packages/packaging-master` |
| `@openppwr/reconciliation` | `packages/reconciliation` |
<!-- /contract:unreachable-packages -->

  They are retained because they carry tested domain logic intended for later use, and they are named
  here because a reader auditing the tree should not have to discover it. The observability package that
  holds the redacting logger is **not** among them — it is imported and active in the running services,
  and so is `@openppwr/evidence` in `packages/supplier-evidence`, which the dossier builder uses to
  produce the archive.
- **ClamAV is an external dependency this project does not maintain.** Signature freshness, resource
  sizing and availability are the operator's responsibility. Failures remain closed.
- **Independent environment validation is not claimed.** The installer, backup, restore, upgrade and
  recovery rehearsals have passed against a real Debian 13 host; they have not been repeated by somebody
  other than their author on a host they control, which is the point of the exercise.
- **The privacy, cookie and company-information text has not been reviewed by a qualified lawyer**, and
  the shipped pages say so. German regulatory wording carries an internal preview only. English is the
  fallback where a translation is missing.

---

## 7. Promises without enforcement

Stated separately rather than quietly omitted. Each of these is something the project asserts or implies
today with no gate, test or migration behind it. They are not guarantees of 1.0.

1. **Browser support beyond Chromium.** Every browser-driven gate launches Chromium. Firefox and Safari
   are untested, and nothing would report a regression in either.
2. **Minimum resources are checked at install time and never again.** `preflight` verifies 4 GB RAM and
   15 GB free disk before installing. A host that later falls below either figure produces no signal from
   this software; the per-service Compose limits are caps, not floors.
3. **No gate asserts a supported PostgreSQL major-version range.** The Compose file pins one digest, and
   an operator pointing the deployment at their own PostgreSQL of a different major version would find out
   at migration time. The pin is the whole of the compatibility statement.
4. **Backup restorability is rehearsed, not continuously verified.** The recovery rehearsal is run
   deliberately; no scheduled job restores a backup and checks it, so a backup set that has silently
   become unrestorable would be discovered during a recovery.
5. **Nothing verifies the private backup key is held off-host.** The installer writes it wherever the
   operator says and warns against the deployment root; it cannot check what happens afterwards.
6. **Upgrade compatibility is asserted for the immediately preceding version only.** There is no test
   matrix over older versions, and no gate prevents a migration that would break one.
7. **Readiness is bounded by a figure derived from one measurement, not from a deployment.** The API's
   `/health/ready` gives the database 2s to answer, chosen against this repository's own pool-checkout
   curve rather than against any operator's traffic. A deployment whose database is legitimately slower
   than that will report itself unready. The gap this entry used to describe — an API with no readiness
   endpoint at all — is closed.
8. **Log redaction is a pattern match, not a proof.** It covers secret-shaped assignments and `Bearer`
   presentations. A secret logged in a shape no pattern anticipates would pass.
9. **"Static analysis" is five regular expressions.** `gate:sast` matches literal text in one file at a
   time across `.js`, `.jsx` and `.mjs` sources. It has no parser, no data-flow or taint analysis, no
   cross-file reasoning, and no coverage of `.sql`, `.sh`, `.yml`, the installer or the `Dockerfile`. It
   catches the five shapes it names and nothing beyond them, and nothing here has been examined by a
   semgrep-class tool.
9. **Independent human review is required by this contract and cannot be enforced by it.** No gate can
   establish that a named person read something.
10. **The prose of this document is not machine-checked, only its numbers, tables and citations.** The
    enforcement table proves that the evidence a promise names still exists; nothing proves that the
    evidence supports the promise, because that judgement is a reading and the gate is a string search. A
    sentence here can be made false by a change that leaves every anchor intact, and the only thing that
    would catch it is somebody reading both. This is the reason each promise cites a file you can open.

---

## 8. Enforcement

Every row below is checked by `npm run release:contract:gate`: the file must exist and must contain the
anchor. A renamed function, a deleted migration or a retired gate therefore fails the build here, in the
document that promised it, rather than being noticed later by somebody reading prose.

The anchor is held to four rules, because containment is only as good as the string being contained: at
least six characters, not an ordinary word of English (a name, a literal or a marker the file emits — so
`assertRegistryIsSound` qualifies and `supplier` does not), present no more than fifty times in the file it
cites, and not already cited by another row, since one line of evidence cannot substantiate two promises.
Nine anchors in this table failed those rules when they were introduced and were replaced with the markers
the named files actually emit. What the rules cannot do is read the promise in the first column; see
[How to read a promise here](#how-to-read-a-promise-here), and item 10 of
[Promises without enforcement](#promises-without-enforcement).

<!-- contract:enforcement -->
| Promise | Enforced by | Anchor |
|---|---|---|
| The full packaging-to-dossier journey completes | `scripts/validation/demo-full-e2e.mjs` | `DEMO_FULL_E2E_PASS` |
| Every interactive role is probed in that journey | `scripts/validation/demo-full-e2e.mjs` | `DEMO_ROLE_MATRIX_PASS` |
| Clean first run refuses an unsupported host | `scripts/installer/openppwr-installer` | `only Debian 13 x86_64 is supported` |
| First run refuses too little memory | `scripts/installer/openppwr-installer` | `at least 4 GB RAM is required` |
| First run refuses too little disk | `scripts/installer/openppwr-installer` | `at least 15 GB free disk is required` |
| Docker Compose v2 is required | `scripts/installer/openppwr-installer` | `Docker Compose v2 is required` |
| Documented first-run steps match the dispatch table | `scripts/validation/installer-docs-gate.mjs` | `INSTALLER_DOCS` |
| Demonstration data is synthetic and checksummed | `scripts/acme/acme-dataset.mjs` | `ACME_CHECKSUM_PASS` |
| The fiction disclaimer travels inside the dossier | `packages/dossier/src/index.mjs` | `FICTION_DISCLAIMER` |
| A second tenant is refused in the database | `packages/database/migrations/008_tenants_rls_and_bootstrap.sql` | `create_openppwr_tenant` |
| The worker refuses to run against more than one tenant | `apps/worker/src/index.mjs` | `openppwr_tenant_count()` |
| The permission registry is sound in the serving process | `apps/api/src/permissions.mjs` | `assertRegistryIsSound` |
| No wildcard permission exists | `apps/api/src/permissions.mjs` | `the registry must not contain a wildcard permission` |
| A commercial-edition permission cannot be granted here | `apps/api/src/permissions.mjs` | `must not be granted by the Community registry` |
| Interface, registry and matrix document agree | `scripts/validation/permission-matrix-gate.mjs` | `PERMISSION_MATRIX_PASS` |
| The dossier and its manifest are byte-deterministic | `packages/dossier/test/index.test.mjs` | `builds byte-deterministic JSON, PDF, ZIP and checksum manifest` |
| The checksum manifest covers every member | `packages/dossier/src/index.mjs` | `createChecksumManifest` |
| Audit chain verification is a product capability | `apps/api/src/app.mjs` | `/v1/audit/verify` |
| There is one canonical way into the audit chain | `packages/database/migrations/020_canonical_audit_append.sql` | `append_openppwr_audit_event` |
| The audit chain is per tenant | `packages/database/migrations/037_audit_chain_per_tenant.sql` | `audit_chain_head` |
| TRUNCATE cannot erase the audit chain | `packages/database/migrations/007_audit_truncate_guard.sql` | `audit_events_truncate_guard` |
| Sign-in and sign-out are audited | `packages/database/migrations/038_login_logout_audited.sql` | `auth.login.succeeded` |
| Restore is an installer command, not a procedure | `scripts/installer/openppwr-installer` | `restore DIR` |
| Upgrade is an installer command | `scripts/installer/openppwr-installer` | `upgrade IMAGE` |
| Upgrade records the generation rollback must restore | `scripts/installer/openppwr-installer` | `previous-backup` |
| Backup sets are encrypted to a public key | `scripts/installer/openppwr-installer` | `cms_encrypt` |
| Backup quiesces the writers so the set describes one moment | `scripts/installer/openppwr-installer` | `compose stop api worker` |
| Restore is confined to the deployment's own backups | `scripts/installer/openppwr-installer` | `canonical_backup_dir` |
| The backup key may not be stored beside the backups | `scripts/installer/openppwr-installer` | `must be outside the deployment root` |
| Recovery from total loss is rehearsable | `scripts/release/rehearse-recovery.mjs` | `RECOVERY_REHEARSAL_` |
| Limitations are published with the source | `docs/release/KNOWN_LIMITATIONS.md` | `One tenant per deployment` |
| PostgreSQL is pinned by digest | `deploy/community/docker-compose.yml` | `postgres:18.4-alpine@sha256:` |
| ClamAV is pinned by digest | `deploy/community/docker-compose.yml` | `clamav/clamav:1.4@sha256:` |
| The runtime base carries no C library | `Dockerfile` | `gcr.io/distroless/static-debian13` |
| Migrations are recorded and not re-applied | `packages/database/src/migrate.mjs` | `openppwr_schema_migrations` |
| The API refuses a database behind the image | `apps/api/src/server.mjs` | `migrationLevelFinding` |
| Browser evidence is driven through Chromium | `scripts/validation/browser-e2e.mjs` | `chromium.launch` |
| The principal list is declared in one place | `packages/database/src/prepare.mjs` | `const PRINCIPALS=` |
| Each principal needs its own password | `packages/database/src/prepare.mjs` | `each database principal needs its own` |
| Role attributes are read back, not assumed | `packages/database/src/prepare.mjs` | `assertRoleAttributes` |
| A principal may not be a member of another role | `packages/database/src/prepare.mjs` | `assertNoMembership` |
| A retired principal loses its credential | `packages/database/src/prepare.mjs` | `NOLOGIN PASSWORD NULL` |
| Each pool connects as the principal it claims | `apps/api/src/server.mjs` | `assertConnectedPrincipal` |
| Tenant tables carry FORCE row-level security | `packages/database/migrations/001_phase4_foundation.sql` | `FORCE ROW LEVEL SECURITY` |
| The tenant registry has row-level security of its own | `packages/database/migrations/008_tenants_rls_and_bootstrap.sql` | `tenants_self_only` |
| Definer functions run as a non-superuser owner | `packages/database/migrations/017_security_owner.sql` | `openppwr_security_owner` |
| Supplier isolation inside one tenant is tested | `scripts/security/supplier-isolation-matrix.mjs` | `SUPPLIER_ISOLATION_SAME_TENANT_PASS` |
| Bearer credentials expire | `packages/database/migrations/009_identity_token_expiry.sql` | `token_expires_at` |
| Credential rotation exists as a database operation | `packages/database/migrations/034_identity_credential_rotation.sql` | `rotate_openppwr_identity_credential` |
| Rotation runs on a principal that holds only that | `packages/database/migrations/035_rotation_principal.sql` | `openppwr_rotation` |
| Rotating another identity needs a named permission | `apps/api/src/permissions.mjs` | `credential:rotate` |
| The worker has a database identity of its own | `packages/database/migrations/022_worker_principal.sql` | `openppwr_worker` |
| Uploads are size-bounded by the parser | `apps/api/src/evidence-service.mjs` | `MAX_EVIDENCE_BYTES` |
| Type, extension and signature must agree | `apps/api/src/evidence-service.mjs` | `EVIDENCE_MIME_MISMATCH` |
| Double extensions are refused | `apps/api/src/evidence-service.mjs` | `EVIDENCE_DOUBLE_EXTENSION` |
| A malformed scanner response is an error, not a default | `apps/worker/src/index.mjs` | `MALWARE_SCANNER_MALFORMED_RESPONSE` |
| The item retry budget cannot be tuned away | `apps/worker/src/index.mjs` | `minimum: 3, maximum: 3` |
| Retention deletions are leased | `packages/database/migrations/015_retention_lease.sql` | `retention_lease_expires_at` |
| Retention deletions are fenced | `packages/database/migrations/019_retention_fencing.sql` | `retention_operation_id` |
| Published placeholders are refused as secrets | `packages/security/src/secret-strength.mjs` | `PUBLISHED_PLACEHOLDERS` |
| Logs are redacted on a single emission path | `packages/observability/src/index.mjs` | `[REDACTED]` |
| Production must not load demonstration credentials | `apps/api/src/app.mjs` | `forbiddenPrivilegedVariables` |
| A machine identity is given no demonstration password | `apps/api/test/login.integration.test.mjs` | `the machine identities are given no demonstration sign-in account` |
| A machine identity cannot sign in even where an account already exists | `packages/database/migrations/039_machine_identities_cannot_sign_in.sql` | `openppwr_machine_roles` |
| The accounts offered are the roles a person signs in as | `apps/api/src/app.mjs` | `DEMO_ROLE_ORDER` |
| Rate limiting is applied to authentication | `packages/security/src/rate-limit.mjs` | `rate_limit_buckets` |
| Response security headers are set | `packages/security/src/index.mjs` | `Content-Security-Policy` |
| Secrets are scanned before release | `scripts/validation/secret-scan.mjs` | `SECRET_SCAN_PASS` |
| Five pattern rules run over every tracked JavaScript file | `scripts/validation/sast-scan.mjs` | `SAST_FALLBACK_PASS` |
| Black-box probes run against a deployment | `scripts/validation/dast-scan.mjs` | `OPENPPWR_DAST_BASE_URL` |
| The container scan result is published | `docs/security/CONTAINER_SCAN_REPORT.md` | `No vulnerabilities found` |
| The worker separates liveness from readiness | `apps/worker/src/server.mjs` | `/health/ready` |
| Log retention is bounded by age and size | `scripts/validation/log-retention-gate.mjs` | `LOG_RETENTION` |
| The running build states which schema it carries | `apps/api/src/app.mjs` | `migrationLevelVerified` |
| A deployed version can be verified from outside | `scripts/validation/verify-deployed-version.mjs` | `migrationLevelVerified` |
| Route identifier validation is checked everywhere | `scripts/validation/route-validation-gate.mjs` | `ROUTE_VALIDATION_PROPERTY_PASS` |
| The release workflow signs the published digest | `.github/workflows/release-image.yml` | `cosign sign` |
| The release workflow attests an SBOM | `.github/workflows/release-image.yml` | `attest-sbom` |
| Supply-chain artifacts are checksummed | `.github/workflows/release-image.yml` | `SHA256SUMS` |
| The image is built for one platform | `.github/workflows/release-image.yml` | `platforms: linux/amd64` |
| The release workflow's own shape is validated | `scripts/validation/validate-release-workflow.mjs` | `RELEASE_WORKFLOW` |
| The licence is Apache-2.0 | `LICENSE` | `Apache License` |
| The notice points at third-party attributions | `NOTICE` | `THIRD_PARTY_NOTICES.md` |
| Contributions require sign-off | `CONTRIBUTING.md` | `Signed-off-by` |
| The certificate of origin is included in full | `DCO.md` | `Developer Certificate of Origin` |
| Trademark use is stated | `TRADEMARKS.md` | `OpenPPWR trademark policy` |
| Vulnerability reporting is stated | `SECURITY.md` | `Reporting a vulnerability` |
| The Community boundary is stated | `docs/architecture/OPEN_CORE_BOUNDARY.md` | `Community — Apache-2.0` |
<!-- /contract:enforcement -->

### Gates this contract depends on

<!-- contract:gates -->
| Gate | npm script |
|---|---|
| This contract against the code | `release:contract:gate` |
| Role and permission parity | `permissions:gate` |
| Installer documentation parity | `installer:docs:gate` |
| Route identifier validation | `routes:gate` |
| Log retention bounds | `logs:retention:gate` |
| Supplier isolation inside one tenant | `security:supplier-isolation` |
| Demonstration journey, end to end | `test:demo:full-e2e` |
| Synthetic dataset integrity | `acme:validate` |
| Secret scanning | `secret:scan` |
| Five pattern rules over JavaScript sources | `gate:sast` |
| Dependency advisories at high or above | `dependency:audit` |
| Release workflow and supply chain | `release:image:validate` |
| Everything above, in order | `full-gate` |
<!-- /contract:gates -->

Run `npm run full-gate` for what a workstation can check, and `npm run deployment-gate` against a running
deployment for what it cannot. A passing local gate is not a complete gate, and the local gate says so on
every run.
