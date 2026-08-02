# Known limitations — 1.0.0 candidate

- Release is not public or approved yet.
- **A human security review binds this release, and its independence is narrower than the phrase usually implies.** It was performed on the revision this release ships, by a reviewer who wrote none of the code, schema or gates under review, working through the judgement-required areas with six of the fifteen adversarial attempts executed in front of them rather than read about. That reviewer owns the product: independent of the authorship, **not** independent of the organisation. **No third-party security assessment and no external penetration test has been carried out**, and none is claimed. An earlier review exists against `0.2.0-beta.1`; it does not bind this release, and is not being counted twice.
- **Eleven of the fifteen adversarial attempts in that review were not made**, and six deployment-dependent gate stages — including DAST and the two-tenant isolation matrix — did not run at this revision. The reviewer was offered a run against a live deployment before deciding and declined it. That is a decision about sufficiency, recorded as one; it is not coverage.
- Legal review of the privacy, cookie and company information has **not** been performed by a qualified lawyer, and every page carrying that information says so.
- German regulatory wording carries an internal preview annotation rather than qualified regulatory review, and says so in German. Statements that would have described the state of the legislation rather than the state of this product were withheld rather than published on that basis.
- Polish product wording has had no separate review gate assigned, which is a gap in the process rather than a finding about the text.
- Community demonstration rule `OPENPPWR-DEMO-RC` is deliberately small, non-authoritative and requires human regulatory review. OpenPPWR supports readiness processes; it does not certify or guarantee compliance.
- Supported candidate image is `linux/amd64` only. No `arm64`, HA or zero-downtime claim.
- ClamAV is an external private dependency. Signature freshness, resource sizing and availability are operator responsibilities; failures remain closed.
- Scan holds one job transaction/row lock during bounded file read and clamd call, up to 30 seconds. `SKIP LOCKED` permits other workers to take other jobs. Claims are lease-based: a claimed job carries a lease (`OPENPPWR_WORKER_JOB_LEASE_MS`, default 300000) after which another worker may reclaim it, so a worker killed mid-scan no longer strands its evidence as permanently pending.
- Worker retry uses two separate budgets. The **item** budget is fixed at three attempts for beta rollback compatibility and is spent on content failures — `OPENPPWR_WORKER_MAX_ATTEMPTS` is bounded to exactly 3 and cannot be tuned. The **infrastructure** budget (`OPENPPWR_WORKER_MAX_INFRASTRUCTURE_ATTEMPTS`, default 12, range 1..100) is separate, is spent on scanner outages, and retries with bounded exponential backoff, so a clamd outage does not consume an evidence item's three attempts. Dead jobs require tenant-admin audited requeue.
- **One tenant per deployment.** OpenPPWR Community Public Beta supports exactly one tenant per deployment
  by owner decision. Multi-tenant orchestration is *Planned / Unsupported in Beta*, and the
  boundary is enforced rather than documented: `/v1/bootstrap` refuses a second tenant, and the worker
  refuses to start — and refuses to keep working, on a periodic recheck — when the database holds more than
  one. The data model remains tenant-aware with row-level security throughout.

  This entry previously said "Multi-tenant deployments require separately managed worker identities and
  processes", which described a topology the product now refuses at startup. A reader following it would
  have designed a deployment that fails closed.
- One-time bootstrap returns bearer credentials but has no dedicated secret-manager bootstrap CLI. Operators must capture them through approved local process and remove/rotate bootstrap capability.
- Offline backup/restore, current-migration idempotency, versioned N-1 upgrade/rollback and immutable
  container/volume-loss recovery all pass against a real Debian 13 installer deployment. Immutable recovery
  was rehearsed end-to-end on 2026-07-31: full teardown (containers, named volumes and the deployment root),
  fresh install and configure against the same pinned image, then restore from a backup copy held outside the
  deployment tree, with the restored data verified identical to the pre-loss state. Independent environment
  validation — the same rehearsals performed by someone other than the author, on a host they control —
  remains open, and remains the point of the exercise.
- **The runtime image no longer contains glibc, and the three Critical/High CVEs are gone.** Until
  2026-08-01 the runtime base was `gcr.io/distroless/nodejs24-debian13`, whose `libc6` carried
  `CVE-2026-5450` (Critical), `CVE-2026-5928` and `CVE-2026-5435` (High). None was fixable on Debian:
  trixie ships no fixed `libc6`, the pinned digest was already the newest, and CVE-2026-5435 is unfixed
  in every glibc Debian ships including unstable. The runtime is now `distroless/static-debian13`, which
  contains no libc at all, running a musl-linked Node taken from `node:24-alpine`. Grype 0.116.1 and
  Trivy 0.72.0 both report zero findings at every severity. The image has since been exercised
  functionally on a real Debian 13 host: the full twenty-one-step demonstration end to end, the black-box
  scan with twenty-three checks and no failures, and DNS resolution measured over a thousand sequential
  and two hundred concurrent lookups per service. The dossier PDFs are byte-identical under musl and
  glibc — same digest for all three locales — so font subsetting, glyph selection and line breaking are
  unaffected. What remains unverified is narrower than the change: musl's `search`-domain handling was not
  exercised because the container runtime generated no search list, dual-stack IPv6 was not available, and
  the shipped deployment does not use TLS to PostgreSQL. See
  `docs/security/CONTAINER_SCAN_REPORT.md` for the scan output and the trade-offs.
- Public GHCR provenance, SBOM attestation, Cosign signature, domain publication and public clean installation cannot run before exact-package owner approval.
- German regulatory text remains draft until human review; EN is fallback for missing translations.
