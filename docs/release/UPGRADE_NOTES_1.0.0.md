# Upgrade notes — 1.0.0

For an operator moving an existing self-hosted deployment onto this candidate. Read
`RELEASE_NOTES_1.0.0.md` first.

The candidate is not published. Until an owner approves publication there is no registry reference to
upgrade to, and the image below is an exact locally built tag.

## The short version

**The schema moves by one migration.** `038` before, `039` after. An earlier draft of this page said the
schema did not move; that was true when it was written and stopped being true, so it is corrected here
rather than quietly left.

`039` removes the demonstration sign-in accounts that older builds created for the `worker` and
`service_account` identities and makes sign-in refuse those roles in the database. It defines no table,
column, constraint, index or policy, so there is no rewrite, no index build and no long lock to wait on:
it deletes at most two rows per tenant and replaces two functions. On a deployment that has never set
`OPENPPWR_DEMO_LOGIN=true` it deletes nothing at all. See "What changes underneath you".

That does not make the upgrade a no-op, and it does not make the way back an image swap. Read "What changes
underneath you" below — several fixes alter behaviour a deployment may have been working around — and read
"Rollback" **before** you need it, because the way back is `openppwr-installer rollback` and it needs a
backup key you have to already hold.

## Before you start

- Debian 13 x86_64 is the supported host. `preflight` refuses anything else.
- **The backup is the way back.** One small migration makes this look like the upgrade whose backup you can
  skip. It is not, and the reason has nothing to do with how large the migration is: rollback is
  restore-based here exactly as everywhere else, so the backup is not insurance against a migration, it is
  the mechanism. `upgrade` takes one before it changes anything and records which directory it took.
- Backups are encrypted and `backup` refuses to run until the deployment has a backup key, so `upgrade`
  fails at that point on a deployment that has never run `backup-key init`:

  ```sh
  sudo OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init
  ```

  Then move that private key off the host. It is the only thing that can read a backup, and `rollback`
  needs it back.
- **Migration `039` refuses a migration credential that cannot see every tenant's rows.** It aborts unless
  `current_user` holds `SUPERUSER` or `BYPASSRLS`. Nothing to do if you run the shipped Compose stack,
  which migrates as `openppwr_migrator` — the PostgreSQL image creates it as the cluster superuser. It
  matters if you point `OPENPPWR_MIGRATION_DATABASE_URL` at a role you provisioned yourself: a role holding
  `CREATEROLE` and `CREATEDB` and neither of those two attributes satisfied every requirement this project
  documented before 2026-08-02, and stops the upgrade at `039` with a named refusal. The refusal is the
  right outcome rather than a defect to work around — `demo_users` carries `FORCE ROW LEVEL SECURITY` under
  a policy keyed on a setting no migration has, so without the ability to bypass it the deletion below
  would match no row, the assertion checking the deletion would also match no row, and the migration would
  report success having repaired nothing on precisely the deployments it exists to repair. Section 0 of
  `packages/database/migrations/039_machine_identities_cannot_sign_in.sql` states this in full.

## Run it from the release tree

```sh
cd openppwr-1.0.0
sudo ./scripts/installer/openppwr-installer upgrade <image reference>
```

`upgrade` must be run from the new release's own extracted tree, not through the copy on `PATH`. It refuses
the `PATH` form (exit `45`) because it needs that release's Compose file, and the `PATH` copy resolves its
source root somewhere else entirely. Every other subcommand works either way.

## What changes underneath you

**Your own domain starts working, and may change what you had to configure.** If you set
`OPENPPWR_CORS_ALLOWED_ORIGINS` to work around browser requests being refused, you can now remove it: the
web tier reports the real protocol, so your deployment is same-origin with itself. Leaving it set is
harmless and still supported — it simply pins the answer rather than deriving it.

**The API now answers readiness separately from liveness.** If your load balancer or orchestrator probes
`/health`, check `RELEASE_NOTES_1.0.0.md` and the 1.0 contract for the exact semantics this release ships,
because a probe that was previously always-healthy may now reflect the database.

**Four database principals are back-filled if your deployment predates them.** A deployment configured
before migration 014 that carries `OPENPPWR_DEMO_LOGIN=true` gains the sign-in credential it never had, and
demonstration sign-in starts working. This only completes a profile you already declared: a deployment
without that flag gains nothing, so an upgrade can never hand a production deployment the session-issuing
credential it is forbidden to hold.

**The API refuses to start on a contradiction it previously served.** If `OPENPPWR_DEMO_LOGIN=true` is set
and no sign-in credential is available, the container now stops with a message naming the variable that
repairs it, instead of starting and answering `404` to every sign-in. If your deployment is in that state,
the back-fill above resolves it during the same upgrade.

**Two demonstration sign-in accounts are deleted, and cannot be recreated by an older build.** If your
deployment carries `OPENPPWR_DEMO_LOGIN=true` and was bootstrapped by any earlier build, it holds password
accounts for the `worker` and `service_account` identities — `worker@<your demo domain>` and
`service-account@<your demo domain>` — with the published demonstration password. Nothing offered them, so
nothing in your interface will change; if you scripted a sign-in against either address, it stops working
and there is no supported replacement, because neither is a person. Migration `039` deletes the rows and
makes sign-in refuse those two roles in the database, so the accounts do not come back if a machine is
briefly run on an older image or a pre-upgrade database is restored. The **bearer** credentials issued to
those identities at bootstrap are untouched: the worker uses one to do its job, and nothing here revokes
it.

