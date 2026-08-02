// Stable, domain-neutral ports retained only where real OpenPPWR consumers require them.
export class ComplianceCorePorts {
  constructor({tenantContext,auditSink,evidenceStore,ruleEvaluator,approvalPolicy}) {
    for (const [name,value] of Object.entries({tenantContext,auditSink,evidenceStore,ruleEvaluator,approvalPolicy})) {
      if (!value) throw new TypeError(`Compliance Core port required: ${name}`);
    }
    Object.assign(this,{tenantContext,auditSink,evidenceStore,ruleEvaluator,approvalPolicy});
  }
}

export function requireFinalizationAllowed({dataClassification, action='approval'}) {
  if (dataClassification !== 'PRODUCTION_APPROVED') throw new Error(`DATA_CLASSIFICATION_BLOCKS_FINALIZATION:${action}`);
  return true;
}

export function createAssessmentSnapshot({assessmentId,tenantId,rule,input,evidence,result,exceptions=[],approvedBy=null,assessedAt=new Date().toISOString()}) {
  if (!assessmentId || !tenantId || !rule?.id || !rule?.version || !result) throw new TypeError('Incomplete assessment snapshot');
  return Object.freeze({assessmentId,tenantId,rule:Object.freeze({...rule}),input:structuredClone(input),evidence:structuredClone(evidence),result:structuredClone(result),exceptions:structuredClone(exceptions),approvedBy,assessedAt});
}
