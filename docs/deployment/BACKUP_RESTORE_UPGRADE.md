# Backup, restore, upgrade and rollback plan

## Backups are encrypted, and the key does not live on the host

Read this before the first `backup` on any deployment. It changes what an operator has to do.

The backup set holds the database dump, the evidence archive, the deployment's environment file and the
bootstrap identities file. The environment file carries the database, worker and bootstrap credentials; the
identities file carries the only plaintext copy of the human bearer tokens that exists anywhere. Off-host
copying is out of scope for the product — an external process pulls `backups/` to another server — so the
archive leaves this host by a path the installer does not control, and its confidentiality cannot depend on
the `0700` directory it was written into.

**Every member of a backup set is encrypted to a public key.** CMS AuthEnvelopedData (RFC 5083), AES-256-GCM
content encryption, RSA-4096 key transport under OAEP-SHA256, via OpenSSL, which `preflight` already
requires. `age` is not present on a minimal Debian 13 host; `gpg` is, but OpenSSL is the dependency this
installer already declares, so it is the one used.

**The host holds only the public half.** `secrets/backup-recipient.pem` is a certificate — it can create a
backup nobody on the host can read. The private key is written once, to a path the operator names, and
`backup-key init` refuses any path under the deployment root: a key stored beside the archives it opens
would be copied off the host by the same process that copies the archives. A host compromise therefore
yields the ability to write future backups and nothing else. No archive already taken, and no off-host copy
of one, becomes readable.

Why not the alternatives:

| Rejected | Why |
|---|---|
| Symmetric key in `secrets/` | Simpler, and it does protect the off-host copies. It fails the harder case: whoever reaches the host reads the key and every backup it has ever protected, past and future. |
| Passphrase held by the operator | Nothing on disk to steal, and nothing to restore with either. A disaster-recovery procedure that depends on a human remembering a passphrase under pressure fails when it is needed. An unrecoverable backup is worse than an unencrypted one. |
| Key inside the environment file | The environment file is *inside* the backup. |
| Encrypting only the environment file | The evidence archive is the customer data and the identities file is the bearer tokens. The register named the environment file as the sharpest part, not the only part. |

**Integrity is bound to the key, not to `SHA256SUMS`.** The manifest sits in the same directory as the files
it describes, so anyone able to rewrite the ciphertext can rewrite the manifest. It is kept, because it
catches corruption before a restore spends effort on it, but AES-256-GCM is what makes tampering fail: an
altered archive does not decrypt.

### What an operator must now do

```sh
# Once per deployment, before the first backup. The path must be outside /opt/openppwr.
sudo OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init

# Then move that file into whatever secret store you already operate and delete the local copy.
# Optional: protect the key file itself with a passphrase, at PBKDF2-HMAC-SHA512, 600000 iterations.
sudo OPENPPWR_BACKUP_KEY_PASSPHRASE_FILE=/root/passphrase \
     OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init

sudo openppwr-installer backup-key show     # which key pair this deployment encrypts to
```

`backup-key init` verifies the pair by encrypting and decrypting a probe before it installs the recipient.
A certificate that its filed private key cannot open would make every subsequent backup look successful and
be unrecoverable, so this check is not optional and not a separate command.

Restore, rollback and any upgrade that has to be undone all need the private key back:

```sh
sudo OPENPPWR_CONFIRM_RESTORE=yes \
     OPENPPWR_BACKUP_PRIVATE_KEY=/path/to/openppwr-backup-key.pem \
     openppwr-installer restore /opt/openppwr/backups/TIMESTAMP
```

Rebuilding a lost host: bring the same private key back and adopt it, so the new deployment can read its own
backup history rather than minting a second key that cannot.

```sh
sudo OPENPPWR_BACKUP_KEY_IN=/path/to/openppwr-backup-key.pem openppwr-installer backup-key init
```

The certificate is minted afresh each time, so its certificate fingerprint changes; the identity recorded in
a backup's `ENCRYPTION` file is the SHA-256 of the public key, which does not.

### Refusals

Each of these stops before anything is created, stopped or replaced.

