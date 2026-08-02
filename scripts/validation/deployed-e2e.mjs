// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';

const required=['OPENPPWR_E2E_BASE_URL','OPENPPWR_E2E_PACKAGING_EDITOR_TOKEN','OPENPPWR_E2E_EVIDENCE_CONTRIBUTOR_TOKEN','OPENPPWR_E2E_EVIDENCE_REVIEWER_TOKEN','OPENPPWR_E2E_COMPLIANCE_MANAGER_TOKEN','OPENPPWR_E2E_COMPLIANCE_MANAGER_ID','OPENPPWR_E2E_AUDITOR_TOKEN','OPENPPWR_E2E_SUPPLIER_TOKEN'];
for(const name of required)if(!process.env[name])throw new Error(`${name} is required.`);
const baseUrl=process.env.OPENPPWR_E2E_BASE_URL.replace(/\/$/,'');
const outputRoot=resolve(process.env.OPENPPWR_E2E_OUTPUT_ROOT||'artifacts/e2e/deployed');
const runId=process.env.OPENPPWR_E2E_RUN_ID||'deployed-beta1';
const tokens={editor:process.env.OPENPPWR_E2E_PACKAGING_EDITOR_TOKEN,contributor:process.env.OPENPPWR_E2E_EVIDENCE_CONTRIBUTOR_TOKEN,reviewer:process.env.OPENPPWR_E2E_EVIDENCE_REVIEWER_TOKEN,manager:process.env.OPENPPWR_E2E_COMPLIANCE_MANAGER_TOKEN,auditor:process.env.OPENPPWR_E2E_AUDITOR_TOKEN,supplier:process.env.OPENPPWR_E2E_SUPPLIER_TOKEN};
const managerId=process.env.OPENPPWR_E2E_COMPLIANCE_MANAGER_ID;
const resume=process.env.OPENPPWR_E2E_RESUME==='true';
const started=Date.now();
const auth=(role,type='application/json')=>({authorization:`Bearer ${tokens[role]}`,'content-type':type});
const request=async(path,options={})=>{const response=await fetch(`${baseUrl}${path}`,options);const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={text};}return {response,body};};
const checksum=(content)=>createHash('sha256').update(content).digest('hex');
const sleep=(milliseconds)=>new Promise((resolveWait)=>setTimeout(resolveWait,milliseconds));

async function waitForEvidence(id,status){
  for(let attempt=0;attempt<60;attempt+=1){
    const listed=await request('/v1/evidence',{headers:{authorization:`Bearer ${tokens.contributor}`}});
    assert.equal(listed.response.status,200);
    const item=listed.body.items.find((candidate)=>candidate.id===id);
    if(item?.scan_status===status)return item;
    if(item?.scan_status&&item.scan_status!=='pending'&&item.scan_status!=='running')throw new Error(`evidence ${id} reached ${item.scan_status}, expected ${status}`);
    await sleep(500);
  }
  throw new Error(`evidence ${id} scan timeout`);
}

async function upload(requirement,bytes,{filename=`declaration-${requirement.supplier_id}.pdf`,mime='application/pdf',expiresAt,token=tokens.contributor}={}){
  const form=new FormData();
  form.set('requirementId',requirement.id);form.set('supplierId',requirement.supplier_id);form.set('evidenceType',requirement.evidence_type);
  if(expiresAt)form.set('expiresAt',expiresAt);
  form.set('file',new Blob([bytes],{type:mime}),filename);
  return request('/v1/evidence',{method:'POST',headers:{authorization:`Bearer ${token}`},body:form});
}

async function accept(uploaded){
  await waitForEvidence(uploaded.body.id,'clean');
  const reviewed=await request(`/v1/evidence/${uploaded.body.id}/review`,{method:'POST',headers:auth('reviewer'),body:JSON.stringify({decision:'accepted'})});
  assert.equal(reviewed.response.status,200);
  return uploaded.body.id;
}

let invalidRows=8;
if(!resume){
  const invalid=await request('/v1/imports',{method:'POST',headers:{...auth('editor'),'idempotency-key':`${runId}-invalid`},body:JSON.stringify(createAcmeInvalidImport())});
  assert.equal(invalid.response.status,422);assert.equal(invalid.body.rejectedRows,8);invalidRows=invalid.body.rejectedRows;
  const empty=await request('/v1/catalog/summary',{headers:{authorization:`Bearer ${tokens.auditor}`}});
  assert.deepEqual(empty.body,{packaging:0,materials:0,components:0,boms:0,suppliers:0});
  const validPayload=JSON.stringify(createAcmeValidJsonImport());
  const validHeaders={...auth('editor'),'idempotency-key':`${runId}-valid`};
  const valid=await request('/v1/imports',{method:'POST',headers:validHeaders,body:validPayload});assert.equal(valid.body.acceptedRows,28);
  const replay=await request('/v1/imports',{method:'POST',headers:validHeaders,body:validPayload});assert.equal(replay.body.replayed,true);
  const csv=await request('/v1/imports',{method:'POST',headers:{...auth('editor','text/csv'),'idempotency-key':`${runId}-csv`},body:createAcmeSupplementalCsv()});assert.equal(csv.body.acceptedRows,4);
}
const catalog=await request('/v1/catalog/summary',{headers:{authorization:`Bearer ${tokens.auditor}`,'x-openppwr-tenant-id':'00000000-0000-0000-0000-000000000000'}});
assert.deepEqual(catalog.body,{packaging:32,materials:18,components:40,boms:32,suppliers:4});

