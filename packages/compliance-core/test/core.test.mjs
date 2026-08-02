import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentSnapshot } from '../src/index.mjs';
import { requireFinalizationAllowed } from '../src/index.mjs';

test('assessment snapshot preserves exact rule version and evidence', () => {
  const value = createAssessmentSnapshot({assessmentId:'a',tenantId:'t',rule:{id:'r',version:2},input:{mass:10},evidence:[{id:'e',version:3}],result:{status:'needs_review'}});
  assert.equal(value.rule.version,2);
  assert.equal(value.evidence[0].version,3);
  assert.equal(value.result.status,'needs_review');
});
test('synthetic classification blocks finalization',()=>{assert.throws(()=>requireFinalizationAllowed({dataClassification:'SYNTHETIC',action:'EU_DECLARATION'}),/DATA_CLASSIFICATION_BLOCKS_FINALIZATION/);assert.equal(requireFinalizationAllowed({dataClassification:'PRODUCTION_APPROVED'}),true);});
