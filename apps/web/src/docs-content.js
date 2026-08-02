import { DOCS_PL } from './docs-content-pl.js';
import { DOCS_DE } from './docs-content-de.js';

// The sixteen Community documentation pages.
//
// These were sixteen cards whose entire body read "Repository documentation". The list was accurate —
// the material did live in the repository — which is exactly why it was useless to a reader who had
// arrived at the documentation portal.
//
// Every command below is one this repository actually defines. Nothing here describes a flag, script
// or endpoint that does not exist; where a capability is absent, the page says so rather than
// inventing a procedure for it.
//
// Language policy, decided by the owner on 2026-07-29. All sixteen areas are complete in English.
// Nine of them — the ones an operator needs in order to install, recover, secure and support a
// deployment — are additionally complete in Polish and German. The remaining seven keep the English
// body and say so in the reader's own language.
//
// Nothing is machine-translated into a command, an environment variable name, an endpoint path or an
// identifier: a translated flag is a broken instruction. Only the prose around them is translated.

export const DOCS_LAST_VALIDATED = '1.0.0';

const p = (text) => ({ kind: 'p', text });
const ul = (items) => ({ kind: 'ul', items });
const code = (text) => ({ kind: 'code', text });
const h = (text) => ({ kind: 'h', text });

export const DOCS_PAGES = [
  {
    slug: 'quickstart',
    title: 'QuickStart',
    purpose: 'Get a working OpenPPWR Community deployment and run the reference workflow once.',
    audience: 'An operator with a clean Linux host and root access.',
    prerequisites: ['Debian 13 x86_64, or any host with Docker and Docker Compose', 'Root or sudo', 'A PostgreSQL-capable volume with room for evidence files', 'The extracted release tree: the image is built from it, not pulled'],
    body: [
      h('Build the image first'),
      p('No OpenPPWR image has been published to any registry. The registry reference in openppwr.env.example describes the form the value takes once publication happens; it is not something you can pull today, and a deployment started against it fails on the pull rather than on anything you did. Build the image from the release tree and point OPENPPWR_IMAGE at the tag you built.'),
      h('Steps'),
      p('Build the image, copy the environment template, and replace every REPLACE_WITH_64_HEX_CHARACTERS value with a distinct random value; reusing one across two variables gives two different trust boundaries the same secret. Set OPENPPWR_IMAGE to the tag you have just built. Leave OPENPPWR_WORKER_TOKEN as it is: the worker credential does not exist until bootstrap has issued it.'),
      code('docker build -t openppwr:1.0.0 .\ncp deploy/community/openppwr.env.example deploy/community/openppwr.env\nchmod 600 deploy/community/openppwr.env\nopenssl rand -hex 32   # run once per secret'),
      p('Start everything except the worker. Starting the whole stack in one command also starts the worker, and the worker has no credential yet: the template ships REPLACE_AFTER_BOOTSTRAP, which is a published placeholder and is refused at startup rather than accepted. Under restart: unless-stopped that is a restart loop, not a container on its way to healthy.'),
      code('docker compose --env-file deploy/community/openppwr.env -f deploy/community/docker-compose.yml up -d postgres clamav migrate api web'),
      h('Bootstrap, then start the worker'),
      p('A deployment that has never been bootstrapped holds no tenant and no identity, so there is nothing to sign in as. Bootstrap creates the tenant and returns every identity with its bearer token once, in the response body — the store keeps only hashes, so nothing can show them again.'),
      code('curl -sS -X POST http://127.0.0.1:31114/v1/bootstrap \\\n  -H \'content-type: application/json\' \\\n  -H "x-openppwr-bootstrap-token: $(sed -n \'s/^OPENPPWR_BOOTSTRAP_TOKEN=//p\' deploy/community/openppwr.env)" \\\n  --data \'{"slug":"acme-eu-demo","name":"ACME Packaging Europe GmbH"}\''),
      p('That body creates the demonstration tenant. disclaimer is optional and defaults to the fiction marker, so a request that omits it produces a tenant whose every dossier states that its contents are fictional — the safe direction to be wrong in, and the wrong one for an organisation deploying this for its own filings. Such a deployment sends its own slug and name together with an explicit "disclaimer":"", so that nothing it produces is marked as fiction. Bootstrap runs once: the API refuses a second tenant for the life of that database, so this is not a decision that can be revised afterwards. On Debian 13 the installer settles the same question with two named subcommands, described on its own page.'),
      p('Copy identities.worker.token out of that response into OPENPPWR_WORKER_TOKEN in the environment file, keep the rest somewhere you can read them again, and start the worker.'),
      code('docker compose --env-file deploy/community/openppwr.env -f deploy/community/docker-compose.yml up -d worker'),
      h('Expected result'),
      p('Five containers run once the worker has started: web, api, worker, postgres and clamav. migrate is a sixth, which runs the schema forward and exits 0 rather than staying up. The web service listens on the bind address and port named in the environment file, 127.0.0.1:31114 by default.'),
      h('Verification'),
      code('curl -s http://127.0.0.1:31114/v1/version'),
      p('The response states the version, the full source revision, the build timestamp, the release channel and the migration level. If it reports a version you did not deploy, the deployment is stale — that is the failure this endpoint exists to make visible.'),
      h('Security notes'),
      p('The bind address defaults to loopback deliberately. Publishing the port directly to the internet places an unauthenticated surface in front of the API; put a reverse proxy and an access control in front of it first.'),
      h('Troubleshooting'),
      ul([
        'An image pull error means OPENPPWR_IMAGE still names a registry reference. Nothing has been published; build the image locally and name the tag you built.',
        'clamav takes several minutes to load signatures on first start and reports unhealthy until it has. Evidence scanning fails closed during that window, which is correct behaviour, not a defect.',
        'A worker that restarts in a loop still carries REPLACE_AFTER_BOOTSTRAP, or a token bootstrap did not issue. The refusal names the variable and never prints the value.',
        'The Debian 13 installer runs this whole sequence, including bootstrap and the sample catalogue, as its own subcommands. It is the shorter path if the host is Debian 13.',
      ]),
    ],
    related: ['docker-deployment', 'debian-installer', 'configuration'],
  },
  {
    slug: 'debian-installer',
    title: 'Debian 13 clean-server installer',
    purpose: 'Install OpenPPWR Community on a freshly provisioned Debian 13 host in one run.',
    audience: 'An operator installing onto a host with nothing on it yet.',
    prerequisites: ['Debian 13 x86_64, freshly installed', 'Root access', 'Outbound network access for package and image retrieval'],
    body: [
      h('Steps'),
      p('The installer lives at scripts/installer/openppwr-installer. It creates the deployment directory, generates secrets, writes the environment file with restrictive permissions, and starts the stack. It does not install the container runtime: preflight requires Docker and Docker Compose v2 to be present already and fails if either is missing.'),
      p('Each step is a separate subcommand. Running the installer with no subcommand prints usage and exits 2.'),
      code('sudo ./scripts/installer/openppwr-installer preflight\nsudo ./scripts/installer/openppwr-installer install\nsudo ./scripts/installer/openppwr-installer configure IMAGE\nsudo ./scripts/installer/openppwr-installer start\nsudo ./scripts/installer/openppwr-installer bootstrap-acme\nsudo ./scripts/installer/openppwr-installer verify'),
      p('Run all six from the root of the extracted release tree, the directory that contains scripts/ and deploy/. install also places a copy of itself at /usr/local/bin/openppwr-installer, so later commands — status, verify, backup, credentials — can be run as a bare openppwr-installer once that tree is gone. upgrade is the exception and must never be run that way: it needs the compose file belonging to the new release, which the installed copy has no tree to find, so it has to be run from within the new release tree exactly as install was. It refuses before changing anything rather than stopping halfway through.'),
      h('Which tenant this deployment gets'),
      p('The fifth command is a choice between two forms, and it is the one step on this page that cannot be revised afterwards. bootstrap-acme creates the fictional acme-eu-demo tenant and loads a synthetic catalogue, which is what an evaluation needs. An organisation installing this for its own filings takes the other form: it creates the tenant under a slug and a name you supply, and leaves the catalogue empty for your own import.'),
      code('sudo ./scripts/installer/openppwr-installer bootstrap <slug> \'<organisation name>\''),
      p('Both forms do the same three things: they create the deployment\'s one tenant, install the worker\'s bearer token into the environment file, and mark the evidence volume. All three are necessary — the worker cannot authenticate without the token, and without the marker its retention sweep refuses to treat a missing evidence file as a deleted one.'),
      p('What separates them outlasts the sample data, and it is the disclaimer carried by the tenant row. bootstrap-acme writes a fiction marker there, and every dossier that deployment ever produces carries it, stating that its contents are fictional: correct for a demonstration and useless for a real filing. bootstrap writes no marker, so a tenant created that way asserts that its data is real. That is the difference to decide on, because the command names do not show it.'),
      p('Bootstrap is a one-time, whole-deployment operation. Once a tenant exists the API refuses a second one for the life of that database, so neither form can be reached from the other later and changing your mind means destroying the deployment and installing again. Decide before running either. The slug must be lowercase letters, digits and hyphens; the installer checks that before the request is sent, because a slug rejected after the tenant row exists leaves a deployment that has to be wiped.'),
      h('Expected result'),
      p('A running stack under /opt/openppwr, an environment file owned by root with mode 600, and generated secrets that were never written to the terminal.'),
      h('Verification'),
      code('npm run installer:validate'),
      p('The validator checks the installer script itself, not a running deployment. Use verify for that. Installation on a clean Debian 13 host has been rehearsed by the authors; independent repetition by a reviewer on a host they control remains open.'),
      h('Security notes'),
      ul(['Generated secrets are written only to the environment file, never to standard output or shell history.', 'The environment file must stay root-owned and mode 600. The installer sets this; an upgrade must not relax it.']),
      h('Troubleshooting'),
      ul(['A host with an existing container runtime from a different source may present an incompatible Compose version. Remove it or install onto a clean host.', 'The installer is not idempotent across major versions. To reinstall, remove /opt/openppwr first, having taken a backup.', 'openppwr-installer: command not found means the bare form was used before install had placed the copy on PATH, or on a host whose sudo secure_path does not include /usr/local/bin. Use the release-tree form above, which depends on nothing but the current directory.']),
    ],
    related: ['quickstart', 'backup-restore', 'upgrade-rollback'],
  },
  {
    slug: 'docker-deployment',
    title: 'Docker deployment',
    purpose: 'Understand the container topology and operate it directly.',
    audience: 'An operator running the stack with Docker Compose.',
    prerequisites: ['Docker Engine with the Compose plugin', 'A completed environment file, including a worker token bootstrap has issued'],
    body: [
      h('Topology'),
      ul([
        'web — serves the product surfaces and proxies /v1/* to the API. The only edge-facing hop.',
        'api — authentication, catalogue, evidence, assessment, dossier and audit.',
        'worker — evidence scanning and background jobs. It authenticates with a bearer token bootstrap issues, so it cannot start on a deployment that has not been bootstrapped.',
        'postgres — persistence, with FORCE RLS enabled for tenant isolation.',
        'clamav — malware scanning. Evidence cannot be reviewed until it has been scanned.',
        'migrate — a sixth service that is not a long-running one: it applies the schema and exits 0. api waits for it to complete.',
      ]),
      h('Steps'),
      p('Naming the services is deliberate. On a deployment that has not been bootstrapped, starting them all also starts the worker, whose token does not exist yet; the QuickStart covers that order. On a bootstrapped deployment the second form is the ordinary one.'),
      code('docker compose --env-file deploy/community/openppwr.env -f deploy/community/docker-compose.yml up -d postgres clamav migrate api web worker\ndocker compose --env-file deploy/community/openppwr.env -f deploy/community/docker-compose.yml ps'),
      h('Expected result'),
      p('All five long-running services healthy, and migrate exited 0. The web service is bound to OPENPPWR_BIND_ADDRESS, which defaults to 127.0.0.1.'),
      h('Verification'),
      code('curl -s http://127.0.0.1:31114/health\ncurl -s http://127.0.0.1:31114/v1/version'),
      h('Security notes'),
      p('web is the sole hop trusted to determine the client address. It strips client-supplied forwarding headers before proxying. Only set OPENPPWR_TRUST_CF_CONNECTING_IP=true when every request genuinely arrives through your own Cloudflare tunnel; otherwise a client can choose its own apparent IP and defeat rate limiting.'),
      h('Troubleshooting'),
      ul(['A 502 from web with an UPSTREAM_UNAVAILABLE body means the API container is not accepting connections.', 'A 404 with UNKNOWN_HOST means OPENPPWR_HOST_MAP is set and the requested hostname is not in it.']),
    ],
    related: ['configuration', 'quickstart', 'architecture'],
  },
  {
    slug: 'configuration',
    title: 'Configuration reference',
    purpose: 'Every environment variable the deployment reads, and what happens when it is wrong.',
    audience: 'An operator writing or reviewing an environment file.',
    prerequisites: ['deploy/community/openppwr.env.example as the starting point'],
    body: [
      h('Deployment identity'),
      ul([
        'OPENPPWR_COMPOSE_PROJECT — Compose project name. Changing it on an existing deployment orphans the volumes.',
        'OPENPPWR_IMAGE — the exact image reference to run. Pin a version; a floating tag makes the running build unknowable.',
        'OPENPPWR_IMAGE_DIGEST — optional. Reported by /v1/version so a deployment can state the digest it was given.',
        'OPENPPWR_BIND_ADDRESS — defaults to 127.0.0.1. Change only behind a reverse proxy.',
        'OPENPPWR_WEB_PORT — host port for the web service.',
      ]),
      h('Secrets the stack will not start without'),
      p('These five, and OPENPPWR_IMAGE above, are the variables the compose file marks as required. An absent or empty value is refused at variable interpolation, before any container starts, with a message naming the variable.'),
      ul([
        'OPENPPWR_DB_PASSWORD — migration-role database password.',
        'OPENPPWR_RUNTIME_DATABASE_PASSWORD — runtime-role password. Deliberately separate from the migration role, so the running application cannot alter its own schema.',
        'OPENPPWR_WORKER_DATABASE_PASSWORD — the worker’s own database principal. It is a distinct login from the API’s: sharing one credential between them is what made the retention grants decorative, so the compose file refuses to start rather than falling back.',
        'OPENPPWR_BOOTSTRAP_TOKEN — one-time tenant bootstrap credential.',
        'OPENPPWR_WORKER_TOKEN — issued by bootstrap; the worker authenticates with it. The template ships a placeholder, which the worker refuses, so the worker cannot start before bootstrap has run.',
      ]),
      p('Each must be a distinct 64-hex-character value. Published placeholders, values under 24 characters and values made of too few distinct characters are refused at startup rather than merely discouraged. The file must be root-owned and mode 600.'),
      h('Privileged database principals'),
      p('Three optional logins, each carrying a capability the request-serving role deliberately lacks. Unset means the capability does not exist rather than falling back to a wider role, and the API verifies at startup that each connects as the principal its variable names.'),
      ul([
        'OPENPPWR_AUTH_DATABASE_PASSWORD — the role that verifies a password and issues a session. Demonstration profile only. OPENPPWR_DEMO_LOGIN=true without it is fatal at startup: the API refuses to serve a sign-in it cannot perform.',
        'OPENPPWR_MAINTENANCE_DATABASE_PASSWORD — the role that resets the demonstration environment. Demonstration profile only; a deployment holding real data never loads it.',
        'OPENPPWR_ROTATION_DATABASE_PASSWORD — the one privileged principal a deployment holding real data is meant to set. It holds EXECUTE on the credential-rotation function and nothing else, which is what makes POST /v1/identities/{id}/rotate-credential available in production. Leave it unset and a leaked bearer token can only be replaced from the host.',
      ]),
      h('Demonstration sign-in'),
      ul([
        'OPENPPWR_DEMO_LOGIN — when true, creates demonstration accounts with a published password. Never set this on a deployment holding real data.',
        'OPENPPWR_DEMO_PASSWORD — defaults to "demo" when demonstration sign-in is enabled.',
        'OPENPPWR_DEMO_EMAIL_DOMAIN — defaults to "dummymail.example".',
      ]),
      p('When demonstration sign-in is off, the /v1/demo/accounts route does not exist at all, so a production deployment discloses nothing about it.'),
      h('Surfaces and origins'),
      ul([
        'OPENPPWR_HOST_MAP — optional. Maps hostnames to surfaces, for example marketing:openppwr.eu,app:app.openppwr.eu. Unset means one host serves every surface, which is the ordinary self-hosted shape. Once set, a hostname not in the map is refused with 404 UNKNOWN_HOST rather than served the marketing site.',
        'OPENPPWR_CORS_ALLOWED_ORIGINS — comma-separated. Replaces the default allowlist for a self-hosted custom domain rather than adding to it.',
        'OPENPPWR_TRUST_X_FORWARDED_HOST — only true when a proxy you control is the sole edge-facing hop and overwrites the header itself.',
        'OPENPPWR_TRUST_CF_CONNECTING_IP — only true when every request arrives through your own Cloudflare deployment.',
      ]),
      h('Security alert routing'),
      p('Where security events go besides stdout. Every one of these is unset by default and unset means off: nothing is sent and nothing is attempted. Delivery is bounded and never on the request path, so a destination that is slow or unreachable drops alerts rather than affecting requests. The api container has no outbound network path by default.'),
      ul([
        'OPENPPWR_ALERT_WEBHOOK_URL — required to enable the webhook transport. http and https only.',
        'OPENPPWR_ALERT_WEBHOOK_TOKEN — optional bearer token for the destination. Never sent in the payload and never logged.',
        'OPENPPWR_ALERT_MIN_LEVEL — debug, info, warn or error. Default error.',
        'OPENPPWR_ALERT_TIMEOUT_MS — one delivery attempt, 100 to 15000. Default 2000.',
        'OPENPPWR_ALERT_MAX_IN_FLIGHT — outstanding deliveries, 1 to 256. Default 16. Beyond it events are dropped and counted rather than queued.',
        'OPENPPWR_ALERT_DEPLOYMENT — a label for this deployment, in the subject line and in a header. Default "unnamed".',
        'OPENPPWR_ALERT_SMTP_HOST — required to enable the e-mail transport, which is independent of the webhook.',
        'OPENPPWR_ALERT_SMTP_PORT — defaults by TLS mode: 587 starttls, 465 implicit, 25 disabled.',
        'OPENPPWR_ALERT_SMTP_TLS — starttls (default), implicit or disabled. A server that stops advertising STARTTLS is refused rather than fallen back from.',
        'OPENPPWR_ALERT_SMTP_USERNAME and OPENPPWR_ALERT_SMTP_PASSWORD — optional. Setting a username with TLS disabled disables routing and says why.',
        'OPENPPWR_ALERT_EMAIL_FROM — required for e-mail. The envelope sender.',
        'OPENPPWR_ALERT_EMAIL_TO — required for e-mail. Up to ten comma-separated addresses.',
        'OPENPPWR_ALERT_EMAIL_MAX_PER_HOUR — 1 to 10000, default 60. Suppressed messages are counted and reported in the next one that goes out.',
      ]),
      h('Host log retention'),
      p('Container logs go to the host journal, so the retention period is a journald setting the installer writes rather than anything the compose file can express. It is host-wide, and it promises "the period or the size ceiling, whichever comes first" — not the period alone.'),
      ul([
        'OPENPPWR_JOURNAL_RETENTION — maximum age of an entry. Any systemd time unit. Default 30day.',
        'OPENPPWR_JOURNAL_MAX_USE — maximum disk the journal may occupy. Default 1G, and on a busy deployment this is what binds first.',
        'OPENPPWR_JOURNAL_MAX_FILE_SIZE — default 128M.',
        'OPENPPWR_JOURNAL_MAX_FILE_SEC — how long one journal file stays active. Default 1day, because deletion works on whole archived files and never on the active one.',
        'OPENPPWR_CONFIRM_JOURNAL_OVERRIDE — proceed even though this host already configures journald elsewhere.',
        'OPENPPWR_SKIP_JOURNAL_RETENTION — leave journald alone, and accept that no retention period is then enforced at all.',
      ]),
      h('Database deadlines'),
      ul([
        'OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS — bounds one statement in an ordinary read or write. Unset by default, and unset means unbounded: no measurement of the ordinary routes exists yet, and a number nobody measured is a guess.',
        'OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS — bounds one statement inside the operations that walk a whole tenant: freeze, dossier generation, audit verification and assessment runs. Default 2000.',
        'OPENPPWR_DB_CHECKOUT_TIMEOUT_MS — how long a request may wait for a free pooled connection. Default 30000, a conservative starting point rather than a measurement of your deployment.',
        'OPENPPWR_DB_CONNECT_TIMEOUT_MS — how long the migration step may spend establishing its connection. Default 30000. It bounds a handshake, never a migration.',
      ]),
      h('Verification'),
      p('A malformed host map is rejected at startup rather than ignored, because a typo that silently disables routing for one hostname is precisely the failure the map exists to prevent. A value that cannot be honoured elsewhere — an unparseable alert URL, an unknown level, a timeout outside its range — disables that feature and says so once, rather than quietly reverting to a default the operator did not ask for.'),
    ],
    related: ['docker-deployment', 'security-model', 'architecture'],
  },
  {
    slug: 'backup-restore',
    title: 'Backup and restore',
    purpose: 'Take a restorable backup, and prove it restores.',
    audience: 'An operator responsible for recovery.',
    prerequisites: ['A running deployment', 'Storage for the database dump and the evidence tree', 'A place to keep a private key that is not this host'],
    body: [
      h('What must be captured together'),
      p('A backup is the database and the evidence storage tree taken at a consistent point. A database dump alone restores records that reference files which are not there, and the dossier manifests will not verify.'),
      h('Before the first backup: the key'),
      p('Every member of a backup set is encrypted to a public key this deployment holds, and only the matching private key can read it back. That pair does not exist until you create it, so backup refuses to run at all on a deployment that has never had one: it exits 83 and names backup-key init rather than writing an archive it cannot protect.'),
      p('Create it once. OPENPPWR_BACKUP_KEY_OUT names where the new private key is written and must be outside the deployment root — a private key stored beside the archives it opens leaves the host with them. Rebuilding a lost host is the other direction: OPENPPWR_BACKUP_KEY_IN adopts the key you already hold, so the rebuilt deployment can still read its own backup history instead of minting a second key that cannot.'),
      code('sudo OPENPPWR_BACKUP_KEY_OUT=/root/openppwr-backup-key.pem openppwr-installer backup-key init\nsudo openppwr-installer backup-key show'),
      p('Then move that file into the secret store you already operate and remove it from this host. Losing the private key makes every backup already taken permanently unreadable — there is no recovery path, no escrow and nobody to ask, which is the price of archives that a host compromise cannot read.'),
      h('Steps'),
      p('Use the installer. Its backup command is the only supported path that captures the database dump, the evidence volume, the deployment environment file, the bootstrap identities file and a SHA256SUMS manifest as one consistent set. A hand-rolled pg_dump captures the database alone, unencrypted.'),
      code('sudo openppwr-installer backup'),
      p('Backups are written root-only under the deployment backup directory. Copy the set somewhere off the host if it must survive loss of the machine; the encryption is what makes that copy safe to hold.'),
      h('Restore'),
      p('Restore needs the private key back. Without OPENPPWR_BACKUP_PRIVATE_KEY it exits 104 before the safety backup and before any container is stopped, so a missing key is a refusal against an untouched deployment rather than a database that has already been dropped.'),
      code('sudo OPENPPWR_CONFIRM_RESTORE=yes \\\n     OPENPPWR_BACKUP_PRIVATE_KEY=/root/openppwr-backup-key.pem \\\n     openppwr-installer restore /opt/openppwr/backups/TIMESTAMP'),
      p('Restore decrypts every member first, verifies the manifest checksums, takes a safety backup, then replaces the database and the evidence tree together. It refuses any source outside the deployment backup directory. Run verify before returning the deployment to service.'),
      h('Verification'),
      code('npm run release:recovery'),
      p('The recovery rehearsal exercises restore and migration idempotency in an isolated PostgreSQL harness. Offline backup/restore and migration idempotency pass; a rehearsal is not the same as a restore of your own data, so rehearse with your own backup, and your own key, before you need either.'),
      h('Security notes'),
      p('A backup contains evidence files, audit records, the deployment environment file and the only plaintext copy of the bootstrap bearer tokens. The product encrypts every one of those members for you — AES-256-GCM under CMS AuthEnvelopedData, RSA-OAEP-SHA256 key transport — so encryption at rest is not left to you. What is left to you is the private key: it must not live under the deployment root, and it must exist somewhere other than this host.'),
      h('Troubleshooting'),
      ul([
        'Exit 83 from backup means no recipient is configured on this deployment. Run backup-key init; nothing has been written.',
        'Exit 104 from restore means the set is encrypted and OPENPPWR_BACKUP_PRIVATE_KEY is unset or unreadable. Nothing has been changed.',
        'If audit verification fails after a restore, the database and the evidence tree came from different moments.',
      ]),
    ],
    related: ['upgrade-rollback', 'security-model', 'known-limitations'],
  },
  {
    slug: 'upgrade-rollback',
    title: 'Versioned upgrade and rollback',
    purpose: 'Move to a new version, and get back if it goes wrong.',
    audience: 'An operator performing a version change.',
    prerequisites: ['The extracted release tree of the target version', 'The exact image reference for the target version', 'The private backup key, because rollback is restore-based'],
    body: [
      h('Do not do this by hand'),
      p('Changing OPENPPWR_IMAGE and recreating the stack looks like the whole upgrade and is not. The installer records three things that path gets wrong, each measured on a real deployment rather than reasoned about: migrate exits 1 with "OPENPPWR_WORKER_DATABASE_PASSWORD is required." on any environment file written before that principal existed; the deployed docker-compose.yml stays at whatever install first copied, so the worker silently goes back to connecting as the API database role and the credential separation is gone; and the copy of the installer on PATH stays at the release that put it there, so day-2 commands run the old implementation against the new deployment.'),
      p('The upgrade subcommand does all of it: takes a backup and records which one belongs to this generation, back-fills environment variables newer migrations require, refreshes the compose file and the PATH copy, applies migrations and verifies the result. It must be run from inside the new release tree, because it needs that release’s compose file; the installed copy has no tree to find one in and refuses before changing anything.'),
      h('Steps'),
      ul([
        'Extract the target release and change into its tree.',
        'Record the current image reference and the current migration level, which is your rollback target.',
        'Run upgrade from that tree, naming the target image. It takes its own backup first.',
        'Verify the running build before returning the deployment to service.',
      ]),
      code('cd /path/to/openppwr-<target-version>\nsudo ./scripts/installer/openppwr-installer upgrade <target-image>'),
      h('Verification'),
      code('OPENPPWR_VERIFY_BASE_URL=http://127.0.0.1:31114 \\\nOPENPPWR_VERIFY_VERSION=<target-version> \\\nOPENPPWR_VERIFY_REVISION=<full-sha> \\\nnode scripts/validation/verify-deployed-version.mjs'),
      p('This fails rather than warns when the running build is not the one you deployed. A deployment is not complete until it passes.'),
      h('Rollback'),
      p('Rollback is restore-based, not image-based. It puts back the compose file, the environment file and the data of the generation the last upgrade replaced, because rolling the image back alone leaves an older application meeting a newer schema. That means it restores from the backup upgrade took, and a backup is encrypted: without OPENPPWR_BACKUP_PRIVATE_KEY it exits 92 before the compose file is swapped, having changed nothing.'),
      code('sudo OPENPPWR_BACKUP_PRIVATE_KEY=/root/openppwr-backup-key.pem openppwr-installer rollback'),
      p('Rollback undoes one generation: the one the most recent upgrade recorded. Going back further is an ordinary restore from the backup set you choose. Each release records its rollback target and whether an application-only rollback would have been sufficient, which is information for planning rather than a second procedure.'),
      h('Security notes'),
      p('Never roll back to a version with a known unpatched vulnerability in order to avoid a migration. Restore instead.'),
    ],
    related: ['backup-restore', 'release-notes', 'known-limitations'],
  },
  {
    slug: 'acme-walkthrough',
    title: 'ACME walkthrough',
    purpose: 'Run the complete reference workflow on fictional data.',
    audience: 'Anyone evaluating what the product does.',
    prerequisites: ['A deployment with demonstration sign-in enabled', 'The demonstration password, shown on the sign-in panel'],
    body: [
      h('The data'),
      p('ACME Packaging is invented. No part of it corresponds to a real company, product or supplier.'),
      p('A deployment bootstrapped with openppwr-installer bootstrap-acme does not start empty. It already holds what acme-import-valid.json carries: 28 packaging records, 18 materials, 40 components, 28 bills of material and 4 suppliers.'),
      p('The complete fictional portfolio is 32 packaging records and 32 bills of material. The remaining 4 records arrive only when you import acme-import-supplemental.csv yourself, from the Downloads page. Materials, components and suppliers are the same in both states.'),
      h('What bootstrap-acme has already done'),
      p('The catalogue is imported, one recycled-content declaration per supplier is uploaded, scanned and accepted — 4 of them, against the 18 evidence requirements the rule derives from those 28 records — and one assessment has been run. Sign in as Compliance Manager and read it: 16 PASS, 1 FAIL, 1 UNKNOWN and 10 NOT APPLICABLE.'),
      p('Two gaps are open, and they are the two no document can close: ACME-PKG-002 declares 5% recycled content against the rule minimum of 30%, and ACME-PKG-006 declares none at all. A review cannot be frozen while a gap is open, so closing them is the work this walkthrough asks for.'),
      h('Steps'),
      ul([
        'Sign in as Compliance Manager and read the assessment, the two open gaps and the accepted evidence behind them. Nothing has to be imported first.',
        'Attempt the freeze. It is refused while a gap is open — the freeze is a gate, not a button.',
        'Work each gap through assign, remediate and reassess. Both move to PASS.',
        'Freeze the review, then generate the dossier.',
        'Verify the audit chain from the same role. The actions bootstrap-acme performed are in it, under the role that holds the permission for each.',
      ]),
      h('Optional steps'),
      p('Neither is required to reach the dossier. Both show behaviour the seeded state cannot.'),
      ul([
        'Sign in as Packaging Editor and import acme-import-invalid.json. All 8 rows are rejected, the report names the reason for each, and nothing at all is written.',
        'Import acme-import-supplemental.csv from the same role. Its 4 rows merge into the populated catalogue, taking it to 32 packaging records and 32 bills of material, and 4 further evidence requirements are derived.',
        'Sign in as Evidence Contributor and upload another declaration, then as Evidence Reviewer and accept or reject it. Every upload is quarantined and scanned; an infected or expired file cannot be accepted.',
      ]),
      h('Expected result'),
      p('On the 28 records bootstrap-acme leaves behind, the assessment reads 16 PASS, 1 FAIL, 1 UNKNOWN and 10 NOT APPLICABLE, and 18 PASS, 0 FAIL, 0 UNKNOWN and 10 NOT APPLICABLE once both gaps are remediated and reassessed.'),
      p('On the complete 32-record catalogue — that is, only after acme-import-supplemental.csv has also been imported and the assessment re-run — the same figures are 20 PASS, 1 FAIL, 1 UNKNOWN and 10 NOT APPLICABLE, then 22 PASS, 0 FAIL, 0 UNKNOWN and 10 NOT APPLICABLE. These are the published reference figures.'),
      p('The count of NOT APPLICABLE results does not move between the two, because the records the supplemental file adds are all within the rule scope. The freeze produces four dossier artifacts either way: JSON, PDF, ZIP and a SHA-256 manifest.'),
      h('Resetting'),
      p('The demonstration tenant can be reset from within the workbench. Uploaded files are removed with it.'),
      p('Reset empties the environment. It does not restore the state bootstrap-acme left, and nothing re-seeds it afterwards: bootstrap-acme is a one-time, whole-deployment operation and the API refuses it once a tenant exists. After a reset the environment is rebuilt by hand from the sample files on the Downloads page.'),
      h('Security notes'),
      p('Demonstration accounts share a published password. They may only exist on a deployment holding fictional data.'),
    ],
    related: ['api-reference', 'security-model', 'support'],
  },
  {
    slug: 'api-reference',
    title: 'API reference',
    purpose: 'The HTTP contract, its versioning rules and its authorization model.',
    audience: 'An integrator calling OpenPPWR from another system.',
    prerequisites: ['A bearer token obtained from /v1/login or issued to a service account'],
    body: [
      h('Versioning'),
      p('Public contracts carry a major path prefix, /v1. Backward-compatible fields may be added within a major version; a breaking change requires a new prefix.'),
      h('Unauthenticated routes'),
      ul([
        'GET /health — liveness. The process is running; no dependency is consulted. Unchanged, and still what a monitor pointed at it receives.',
        'GET /health/live — liveness, under its own name.',
        'GET /health/ready — readiness: 200 when the database answers through the connection pool, 503 with a reason code when it does not. This is what the container healthcheck probes; a liveness answer cannot distinguish a working API from one whose pool is exhausted.',
        'GET /v1/version — version, revision, build timestamp, channel, image digest and migration level.',
        'GET /v1/permissions — the role and permission registry the server enforces.',
        'GET /v1/demo/accounts — only when demonstration sign-in is enabled; otherwise this route does not exist.',
        'POST /v1/bootstrap — creates the one tenant and its identities, authorized by the bootstrap token header rather than by a bearer credential. It answers 409 forever afterwards.',
      ]),
      h('Session'),
      ul([
        'POST /v1/login — email and password, returns a bearer token. Sets no cookie.',
        'GET /v1/session — the caller identity: role, tenant, permissions and expiry.',
        'POST /v1/logout — revokes the session server-side. The token is invalid immediately afterwards, not merely forgotten by the client.',
      ]),
      h('Credential rotation'),
      ul([
        'POST /v1/identities/{id}/rotate-credential — replaces one identity’s bearer token. This is the recovery path for a leaked credential, and it does not require resetting anything.',
      ]),
      p('Any identity may replace its own credential, because presenting it is proof of possession; a tenant administrator may replace any credential in the tenant, which is the recovery path when the holder cannot act. Anything else is answered as a not-found. The replacement is returned once and never again, the old credential stops authenticating immediately, every live session that identity holds is revoked in the same transaction, and the change is recorded in the audit chain. Role, tenant and supplier scope are untouched: rotation is recovery, never a way to acquire authority.'),
      p('The route needs a database principal narrow enough for a production deployment to hold. Set OPENPPWR_ROTATION_DATABASE_PASSWORD and it is available; leave it unset and the route answers 404, which is the only state in which a leaked credential has to be replaced from the host instead.'),
      h('Workflow'),
      ul([
        'POST /v1/imports — JSON or CSV, with an idempotency key. A replay returns the original outcome rather than importing twice.',
        'GET /v1/catalog/summary and GET /v1/catalog/{resource}',
        'GET /v1/evidence-requirements, GET /v1/evidence and POST /v1/evidence, POST /v1/evidence/{id}/review',
        'GET /v1/evidence/{id}/download — the stored document, verified against its recorded checksum. Only a document with a clean scan result is served.',
        'POST /v1/assessments/run and GET /v1/assessments — the run, and the paginated history of runs.',
        'GET /v1/gaps, POST /v1/gaps/{id}/assign, POST /v1/gaps/{id}/remediate, POST /v1/gaps/{id}/reassess',
        'POST /v1/review-snapshots and GET /v1/review-snapshots, POST /v1/review-snapshots/{id}/dossier, GET /v1/dossiers/{id}/download',
        'GET /v1/scan-jobs — evidence scan queue state for the tenant.',
        'POST /v1/scan-jobs/{id}/requeue — tenant-admin requeue of a dead job. Resets attempts and writes an audit event; manual database requeue is prohibited.',
        'GET /v1/audit/verify',
        'POST /v1/demo/reset — empties the demonstration tenant. It exists only where the maintenance principal is configured, which a deployment holding real data never does.',
      ]),
      h('Authorization'),
      p('Every route is authorized server-side against the permission registry. A caller lacking a permission receives 404 rather than 403, so an unauthorized caller cannot use error codes to map what exists.'),
      h('Security notes'),
      p('Tokens are bearer credentials. Never place one in a URL, a query string or a redirect target.'),
    ],
    related: ['security-model', 'architecture', 'acme-walkthrough'],
  },
  {
    slug: 'security-model',
    title: 'Security model',
    purpose: 'What protects the deployment, and what is deliberately not claimed.',
    audience: 'A security reviewer or an operator accepting risk.',
    prerequisites: [],
    body: [
      h('Identity and authorization'),
      ul([
        'Bearer tokens, verified server-side. No client-supplied tenant or actor header is trusted.',
        'Sessions are revocable. Signing out revokes on the server.',
        'Route-level authorization against a single permission registry, exposed for inspection at /v1/permissions.',
      ]),
      h('Tenant isolation'),
      p('PostgreSQL row-level security with FORCE RLS. The runtime database role is separate from the migration role, so the running application cannot alter its own schema.'),
      h('Evidence handling'),
      p('Uploads are quarantined and scanned before review is possible. Scanning fails closed: an unscanned file cannot be accepted, and an infected or expired one is refused rather than warned about.'),
      h('Integrity'),
      p('The audit chain is verifiable through /v1/audit/verify, which reports the number of events verified and the period they cover. Dossiers carry a SHA-256 manifest.'),
      h('Transport and web'),
      p('Security headers including a content security policy of script-src self, HSTS with a six-month max-age, and a CORS allowlist. No cookie is used for authentication, which is why CSRF is assessed as not applicable.'),
      h('What is not claimed'),
      ul([
        'No certification of any kind is claimed or implied.',
        'No independent penetration test has been performed.',
        'The redacting logger is wired into the running services: the API records authentication failures, authorization denials, rate-limit trips and internal errors, redacted by key and by value.',
        'Human security review of this release is outstanding.',
      ]),
      h('Reporting'),
      p('Report vulnerabilities as described in the vulnerability reporting page. Do not open a public issue for a security defect.'),
    ],
    related: ['vulnerability-reporting', 'known-limitations', 'api-reference'],
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    purpose: 'How the parts fit together and why the boundaries are where they are.',
    audience: 'An engineer evaluating or extending OpenPPWR.',
    prerequisites: [],
    body: [
      h('Runtime'),
      p('Four runtime components — web, api, worker and PostgreSQL — plus ClamAV for scanning. The web service is the only edge-facing hop and is the sole component trusted to determine the client address.'),
      h('Surfaces'),
      p('One application serves seven product surfaces. The server resolves the surface from the configured host map and states it in the served document; the browser renders accordingly. With no host map configured, one host serves every surface, which is the ordinary self-hosted shape.'),
      h('Data flow'),
      p('Packaging import is transactional: an invalid file is rejected in full, row by row, and nothing is written. Assessment persists its outcome with the exact rule version used, so a result can be explained later rather than recomputed and hoped to match.'),
      h('Review and dossier'),
      p('A frozen review snapshot is immutable input. The dossier is generated from the snapshot, not from live data, which is what makes it reproducible.'),
      h('Open core boundary'),
      p('Community contains the complete workflow under Apache-2.0. Maintained regulatory rule packs, managed operation, ERP connectors and advanced identity controls are separate commercial editions and are not present in this codebase.'),
    ],
    related: ['security-model', 'configuration', 'license'],
  },
  {
    slug: 'known-limitations',
    title: 'Known limitations',
    purpose: 'What this release does not do, stated before you find out.',
    audience: 'Anyone deciding whether to deploy it.',
    prerequisites: [],
    body: [
      h('Product'),
      ul([
        'The demonstration rule pack is deliberately small and is not authoritative regulatory content.',
        'German regulatory wording has not been approved by a qualified regulatory reviewer.',
        'One tenant per deployment. The data model is tenant-aware with verified RLS, but a single deployment does not operate several tenants: the worker processes only its own tenant, so another tenant\u2019s evidence would never be scanned. Bootstrap and the worker both refuse the unsupported topology.',
        'Cloud, Connect, Regulatory and Enterprise capabilities do not exist in this codebase.',
      ]),
      h('Operations'),
      ul([
        'Debian 13 x86_64 is the supported host. Other platforms are untested.',
        'Rollback across a migration that changed schema requires a restore, not a downgrade in place.',
        'ClamAV signature loading on first start leaves evidence scanning unavailable for several minutes, failing closed.',
      ]),
      h('Engineering'),
      ul([
        'Three packages ship in the source tree but are not reachable at runtime: compliance-core, packaging-master and reconciliation. Neither the observability package that holds the redacting logger nor the supplier-evidence package that builds the dossier ZIP is among them — both are imported and active in the running services.',
        'Documentation is maintained in English; Polish and German translations of the operational pages are outstanding.',
      ]),
      h('Assurance'),
      ul([
        'Human security, Polish product, German regulatory and legal reviews are all outstanding.',
        'No independent penetration test has been performed.',
      ]),
    ],
    related: ['release-notes', 'security-model', 'support'],
  },
  {
    slug: 'release-notes',
    title: 'Release notes',
    purpose: 'What changed, and what each change means for an operator.',
    audience: 'An operator deciding whether and how to upgrade.',
    prerequisites: [],
    body: [
      h('1.0.0'),
      p('A statement about stability rather than a list of features. What 1.0 adds is a written contract that says what this software promises across the 1.x line, what it refuses to promise, and, for each promise, the file that enforces it. It does not mean the product is finished, audited or certified. This is a release candidate: it has not been published, no image has been pushed to any registry, and it is held for an owner decision that has not been made.'),
      ul([
        'Self-hosting on your own domain works. The web tier reported a fabricated protocol to the API, so any deployment terminating TLS at its own reverse proxy had its own front end treated as a foreign origin and every request refused.',
        'The demonstration contains a demonstration: the catalogue is loaded, evidence is collected and reviewed and the assessment is run, leaving exactly the two gaps no evidence upload can close.',
        'The three published CSV samples import. Each carried a comment line that the importer read as the header, so this product rejected its own sample files; they are also now offered where the import box is.',
        'Interactive sign-in works on a deployment upgraded from before migration 014, and a deployment that advertises demonstration accounts it cannot serve is refused at startup rather than answering every sign-in with 404.',
        'The worker and service-account identities no longer hold a demonstration password. Bootstrap created one for all nine roles while the accounts panel offered seven, so two unannounced sign-ins existed at guessable addresses; a deployment that already has them is repaired by the migration this release runs, which also makes the database refuse those roles.',
        'Every disabled control states why it is disabled — visibly, in the tooltip, and to assistive technology.',
        'Polish and German screens no longer show English column headers or raw database values, and lists that stopped silently at a hundred rows now paginate and say how many of how many they show.',
        'The status page can report an outage instead of rendering an em-dash indistinguishable from a slow page load.',
        'The documented installer sequence works, and upgrade refreshes the installer copy on PATH.',
      ]),
      h('Upgrade note for 1.0.0'),
      p('The schema moves by one step. This release applies migration 039; the last 0.2.0-beta.1 source tree ended at migration 038. It defines no table, column, constraint or policy — it deletes the demonstration sign-in accounts that older builds created for the worker and service-account identities, and makes sign-in refuse those two roles in the database so a restored or hand-written row does not authenticate either. There is no rewrite and no long lock to wait on, and a deployment that never enabled demonstration sign-in has nothing to delete. That does not make the way back an image swap. Rollback is restore-based on this release as on every other: `upgrade` replaces the deployment’s compose file with the new release’s, which health-checks the API and the worker on `/health/ready` — a route this release adds and no 0.2.0-beta.1 build serves — so an image swapped back is marked unhealthy and everything waiting on it never starts. 0.2.0-beta.1 is also a range of builds rather than one artifact, and the recorded images under that version are at migration level 006. Use `openppwr-installer rollback`, which restores the compose file, the environment file and the data of the replaced generation together. Take the backup — `upgrade` takes one before it changes anything, and refuses to run on a deployment that has never run `backup-key init`.'),
      h('0.2.0-beta.1'),
      p('Minor version rather than a patch: it carries the schema from migration 004 to migration 038, and adds server-side session revocation, separate database principals for the API and the worker, per-identity credential rotation, evidence retention, new permissions and new endpoints.'),
      ul([
        'Sign-in with email and password, replacing a bootstrap-token-only flow that gave a new user nowhere to go.',
        'Server-side session revocation. Signing out invalidates the token rather than discarding it locally.',
        'Audit chain verification available to the role that runs the review.',
        'A /v1/version endpoint, so a deployment can state which build it is rather than leaving the question to container labels.',
        'Dossier downloads fixed; a refused download now reports its refusal instead of doing nothing.',
        'Demonstration reset fixed for tenants that had produced a gap.',
      ]),
      h('Upgrade note for 0.2.0-beta.1'),
      p('Do not roll back by swapping the image alone. This release advances the schema across many migrations that add tables, columns, constraints, row-level-security policies and database roles, so an older application will meet a schema it does not understand. Rolling back means restoring the database from a backup taken before the upgrade, together with the matching evidence volume — which is what `openppwr-installer rollback` does, and why it is restore-based rather than image-based. Take a backup before upgrading; without one there is no way back.'),
      h('Release state'),
      p('These notes describe what changed in a release. They do not state which build is serving this page, because a documentation page cannot know that: the version, revision and release channel of the running deployment are reported by `/v1/version` and shown in the build stamp at the foot of every page.'),
    ],
    related: ['upgrade-rollback', 'known-limitations', 'support'],
  },
  {
    slug: 'support',
    title: 'Support model',
    purpose: 'What support exists for Community, and what does not.',
    audience: 'Anyone planning to depend on OpenPPWR.',
    prerequisites: [],
    body: [
      h('Community'),
      p('Community is self-hosted software under Apache-2.0. It is provided without warranty and without a service level commitment. There is no support queue, no response time and no uptime obligation attached to it.'),
      h('Commercial'),
      p('Assessment, installation, migration, integration design, training and Design Partner work are offered commercially by Attentus under a separate agreement. Managed operation is the Cloud edition, which is in Private Beta with manual onboarding.'),
      h('What to do with a problem'),
      ul([
        'For a suspected security vulnerability, follow the vulnerability reporting page. Do not open a public issue.',
        'For a functional defect, gather the correlation identifier shown with the error and the output of /v1/version.',
        'For an operational failure, capture container state and the deployment logs before restarting, because a restart destroys the evidence of why it failed.',
      ]),
      h('What is not offered'),
      p('No response time is published for Community, because none is committed to. A page claiming otherwise would be inventing an obligation.'),
    ],
    related: ['vulnerability-reporting', 'known-limitations', 'contribution'],
  },
  {
    slug: 'vulnerability-reporting',
    title: 'Vulnerability reporting',
    purpose: 'Report a security defect so it can be fixed before it is exploited.',
    audience: 'Security researchers and operators.',
    prerequisites: [],
    body: [
      h('How to report'),
      p('Use the contact channel in SECURITY.md at the root of the repository. Do not open a public issue, and do not include exploit details in a public channel.'),
      h('What to include'),
      ul([
        'The version and revision from /v1/version.',
        'What you did, what happened, and what you expected.',
        'Whether the finding requires authentication, and at which role.',
        'Any correlation identifier shown by the interface.',
      ]),
      h('What to expect'),
      p('Acknowledgement, an assessment, and a fix or an explicit accepted-risk decision. No bounty is offered. No response timeline is committed to here, and claiming one would be an obligation nobody has agreed to.'),
      h('Safe harbour'),
      p('Test only against your own deployment. Do not test against the demonstration environment we operate at openppwr.eu, and do not access data that is not yours.'),
    ],
    related: ['security-model', 'support', 'license'],
  },
  {
    slug: 'contribution',
    title: 'Contribution and DCO',
    purpose: 'Contribute a change and have it accepted.',
    audience: 'Contributors.',
    prerequisites: ['A signed-off commit'],
    body: [
      h('Developer Certificate of Origin'),
      p('Every commit must carry a Signed-off-by line certifying the Developer Certificate of Origin, recorded in DCO.md. A contribution without it cannot be merged, because the project would have no record of the right to distribute it.'),
      code('git commit -s -m "your change"'),
      h('Before opening a change'),
      code('npm run format:check\nnpm run lint\nnpm run test:unit'),
      h('What a good change looks like'),
      ul([
        'One concern per change.',
        'A test that fails before the change and passes after it.',
        'Documentation updated in the same change, not afterwards.',
        'No customer data, no secrets, and no material you do not have the right to contribute.',
      ]),
      h('Code of conduct'),
      p('CODE_OF_CONDUCT.md applies to every interaction in the project.'),
      h('Current state'),
      p('The repository is not public yet, so contributions cannot be accepted through a public channel at this time.'),
    ],
    related: ['license', 'support', 'architecture'],
  },
  {
    slug: 'license',
    title: 'License, notices and trademarks',
    purpose: 'What you may do with the software, and what you may not do with the name.',
    audience: 'Anyone redistributing or building on OpenPPWR.',
    prerequisites: [],
    body: [
      h('Licence'),
      p('OpenPPWR Community is licensed under Apache-2.0. The full text is in LICENSE at the root of the repository. You may use, modify and redistribute it under those terms, including commercially.'),
      h('Notices'),
      p('NOTICE and THIRD_PARTY_NOTICES.md must be preserved in redistribution. The third-party inventory is generated from the dependency tree rather than maintained by hand, so it does not drift from what is actually shipped.'),
      h('Trademarks'),
      p('The Apache-2.0 licence covers the code, not the name. TRADEMARKS.md sets out permitted use of the OpenPPWR and Attentus names and marks. A fork may use the code; it may not present itself as OpenPPWR.'),
      h('What the licence does not give you'),
      p('No warranty, and no compliance guarantee. OpenPPWR supports packaging compliance processes; it does not certify or guarantee legal compliance, and no licence term changes that.'),
    ],
    related: ['contribution', 'known-limitations', 'architecture'],
  },
];

