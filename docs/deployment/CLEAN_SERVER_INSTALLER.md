# Clean-server installer

Status: release candidate. The supported host is Debian 13 x86_64. A disposable clean-host run, executed by someone who did not author the installer, is still required before release readiness may be claimed.

## Task contract

- Scope: install one isolated OpenPPWR Community stack with PostgreSQL, API, web, worker and ClamAV from an exact release image.
- Acceptance: preflight passes; secrets are root-only; migrations, health, synthetic ACME bootstrap, full E2E, backup/restore and versioned restore-based rollback pass.
- Forbidden: `latest`, `curl | sh`, customer data, manual database edits, public database/API/clamd ports, unrelated firewall changes, secret output, destructive uninstall by default.
- Tests and negative tests: reject unsupported OS/architecture, insufficient resources, occupied loopback port, missing Compose, weak/missing image reference, `latest`, bad archive checksum, overwrite/reconfigure without confirmation and restore outside the deployment backup directory.
- Validation: `sh -n scripts/installer/openppwr-installer`, `npm run installer:validate`, `openppwr-installer preflight`, `start`, `bootstrap-acme`, `verify`, `backup`, controlled `upgrade`, `rollback`, full ACME E2E and source/public-export gates.
- Migration/deployment/rollback: migrations run as `openppwr_migrator`; runtime uses `openppwr_app` with `FORCE RLS`; upgrades take a backup; rollback restores the matching database/evidence snapshot and immutable prior image. Down-migrations are not claimed.
- Impact: credentials never leave root-only files; only web binds to loopback; tenant identity comes from bearer authentication; audit history and evidence are backed up together; ACME data is fictional; EN fallback and the DE human-review warning remain.

## Safe artifact acquisition

Download the release archive and its SHA-256 file separately. Inspect the command before execution. Never pipe a network response into a shell.

```sh
sha256sum -c openppwr-1.0.0.tar.gz.sha256
tar -xzf openppwr-1.0.0.tar.gz
cd openppwr-1.0.0
sudo ./scripts/installer/openppwr-installer verify-archive ../openppwr-1.0.0.tar.gz APPROVED_SHA256
sudo ./scripts/installer/openppwr-installer preflight
sudo ./scripts/installer/openppwr-installer install
sudo ./scripts/installer/openppwr-installer configure ghcr.io/open-ppwr/openppwr:1.0.0
sudo ./scripts/installer/openppwr-installer start
sudo ./scripts/installer/openppwr-installer bootstrap-acme
sudo ./scripts/installer/openppwr-installer verify
```

**Choose which of the two bootstrap commands you want before you run either**, because bootstrap is a
one-time, whole-deployment operation: once a tenant exists the API refuses a second one for the life of
that database, and changing your mind afterwards means destroying it and starting again.

| | `bootstrap SLUG NAME` | `bootstrap-acme` |
|---|---|---|
| Tenant | the one you name | `acme-eu-demo`, fictional |
| Catalogue | empty; you import your own | 28 records of synthetic ACME data |
| Dossier disclaimer | none | every dossier states its contents are fictional |

The disclaimer is the difference that outlasts the data. `bootstrap-acme` writes a fiction marker into
the tenant row, and every dossier that deployment ever produces carries it — which is correct for a
demonstration and useless for a real filing. `bootstrap` writes no marker, so a tenant created that way
is asserting that its data is real. Neither is recoverable from the other without recreating the tenant.

```sh
sudo ./scripts/installer/openppwr-installer bootstrap moja-firma 'Moja Firma sp. z o.o.'
```

The slug must be lowercase letters, digits and hyphens; it is checked before the request is sent, because
a slug rejected after the tenant row exists leaves a deployment that has to be wiped.

Every step of the first run uses the release-tree form. `install` does place a copy at
`/usr/local/bin/openppwr-installer`, and the operations below use it — but the first run should not
change invocation form halfway through a sequence the operator is already standing in the right
directory for, and the bare form additionally assumes `/usr/local/bin` is on `sudo`'s `secure_path`.
`configure`, `start`, `bootstrap-acme` and `verify` read nothing out of the release tree, so both
forms are equivalent for them; only the release-tree form is equivalent for every subcommand.

`preflight` checks the host; it does not change it. It requires Docker and Docker Compose v2 to be
installed already and fails if either is missing — installing a container runtime is the operator's job,
not the installer's.

The GHCR command becomes usable only after owner-approved publication. Before publication, operators use an exact locally loaded private tag such as `openppwr:1.0.0-<shortsha>`.

