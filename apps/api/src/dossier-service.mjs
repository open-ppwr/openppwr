import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { buildDossierArtifacts, stableStringify } from '@openppwr/dossier';
import { appendAudit, verifyAuditChain, withTenantTransaction } from '@openppwr/database';
import { readVerifiedEvidence } from './evidence-service.mjs';
import { reviewSerializationKey } from './assessment-service.mjs';

function dossierError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function sha256(content) { return createHash('sha256').update(content).digest('hex'); }

const explanationCatalog={
  en:{minimum:'Recycled content meets the demonstrated minimum.',minimumFail:'Recycled content is below the demonstrated minimum.',required_input_missing:'A required input is missing.',required_evidence_missing:'Required evidence is missing.',packaging_type_out_of_scope:'The packaging type is outside this demonstration rule.',closed:'Closed',open:'Open'},
  pl:{minimum:'Zawartość recyklatu spełnia demonstracyjne minimum.',minimumFail:'Zawartość recyklatu jest niższa od demonstracyjnego minimum.',required_input_missing:'Brakuje wymaganej danej.',required_evidence_missing:'Brakuje wymaganego dowodu.',packaging_type_out_of_scope:'Typ opakowania nie podlega tej regule demonstracyjnej.',closed:'Zamknięta',open:'Otwarta'},
  de:{minimum:'Der Rezyklatanteil erfüllt den demonstrierten Mindestwert.',minimumFail:'Der Rezyklatanteil liegt unter dem demonstrierten Mindestwert.',required_input_missing:'Eine erforderliche Eingabe fehlt.',required_evidence_missing:'Ein erforderlicher Nachweis fehlt.',packaging_type_out_of_scope:'Der Verpackungstyp liegt außerhalb dieser Demonstrationsregel.',closed:'Geschlossen',open:'Offen'},
};
function localizedTrace(trace,locale){const catalog=explanationCatalog[locale]||explanationCatalog.en;return (trace||[]).map((item)=>({...item,message:item.explanationKey==='assessment.recycled_content.minimum'?(item.passed?catalog.minimum:catalog.minimumFail):(catalog[item.code]||item.explanationKey||item.code)}));}

function safeStoragePath(rootInput, key) {
  const root = resolve(rootInput);
  const target = resolve(root, key);
  if (!target.startsWith(`${root}${sep}`)) throw dossierError('DOSSIER_STORAGE_PATH_INVALID', 'Dossier storage path is invalid.', 500);
  return target;
}

// The tenant-prefixed key a dossier artifact must have, checked rather than assumed.
//
// `safeStoragePath` is lexical: it stops `..` from leaving the root, and it stops nothing else. On its own
// it does not establish that the key belongs to the caller's tenant, nor that the path it resolves is a
// regular file rather than a symlink pointing anywhere the process can read. Both were relied on
// implicitly on the download path.
function confinedArtifactPath(storageRoot, tenantId, storageKey) {
  const expectedPrefix = `${tenantId}/dossiers/`;
  const remainder = storageKey?.startsWith(expectedPrefix) ? storageKey.slice(expectedPrefix.length) : null;
  // `<tenant>/dossiers/<snapshot>/<file>` — exactly two further segments, so a key cannot climb or branch.
  if (!remainder || remainder.split('/').length !== 2 || remainder.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw dossierError('DOSSIER_STORAGE_PATH_INVALID', 'Dossier storage path is invalid.', 500);
  }
  return safeStoragePath(storageRoot, storageKey);
}