export const DOCS_INDEX = DOCS_PAGES.map(({ slug, title, purpose }) => ({ slug, title, purpose }));

const TRANSLATIONS = { pl: DOCS_PL, de: DOCS_DE };

// The nine the owner requires in all three languages. Named here rather than derived, so that adding
// a translation file cannot silently change what the policy gate considers required.
export const CRITICAL_SLUGS = Object.freeze([
  'quickstart', 'debian-installer', 'acme-walkthrough', 'backup-restore', 'upgrade-rollback',
  'security-model', 'known-limitations', 'support', 'vulnerability-reporting',
]);

export function isTranslated(slug, locale) {
  return Boolean(TRANSLATIONS[locale]?.[slug]);
}

// The page as it should be read in this locale. English is the source; a locale with a translation
// overrides title, purpose, audience, prerequisites and body together, never in part — a page half in
// one language reads as a defect even when both halves are correct.
export function docsPage(slug, locale = 'en') {
  const base = DOCS_PAGES.find((page) => page.slug === slug);
  if (!base) return null;
  const translated = TRANSLATIONS[locale]?.[slug];
  if (!translated) return { ...base, translated: false };
  return { ...base, ...translated, translated: true };
}

// The contents list, in the reader's language where one exists.
export function docsIndexFor(locale) {
  return DOCS_PAGES.map((page) => {
    const translated = TRANSLATIONS[locale]?.[page.slug];
    return {
      slug: page.slug,
      title: translated?.title || page.title,
      purpose: translated?.purpose || page.purpose,
      translated: Boolean(translated),
    };
  });
}

