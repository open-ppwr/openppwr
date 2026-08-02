# Rule Governance

Status: Mandatory; executable regulatory interpretation requires human approval.

Every rule contains:

- stable rule ID and semantic version;
- source reference and source version;
- publication date when relevant;
- effective-from/effective-to;
- draft/approved/withdrawn status;
- geography and applicability;
- required inputs and evidence;
- deterministic evaluation logic;
- localized explanation keys;
- regression/golden tests;
- reviewer status, reviewer identity and review time.

Rules are immutable after approved use. Corrections create new versions. Assessments retain exact rule/input/evidence snapshots. Community demonstration content stays clearly draft/basic until reviewed and never claims certification or guaranteed compliance.

Required lifecycle: draft → engineering review → regulatory/legal review → owner approval → approved. Withdrawal never deletes prior assessment references.
