import { createHash } from 'node:crypto';

export const ASSESSMENT_OUTCOMES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']);

const REQUIRED_RULE_FIELDS = Object.freeze([
  'id', 'version', 'sourceReference', 'publicationDate', 'effectiveFrom', 'status',
  'reviewerStatus', 'requiredInputs', 'requiredEvidence', 'applicability', 'checks',
]);

function clone(value) {
  return structuredClone(value);
}

export function validateAssessmentRule(rule) {
  if (!rule || typeof rule !== 'object') throw new TypeError('Rule is required.');
  const missing = REQUIRED_RULE_FIELDS.filter((field) => rule[field] === undefined || rule[field] === null);
  if (missing.length) throw Object.assign(new Error(`Rule metadata missing: ${missing.join(', ')}`), { code: 'RULE_METADATA_MISSING' });
  if (!Array.isArray(rule.requiredInputs) || !Array.isArray(rule.requiredEvidence) || !Array.isArray(rule.checks)) {
    throw Object.assign(new Error('Rule inputs, evidence and checks must be arrays.'), { code: 'RULE_SCHEMA_INVALID' });
  }
  if (!['draft', 'approved', 'withdrawn'].includes(rule.status)) {
    throw Object.assign(new Error('Rule status is invalid.'), { code: 'RULE_STATUS_INVALID' });
  }
  for (const check of rule.checks) {
    if (!check.id || !check.input || !check.operator || !check.explanationKey) {
      throw Object.assign(new Error('Rule check metadata is incomplete.'), { code: 'RULE_CHECK_INVALID' });
    }
  }
  return rule;
}

function compare(actual, operator, expected) {
  switch (operator) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gte': return Number(actual) >= Number(expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'includes': return Array.isArray(actual) && actual.includes(expected);
    default: throw Object.assign(new Error(`Unsupported rule operator: ${operator}`), { code: 'RULE_OPERATOR_UNSUPPORTED' });
  }
}

function notApplicable(rule, input, date) {
  if (rule.status === 'withdrawn') return 'withdrawn';
  if (date < new Date(`${rule.effectiveFrom}T00:00:00.000Z`)) return 'before_effective_date';
  if (rule.effectiveTo && date > new Date(`${rule.effectiveTo}T23:59:59.999Z`)) return 'after_effective_date';
  const countries = rule.applicability?.countries || [];
  if (countries.length && !countries.includes(input.country)) return 'country_out_of_scope';
  const packagingTypes = rule.applicability?.packagingTypes || [];
  if (packagingTypes.length && !packagingTypes.includes(input.packagingType)) return 'packaging_type_out_of_scope';
  return null;
}

function validEvidence(items, type) {
  return items.find((item) => item.type === type && item.status === 'accepted' && item.scanStatus === 'clean' && !item.expired);
}

export function evaluateAssessment({ assessmentId, rule: candidateRule, input = {}, evidence = [], at = new Date() }) {
  if (!assessmentId) throw new TypeError('assessmentId is required.');
  const rule = validateAssessmentRule(candidateRule);
  const date = new Date(at);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Assessment date is invalid.');

  const scopeReason = notApplicable(rule, input, date);
  if (scopeReason) {
    return {
      id: assessmentId,
      outcome: 'NOT_APPLICABLE',
      ruleId: rule.id,
      ruleVersion: rule.version,
      inputSnapshot: clone(input),
      evidenceIds: [],
      trace: [{ code: scopeReason, passed: true }],
      missingInputs: [],
      missingEvidence: [],
      evaluatedAt: date.toISOString(),
    };
  }

  const missingInputs = rule.requiredInputs.filter((name) => input[name] === undefined || input[name] === null || input[name] === '');
  const evidenceByType = new Map(rule.requiredEvidence.map((type) => [type, validEvidence(evidence, type)]));
  const missingEvidence = [...evidenceByType].filter(([, item]) => !item).map(([type]) => type);
  const evidenceIds = [...evidenceByType.values()].filter(Boolean).map((item) => item.id).sort();

  if (missingInputs.length || missingEvidence.length) {
    return {
      id: assessmentId,
      outcome: 'UNKNOWN',
      ruleId: rule.id,
      ruleVersion: rule.version,
      inputSnapshot: clone(input),
      evidenceIds,
      trace: [
        ...missingInputs.map((name) => ({ code: 'required_input_missing', field: name, passed: false })),
        ...missingEvidence.map((type) => ({ code: 'required_evidence_missing', evidenceType: type, passed: false })),
      ],
      missingInputs,
      missingEvidence,
      evaluatedAt: date.toISOString(),
    };
  }

  const trace = rule.checks.map((check) => ({
    checkId: check.id,
    explanationKey: check.explanationKey,
    actual: input[check.input],
    operator: check.operator,
    expected: check.value,
    passed: compare(input[check.input], check.operator, check.value),
  }));
  return {
    id: assessmentId,
    outcome: trace.every((item) => item.passed) ? 'PASS' : 'FAIL',
    ruleId: rule.id,
    ruleVersion: rule.version,
    inputSnapshot: clone(input),
    evidenceIds,
    trace,
    missingInputs: [],
    missingEvidence: [],
    evaluatedAt: date.toISOString(),
  };
}

function gapId(assessmentId, discriminator) {
  return `GAP-${createHash('sha256').update(`${assessmentId}:${discriminator}`).digest('hex').slice(0, 24).toUpperCase()}`;
}

export function createGaps(assessment) {
  if (!['FAIL', 'UNKNOWN'].includes(assessment?.outcome)) return [];
  const failedChecks = (assessment.trace || []).filter((item) => item.passed === false);
  return failedChecks.map((item) => {
    const discriminator = item.checkId || item.field || item.evidenceType || item.code;
    return {
      id: gapId(assessment.id, discriminator),
      assessmentId: assessment.id,
      ruleId: assessment.ruleId,
      ruleVersion: assessment.ruleVersion,
      code: item.checkId || item.code,
      explanationKey: item.explanationKey || item.code,
      status: 'open',
      ownerId: null,
      remediationEvidenceIds: [],
      history: [],
    };
  });
}

export function assignGap(gap, { ownerId, actorId, at = new Date() }) {
  if (!ownerId || !actorId) throw new TypeError('ownerId and actorId are required.');
  return {
    ...clone(gap),
    ownerId,
    status: 'assigned',
    history: [...(gap.history || []), { action: 'assigned', actorId, ownerId, at: new Date(at).toISOString() }],
  };
}

export function addRemediationEvidence(gap, { evidenceId, actorId, at = new Date() }) {
  if (!evidenceId || !actorId) throw new TypeError('evidenceId and actorId are required.');
  const remediationEvidenceIds = [...new Set([...(gap.remediationEvidenceIds || []), evidenceId])].sort();
  return {
    ...clone(gap),
    status: 'remediated',
    remediationEvidenceIds,
    history: [...(gap.history || []), { action: 'remediation_evidence_added', actorId, evidenceId, at: new Date(at).toISOString() }],
  };
}
