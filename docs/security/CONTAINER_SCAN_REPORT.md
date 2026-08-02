# Container and supply-chain report

Status: **SUPERSEDED — see the 2026-08-01 section at the end of this file**, which records the current
result. The 2026-07-31 section below it records the failing scan that preceded it, and the 2026-07-28
`PASS` at the top was a Trivy-only run against an earlier candidate. Do not read either as the current
state of the release.

Original status line, kept for the record: *LOCAL BUILD/SCAN/SBOM PASS; PROVENANCE, SIGNING AND
PUBLICATION NOT RUN*
Date: 2026-07-28
Candidate: `ghcr.io/open-ppwr/openppwr:0.1.0-beta.1` (superseded by `0.2.0-beta.1`)

## Executed locally

Native Windows environment has no Docker, Podman, Grype, Syft, Trivy or Cosign executable. Native gate fails closed. Existing Debian WSL2 provides Docker Engine `29.6.1` and Trivy `0.72.0`; non-publishing WSL gate executed successfully.

Static and negative controls executed from repository root:

```powershell
npm ci --ignore-scripts
npm run release:image:validate
node scripts/release/validate-release-ref.mjs ghcr.io/open-ppwr/openppwr:latest
npm run release:image:gate
git diff --check
```

Results:

- dependency install/audit: PASS, 159 packages, zero vulnerabilities;
- supply-chain static validation: PASS, 15 root/workspace package records, zero `latest` image tags;
- release-reference tests: PASS, 7 tests including wrong version, registry, digest and `latest` negatives;
- direct `latest` validation: expected FAIL;
- runtime supply-chain gate: expected fail-closed result `Required tools missing: docker, grype, syft, trivy, cosign` before image build or artifact creation;
- whitespace validation: PASS.

## Executed WSL runtime gate

Command:

```powershell
npm run release:image:gate:wsl
```

Results on 2026-07-28: PASS for the initial candidate and PASS again after committing to a clean exact source revision. Image was not pushed.

- candidate image: `ghcr.io/open-ppwr/openppwr:0.1.0-beta.1` — the version current on 2026-07-28, superseded by `0.2.0-beta.1`;
- exact source revision and local image ID: recorded in the per-run ignored evidence directory;
- Trivy HIGH/CRITICAL image vulnerabilities: zero;
- Trivy HIGH/CRITICAL configuration findings: zero;
- SPDX JSON SBOM: generated;
- CycloneDX JSON SBOM: generated;
- checksums: `artifacts/supply-chain/SHA256SUMS`;
- provenance: `NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN`;
- signing: `NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN`;
- publication: false.

Evidence remains ignored runtime output under `artifacts/supply-chain`. The successful exact-clean-source rerun records its source revision and image ID. This gate must be repeated after any later tracked candidate change.

## Runtime gate definition

`npm run release:image:gate` builds exact candidate locally without pushing, then requires:

1. Grype v0.112.0 HIGH/CRITICAL image vulnerability gate;
2. Trivy v0.70.0 HIGH/CRITICAL Dockerfile/configuration gate;
3. Syft v1.44.0 SPDX JSON and CycloneDX JSON SBOMs;
4. source revision, image ID, tool versions, SHA-256 checksums and sanitized JSON evidence;
5. Cosign presence while leaving signing `NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN`.

Missing tools or scanner failures stop gate. Output stays under ignored `artifacts/supply-chain`.

`npm run release:image:gate:wsl` provides equivalent trusted WSL execution when native tools are absent. It pins installed Trivy to `0.72.0`, uses Docker Engine, runs HIGH/CRITICAL vulnerability and configuration gates, and emits SPDX JSON plus CycloneDX JSON. Provenance/signing remain publication-only protected workflow steps.

First WSL execution built digest-pinned Debian 12 slim candidate successfully, then correctly failed vulnerability gate with 27 findings: 21 HIGH and 6 CRITICAL. Candidate was not published. Runtime base was replaced with digest-pinned non-root Distroless Node.js 24 on Debian 13; successful rerun evidence is recorded above. Historical failing result is retained.

## Prepared protected GitHub workflow

`.github/workflows/release-image.yml` uses full-SHA-pinned actions and `public-release` environment. Default dispatch builds, scans and records evidence without publication. `publish: true` additionally requires exact `refs/tags/v0.2.0-beta.1` plus protected-environment approval. The Git tag carries the `v` prefix; the image tag is the bare SemVer `0.2.0-beta.1`.

Publish path pushes only already-built and successfully scanned local image. It records registry digest, creates GitHub/Sigstore SLSA build provenance and SPDX SBOM attestations, keylessly signs digest with Cosign v3.0.6, then verifies certificate identity and OIDC issuer. No long-lived signing key or registry token is introduced. Workflow never creates `latest` tag.