export const docsChrome = {
  en: {
    heading: 'Community documentation', intro: 'Install it, verify it, recover it, and understand what it does not do.',
    contents: 'Contents', onThisPage: 'On this page', purpose: 'Purpose', audience: 'Audience',
    prerequisites: 'Prerequisites', related: 'Related pages', lastValidated: 'Last validated against',
    previous: 'Previous', next: 'Next', search: 'Search documentation', noResults: 'No page matches that search.',
    englishOnly: 'Some technical documents are currently available in English only. The pages an operator needs to install, recover, secure and support a deployment are translated; the rest follow.', englishBody: 'English',
    copy: 'Copy', copied: 'Copied',
  },
  pl: {
    heading: 'Dokumentacja Community', intro: 'Zainstaluj, zweryfikuj, odtwórz i zrozum, czego produkt nie robi.',
    contents: 'Spis treści', onThisPage: 'Na tej stronie', purpose: 'Cel', audience: 'Odbiorca',
    prerequisites: 'Wymagania wstępne', related: 'Powiązane strony', lastValidated: 'Zweryfikowano względem',
    previous: 'Poprzednia', next: 'Następna', search: 'Szukaj w dokumentacji', noResults: 'Żadna strona nie pasuje.',
    englishOnly: 'Część dokumentów technicznych jest obecnie dostępna wyłącznie po angielsku. Strony potrzebne operatorowi do instalacji, odtworzenia, zabezpieczenia i utrzymania wdrożenia są przetłumaczone; pozostałe będą następne.', englishBody: 'Po angielsku',
    copy: 'Kopiuj', copied: 'Skopiowano',
  },
  de: {
    heading: 'Community-Dokumentation', intro: 'Installieren, prüfen, wiederherstellen — und verstehen, was sie nicht leistet.',
    contents: 'Inhalt', onThisPage: 'Auf dieser Seite', purpose: 'Zweck', audience: 'Zielgruppe',
    prerequisites: 'Voraussetzungen', related: 'Verwandte Seiten', lastValidated: 'Geprüft gegen',
    previous: 'Zurück', next: 'Weiter', search: 'Dokumentation durchsuchen', noResults: 'Keine Seite passt.',
    englishOnly: 'Einige technische Dokumente sind derzeit nur auf Englisch verfügbar. Die Seiten, die Betreibende zur Installation, Wiederherstellung, Absicherung und Unterstützung brauchen, sind übersetzt; die übrigen folgen.', englishBody: 'Auf Englisch',
    copy: 'Kopieren', copied: 'Kopiert',
  },
};
