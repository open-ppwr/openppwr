# Upgrade notes — 0.2.0-beta.1

For an operator moving an existing self-hosted deployment onto this candidate. Read
`RELEASE_NOTES_0.2.0-beta.1.md` first: the schema advances from migration `004` to migration `038`, and
rollback is restore-based rather than a swap back to the previous image.

The candidate is not published. Until an owner approves publication there is no registry reference to
upgrade to, and the image below is an exact locally built tag.

## Before you start

- Debian 13 x86_64 is the supported host. `preflight` refuses anything else (`20`), a host without Docker
  Compose v2 (`21`), less than 4 GB of RAM (`22`), less than 15 GB of free disk (`23`), and an occupied
  loopback port on a host with no configuration yet (`24`).
- You need a backup you have actually verified, and a copy of it somewhere the host cannot lose. Without
  a pre-upgrade backup this upgrade has no reverse.
- **New, and it blocks the upgrade if you skip it: backups are now encrypted, and `backup` refuses to run
  until this deployment has a backup key.** `upgrade` takes a backup before it changes anything, so it
  fails at that point with exit `83` on a deployment that has never run `backup-key init`. Do it first:

  ```sh
  sudo OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init
  ```

  Then move that private key off the host, into whatever secret store you already operate. It is the only
  thing that can read a backup, it is deliberately not stored under `/opt/openppwr`, and **`rollback` needs
  it back** — `rollback` restores the backup `upgrade` took, which is encrypted. Have the key retrievable
  before you start, not after the upgrade has gone wrong. See
  `docs/deployment/BACKUP_RESTORE_UPGRADE.md` for the full design and the refusal codes.
- Backups taken before this change are unaffected: `restore` still reads them, with no key.
- **Also new: one identity's credential can now be replaced without destroying the tenant.** Until this
  release, revoking a leaked bearer credential meant rebuilding the tenant — acceptable for fictional
  demonstration data and for nothing else. `POST /v1/identities/{id}/rotate-credential` returns a
  replacement once, ends every session derived from the old one, and records the rotation in the audit
  chain. An identity may replace its own credential; replacing somebody else's needs the tenant
  administrator's `credential:rotate`.

  It runs on a database principal that holds `EXECUTE` on that one function and nothing else — no table
  grant, no session issuance — which is why a production deployment can load it where it deliberately
  cannot load the credential that issues sessions. `configure` generates
  `OPENPPWR_ROTATION_DATABASE_PASSWORD` for you. **A deployment whose environment file predates this
  release has no such line, and the route answers `404` until it does** — the same 404 an unknown identity
  gets, so nothing about the deployment leaks, and nothing tells you the capability is simply absent. Run
  `configure` after the upgrade, or add the line by hand and restart, before you need it. A leaked
  credential is not the moment to discover that recovery was never wired up.
- Decide the exact image reference in advance. `latest`, a bare name with no tag, a malformed tag and a
  truncated `@sha256:` digest are all refused (`12`). A bare name is refused explicitly, because it
  resolves to `latest` by omission rather than by name.

## The order

1. **Download the release archive and its SHA-256 file separately, and verify before extracting.** Never
   pipe a network response into a shell.

   ```sh
   sha256sum -c openppwr-0.2.0-beta.1.tar.gz.sha256
   tar -xzf openppwr-0.2.0-beta.1.tar.gz
   cd openppwr-0.2.0-beta.1
   sudo ./scripts/installer/openppwr-installer verify-archive ../openppwr-0.2.0-beta.1.tar.gz APPROVED_SHA256
   ```

   A missing archive is `32`, a checksum argument that is not 64 characters is `33`, and a mismatch is
   `34`. A mismatch means stop, not retry.

2. **Record what you are upgrading from.** The current image reference and the migration level reported
   by `GET /v1/version` are your rollback target. Write them down outside the host.

3. **Take a backup and confirm it verified.**

   ```sh
   sudo openppwr-installer backup
   ```

   `BACKUP_PASS path=…` is the only acceptable outcome. The command stops the API and worker for the
   width of the snapshot so the database dump and the evidence archive describe one moment, and restarts
   them whether the dump succeeded or not. A failed dump or evidence archive is `82`, and the deployment
   is left running rather than stopped. Copy the resulting directory off the host: it carries the
   database dump, the evidence archive, the environment file, the bootstrap identities, an `ENCRYPTION`
   descriptor and `SHA256SUMS`. Every one of those members except the last two is encrypted, so the copy
   can travel without carrying the deployment's credentials in the clear. Encryption not configured is
   `83`, and encryption failing part-way is `84` — in which case the unencrypted intermediates are removed
   and the directory is not a usable backup.