**`upgrade` now refreshes the installer copy on `PATH`.** If day-2 commands have been failing with
`command not found`, or silently running an older implementation than the deployment they manage, this is
why and it is fixed.

**Existing demonstration tenants are not re-seeded.** The seeding runs in `bootstrap-acme`, which cannot
run twice on a deployment. An existing demonstration keeps whatever state it has; only a fresh deployment
gets the seeded one.

## Rollback

**Do not roll back by pointing `OPENPPWR_IMAGE` at the old image.** On this upgrade that does not return
the deployment to the previous release — it takes the deployment down. Two independent reasons, either one
sufficient on its own.

*The Compose file is not yours after an upgrade; it is the release's.* `upgrade` installs the new release
tree's Compose file over the deployment's (`scripts/installer/openppwr-installer:1241`), deliberately,
because every health check, dependency condition and credential wiring in that file belongs to the release
being installed. The refreshed file health-checks `api` and `worker` on `/health/ready`
(`deploy/community/docker-compose.yml:288` and `:332`) — a route this release adds. No `0.2.0-beta.1` build
serves it: those trees register `/health` and nothing else, so the probe gets `404`, exits `1`, and the
container stays unhealthy indefinitely — `restart: unless-stopped` does not restart a container for being
unhealthy, so nothing recovers on its own. `web` and `worker` each wait on `api: {condition:
service_healthy}` (`:317` and `:359`), so neither ever starts. Changing the image reference does not put
the old Compose file back; only `rollback` does that.

*And `0.2.0-beta.1` is not one artifact.* It is a version string that covered a range of builds. Every
image recorded under it in this project's internal source-deployment provenance record is at migration level
`006`, 33 levels behind `039`. The one migration this release runs is therefore not what makes an image swap
unsafe, and removing it would not make one safe: whatever `0.2.0-beta.1` image a host actually has is an
application that would meet a schema thirty-three levels ahead of the one it knows.

**`openppwr-installer rollback` is the only supported way back**, on this release as on every other. It
restores the Compose file, the environment file, the database and the evidence volume of the generation the
last `upgrade` replaced — together, because those four are one generation and mixing them is its own
failure. It needs:

- the state `upgrade` recorded: `previous.env`, `previous-compose.yml` and the backup directory it took. A
  deployment last upgraded by an installer predating those records still rolls back, but says so
  (`ROLLBACK_WARN compose_restored=false`) rather than degrading silently;
- `OPENPPWR_BACKUP_PRIVATE_KEY`. Backups are encrypted, and without the key `rollback` fails with exit `92`
  *before* it swaps the Compose file, having changed nothing.

This is why `upgrade` prints `rollback=restore-based` when it finishes. The procedure, its requirements and
its exit codes are exactly what they were before this release; migration `039` does not add a step, and
there is no down-migration to run because this project has never had one.

One consequence of that is worth stating rather than leaving for you to discover. `rollback` restores the
database as it was *before* the upgrade, so on a demonstration deployment it brings the two machine sign-in
accounts back, with the published password, alongside an application that no longer refuses them. That is
inherent to restoring a backup taken before a security fix — it is not specific to this one — but it means
a rolled-back demonstration is a deployment with a known unannounced credential again. If you roll back and
intend to stay there, either set `OPENPPWR_DEMO_LOGIN=false`, which ends every demonstration session and
refuses every demonstration sign-in immediately, or delete the two rows by hand.

Deleting them by hand needs a credential this page used to leave unnamed, and none of the deployment's own
principals will do. `demo_users` carries `FORCE ROW LEVEL SECURITY` under a tenant-keyed policy, and after
migration `014` the application role `openppwr_app` holds only `SELECT` on it, `openppwr_auth` lost even
that at `016`, and `openppwr_security_owner` holds `SELECT, INSERT`. No runtime principal holds `DELETE` at
all. The statement therefore runs on the migration credential, which in the shipped stack is
`openppwr_migrator` — the cluster superuser the PostgreSQL image creates — and which bypasses the policy as
well as holding the privilege. Run it from the deployment root:

```sh
cd /opt/openppwr
sudo docker compose --env-file secrets/openppwr.env -f docker-compose.yml exec -T postgres \
  psql -U openppwr_migrator -d openppwr -v ON_ERROR_STOP=1 -c \
  "DELETE FROM demo_users u USING identities i WHERE i.tenant_id = u.tenant_id AND i.id = u.identity_id AND i.role IN ('worker', 'service_account');"
```

`psql` prints the row count it deleted. `DELETE 0` on a deployment you know was bootstrapped with
demonstration sign-in on means the statement ran under a credential the policy applied to and matched
nothing, not that there was nothing to delete — the same silent no-op migration `039` guards against — so
check which role you connected as before concluding the deployment is clean.

## After the upgrade

```sh
sudo openppwr-installer verify
curl -s http://127.0.0.1:<port>/v1/version
```

`verify` must report web, database and worker healthy. `/v1/version` must report the revision you installed
and `migrationLevelVerified: true`. A deployment reporting a migration level it cannot verify is one to
investigate before putting traffic on it.
