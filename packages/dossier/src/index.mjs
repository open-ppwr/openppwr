import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildEvidenceZip } from '@openppwr/evidence';
import PDFDocument from 'pdfkit';

export const FICTION_DISCLAIMER = 'All companies, products, materials, suppliers and documents in this environment are fictional and generated exclusively for demonstration and testing.';

// The disclaimer a dossier carries belongs to the tenant it describes, and the tenant row has held one
// since migration 001 — `dossier-service.mjs` already selects it and puts it in `organization`. This
// module then overwrote it with the constant above, on every dossier, so the product's actual deliverable
// declared its own contents fictional no matter whose data it held. A deployment holding one real
// organization's packaging data produced a compliance dossier saying that organization does not exist.
//
// Resolved from the snapshot instead, with the constant kept as the default rather than as the answer.
// That direction matters: a tenant created without a disclaimer, or a snapshot from before this change,
// still gets marked fictional. Nothing silently loses the marker — a document only stops declaring itself
// a demonstration when a tenant explicitly says it is not one, which is a decision someone had to make and
// record in the database.
//
// An empty string is honoured as "no disclaimer", deliberately: it is the only way for a real tenant to
// produce a document with no such line at all, and `??` rather than `||` is what makes it reachable.
function disclaimerFor(snapshot) {
  const organization = snapshot?.organization;
  if (organization && typeof organization === 'object' && typeof organization.disclaimer === 'string') {
    return organization.disclaimer;
  }
  return FICTION_DISCLAIMER;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

const dossierCatalogs={
  en:{title:'OpenPPWR Community dossier',organization:'Organization',assessments:'Assessments',outcomes:'Outcomes',rules:'Rules',generated:'Generated',review:''},
  pl:{title:'Dokumentacja OpenPPWR Community',organization:'Organizacja',assessments:'Oceny',outcomes:'Wyniki',rules:'Reguły',generated:'Wygenerowano',review:''},
  de:{title:'OpenPPWR Community Dossier',organization:'Organisation',assessments:'Bewertungen',outcomes:'Ergebnisse',rules:'Regeln',generated:'Erstellt',review:'REQUIRES HUMAN DE REGULATORY REVIEW'},
};
const require=createRequire(import.meta.url);
const fontPath=require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');

export async function renderDossierPdf(dossier) {
  const assessments = dossier.assessments || (dossier.assessment ? [dossier.assessment] : []);
  const organization = typeof dossier.organization === 'string' ? dossier.organization : dossier.organization?.name;
  const outcomes = assessments.reduce((summary, item) => ({ ...summary, [item.outcome]: (summary[item.outcome] || 0) + 1 }), {});
  const ruleVersions = [...new Set(assessments.map((item) => `${item.ruleId} ${item.ruleVersion}`))].sort().join(', ');
  const text=dossierCatalogs[dossier.locale]||dossierCatalogs.en;
  const lines = [
    text.title,
    `${text.organization}: ${organization}`,
    `${text.assessments}: ${assessments.length}`,
    `${text.outcomes}: ${Object.entries(outcomes).sort().map(([key,value]) => `${key}=${value}`).join(', ')}`,
    `${text.rules}: ${ruleVersions}`,
    `${text.generated}: ${dossier.generatedAt || dossier.frozenAt}`,
    // `buildDossierArtifacts` has already resolved this onto the canonical object, so the PDF and the JSON
    // cannot disagree about it. Read from the dossier rather than re-resolved here: two call sites deciding
    // the same thing separately is how a document ends up saying one thing and its machine-readable twin
    // another, and this pair is checksummed together and presented as one artifact.
    dossier.disclaimer ?? FICTION_DISCLAIMER,
    text.review,
  ].filter((line) => line !== '');
  const timestamp=new Date(dossier.generatedAt||dossier.frozenAt);
  const document=new PDFDocument({size:'A4',margin:56,pdfVersion:'1.4',compress:false,info:{Title:text.title,Author:'OpenPPWR Community',Creator:'OpenPPWR',Producer:'OpenPPWR',CreationDate:timestamp,ModDate:timestamp}});
  const chunks=[];
  document.on('data',(chunk)=>chunks.push(chunk));
  const finished=new Promise((resolvePdf,rejectPdf)=>{document.on('end',()=>resolvePdf(Buffer.concat(chunks)));document.on('error',rejectPdf);});
  document.font(fontPath).fontSize(18).text(lines[0]);
  document.moveDown().fontSize(10);
  for(const line of lines.slice(1).filter(Boolean))document.text(line,{lineGap:5});
  document.end();
  return finished;
}

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function createChecksumManifest(files) {
  return {
    algorithm: 'SHA-256',
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({
      name: file.name,
      sizeBytes: Buffer.byteLength(file.content),
      sha256: checksum(file.content),
    })),
  };
}

export function verifyChecksumManifest(manifestInput, files) {
  const manifest = typeof manifestInput === 'string' ? JSON.parse(manifestInput) : manifestInput;
  return stableStringify(manifest) === stableStringify(createChecksumManifest(files));
}

export async function buildDossierArtifacts(snapshot, evidenceFiles = []) {
  const dossier = canonical({ ...structuredClone(snapshot), disclaimer: disclaimerFor(snapshot) });
  const json = stableStringify(dossier);
  const pdf = await renderDossierPdf(dossier);
  const files = [
    { name: 'dossier.json', content: Buffer.from(json) },
    { name: 'dossier.pdf', content: pdf },
    ...evidenceFiles.map((file) => ({ name: `evidence/${file.name}`, content: Buffer.from(file.content) })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const manifest = stableStringify(createChecksumManifest(files));
  const zip = buildEvidenceZip([...files, { name: 'checksum-manifest.json', content: Buffer.from(manifest) }]);
  return { dossier, json, pdf, manifest, zip, files };
}
