import { createHash, randomUUID } from 'node:crypto';
import { createGaps, evaluateAssessment } from '@openppwr/assessment';
import { appendAudit, withTenantTransaction } from '@openppwr/database';

function serviceError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

function mapRule(row) {
  return {
    id: row.rule_id,
    version: row.version,
    sourceReference: row.source_reference,
    publicationDate: row.publication_date.toISOString().slice(0, 10),
    effectiveFrom: row.effective_from.toISOString().slice(0, 10),
    effectiveTo: row.effective_to?.toISOString().slice(0, 10) || null,
    status: row.lifecycle_status,
    reviewerStatus: row.reviewer_status,
    requiredInputs: row.required_inputs,
    requiredEvidence: row.required_evidence,
    applicability: row.applicability,
    checks: row.checks,
  };
}

// Exported so the identifier contract can be tested against the producer rather than against a copy of
// it. A validator proved correct against a replica of the derivation proves nothing about the derivation
// nothing about the derivation: the two can drift, and the test would keep passing.
export function gapIdentity(tenantId, packagingId, ruleId, discriminator) {
  const hash = createHash('sha256').update(`${tenantId}:${packagingId}:${ruleId}:${discriminator}`).digest('hex').slice(0, 24).toUpperCase();
  return { id: `GAP-${hash}`, deduplicationKey: discriminator };
}

async function synchronizeGaps(client, identity, packagingId, assessmentId, result, at) {
  const failed = new Map();
  for (const item of (result.trace || []).filter((entry) => entry.passed === false)) {
    const discriminator = item.checkId || item.field || item.evidenceType || item.code;
    failed.set(discriminator, item);
  }
  const existing = await client.query('SELECT * FROM gaps WHERE packaging_id=$1 AND rule_id=$2 FOR UPDATE', [packagingId,result.ruleId]);
  const byKey = new Map(existing.rows.map((gap) => [gap.deduplication_key,gap]));
  for (const [discriminator, trace] of failed) {
    const current = byKey.get(discriminator);
    const event = { action: current?.status === 'closed' ? 'reopened' : 'assessment_linked', actorId: identity.actorId, assessmentId, at };
    if (current) {
      const status = ['closed','remediated'].includes(current.status) ? 'reopened' : current.status;
      await client.query(`UPDATE gaps SET current_assessment_id=$1,rule_version=$2,status=$3,history=$4::jsonb,updated_at=$5 WHERE id=$6`, [assessmentId,result.ruleVersion,status,JSON.stringify([...(current.history || []),event]),at,current.id]);
    } else {
      const key = gapIdentity(identity.tenantId,packagingId,result.ruleId,discriminator);
      await client.query(
        `INSERT INTO gaps (tenant_id,id,packaging_id,rule_id,rule_version,deduplication_key,current_assessment_id,status,history) VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8::jsonb)`,
        [identity.tenantId,key.id,packagingId,result.ruleId,result.ruleVersion,key.deduplicationKey,assessmentId,JSON.stringify([{ action:'created', actorId:identity.actorId, assessmentId, code:trace.checkId || trace.code, at }])],
      );
    }
  }
  for (const gap of existing.rows) {
    if (!failed.has(gap.deduplication_key) && gap.status !== 'closed') {
      await client.query(`UPDATE gaps SET current_assessment_id=$1,status='closed',history=$2::jsonb,updated_at=$3 WHERE id=$4`, [assessmentId,JSON.stringify([...(gap.history || []),{action:'closed_by_reassessment',actorId:identity.actorId,assessmentId,at}]),at,gap.id]);
    }
  }
}

// The advisory-lock key shared with `freezeReviewSnapshot`. An assessment run creates, reopens and closes
// gaps, and a review freeze reads them to decide whether the review is complete — so the two must not
// interleave, and a lock only excludes the parties that take it. Namespaced away from the audit chain's key,
// which locks on the tenant identifier alone.
export const reviewSerializationKey = (tenantId) => `review-freeze:${tenantId}`;