Pinned external tool versions:

- Grype `v0.112.0`;
- Syft `v1.44.0`;
- Trivy `v0.70.0` through post-incident SHA-pinned `trivy-action v0.36.0`;
- Cosign `v3.0.6` through SHA-pinned `cosign-installer v4.1.2`.

## Remaining release gate

After all other hard gates and explicit owner approval, execute the protected tagged publish run and verify GHCR digest, provenance, SBOM attestation and signature. Provenance, signing and publication remain blocked, not passed.

## 2026-07-31 — current result, and it is not a pass

Grype, Syft and Cosign were run for the first time in this programme. Every earlier `PASS` above came
from Trivy alone, so the scanner that now fails had never been executed against any candidate.

| Tool | Version | Result |
|---|---|---|
| Trivy | 0.72.0 | image vulnerabilities: **0** HIGH/CRITICAL; configuration: **0** HIGH/CRITICAL |
| Grype | 0.116.1 | **3 findings at or above High — gate exits non-zero** |
| Syft | 1.50.0 | SPDX and CycloneDX SBOMs generated |
| Cosign | v3.1.2 | installed and runnable; **no signing or publication performed** |

The three Grype findings are all in `libc6` in the distroless Debian 13 base image, and all are marked
`wont-fix` by Debian: `CVE-2026-5450` (Critical — `scanf` `%mc` with an explicit width above 1024),
`CVE-2026-5928` (High — `ungetwc` on a stream whose encoding overlaps single- and multi-byte forms) and
`CVE-2026-5435` (High — the deprecated resolver print functions `ns_printrrf`, `ns_printrr`,
`fp_nquery`).

Trivy reports zero for the identical image ID. That is a genuine disagreement between two scanners over
the same bytes, not a duplicate report, and it is recorded rather than resolved in favour of the
convenient answer.

**The disagreement was resolved on 2026-08-01 and this paragraph's framing was wrong.** It is not a
detection disagreement. See the next section.

**This is not an accepted risk.** None of the three code paths is called by this application or its
dependencies, and Debian has assessed and declined to patch all three — but that is engineering
judgement, and under the standard this programme follows the author of a control may not approve it.
It is recorded as an open risk requiring a named security reviewer's explicit accept-or-reject decision.
Until that decision exists, the honest status of the container gate is **FAIL, unaccepted**, and any
statement that vulnerability scanning gates this release is true only in the sense that it is currently
blocking it.

Operators who require a clean Critical/High container scan should not deploy this candidate.

## 2026-08-01 — the scanner disagreement, explained; and the CVEs resolved by removing glibc

### 1. The disagreement was never about detection

The 2026-07-31 section above records Grype finding three Critical/High CVEs and Trivy finding zero on
the identical image, and calls it "a genuine disagreement between two scanners over the same bytes".
That framing was wrong, and the working hypothesis recorded in the internal risk register — that Trivy excludes
unfixed vulnerabilities by default and so its zero might be reporting behaviour — was also wrong.
Trivy's `--ignore-unfixed` already defaults to `false`.

Trivy was re-run against the identical image (`sha256:154bb8800f34…`) with the severity filter removed
and `--ignore-unfixed=false` stated explicitly:

```
trivy image --scanners vuln --pkg-types os --ignore-unfixed=false openppwr:22c5518-supplychain
```

```
CVE-2026-5435 libc6 2.41-12+deb13u3 MEDIUM status= affected fixed= None
CVE-2026-5450 libc6 2.41-12+deb13u3 MEDIUM status= affected fixed= None
CVE-2026-5928 libc6 2.41-12+deb13u3 MEDIUM status= affected fixed= None
CVE-2026-6238 libc6 2.41-12+deb13u3 MEDIUM status= affected fixed= None
CVE-2010-4756 libc6 2.41-12+deb13u3 LOW    status= affected fixed= None
… 7 more LOW/negligible …
```

**Trivy detects all three CVEs, on the same package, at the same version. It rates them MEDIUM.** The
gate ran `--severity HIGH,CRITICAL`, so a MEDIUM finding is filtered out before it is counted. Trivy's
"zero" was the severity filter, not absence, and not unfixed-exclusion.

The severities differ because the two scanners inherit them from different third parties when Debian
assigns none. Debian marks all three `<no-dsa> (Minor issue)` and assigns no urgency. Trivy's record
for each carries `"SeveritySource": null` and a `VendorSeverity` map with **no `debian` and no `nvd`
key** — it falls back to Red Hat's CVSS, which scores them 5.0, 5.0 and 5.9. Grype takes NVD's, which
scores the same three 9.8, 7.5 and 7.3. The vectors are not close: NVD scores all three
`AV:N/AC:L/PR:N/UI:N`, Red Hat scores them `AV:L` or `AC:H/UI:R`.