const requirements=await request('/v1/evidence-requirements',{headers:{authorization:`Bearer ${tokens.contributor}`}});
assert.equal(requirements.response.status,200);
const bySupplier=new Map();for(const item of requirements.body.items)if(!bySupplier.has(item.supplier_id))bySupplier.set(item.supplier_id,item);
const supplierScope=await upload(bySupplier.get('ACME-SUP-002'),Buffer.from('%PDF-1.4\nSynthetic supplier boundary test\n'),{token:tokens.supplier});
assert.equal(supplierScope.response.status,404);
const infected=await upload(bySupplier.get('ACME-SUP-001'),Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),{filename:'infected.txt',mime:'text/plain'});
assert.equal(infected.response.status,202);await waitForEvidence(infected.body.id,'infected');
const infectedReview=await request(`/v1/evidence/${infected.body.id}/review`,{method:'POST',headers:auth('reviewer'),body:JSON.stringify({decision:'accepted'})});assert.equal(infectedReview.response.status,409);

const evidenceIds=[];
for(const supplierId of ['ACME-SUP-001','ACME-SUP-002']){
  const uploaded=await upload(bySupplier.get(supplierId),Buffer.from(`%PDF-1.4\nSynthetic clean evidence ${supplierId}\n`));
  assert.equal(uploaded.response.status,202);evidenceIds.push(await accept(uploaded));
}
const expired=await upload(bySupplier.get('ACME-SUP-003'),Buffer.from('%PDF-1.4\nSynthetic expired evidence\n'),{expiresAt:'2026-01-01T00:00:00.000Z'});
await waitForEvidence(expired.body.id,'clean');
const expiredReview=await request(`/v1/evidence/${expired.body.id}/review`,{method:'POST',headers:auth('reviewer'),body:JSON.stringify({decision:'accepted'})});assert.equal(expiredReview.response.status,409);
for(const supplierId of ['ACME-SUP-003','ACME-SUP-004']){
  const uploaded=await upload(bySupplier.get(supplierId),Buffer.from(`%PDF-1.4\nSynthetic replacement evidence ${supplierId}\n`));
  assert.equal(uploaded.response.status,202);evidenceIds.push(await accept(uploaded));
}
const mismatch=await upload(bySupplier.get('ACME-SUP-004'),Buffer.from('Synthetic MIME mismatch'),{filename:'mismatch.pdf',mime:'application/pdf'});
assert.equal(mismatch.response.status,422);assert.equal(mismatch.body.error.code,'EVIDENCE_MIME_MISMATCH');

const assessed=await request('/v1/assessments/run',{method:'POST',headers:auth('manager'),body:'{}'});
const outcomes={PASS:0,FAIL:0,UNKNOWN:0,NOT_APPLICABLE:0,...assessed.body.outcomes};

// Invariants that hold regardless of how far this tenant has already been remediated.
// Absolute PASS/FAIL/UNKNOWN counts are NOT invariant: remediating a gap converts a
// FAIL or UNKNOWN into a PASS permanently, so asserting the pre-remediation numbers
// makes the test unrunnable against any tenant it has already been run against.
const assessedTotal=Object.values(outcomes).reduce((sum,value)=>sum+value,0);
assert.equal(assessedTotal,32,'every packaging record must produce exactly one outcome');
assert.equal(outcomes.NOT_APPLICABLE,10,'rule applicability is data-driven and must not change with remediation');
assert.equal(outcomes.PASS+outcomes.FAIL+outcomes.UNKNOWN,22,'applicable packaging count must stay stable');
assert.ok(Object.keys(assessed.body.outcomes).every((key)=>['PASS','FAIL','UNKNOWN','NOT_APPLICABLE'].includes(key)),'only the four defined outcomes may be produced');

