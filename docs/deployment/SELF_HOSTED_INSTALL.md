# Self-hosted installation

Status: release-candidate procedure. WSL image build, vulnerability/configuration scans and dual SBOMs pass. Clean-host installation, versioned upgrade and restore-based rollback have each passed against a real Debian 13 host with the [clean-server installer](CLEAN_SERVER_INSTALLER.md) — see [backup, restore and upgrade](BACKUP_RESTORE_UPGRADE.md) for what was verified and when. Image is not published. The supported Community path is the clean-server installer and dedicated Compose stack in `deploy/community/docker-compose.yml`; the manual `docker run` sequence below is a lower-level reference, not the supported path.

## Installation contract

- Scope: one self-hosted Community instance, PostgreSQL, shared private evidence volume, API process, tenant-scoped scan worker, private ClamAV and HTTPS reverse proxy.
- Acceptance: migrations use a privileged migration identity; API/worker use non-superuser runtime identity; `/health` passes; ACME E2E passes; evidence stays private and scanner failures stay closed.
- Forbidden: HTTP exposure of authentication/evidence routes, credentials in Git/Compose, `latest`, manual schema/data changes, customer fixtures, public clamd port or production changes without release approval.
- Validation: run commands below, `npm run test:e2e`, `npm run release:clamav:validate`, backup/restore checks and public-export/full gates.
- Rollback: retain previous immutable image digest and validated matching database/evidence snapshot; no destructive down-migration.
- Impact: tenant RLS, verified bearer identities and audit history remain mandatory. Community rules and ACME data are non-authoritative fiction; EN fallback remains required.

Prerequisites are PostgreSQL 18 with separate migration and runtime credentials, private persistent evidence storage, HTTPS reverse proxy, and a fail-closed ClamAV-compatible scanner. Run migrations with `OPENPPWR_MIGRATION_DATABASE_URL`; run the application with the non-superuser `openppwr_app` connection in `OPENPPWR_DATABASE_URL`. Provision the runtime role password through a DBA-controlled secret mechanism; never place it in Compose or Git.