`bootstrap-acme` stores all returned synthetic identities in `/opt/openppwr/state/acme-bootstrap.json`, mode 600, and installs the worker token without printing it. Move operational credentials into the approved secret manager after onboarding. Keep the bootstrap route protected and rotate/remove its secret after the release-test workflow.

### What `bootstrap-acme` leaves behind

It does not stop at identities. After creating the tenant it seeds the demonstration through the
product's own HTTP routes, each under the credential of the role that holds the permission for it, so
every seeded row has an audit event behind it:

| Step | Route | Credential |
|---|---|---|
| Import the fictional ACME catalogue | `POST /v1/imports` | `packaging_editor` |
| Upload one recycled-content declaration per supplier | `POST /v1/evidence` | `evidence_contributor` |
| Wait for the ClamAV verdict | `GET /v1/evidence` | `evidence_contributor` |
| Accept each declaration | `POST /v1/evidence/{id}/review` | `evidence_reviewer` |
| Run the assessment over the catalogue | `POST /v1/assessments/run` | `compliance_manager` |

A freshly bootstrapped deployment therefore starts with 28 packaging records, 18 materials, 40
components, 28 bills of material, 4 suppliers, 18 evidence requirements, 4 accepted supplier
declarations, one completed assessment reading **16 PASS, 1 FAIL, 1 UNKNOWN, 10 NOT APPLICABLE**, and
**exactly two open gaps**.

The two are deliberate, and they are the two that no upload can close: `ACME-PKG-002` declares 5%
recycled content against the demonstration rule's 30% minimum, and `ACME-PKG-006` declares none at
all. Both are fixed by working the gap — assign, remediate, reassess — which is the step the ACME
walkthrough asks for and the step a review cannot be frozen without. So the freeze and the dossier are
reachable in a few minutes of real work rather than after eighteen uploads and nineteen remediations,
and they are still earned: `POST /v1/review-snapshots` answers `409 READY_FOR_REVIEW_BLOCKED` while
either gap is open.

Two lines report it, and both name what happened rather than that something happened:

```
BOOTSTRAP_SEED_PASS dataset=acme-import-valid.json route=/v1/imports audited=true
BOOTSTRAP_SEED_READY evidence=4 accepted=4 scan=clean outcomes=PASS:16,FAIL:1,UNKNOWN:1,NOT_APPLICABLE:10 open_gaps=2 remaining=recycled-content-correction audited=true
```

Seeding is **not fatal and not a precondition for anything**. Bootstrap is a one-time,
whole-deployment operation, so a step that aborted here would leave the deployment with no way
forward; instead each failure prints `BOOTSTRAP_WARN demonstration_state=…` on stderr with the reason,
`bootstrap-acme` still exits 0, and the demonstration can be brought to the same state by hand from
the ACME walkthrough. The reason worth knowing is `scan_not_clean_after_300s_state_waiting`: ClamAV
loads its signature databases on first start and the wait is bounded at five minutes, so on a slow or
signature-less host the uploads are sitting in quarantine and only the review step is outstanding.

Seeding is idempotent. The catalogue import replays on its idempotency key; the declarations are
recognised by filename (`openppwr-seed-<supplier>.txt`) and reused rather than re-uploaded; already
accepted evidence is not reviewed again; and the assessment is re-run only when something actually
changed.

**The reset does not restore this state.** `Reset environment to initial state` in the workbench, and
`npm run demo:reset`, delete the imported catalogue, the evidence and the assessments, and nothing
re-seeds afterwards — `bootstrap-acme` cannot be run a second time against an existing tenant. After a
reset the demonstration is empty and is rebuilt by hand from the walkthrough, starting with the sample
files on the Downloads page.

## Deployment modes

Mode A binds web to `127.0.0.1:31114` for an existing reverse proxy. No API, PostgreSQL or clamd port is published. Mode B uses the same loopback service behind an operator-supplied HTTPS reverse proxy. Authentication and evidence upload must never traverse plain HTTP. Cloudflare Zero Trust is an optional documented protection pattern and is used for the private `openppwr.eu` candidate.

The stack uses a dedicated Compose project, internal application network, PostgreSQL/evidence/ClamAV volumes, bounded logs, restart policies, health checks, non-root application containers, read-only application filesystems, dropped capabilities and no-new-privileges. Only ClamAV receives an egress network for signature updates.

## Operations

`configure`, `status`, `verify`, `credentials`, `backup`, `rollback`, `restore`, `stop` and `uninstall` act on
the deployment already in place and may be run via the installed copy on `PATH`. `upgrade` is different: it needs the *new* release's
`deploy/community/docker-compose.yml`, so it must be run the same way `install` is — from within that new
release's own extracted tree — not via the bare installed command. Running it via `PATH` fails closed
before any change is made (`SOURCE_ROOT` would resolve under the installed binary's own directory, not a
release tree, and there is no `deploy/community/docker-compose.yml` there).