So: one set of bytes, one set of findings, two inherited opinions about how bad they are. Neither
scanner missed anything. The correct reading of the 2026-07-31 evidence is that the image had three
unfixed `libc6` CVEs whose severity is genuinely disputed between NVD and Red Hat — not that one
scanner was wrong.

### 2. "wont-fix" was Grype's word, not Debian's

The internal risk register and `KNOWN_LIMITATIONS.md` both stated that Debian had "assessed and declined to patch" all
three, `wont-fix` rather than `no-dsa`-and-pending. That is not what Debian's tracker says. Grype
renders Debian's `<no-dsa>` annotation as `fix.state: "wont-fix"`; the annotation actually means no
Debian Security Advisory will be issued for the stable release, which is a statement about the advisory
process, not a refusal to ever fix. Checked against the Debian security tracker on 2026-08-01:

| CVE | trixie (the base) | bookworm | sid / unstable | Debian annotation |
|---|---|---|---|---|
| CVE-2026-5450 | vulnerable, 2.41-12+deb13u3 | — | **fixed, 2.42-17** | `<no-dsa> (Minor issue)` |
| CVE-2026-5928 | vulnerable, 2.41-12+deb13u3 | vulnerable | **fixed, 2.42-17** | `<no-dsa> (Minor issue)` |
| CVE-2026-5435 | vulnerable, 2.41-12+deb13u3 | vulnerable | **vulnerable, 2.42-17** | `<no-dsa> (Minor issue)`; bullseye `<postponed>` |

Two of the three are already fixed in unstable. The third is unfixed in **every** glibc Debian ships,
including unstable, and the tracker lists no fixed version for it anywhere.

### 3. Why no newer Debian base could resolve it

- The pinned runtime digest `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11c…` was pulled
  fresh on 2026-08-01 and **is** the digest the `:nonroot` tag currently resolves to. There is no newer
  distroless digest to move to.
- Trixie carries no fixed `libc6`, so any future `nodejs24-debian13` digest would carry the same three.
- `gcr.io/distroless/nodejs24-debian12:nonroot` was scanned as an alternative and is far worse:
  **21 High/Critical**, including all three `libc6` CVEs plus eleven `libssl3` findings and
  `CVE-2026-21710` against node 24.14.0.
- Because CVE-2026-5435 is unfixed upstream, **no Debian release of any vintage resolves all three.**

### 4. Chainguard was rejected on evidence, not on preference

`cgr.dev/chainguard/node:latest` scans clean — Grype reports zero. That zero does not mean what it
appears to. The image ships `usr/lib/libc.so.6` and its own SBOM names `glibc-2.43-r11`: it **has**
glibc. glibc 2.43 plausibly carries the fixes for CVE-2026-5450 and CVE-2026-5928, but CVE-2026-5435 is
unfixed upstream, so the clean result for that CVE is Wolfi's advisory feed having no entry rather than
the defect being absent. It also ships `usr/bin/sh`, `usr/bin/ash` and busybox, so it is not
shell-free. Adopting it would have replaced a reported problem with an unreported one — exactly the
failure mode this exercise was meant to avoid.

### 5. What was changed

The three findings are properties of glibc. They are removed by removing glibc.

- Runtime base: `gcr.io/distroless/nodejs24-debian13:nonroot` →
  `gcr.io/distroless/static-debian13:nonroot@sha256:f7f8f729…`, which contains **no libc at all** —
  only `base-files`, `media-types`, `netbase`, `tzdata` and the CA bundle.
- Node is taken from `node:24-alpine@sha256:f70403e8…` and is musl-linked. Four files are copied into
  the static base: `ld-musl-x86_64.so.1`, `libstdc++.so.6`, `libgcc_s.so.1` and the `node` binary.
- The build stage moved to the same `node:24-alpine` digest, so `npm ci` resolves platform-specific
  optional dependencies against the libc the runtime actually has.
- `ENTRYPOINT ["/nodejs/bin/node"]` is now stated explicitly, because `distroless/static` declares none
  where the `nodejs` variant did.
- A build-stage assertion fails the build if any glibc-linked ELF reaches the shipped tree. The pruned
  tree is pure JavaScript today — **zero ELF files under `/app`, verified** — and the assertion exists
  so that a future native dependency stops the build rather than producing an image that cannot start.

Every property the distroless base was chosen for is retained: no shell, no package manager, no
interactive user, numeric non-root `65532:65532`.

### 6. Measured result

Image built from the committed `Dockerfile` in WSL `openppwr-d13-test`, Docker Engine 29.7.0.
`image_id=sha256:583a4c200bdf854a9e552079742b1be9bb41cd6c20d9921df830090eea7b5d7d`.

