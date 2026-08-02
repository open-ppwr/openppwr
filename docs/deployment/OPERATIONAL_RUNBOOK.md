# Operational runbook — health, diagnostics, incident response

Written from a real Debian 13 install/upgrade/rollback/backup/restore rehearsal (2026-07-31), not from
what the installer is documented to do. Every command below was actually run against a live deployment
during that rehearsal.

## Health and readiness

```sh
sudo openppwr-installer status    # container-level: docker compose ps
sudo openppwr-installer verify    # application-level: web/database/worker health
```

`verify` prints `VERIFY_PASS web=healthy database=ready worker=healthy` when all three hold. A partial
result (e.g. `worker=unhealthy`) means the container is up but its own readiness check is failing — go to
Diagnostics, not straight to a restart.

Per-container health, direct:

```sh
docker compose --env-file /opt/openppwr/secrets/openppwr.env -f /opt/openppwr/docker-compose.yml ps
```

A container can show `Up (healthy)` in `docker compose ps` while still logging errors — health checks
test liveness, not correctness. Cross-check container status against `verify`'s application-level answer,
not either alone.

## Diagnostics

```sh
docker compose --env-file /opt/openppwr/secrets/openppwr.env -f /opt/openppwr/docker-compose.yml logs <service> --tail 50
```

**Worker crash-looping (`Restarting (1)`).** Read the worker's own log first — it fails closed with a
specific PostgreSQL error rather than a generic crash. Two causes found in this rehearsal, both now fixed
upstream but worth checking after any upgrade that predates the fix:

- `permission denied for function openppwr_tenant_count` — the worker's own database principal lacks
  `EXECUTE` on its startup tenancy guard. Fixed in migration 029; confirm the deployment is at or beyond
  that migration level (`SELECT name FROM openppwr_schema_migrations ORDER BY name DESC LIMIT 1;`).
- Worker connects as `openppwr_app` instead of `openppwr_worker` — the deployed `docker-compose.yml` is
  stale relative to the running image (an upgrade before the fix in
  `docs/deployment/BACKUP_RESTORE_UPGRADE.md` never refreshed it). Confirm:
  `grep OPENPPWR_DATABASE_URL /opt/openppwr/docker-compose.yml` under the `worker:` service must reference
  `openppwr_worker`, not `openppwr_app`.

**`migrate` container exits 1 immediately.** Read its log — every required-secret check names the exact
variable it's missing, e.g. `OPENPPWR_WORKER_DATABASE_PASSWORD is required.` This happens when an env
file predates a migration that added a new required credential. A current installer's `upgrade` generates
missing required secrets automatically; if hand-editing the secrets file directly, use
`openssl rand -hex 32` for a same-shape value and never reuse a password across principals.

**Environment variable present in the secrets file but not reaching a container.** Confirm the *deployed*
`docker-compose.yml` (`/opt/openppwr/docker-compose.yml`), not the release tree's copy, actually declares
that variable under the relevant service's `environment:` block —
`grep -A15 '^  <service>:' /opt/openppwr/docker-compose.yml`. `install` copies this file once; nothing
except `upgrade` (as of the fix above) or a fresh `install --confirm-overwrite` ever refreshes it.

**Audit chain verification fails.** `curl -H "authorization: Bearer <token>" <base>/v1/audit/verify` — a
non-200 here is a data-integrity incident, not a transient fault. Do not attempt a manual database repair;
restore from the most recent verified backup and re-run `verify`.

## Incident response

**Suspected compromised bearer credential (tenant identity or supplier token).** Rotate it:

```
curl -X POST -H "authorization: Bearer <your token>" \
  <base>/v1/identities/<identity id>/rotate-credential
```

The response carries the replacement **once**, in the clear, together with its expiry and the number of
interactive sessions the rotation ended. Nothing can show it again: the store keeps a SHA-256 digest and
no more, which is also why nobody — not you, not the database owner — could have read the old one back to
reissue it. Capture the value before you close the terminal.

