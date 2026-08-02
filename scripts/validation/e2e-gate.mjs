import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool, migrate, withTenantTransaction } from '@openppwr/database';
import { createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';
import { VerdictStubScanner, processNextScanJob } from '@openppwr/worker';
import { createApp, createVerifiedContext } from '../../apps/api/src/app.mjs';
import { startTestDatabase } from '../testing/embedded-postgres.mjs';
import { boundedStep, closeServer, endPool } from '../testing/bounded-teardown.mjs';

const outputRoot = resolve('artifacts','e2e');

function checksum(content) { return createHash('sha256').update(content).digest('hex'); }

async function executeReferenceRun(runNumber) {
  const started = new Date();
  const runRoot = resolve(outputRoot,`run-${runNumber}`);
  const storageRoot = resolve(runRoot,'private-storage');
  const downloadRoot = resolve(runRoot,'downloads');
  await mkdir(downloadRoot,{recursive:true});
  const database = await startTestDatabase(`reference-e2e-${runNumber}`);
  let pool;
  let workerPool;
  let server;
  try {
    await migrate(database.adminUrl);
    pool = createPool(database.runtimeUrl);
    // scan_jobs is granted to openppwr_worker directly (migration 022), not routed through a
    // SECURITY DEFINER function the way identity verification is — reusing the app's own pool for
    // processNextScanJob below authenticates as openppwr_app, which migration 028 explicitly revoked
    // table-wide UPDATE on scan_jobs from, so the poll query failed with "permission denied for table
    // scan_jobs" rather than exercising the real worker's own database identity.
    workerPool = createPool(database.workerUrl);
    const bootstrapSecret = randomUUID();
    const app = createApp({pool,bootstrapToken:bootstrapSecret,storageRoot});
    await new Promise((resolveListen) => { server=app.listen(0,'127.0.0.1',resolveListen); });
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const jsonRequest=async(path,options={})=>{const response=await fetch(`${baseUrl}${path}`,options);return {response,body:await response.json()};};
    const created=await jsonRequest('/v1/bootstrap',{method:'POST',headers:{'content-type':'application/json','x-openppwr-bootstrap-token':bootstrapSecret},body:'{}'});
    assert.equal(created.response.status,201);
    const {tenantId,identities}=created.body;
    const auth=(role,type='application/json')=>({authorization:`Bearer ${identities[role].token}`,'content-type':type});

    const invalid=await jsonRequest('/v1/imports',{method:'POST',headers:{...auth('packaging_editor'),'idempotency-key':`invalid-${runNumber}`},body:JSON.stringify(createAcmeInvalidImport())});
    assert.equal(invalid.response.status,422);
    assert.equal(invalid.body.rejectedRows,8);
    const zero=await database.admin.query('SELECT count(*)::int count FROM packaging');
    assert.equal(zero.rows[0].count,0);

    const validPayload=JSON.stringify(createAcmeValidJsonImport());
    const validHeaders={...auth('packaging_editor'),'idempotency-key':`valid-${runNumber}`};
    const valid=await jsonRequest('/v1/imports',{method:'POST',headers:validHeaders,body:validPayload});
    assert.equal(valid.body.acceptedRows,28);
    const replay=await jsonRequest('/v1/imports',{method:'POST',headers:validHeaders,body:validPayload});
    assert.equal(replay.body.replayed,true);
    const supplemental=await jsonRequest('/v1/imports',{method:'POST',headers:{...auth('packaging_editor','text/csv'),'idempotency-key':`supplemental-${runNumber}`},body:createAcmeSupplementalCsv()});
    assert.equal(supplemental.body.acceptedRows,4);

    const listed=await jsonRequest('/v1/evidence-requirements',{headers:{authorization:`Bearer ${identities.evidence_contributor.token}`}});
    const bySupplier=new Map();
    for(const item of listed.body.items) if(!bySupplier.has(item.supplier_id)) bySupplier.set(item.supplier_id,item);
    const worker=await createVerifiedContext(pool,identities.worker.token);
    const upload=async(requirement,bytes,{filename=`declaration-${requirement.supplier_id}.pdf`,mime='application/pdf',expiresAt=null}={})=>{
      const form=new FormData();
      form.set('requirementId',requirement.id);
      form.set('supplierId',requirement.supplier_id);
      form.set('evidenceType',requirement.evidence_type);
      if(expiresAt) form.set('expiresAt',expiresAt);
      form.set('file',new Blob([bytes],{type:mime}),filename);
      return jsonRequest('/v1/evidence',{method:'POST',headers:{authorization:`Bearer ${identities.evidence_contributor.token}`},body:form});
    };
    const scanAndReview=async(uploaded,decision='accepted')=>{
      const scan=await processNextScanJob({pool:workerPool,identity:worker,storageRoot,scanner:new VerdictStubScanner({runtime:'test'})});
      const reviewed=await jsonRequest(`/v1/evidence/${uploaded.body.id}/review`,{method:'POST',headers:auth('evidence_reviewer'),body:JSON.stringify({decision})});
      return {scan,reviewed};
    };

    const supplier1=await upload(bySupplier.get('ACME-SUP-001'),Buffer.from('%PDF-1.4\nSynthetic complete evidence\n'));
    assert.equal((await scanAndReview(supplier1)).reviewed.response.status,200);
    const preliminary=await jsonRequest('/v1/assessments/run',{method:'POST',headers:auth('compliance_manager'),body:'{}'});
    assert.ok(preliminary.body.outcomes.UNKNOWN>0);

    const supplier2=await upload(bySupplier.get('ACME-SUP-002'),Buffer.from('%PDF-1.4\nSynthetic remediation evidence\n'));
    assert.equal((await scanAndReview(supplier2)).reviewed.response.status,200);

    const expired=await upload(bySupplier.get('ACME-SUP-003'),Buffer.from('%PDF-1.4\nSynthetic expired declaration\n'),{expiresAt:'2026-01-01T00:00:00.000Z'});
    const expiredReview=await scanAndReview(expired);
    assert.equal(expiredReview.reviewed.response.status,409);
    assert.equal(expiredReview.reviewed.body.error.code,'EVIDENCE_EXPIRED');
    const replacement=await upload(bySupplier.get('ACME-SUP-003'),Buffer.from('%PDF-1.4\nSynthetic replacement declaration\n'));
    assert.equal((await scanAndReview(replacement)).reviewed.response.status,200);

    const spoof=await upload(bySupplier.get('ACME-SUP-004'),Buffer.from('synthetic MIME mismatch'),{filename:'mismatch.pdf'});
    assert.equal(spoof.response.status,422);
    assert.equal(spoof.body.error.code,'EVIDENCE_MIME_MISMATCH');
    const resubmission=await upload(bySupplier.get('ACME-SUP-004'),Buffer.from('%PDF-1.4\nSynthetic clean resubmission\n'));
    assert.equal((await scanAndReview(resubmission)).reviewed.response.status,200);

    const assessed=await jsonRequest('/v1/assessments/run',{method:'POST',headers:auth('compliance_manager'),body:'{}'});
    for(const outcome of ['PASS','FAIL','UNKNOWN','NOT_APPLICABLE']) assert.ok(assessed.body.outcomes[outcome]>0,`${outcome} missing`);
    const blocked=await jsonRequest('/v1/review-snapshots',{method:'POST',headers:auth('compliance_manager'),body:'{}'});
    assert.equal(blocked.response.status,409);
    const currentGaps=await jsonRequest('/v1/gaps',{headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
    const blocking=currentGaps.body.items.filter((gap)=>gap.status!=='closed');
    assert.equal(blocking.length,2);
    for(const gap of blocking){
      const assigned=await jsonRequest(`/v1/gaps/${gap.id}/assign`,{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({ownerId:identities.compliance_manager.id})});
      assert.equal(assigned.body.status,'assigned');
      const remediated=await jsonRequest(`/v1/gaps/${gap.id}/remediate`,{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({notes:'Synthetic remediation',evidenceIds:[supplier2.body.id],packagingPatch:{recycledContentPct:40}})});
      assert.equal(remediated.body.status,'remediated');
      const reassessed=await jsonRequest(`/v1/gaps/${gap.id}/reassess`,{method:'POST',headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
      assert.equal(reassessed.body.results[0].outcome,'PASS');
    }

    const frozen=await jsonRequest('/v1/review-snapshots',{method:'POST',headers:auth('compliance_manager'),body:JSON.stringify({locale:'en'})});
    assert.equal(frozen.body.status,'READY_FOR_REVIEW');
    const generated=await jsonRequest(`/v1/review-snapshots/${frozen.body.id}/dossier`,{method:'POST',headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
    assert.equal(generated.body.artifacts.length,4);
    const artifacts=[];
    for(const artifact of generated.body.artifacts){
      const response=await fetch(`${baseUrl}/v1/dossiers/${artifact.id}/download`,{headers:{authorization:`Bearer ${identities.read_only_auditor.token}`}});
      assert.equal(response.status,200);
      const content=Buffer.from(await response.arrayBuffer());
      assert.equal(checksum(content),artifact.sha256);
      const filename=artifact.artifactType==='manifest'?'checksum-manifest.json':`dossier.${artifact.artifactType}`;
      const path=resolve(downloadRoot,filename);
      await writeFile(path,content,{flag:'w'});
      artifacts.push({type:artifact.artifactType,path,sha256:artifact.sha256,sizeBytes:content.length});
    }
    const audit=await jsonRequest('/v1/audit/verify',{headers:{authorization:`Bearer ${identities.read_only_auditor.token}`}});
    assert.equal(audit.body.valid,true);

    const adversaryTenant=randomUUID();
    await database.admin.query(`INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,'Synthetic isolation tenant','synthetic')`,[adversaryTenant,`isolation-${runNumber}`]);
    await database.admin.query(`INSERT INTO suppliers (tenant_id,id,name) VALUES ($1,'ISOLATION-SUPPLIER','Synthetic isolation supplier')`,[adversaryTenant]);
    const manager=await createVerifiedContext(pool,identities.compliance_manager.token);
    const crossTenant=await withTenantTransaction(pool,manager,(client)=>client.query(`SELECT id FROM suppliers WHERE id='ISOLATION-SUPPLIER'`));
    assert.equal(crossTenant.rowCount,0);

    const counts=await database.admin.query('SELECT (SELECT count(*)::int FROM packaging WHERE tenant_id=$1) packaging,(SELECT count(*)::int FROM materials WHERE tenant_id=$1) materials,(SELECT count(*)::int FROM components WHERE tenant_id=$1) components,(SELECT count(*)::int FROM boms WHERE tenant_id=$1) boms',( [tenantId] ));
    assert.deepEqual(counts.rows[0],{packaging:32,materials:18,components:40,boms:32});
    return {runNumber,durationSeconds:Number(((new Date()-started)/1000).toFixed(3)),counts:counts.rows[0],invalidRows:invalid.body.rejectedRows,outcomes:assessed.body.outcomes,blockingGapsRemediated:blocking.length,audit:{valid:audit.body.valid,count:audit.body.count,head:audit.body.head},snapshotSha256:frozen.body.snapshotSha256,artifacts};
  } finally {
    // Every step here was unbounded until now, which is why this stage could stall after doing all of
    // its work and printing its result. `pool.end()` in particular waits for every checked-out client to
    // be returned and has no deadline of its own: measured on this host, a single leaked client makes it
    // never settle at all, and a teardown that never settles is indistinguishable from a slow stage.
    await closeServer(server,'e2e-server',15000);
    await endPool(pool,'e2e-pool',15000);
    await endPool(workerPool,'e2e-worker-pool',15000);
    await boundedStep('e2e-database',()=>database.stop(),60000);
  }
}

await mkdir(outputRoot,{recursive:true});
const report={schemaVersion:'1.0',generatedAt:new Date().toISOString(),runs:[]};
for(let runNumber=1;runNumber<=2;runNumber+=1) report.runs.push(await executeReferenceRun(runNumber));
report.status='PASS';
const reportPath=resolve(outputRoot,'reference-e2e-report.json');
await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,'utf8');
console.log(`REFERENCE_E2E_PASS runs=${report.runs.length} report=${reportPath}`);
for(const run of report.runs) console.log(`RUN=${run.runNumber} duration=${run.durationSeconds}s outcomes=${JSON.stringify(run.outcomes)} auditEvents=${run.audit.count}`);

