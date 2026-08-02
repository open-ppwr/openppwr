import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { preview as createVitePreview } from 'vite';
import { createPool, migrate } from '@openppwr/database';
import { createAcmeInvalidImport, createAcmeSupplementalCsv, createAcmeValidJsonImport } from '@openppwr/testing';
import { VerdictStubScanner, processNextScanJob } from '@openppwr/worker';
import { createApp, createVerifiedContext } from '../../apps/api/src/app.mjs';
import { startTestDatabase } from '../testing/embedded-postgres.mjs';
import { endPool } from '../testing/bounded-teardown.mjs';
// What a populated screen has to show, asserted from the DOM. See the reasoning in that file: the
// catalog table had never been rendered by any automated run in any locale, which is why a Polish and a
// German catalog shipped English headers and raw database values past a gate that passed 26 of 26.
import {
  assertCountLine, assertDisabledControlExplained, assertEmptyState, assertLocaleOwnsText,
  assertNarrowedView, assertRefusalExplained, assertTable,
  CATALOG_COLUMNS, CATALOG_RESOURCES, EMPTY_STATES, EVIDENCE_COLUMNS, GAP_COLUMNS, REFUSALS,
  SCAN_JOB_COLUMNS, waitForTableShape,
} from './workbench-screens.mjs';

