# Release notes — 1.0.0

**This release has not been published.** It is a private candidate held for an owner decision that has not
been made. No tag exists, no image has been pushed to a registry, and no announcement has been issued. The
version below is what the candidate carries, not a record that it shipped.

| | |
|---|---|
| Version | `1.0.0` |
| Licence | Apache-2.0 |
| Deployment | Self-hosted. Debian 13 x86_64 is the supported host; the candidate image is `linux/amd64` only |
| Schema | migration `039` — one migration ahead of the final `0.2.0-beta.1` source tree (see "The upgrade runs one migration") |
| Release SHA | see below — one revision, and this file deliberately does not name it |
| Image digest | recorded in the release manifest; not a registry digest until publication is approved |
| Release date | NOT_VERIFIED — no date is set, because publication is not approved |

**One revision produces everything in this release**: the source, the image built from it, its SBOMs, the
clean install, the public export and the export's root commit. Anything reporting a different one is
reporting a different build.

That revision is not written here, and the omission is deliberate rather than an oversight. A file cannot
contain the hash of the commit that adds it, so a release SHA typed into this page can only ever name the
commit *before* the release — and an earlier revision of this page did exactly that, then had to explain at
length why a running deployment reported something else. Naming it in the one place it cannot be correct is
worse than not naming it.

Three places name it, and all three are produced by the thing they describe rather than typed:

- `/v1/version` on any deployment, as `revision` — the image reports what it was built from.
- `PUBLIC_RELEASE_MANIFEST_1_0_0.json`, which binds source, image, SBOMs and export together. Read the
  next paragraph before treating its `source.revision` as evidence.
- `git log` in this repository, where the release commit is the one that carries this file.

If those three disagree, believe the deployment and treat the release as unfrozen.

**The manifest's `source.revision` is an attested claim, not something you can verify**, and it is worth
saying so rather than letting a bare commit hash read as evidence. This project is developed in a private
repository and published as a single-commit export of a reviewed file set — the architecture decision
record for that is in the tree. So the revision named there does not exist in the history you can clone,
and no amount of checking will make it appear. What you *can* verify is everything downstream of it: the
tag resolves to the root commit, the root commit yields the file tree, and the tree hashes to the
`contentDigest` the manifest records, which you can recompute yourself. Treat the private revision as a
statement Attentus makes about provenance, and the digest chain as the part that answers to arithmetic.

The image digest is **not a registry digest**. Nothing has been pushed, so no registry has been asked to
confirm anything; this is the digest the local build computed, and it is recorded so that the image a
reviewer builds can be compared with the one that was scanned. It becomes a registry digest only if and when
publication is approved and the exact scanned image is pushed — the workflow that would do so is gated on an
explicit input and has never been run.

## What 1.0 means, and what it does not

1.0 is a statement about **stability**, not a list of new features. What it adds is a written contract —
`COMMUNITY_1_0_RELEASE_CONTRACT.md` — that says what this software promises across the 1.x line, what it
refuses to promise, and, for each promise, the file that enforces it. Promises that nothing enforces are
listed there as gaps rather than asserted, because a promise nothing checks is marketing.

It does not mean the product is finished, audited, or certified. Read "What is not claimed" below before
deciding what this release is suitable for.

## The upgrade runs one migration

An earlier draft of these notes said the schema did not move. That stopped being true when a real defect on
live deployments needed repairing in the database rather than in the application, so it is stated plainly
here instead: the schema goes from migration `038` to migration `039`, and `039` is the only one that runs.

It does two things, both described under "A machine identity can no longer sign in" below: it deletes the
demonstration password accounts that `bootstrap` used to create for the `worker` and `service_account`
identities, and it makes sign-in refuse those roles in the database, so a row put back later still does not
authenticate. It touches no table definition, adds no column, no constraint, no index and no policy, and
takes no lock on a table a request path uses beyond the moment it runs. On a deployment that never enabled
demonstration sign-in it deletes nothing and changes only the two sign-in functions, which that deployment
does not call.

That is a statement about the upgrade, not about the way back. Rollback is restore-based on this release
exactly as on every other, and putting the old image reference back does not undo the upgrade — it stops
the deployment. It was restore-based when the schema was not moving at all; this migration adds a second
reason without changing the procedure. "Rollback" below gives them, each checkable in the shipped files.