This page said "PostgreSQL 16+" until 2026-08-02, and nothing had ever run this software on 16 or 17. Every verification runs 18: the Compose stack pins `postgres:18.4-alpine` by digest, and the test harness starts an embedded 18.4 cluster. A minimum-version check in `packages/database/src/migrate.mjs` was the obvious alternative and was rejected, because it would have made "16+" an enforced promise on the strength of no measurement at all — a refusal at 15 implies an assurance at 16, and there is none to give. Pinning the check to 18 exactly was rejected for the mirror-image reason: it would refuse deployments nobody has shown to be broken. So the version is stated as the one that is verified, and it is not enforced. An incompatibility with another major version surfaces at migration time, which the release contract records under [promises without enforcement](../release/COMMUNITY_1_0_RELEASE_CONTRACT.md#promises-without-enforcement).

The API image listens on port 3000 and writes evidence/dossier files below `/var/lib/openppwr`. The web process listens internally on 8080 and proxies `/v1` to the API; only web is loopback-published by Compose. Supply `OPENPPWR_BOOTSTRAP_TOKEN` from a secret manager, complete bootstrap once, then rotate or remove the bootstrap capability according to the production runbook. Do not expose login or evidence routes over HTTP.

The current image target is `linux/amd64` only. `arm64` is not claimed until tested.

## Container registries

**No image has been published yet.** Nothing is pullable from either registry named below, and every
`docker pull` in this section will fail until an owner-approved release run publishes the candidate. This
section states the registry contract that publication will follow, not a service you can use today. Until
then, build locally from an exact approved revision as shown under [candidate commands](#candidate-commands).

GitHub Container Registry is the canonical registry for OpenPPWR Community:

```text
ghcr.io/open-ppwr/openppwr
```

Docker Hub is a convenience mirror of the same versioned image:

```text
docker.io/openppwr/openppwr
```

The image will be built once, by the release workflow, and published to GHCR. Docker Hub will receive a
copy of that same manifest, referenced by digest, and the workflow fails the release if the two digests or
the two platform sets differ. The mirror is therefore the same bytes, not a second build, and it can be
withdrawn without affecting GHCR.

**GHCR is the canonical registry for signatures, attestations and provenance. Docker Hub is a
convenience mirror of the same versioned image digest.** Verify signatures and attestations against
GHCR; do not infer them from the presence of a Docker Hub tag.

The digest is the integrity claim, not the tag. Pin deployments to `@sha256:…` and treat a version tag
as a label that helps humans find the right digest. Once publication has happened, the pull is:

```bash
# GHCR is canonical. Read the digest from the release, or from the registry itself:
#   docker buildx imagetools inspect ghcr.io/open-ppwr/openppwr:1.0.0
docker pull ghcr.io/open-ppwr/openppwr@sha256:<digest>
```

A Docker Hub mirror carries the identical digest **when it is present**. It is a copy of the manifest GHCR
already holds, never an independent build, so a digest that differs is a reason to stop rather than a
variant to choose between. Check before relying on it: an absent mirror and a private one answer a stranger
identically, so a failed pull tells you nothing about which it is.

No moving tag is published for a pre-release. `latest` is not published at all until a stable release
policy is agreed, and it is never a proof of integrity.

## Candidate commands

Before publication, build locally from exact approved clean SHA. After publication, pull exact approved digest instead. Never substitute `latest`.

No image has been published to any registry, so building locally is currently the only way to obtain one.
The supported host is Debian 13 x86_64, so the shell form is the one most readers need; the PowerShell form
is kept for anyone building on a Windows workstation.

```sh
OPENPPWR_IMAGE=openppwr:1.0.0-$(git rev-parse --short HEAD)
docker build --pull \
  --build-arg OPENPPWR_VERSION=1.0.0 \
  --build-arg OPENPPWR_REVISION="$(git rev-parse HEAD)" \
  --tag "$OPENPPWR_IMAGE" .
docker network create openppwr-private
docker volume create openppwr-evidence
```

Tagged with the revision it was built from, rather than with a registry path that does not resolve. That
tag is what `openppwr-installer configure` expects: an exact, immutable, locally loaded reference. Passing
a `ghcr.io/...` tag for an image that exists only on this host works, but names something the host cannot
pull if the local copy is ever removed.

```powershell
$env:OPENPPWR_IMAGE = "openppwr:1.0.0-$(git rev-parse --short HEAD)"
docker build --pull --build-arg OPENPPWR_VERSION=1.0.0 --build-arg "OPENPPWR_REVISION=$(git rev-parse HEAD)" --tag $env:OPENPPWR_IMAGE .
docker network create openppwr-private
docker volume create openppwr-evidence
```

Provision PostgreSQL 18 through DBA-controlled automation. `OPENPPWR_MIGRATION_DATABASE_URL` must identify a migration role able to create schema/roles **and able to see every tenant's rows** — `SUPERUSER` or `BYPASSRLS`; `OPENPPWR_DATABASE_URL` must identify `openppwr_app` with `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT` and `NOBYPASSRLS`. Keep both values in container-runtime secret mechanism.

The row-level-security requirement on the migration credential is newer than the rest of this paragraph and is not optional. Migration `packages/database/migrations/039_machine_identities_cannot_sign_in.sql` deletes rows from `demo_users`, which carries `FORCE ROW LEVEL SECURITY` under a policy keyed on `openppwr.tenant_id` — a setting a migration does not have. A credential that can neither bypass that policy nor act as a superuser would match no row on the `DELETE` and no row on the assertion that checks the deletion, and would report success having repaired nothing, on exactly the deployments the migration exists to repair. Section 0 of that migration therefore checks `rolsuper OR rolbypassrls` for `current_user` before anything else happens and aborts with a named refusal otherwise. Both shipped paths already satisfy it — the Compose stack migrates as `openppwr_migrator`, which the PostgreSQL image creates as the cluster superuser, and the test harness migrates as `postgres` — so this constrains only an installation that supplies its own migration role. A role holding `CREATEROLE` and `CREATEDB` and neither `SUPERUSER` nor `BYPASSRLS` satisfies the sentence as it was written before 2026-08-02 and aborts the upgrade.

```powershell
docker run --rm --network openppwr-private --env OPENPPWR_MIGRATION_DATABASE_URL $env:OPENPPWR_IMAGE packages/database/src/migrate.mjs
docker run --detach --name openppwr-api --network openppwr-private --publish 127.0.0.1:3000:3000 --env OPENPPWR_DATABASE_URL --env OPENPPWR_BOOTSTRAP_TOKEN --volume openppwr-evidence:/var/lib/openppwr $env:OPENPPWR_IMAGE
docker inspect --format '{{json .State.Health}}' openppwr-api
```

Terminate TLS at approved reverse proxy and expose only HTTPS. Capture the returned bearer credentials
directly into a secret manager, then remove or rotate the bootstrap capability.

### Creating your tenant

An earlier revision of this page said there was no dedicated bootstrap CLI. There is, and there was one
when that sentence was written -- it only knew how to create the fictional demonstration company, which is
why nothing here pointed at it:

```sh
sudo openppwr-installer bootstrap <slug> '<organization name>'
```

This creates the deployment's one tenant, installs the worker's bearer token into the environment file, and
marks the evidence volume. Do all three or the deployment is quietly broken -- the worker cannot
authenticate without the token, and without the volume marker its retention sweep refuses to treat a
missing file as a deleted one. Calling `POST /v1/bootstrap` by hand does the first and neither of the
others.

**Bootstrap happens once per deployment and cannot be repeated.** Once a tenant exists the API answers
`409` for the life of that database, so a wrong slug or the wrong command means destroying the deployment
and starting again.

`bootstrap-acme` is the other form. It creates the fictional `acme-eu-demo` tenant, loads a synthetic
catalogue, and -- the part that matters beyond the sample data -- writes a fiction marker into the tenant
row, so **every dossier that deployment ever produces states that its contents are fictional**. That is
correct for a demonstration and useless for a real filing. Use `bootstrap` for an organization's own
deployment and `bootstrap-acme` only for one you are evaluating with.

## Evidence scan worker

This deployment serves exactly one tenant, so run the worker against a database holding exactly one tenant. The worker counts tenants at startup and rechecks periodically while running, and refuses to start — or to keep working — when it finds more than one, because it would otherwise process only its own tenant's jobs and leave every other tenant's evidence pending for ever. `OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE=true` opts out for test environments only; it is not a supported production topology. The worker reauthenticates its tenant-scoped `worker` identity from a bearer token stored outside Git on every poll, so revocation takes effect without a restart; it does not trust tenant, actor or role headers. It polls PostgreSQL `scan_jobs` using transactions and `FOR UPDATE SKIP LOCKED`. A crash during scanning rolls back the running claim, while scanner failures persist retry state and eventually become `dead` jobs.

Required worker configuration:

```text
OPENPPWR_DATABASE_URL                 non-superuser runtime PostgreSQL URL
OPENPPWR_WORKER_TOKEN                 bearer token for a verified worker identity
OPENPPWR_EVIDENCE_STORAGE_ROOT        same private evidence volume used by the API
OPENPPWR_CLAMAV_HOST                  private clamd host
```

Optional bounded settings:

```text
OPENPPWR_CLAMAV_PORT                  default 3310
OPENPPWR_CLAMAV_TIMEOUT_MS            default 10000; 10..30000
OPENPPWR_SCANNER_MAX_BYTES            default/max 10485760
OPENPPWR_WORKER_POLL_INTERVAL_MS      default 1000; 10..60000
OPENPPWR_WORKER_MAX_ATTEMPTS          fixed at 3 for beta rollback compatibility; per evidence item
OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS  default 12; 1..100; separate budget, spent on scanner
                                      outages rather than on the evidence item
OPENPPWR_WORKER_RETRY_DELAY_MS        default 60000; max 86400000
OPENPPWR_WORKER_MAX_RETRY_DELAY_MS    default 900000; 1000..86400000; ceiling on exponential backoff
OPENPPWR_WORKER_JOB_LEASE_MS          default 300000; 10000..3600000; how long a claimed job may stay
                                      running before another worker may reclaim it
OPENPPWR_WORKER_HEALTH_STALE_MS       default 300000; 1000..3600000; poll staleness before health
                                      reports the loop as stopped
OPENPPWR_EVIDENCE_RETENTION_DAYS      default 30; 1..3650
OPENPPWR_WORKER_RETENTION_SWEEP_MS    default 3600000; 60000..86400000; retention sweep interval
OPENPPWR_WORKER_TENANCY_RECHECK_MS    default 60000; 1000..3600000; tenancy invariant recheck interval
OPENPPWR_WORKER_HEALTH_HOST            default OPENPPWR_HOST or 0.0.0.0
OPENPPWR_WORKER_HEALTH_PORT            default OPENPPWR_PORT or 3000
```

**Evidence retention deletes data.** The worker periodically deletes evidence that was never accepted —
infected, errored and timed-out uploads — once it is older than `OPENPPWR_EVIDENCE_RETENTION_DAYS`,
which defaults to **30 days**. Accepted evidence is not touched. Operators who must keep failed uploads
for longer than 30 days have to raise this value before the first sweep removes them; the setting is
bounded at both ends, so retention can be lengthened but never disabled.

Start clamd on `openppwr-private` using independently reviewed official digest; never publish port 3310. Then start worker with verified tenant-scoped token:

```powershell
docker run --detach --name openppwr-worker --network openppwr-private --env OPENPPWR_DATABASE_URL --env OPENPPWR_WORKER_TOKEN --env OPENPPWR_CLAMAV_HOST=clamav --env OPENPPWR_EVIDENCE_STORAGE_ROOT=/var/lib/openppwr/evidence --volume openppwr-evidence:/var/lib/openppwr $env:OPENPPWR_IMAGE apps/worker/src/server.mjs
docker inspect --format '{{json .State.Health}}' openppwr-worker
```

Source installations may start with `npm run start --workspace=@openppwr/worker`. Clamd communication uses INSTREAM protocol over private network. Clean and infected responses complete jobs; integrity mismatch, timeout, unavailable, oversized and malformed responses fail closed. Evidence content, filenames and scanner signatures are not logged. Worker exposes `/health`, `/health/live` and `/health/ready` on the configured health port; `/health` is the target the shared image health check uses, so it remains valid when the command is overridden. `/health/live` answers only whether the process is up, `/health/ready` whether it has authenticated and its poll loop is current, and `/health` reports operational detail including a degraded state. `SIGINT` and `SIGTERM` stop polling, close health listener and close database pool after current bounded scan finishes.

No schema migration is needed for this worker. Deploy it as a separate process sharing the private evidence volume. Rollback by stopping it and restoring the previous worker executable/image; pending and failed jobs remain durable in PostgreSQL. When using the shared API image, override its command with `apps/worker/src/server.mjs`; the shared `/health` check works for both API and worker roles. Dead jobs are requeued only through authenticated tenant-admin route `POST /v1/scan-jobs/{jobId}/requeue`, which resets attempts and writes an audit event. Manual database requeue is prohibited.

## Scheduled audit verification

The audit record is a hash chain: every event carries the hash of the one before it, so altering or removing
an event breaks the linkage and `GET /v1/audit/verify` recomputes the whole chain and says so. The route is
**on demand**. Nothing in a Community deployment runs it, which means tampering is detectable but not
detected — it waits until somebody asks. Continuous verification with alerting is not part of Community and
this document does not pretend otherwise.

What Community gives you instead is a check you can schedule yourself:

```sh
OPENPPWR_AUDIT_TOKEN=<bearer token> \
  sh scripts/validation/verify-audit-chain.sh --base-url=https://openppwr.example.org
```

It needs `curl` and a POSIX shell — the same tools the installer's preflight already requires — and no `jq`,
Node or Python. It prints one line of JSON and exits with a code your own alerting can act on:

| Exit | Meaning |
|---|---|
| `0` | the chain verified over the reported number of events |
| `1` | **verification failed** — the recorded history no longer hashes to itself; the offending event id is in the output |
| `2` | the command was called wrongly, usually a missing token |
| `3` | the deployment could not be reached, or answered something the check could not read |
| `4` | the credential was refused, or its role may not verify |

Alert on **any** non-zero code, not only on `1`. A `3` or a `4` means the check did not establish that the
record is intact, which is a different statement from "the record is broken" and must not be mistaken for
success. An expired token that silently stops the check is exactly how a monitored deployment becomes an
unmonitored one.

The token must belong to a role permitted to verify — `compliance_manager` or `read_only_auditor`. A role
without that permission is answered `404` rather than `403`, because the product hides existence rather than
confirming it, so the check reports `404` and `401` alike as a credential problem.

A daily cron entry, writing the last result where a monitoring agent can read it:

```cron
17 3 * * * OPENPPWR_AUDIT_TOKEN=... /bin/sh /opt/openppwr-release/scripts/validation/verify-audit-chain.sh \
  --base-url=http://127.0.0.1:8080 --output=/var/lib/openppwr/audit-verify.json >/dev/null || \
  logger -p daemon.err -t openppwr "audit chain verification failed"
```

`--output` writes the same JSON to a file, replacing it atomically, so a monitoring agent never reads a
half-written result. The file is created under a restrictive umask: it records what was verified and when,
which is not something to leave world-readable.

**What this does not do.** It runs when your scheduler runs it, so the window between a tampering event and
its detection is however long you set that interval to be. It proves the chain the deployment reports on;
it does not independently hold a copy, so an attacker who can rewrite the database *and* the application can
still answer whatever they like. Detecting that needs an off-host copy of the chain head compared over time,
which Community does not ship.

## Known limitations

- **Individual credential rotation needs its own database principal.** `POST
  /v1/identities/{id}/rotate-credential` replaces one identity's bearer token, returns the replacement
  once, ends that identity's sessions and records the change in the audit chain — resetting the tenant is
  not the recovery path and never needs to be. The route runs on `openppwr_rotation`, so it exists only
  where `OPENPPWR_ROTATION_DATABASE_PASSWORD` is set; leave it unset and the route answers `404` and the
  only remaining path is the migration credential on the host. See the incident-response section of
  `OPERATIONAL_RUNBOOK.md`.
- **`arm64` is untested and unsupported.** The build target is `linux/amd64` only; no `arm64` image has
  been built or validated.
- **Upgrading across a version gap that introduces a new required secret or compose service** is now
  handled automatically by the clean-server installer's `upgrade` command (it generates missing required
  secrets and refreshes the deployed Compose file from the release tree), but the manual `docker run`
  sequence in this document has no equivalent — an operator following the manual path across such a gap
  must diff the release's Compose file and secret requirements by hand.
- **Immutable container recovery** — redeploying entirely from a backup after total container and volume
  loss, with no prior containers to roll back to or restore over — has been rehearsed end-to-end and
  passed; see [backup, restore and upgrade](BACKUP_RESTORE_UPGRADE.md). Independent repetition by someone
  other than the author, on a host they control, remains open.