| Situation | Result |
|---|---|
| `backup` with no recipient configured | exit `83`, naming `backup-key init`. No archive is written. |
| `OPENPPWR_BACKUP_KEY_OUT` under the deployment root | exit `85`. No key is generated. |
| `backup-key init` when a recipient already exists | exit `85` unless `OPENPPWR_CONFIRM_ROTATE_BACKUP_KEY=yes`; rotation does not re-encrypt archives already written. |
| `restore` of an encrypted set with no `OPENPPWR_BACKUP_PRIVATE_KEY` | exit `104`, before the safety backup. |
| `restore` with the wrong key, a wrong passphrase, or an altered archive | exit `105`, before the safety backup. |
| `rollback` when the recorded backup is encrypted and no key is set | exit `92`, before the compose file is swapped. |
| Encryption failing part-way through `backup` | exit `84`; every unencrypted intermediate is removed, so a half-written set is never left looking complete. |

### What did not change

- **Backups taken before this change still restore, with no key.** `restore` reads the plaintext member
  names when the encrypted ones are absent. Upgrading must not break recovery for deployments that already
  exist.
- The writers are still stopped for the width of the snapshot, the dump's exit status is still checked
  before compression, and the bootstrap identities file is still included.
- Encryption happens after `compose up -d api worker`, so a failure to encrypt never leaves the deployment
  stopped.

### Limits worth knowing

- Decryption is not streamed: `openssl cms -decrypt` buffers the content. Measured peak RSS is roughly
  three times the size of the largest archive member (50 MB → 161 MiB, 100 MB → 268 MiB, 200 MB → 589 MiB,
  400 MB → 1.02 GiB). Encryption *is* streamed and stays at about 8 MiB regardless of size. On the 4 GB
  minimum this installer enforces, a member beyond roughly 1 GB needs headroom checked first.
- `restore` decrypts to `state/restore-plaintext.$$`, mode `0700`, removed on exit including on failure.
  The plaintext exists on the host's disk for the width of the restore; `pg_restore` and `tar` need files,
  and `/bin/sh` on Debian is dash, which has no `pipefail` — the same reason the dump is written to a file
  before it is compressed.
- A private key the operator leaves on the host is a key on the host. The installer can refuse to *write*
  it under the deployment root; it cannot make anyone move it off the machine.

1. Quiesce writes or take a transactionally consistent PostgreSQL snapshot plus the matching immutable evidence-storage snapshot.
2. Record application version, migration ledger, object-store manifest and SHA-256 checksums.
3. Validate the database archive and restore it into an isolated database; verify tenant counts, RLS, audit chain and dossier downloads.
4. For upgrades, back up first, apply migrations as the migration identity, deploy an immutable image digest, run health/E2E smoke checks, then admit traffic.
5. Application rollback is `openppwr-installer rollback`, which is restore-based. Database rollback is restore-forward from the validated backup; destructive down-migrations are prohibited and this project has never had one.

   **Pointing the image reference back at a previous release is not a rollback and generally breaks the deployment**, even when the migrations between the two are backward-compatible. An earlier revision of this line said backward-compatible migrations made an image swap safe; that reasoning is about the schema alone and the schema is not the only thing an upgrade replaces. `upgrade` installs the new release's Compose file over the deployment's, and every health check and dependency condition in it belongs to the release being installed — so an older image is started under a newer file, probed on routes it may not serve, and left unhealthy with the tiers that wait on it never starting. Changing the image reference does not put the old Compose file back; `rollback` restores the Compose file, the environment file, the database and the evidence volume of one generation together, which is the only combination that has been tested.

Offline backup/restore and current-migration idempotency passed in an isolated local PostgreSQL test harness with matching evidence-storage manifest, RLS negative check and audit reconstruction. See `docs/testing/RECOVERY_REHEARSAL.md`.

## Verified against a real Debian 13 host, 2026-07-31

Backup, restore, versioned upgrade and restore-based rollback all executed against a real installer
deployment (Docker Compose, real ClamAV, genuine identities/evidence/audit data) rather than a synthetic
seed — not the isolated harness above.