```sh
sudo openppwr-installer status
sudo openppwr-installer verify

# once per deployment, before the first backup — the path must be outside /opt/openppwr:
sudo OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init
sudo openppwr-installer backup-key show

sudo openppwr-installer backup

# read the bearer credentials created by bootstrap-acme; the only supported way to obtain them:
sudo OPENPPWR_SHOW_CREDENTIALS=yes openppwr-installer credentials

# upgrade — from within the newly downloaded and verified release tree, exactly like the first install:
tar -xzf openppwr-NEW_VERSION.tar.gz && cd openppwr-NEW_VERSION
sudo ./scripts/installer/openppwr-installer upgrade openppwr:NEW_VERSION-APPROVED_SHA

sudo OPENPPWR_BACKUP_PRIVATE_KEY=/path/to/openppwr-backup-key.pem openppwr-installer rollback
sudo OPENPPWR_CONFIRM_RESTORE=yes OPENPPWR_BACKUP_PRIVATE_KEY=/path/to/openppwr-backup-key.pem \
  openppwr-installer restore /opt/openppwr/backups/TIMESTAMP
sudo openppwr-installer stop
sudo openppwr-installer uninstall
```

`uninstall` stops/removes containers and network but preserves volumes, backups, secrets and state. Manual data deletion is intentionally outside the command. Backups are root-only and hold a compressed custom PostgreSQL dump, an evidence archive, the deployment configuration, the bootstrap identities file, an `ENCRYPTION` descriptor and `SHA256SUMS`. Every member except those last two is encrypted to the deployment's backup recipient — AES-256-GCM under CMS AuthEnvelopedData, RSA-OAEP-SHA256 key transport — and the private key that reads them is deliberately not on the host. See [backup, restore and upgrade](BACKUP_RESTORE_UPGRADE.md) for the key-management design and what an operator must do.

## Refusals an operator will meet

These are deliberate fail-closed behaviours, not defects. Each stops before changing anything.

- **`credentials` will not print without confirmation.** It exits 112 unless `OPENPPWR_SHOW_CREDENTIALS=yes`
  is set, because the values are bearer tokens that grant full access to the tenant. A token that has been
  seen by the wrong person is replaced with `POST /v1/identities/{id}/rotate-credential`, which needs
  `OPENPPWR_ROTATION_DATABASE_PASSWORD` to be configured; a database reset is not the remedy.
- **`configure` refuses to change the demonstration identity after `bootstrap-acme` has run.** Changing
  `OPENPPWR_DEMO_PASSWORD` or `OPENPPWR_DEMO_EMAIL_DOMAIN` afterwards exits 43: the password is already
  hashed into the demonstration accounts and the addresses are already recorded, and neither can be
  rewritten without a fresh bootstrap.
- **`OPENPPWR_COMPOSE_PROJECT` is honoured on the first `configure` only.** It defaults to
  `openppwr-community` and is read back from the deployment's env file on every later `configure`; setting
  it again on an existing deployment has no effect, because the project name is what the PostgreSQL and
  evidence volumes are named after.
- **`backup` refuses to run before `backup-key init`.** It exits 83 rather than writing an archive it
  cannot protect. `backup-key init` in turn exits 85 if `OPENPPWR_BACKUP_KEY_OUT` names a path under the
  deployment root, because `backups/` is what leaves the host and a private key sitting in it would leave
  with the archives it opens.
- **`restore` refuses an encrypted backup without the private key, before it touches anything.** Exit 104
  with no key set, 105 when the key does not match or the archive has been altered — in both cases before
  the safety backup is taken and before a single container is stopped, so a wrong key costs nothing.
  `rollback` makes the same check at exit 92, before it swaps the compose file.
- **`restore` refuses any source outside the deployment backup directory.** Both the backup directory and
  the supplied source are canonicalised before the comparison and the canonical path is used for every
  read afterwards, so neither `..` segments nor a symlink planted below `backups` can redirect a
  destructive restore. It also requires `OPENPPWR_CONFIRM_RESTORE=yes` and takes a safety backup first.

## Clean-host acceptance

`backup`, `restore`, versioned `upgrade`, restore-based `rollback` and immutable container/volume-loss
recovery have each passed against a real Debian 13 x86_64 installer deployment; see [backup, restore and
upgrade](BACKUP_RESTORE_UPGRADE.md) for what was verified and when. Data-preserving `uninstall` followed by
reinstall has not been rehearsed separately. Independent repetition — a reviewer other than the author
working only from the release artifacts and this document, on a host they control — remains open.
