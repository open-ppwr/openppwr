import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeValidJsonImport } from '@openppwr/testing';
import { VerdictStubScanner, processNextScanJob } from '@openppwr/worker';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';
import { createApp, createVerifiedContext } from '../src/app.mjs';

let database;
let pool;
let workerPool;
let server;
let baseUrl;
let identities;
const storageRoot = resolve('.runtime-test', `assessment-${randomUUID()}`);

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

function auth(role, contentType = 'application/json') {
  return { authorization: `Bearer ${identities[role].token}`, 'content-type': contentType };
}

before(async () => {
  database = await startTestDatabase('api-assessment');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  workerPool = createPool(database.workerUrl);
  const bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken:bootstrapSecret, storageRoot });
  await new Promise((resolveListen) => { server = app.listen(0,'127.0.0.1',resolveListen); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await jsonRequest('/v1/bootstrap', { method:'POST',headers:{'content-type':'application/json','x-openppwr-bootstrap-token':bootstrapSecret},body:'{}' });
  identities = created.body.identities;
  const imported = await jsonRequest('/v1/imports', { method:'POST',headers:{...auth('packaging_editor'),'idempotency-key':'assessment-catalog'},body:JSON.stringify(createAcmeValidJsonImport()) });
  assert.equal(imported.response.status,201);
  const listed = await jsonRequest('/v1/evidence-requirements', { headers:{authorization:`Bearer ${identities.evidence_contributor.token}`} });
  const requirements = [...new Map(listed.body.items.map((item) => [item.supplier_id,item])).values()];
  const worker = await createVerifiedContext(pool,identities.worker.token);
  for (const requirement of requirements) {
    const form = new FormData();
    form.set('requirementId',requirement.id);
    form.set('supplierId',requirement.supplier_id);
    form.set('evidenceType',requirement.evidence_type);
    form.set('file',new Blob([Buffer.from(`%PDF-1.4\nSynthetic accepted ${requirement.supplier_id}\n`)],{type:'application/pdf'}),`declaration-${requirement.supplier_id}.pdf`);
    const uploaded = await jsonRequest('/v1/evidence',{method:'POST',headers:{authorization:`Bearer ${identities.evidence_contributor.token}`},body:form});
    assert.equal(uploaded.response.status,202);
    assert.equal((await processNextScanJob({pool:workerPool,identity:worker,storageRoot,scanner:new VerdictStubScanner({runtime:'test'})})).scanStatus,'clean');
    const reviewed = await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`,{method:'POST',headers:auth('evidence_reviewer'),body:JSON.stringify({decision:'accepted'})});
    assert.equal(reviewed.response.status,200);
  }
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await pool?.end();
  await workerPool?.end();
  await database?.stop();
  await rm(storageRoot,{recursive:true,force:true});
});

test('exact rule/evidence snapshots produce all four outcomes and deduplicated gaps', async () => {
  const run = await jsonRequest('/v1/assessments/run',{method:'POST',headers:auth('compliance_manager'),body:'{}'});
  assert.equal(run.response.status,201);
  assert.ok(run.body.outcomes.PASS > 0);
  assert.ok(run.body.outcomes.FAIL > 0);
  assert.ok(run.body.outcomes.UNKNOWN > 0);
  assert.ok(run.body.outcomes.NOT_APPLICABLE > 0);
  assert.equal(run.body.ruleId,'OPENPPWR-DEMO-RC');
  assert.equal(run.body.ruleVersion,'1.0.0');
  const listed = await jsonRequest('/v1/gaps',{headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
  assert.equal(listed.body.items.length,2);
  const snapshots = await database.admin.query('SELECT rule_version,input_snapshot,evidence_snapshot FROM assessments');
  assert.equal(snapshots.rows.every((row) => row.rule_version === '1.0.0'),true);
  assert.equal(snapshots.rows.some((row) => row.evidence_snapshot.length > 0),true);
});

test('assignment, remediation and reassessment close gaps without deletion', async () => {
  const listed = await jsonRequest('/v1/gaps',{headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
  for (const gap of listed.body.items) {
    const assign = await jsonRequest(`/v1/gaps/${gap.id}/assign`,{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({ownerId:identities.compliance_manager.id})});
    assert.equal(assign.body.status,'assigned');
    const remediate = await jsonRequest(`/v1/gaps/${gap.id}/remediate`,{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({notes:'Synthetic correction',packagingPatch:{recycledContentPct:40}})});
    assert.equal(remediate.body.status,'remediated');
    const reassessed = await jsonRequest(`/v1/gaps/${gap.id}/reassess`,{method:'POST',headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
    assert.equal(reassessed.response.status,201);
    assert.equal(reassessed.body.results[0].outcome,'PASS');
    assert.ok(reassessed.body.results[0].supersedesId);
  }
  const final = await jsonRequest('/v1/gaps',{headers:{authorization:`Bearer ${identities.read_only_auditor.token}`}});
  assert.equal(final.body.items.length,2);
  assert.equal(final.body.items.every((gap) => gap.status === 'closed'),true);
  assert.equal(final.body.items.every((gap) => gap.history.some((event) => event.action === 'closed_by_reassessment')),true);
});

test('ready-for-review freezes state and generates verified JSON/PDF/ZIP/manifest', async () => {
  const frozen = await jsonRequest('/v1/review-snapshots',{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({locale:'en'})});
  assert.equal(frozen.response.status,201);
  assert.equal(frozen.body.status,'READY_FOR_REVIEW');
  assert.equal(frozen.body.auditVerification.valid,true);
  const generated = await jsonRequest(`/v1/review-snapshots/${frozen.body.id}/dossier`,{method:'POST',headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
  assert.equal(generated.response.status,201);
  assert.equal(generated.body.artifacts.length,4);
  const contents = {};
  for (const artifact of generated.body.artifacts) {
    const response = await fetch(`${baseUrl}/v1/dossiers/${artifact.id}/download`,{headers:{authorization:`Bearer ${identities.read_only_auditor.token}`}});
    assert.equal(response.status,200);
    const content = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(content).digest('hex'),artifact.sha256);
    contents[artifact.artifactType] = content;
  }
  assert.match(contents.json.toString('utf8'),/fictional and generated exclusively/);
  assert.equal(contents.pdf.subarray(0,8).toString('ascii'),'%PDF-1.4');
  assert.equal(contents.zip.subarray(0,2).toString('ascii'),'PK');
  assert.equal(JSON.parse(contents.manifest).algorithm,'SHA-256');
  const verified = await jsonRequest('/v1/audit/verify',{headers:{authorization:`Bearer ${identities.read_only_auditor.token}`}});
  assert.equal(verified.body.valid,true);
  assert.ok(verified.body.count > 0);
});