Who may run it: any identity may replace its own credential, because presenting it is proof of possession
and the holder already has everything the replacement grants. A **tenant administrator** may replace any
credential in the tenant, which is the account-recovery path when the holder cannot act. Anything else is
answered as a not-found, so a caller who may not act on an identity does not learn whether it exists.

What rotation does, and what it deliberately does not. The old credential stops authenticating
immediately, and every live session that identity holds is revoked in the same transaction — a session
carries its own token and its own expiry, so replacing the bearer token alone would leave an attacker
working for up to another twelve hours. Role, tenant and supplier scope are untouched: rotation is
recovery, never a way to acquire authority. The change is recorded in the audit chain as
`identity.credential.rotated`, attributed to the identity that performed it, with no credential material in
the payload.

If the compromised identity is the **only** tenant administrator and its credential is unusable (expired
rather than merely leaked), rotation cannot help — nothing in the tenant is entitled to act. Recover by
running `rotate_openppwr_identity_token` on the migration credential, which is a hand-repair path for an
operator with database access and is not reachable from any HTTP route.

`revoke_openppwr_identity_token` remains available for the case where a credential must simply stop working
and no replacement is wanted.

**Suspected compromised deployment-level secret** (database password, worker token, bootstrap token).
Rotating these requires a full `configure` cycle with fresh secrets and a restart — there is no in-place
credential swap. Take a `backup` first. Regenerating `OPENPPWR_BOOTSTRAP_TOKEN` is safe at any time (it is
single-use and only matters before the one tenant is bootstrapped). Regenerating database passwords
requires coordinating the change with PostgreSQL's own `ALTER ROLE ... PASSWORD` for each affected
principal in the same operation as updating the secrets file — mismatched credentials fail closed
(services refuse to start) rather than silently degrading.

**Worker unhealthy, API and web healthy.** Evidence uploads still accept, but nothing gets scanned and
retention sweeps stop. This degrades gracefully (evidence sits at `scan_status=pending` rather than being
falsely marked clean) but is not self-healing — diagnose per the Diagnostics section above rather than
waiting for it to recover on its own.

**Total container/volume loss.** Rehearsed 2026-07-31 at source `b50bfd0` — see
`docs/deployment/BACKUP_RESTORE_UPGRADE.md`'s "Immutable container/volume-loss recovery — PASS" section:
full teardown (`docker compose down -v` plus removing the deployment root entirely), fresh
`preflight`/`install`/`configure` against the same image digest, `restore` from an off-host backup copy,
data verified byte-for-byte identical (audit events, evidence rows and files, working worker
authentication). `backup` output is the only artifact that survives host loss; confirm backups are copied
off-host on whatever schedule the deployment's actual criticality warrants — this repository does not
prescribe one, since that is an operational decision for the deploying organization, not a product default.

Since 2026-08-01 that output is encrypted (`openppwr.pgdump.gz.enc`, `evidence.tar.gz.enc`,
`openppwr.env.enc`, `acme-bootstrap.json.enc`, plus `ENCRYPTION` and `SHA256SUMS`), which changes this
procedure in one way that matters: **the backup is no longer sufficient on its own.** Recovery needs the
backup *and* the private key from `backup-key init`, and that key is deliberately not stored under
`/opt/openppwr` — so it is not in the backup and it does not travel with the off-host copy. A recovery
rehearsal that does not include fetching the key from wherever it actually lives has not rehearsed
recovery. Re-rehearsed end to end on 2026-08-01, including adopting the surviving key on the rebuilt host
with `OPENPPWR_BACKUP_KEY_IN`; see the "Encrypted backup and recovery — PASS" section of
`docs/deployment/BACKUP_RESTORE_UPGRADE.md`.

## What "healthy" does not mean

`VERIFY_PASS` proves the deployment answers requests correctly against its own database. It does not
prove backups are being taken, that they are copied off-host, that TLS termination at the reverse proxy is
configured correctly (the product's own loopback binding assumes one), or that an operator other than the
one who installed it could operate it from documentation alone. Each of those is a separate, explicit
check — do not read `verify` as a substitute for any of them.