4. **Run the upgrade from inside the new release tree.**

   ```sh
   sudo ./scripts/installer/openppwr-installer upgrade openppwr:0.2.0-beta.1-APPROVED_SHA
   ```

   `upgrade` takes its own backup first, records which directory it took so a later `rollback` restores
   that generation, saves the current environment file and compose file, refreshes `docker-compose.yml`
   from this release tree, applies migrations and brings the stack up. If the deployment predates the
   worker having its own database principal, `upgrade` generates the missing password rather than
   leaving you to hand-edit a root-only file mid-upgrade.

5. **Verify before returning the deployment to service.**

   ```sh
   sudo openppwr-installer verify
   ```

   `VERIFY_PASS web=healthy database=ready worker=healthy`. `upgrade` runs this itself and prints
   `UPGRADE_PASS image=… rollback=restore-based` only after it passes. A worker that is not running is
   `71`, and so is a worker that never becomes healthy within the wait.

6. **Confirm the running build is the one you deployed**, then check the data survived: catalogue counts,
   `GET /v1/audit/verify`, and one dossier download.

   ```sh
   OPENPPWR_VERIFY_BASE_URL=http://127.0.0.1:31114 \
   OPENPPWR_VERIFY_VERSION=0.2.0-beta.1 \
   OPENPPWR_VERIFY_REVISION=<full-sha> \
   node scripts/validation/verify-deployed-version.mjs
   ```

## What refuses to work if you skip a step

**`upgrade` run through the installed copy on `PATH` refuses, exit `45`.** It needs the *new* release's
`deploy/community/docker-compose.yml`, and the installed binary at `/usr/local/bin` has no release tree
around it. The check runs before the backup and before any environment change, so a refusal leaves the
deployment exactly as it was. Every other command — `configure`, `status`, `verify`, `credentials`,
`backup`, `restore`, `rollback`, `stop`, `uninstall` — may be run through `PATH`. `upgrade` and `install`
may not.

**`configure` refuses a changed demonstration credential after bootstrap has run, exit `43`.**
`bootstrap-acme` hashes `OPENPPWR_DEMO_PASSWORD` and `OPENPPWR_DEMO_EMAIL_DOMAIN` once, into the
demonstration accounts, and there is no re-bootstrap path that would re-hash them. Accepting a change
here would leave `/v1/demo/accounts` advertising a password `/v1/login` no longer accepts. A deployment
that took the defaults is treated as having them explicitly, so the refusal fires for exactly the
deployments most likely to trip over it. Changing either value requires a fresh bootstrap, which means a
new deployment — not a reconfigure.

**`configure` on an existing deployment refuses without `OPENPPWR_CONFIRM_RECONFIGURE=yes`, exit `41`.**
It also preserves, rather than regenerates, the migration credential, the worker credential, the host map
and the Compose project name. The Compose project name is never taken from the invoking environment on a
reconfigure: it names the containers, volumes and networks that already exist, and changing it would
stand up a second disconnected set beside the first.

**`restore` refuses a source outside the deployment's backups directory, exit `101`.** The path is
canonicalised first and used canonically for every read afterwards, so neither a `..` segment nor a
symlink placed below `backups` gets past it. To restore an off-host copy after a real host loss, copy it
*into* the new deployment's own `backups/` directory and restore from there — that is the procedure, not
a workaround. `restore` also refuses without `OPENPPWR_CONFIRM_RESTORE=yes` (`100`), verifies
`SHA256SUMS` before touching anything, and takes its own safety backup before it replaces the database.

**`rollback` refuses when there is no previous generation to return to, exit `90`,** and refuses when the
backup recorded for that generation no longer exists, exit `91`. A deployment upgraded before `upgrade`
began recording its compose file prints `ROLLBACK_WARN compose_restored=false` and continues; the compose
file already on disk may not match the environment being restored, so treat that warning as a reason to
check before admitting traffic.

**`credentials` refuses to print bearer credentials without `OPENPPWR_SHOW_CREDENTIALS=yes`, exit
`112`.** They grant full access to the tenant. A credential that has been seen by the wrong person is
replaced with `POST /v1/identities/{id}/rotate-credential`, not by rebuilding the tenant.

**`install` over an existing deployment refuses without `OPENPPWR_CONFIRM_OVERWRITE=yes`, exit `31`,** so
an accidental re-run cannot silently change a live topology.

## If it goes wrong

```sh
sudo openppwr-installer rollback
```

Restore-based, using the backup `upgrade` took and recorded. It puts back the compose file, the
environment file and the data of the pre-upgrade generation together, then verifies. Expect
`ROLLBACK_PASS backup=… policy=restore-based compose_restored=true`.

Do not attempt an application-only rollback across this upgrade. Thirty-four migrations added tables,
columns, constraints, policies and roles; the previous application does not understand the schema it
would find. `docs/deployment/BACKUP_RESTORE_UPGRADE.md` covers backup, restore and container/volume-loss
recovery in full.