const locale=process.argv[2]||'en';
assert.ok(['en','pl','de'].includes(locale),'Unsupported browser E2E locale.');
const outputRoot=resolve('artifacts','e2e','browser',locale);
const storageRoot=resolve(outputRoot,'private-storage');
const edgePath='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
await mkdir(outputRoot,{recursive:true});
const database=await startTestDatabase('browser-e2e');
let pool;
let workerPool;
let apiServer;
let vite;
let browser;
const started=new Date();
try{
  await migrate(database.adminUrl);
  pool=createPool(database.runtimeUrl);
  // Same fix as scripts/validation/e2e-gate.mjs: scan_jobs is granted to openppwr_worker directly
  // (migration 022), not through a SECURITY DEFINER function, and migration 028 revoked the app
  // role's table-wide UPDATE on it — processNextScanJob must run through the worker's own role.
  workerPool=createPool(database.workerUrl);
  const bootstrapSecret=randomUUID();
  const app=createApp({pool,bootstrapToken:bootstrapSecret,storageRoot});
  await new Promise((resolveListen)=>{apiServer=app.listen(0,'127.0.0.1',resolveListen);});
  const apiUrl=`http://127.0.0.1:${apiServer.address().port}`;
  const apiJson=async(path,options={})=>{const response=await fetch(`${apiUrl}${path}`,options);const body=await response.json();return {response,body};};
  const created=await apiJson('/v1/bootstrap',{method:'POST',headers:{'content-type':'application/json','x-openppwr-bootstrap-token':bootstrapSecret},body:'{}'});
  assert.equal(created.response.status,201);
  const {identities}=created.body;

  // xfwd mirrors the production web proxy, which forwards X-Forwarded-Host so the API can
  // recognise same-origin browser traffic after the Host header is rewritten to the API.
  vite=await createVitePreview({root:resolve('apps','web'),configFile:resolve('apps','web','vite.config.js'),preview:{host:'127.0.0.1',port:0,strictPort:false,proxy:{'/v1':{target:apiUrl,changeOrigin:true,xfwd:true},'/health':{target:apiUrl,changeOrigin:true,xfwd:true}}}});
  const webUrl=vite.resolvedUrls.local[0];
  browser=await chromium.launch({headless:true,executablePath:edgePath});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',(error)=>pageErrors.push(error.message));
  const waitActivity=(text)=>page.waitForFunction((expected)=>document.querySelector('[data-testid="activity"]')?.textContent.includes(expected),text,{timeout:15000});
  const waitForApi=async(operation,predicate)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const result=await operation();if(predicate(result))return result;await new Promise((resolveWait)=>setTimeout(resolveWait,100));}throw new Error('Timed out waiting for API state.');};
  // The workbench now requires an explicitly verified session before it enables actions, so the
  // journey signs in the way a real operator does instead of assuming a pasted token works.
  const setCredential=async(value)=>{
    // Email-and-password sign-in is the primary path for users; the token field now lives behind an
    // "advanced" disclosure. This journey drives role switching, which needs the token path, so it
    // opens the disclosure first rather than assuming it is visible.
    await page.evaluate(()=>{const details=document.querySelector('details.advanced-token');if(details)details.open=true;});
    await page.getByTestId('credential').fill(value);
    await page.getByTestId('sign-in-action').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="sign-in-status"]')?.classList.contains('ok'),null,{timeout:15000});
  };
  await page.goto(`${webUrl}?lang=${locale}`,{waitUntil:'networkidle'});
  assert.equal(await page.title(),'OpenPPWR Community');
  assert.equal(await page.getByTestId('locale').inputValue(),locale);
  const journeyLabels={en:'Import packaging',pl:'Import opakowań',de:'Verpackungen importieren'};
  await page.getByRole('heading',{name:journeyLabels[locale]}).waitFor();
  // This previously waited for `REQUIRES HUMAN DE REGULATORY REVIEW` to become visible, so the German
  // workbench was required by the test suite to display an internal review status to its users. The
  // review gate itself is unchanged and still tracked in the regulatory review record;
  // what changed is that it is no longer published to the interface. The assertion is inverted rather
  // than deleted, because "the marker is absent" is the property that now has to hold.
  assert.equal(await page.getByText('REQUIRES HUMAN').count(),0,'an internal review marker is visible in the workbench');

  // ------------------------------------------------------------------------------------------------
  // The screen before the data.
  //
  // Six empty states are written and translated into three languages, and not one of them had ever been
  // rendered by any automated run. The reason is structural rather than an oversight: every journey in
  // this repository imports the ACME fixture in its first step, so by the time any assertion reaches a
  // panel the panel holds records. The state is therefore reached here — the only moment in the sequence
  // where it is the *natural* state — rather than by deleting rows from a populated tenant, which would
  // assert something no operator ever sees.
  //
  // This is what a self-hosted installation looks like on its first day, and these sentences are the only
  // thing on those screens that names the step which produces the missing records. The tenant
  // administrator is the role that reaches all six: `read`, `dossier:download` and `scan:requeue`
  // together, which no other single role holds.
  const emptyStatesStarted=Date.now();
  await setCredential(identities.tenant_admin.token);
  await page.getByTestId('load-catalog').click();
  await page.locator('#catalog .catalog-counts').waitFor({timeout:20000});
  // The tiles and the table have to agree. A tile reading 0 above a table saying "nothing is stored" is
  // one coherent answer; the truncation defect was the same disagreement in the other direction.
  for(const [index,resource] of CATALOG_RESOURCES.entries()){
    const tile=page.locator('#catalog .catalog-counts button').nth(index);
    assert.equal((await tile.locator('strong').textContent()).trim(),'0',`empty tenant (${locale}): the ${resource} tile does not report an empty catalog`);
  }
  await page.locator('#catalog .catalog-counts button').nth(0).click();
  const emptyStateTexts={};
  const renderEmptyState=async(name,act)=>{
    const state=EMPTY_STATES.find((candidate)=>candidate.name===name);
    if(act)await act();
    emptyStateTexts[name]=await assertEmptyState({page,locale,...state,where:`empty tenant (${locale}) ${name}`});
  };
  await renderEmptyState('catalog');
  await renderEmptyState('requirements',()=>page.getByTestId('load-requirements').click());
  await renderEmptyState('evidence',()=>page.getByTestId('refresh-evidence').click());
  await renderEmptyState('gaps',()=>page.getByTestId('load-gaps').click());
  await renderEmptyState('artifacts',()=>page.getByTestId('load-dossiers').click());
  await renderEmptyState('scanJobs',()=>page.getByTestId('load-scan-jobs').click());
  assert.equal(Object.keys(emptyStateTexts).length,EMPTY_STATES.length,'every empty state the interface can show must have been rendered');
  // Signing out discards every record this phase loaded. Switching credential does not: `clearWorkspace`
  // runs on sign-out alone, so continuing without it would leave the administrator's empty catalog on
  // screen underneath the next role and make the populated assertions below read stale zeros.
  const emptyStatesSeconds=Number(((Date.now()-emptyStatesStarted)/1000).toFixed(3));
  await page.getByTestId('sign-out').click();
  await page.getByTestId('locked-hint').waitFor();

  await setCredential(identities.packaging_editor.token);
  await page.getByTestId('import-key').fill('browser-invalid');
  await page.getByTestId('import-payload').fill(JSON.stringify(createAcmeInvalidImport()));
  await page.getByTestId('run-import').click();
  await waitActivity('"rejectedRows": 8');
  await page.getByTestId('import-key').fill('browser-valid');
  await page.getByTestId('import-payload').fill(JSON.stringify(createAcmeValidJsonImport()));
  await page.getByTestId('run-import').click();
  await waitActivity('"acceptedRows": 28');
  await page.getByTestId('import-format').selectOption('text/csv');
  await page.getByTestId('import-key').fill('browser-supplemental');
  await page.getByTestId('import-payload').fill(createAcmeSupplementalCsv());
  await page.getByTestId('run-import').click();
  await waitActivity('"acceptedRows": 4');

  await setCredential(identities.evidence_contributor.token);
  await page.getByTestId('load-requirements').click();
  await waitActivity('"items"');
  const requirementsResponse=await apiJson('/v1/evidence-requirements',{headers:{authorization:`Bearer ${identities.evidence_contributor.token}`}});
  const requirements=[...new Map(requirementsResponse.body.items.map((item)=>[item.supplier_id,item])).values()];
  const worker=await createVerifiedContext(pool,identities.worker.token);
  for(const [index,requirement] of requirements.entries()){
    await page.getByTestId('requirement').selectOption(requirement.id);
    await page.getByTestId('evidence-file').setInputFiles({name:`browser-${requirement.supplier_id}.pdf`,mimeType:'application/pdf',buffer:Buffer.from(`%PDF-1.4\nSynthetic browser ${requirement.supplier_id}\n`)});
    await page.getByTestId('upload-evidence').click();
    await waitForApi(()=>apiJson('/v1/evidence',{headers:{authorization:`Bearer ${identities.evidence_contributor.token}`}}),(result)=>result.body.items.length===index+1&&result.body.items.at(-1).scan_status==='pending');
    const processed=await processNextScanJob({pool:workerPool,identity:worker,storageRoot,scanner:new VerdictStubScanner({runtime:'test'})});
    assert.equal(processed.scanStatus,'clean');
  }

  await setCredential(identities.evidence_reviewer.token);
  await page.getByTestId('refresh-evidence').click();
  await waitActivity('"scan_status": "clean"');
  const evidenceResponse=await apiJson('/v1/evidence',{headers:{authorization:`Bearer ${identities.evidence_reviewer.token}`}});
  for(const item of evidenceResponse.body.items){
    await page.getByTestId(`accept-${item.id}`).click();
    await waitActivity('"reviewStatus": "accepted"');
  }

  await setCredential(identities.compliance_manager.token);
  await page.getByTestId('run-assessment').click();
  await waitActivity('"NOT_APPLICABLE": 10');
  for(const outcome of ['PASS','FAIL','UNKNOWN','NOT_APPLICABLE']) assert.ok(await page.locator(`[data-outcome="${outcome}"]`).count());
  // The owner field is prefilled with the signed-in identity, which is the fix for a step the browser
  // could not complete: it demanded an identity UUID the interface never displayed. The journey asserts
  // the prefill rather than relying on it, then overwrites it with the same value it always used.
  assert.equal(await page.getByTestId('gap-owner').inputValue(),identities.compliance_manager.id,'the owner field must be prefilled with the signed-in identity');
  await page.getByTestId('gap-owner').fill(identities.compliance_manager.id);
  // What the remediation records is now the operator's, not a constant in App.jsx. The note and the
  // corrected recycled content are stated here for the same reason a user has to state them: they are
  // written to the packaging record, to the audit chain and to the dossier.
  await page.getByTestId('remediation-notes').fill('Supplier confirmed the corrected recycled content.');
  await page.getByTestId('remediation-recycled').fill('40');
  await page.getByTestId('load-gaps').click();
  await waitActivity('"items"');
  const gapResponse=await apiJson('/v1/gaps',{headers:{authorization:`Bearer ${identities.compliance_manager.token}`}});
  const blocking=gapResponse.body.items.filter((gap)=>gap.status!=='closed');
  assert.equal(blocking.length,2);

  // ------------------------------------------------------------------------------------------------
  // A refused operation, in the reader's language.
  //
  // Failures were asserted only through the JSON in the activity panel — which the server writes, which
  // is identical in every locale, and which is behind a collapsed disclosure. Nothing had ever read the
  // sentence the interface actually puts in front of the user, so no run in Polish or German had
  // established that a refusal is explained in Polish or German rather than in English.
  //
  // Both refusals below are provoked for real, by pressing an enabled control in the ordinary order of
  // the workflow. Neither response is faked: the first is the server rejecting an owner identifier that
  // belongs to no identity, the second is the freeze the product owner met — 409 with two gaps still
  // open, at exactly the point in step 06 where an operator presses it too early.
  const refusals=[];
  const refusalOf=(code)=>REFUSALS.find((candidate)=>candidate.code===code);
  await page.getByTestId('gap-owner').fill('00000000-0000-4000-8000-000000000000');
  await page.getByTestId(`assign-${blocking[0].id}`).click();
  refusals.push(await assertRefusalExplained({page,locale,...refusalOf('GAP_OWNER_INVALID'),where:`step 05 (${locale})`}));
  await page.getByTestId('gap-owner').fill(identities.compliance_manager.id);
  await page.getByTestId('freeze').click();
  refusals.push(await assertRefusalExplained({page,locale,...refusalOf('READY_FOR_REVIEW_BLOCKED'),where:`step 06 (${locale})`}));
  assert.equal(refusals.length,REFUSALS.length,'every refusal this suite declares must have been provoked and read');

  for(const gap of blocking){
    await page.getByTestId(`assign-${gap.id}`).click();
    await waitActivity('"status": "assigned"');
    await page.getByTestId(`remediate-${gap.id}`).click();
    await waitActivity('"status": "remediated"');
    await page.getByTestId(`reassess-${gap.id}`).click();
    await waitActivity('"outcome": "PASS"');
  }
  await page.getByTestId('freeze').click();
  await waitActivity('"status": "READY_FOR_REVIEW"');
  await page.getByTestId('generate').click();
  await waitActivity('"artifactType": "zip"');
  // The role that generated the dossier downloads it first. Downloading only as the auditor is what
  // let a real authorisation gap survive: the generating role was refused its own artifact and no
  // test noticed. Every published format is fetched, not just JSON.
  const fetchArtifact=async(format,filename)=>{
    const downloadPromise=page.waitForEvent('download');
    await page.getByTestId(`download-${format}`).click();
    const download=await downloadPromise;
    const path=resolve(outputRoot,filename);
    await download.saveAs(path);
    return path;
  };
  const downloadPath=await fetchArtifact('json','browser-dossier.json');
  const pdfPath=await fetchArtifact('pdf','browser-dossier.pdf');
  const zipPath=await fetchArtifact('zip','browser-dossier-package.zip');
  const manifestPath=await fetchArtifact('manifest','browser-checksum-manifest.json');
  // The role that ran the review verifies the record behind it. This is the journey a user actually
  // performs, and it returned RESOURCE_NOT_FOUND until the compliance manager was granted
  // audit:verify — on a button the interface had been offering all along.
  await page.getByTestId('verify-audit').click();
  await waitActivity('"valid": true');
  await page.getByTestId('audit-result').waitFor();
  const managerAuditText=await page.getByTestId('audit-result').textContent();
  assert.ok(managerAuditText.trim().length>0,'audit verification must state its result in the interface');
  // The result must be readable prose in the active locale, not a raw payload.
  assert.ok(!managerAuditText.includes('"valid"'),'the audit result must not present raw JSON as the primary state');

  // Signing out ends the session rather than merely forgetting it, and the workbench must return to
  // a usable sign-in state without a page reload.
  await page.getByTestId('sign-out').click();
  await page.getByTestId('locked-hint').waitFor();
  assert.equal(await page.getByTestId('credential').inputValue(),'','signing out must clear the credential from the interface');

  await setCredential(identities.read_only_auditor.token);
  // The auditor did not generate this dossier and signed in after it was produced, so it must be
  // reachable from stored state rather than from the generating session's memory.
  await page.getByTestId('load-dossiers').click();
  await waitActivity('"artifactType": "zip"');
  const auditorDownloadPath=await fetchArtifact('json','browser-dossier-auditor.json');
  await page.getByTestId('verify-audit').click();
  await waitActivity('"valid": true');
  // A read-only auditor may verify but must not be invited to freeze or generate.
  assert.equal(await page.getByTestId('freeze').isDisabled(),true,'an auditor must not be offered the freeze action');
  assert.equal(await page.getByTestId('generate').isDisabled(),true,'an auditor must not be offered dossier generation');
  // Captured here rather than at the end of the run. The Polish and German review packs cite this image
  // as the reference view of the finished workflow, and the section below deliberately loads a
  // hundred-row table on top of it; the reviewer's screenshot must keep showing what it always showed.
  const screenshotPath=resolve(outputRoot,'base-locale-reference.png');
  await page.screenshot({path:screenshotPath,fullPage:true});

  // ------------------------------------------------------------------------------------------------
  // Every step's populated state, rendered and read in this locale.
  //
  // Everything above this line drives the workflow and then reads the JSON in the activity panel. That
  // is why eleven user-facing defects survived a gate that passed 26 of 26: the payload was right in
  // every case. What was wrong was the screen — English headers and raw database enum values in Polish
  // and German, a table silently holding 100 of 480 rows, a destructive button offered to a role that
  // could not press it. This section renders the screens instead, and asserts what a reader would see.
  //
  // The catalog table is the centre of it. Nothing in this repository had ever rendered it: `browser-e2e`
  // never clicked `load-catalog`, and `ui-states-check` deliberately asserted only the state *before* the
  // load. Step 02 of the reference workflow had no browser coverage at all, in any locale.
  const screensStarted=Date.now();
  const auditorHeaders={authorization:`Bearer ${identities.read_only_auditor.token}`,'accept-language':locale};
  // The demonstration reset is destructive, and this deployment has no demonstration sign-in, so the
  // endpoint behind the control would refuse every caller. A control that cannot succeed is not offered.
  assert.equal(await page.getByTestId('reset-environment').count(),0,'a deployment without demonstration reset must not show the destructive reset control');
  const summary=(await apiJson('/v1/catalog/summary',{headers:auditorHeaders})).body;
  await page.getByTestId('load-catalog').click();
  await page.locator('#catalog .catalog-counts').waitFor({timeout:20000});
  const catalogPages={};
  for(const [index,resource] of CATALOG_RESOURCES.entries()){
    const tile=page.locator('#catalog .catalog-counts button').nth(index);
    assertLocaleOwnsText({locale,key:resource,text:(await tile.locator('small').textContent()).trim(),where:`step 02 (${locale}) ${resource} tile`});
    assert.equal((await tile.locator('strong').textContent()).trim(),String(summary[resource]),`step 02 (${locale}): the ${resource} tile does not show the stored count`);
    await tile.click();
    const columns=CATALOG_COLUMNS[resource];
    const page1=(await apiJson(`/v1/catalog/${resource}?limit=100&offset=0`,{headers:auditorHeaders})).body;
    catalogPages[resource]=page1.items.length;
    await waitForTableShape(page,'catalog',columns,page1.items.length);
    await assertTable({page,locale,section:'catalog',columns,where:`step 02 catalog·${resource} (${locale})`,expectedRows:page1.items});
    await assertCountLine({page,locale,name:'catalog',shown:page1.items.length,total:summary[resource],hasMore:page1.hasMore,where:`step 02 catalog·${resource} (${locale})`});
  }

  // Steps 03 and 05 were driven by the journey above and never read. The evidence table carries three
  // closed-enum columns — scan status, review status and version currency — and the gap table two more.
  await page.getByTestId('refresh-evidence').click();
  const auditorEvidence=(await apiJson('/v1/evidence',{headers:auditorHeaders})).body.items;
  await waitForTableShape(page,'evidence',EVIDENCE_COLUMNS,auditorEvidence.length);
  await assertTable({page,locale,section:'evidence',columns:EVIDENCE_COLUMNS,where:`step 03 evidence (${locale})`,expectedRows:auditorEvidence});
  await page.getByTestId('load-gaps').click();
  const auditorGaps=(await apiJson('/v1/gaps?limit=100&offset=0',{headers:auditorHeaders})).body;
  await waitForTableShape(page,'gaps',GAP_COLUMNS,auditorGaps.items.length);
  await assertTable({page,locale,section:'gaps',columns:GAP_COLUMNS,where:`step 05 gaps (${locale})`,expectedRows:auditorGaps.items});
  // No total is known for gaps — the route reports `hasMore` and no count — so the line states what is
  // shown rather than inventing a denominator.
  await assertCountLine({page,locale,name:'gaps',shown:auditorGaps.items.length,total:undefined,hasMore:auditorGaps.hasMore,where:`step 05 gaps (${locale})`});

  // The scan queue is the documented day-30 operator remedy and is reachable by one role only. No
  // browser run had ever rendered it either, in any locale.
  await setCredential(identities.tenant_admin.token);
  const adminHeaders={authorization:`Bearer ${identities.tenant_admin.token}`,'accept-language':locale};
  const scanJobs=(await apiJson('/v1/scan-jobs',{headers:adminHeaders})).body.items
    .map((job)=>({evidence_id:job.evidenceId,status:job.status,attempts:job.attempts,last_error_code:job.lastErrorCode}));
  assert.ok(scanJobs.length>0,'the scan queue must hold the jobs this journey produced');
  await page.getByTestId('load-scan-jobs').click();
  await waitForTableShape(page,'scan-queue',SCAN_JOB_COLUMNS,scanJobs.length);
  await assertTable({page,locale,section:'scan-queue',columns:SCAN_JOB_COLUMNS,where:`scan queue (${locale})`,expectedRows:scanJobs});

  // ------------------------------------------------------------------------------------------------
  // The one role whose view is narrowed, on screen.
  //
  // `supplier_user` had never rendered a single screen in any browser test, in any locale. It is the only
  // role in this product that sees a *subset* rather than a different set of buttons — its `read-own`
  // grant is a narrowing of `read` — which makes it the role where a scoping defect costs the most: a
  // supplier reading another supplier's evidence. The API side of that boundary was closed in July after
  // `/v1/gaps` and `/v1/assessments` were found returning the whole tenant to a supplier; what was still
  // missing is the screen, and a screen that shows too much renders exactly as well as one that does not.
  //
  // So the assertions below are about what the screen withholds, not about whether it appeared. Signing
  // out first is not ceremony: `clearWorkspace` runs on sign-out alone, so entering this role by swapping
  // the credential would leave the administrator's scan queue and the auditor's tables on screen and
  // every "the supplier sees only its own" assertion would be reading the previous role's data.
  const supplierStarted=Date.now();
  await page.getByTestId('sign-out').click();
  await page.getByTestId('locked-hint').waitFor();
  await setCredential(identities.supplier_user.token);
  const supplierId=identities.supplier_user.supplierId;
  assert.ok(supplierId,'the supplier identity must carry the supplier it is scoped to');
  const supplierHeaders={authorization:`Bearer ${identities.supplier_user.token}`,'accept-language':locale};
  // The scan queue is infrastructure state behind `scan:requeue`. A supplier holds none of it, so the
  // section is absent rather than disabled — there is nothing in it this role could ever act on.
  assert.equal(await page.locator('#scan-queue').count(),0,`supplier user (${locale}): the scan queue section is offered to a role that cannot read it`);
  // The catalog is `read` outright, which a supplier does not hold. The control is disabled and says so,
  // and the endpoint behind it refuses the same caller — so the greyed-out button is a statement about
  // the boundary rather than the boundary itself.
  const supplierCatalogLock=await assertDisabledControlExplained({page,locale,testid:'load-catalog',where:`supplier user (${locale})`});
  assert.equal((await apiJson('/v1/catalog/packaging',{headers:supplierHeaders})).response.status,404,'the catalog must refuse a supplier at the endpoint, not only in the interface');

  const ownRequirements=(await apiJson('/v1/evidence-requirements',{headers:supplierHeaders})).body.items;
  const allRequirements=(await apiJson('/v1/evidence-requirements',{headers:auditorHeaders})).body.items;
  // What this supplier is entitled to is decided from the tenant-wide list, by the supplier each record
  // names — not from the supplier-scoped endpoint, which is the thing under test. Taking the expectation
  // from the route being checked lets a route that stopped scoping define its own correctness: the run
  // that proved this necessary reported "the narrowing is not under test" instead of naming the sixteen
  // other suppliers' requirements it had just put on the screen.
  const permittedRequirements=allRequirements.filter((item)=>item.supplier_id===supplierId);
  assert.ok(permittedRequirements.length>0,`supplier user (${locale}): this supplier has no requirements of its own, so nothing about its scope can be read from this screen`);
  await page.getByTestId('load-requirements').click();
  await page.waitForFunction((count)=>document.querySelectorAll('[data-testid="requirement"] option').length===count,ownRequirements.length,{timeout:20000});
  const requirementOptions=await page.getByTestId('requirement').locator('option').evaluateAll((nodes)=>nodes.map((node)=>({value:node.value,text:node.textContent.trim()})));
  const requirementScope=assertNarrowedView({shown:requirementOptions.map((option)=>option.value),permitted:permittedRequirements.map((item)=>item.id),
    all:allRequirements.map((item)=>item.id),label:'evidence requirement',where:`supplier user (${locale})`});
  // Each option is read by a human before they attach a document to it, so it must also *say* whose
  // requirement it is rather than merely happening to be the right row.
  for(const option of requirementOptions){
    assert.ok(option.text.endsWith(`· ${supplierId}`),`supplier user (${locale}): the requirement "${option.text}" does not name this supplier`);
  }

  const ownEvidence=(await apiJson('/v1/evidence',{headers:supplierHeaders})).body.items;
  const allEvidence=(await apiJson('/v1/evidence',{headers:auditorHeaders})).body.items;
  await page.getByTestId('refresh-evidence').click();
  await waitForTableShape(page,'evidence',EVIDENCE_COLUMNS,ownEvidence.length);
  // The narrowed table is still a table a Polish or German supplier reads: same localized headers, same
  // localized scan and review badges. A scoped screen is not an excuse for an unlocalized one.
  const supplierEvidenceTable=await assertTable({page,locale,section:'evidence',columns:EVIDENCE_COLUMNS,where:`supplier user evidence (${locale})`,expectedRows:ownEvidence});
  const evidenceScope=assertNarrowedView({shown:supplierEvidenceTable.rows.map((cells)=>cells[0].text),permitted:[supplierId],
    all:allEvidence.map((item)=>item.supplier_id),label:'evidence',where:`supplier user (${locale})`});
  // What the supplier may *do* with its own document, on its own row. `evidence:download-own` is held and
  // `evidence:review` is not, so the row offers the document itself and no verdict on it. The download
  // control is asserted present as well as the review controls absent: a row that offered nothing at all
  // would satisfy "no review control" while telling the supplier its own upload is unreadable.
  for(const item of ownEvidence){
    assert.equal(await page.getByTestId(`view-${item.id}`).count(),1,`supplier user (${locale}): the supplier's own evidence row does not offer the document it uploaded`);
    for(const action of ['accept','reject']){
      assert.equal(await page.getByTestId(`${action}-${item.id}`).count(),0,`supplier user (${locale}): an evidence row offers "${action}" to a role that does not hold evidence:review`);
    }
  }

  // "Own" for a gap is the packaging this supplier has an evidence requirement for — the same definition
  // the requirement and evidence routes use, which is what makes it one boundary rather than three.
  //
  // In this fixture the two gaps the assessment produces both belong to ACME-SUP-002: the only packaging
  // records that fail the recycled-content rule are that supplier's. So the correct screen for
  // ACME-SUP-001 holds no rows — and that is the interesting case, not a weaker one. Until 2026-07-30
  // `/v1/gaps` answered a supplier with the whole tenant, so the defect this asserts against is precisely
  // a table appearing here with somebody else's gaps in it. It is asserted as a *withholding*: the gaps
  // exist, they are on the auditor's screen, and this role is told there are none of its own.
  const ownPackaging=new Set(permittedRequirements.map((item)=>item.packaging_id));
  const foreignGaps=auditorGaps.items.filter((gap)=>!ownPackaging.has(gap.packaging_id));
  assert.ok(foreignGaps.length>0,`supplier user (${locale}): every gap in this tenant belongs to this supplier, so a screen that withheld nothing would pass. The gap narrowing is not under test.`);
  const ownGaps=(await apiJson('/v1/gaps?limit=100&offset=0',{headers:supplierHeaders})).body.items;
  await page.getByTestId('load-gaps').click();
  let gapScope;
  if(ownGaps.length===0){
    await assertEmptyState({page,locale,...EMPTY_STATES.find((state)=>state.name==='gaps'),where:`supplier user gaps (${locale})`});
    gapScope={shown:0,withheld:foreignGaps.length,statedAs:'empty'};
  }else{
    await waitForTableShape(page,'gaps',GAP_COLUMNS,ownGaps.length);
    const supplierGapTable=await assertTable({page,locale,section:'gaps',columns:GAP_COLUMNS,where:`supplier user gaps (${locale})`,expectedRows:ownGaps});
    gapScope={...assertNarrowedView({shown:supplierGapTable.rows.map((cells)=>cells[0].text),permitted:[...ownPackaging],
      all:auditorGaps.items.map((gap)=>gap.packaging_id),label:'gap',where:`supplier user (${locale})`}),statedAs:'table'};
  }
  // A gap a supplier can see is not a gap a supplier may resolve, and a gap it cannot see must offer it
  // nothing at all. Every gap in the tenant is checked, not only the ones in scope.
  for(const gap of auditorGaps.items){
    for(const action of ['assign','remediate','reassess']){
      assert.equal(await page.getByTestId(`${action}-${gap.id}`).count(),0,`supplier user (${locale}): a gap row offers "${action}" to a role that does not hold gap:manage`);
    }
  }
  const supplierSeconds=Number(((Date.now()-supplierStarted)/1000).toFixed(3));
  const supplierScreenshotPath=resolve(outputRoot,'supplier-user-evidence.png');
  await page.locator('#evidence').screenshot({path:supplierScreenshotPath});
  await page.getByTestId('sign-out').click();
  await page.getByTestId('locked-hint').waitFor();

  // ------------------------------------------------------------------------------------------------
  // A list longer than one page.
  //
  // The ACME catalog is 32 packaging records, which fits in a page and therefore proves nothing about the
  // defect: a tenant with 480 records read "Packaging 480" over a table of 100, with no statement of the
  // difference and no way to reach row 101. The rows are imported through the interface, by the role that
  // imports packaging, so the state under test is reached the way a user reaches it.
  await setCredential(identities.packaging_editor.token);
  const editorHeaders={authorization:`Bearer ${identities.packaging_editor.token}`,'accept-language':locale};
  const componentIds=(await apiJson('/v1/catalog/components?limit=100&offset=0',{headers:editorHeaders})).body.items.map((row)=>row.id);
  const supplierIds=(await apiJson('/v1/catalog/suppliers?limit=100&offset=0',{headers:editorHeaders})).body.items.map((row)=>row.id);
  const bulkRows=80;
  const packagingTypes=['sales','grouped','transport','ecommerce','reusable'];
  const countries=['DE','PL','FR','CZ'];
  const bulkCsv=[
    'id,name,packagingType,country,supplierId,recycledContentPct,bomId,bomVersion,componentIds',
    ...Array.from({length:bulkRows},(_ignored,index)=>{
      const serial=String(index+1).padStart(3,'0');
      return [`E2E-BULK-PKG-${serial}`,`Synthetic bulk packaging ${serial}`,packagingTypes[index%packagingTypes.length],
        countries[index%countries.length],supplierIds[index%supplierIds.length],'40',`E2E-BULK-BOM-${serial}`,'1',
        componentIds[index%componentIds.length]].join(',');
    }),
  ].join('\n');
  await page.getByTestId('import-format').selectOption('text/csv');
  await page.getByTestId('import-key').fill('browser-bulk');
  await page.getByTestId('import-payload').fill(bulkCsv);
  await page.getByTestId('run-import').click();
  await waitActivity(`"acceptedRows": ${bulkRows}`);
  const totalPackaging=summary.packaging+bulkRows;
  await page.getByTestId('load-catalog').click();
  await waitActivity(`"packaging": ${totalPackaging}`);
  await page.locator('#catalog .catalog-counts button').nth(0).click();
  await waitForTableShape(page,'catalog',CATALOG_COLUMNS.packaging,100);
  const truncated=(await apiJson('/v1/catalog/packaging?limit=100&offset=0',{headers:editorHeaders})).body;
  assert.equal(truncated.hasMore,true,'the fixture must actually exceed one page, or the truncation state is not under test');
  await assertTable({page,locale,section:'catalog',columns:CATALOG_COLUMNS.packaging,where:`step 02 catalog·packaging truncated (${locale})`,expectedRows:truncated.items});
  await assertCountLine({page,locale,name:'catalog',shown:100,total:totalPackaging,hasMore:true,where:`step 02 catalog·packaging truncated (${locale})`});
  // And the way to the rest actually reaches the rest, rather than re-reading the first page.
  await page.getByTestId('catalog-load-more').click();
  await waitForTableShape(page,'catalog',CATALOG_COLUMNS.packaging,totalPackaging);
  await assertCountLine({page,locale,name:'catalog',shown:totalPackaging,total:totalPackaging,hasMore:false,where:`step 02 catalog·packaging complete (${locale})`});

  // ------------------------------------------------------------------------------------------------
  // A disabled control states why it is disabled.
  //
  // The packaging editor holds `packaging:write` and `read` and nothing else, so four of the workflow's
  // controls are locked for this role. A greyed-out button with no reason is indistinguishable from a
  // broken one — which is how "Generate dossier" was reported as broken by someone whose role held the
  // permission and was simply waiting on the freeze in step 06.
  const disabledReasons=[];
  for(const testid of ['run-assessment','upload-evidence','freeze','generate']){
    disabledReasons.push(await assertDisabledControlExplained({page,locale,testid,where:`packaging editor (${locale})`}));
  }
  const screensSeconds=Number(((Date.now()-screensStarted)/1000).toFixed(3));
  // The evidence a Polish or German reviewer actually needs for step 02: the catalog table itself, in
  // their language, complete. No image of it existed before, because nothing had ever rendered it.
  const catalogScreenshotPath=resolve(outputRoot,'catalog-packaging.png');
  await page.locator('#catalog').screenshot({path:catalogScreenshotPath});

  assert.deepEqual(pageErrors,[]);
  const dossier=JSON.parse(await (await import('node:fs/promises')).readFile(downloadPath,'utf8'));
  assert.equal(dossier.locale,locale);
  const report={status:'PASS',locale,durationSeconds:Number(((new Date()-started)/1000).toFixed(3)),packaging:32,requirements:requirements.length,evidence:evidenceResponse.body.items.length,outcomes:{PASS:20,FAIL:1,UNKNOWN:1,NOT_APPLICABLE:10},gapsRemediated:blocking.length,downloadPath,pdfPath,zipPath,manifestPath,auditorDownloadPath,downloadRoles:['compliance_manager','read_only_auditor'],auditVerifiedBy:['compliance_manager','read_only_auditor'],signedOut:true,screenshotPath,dossierLocale:dossier.locale,
    // What was rendered and read, rather than only driven. `screensSeconds` is the cost of it.
    screens:{secondsSpent:screensSeconds,catalogRowsRendered:catalogPages,catalogResources:CATALOG_RESOURCES.length,
      evidenceRowsRendered:auditorEvidence.length,gapRowsRendered:auditorGaps.items.length,scanJobRowsRendered:scanJobs.length,
      truncation:{resource:'packaging',total:totalPackaging,firstPage:100,reachedTotal:totalPackaging},
      disabledControlsExplained:disabledReasons,catalogScreenshotPath},
    // The three states that had no browser coverage in any locale until now: the screen before the data,
    // the screen of a refused operation, and the screen of the only role with a narrowed view.
    emptyStates:{secondsSpent:emptyStatesSeconds,rendered:emptyStateTexts},
    refusals:{provoked:refusals.map((refusal)=>refusal.code),messages:Object.fromEntries(refusals.map((refusal)=>[refusal.code,refusal.text]))},
    supplierUser:{secondsSpent:supplierSeconds,supplierId,catalogLock:supplierCatalogLock,scanQueueOffered:false,
      requirements:requirementScope,evidence:evidenceScope,gaps:gapScope,screenshotPath:supplierScreenshotPath},};
  const reportPath=resolve(outputRoot,'browser-e2e-report.json');
  await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,'utf8');
  console.log(`BROWSER_E2E_PASS locale=${locale} report=${reportPath}`);
}finally{
  // Teardown must be bounded and complete. This journey used to print PASS and then hang forever:
  // closing vite.httpServer stops the HTTP listener but leaves Vite's own services running, and the
  // esbuild child process it owns kept the Node event loop alive with no socket and no output. The
  // gate therefore stalled after the last locale passed, with nothing to show why.
  //
  // vite.close() is Vite's own teardown and stops those services. Every step is also bounded, so a
  // single stuck resource degrades to a reported warning instead of an invisible stall.
  const teardown=async(label,operation,ms=30000)=>{
    let timer;
    try{
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_ignored,reject)=>{timer=setTimeout(()=>reject(new Error(`teardown timed out after ${ms}ms`)),ms);}),
      ]);
    }catch(error){
      console.error(`TEARDOWN_WARNING step=${label} reason=${error.message}`);
    }finally{clearTimeout(timer);}
  };
  await teardown('browser',()=>browser?.close());
  await teardown('vite',()=>vite?.close());
  await teardown('api',()=>apiServer&&new Promise((resolveClose)=>{apiServer.closeAllConnections?.();apiServer.close(resolveClose);}));
  // Not `teardown(...)` for these two. Bounding `pool.end()` with Promise.race makes the await return;
  // it does not close the sockets, so the process is left with live handles and still cannot exit —
  // a warning followed by the same silent stall. endPool() destroys what the deadline gave up on.
  await endPool(pool,'pool',30000);
  await endPool(workerPool,'workerPool',30000);
  await teardown('database',()=>database.stop());
}
