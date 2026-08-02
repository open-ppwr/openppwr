import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssessment, createGaps, assignGap, addRemediationEvidence } from '../src/index.mjs';

const rule = {
  id: 'OPENPPWR-DEMO-MATERIAL-001',
  version: '1.0.0',
  sourceReference: 'Demonstration rule — not legal advice',
  publicationDate: '2026-01-01',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  status: 'draft',
  reviewerStatus: 'engineering_review',
  requiredInputs: ['country', 'packagingType', 'recycledContentPercent'],
  requiredEvidence: ['RECYCLED_CONTENT_DECLARATION'],
  applicability: { countries: ['DE', 'PL'], packagingTypes: ['sales'] },
  checks: [{ id: 'minimum-recycled-content', input: 'recycledContentPercent', operator: 'gte', value: 30, explanationKey: 'assessment.minimumRecycledContent' }],
};

const evidence = [{ id: 'ACME-EVD-001', type: 'RECYCLED_CONTENT_DECLARATION', status: 'accepted', scanStatus: 'clean', expired: false }];

test('produces PASS with exact rule/evidence references', () => {
  const result = evaluateAssessment({ assessmentId: 'A-1', rule, input: { country: 'PL', packagingType: 'sales', recycledContentPercent: 35 }, evidence, at: '2026-07-28' });
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.ruleVersion, '1.0.0');
  assert.deepEqual(result.evidenceIds, ['ACME-EVD-001']);
});

test('produces FAIL, UNKNOWN and NOT_APPLICABLE without hard-coded success', () => {
  assert.equal(evaluateAssessment({ assessmentId: 'A-2', rule, input: { country: 'PL', packagingType: 'sales', recycledContentPercent: 10 }, evidence, at: '2026-07-28' }).outcome, 'FAIL');
  assert.equal(evaluateAssessment({ assessmentId: 'A-3', rule, input: { country: 'PL', packagingType: 'sales' }, evidence: [], at: '2026-07-28' }).outcome, 'UNKNOWN');
  assert.equal(evaluateAssessment({ assessmentId: 'A-4', rule, input: { country: 'FR', packagingType: 'sales', recycledContentPercent: 35 }, evidence, at: '2026-07-28' }).outcome, 'NOT_APPLICABLE');
});

test('creates deterministic gaps and preserves remediation history', () => {
  const assessment = evaluateAssessment({ assessmentId: 'A-5', rule, input: { country: 'PL', packagingType: 'sales', recycledContentPercent: 10 }, evidence, at: '2026-07-28' });
  const [gap] = createGaps(assessment);
  assert.equal(gap.status, 'open');
  const assigned = assignGap(gap, { ownerId: 'ACME-USER-001', actorId: 'ACME-USER-002', at: '2026-07-28T10:00:00.000Z' });
  const remediated = addRemediationEvidence(assigned, { evidenceId: 'ACME-EVD-002', actorId: 'ACME-USER-001', at: '2026-07-29T10:00:00.000Z' });
  assert.equal(remediated.status, 'remediated');
  assert.equal(remediated.history.length, 2);
  assert.deepEqual(remediated.remediationEvidenceIds, ['ACME-EVD-002']);
});