const gaps=await request('/v1/gaps',{headers:{authorization:`Bearer ${tokens.manager}`}});
const blocking=gaps.body.items.filter((gap)=>gap.status!=='closed');
// A pristine ACME tenant yields exactly one FAIL (below threshold) and one UNKNOWN
// (missing recycled-content evidence), hence two blocking gaps. Assert that strictly
// only when this run actually created the data; on a resumed tenant, assert instead
// that the earlier remediation is still coherently recorded.
const scenario=blocking.length?'remediation_required':'already_remediated';
if(!resume){
  assert.deepEqual(outcomes,{PASS:20,FAIL:1,UNKNOWN:1,NOT_APPLICABLE:10},'a freshly imported ACME tenant must demonstrate all four outcomes');
  assert.equal(blocking.length,2,'a freshly imported ACME tenant must raise exactly two blocking gaps');
}
if(blocking.length){
  const premature=await request('/v1/review-snapshots',{method:'POST',headers:auth('manager'),body:'{}'});
  assert.equal(premature.response.status,409,'READY_FOR_REVIEW must be refused while blocking gaps are open');
}else{
  assert.ok(gaps.body.items.length>0,'a remediated tenant must still retain its gap history');
  assert.ok(gaps.body.items.every((gap)=>gap.history?.some((event)=>event.action==='closed_by_reassessment')),'closed gaps must retain the reassessment that closed them');
  assert.equal(outcomes.FAIL+outcomes.UNKNOWN,0,'no blocking gap may remain while FAIL or UNKNOWN outcomes exist');
}
for(const gap of blocking){
  const assigned=await request(`/v1/gaps/${gap.id}/assign`,{method:'POST',headers:auth('manager'),body:JSON.stringify({ownerId:managerId})});assert.equal(assigned.body.status,'assigned');
  const remediated=await request(`/v1/gaps/${gap.id}/remediate`,{method:'POST',headers:auth('manager'),body:JSON.stringify({notes:'Synthetic deployed remediation',evidenceIds,packagingPatch:{recycledContentPct:40}})});assert.equal(remediated.body.status,'remediated');
  const reassessed=await request(`/v1/gaps/${gap.id}/reassess`,{method:'POST',headers:{authorization:`Bearer ${tokens.manager}`}});assert.equal(reassessed.body.results[0].outcome,'PASS');
}
const frozen=await request('/v1/review-snapshots',{method:'POST',headers:auth('manager'),body:JSON.stringify({locale:'en'})});assert.equal(frozen.body.status,'READY_FOR_REVIEW');
const generated=await request(`/v1/review-snapshots/${frozen.body.id}/dossier`,{method:'POST',headers:{authorization:`Bearer ${tokens.manager}`}});assert.equal(generated.body.artifacts.length,4);
await mkdir(outputRoot,{recursive:true});const artifacts=[];
// Every artifact is fetched by the role that generated it and again by the auditor. Downloading
// only as the auditor is what allowed a real authorisation gap to reach the deployment: the
// generating role was refused its own dossier and nothing noticed.
for(const artifact of generated.body.artifacts){
  const managerResponse=await fetch(`${baseUrl}/v1/dossiers/${artifact.id}/download`,{headers:{authorization:`Bearer ${tokens.manager}`}});
  assert.equal(managerResponse.status,200,`the generating role must be able to download ${artifact.artifactType}`);
  assert.equal(checksum(Buffer.from(await managerResponse.arrayBuffer())),artifact.sha256);
  const response=await fetch(`${baseUrl}/v1/dossiers/${artifact.id}/download`,{headers:{authorization:`Bearer ${tokens.auditor}`}});assert.equal(response.status,200);
  const content=Buffer.from(await response.arrayBuffer());assert.equal(checksum(content),artifact.sha256);
  const path=resolve(outputRoot,artifact.artifactType==='manifest'?'checksum-manifest.json':`dossier.${artifact.artifactType}`);await writeFile(path,content);artifacts.push({type:artifact.artifactType,path,sha256:artifact.sha256,sizeBytes:content.length});
}
// A role with no dossier responsibility must still be refused, and refused without confirming that
// the artifact exists.
const refused=await fetch(`${baseUrl}/v1/dossiers/${generated.body.artifacts[0].id}/download`,{headers:{authorization:`Bearer ${tokens.contributor}`}});
assert.equal(refused.status,404);

const audit=await request('/v1/audit/verify',{headers:{authorization:`Bearer ${tokens.auditor}`}});assert.equal(audit.body.valid,true);
// Addressed by the application hostname. On a deployment with host routing the base URL is reached
// by loopback, which is deliberately mapped to the API surface and serves no HTML — asking it for a
// page is not a defect, it is the routing working. The host header names the surface being tested.
const appHost=process.env.OPENPPWR_E2E_APP_HOST||'app.openppwr.eu';
for(const locale of ['en','pl','de']){
  const page=await fetch(`${baseUrl}/${locale}`,{headers:{'x-forwarded-host':appHost}});
  assert.equal(page.status,200,`${locale} workbench shell must be served by the application host`);
  assert.match(await page.text(),/<div id="root"><\/div>/);
}
const report={status:'PASS',sourceRevision:process.env.OPENPPWR_E2E_SOURCE_REVISION||null,baseUrl,runId,resumed:resume,scenario,durationSeconds:Number(((Date.now()-started)/1000).toFixed(3)),invalidRows,catalog:catalog.body,outcomes,infectedRejected:true,mimeMismatchRejected:true,supplierBoundaryDenied:true,tenantHeaderIgnored:true,gapsRemediated:blocking.length,snapshotSha256:frozen.body.snapshotSha256,audit:{valid:audit.body.valid,count:audit.body.count,head:audit.body.head},localizedWorkbenchRoutes:['en','pl','de'],artifacts};
const reportPath=resolve(outputRoot,'deployed-e2e-report.json');await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
console.log(`DEPLOYED_E2E_PASS duration=${report.durationSeconds}s outcomes=${JSON.stringify(report.outcomes)} auditEvents=${report.audit.count} artifacts=${artifacts.length} report=${reportPath}`);