// A tenant reset deletes the dossier_artifacts row; the file on disk was never removed by anything
// until this helper existed. Called after the row deletion already committed, so this is best-effort
// cleanup, not part
// of the reset's own success criteria — a missing file or a key that fails confinement is swallowed here.
export async function removeDossierStorageKey(storageRoot, tenantId, storageKey) {
  let target;
  try {
    target = confinedArtifactPath(storageRoot, tenantId, storageKey);
  } catch {
    return false;
  }
  try {
    // `confinedArtifactPath` is lexical, same as the equivalent evidence cleanup helper before this fix
    // a symlinked `<tenant>/dossiers` or snapshot directory would let `rm` follow it outside
    // storageRoot despite the string check passing. Checked against the parent's real path, not the file's
    // own — the file may legitimately already be gone. Compared against the exact canonical directory this
    // key's own tenant/snapshot prefix names, not merely "somewhere under root" — a symlink swapped for a
    // different in-root tenant's directory satisfies the weaker check without being the right one.
    const root = resolve(storageRoot);
    const canonicalRoot = await realpath(root);
    const canonicalParent = await realpath(dirname(target)).catch(() => null);
    if (canonicalParent === null) return false;
    const expectedParent = resolve(canonicalRoot, relative(root, dirname(target)));
    if (canonicalParent !== expectedParent) return false;
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function packagingSnapshot(client) {
  const rows = await client.query(
    `SELECT p.id,p.name,p.packaging_type,p.country,p.supplier_id,p.recycled_content_pct,s.name supplier_name,
            b.id bom_id,b.version bom_version,l.component_id,l.quantity,c.name component_name,c.mass_g,c.material_id,m.name material_name,m.family material_family
     FROM packaging p JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
     JOIN boms b ON b.tenant_id=p.tenant_id AND b.packaging_id=p.id AND b.status='approved'
     LEFT JOIN bom_lines l ON l.tenant_id=b.tenant_id AND l.bom_id=b.id
     LEFT JOIN components c ON c.tenant_id=l.tenant_id AND c.id=l.component_id
     LEFT JOIN materials m ON m.tenant_id=c.tenant_id AND m.id=c.material_id
     ORDER BY p.id,l.component_id`,
  );
  const packages = new Map();
  for (const row of rows.rows) {
    if (!packages.has(row.id)) packages.set(row.id, {
      id:row.id,name:row.name,packagingType:row.packaging_type,country:row.country,
      recycledContentPct:row.recycled_content_pct === null ? null : Number(row.recycled_content_pct),
      supplier:{id:row.supplier_id,name:row.supplier_name},bom:{id:row.bom_id,version:row.bom_version,lines:[]},
    });
    if (row.component_id) packages.get(row.id).bom.lines.push({componentId:row.component_id,name:row.component_name,quantity:Number(row.quantity),massG:Number(row.mass_g),material:{id:row.material_id,name:row.material_name,family:row.material_family}});
  }
  return [...packages.values()];
}

// The generator version is stamped into the frozen snapshot, the dossier and the audit event, and is
// the thing a reader uses to know which build produced an artifact they are relying on. It was a
// hardcoded literal that stopped matching the build at 0.2.0-beta.1, so every dossier this candidate
// produced claimed to come from a version that had not built it — in a product whose central claim is
// that its artifacts are reproducible from a known revision. Read from the same build metadata
// `/v1/version` reports, so the two can never disagree again.
export async function freezeReviewSnapshot(pool, identity, { locale = 'en', at = new Date(), generatorVersion = process.env.OPENPPWR_VERSION || 'unknown' } = {}) {
  if (!['en','pl','de'].includes(locale)) throw dossierError('LOCALE_NOT_AVAILABLE', 'Requested locale is unavailable.', 409);
  // The extended deadline class: this transaction reads a whole tenant's packaging, assessments, rules,
  // evidence and gaps and then verifies every audit event the tenant has. Whatever bound a deployment
  // chooses for an interactive read is the wrong bound for this, which is why the class is named here
  // rather than a number chosen here.
  return withTenantTransaction(pool, identity, async (client) => {
    // Serialise the freeze against concurrent work in the same tenant, before reading anything.
    //
    // The transaction runs at READ COMMITTED, so each statement sees a newer committed snapshot than the
    // last. The readiness check ran first and the gap list was read many statements later, which left a
    // window: a gap committed in between passed the check and then appeared *inside* the frozen review. The
    // freeze still succeeded, and the artifact it produced said the review was complete while containing an
    // open gap.
    //
    // An advisory lock rather than SERIALIZABLE: this codebase already uses `pg_advisory_xact_lock` for
    // bootstrap and for the audit chain, so the pattern is established, and a serialisation failure here
    // would surface to the caller as a retry they did not ask for. The lock is released with the
    // transaction. The key is namespaced away from the audit chain's, which locks on the tenant identifier
    // alone — two different exclusions sharing one key would deadlock the pair for no reason.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reviewSerializationKey(identity.tenantId)]);
    const blocking = await client.query(`SELECT id,status FROM gaps WHERE status <> 'closed' ORDER BY id`);
    if (blocking.rowCount) throw dossierError('READY_FOR_REVIEW_BLOCKED', 'Blocking gaps remain.', 409);
    const readiness = await client.query(
      `SELECT (SELECT count(*)::int FROM packaging) packaging_count,
              count(*)::int assessment_count,
              count(*) FILTER (WHERE r.outcome IN ('FAIL','UNKNOWN'))::int blocking_outcomes
       FROM assessments a JOIN assessment_results r ON r.tenant_id=a.tenant_id AND r.assessment_id=a.id WHERE a.status='completed'`,
    );
    const status = readiness.rows[0];
    if (!status.packaging_count || status.assessment_count !== status.packaging_count || status.blocking_outcomes) throw dossierError('READY_FOR_REVIEW_INCOMPLETE', 'Every packaging record needs a non-blocking current assessment.', 409);
    const tenant = await client.query('SELECT id,slug,name,disclaimer FROM tenants WHERE id=$1', [identity.tenantId]);
    const assessments = await client.query(
      `SELECT a.id,a.packaging_id,a.rule_id,a.rule_version,a.supersedes_id,a.input_snapshot,a.evidence_snapshot,a.evaluated_at,r.outcome,r.explanation,r.evidence_ids
       FROM assessments a JOIN assessment_results r ON r.tenant_id=a.tenant_id AND r.assessment_id=a.id WHERE a.status='completed' ORDER BY a.packaging_id,a.id`,
    );
    const rules = await client.query(`SELECT rule_id,version,source_reference,publication_date,effective_from,effective_to,lifecycle_status,reviewer_status,required_inputs,required_evidence,applicability,checks FROM rule_versions WHERE (rule_id,version) IN (SELECT rule_id,rule_version FROM assessments WHERE status='completed') ORDER BY rule_id,version`);
    const evidence = await client.query(`SELECT tenant_id,id,requirement_id,supplier_id,evidence_type,version,normalized_filename,detected_mime,size_bytes,sha256,storage_key,scan_status,review_status,expires_at,reviewed_at FROM evidence_files WHERE scan_status='clean' AND review_status='accepted' ORDER BY supplier_id,evidence_type,version,id`);
    const gaps = await client.query(`SELECT id,packaging_id,rule_id,rule_version,deduplication_key,current_assessment_id,status,owner_id,remediation_notes,remediation_evidence_ids,history FROM gaps ORDER BY id`);
    const audit = await verifyAuditChain(client);
    if (!audit.valid) throw dossierError('AUDIT_CHAIN_INVALID', 'Audit verification failed.', 409);
    const frozenAt = at.toISOString();
    const snapshot = {
      schemaVersion:'1.0.0',generatorVersion,locale,frozenAt,generatedAt:frozenAt,
      organization:tenant.rows[0],
      packaging:await packagingSnapshot(client),
      assessments:assessments.rows.map((row) => ({id:row.id,packagingId:row.packaging_id,ruleId:row.rule_id,ruleVersion:row.rule_version,supersedesId:row.supersedes_id,inputSnapshot:row.input_snapshot,evidenceSnapshot:row.evidence_snapshot,outcome:row.outcome,explanation:row.explanation,localizedExplanation:localizedTrace(row.explanation,locale),evidenceIds:row.evidence_ids,evaluatedAt:row.evaluated_at.toISOString()})),
      rules:rules.rows.map((row) => ({...row,publication_date:row.publication_date.toISOString().slice(0,10),effective_from:row.effective_from.toISOString().slice(0,10),effective_to:row.effective_to?.toISOString().slice(0,10) || null})),
      evidence:evidence.rows.map((row) => ({id:row.id,requirementId:row.requirement_id,supplierId:row.supplier_id,evidenceType:row.evidence_type,version:row.version,filename:row.normalized_filename,mimeType:row.detected_mime,sizeBytes:Number(row.size_bytes),sha256:row.sha256,storageKey:row.storage_key,scanStatus:row.scan_status,reviewStatus:row.review_status,expiresAt:row.expires_at?.toISOString() || null,reviewedAt:row.reviewed_at?.toISOString() || null})),
      gaps:gaps.rows.map((row)=>({...row,localizedStatus:(explanationCatalog[locale]||explanationCatalog.en)[row.status]||row.status})),
      auditVerification:audit,
    };
    // Re-checked immediately before the row is written, against the same view the snapshot was built from.
    // The lock above is what makes this hold; this assertion is what makes a future writer that forgets the
    // lock fail loudly rather than silently produce an artifact claiming a completeness it does not have.
    const stillBlocking = await client.query(`SELECT id FROM gaps WHERE status <> 'closed' ORDER BY id`);
    if (stillBlocking.rowCount) throw dossierError('READY_FOR_REVIEW_BLOCKED', 'Blocking gaps appeared while the review was being frozen.', 409);
    const snapshotId = randomUUID();
    const snapshotHash = sha256(stableStringify(snapshot));
    await client.query(`INSERT INTO review_snapshots (tenant_id,id,locale,generator_version,frozen_at,frozen_by,snapshot,snapshot_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [identity.tenantId,snapshotId,locale,generatorVersion,frozenAt,identity.actorId,stableStringify(snapshot),snapshotHash]);
    await appendAudit(client, { tenantId:identity.tenantId,actorId:identity.actorId,action:'review_snapshot.frozen',entityType:'review_snapshot',entityId:snapshotId,payload:{snapshotHash,locale,generatorVersion,auditHead:audit.head},occurredAt:frozenAt });
    return { id:snapshotId,status:'READY_FOR_REVIEW',locale,generatorVersion,frozenAt,snapshotSha256:snapshotHash,auditVerification:audit };
  }, { deadline: 'extended' });
}

export async function generateDossier(pool, identity, { snapshotId, storageRoot, at = new Date() }) {
  const createdPaths = [];
  try {
    return await withTenantTransaction(pool, identity, async (client) => {
      const selected = await client.query('SELECT * FROM review_snapshots WHERE id=$1', [snapshotId]);
      if (!selected.rowCount) throw dossierError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
      const existing = await client.query('SELECT id,artifact_type,sha256,size_bytes FROM dossier_artifacts WHERE snapshot_id=$1 ORDER BY artifact_type', [snapshotId]);
      if (existing.rowCount) return { snapshotId, replayed:true, artifacts:existing.rows };
      const snapshot = selected.rows[0].snapshot;
      // The frozen snapshot is verified against the digest recorded beside it, before anything is built from
      // it. That digest was computed at freeze time and then never read again.
      //
      // The runtime role cannot UPDATE `review_snapshots`, and that is correctly enforced — so this is not
      // guarding against the application. It guards against the cases a stored digest exists for at all:
      // storage corruption, a partial or mismatched restore, and a privileged owner. A dossier is produced to
      // be relied on by a third party; building one from a snapshot that no longer matches what was frozen
      // would put that party's name on the wrong facts, and the manifest would verify perfectly against them.
      const recorded = selected.rows[0].snapshot_sha256;
      if (recorded && sha256(stableStringify(snapshot)) !== recorded) {
        throw dossierError('REVIEW_SNAPSHOT_INTEGRITY_MISMATCH', 'The frozen review no longer matches its recorded digest.', 500);
      }
      const evidenceFiles = [];
      for (const item of snapshot.evidence || []) evidenceFiles.push({ name:`${item.id}-${item.filename}`, content:await readVerifiedEvidence(storageRoot,{tenantId:identity.tenantId,storageKey:item.storageKey,sizeBytes:item.sizeBytes,sha256:item.sha256}) });
      const built = await buildDossierArtifacts(snapshot,evidenceFiles);
      const files = [
        {type:'json',name:'dossier.json',content:Buffer.from(built.json)},
        {type:'pdf',name:'dossier.pdf',content:built.pdf},
        {type:'manifest',name:'checksum-manifest.json',content:Buffer.from(built.manifest)},
        {type:'zip',name:'dossier.zip',content:built.zip},
      ];
      const directoryKey = `${identity.tenantId}/dossiers/${snapshotId}`;
      const directory = safeStoragePath(storageRoot,`${directoryKey}/placeholder`).replace(/[\\/]placeholder$/,'');
      await mkdir(directory,{recursive:true,mode:0o700});
      const metadata = [];
      for (const file of files) {
        const key = `${directoryKey}/${file.name}`;
        const path = safeStoragePath(storageRoot,key);
        await writeFile(path,file.content,{flag:'wx',mode:0o600});
        createdPaths.push(path);
        const id = randomUUID();
        const checksum = sha256(file.content);
        await client.query(`INSERT INTO dossier_artifacts (tenant_id,id,snapshot_id,artifact_type,storage_key,sha256,size_bytes,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [identity.tenantId,id,snapshotId,file.type,key,checksum,file.content.length,identity.actorId,at.toISOString()]);
        metadata.push({id,artifactType:file.type,sha256:checksum,sizeBytes:file.content.length});
      }
      await appendAudit(client, { tenantId:identity.tenantId,actorId:identity.actorId,action:'dossier.generated',entityType:'review_snapshot',entityId:snapshotId,payload:{artifacts:metadata.map((item) => ({type:item.artifactType,sha256:item.sha256,sizeBytes:item.sizeBytes}))},occurredAt:at.toISOString() });
      return { snapshotId,replayed:false,artifacts:metadata };
      // Extended for the same reason as the freeze above, and for one more: this transaction stays open
      // across evidence reads, PDF and ZIP construction and four file writes, so the connection is held
      // for work that is not a database statement at all.
    }, { deadline: 'extended' });
  } catch (error) {
    for (const path of createdPaths) await rm(path,{force:true}).catch(() => {});
    throw error;
  }
}

// Authorization decides *whether* the caller may have the artifact. It says nothing about whether the bytes
// on disk are still the bytes the dossier attests to, and until 2026-07-30 this function read the file and
// sent it unchecked — while the row beside it carried the digest and the length the whole time.
//
// A dossier exists to be relied on by a third party. Serving content that no longer matches its recorded
// digest, from the endpoint whose purpose is to produce evidence, is the failure that matters most here: the
// manifest would still verify against itself, and the delivered file would not be what it describes.
//
// `readVerifiedEvidence` had done this for evidence files since Stage 2. The dossier path simply never
// adopted it, which is the ordinary way a control ends up applied to one of two similar routes.
export async function downloadDossierArtifact(client, { artifactId, storageRoot }) {
  const selected = await client.query('SELECT * FROM dossier_artifacts WHERE id=$1', [artifactId]);
  if (!selected.rowCount) throw dossierError('RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  const artifact = selected.rows[0];
  const target = confinedArtifactPath(storageRoot, artifact.tenant_id, artifact.storage_key);
  // O_NOFOLLOW on the final component, and a stat that insists on a regular file: a symlink placed where the
  // artifact should be would otherwise be followed wherever it points.
  let handle;
  let content;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw dossierError('DOSSIER_STORAGE_PATH_INVALID', 'Dossier storage path is invalid.', 500);
    content = await handle.readFile();
  } catch (error) {
    if (error.code === 'DOSSIER_STORAGE_PATH_INVALID') throw error;
    throw dossierError('DOSSIER_STORAGE_UNAVAILABLE', 'Dossier storage is unavailable.', 500);
  } finally {
    await handle?.close().catch(() => {});
  }
  // Size first, because it is the cheap half of the same question, then the digest. A deliberate 500 rather
  // than a 404: the caller was entitled to this artifact, and "we hold something that does not match what we
  // recorded" is a fact they must not be allowed to mistake for "it does not exist".
  if (content.length !== Number(artifact.size_bytes) || sha256(content) !== artifact.sha256) {
    throw dossierError('DOSSIER_INTEGRITY_MISMATCH', 'Dossier artifact integrity verification failed.', 500);
  }
  return { artifact, content };
}