| Operation | Result |
|---|---|
| `backup` | `BACKUP_PASS`, `openppwr.pgdump.gz`/`evidence.tar.gz`/`openppwr.env` all `SHA256SUMS`-verified |
| `restore` (same-version round trip) | `RESTORE_PASS pre_restore_backup=true`; catalog state and audit-chain verification identical before and after |
| `upgrade` from the actual old private RC schema (`9faeb00`, 7 migrations, real ACME data seeded by a real E2E run) forward through 29 migrations | `UPGRADE_PASS`; all pre-upgrade data intact (32 packaging / 18 materials / 40 components / 32 BOMs / 4 suppliers, 60+ audit events), audit chain still verifies, worker healthy and correctly wired to its own database principal |
| `rollback` (restore-based, to the immediately prior image) | `ROLLBACK_PASS`; image reference and data both reverted correctly |

**Two real defects found by this rehearsal, both fixed in the installer** (neither was reachable by any
prior gate, because every prior gate migrates an empty embedded database and never upgrades a real prior
deployment):

1. A deployment configured before migration 022 (the worker's own database principal) has no
   `OPENPPWR_WORKER_DATABASE_PASSWORD`, which every image since requires unconditionally. `upgrade` now
   generates one if absent.
2. `upgrade` swapped only the image reference and never refreshed `docker-compose.yml` — an upgraded
   deployment kept running whatever compose topology it was first installed with. On the test above, the
   worker container stayed wired to connect as `openppwr_app` (silently reverting the entire worker/API
   credential separation) because the deployed compose file predated the worker service existing at all.
   `upgrade` now refreshes the compose file unconditionally from the release tree.

## Immutable container/volume-loss recovery — PASS, 2026-07-31, source `b50bfd0`, image `openppwr:b50bfd0-rc`

Previously unpassed (see below) — every prior rehearsal always had the prior containers available to roll
back to or restore over, not a full rebuild from backup alone. This is the first genuine end-to-end run:

1. Backed up the running isolated deployment (`BACKUP_PASS`), then copied the backup set to a location
   outside the deployment tree entirely (`/tmp`), simulating retrieval of an off-host copy after total
   host loss.
2. Destroyed everything else: `docker compose down -v` (all containers, named volumes and networks), then
   `rm -rf` the entire deployment root (`state/`, `secrets/`, the compose file — everything a real VPS
   rebuild would lose).
3. Rebuilt the image from the exact frozen source (`openppwr:b50bfd0-rc`) and ran `preflight` → `install`
   → `configure` fresh against it — new secrets throughout, exactly as a genuinely new host would produce.
4. Copied the off-host backup into the new deployment's own `backups/` directory (the confinement check
   added this session correctly refuses a restore source outside it — this is the real
   procedure, not a workaround) and ran `restore`.
5. Result: `RESTORE_PASS source=.../backups/recovered pre_restore_backup=true`, then
   `VERIFY_PASS web=healthy database=ready worker=healthy`.

**Data verified identical to the pre-disaster state, not just "the deployment is up":** 64/64 audit
events, 8/8 `evidence_files` rows, 13 real files recovered on disk under the evidence volume (dossiers,
quarantine items and the storage-identity marker), and the worker actually authenticated with its
backup-derived token rather than crash-looping (`worker.tenancy.checked tenants=1` in its own log) — the
exact failure mode the restore code's own disaster-recovery comment warns about.

## Encrypted backup and recovery — PASS, 2026-08-01, image `openppwr:0.2.0-beta.1-5abb8a6-dgate`

Run against a real Debian 13 x86_64 installer deployment in its own root, compose project and port, with
real containers, a real ClamAV, a real synthetic-ACME import (28 packaging, 4 suppliers, 40 components), a
real evidence upload and a verifying audit chain. Pre-disaster state: `tenants=1 packaging=28 suppliers=4
components=40 evidence_files=1 audit_events=32 assessments=28`, 2 files on the evidence volume,
`{"valid":true,"count":32}`.

1. **A backup written before this change was kept**, taken with the installer exactly as it stood at
   `7cee582`. Its `openppwr.env` reads with no key at all: `OPENPPWR_DB_PASSWORD=837e21eeb6…`,
   `OPENPPWR_BOOTSTRAP_TOKEN=216144568c…`. That is the risk, demonstrated rather than asserted.