## What changed since `0.2.0-beta.1`

The candidate was tested as a real user would use it, and a functional audit followed. Both found defects
the automated suite had not, and this release is mostly those fixes. They are listed plainly because
several of them would have met a first-time self-hoster on day one.

**Self-hosting on your own domain now works.** The web tier reported a fabricated protocol to the API
rather than the one the browser used, so any deployment terminating TLS at its own reverse proxy — which is
every real one — had its own front end classified as a foreign origin and every request answered `403`.
The defect was invisible on the project's own hostnames, which the built-in allowlist happens to name.
`OPENPPWR_CORS_ALLOWED_ORIGINS`, the documented escape hatch, was never wired into the shipped Compose file
and so could not work either. Both fixed; the API's same-origin check is unchanged, because what was wrong
was its input.

**The demonstration now contains a demonstration.** `bootstrap-acme` created an ACME tenant with nine
identities and an empty catalogue: six empty screens and no dossier reachable. It now loads the catalogue,
collects and reviews evidence and runs the assessment, leaving exactly two open gaps — the two that no
evidence upload can close. An evaluator still performs a genuine remediation before the review will freeze,
and now reaches the dossier in minutes rather than after eighteen uploads.

**The sample files work, and can be found.** All three published CSV samples were rejected by this
product's own importer: each carries a fiction marker on its first line, and the parser read that line as
the header. Leading comment lines are now skipped before the header and only before it. The files were also
unreachable on a multi-host deployment — they rendered on the two pages that redirect elsewhere — and are
now offered on the demonstration surface and beside the import box itself.

**Interactive sign-in works on an upgraded deployment.** The upgrade path back-filled one of the four
database principals later migrations introduced, so a deployment carrying `OPENPPWR_DEMO_LOGIN=true` from
before migration 014 never gained the credential that performs a sign-in, and the role was retired exactly
as documented. The API meanwhile kept advertising the demonstration accounts it was refusing. All four
principals are back-filled, the contradiction is refused at startup, and the accounts panel is gated on the
same credential the sign-in is.

**A machine identity can no longer sign in.** `bootstrap` minted an identity for all nine roles and then
handed the published demonstration password to every one of them, while the accounts panel offered seven.
`worker@<domain>` and `service-account@<domain>` therefore had a working sign-in at a guessable address on
the default demonstration posture, announced by nothing — and `service_account` reads the whole tenant, runs
assessments, and generates and downloads the dossiers. Provisioning now covers the seven roles a person
signs in as and no others. Because that only governs a deployment created afterwards, migration `039`
deletes the accounts a deployment already holds and makes both halves of sign-in refuse those two roles in
the database, so an account restored from a backup or written back by hand does not authenticate either.
This affects only deployments running with `OPENPPWR_DEMO_LOGIN=true`; the bearer credentials an operator
holds for those identities are untouched, because a worker needs one to do its job.

**The interface explains itself.** Every disabled control now states why — not signed in, role, an earlier
step, or an operation in progress — visibly, in the tooltip, and to assistive technology. Previously there
were twenty-seven disabled controls and one explanation, so a greyed button could equally mean "your role
may not", "do step five first", or "this is broken".

**Polish and German screens no longer show English.** The catalogue rendered English column headers and raw
database values in both, and the gate written to catch exactly that could not see either. Lists also
stopped silently at a hundred rows while the summary beside them showed the true total; both routes now
paginate and the interface says how many of how many it is showing.

**The status page can say "down".** It rendered an em-dash when it could not read the build, so during an
outage the one surface whose job is to report availability was indistinguishable from a slow page load. A
genuinely unreachable service is also no longer reported as a server error asking for a support reference
that cannot exist.

**The documented installer sequence works.** It silently depended on a side effect of an earlier step that
no page mentioned, and `upgrade` never refreshed the copy it installs onto `PATH` — so on a long-lived
deployment that command did not exist, and on a newer one it could be older than the deployment it managed.

**Navigation exists outside the marketing pages.** The site-level navigation was private to one module, so
structurally absent everywhere else.