| Tool | Version | Command | Result |
|---|---|---|---|
| Grype | 0.116.1 | `grype openppwr:risk31-final -o table` | `No vulnerabilities found` |
| Grype | 0.116.1 | `grype … --fail-on high` | **exit 0** |
| Trivy | 0.72.0 | `trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1` | 0 findings, **exit 0** |
| Trivy | 0.72.0 | `trivy image --scanners vuln --ignore-unfixed=false` (all severities) | **0 findings** |
| Syft | 1.50.0 | `syft … -o json` | 5 `deb`, 1 `binary` (`node 24.18.1`), 124 `npm` |

For comparison, the same `grype --fail-on high` against the previous image exits **2** and lists the
three CVEs — the gate still bites, so exit 0 is a result and not a gate that stopped running.

Package surface, before → after:

```
removed: gcc-14-base, libc6, libgcc-s1, libgomp1, libssl3t64, libstdc++6, libzstd1, zlib1g
kept:    base-files, media-types, netbase, tzdata, tzdata-legacy
runtime: node 24.18.0 (glibc)  ->  node 24.18.1 (musl)
```

Absence of glibc is verified by listing the exported filesystem, not by trusting a scanner's zero. The
only shared libraries in the image are:

```
usr/lib/ld-musl-x86_64.so.1
usr/lib/libgcc_s.so.1
usr/lib/libstdc++.so.6
```

and there is no match for `libc.so.6`, `ld-linux*`, `busybox`, `bin/sh`, `bin/bash`, `bin/ash`,
`bin/apk`, `bin/apt`, `bin/dpkg` or `bin/npm`.

### 7. Status of each CVE under this change

| CVE | Status | Basis |
|---|---|---|
| CVE-2026-5450 (Critical) | **Gone by construction** | The vulnerable code is in glibc. The image contains no glibc. Fixed in Debian only in unstable, never in trixie. |
| CVE-2026-5928 (High) | **Gone by construction** | As above. |
| CVE-2026-5435 (High) | **Gone by construction** | As above, and this one is **unfixable by any Debian base** — no fixed glibc exists in any suite including unstable. |

"Gone by construction" is the accurate claim, and it is stronger than "patched": there is no version of
the affected component present to be vulnerable. It is not a claim that musl has no defects of its own.

### 8. Trade-offs, stated rather than buried

- **musl is not glibc.** `dns.lookup` (and therefore `fetch` and `http`) resolves through musl's
  `getaddrinfo`. musl 1.2.6 supports TCP fallback and search domains, but its resolver behaviour,
  thread stack defaults and locale support are not identical to glibc's. Verified working in the
  candidate: `dns.lookup`, an outbound HTTPS `fetch` returning 200, and `crypto` hashing. The
  application uses no `worker_threads` and no native modules.
- **Native modules.** The shipped tree contains zero ELF files, so nothing needed recompiling. This is
  a fact about the current dependency set, not a permanent property — hence the build-stage assertion.
- **Scanner visibility for OpenSSL and zlib.** `libssl3t64` and `zlib1g` were previously cataloged as
  OS packages and are now gone. Node did not use them: it reports OpenSSL 3.5.7 in both images while
  Debian shipped 3.5.6, so Node has always used its own statically bundled OpenSSL and zlib. The change
  removes unused shipped copies rather than removing coverage of what Node executes — but it is true
  that the OpenSSL Node actually runs is not visible to OS-package scanning, and was not before either.
  It is covered only by the `node` binary CVE feed, which is confirmed live: Grype flags
  `CVE-2026-21710` and nine others against node 24.14.0 in the debian12 image, so a clean node result
  is a real result.
- **We now compose the base rather than consume one.** Both inputs are upstream-maintained and
  digest-pinned, and the composition is four `COPY` lines, but Node/musl upgrades are now our
  responsibility on both pins instead of one.
- **`distroless/static` is not rebuilt as often as the language variants.** If a CVE ever lands in
  `base-files`, `netbase`, `media-types` or `tzdata`, it must be tracked on that image's cadence.

### 9. Not verified

- The full deployed E2E and DAST suites were **not** re-run against the musl image. What was verified
  is that the application's module graph loads to the point of its own configuration check
  (`OPENPPWR_DATABASE_URL is required.`), that DNS and TLS work, and that the process runs as uid
  65532. A functional re-run against a live stack is still required before this candidate is released.
- No performance comparison between musl and glibc was made.
- The image was built for `linux/amd64` only. `arm64` was not built or scanned.
- Provenance, signing and publication remain `NOT_RUN_LOCAL_PUBLICATION_FORBIDDEN`, unchanged.