2. **`backup` with no key configured refused**, exit `83`. No archive was written.
3. **`backup-key init` refused a private key inside the deployment root**, exit `85`.
4. **`backup-key init` succeeded** — `BACKUP_KEY_PASS … roundtrip=verified adopted=false` — writing the
   recipient `0644` under `secrets/` and the private key `0600` outside the deployment tree.
5. **`backup` produced a set with no plaintext member**: `openppwr.pgdump.gz.enc`, `evidence.tar.gz.enc`,
   `openppwr.env.enc`, `acme-bootstrap.json.enc`, plus `ENCRYPTION` and `SHA256SUMS`.
6. **The archive is unreadable without the key.** Every byte of the encrypted set was searched for this
   deployment's own live secrets, taken from the plaintext copy in step 1: database password `0` matches,
   worker token `0`, bootstrap token `0`, the literal string `OPENPPWR_` `0` — against `1`, `2`, `1` and `9`
   in the plaintext set. `gzip -dc` exits `1` ("not in gzip format"), `tar -tzf` exits `2`, and
   `openssl cms -decrypt` under a freshly generated 4096-bit key exits `4` ("Error decrypting CMS
   structure"). Flipping one byte of the ciphertext and decrypting with the *correct* key also exits `4`:
   tampering is caught by the AEAD tag, not by the manifest beside it. With the key, the recovered
   environment file is byte-identical to the plaintext of step 1.
7. **Total loss, then rebuild.** `docker compose down -v` and `rm -rf` on the deployment root: root gone,
   0 named volumes left, the encrypted set and the private key the only survivors, both outside the tree.
   Fresh `configure` generated new secrets (`OPENPPWR_WORKER_TOKEN=UNCONFIGURED`), the surviving key was
   adopted with `OPENPPWR_BACKUP_KEY_IN` — same `public_key_sha256`, `adopted=true` — and the empty
   deployment started at `tenants=0 packaging=0 audit_events=0`.
8. **Both restore failure modes are clean refusals.** No key: exit `104`. Wrong key: exit `105`, after the
   checksum manifest verified, so this is the encryption refusing and not corruption. Afterwards
   `backups/` still held only the recovered set — no safety backup had been taken — and `api clamav
   postgres web` were all still running. Nothing was half-restored.
9. **Restore with the key**: `RESTORE_PASS source=…/backups/recovered pre_restore_backup=true`,
   `VERIFY_PASS web=healthy database=ready worker=healthy`. State after: `tenants=1 packaging=28
   suppliers=4 components=40 evidence_files=1 audit_events=32 assessments=28`, 2 evidence files,
   `{"valid":true,"count":32}` — identical to pre-disaster. The worker authenticated with its
   backup-derived token rather than crash-looping. `state/` held no decrypted plaintext afterwards.
10. **The pre-change plaintext backup from step 1 restored too**, with no key set at all: `RESTORE_PASS`,
    `VERIFY_PASS`, same counts. Its own safety backup came out encrypted, as it should.
11. **The optional passphrase path was exercised separately.** `backup-key init` with
    `OPENPPWR_BACKUP_KEY_PASSPHRASE_FILE` produced an `ENCRYPTED PRIVATE KEY` whose ASN.1 reads `PBES2` →
    `PBKDF2`, `hmacWithSHA512`, `aes-256-cbc`, iteration count `0x0927C0` = 600000. A backup taken against
    it restored with the passphrase (`RESTORE_PASS`, `VERIFY_PASS`) and refused without it — exit `105` in
    one second, not a process sitting on an invisible terminal prompt, which is why `-passin` is always
    passed.

`npm run release:recovery` — the isolated-harness rehearsal, which is untouched by this change —
still reports `RECOVERY_REHEARSAL_PASS`.

### Previously: remained unpassed

Immutable container recovery (redeploying from a known-good image digest after total container/volume
loss, with backup as the only surviving artifact) remained unpassed through 2026-07-31 — every rehearsal
before the one above always had the prior containers available to roll back to or restore over, not a
full rebuild from backup alone.
