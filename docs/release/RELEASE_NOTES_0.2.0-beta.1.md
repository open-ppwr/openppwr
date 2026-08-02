# Release notes — 0.2.0-beta.1

**This release has not been published.** It is a private candidate held for an owner decision that has
not been made. No tag exists, no image has been pushed to a registry, and no announcement has been
issued. The version below is what the candidate carries, not a record that it shipped.

| | |
|---|---|
| Version | `0.2.0-beta.1` |
| Licence | Apache-2.0 |
| Deployment | Self-hosted. Debian 13 x86_64 is the supported host; the candidate image is `linux/amd64` only |
| Schema | migration `004` to migration `038` |
| Release SHA | `8b329af4f026ea249d483c258bd367715a9da804` — frozen candidate revision, not a publication |
| Image digest | `sha256:ca012bf2f95ec4e16118e41dd3dc5de7aced2d53f7b2a6df17a632f349b37d21` — local build only, not pushed to any registry |
| Release date | NOT_VERIFIED — no date is set, because publication is not approved |

## Why this is a minor version rather than a patch

The schema moves from migration `004` to migration `038`. Those thirty-four migrations add tables,
columns, constraints, row-level-security policies and database roles. An older application meeting this
schema does not degrade gracefully; it meets a database it does not understand. That is the whole reason
the upgrade path below is worth reading before you take it.

## What changed

**Sign-in and sessions.** Interactive sign-in with an e-mail address and a password replaces a flow in
which the only credential was a bootstrap token, which left a new user with nowhere to go. Signing out
revokes the session on the server, so the credential is invalid immediately afterwards rather than merely
forgotten by the browser. Bootstrap-issued bearer credentials now carry an expiry; previously they were
valid for ever, and a static credential's own expiry was discarded rather than enforced.

**Separate database principals.** The request-serving role no longer holds the capabilities that let it
write credentials, provision identities or reset a tenant. Those live with separate principals reached
only through defined functions, and the worker was given a database identity of its own rather than
sharing the API's. The runtime role still cannot alter its own schema.

**Credential rotation.** One identity's bearer credential can be replaced without touching anything else.
Until now the only way to revoke a leaked credential was to destroy the tenant, because credentials are
stored as hashes and bootstrap refuses to run a second time — acceptable for fictional demonstration data
and for nothing else. An identity may replace its own; replacing another needs the tenant administrator's
permission. The replacement is returned once, every session derived from the old credential ends in the
same transaction, and the rotation is recorded in the audit chain. Rotation cannot change a role, a tenant
or a supplier scope.

It runs on a principal holding `EXECUTE` on that one function and nothing else. That is what makes it safe
for a production deployment to load, where the credential that issues sessions deliberately is not: issuing
a session is authority by itself, while rotation requires the caller to present a live credential first and
grants nothing beyond what that credential already authorises.

**Encrypted backups.** The backup set is encrypted to a public key, AES-256-GCM with RSA-4096 key
transport. The host keeps only the certificate; the private key is written wherever the operator says and
never under the deployment root, because `backups/` is what leaves the machine. Restore and rollback now
need that key — including at the worst possible moment, which is the real cost and is stated in the upgrade
notes rather than discovered. Backups taken before this release still restore with no key.

**Evidence retention.** A retention deletion now has an owner, a lease and a fencing token, so a worker
that has become slow rather than dead cannot keep acting on bytes a second worker has already claimed.
A recorded deletion has to leave a record, and a demonstration reset returns the storage keys it actually
deleted rather than a set assembled separately from the deletion.

**Audit chain.** There is one canonical way into the audit chain and it verifies the link before writing.
Immutability now covers `TRUNCATE`, which it previously did not. Chain verification is available through
`GET /v1/audit/verify` to the role that runs the review.

**Tenancy.** One tenant per deployment is enforced rather than documented: `/v1/bootstrap` refuses a
second tenant, and the worker refuses to start — and refuses to keep running, on a periodic recheck —
when the database holds more than one. The tenant registry gained row-level security of its own.

**Reporting what is running.** `GET /v1/version` reports version, revision, build timestamp, channel,
image digest and migration level, so a deployment can state which build it is instead of leaving the
question to container labels.

The migration level is now two numbers rather than one. Until this release the reported level came from a
build argument baked into the image, and nothing compared it to the schema — so the one number a reader
could use to tell which schema a deployment was on was the one number nothing verified. The route now also
reports `appliedMigrationLevel`, read from the database on each request, and `migrationLevelVerified`, which
is true only when both are known and equal. The API additionally refuses to start when the database is
*behind* the image; a database *ahead* of it is a warning, because that is what an upgrade window and a
deliberate rollback both look like from inside a container.

