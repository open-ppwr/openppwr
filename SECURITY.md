# Security policy

## Supported versions

| Version | Security updates |
| --- | --- |
| `1.x` | Supported |
| `0.2.x` beta | Not supported — superseded by `1.0.0` |
| `0.1.x` beta | Not supported — superseded by `0.2.x` before any public release |
| Earlier private development versions | Not supported |

Support means Attentus will assess validated security defects and publish fix
or mitigation guidance when appropriate. No remediation deadline is promised for
Community unless a separate written support agreement applies, and nothing here
is a support commitment for anything other than a security report — `SUPPORT.md`
states that other side plainly. The one response target this project publishes is
the triage target below, and it is a target for answering you, not for fixing the
defect.

This table names the line, not a date. There is no published end-of-life
schedule for `1.x` and none is implied; if one is set it will appear here
rather than being announced elsewhere.

## Reporting a vulnerability

Report suspected vulnerabilities privately to `security@openppwr.eu`. That is the
address the website publishes, the address on the imprint, and the address to
prefer.

`office@attentus.pl` reaches the same people and no report sent there is turned
away. It is named here rather than replaced because this file previously gave it
as the only reporting address, and an address a researcher already holds should
not stop working the day a policy is tidied.

Do not open a public issue before coordinated disclosure. Include:

- affected component and exact version or commit;
- safe reproduction steps using synthetic data;
- expected impact and affected security boundary;
- known mitigations, if any;
- preferred contact details for follow-up.

Never include live credentials, customer data, uploads, dumps, private keys or
private-infrastructure details. Do not test systems, tenants or accounts you do
not own or have explicit authorization to assess.

## Triage targets

| Severity | Target for the first substantive response |
| --- | --- |
| Critical | typically 24–72 hours |
| High | typically 7 days |
| Medium | typically 30 days |

These are the same targets the website publishes, and they are stated here because
a disclosure policy that is quieter than the marketing page is the wrong way round:
a researcher should be able to read what to expect from the file that ships with
the software rather than from a page they may never visit.

A target is what it says. It is an intention to reach the report, assess it and
tell you what we found, measured from receipt. It is not a remediation deadline,
not a fix date, and not an availability commitment — the supported-versions
paragraph above still governs what happens after triage, and it promises
assessment and guidance rather than a schedule.

Disclosure timing will be coordinated with reporter after validation. Public
advisories will avoid exploit-enabling detail until reasonable mitigation is
available.

This policy does not authorize access to third-party systems, privacy violations
or disruption of service.
