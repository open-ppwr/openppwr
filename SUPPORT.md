# Support

OpenPPWR Community is self-hosted software published under Apache License 2.0. This page states what
support exists, what does not, and where each kind of question belongs — so that you can decide whether
that is enough for your situation before you deploy it, rather than afterwards.

## What Community support is

**Community support is best effort and carries no service level commitment.** There is no response time, no
remediation time, no support queue and no ticket system. Nothing on this page promises that a question will
be answered, and no schedule is implied by anything here.

If you need a commitment, it has to be a separate written agreement. This page is not one, and neither is
any reply you receive through the channels below.

## Where to take a question

| You have | Use | Do not use |
|---|---|---|
| A suspected security vulnerability | The private channel in [`SECURITY.md`](SECURITY.md) | A public issue, ever |
| Software behaving differently from the documentation | A [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) | Discussions |
| A usage question, or "is this supposed to work like this" | GitHub Discussions | An issue |
| A proposal for a change | A [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) | A pull request without one |
| A trademark or licensing question | The address in [`TRADEMARKS.md`](TRADEMARKS.md) | An issue |

Before opening anything, please check [`docs/release/KNOWN_LIMITATIONS.md`](docs/release/KNOWN_LIMITATIONS.md)
and section 6 of [`docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md`](docs/release/COMMUNITY_1_0_RELEASE_CONTRACT.md).
Several behaviours that look like defects are documented, deliberate refusals — the software declines an
unsupported configuration instead of degrading quietly, and the refusal message names the reason.

## What is in scope

- The software in this repository, at a released version, running on a supported platform: Debian 13 on
  x86_64, Docker with Compose v2, one tenant per deployment.
- The installer subcommands, the documented first-run sequence, and backup, restore, upgrade and rollback.
- The documentation in this repository, where it does not match the software.

## What is out of scope

Not because these are unimportant, but because Community makes no commitment about them and saying so is
more useful than implying otherwise:

- **Regulatory advice.** OpenPPWR supports a readiness process. It does not certify anything, no output of
  it is a certificate, and nobody here can tell you whether you are compliant. The shipped rule pack is a
  demonstration pack and is not authoritative regulatory content.
- **Legal advice**, including on the privacy, cookie and company-information text that ships with the
  product. That text has not been reviewed by a qualified lawyer, and the shipped pages say so.
- **Unsupported platforms and topologies:** any host other than Debian 13 x86_64, `arm64`, more than one
  tenant per deployment, high availability, zero-downtime upgrade, and browsers other than Chromium-based
  ones.
- **Your infrastructure:** your PostgreSQL if you supply your own, your ClamAV signature freshness and
  sizing, your reverse proxy, your TLS, your backups once they leave the deployment, and the private backup
  key. Restore and rollback need that key; if it is lost, no support channel can recover your data.
- **Modified builds.** A patched fork is welcome under the licence and is yours to support.
- **Data recovery.** There is no mechanism through which anyone here can access your deployment, and that
  is deliberate: the software has no telemetry, no phone-home and no hosted component.

## Supported versions

Security-update scope is stated in [`SECURITY.md`](SECURITY.md) and that table is the authority. Only the
current minor line receives attention; older lines are superseded rather than maintained in parallel.

Upgrade compatibility is asserted for the immediately preceding version only. There is no test matrix over
older versions, and no gate prevents a migration that would break one. Upgrade in sequence.

## Before you report anything

A report that includes these can be acted on; one that does not, usually cannot:

1. The version and revision from `GET /v1/version` on the affected deployment.
2. How the deployment was created — installer, manual Compose, or a development checkout.
3. What you expected and what happened instead. Both, not one.
4. Numbered reproduction steps **using synthetic data only**. The ACME sample set that ships with the
   product is fictional and may be used freely.

**Everything you put in a public issue is public immediately.** Remove bearer credentials, e-mail addresses,
hostnames, customer material and anything else identifying your infrastructure before you submit, not
afterwards. Deployment logs in particular carry credentials and file names.

## Commercial support

Maintained regulatory rule packs, managed operation, ERP connectors and advanced identity controls are
separate commercial editions and are not in this codebase. Enquiries about a commercial arrangement,
including any support commitment, go to `office@attentus.pl` — the company address, the same one
[`TRADEMARKS.md`](TRADEMARKS.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) use. This paragraph
previously pointed at "the address in `SECURITY.md`", which was the company address at the time and is
now a dedicated vulnerability mailbox; leaving the pointer would have routed sales enquiries into the
disclosure channel. Nothing about the terms of such an arrangement is stated here.
