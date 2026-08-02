import { useEffect, useMemo, useState } from 'react';
import { columnLabel, describeError, enumLabel, normalizeLocale, SUPPORTED_LOCALES, translate } from './i18n.js';
import { appendPage, countLine, pagePath, SELECT_PAGE_SIZE } from './paging.js';
import { Site } from './Site.jsx';
import { AppNav } from './AppNav.jsx';
import { permissionLabel, RoleMatrix } from './RoleMatrix.jsx';
import { RUNTIME } from './runtime.js';
import { useBuildInfo } from './build-info.js';
import { CommunitySurface, DemoSurface, DocsSurface, StatusSurface } from './Surfaces.jsx';
import { SampleDownloads } from './Downloads.jsx';
// The disabled-control mechanism. It is a module of its own because `AppNav.jsx` needs it too and this
// file imports that one; see the note at the top of `Locked.jsx`.
import { Locked, lockOf } from './Locked.jsx';
const steps=['importTitle','catalogTitle','evidenceTitle','assessmentTitle','gapsTitle','dossierTitle'];
const catalogColumns={packaging:['id','name','packaging_type','country','supplier_id','status'],materials:['id','name','family','recycled_content_pct'],components:['id','name','material_id','supplier_id','mass_g'],boms:['id','packaging_id','version','status'],suppliers:['id','name','status']};

// Business-readable artifact naming. The raw artifactType ('json', 'zip', 'manifest') is a storage
// detail, not something a compliance user should have to interpret.
function artifactLabel(t,type){return t(`artifact_${type}`);}
function artifactFilename(type){
  return {json:'openppwr-dossier.json',pdf:'openppwr-dossier.pdf',zip:'openppwr-dossier-package.zip',manifest:'openppwr-checksum-manifest.json'}[type]||`openppwr-dossier.${type}`;
}

// A service that cannot be reached is not a service that failed.
//
// `fetch` rejects on a transport failure — the deployment is down, the network is gone, the proxy
// closed the connection — and that rejection carries no response: no status, no error code, no
// correlation identifier. It reached `act()` as a bare Error, so `errorMessageKey(undefined,undefined)`
// fell through to `errServer`, which tells the user to quote a support reference that cannot exist,
// because there was no response to carry one. `CLIENT_NETWORK_ERROR` and its three translations were
// already written and were referenced by nothing; this is what raises them.
export async function fetchOrNetworkError(input,init){
  try{return await fetch(input,init);}
  catch(cause){
    throw Object.assign(new Error('The service could not be reached.'),{
      code:'CLIENT_NETWORK_ERROR',
      // Stated as absent rather than left undefined: there was no response, so there is no status and
      // no reference, and the interface must not imply otherwise.
      status:null,
      correlationId:null,
      cause,
    });
  }
}

async function parseResponse(response){
  const text=await response.text();
  let body;try{body=JSON.parse(text);}catch{body={text};}
  if(!response.ok)throw Object.assign(new Error(body.error?.message || `Request failed: ${response.status}`),{
    body,
    status:response.status,
    code:body.error?.code,
    // Correlation ID lets support tie a user-visible failure to a server log entry without
    // showing the user any technical internals.
    correlationId:response.headers.get('x-correlation-id')||body.error?.correlationId||null,
  });
  return body;
}

// Each upload against a requirement creates a new version rather than replacing the previous one.
// Listed by supplier and type alone those versions are indistinguishable and read as duplicate rows, so
// the highest version per requirement is marked current and the rest superseded.
//
// Derived over the rows currently held rather than over one fetched page, because the collection is now
// paginated: appending a page can supersede a row that was current when it arrived, and a badge computed
// once per page would keep calling it current. What it cannot do is speak for rows nobody has fetched —
// a version living on an unloaded page leaves an older row reading as current, which is precisely why
// the count line under the table states that further rows exist rather than letting the table imply it
// is the whole collection.
export function withCurrency(rows){
  const latest=new Map();
  for(const item of rows||[]){const seen=latest.get(item.requirement_id);if(seen===undefined||item.version>seen)latest.set(item.requirement_id,item.version);}
  return (rows||[]).map((item)=>({...item,currency:item.version===latest.get(item.requirement_id)?'current':'superseded'}));
}

export function App(){
  const params=new URLSearchParams(window.location.search);
  const segments=window.location.pathname.split('/').filter(Boolean);
  const pathLocale=SUPPORTED_LOCALES.includes(segments[0])?segments[0]:null;
  const locale=pathLocale||normalizeLocale(navigator.language);
  const route=pathLocale?(segments[1]||'home'):(segments[0]||'home');
  const {surface}=RUNTIME;
  // Which of the seven places this is. The server resolved it from the configured host map and stated
  // it in the document; deriving it here from the hostname would be a guess, and guessing wrong is
  // how six hostnames came to serve one marketing homepage.
  if(surface==='app')return <WorkbenchSurface locale={locale} pathLocale={pathLocale} segments={segments}/>;
  if(surface==='demo')return <DemoSurface locale={locale}/>;
  if(surface==='status')return <StatusSurface locale={locale}/>;
  if(surface==='community')return <CommunitySurface locale={locale}/>;
  if(surface==='docs')return <DocsSurface locale={locale} path={segments.slice(1)}/>;
  if(surface==='marketing')return <Site locale={locale} route={route}/>;
  // `all` — one host serves every surface. This is the ordinary self-hosted shape and keeps the
  // original path-only behaviour, because a single-domain deployment has no host to read.
  if(params.has('lang')||route==='app'||route==='workbench')return <CommunityWorkbench initialLocale={params.get('lang')||pathLocale}/>;
  // The documentation portal is reachable here too. `/{locale}/docs` stays the marketing page about
  // the documentation, which links onward; `/{locale}/docs/{slug}` is the page itself. Without this
  // every link out of that page would point at a documentation host the operator does not have.
  if(route==='docs'&&segments.length>(pathLocale?2:1))return <DocsSurface locale={locale} path={segments.slice(pathLocale?2:1)}/>;
  // The status page has no marketing route of its own, so on a single-host deployment `/{locale}/status`
  // — which is exactly what `localeHref('status')` builds, and what the application navigation and every
  // surface header link to — fell through to `Site`, where an unknown route resolved to the marketing
  // homepage. The demonstration and Community surfaces are not routed here: `demo` and `community` are
  // published marketing routes with their own localized copy, metadata and sections, and that is what
  // those links are meant to reach on a deployment that has only one host.
  if(route==='status')return <StatusSurface locale={locale}/>;
  return <Site locale={locale} route={route}/>;
}