**Audit immutability is documented correctly.** The reset documentation described the audit chain as
erasable by `TRUNCATE` and the fix as pending. Migration 007 has contained the statement-level trigger that
closes it since long before this release; the documentation understated the product.

## What this release also adds: gates that stop the class, not the instance

Each fix above is paired with an assertion that makes its failure mode hard to re-enter. The browser suite
now renders the screens a person actually reaches, in all three languages — the catalogue had never been
rendered by any automated run, which is precisely why the translation defect survived every gate. The
release contract is machine-checked against the code. Documented installer commands are checked against the
installer's own command table. The sample files are checked as the bytes that ship rather than as the
generator's output, which is how three broken samples passed every import test.

## Rollback

Rollback is restore-based on this release as on every other, and `openppwr-installer rollback` is the only
supported way back. An image swap back to `0.2.0-beta.1` does not work, for two independent reasons.

`upgrade` replaces the deployment's Compose file with the new release's, and the refreshed file
health-checks `api` and `worker` on `/health/ready` — a route this release adds, which no `0.2.0-beta.1`
build serves. It answers `404`, the container is marked unhealthy and is not restarted for being unhealthy,
and `web` and `worker` both wait on the API being healthy, so neither starts. Separately, `0.2.0-beta.1`
names a range of builds rather than one artifact: every image recorded under it in
this project's internal source-deployment provenance record sits at migration level `006`, thirty-three
levels behind this release.
The schema distance to any image that could actually be swapped to has never been one migration, and it is
not one now.

`rollback` restores the Compose file, the environment file, the database and the evidence volume of the
pre-upgrade generation together. It needs the backup `upgrade` takes and records before it changes
anything, and the private backup key, without which it refuses at exit `92` having changed nothing.
`UPGRADE_NOTES_1.0.0.md` states the sequence and what to have ready first.

## Known limitations that matter to an operator

The complete list is `KNOWN_LIMITATIONS.md`, and the enforcement gaps are in the 1.0 contract. These change
a deployment decision:

- **No qualified lawyer has reviewed the privacy, cookie or company information**, and the site says so on
  every page carrying it. Disclosed, not resolved.
- **German regulatory wording carries an internal preview annotation, not qualified regulatory review**,
  and says so in German. Statements that would have described the state of the legislation rather than the
  state of this product were withheld rather than published on that basis.
- **A human security review binds this release; a third-party one does not exist.** The reviewer wrote none
  of the controls under review, so the review is independent of the authorship. They own the product, so it
  is not independent of the organisation. No external assessment and no penetration test has been carried
  out. `KNOWN_LIMITATIONS.md` states what was and was not attempted; automated analysis remains
  supplementary, because a program is not a named person.
- The demonstration rule pack is deliberately small and is not authoritative regulatory content.
- One tenant per deployment, refused at startup rather than merely unsupported.
- `linux/amd64` only. No `arm64`, no high availability, no zero-downtime claim.
- **The API has liveness but readiness is newly added** — check the contract for its current enforcement
  state before relying on it for load-balancer decisions.
- **Only Chromium is exercised by the browser suite.** Firefox and Safari are untested rather than
  unsupported, and the contract says so.
- ClamAV is an external dependency and scanning fails closed: evidence cannot be reviewed until it has been
  scanned, so an unavailable scanner stops review rather than waving files through.
- The runtime image contains no C library at all — `distroless/static` with a musl-linked Node runtime — so
  the glibc findings an earlier base carried are gone by construction rather than argued away.
- Three packages ship in the source tree and are never reachable at runtime.
- Independent environment validation — installer, backup, restore, upgrade and recovery rehearsed by
  someone other than their author, on a host they control — remains open.

## What is not claimed

No certification of any kind. No independent penetration test. No third-party audit. No uptime or
availability figure. No SLA, other than the security-disclosure handling in `SECURITY.md`. No guarantee of
regulatory compliance: OpenPPWR supports a readiness process, and certifies nobody.

## Upgrading

`UPGRADE_NOTES_1.0.0.md` states what to do, in order. `docs/deployment/BACKUP_RESTORE_UPGRADE.md` covers
backup, restore and recovery in general.
