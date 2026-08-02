# Community Demonstration Rule Pack

Status: engineering draft; `REQUIRES HUMAN REGULATORY REVIEW`. It supports readiness workflow demonstrations and does not guarantee or certify legal compliance.

## `OPENPPWR-DEMO-RC` version `1.0.0`

- Source reference: Regulation (EU) 2025/40 demonstration subset; non-authoritative.
- Publication date recorded by runtime: 2025-02-28.
- Effective range: from 2025-01-01; no end date in the demonstration version.
- Lifecycle: `draft`.
- Reviewer status: `requires_human_regulatory_review`.
- Required input: `recycledContentPct`.
- Required evidence: `RECYCLED_CONTENT_DECLARATION` from the exact requirement linked to this rule version.
- Applicability: sales, grouped and reusable packaging; demonstration geography is not restricted.
- Evaluation: known value at least 30 produces `PASS`; known lower value produces `FAIL`; missing input/evidence produces `UNKNOWN`; out-of-scope packaging produces `NOT_APPLICABLE`.
- Explanation key: `assessment.recycled_content.minimum`.

## Traceability

Each assessment stores the rule ID/version FK, immutable input snapshot, selected evidence IDs/versions/checksums, decision trace, evaluation identity and time. Rule versions used by assessments are not updated in place. Regression evidence lives in assessment unit tests and the PostgreSQL API integration journey.