**Query deadlines are now something a deployment can set.** `OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS`,
`OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS` and `OPENPPWR_DB_CHECKOUT_TIMEOUT_MS` reach the API and worker
containers, which they previously did not. All three are absent by default and absent means unbounded, so
an existing deployment behaves exactly as before. **No default is shipped, deliberately:** the operations
needing the longest bound scale with tenant size, the dataset this software is tested against holds 32
packaging records, and a number extrapolated from that would look like a control and behave like an outage
on the first deployment larger than the fixture. `deploy/community/openppwr.env.example` states which two
figures to measure on your own deployment.

**Installer.** `upgrade` now refreshes `docker-compose.yml` from the new release tree instead of swapping
only the image reference, and generates the worker's database password when upgrading a deployment
configured before that principal existed. `backup` stops the two writers for the width of the snapshot so
the database dump and the evidence archive describe one moment, checks the dump's own exit status before
compressing it, and includes the bootstrap identities file so a genuine host loss does not make every
human credential permanently unrecoverable. `restore` re-injects the worker credential carried in the
backup, canonicalises its source directory before confining it, and refuses a source outside the
deployment's own backups directory.

**Fixes.** Dossier downloads work, and a refused download reports the refusal instead of doing nothing.
Demonstration reset succeeds on a tenant that had produced a gap; it previously deleted assessments
before the gaps referencing them. One failing evidence item can no longer consume the whole scan retry
budget.

## Rollback is restore-based, not image-only

Do not roll back by swapping the image. This release advances the schema across thirty-four migrations,
so the previous application will not run against the database this one leaves behind. Rolling back means
restoring the database from a backup taken **before** the upgrade, together with the matching evidence
volume and the environment file of that generation. That is what `openppwr-installer rollback` does, and
why it is restore-based.

Without a pre-upgrade backup there is no way back. `upgrade` takes one and records which directory it
took, so a later `rollback` restores that generation rather than whichever backup happens to sort last.

## Known limitations that matter to an operator

The complete list is `KNOWN_LIMITATIONS.md`. These are the ones that change a deployment decision:

- **No qualified lawyer has reviewed the privacy, cookie or company information**, and the site says so
  on every page carrying it. The owner accepted that position rather than delay the release; it is
  disclosed, not resolved, and an operator relying on that text should have it reviewed.
- **German regulatory wording carries one recorded reviewer — an Attentus internal preview — annotated
  *subject for individual reassessment, if required*.** That is not qualified regulatory review, and the
  German page says as much in German. Statements that would have described the state of the legislation
  rather than the state of this product were removed instead of published on that basis. English is the
  fallback where a translation is missing.
- Independent human security review is outstanding. Automated analysis was run as supplementary
  technical evidence and is not a substitute: a program is not a named person.
- The demonstration rule pack is deliberately small and is not authoritative regulatory content.
- One tenant per deployment. Multi-tenant orchestration is refused at startup, not merely unsupported.
- `linux/amd64` only. No `arm64`, no high availability, no zero-downtime claim.
- ClamAV is an external dependency. Signature freshness, sizing and availability are the operator's
  responsibility, and scanning fails closed — evidence cannot be reviewed until it has been scanned, so a
  clamd that is unavailable stops review rather than waving files through.
- The runtime image contains no C library at all. It was previously distroless Debian, which carried
  three unfixed Critical/High glibc findings; the base is now `distroless/static` with a musl-linked Node
  runtime, so those findings are gone by construction rather than argued away. Both scanners report zero
  at every severity.
- Bootstrap returns bearer credentials but there is no secret-manager bootstrap command. Capture them
  through your own approved process, then remove and rotate the bootstrap capability.
- Three packages ship in the source tree and are never reachable at runtime: `compliance-core`,
  `packaging-master` and `reconciliation`.
- Independent environment validation — the installer, backup, restore, upgrade and recovery rehearsals
  performed by someone other than their author, on a host they control — remains open.

## What is not claimed

No certification of any kind. No independent penetration test. No third-party audit. No uptime or
availability figure. No SLA, other than the security-disclosure handling described in `SECURITY.md`. No
guarantee of regulatory compliance: OpenPPWR supports a readiness process, and does not certify anyone.

## Upgrading

`UPGRADE_NOTES_0.2.0-beta.1.md` states what to do, in order, and what refuses to work if a step is
skipped. `docs/deployment/BACKUP_RESTORE_UPGRADE.md` covers backup, restore and recovery in general.