// Reclassified from the (default) interactive class to extended on 2026-08-01: unlike `assignGap` and
// `remediateGap`, which touch one gap, this loops the whole packaging catalogue in one transaction — the
// same "walks a whole tenant" shape `freezeReviewSnapshot`, `generateDossier` and `verifyAuditChain`
// already carry the extended class for, and named as exactly that shape in the comment above
// `DEADLINE_VARIABLES` in `packages/database/src/index.mjs` before this reclassification closed it. A
// statement timeout sized for a single-row interactive read would have been miscalibrated for the
// thousands of per-packaging statements this issues; extended is the class measured for that. This
// changes only which `statement_timeout` applies when an operator has set one — the response shape,
// status codes and business logic below are unchanged.
export async function runAssessments(pool, identity, { packagingIds = null, at = new Date() } = {}) {
  return withTenantTransaction(pool, identity, async (client) => {
    // Taken before any read, and in the same order as the freeze takes it, so the pair cannot deadlock:
    // both acquire this key first and the audit chain's key second.
    //
    // Without it the freeze's readiness check and its gap read saw two different committed states under
    // READ COMMITTED, and a gap created in between passed the check and then appeared inside the frozen
    // review — an artifact stating the review was complete while containing an open gap.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reviewSerializationKey(identity.tenantId)]);
    const ruleResult = await client.query(`SELECT * FROM rule_versions WHERE lifecycle_status IN ('draft','approved') AND effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1) ORDER BY effective_from DESC,version DESC LIMIT 1`, [at.toISOString().slice(0,10)]);
    if (!ruleResult.rowCount) throw serviceError('RULE_VERSION_NOT_FOUND', 'No effective Community rule version is available.', 409);
    const rule = mapRule(ruleResult.rows[0]);
    const parameters = [];
    let sql = 'SELECT * FROM packaging';
    if (Array.isArray(packagingIds) && packagingIds.length) { parameters.push(packagingIds); sql += ' WHERE id = ANY($1::text[])'; }
    sql += ' ORDER BY id';
    const packages = await client.query(sql, parameters);
    const responses = [];
    for (const item of packages.rows) {
      const evidenceResult = await client.query(
        `SELECT DISTINCT ON (e.evidence_type) e.id,e.evidence_type,e.version,e.sha256,e.scan_status,e.review_status,e.expires_at
         FROM evidence_files e JOIN evidence_requirements r ON r.tenant_id=e.tenant_id AND r.id=e.requirement_id
         WHERE e.supplier_id=$1 AND r.rule_id=$2 AND r.rule_version=$3 AND e.scan_status='clean' AND e.review_status='accepted'
         ORDER BY e.evidence_type,e.version DESC,e.created_at DESC`,
        [item.supplier_id,rule.id,rule.version],
      );
      const evidence = evidenceResult.rows.map((row) => ({
        id: row.id,
        type: row.evidence_type,
        version: row.version,
        sha256: row.sha256,
        status: row.review_status,
        scanStatus: row.scan_status,
        expiresAt: row.expires_at?.toISOString() || null,
        expired: Boolean(row.expires_at && row.expires_at <= at),
      }));
      const assessmentId = randomUUID();
      const input = { packagingId:item.id,packagingType:item.packaging_type,country:item.country,recycledContentPct:item.recycled_content_pct === null ? null : Number(item.recycled_content_pct) };
      const result = evaluateAssessment({ assessmentId, rule, input, evidence, at });
      const prior = await client.query(`SELECT id FROM assessments WHERE packaging_id=$1 AND rule_id=$2 AND status='completed' ORDER BY evaluated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [item.id,rule.id]);
      if (prior.rowCount) await client.query(`UPDATE assessments SET status='superseded' WHERE id=$1`, [prior.rows[0].id]);
      await client.query(
        `INSERT INTO assessments (tenant_id,id,packaging_id,rule_id,rule_version,supersedes_id,input_snapshot,evidence_snapshot,evaluated_by,evaluated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
        [identity.tenantId,assessmentId,item.id,rule.id,rule.version,prior.rows[0]?.id || null,JSON.stringify(input),JSON.stringify(evidence),identity.actorId,at.toISOString()],
      );
      await client.query(
        `INSERT INTO assessment_results (tenant_id,id,assessment_id,outcome,explanation,missing_inputs,missing_evidence,evidence_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
        [identity.tenantId,randomUUID(),assessmentId,result.outcome,JSON.stringify(result.trace),JSON.stringify(result.missingInputs),JSON.stringify(result.missingEvidence),JSON.stringify(result.evidenceIds)],
      );
      await synchronizeGaps(client, identity, item.id, assessmentId, result, at.toISOString());
      await appendAudit(client, { tenantId: identity.tenantId, actorId: identity.actorId, action: 'assessment.completed', entityType: 'assessment', entityId: assessmentId, payload: { packagingId:item.id,ruleId:rule.id,ruleVersion:rule.version,outcome:result.outcome,evidenceIds:result.evidenceIds }, occurredAt:at.toISOString() });
      responses.push({ assessmentId, packagingId:item.id, outcome:result.outcome, ruleId:rule.id, ruleVersion:rule.version, supersedesId:prior.rows[0]?.id || null, evidenceIds:result.evidenceIds, trace:result.trace });
    }
    return { ruleId:rule.id, ruleVersion:rule.version, results:responses, outcomes:Object.fromEntries(['PASS','FAIL','UNKNOWN','NOT_APPLICABLE'].map((outcome) => [outcome,responses.filter((item) => item.outcome === outcome).length])) };
  }, { deadline: 'extended' });
}

export async function assignGap(pool, identity, { gapId, ownerId, at = new Date() }) {
  if (!ownerId) throw serviceError('GAP_OWNER_REQUIRED', 'Gap owner is required.');
  return withTenantTransaction(pool, identity, async (client) => {
    // Every writer of `gaps` takes the review lock, not only the ones that create them.
    //
    // The first version of this fix put the lock in `runAssessments` and `freezeReviewSnapshot` and stopped
    // there. An advisory lock excludes only the parties that take
    // it: this function commits a gap status change without it, so a change landing after the
    // freeze's final check and before its commit was still invisible — the same window, reached by a
    // different route. Acquired before the row is read, and before the audit lock, so the order matches
    // every other holder and the pair cannot deadlock.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reviewSerializationKey(identity.tenantId)]);
    const selected = await client.query('SELECT * FROM gaps WHERE id=$1 FOR UPDATE', [gapId]);
    if (!selected.rowCount) throw serviceError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
    const gap = selected.rows[0];
    const owner = await client.query('SELECT id FROM identities WHERE id=$1 AND active=true', [ownerId]);
    if (!owner.rowCount) throw serviceError('GAP_OWNER_INVALID', 'Gap owner is invalid.', 422);
    const history = [...(gap.history || []),{action:'assigned',actorId:identity.actorId,ownerId,at:at.toISOString()}];
    await client.query(`UPDATE gaps SET owner_id=$1,status='assigned',history=$2::jsonb,updated_at=$3 WHERE id=$4`, [ownerId,JSON.stringify(history),at.toISOString(),gapId]);
    await appendAudit(client, { tenantId:identity.tenantId,actorId:identity.actorId,action:'gap.assigned',entityType:'gap',entityId:gapId,payload:{ownerId},occurredAt:at.toISOString() });
    return { id:gapId,status:'assigned',ownerId };
  });
}

export async function remediateGap(pool, identity, { gapId, notes, evidenceIds = [], packagingPatch = {}, at = new Date() }) {
  return withTenantTransaction(pool, identity, async (client) => {
    // Every writer of `gaps` takes the review lock, not only the ones that create them.
    //
    // The first version of this fix put the lock in `runAssessments` and `freezeReviewSnapshot` and stopped
    // there. An advisory lock excludes only the parties that take
    // it: this function commits a gap status change without it, so a change landing after the
    // freeze's final check and before its commit was still invisible — the same window, reached by a
    // different route. Acquired before the row is read, and before the audit lock, so the order matches
    // every other holder and the pair cannot deadlock.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reviewSerializationKey(identity.tenantId)]);
    const selected = await client.query('SELECT * FROM gaps WHERE id=$1 FOR UPDATE', [gapId]);
    if (!selected.rowCount) throw serviceError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
    const gap = selected.rows[0];
    if (!gap.owner_id) throw serviceError('GAP_OWNER_REQUIRED', 'Assign the gap before remediation.', 409);
    if (evidenceIds.length) {
      const evidence = await client.query(`SELECT id FROM evidence_files WHERE id=ANY($1::uuid[]) AND scan_status='clean' AND review_status='accepted'`, [evidenceIds]);
      if (evidence.rowCount !== evidenceIds.length) throw serviceError('REMEDIATION_EVIDENCE_INVALID', 'Remediation evidence must be clean and accepted.', 422);
    }
    if (Object.hasOwn(packagingPatch,'recycledContentPct')) {
      const value = packagingPatch.recycledContentPct;
      if (!(Number(value) >= 0 && Number(value) <= 100)) throw serviceError('RECYCLED_CONTENT_INVALID', 'Recycled content must be between 0 and 100.', 422);
      await client.query('UPDATE packaging SET recycled_content_pct=$1,updated_at=$2 WHERE id=$3', [Number(value),at.toISOString(),gap.packaging_id]);
    }
    const mergedEvidence = [...new Set([...(gap.remediation_evidence_ids || []),...evidenceIds])].sort();
    const history = [...(gap.history || []),{action:'remediated',actorId:identity.actorId,notes:notes || null,evidenceIds:mergedEvidence,packagingPatch,at:at.toISOString()}];
    await client.query(`UPDATE gaps SET status='remediated',remediation_notes=$1,remediation_evidence_ids=$2::jsonb,history=$3::jsonb,updated_at=$4 WHERE id=$5`, [notes || null,JSON.stringify(mergedEvidence),JSON.stringify(history),at.toISOString(),gapId]);
    await appendAudit(client, { tenantId:identity.tenantId,actorId:identity.actorId,action:'gap.remediated',entityType:'gap',entityId:gapId,payload:{evidenceIds:mergedEvidence,packagingPatch},occurredAt:at.toISOString() });
    return { id:gapId,status:'remediated',packagingId:gap.packaging_id,evidenceIds:mergedEvidence };
  });
}

export function assessmentDomainGapPreview(result) { return createGaps(result); }