// The workbench host. Its canonical route is `/{locale}/app`; anything else on this host is a link
// that lost its way — most often the cross-host redirect, which used to drop the `app` segment and
// land the user on `/{locale}`, where the application rendered the marketing homepage.
//
// The address is corrected rather than merely tolerated, so the URL a user copies from here is the
// one that works when they paste it.
function WorkbenchSurface({locale,pathLocale,segments}){
  const canonical=`/${locale}/app`;
  const onCanonical=pathLocale&&segments[1]==='app';
  useEffect(()=>{
    if(!onCanonical)window.history.replaceState(null,'',canonical+window.location.hash);
  },[onCanonical,canonical]);
  return <CommunityWorkbench initialLocale={locale}/>;
}

// Exported so the whole workbench can be rendered under test rather than reasoned about from its
// source. Every disabled control it produces is asserted to carry an explanation, which is a claim no
// amount of source reading can make about rendered output.
export function CommunityWorkbench({initialLocale}){
  const [locale,setLocale]=useState(()=>normalizeLocale(initialLocale||navigator.language));
  const t=(key)=>translate(locale,key);
  const [token,setToken]=useState('');
  const [activity,setActivity]=useState(null);
  const [busy,setBusy]=useState(false);
  const [importType,setImportType]=useState('application/json');
  const [importKey,setImportKey]=useState('browser-import');
  const [payload,setPayload]=useState('');
  const [catalog,setCatalog]=useState(null);
  // `null` is "not loaded yet" and `[]` is "loaded, and there is nothing". The two used to be the same
  // value, so a first run could not be told apart from a failure: the button changed an activity label
  // and the table below it rendered nothing at all.
  const [catalogItems,setCatalogItems]=useState(null);
  const [catalogResource,setCatalogResource]=useState('packaging');
  // Whether the server said rows remain past the ones held here. The catalog table showed the first
  // hundred rows of a resource and stated nothing, while the summary tile directly above it showed the
  // real total — so a tenant with 480 packaging records read "Packaging 480" over a table of 100 with
  // no explanation of the difference and no way to reach the rest.
  const [catalogMore,setCatalogMore]=useState(false);
  const [requirements,setRequirements]=useState(null);
  // Whether the server said requirements remain past the ones in the selector. Both evidence collections
  // returned every row with no LIMIT until 2026-08-01, so a tenant with ten thousand evidence files
  // rendered ten thousand table rows and the requirement dropdown was filled the same way.
  const [requirementsMore,setRequirementsMore]=useState(false);
  const [requirementId,setRequirementId]=useState('');
  const [file,setFile]=useState(null);
  const [evidence,setEvidence]=useState(null);
  const [evidenceMore,setEvidenceMore]=useState(false);
  const [assessment,setAssessment]=useState(null);
  const [gaps,setGaps]=useState(null);
  // `/v1/gaps` has reported `hasMore` since pagination was added to it; this screen discarded it.
  const [gapsMore,setGapsMore]=useState(false);
  const [ownerId,setOwnerId]=useState('');
  const [ownerEdited,setOwnerEdited]=useState(false);
  const [remediationNotes,setRemediationNotes]=useState('');
  const [recycledContent,setRecycledContent]=useState('');
  const [scanJobs,setScanJobs]=useState(null);
  const [snapshot,setSnapshot]=useState(null);
  const [artifacts,setArtifacts]=useState(null);
  const [identity,setIdentity]=useState(null);
  const [signInState,setSignInState]=useState('idle');
  const [signInError,setSignInError]=useState(null);
  const [demoAccounts,setDemoAccounts]=useState(null);
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  // WCAG 3.1.1. The locale selector changed every visible string but never the document language, so
  // a screen reader announced Polish and German content with English pronunciation rules.
  useEffect(()=>{document.documentElement.lang=locale;},[locale]);
  // A demonstration whose credentials are undiscoverable is not a demonstration. The endpoint exists
  // only when the operator enabled demo sign-in, so a real deployment simply returns nothing here.
  useEffect(()=>{
    let active=true;
    // The body is read on every path, including the 404 that a deployment without demonstration
    // sign-in returns. An unread body leaves the request open in the browser until the connection is
    // torn down, which holds a connection open for nothing and never settles the network.
    fetch('/v1/demo/accounts').then(async(response)=>{
      const text=await response.text();
      if(!response.ok)return null;
      try{return JSON.parse(text);}catch{return null;}
    }).then((body)=>{if(active&&body?.accounts?.length)setDemoAccounts(body);}).catch(()=>{});
    return()=>{active=false;};
  },[]);
  const headers=useMemo(()=>({authorization:`Bearer ${token}`,'accept-language':locale}),[token,locale]);
  const act=async(label,operation)=>{
    setBusy(true);
    try{const result=await operation();setActivity({kind:'done',label,result});return result;}
    catch(error){
      // A credential that stops working mid-session must return the user to the sign-in state
      // rather than leaving an authenticated-looking workbench that silently fails.
      if(error.status===401){setIdentity(null);setSignInState('error');setSignInError({code:error.code,status:error.status,correlationId:error.correlationId});}
      setActivity({kind:'error',label,message:describeError(locale,{code:error.code,status:error.status}),correlationId:error.correlationId,result:error.body||{error:{code:'CLIENT_ERROR',message:error.message}}});
      return null;
    }
    finally{setBusy(false);}
  };
  const api=(path,options={})=>fetchOrNetworkError(path,{...options,headers:{...headers,...options.headers}}).then(parseResponse);
  const loadCatalog=()=>act(t('loadCatalog'),async()=>{const result=await api('/v1/catalog/summary');setCatalog(result);return result;});
  const loadCatalogResource=(resource)=>act(t(resource),async()=>{const result=await api(pagePath(`/v1/catalog/${resource}`));setCatalogResource(resource);setCatalogItems(result.items);setCatalogMore(Boolean(result.hasMore));return result;});
  // The offset is the number of rows already held, so pressing this repeatedly walks to the end of the
  // resource rather than re-reading the same page.
  const loadMoreCatalog=()=>act(t('loadMore'),async()=>{const result=await api(pagePath(`/v1/catalog/${catalogResource}`,{offset:(catalogItems||[]).length}));setCatalogItems((rows)=>appendPage(rows,result.items));setCatalogMore(Boolean(result.hasMore));return result;});
  // The selector asks for the largest page the API serves rather than the table page size — see
  // SELECT_PAGE_SIZE in paging.js for why a chooser must not truncate on the same terms a table may.
  const loadRequirements=()=>act(t('loadRequirements'),async()=>{const result=await api(pagePath('/v1/evidence-requirements',{limit:SELECT_PAGE_SIZE}));setRequirements(result.items);setRequirementsMore(Boolean(result.hasMore));setRequirementId((value)=>value || result.items[0]?.id || '');return result;});
  const loadMoreRequirements=()=>act(t('loadMoreRequirements'),async()=>{const result=await api(pagePath('/v1/evidence-requirements',{limit:SELECT_PAGE_SIZE,offset:(requirements||[]).length}));setRequirements((rows)=>appendPage(rows,result.items));setRequirementsMore(Boolean(result.hasMore));return result;});
  const loadEvidence=()=>act(t('refreshEvidence'),async()=>{
    const result=await api(pagePath('/v1/evidence'));
    setEvidence(withCurrency(result.items));
    setEvidenceMore(Boolean(result.hasMore));
    return result;
  });
  // The offset is the number of rows already held, so pressing this repeatedly walks to the end of the
  // collection rather than re-reading the same page. Currency is re-derived over the accumulated rows,
  // not over the page just fetched: a page can carry the newer version of a row that is already on
  // screen, and marking that row current for ever would be the same defect the badge exists to prevent.
  const loadMoreEvidence=()=>act(t('loadMore'),async()=>{
    const result=await api(pagePath('/v1/evidence',{offset:(evidence||[]).length}));
    setEvidence((rows)=>withCurrency(appendPage(rows,result.items)));
    setEvidenceMore(Boolean(result.hasMore));
    return result;
  });
  const loadGaps=()=>act(t('loadGaps'),async()=>{const result=await api(pagePath('/v1/gaps'));setGaps(result.items);setGapsMore(Boolean(result.hasMore));return result;});
  const loadMoreGaps=()=>act(t('loadMore'),async()=>{const result=await api(pagePath('/v1/gaps',{offset:(gaps||[]).length}));setGaps((rows)=>appendPage(rows,result.items));setGapsMore(Boolean(result.hasMore));return result;});
  const loadScanJobs=()=>act(t('loadScanJobs'),async()=>{
    const result=await api('/v1/scan-jobs');
    setScanJobs(result.items.map((job)=>({id:job.jobId,evidence_id:job.evidenceId,status:job.status,attempts:job.attempts,last_error_code:job.lastErrorCode,requiresAttention:job.requiresAttention})));
    return result;
  });
  const requeue=(job)=>act(t('requeue'),async()=>{const result=await api(`/v1/scan-jobs/${job.id}/requeue`,{method:'POST'});await loadScanJobs();return result;});
  const submitImport=()=>act(t('runImport'),()=>api('/v1/imports',{method:'POST',headers:{'content-type':importType,'idempotency-key':importKey},body:payload}));
  const submitEvidence=()=>act(t('upload'),async()=>{const requirement=(requirements||[]).find((item)=>item.id===requirementId);const form=new FormData();form.set('requirementId',requirement.id);form.set('supplierId',requirement.supplier_id);form.set('evidenceType',requirement.evidence_type);form.set('file',file);const result=await api('/v1/evidence',{method:'POST',body:form});await loadEvidence();return result;});
  const review=(id,decision)=>act(t(decision==='accepted'?'accept':'reject'),async()=>{const result=await api(`/v1/evidence/${id}/review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});await loadEvidence();return result;});
  // A reviewer who cannot read the document is not reviewing it. The endpoint existed and was
  // documented; nothing in the browser called it, so accept and reject were pressed sight-unseen.
  const downloadEvidence=(row)=>act(`${t('viewEvidence')} · ${row.normalized_filename||row.evidence_type}`,async()=>{
    const response=await fetchOrNetworkError(`/v1/evidence/${row.id}/download`,{headers});
    if(!response.ok)await parseResponse(response);
    const blob=await response.blob();
    const link=document.createElement('a');
    link.href=URL.createObjectURL(blob);
    link.download=row.normalized_filename||`evidence-${row.id}`;
    document.body.append(link);link.click();link.remove();
    URL.revokeObjectURL(link.href);
    return {downloaded:row.normalized_filename,bytes:row.size_bytes,sha256:row.sha256};
  });
  const runAssessment=()=>act(t('runAssessment'),async()=>{const result=await api('/v1/assessments/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});setAssessment(result);return result;});
  const assign=(gap)=>act(t('assign'),async()=>{const result=await api(`/v1/gaps/${gap.id}/assign`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ownerId})});await loadGaps();return result;});
  // Both values are the operator's, and neither is invented here any more. This posted a fixed
  // `recycledContentPct: 40` and the literal note "Synthetic browser remediation": on a real
  // deployment that overwrote the operator's own recycled-content figure and wrote an English
  // placeholder into the immutable audit chain and into the generated dossier. An empty
  // recycled-content field sends no packaging patch at all, so recording a remediation no longer
  // implies changing the packaging record.
  const remediate=(gap)=>act(t('remediate'),async()=>{
    const packagingPatch=recycledContent===''?{}:{recycledContentPct:Number(recycledContent)};
    const result=await api(`/v1/gaps/${gap.id}/remediate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notes:remediationNotes,packagingPatch})});
    await loadGaps();
    return result;
  });
  const reassess=(gap)=>act(t('reassess'),async()=>{const result=await api(`/v1/gaps/${gap.id}/reassess`,{method:'POST'});await loadGaps();return result;});
  const freeze=()=>act(t('freeze'),async()=>{const result=await api('/v1/review-snapshots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({locale})});setSnapshot(result);return result;});
  // An auditor who signs in after the dossier was produced needs a route to it. Without this the
  // artifacts existed only in the memory of the session that generated them.
  const loadDossiers=()=>act(t('loadDossiers'),async()=>{
    const result=await api('/v1/review-snapshots');
    const latest=result.items[0];
    setSnapshot(latest?{id:latest.id,frozenAt:latest.frozenAt}:null);
    setArtifacts(latest?.artifacts||[]);
    return result;
  });
  const generate=()=>act(t('generate'),async()=>{const result=await api(`/v1/review-snapshots/${snapshot.id}/dossier`,{method:'POST'});setArtifacts(result.artifacts);return result;});
  // Routed through act() like every other operation. Previously this threw into an unhandled
  // promise, so a refused download produced no visible result at all — the user saw the artifact
  // listed with its size and clicking simply did nothing.
  const download=(artifact)=>act(`${t('download')} · ${artifactLabel(t,artifact.artifactType)}`,async()=>{
    const response=await fetchOrNetworkError(`/v1/dossiers/${artifact.id}/download`,{headers});
    if(!response.ok)await parseResponse(response);
    const blob=await response.blob();
    const link=document.createElement('a');
    link.href=URL.createObjectURL(blob);
    link.download=artifactFilename(artifact.artifactType);
    document.body.append(link);link.click();link.remove();
    URL.revokeObjectURL(link.href);
    return {downloaded:artifactFilename(artifact.artifactType),bytes:artifact.sizeBytes,sha256:artifact.sha256};
  });
  const build=useBuildInfo();
  const [auditResult,setAuditResult]=useState(null);
  // The result is stated in the user's language, with the evidence that makes it checkable: how many
  // events were verified and which period they cover. The payload stays available behind the
  // technical-details disclosure, as with every other operation.
  const verifyAudit=()=>act(t('verifyAudit'),async()=>{
    const result=await api('/v1/audit/verify');
    setAuditResult(result);
    return result;
  });
  // `/v1/session` returns `actorId`, and it always did. Nothing in the interface ever showed it, so
  // step 05 asked the user for an identity UUID that could only be obtained by reading the bootstrap
  // identities file on the server. It is the sensible default owner in any case: the person resolving
  // a gap they just found is usually the person looking at it.
  // Prefilled on every sign-in, so switching role re-points it at whoever is now signed in — unless the
  // field was edited by hand, which is a deliberate choice the interface must not overwrite.
  const adoptIdentity=(result)=>{setIdentity(result);if(!ownerEdited)setOwnerId(result.actorId||'');setSignInState('signedIn');};
  const signIn=async()=>{
    if(!token)return;
    setSignInState('verifying');setSignInError(null);
    try{
      const result=await api('/v1/session');
      adoptIdentity(result);
    }catch(error){
      setIdentity(null);setSignInState('error');
      setSignInError({code:error.code,status:error.status,correlationId:error.correlationId});
    }
  };
  // Email and password sign-in. The server returns a bearer token which is held in this tab only —
  // never a cookie, never persisted — so the CSRF assessment is unaffected.
  const signInWithPassword=async()=>{
    if(!email||!password)return;
    setSignInState('verifying');setSignInError(null);
    try{
      const response=await fetchOrNetworkError('/v1/login',{method:'POST',headers:{'content-type':'application/json','accept-language':locale},body:JSON.stringify({email,password})});
      const session=await parseResponse(response);
      setToken(session.token);
      const result=await fetchOrNetworkError('/v1/session',{headers:{authorization:`Bearer ${session.token}`,'accept-language':locale}}).then(parseResponse);
      adoptIdentity(result);setPassword('');
    }catch(error){
      setIdentity(null);setSignInState('error');
      setSignInError({code:error.code,status:error.status,correlationId:error.correlationId});
    }
  };
  const resetEnvironment=()=>{
    if(!globalThis.confirm(t('resetConfirm')))return null;
    return act(t('resetAction'),async()=>{
      const result=await api('/v1/demo/reset',{method:'POST'});
      clearWorkspace();setAuditResult(null);
      return result;
    });
  };
  // Signing out revokes the session on the server before discarding it here. Clearing the token
  // alone would leave a live credential valid for the rest of its twelve hours, which is forgetting,
  // not signing out. Every loaded record is cleared with it, so nothing from the previous role stays
  // on screen — including after a back navigation, since none of it was ever persisted.
  const clearWorkspace=()=>{
    setCatalog(null);setCatalogItems(null);setRequirements(null);setRequirementId('');setEvidence(null);
    setAssessment(null);setGaps(null);setOwnerId('');setSnapshot(null);setArtifacts(null);setPayload('');setFile(null);
    setRemediationNotes('');setRecycledContent('');setScanJobs(null);setOwnerEdited(false);
    setCatalogMore(false);setGapsMore(false);setRequirementsMore(false);setEvidenceMore(false);
  };
  const signOut=async()=>{
    if(token){
      // A failure here must not strand the user in a signed-in interface holding a credential they
      // asked to discard, so the local state is cleared either way and the outcome is reported.
      try{await fetch('/v1/logout',{method:'POST',headers});}catch{/* reported by state reset below */}
    }
    setToken('');setIdentity(null);setSignInState('idle');setSignInError(null);setActivity(null);
    setEmail('');setPassword('');setAuditResult(null);clearWorkspace();
  };
  // Server-side authorization is the control; this only avoids presenting actions that cannot
  // succeed, so the user is never sent into a guaranteed failure.
  const ready=Boolean(identity);
  // Server-side authorization remains the control. This only avoids inviting the user into an
  // operation that is guaranteed to fail — which is exactly how the audit-chain and dossier-download
  // defects reached users: the interface offered actions the role could never perform.
  const can=(permission)=>Boolean(identity?.permissions?.includes(permission));
  // The read routes accept either grant. `read-own` is the supplier's narrowed form of `read`, so a
  // supplier user may list their own requirements, evidence and gaps — but `/v1/catalog/*` requires
  // `read` outright and answers a supplier user with 404, which is why the catalog button is gated
  // separately below rather than on `ready` alone.
  const canRead=can('read')||can('read-own');
  // The permission a control needs, named the way the role matrix names it — or `null` when the
  // signed-in role holds it, which is what makes it a lock reason rather than a label.
  const needs=(permission)=>can(permission)?null:permissionLabel(locale,permission);
  // The read routes accept either grant, so there is no single permission to name. `read` is the one a
  // workbench role would be missing; a supplier user holds `read-own` and never reaches this.
  const needsRead=canRead?null:permissionLabel(locale,'read');
  // Every workflow control carries the same two conditions, so they are supplied once here rather than
  // repeated twenty-three times — which is how twenty-two of them came to have no explanation at all.
  const lock=(options={})=>lockOf({signedOut:!ready,busy,...options});
  return <div className="shell" id="workspace">
    <a className="skip-link" href="#import">{t('skipToContent')}</a>
    <AppNav locale={locale} onLocaleChange={setLocale} identity={identity} build={build}
      onSignOut={signOut} busy={busy}/>
    <header className="masthead">
      <div><p className="eyebrow">{t('eyebrow')}</p><h1>{t('title')}</h1></div>
      <div><p className="fiction">{t('fiction')}</p></div>
    </header>
    <div className="workspace">
      <aside className="rail" aria-label={t('workflow')}><h2>{t('workflow')}</h2><ol>{steps.map((step,index)=><li key={step}><span>{String(index+1).padStart(2,'0')}</span>{t(step)}</li>)}</ol></aside>
      <main>
        <section className="credential-panel" data-testid="sign-in">
          <h2>{t('signInTitle')}</h2>
          <p className="sign-in-help">{t('signInHelp')}</p>
          <p className="sign-in-intro">{t('signInIntro')}</p>
          {demoAccounts&&!identity&&<div className="demo-accounts" data-testid="demo-accounts">
            <h3>{t('demoTitle')}</h3>
            <p>{t('demoIntro')}</p>
            <p className="demo-password">{t('demoPassword')}: <code data-testid="demo-password">{demoAccounts.password}</code></p>
            <ul className="role-cards">{demoAccounts.accounts.map((account)=><li key={account.role} className="role-card">
              <strong>{t(`role_${account.role}`)}</strong>
              <p>{t(`roleUse_${account.role}`)}</p>
              <code>{account.email}</code>
              <button className="quiet" data-testid={`use-role-${account.role}`}
                onClick={()=>{setEmail(account.email);setPassword(demoAccounts.password);setSignInState('idle');setSignInError(null);}}>
                {t('demoUse')}
              </button>
            </li>)}</ul>
          </div>}
          <div className="form-grid">
            <label htmlFor="email">{t('email')}
              <input id="email" data-testid="email" type="email" autoComplete="username" value={email}
                onChange={(event)=>{setEmail(event.target.value);setSignInState('idle');setSignInError(null);}}
                onKeyDown={(event)=>{if(event.key==='Enter')signInWithPassword();}}/>
            </label>
            <label htmlFor="password">{t('password')}
              <input id="password" data-testid="password" type="password" autoComplete="current-password" value={password}
                onChange={(event)=>{setPassword(event.target.value);setSignInState('idle');setSignInError(null);}}
                onKeyDown={(event)=>{if(event.key==='Enter')signInWithPassword();}}/>
            </label>
          </div>
          <Locked t={t} id="sign-in-password" onClick={signInWithPassword}
            lock={lockOf({precondition:signInState==='verifying'?'lockVerifying':(!email||!password)&&'lockNeedsCredentials'})}>
            {signInState==='verifying'?t('signingIn'):t('signIn')}
          </Locked>
          <details className="advanced-token">
            <summary>{t('advancedToken')}</summary>
          <label htmlFor="credential">{t('credential')}</label>
          <div className="credential-row">
            <input id="credential" data-testid="credential" type="password" value={token} autoComplete="off"
              onChange={(event)=>{setToken(event.target.value);setIdentity(null);setSignInState('idle');setSignInError(null);}}
              onKeyDown={(event)=>{if(event.key==='Enter')signIn();}}/>
            <Locked t={t} id="sign-in-action" onClick={signIn} lock={lockOf({precondition:signInState==='verifying'?'lockVerifying':!token&&'lockNeedsToken'})}>{t('signInAction')}</Locked>

          </div>
          <small>{t('credentialHint')}</small>
          </details>
          {signInState==='verifying'&&<p className="sign-in-status" data-testid="sign-in-status">{t('verifying')}</p>}
          {signInState==='signedIn'&&identity&&<div className="account-panel" data-testid="account-panel">
            <p className="sign-in-status ok" data-testid="sign-in-status">
              {t('signedInAs')} · {t('role')}: <strong>{t(`role_${identity.role}`)}</strong> · {t('tenant')}: <code>{identity.tenantId}</code>
            </p>
            <p className="session-expiry" data-testid="session-expiry">{identity.expiresAt
              ?`${t('sessionExpires')}: ${new Date(identity.expiresAt).toLocaleString(locale)}`
              :t('sessionStatic')}</p>
            <div className="actions">
              <Locked t={t} id="sign-out" className="quiet" lock={lockOf({busy})} onClick={signOut}>{t('signOut')}</Locked>
              <Locked t={t} id="switch-role" className="quiet" lock={lockOf({busy})} onClick={signOut}>{t('switchRole')}</Locked>
            </div>
          </div>}
          {signInState==='error'&&<p className="sign-in-status error" data-testid="sign-in-status" role="alert">
            {describeError(locale,signInError||{})}
            {signInError?.correlationId&&<><br/><small>{t('supportReference')}: <code>{signInError.correlationId}</code></small></>}
          </p>}
          {!ready&&<p className="locked-hint" data-testid="locked-hint">{t('lockedHint')}</p>}
        </section>
        {/* Read from the deployment's own permission registry, so what a reader is told a role can do
            and what the server will actually permit cannot diverge. */}
        <section id="roles"><RoleMatrix locale={locale} compact/></section>
        <section id="import"><SectionHead number="01" title={t('importTitle')} help={t('importHelp')}/><div className="form-grid"><label>{t('format')}<select data-testid="import-format" value={importType} onChange={(event)=>setImportType(event.target.value)}><option value="application/json">JSON</option><option value="text/csv">CSV</option></select></label><label>{t('idempotency')}<input data-testid="import-key" value={importKey} onChange={(event)=>setImportKey(event.target.value)}/></label></div><label>{t('payload')}<textarea data-testid="import-payload" value={payload} onChange={(event)=>setPayload(event.target.value)} rows="8"/></label><Locked t={t} id="run-import" lock={lock({permission:needs('packaging:write'),precondition:!payload&&'lockNeedsPayload'})} onClick={submitImport}>{t('runImport')}</Locked>
          {/* The step cannot be completed without data, and until now nothing on any reachable page
              said where data comes from: the sample files were offered only on the two marketing
              routes that a mapped deployment redirects away from. They are offered here because here
              is where the reader is looking at an empty box and a disabled button. */}
          <SampleDownloads locale={locale} variant="inline"/></section>
        {/* `read`, not `ready`. A supplier user holds `read-own`, which `/v1/catalog/summary` does not
            accept, so this button was offered to a role that could only ever receive 404 from it. */}
        <section id="catalog"><SectionHead number="02" title={t('catalogTitle')} help={t('catalogHelp')}/><Locked t={t} id="load-catalog" lock={lock({permission:needs('read')})} onClick={loadCatalog}>{t('loadCatalog')}</Locked>{catalog&&<><div className="catalog-counts">{['packaging','materials','components','boms','suppliers'].map((key)=><button className="quiet" key={key} onClick={()=>loadCatalogResource(key)}><small>{t(key)}</small><strong>{catalog[key]}</strong></button>)}</div><DataTable t={t} locale={locale} name="catalog" empty={t('emptyCatalog')} columns={catalogColumns[catalogResource]} rows={catalogItems} actions={()=>null}/><TableFooter t={t} locale={locale} name="catalog" shown={catalogItems?.length} total={catalog[catalogResource]} hasMore={catalogMore} busy={busy} onMore={loadMoreCatalog}/></>}</section>
        <section id="evidence"><SectionHead number="03" title={t('evidenceTitle')} help={t('evidenceHelp')}/><div className="actions"><Locked t={t} id="load-requirements" lock={lock({permission:needsRead})} onClick={loadRequirements}>{t('loadRequirements')}</Locked><Locked t={t} id="refresh-evidence" className="quiet" lock={lock({permission:needsRead})} onClick={loadEvidence}>{t('refreshEvidence')}</Locked></div><div className="form-grid"><label>{t('requirement')}<select data-testid="requirement" value={requirementId} onChange={(event)=>setRequirementId(event.target.value)}>{(requirements||[]).map((item)=><option key={item.id} value={item.id}>{item.packaging_id} · {item.supplier_id}</option>)}</select></label><label>{t('file')}<input data-testid="evidence-file" type="file" onChange={(event)=>setFile(event.target.files[0])}/></label></div>{requirements&&!requirements.length&&<p className="table-empty" data-testid="requirements-empty" role="status">{t('emptyRequirements')}</p>}<RequirementsFooter t={t} hasMore={requirementsMore} busy={busy} onMore={loadMoreRequirements}/><Locked t={t} id="upload-evidence" lock={lock({permission:needs('evidence:upload'),precondition:!requirementId?'lockNeedsRequirement':!file&&'lockNeedsFile'})} onClick={submitEvidence}>{t('upload')}</Locked>
          {/* An action the role cannot perform is absent, not disabled — and accepting a document
              whose scan is not clean is refused by the server with 409, so it is not offered either.
              Rejecting one is legitimate and stays available. */}
          <DataTable t={t} locale={locale} name="evidence" empty={t('emptyEvidence')} columns={['supplier_id','evidence_type','version','currency','scan_status','review_status']} rows={evidence} actions={(row)=><>
            {(can('evidence:download')||can('evidence:download-own'))&&row.scan_status==='clean'&&<Locked t={t} id={`view-${row.id}`} className="quiet" lock={lockOf({busy})} onClick={()=>downloadEvidence(row)}>{t('viewEvidence')}</Locked>}
            {can('evidence:review')&&row.currency!=='superseded'&&<>
              {row.scan_status==='clean'&&<Locked t={t} id={`accept-${row.id}`} lock={lockOf({busy})} onClick={()=>review(row.id,'accepted')}>{t('accept')}</Locked>}
              <Locked t={t} id={`reject-${row.id}`} className="quiet" lock={lockOf({busy})} onClick={()=>review(row.id,'rejected')}>{t('reject')}</Locked>
            </>}
          </>}/>
          {/* No total: `/v1/evidence` reports `hasMore` and no count, so the line states what is shown
              rather than inventing a denominator — the same choice the gaps table already makes. */}
          <TableFooter t={t} locale={locale} name="evidence" shown={evidence?.length} hasMore={evidenceMore} busy={busy} onMore={loadMoreEvidence}/></section>
        <section id="assessment"><SectionHead number="04" title={t('assessmentTitle')} help={t('assessmentHelp')}/><Locked t={t} id="run-assessment" lock={lock({permission:needs('assessment:run')})} onClick={runAssessment}>{t('runAssessment')}</Locked>{assessment&&<div className="verdicts">{Object.entries(assessment.outcomes).map(([key,value])=><span key={key} data-outcome={key}>{enumLabel(locale,key)}<strong>{value}</strong></span>)}</div>}</section>
        <section id="gaps"><SectionHead number="05" title={t('gapsTitle')} help={t('gapsHelp')}/>
          <div className="form-grid">
            <label>{t('owner')}<input data-testid="gap-owner" value={ownerId} onChange={(event)=>{setOwnerId(event.target.value);setOwnerEdited(true);}}/></label>
            <div className="actions align-end">
              <Locked t={t} id="own-identity" className="quiet" lock={lockOf({signedOut:!identity?.actorId,busy})} onClick={()=>{setOwnerId(identity.actorId);setOwnerEdited(false);}}>{t('useMyIdentity')}</Locked>
              <Locked t={t} id="load-gaps" lock={lock({permission:needsRead})} onClick={loadGaps}>{t('loadGaps')}</Locked>
            </div>
          </div>
          <small className="field-help">{t('ownerHelp')}</small>
          {/* What the remediation writes is stated by the operator. It used to be a constant in this
              file, and that constant landed in the packaging record, the audit chain and the dossier. */}
          {(!ready||can('gap:manage'))&&<>
            <div className="form-grid">
              <label>{t('remediationNotes')}<input data-testid="remediation-notes" value={remediationNotes} onChange={(event)=>setRemediationNotes(event.target.value)}/></label>
              <label>{t('recycledContent')}<input data-testid="remediation-recycled" type="number" min="0" max="100" step="0.1" value={recycledContent} onChange={(event)=>setRecycledContent(event.target.value)}/></label>
            </div>
            <small className="field-help">{t('remediationNotesHelp')} {t('recycledContentHelp')}</small>
          </>}
          <DataTable t={t} locale={locale} name="gaps" empty={t('emptyGaps')} columns={['packaging_id','deduplication_key','status','owner_id']} rows={gaps} actions={can('gap:manage')?(row)=><>
            {row.status!=='closed'&&<Locked t={t} id={`assign-${row.id}`} lock={lockOf({precondition:!ownerId&&'lockNeedsOwnerId',busy})} onClick={()=>assign(row)}>{t('assign')}</Locked>}
            {row.status!=='closed'&&<Locked t={t} id={`remediate-${row.id}`} lock={lockOf({precondition:!row.owner_id?'lockNeedsGapOwner':!remediationNotes&&'lockNeedsNote',busy})} onClick={()=>remediate(row)}>{t('remediate')}</Locked>}
            {row.status==='remediated'&&<Locked t={t} id={`reassess-${row.id}`} lock={lockOf({busy})} onClick={()=>reassess(row)}>{t('reassess')}</Locked>}
          </>:()=>null}/>
          <TableFooter t={t} locale={locale} name="gaps" shown={gaps?.length} hasMore={gapsMore} busy={busy} onMore={loadMoreGaps}/></section>
        {/* The documented day-30 operator remedy. `GET /v1/scan-jobs` and the requeue that follows it
            existed, were documented and were reachable only with curl: the interface told the tenant
            administrator they could requeue a stalled scan and then gave them nothing to press. */}
        {(!ready||can('scan:requeue'))&&<section id="scan-queue">
          <SectionHead number="" title={t('scanQueueTitle')} help={t('scanQueueHelp')}/>
          <Locked t={t} id="load-scan-jobs" lock={lock({permission:needs('scan:requeue')})} onClick={loadScanJobs}>{t('loadScanJobs')}</Locked>
          <DataTable t={t} locale={locale} name="scan-jobs" empty={t('emptyScanJobs')} columns={['evidence_id','status','attempts','last_error_code']} rows={scanJobs} actions={(row)=>row.requiresAttention
            ?<Locked t={t} id={`requeue-${row.id}`} lock={lockOf({busy})} onClick={()=>requeue(row)}>{t('requeue')}</Locked>
            :null}/>
        </section>}
        <ResetPanel t={t} identity={identity} demo={demoAccounts} busy={busy} onReset={resetEnvironment}/>
        <section id="dossier"><SectionHead number="06" title={t('dossierTitle')} help={t('dossierHelp')}/><div className="actions"><Locked t={t} id="freeze" lock={lock({permission:needs('review:freeze')})} onClick={freeze}>{t('freeze')}</Locked>{/* The step-order defect, stated. `dossier:generate` is held by the compliance manager, so nothing
            about the role explains this button being grey — the snapshot does, and the reason names the
            control that produces one. */}<Locked t={t} id="generate" lock={lock({permission:needs('dossier:generate'),precondition:!snapshot&&'lockNeedsSnapshot'})} onClick={generate}>{t('generate')}</Locked><Locked t={t} id="load-dossiers" className="quiet" lock={lock({permission:needs('dossier:download')})} onClick={loadDossiers}>{t('loadDossiers')}</Locked>{(!ready||can('audit:verify'))&&<Locked t={t} id="verify-audit" className="quiet" lock={lock({permission:needs('audit:verify')})} onClick={verifyAudit}>{t('verifyAudit')}</Locked>}</div>
          {/* The other half of the same incident, and it is not a disabled state: the freeze button is
              enabled for a role that holds `review:freeze`, and the deployment refuses it with 409
              READY_FOR_REVIEW_BLOCKED while any blocking gap is open. The client cannot know that in
              advance without asking, so the expectation is set here and the refusal itself is now
              explained in the user's language rather than as a generic conflict. */}
          <small className="field-help">{t('freezeBlockedNote')}</small>{artifacts&&!artifacts.length&&<p className="table-empty" data-testid="artifacts-empty" role="status">{t('emptyArtifacts')}</p>}{artifacts?.length>0&&<><p className="artifact-intro">{t('artifactIntro')}</p><ul className="artifact-list">{artifacts.map((artifact)=><li key={artifact.id}>
          <div className="artifact-meta">
            <strong>{artifactLabel(t,artifact.artifactType)}</strong>
            <small>{artifactFilename(artifact.artifactType)} · {formatBytes(artifact.sizeBytes)}{artifact.sha256?` · SHA-256 ${artifact.sha256.slice(0,12)}…`:''}</small>
          </div>
          <Locked t={t} id={`download-${artifact.artifactType}`} lock={lockOf({busy})} onClick={()=>download(artifact)}>{t('download')}</Locked>
        </li>)}</ul></>}
        {auditResult&&<div className={`audit-result ${auditResult.valid?'ok':'error'}`} data-testid="audit-result" role="status">
          <strong>{auditResult.valid?t('auditValid'):t('auditInvalid')}</strong>
          <p>{auditResult.valid
            ?t('auditCoverage').replace('{count}',auditResult.count)
            :t('auditFailedAt')}</p>
          {auditResult.firstEventAt&&auditResult.lastEventAt&&<small>{t('auditRange')}: {new Date(auditResult.firstEventAt).toLocaleString(locale)} — {new Date(auditResult.lastEventAt).toLocaleString(locale)}</small>}
          {snapshot&&<small>{t('auditSnapshot')}: <code>{snapshot.id}</code></small>}
        </div>}</section>
      </main>
      <aside className={`activity ${activity?.kind||''}`} aria-live="polite">
        <p>{t('status')}</p>
        {activity?<>
          <strong>{activity.label}</strong>
          {/* A failure is explained in the user's language first. The raw payload stays available
              for support but is never the primary experience. */}
          {activity.kind==='error'&&<p className="activity-message" data-testid="activity-message" role="alert">{activity.message}</p>}
          {activity.correlationId&&<p className="activity-reference"><small>{t('supportReference')}: <code>{activity.correlationId}</code></small></p>}
          <details className="activity-details">
            <summary>{t('technicalDetails')}</summary>
            <pre data-testid="activity">{JSON.stringify(activity.result,null,2)}</pre>
          </details>
        </>:<span>{t('empty')}</span>}
      </aside>
    </div>
  </div>;
}

// Whether this deployment, this role and this endpoint can actually perform a demonstration reset.
//
// `POST /v1/demo/reset` requires all three of: demonstration sign-in enabled, the maintenance
// credential present, and the caller holding `scan:requeue` — a permission only `tenant_admin` is
// granted. The panel was gated on being signed in alone, so on an ordinary self-hosted installation it
// showed a red destructive button to every user under a heading stating that it "restores the
// demonstration environment" — a claim about their production deployment that is not true — and
// pressing it produced only "The resource does not exist or is not available to your role".
//
// The first two conditions are read from `/v1/demo/accounts`: that route answers only where
// demonstration sign-in is enabled, and it now reports whether the reset endpoint is wired as well. One
// precondition remains invisible to any client — the reset function refuses unless the installer
// declared this deployment a demonstration, which is a database fact no endpoint reports — so a
// demonstration provisioned without that declaration will still be offered the panel and refused. That
// is a narrower and more honest failure than offering it to everyone.
export function canResetEnvironment({identity,demo}={}){
  return Boolean(identity&&identity.permissions?.includes('scan:requeue')&&demo?.resetAvailable);
}

export function ResetPanel({t,identity,demo,busy,onReset}){
  if(!canResetEnvironment({identity,demo}))return null;
  return <section id="reset" className="reset-panel">
    <SectionHead number="07" title={t('resetTitle')} help={t('resetHelp')}/>
    <Locked t={t} id="reset-environment" className="danger" lock={lockOf({busy})} onClick={onReset}>
      {busy?t('resetting'):t('resetAction')}
    </Locked>
  </section>;
}

function formatBytes(bytes){if(!Number.isFinite(bytes))return '';if(bytes<1024)return `${bytes} B`;if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} kB`;return `${(bytes/1048576).toFixed(1)} MB`;}

// The number is the workflow position. A panel that is not a workflow step passes an empty string: the
// column is kept so the heading stays aligned with the numbered sections, but no number is claimed.
function SectionHead({number,title,help}){return <div className="section-head"><span>{number}</span><div><h2>{title}</h2><p>{help}</p></div></div>;}
// Columns whose values are a closed enum are translated; identifiers and free text are shown as
// stored, because translating an identifier would make it impossible to match against the source data.
// `packaging_type` belongs here and was missing: the schema constrains it to five values
// (packages/database/migrations/001_phase4_foundation.sql), so it is exactly as closed as `status`, and
// leaving it out printed the stored English words — "sales", "grouped", "transport" — into a Polish and a
// German table. `family` is deliberately absent: the schema places no CHECK on it, so its values are the
// operator's own material identifiers and must match the imported source data character for character.
const enumColumns=new Set(['scan_status','review_status','status','currency','packaging_type']);

// What the table can account for, stated under it. A table that holds 100 of 480 rows and says nothing
// is not a shorter answer than the whole catalog — it is a wrong one, and the summary tile above it was
// already showing the number that contradicted it.
// What the evidence-requirement selector cannot show, said out loud.
//
// The table footer below is not reusable here and must not be: a table states what it holds whether or
// not more exists, because the reader can see the rows. A `<select>` is a chooser — the requirement the
// user wants is either in it or, as far as this screen tells them, does not exist — so the only case
// worth a sentence is the case where the list is incomplete, and in that case a sentence is not optional.
// Nothing at all is rendered when the whole collection is present, which on every deployment this
// product has been run against is every deployment.
export function RequirementsFooter({t,hasMore,busy,onMore}){
  if(!hasMore)return null;
  return <div className="table-footer">
    <p className="field-help" data-testid="requirements-truncated" role="status">{t('requirementsTruncated')}</p>
    <Locked t={t} id="requirements-load-more" className="quiet" lock={lockOf({busy})} onClick={onMore}>{t('loadMoreRequirements')}</Locked>
  </div>;
}

function TableFooter({t,locale,name,shown,total,hasMore,busy,onMore}){
  if(!shown)return null;
  return <div className="table-footer">
    <p data-testid={`${name}-count`} role="status">{countLine(locale,{shown,total,hasMore})}</p>
    {hasMore&&<Locked t={t} id={`${name}-load-more`} className="quiet" lock={lockOf({busy})} onClick={onMore}>{t('loadMore')}</Locked>}
  </div>;
}

// `rows === null` means no load has been attempted and there is nothing to say. An empty array is a
// load that succeeded and found nothing, which is a result and must be stated: returning null for both
// left "Load requirements", "Load gaps" and "Load frozen reviews" looking identical to a silent failure
// on a fresh deployment.
function DataTable({t,locale,columns,rows,actions,name,empty}){
  if(!rows)return null;
  if(!rows.length)return <p className="table-empty" data-testid={`${name}-empty`} role="status">{empty}</p>;
  return <div className="table-wrap"><table><thead><tr>
    {columns.map((column)=><th key={column}>{columnLabel(locale,column)}</th>)}<th>{t('actions')}</th>
  </tr></thead><tbody>{rows.map((row)=><tr key={row.id} data-currency={row.currency||undefined}>
    {columns.map((column)=><td key={column}>{enumColumns.has(column)
      ?<span className={`badge badge-${String(row[column]??'unknown').toLowerCase()}`}>{enumLabel(locale,row[column])}</span>
      :<code>{row[column]??'—'}</code>}</td>)}
    <td className="row-actions">{actions(row)}</td>
  </tr>)}</tbody></table></div>;
}
