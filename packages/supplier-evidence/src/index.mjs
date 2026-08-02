import {createHash, randomUUID} from 'node:crypto';

export const REQUEST_TRANSITIONS={draft:['scheduled','sent','cancelled'],scheduled:['sent','cancelled'],sent:['viewed','in_progress','expired','cancelled'],viewed:['in_progress','expired'],in_progress:['submitted','expired'],submitted:['under_review'],under_review:['changes_requested','accepted','rejected'],changes_requested:['in_progress','submitted'],accepted:['expired'],rejected:['in_progress'],expired:['in_progress'],cancelled:[]};

export function transitionRequest(request,next,{actor='system',comment='',correlationId=randomUUID()}={}){
  if(!REQUEST_TRANSITIONS[request.status]?.includes(next)) throw Object.assign(new Error('Evidence request status transition is not permitted.'),{code:'EVIDENCE_INVALID_TRANSITION'});
  const event={id:randomUUID(),from:request.status,to:next,actor,comment,correlationId,at:new Date().toISOString()};
  return {...request,status:next,events:[...(request.events||[]),event],updatedAt:event.at};
}

export function evaluateCondition(rule,answers={}){
  if(!rule)return true;
  const value=answers[rule.questionCode];
  return rule.operator==='in'?rule.value.includes(value):rule.operator==='not_equals'?value!==rule.value:value===rule.value;
}

export function calculateEvidenceScore(items,{ruleVersion='1.0'}={}){
  const required=items.filter(x=>x.required!==false);let earned=0;const trace=[];let criticalMissing=0;
  for(const item of required){const valid=['accepted','complete'].includes(item.status)&&!item.expired&&item.dataClassification!=='SYNTHETIC'&&item.scanStatus==='clean';if(valid)earned++;if(!valid&&item.critical)criticalMissing++;trace.push({code:item.code,status:item.status,valid,reason:valid?'Evidence is complete.':item.dataClassification==='SYNTHETIC'?'Synthetic evidence cannot establish compliance.':item.expired?'Evidence has expired.':'Evidence is missing, rejected or unverified.'});}
  const percentage=required.length?Math.round(earned/required.length*100):100;
  return {ruleVersion,percentage,criticalMissing,status:criticalMissing?'missing':percentage===100?'complete':percentage?'incomplete':'missing',finalApprovalAllowed:percentage===100&&!criticalMissing,trace};
}

export function createReminder({requestId,type,dueAt,channel='in_app'}){const key=`${requestId}:${type}:${dueAt.slice(0,10)}:${channel}`;return {id:randomUUID(),idempotencyKey:createHash('sha256').update(key).digest('hex'),requestId,type,dueAt,channel,status:'queued',message:type==='overdue'?'The supplier has not provided the required information.':type==='expiry'?'This document expires in 30 days.':'Documents are due in 7 days.'};}

export function buildEvidenceManifest({request,questionnaire,answers=[],documents=[],reviews=[],score,audit=[]}){return {schemaVersion:'1.0',generatedAt:new Date().toISOString(),classification:request.dataClassification||'SYNTHETIC',watermark:(request.dataClassification||'SYNTHETIC')==='SYNTHETIC'?'SYNTHETIC DATA — NOT FOR PRODUCTION ASSESSMENT':null,request:{id:request.id,status:request.status,supplierId:request.supplierId},questionnaire:{id:questionnaire.id,version:questionnaire.version},answers,documents:documents.map(({storageKey,...safe})=>safe),reviews,score,audit:audit.map(({internalNote,...safe})=>safe)};}

// `resource` is either a child record that references its owning supplier through `supplierId`
// (an evidence request, a document, a contact) or the supplier record itself, identified by `id`.
// Both forms have to be accepted: comparing only `supplierId` denies a supplier principal access to
// its own supplier row, on which that field does not exist.
//
// This comment previously described the defect in terms of a supplier profile endpoint and an OIDC
// sign-in flow. Neither exists in this product — no `/suppliers/:id` route is defined anywhere in
// `apps/api/src/app.mjs`, and there is no OIDC anywhere in the codebase. That wording came from the
// private codebase this package was extracted from and described that product, not this one.
export function canAccessSupplier(resource,{tenantId,supplierId,role}){return resource.tenantId===tenantId&&(role!=='supplier'||resource.supplierId===supplierId||resource.id===supplierId);}

export function createInvitation({tenantId,supplierId,email,expiresAt,actor='system'}){if(!tenantId||!supplierId||!email||!expiresAt)throw new Error('An invitation requires a tenant, a supplier, an address and an expiry.');const token=randomUUID()+randomUUID();return {invitation:{id:randomUUID(),tenantId,supplierId,email,status:'pending',expiresAt,createdBy:actor,createdAt:new Date().toISOString(),tokenHash:createHash('sha256').update(token).digest('hex')},token};}
export function acceptInvitation(invitation,token,now=new Date()){if(invitation.status!=='pending')throw Object.assign(new Error('The invitation is not active.'),{code:'INVITATION_NOT_ACTIVE'});if(new Date(invitation.expiresAt)<=now)throw Object.assign(new Error('The invitation has expired.'),{code:'INVITATION_EXPIRED'});if(createHash('sha256').update(token).digest('hex')!==invitation.tokenHash)throw Object.assign(new Error('The invitation token is invalid.'),{code:'INVITATION_TOKEN_INVALID'});return {...invitation,status:'accepted',acceptedAt:now.toISOString()};}
export function revokeInvitation(invitation,actor='system'){if(invitation.status!=='pending')throw Object.assign(new Error('Only a pending invitation can be revoked.'),{code:'INVITATION_NOT_ACTIVE'});return {...invitation,status:'revoked',revokedBy:actor,revokedAt:new Date().toISOString()};}
export function createDocumentVersion(previous,stored,{actor='system'}={}){return {...previous,...stored,id:randomUUID(),previousVersionId:previous.id,versionNumber:(previous.versionNumber||1)+1,reviewStatus:'pending',validFrom:new Date().toISOString(),createdBy:actor};}
export function scheduleEvidenceJobs({requests=[],documents=[],now=new Date()}={}){const jobs=[];for(const request of requests){if(request.dueAt&&new Date(request.dueAt)<=now&&!['accepted','cancelled'].includes(request.status))jobs.push(createReminder({requestId:request.id,type:'overdue',dueAt:request.dueAt}));}for(const document of documents){if(document.expiryDate&&new Date(document.expiryDate)-now<=30*86400000&&new Date(document.expiryDate)>now)jobs.push(createReminder({requestId:document.requestId||document.id,type:'expiry',dueAt:document.expiryDate}));}return [...new Map(jobs.map(job=>[job.idempotencyKey,job])).values()];}

const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=buffer=>{let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
export function buildEvidenceZip(files){const local=[],central=[];let offset=0;for(const file of files){const name=Buffer.from(file.name.replace(/[^a-zA-Z0-9._-]/g,'_')),data=Buffer.from(file.content),crc=crc32(data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);local.push(header,name,data);const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+data.length;}const centralBody=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBody.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,centralBody,end]);}
