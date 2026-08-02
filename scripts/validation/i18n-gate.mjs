import { readFile } from 'node:fs/promises';
import { catalogs, DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../../apps/web/src/i18n.js';
import { commonCopy, LEGAL_ROUTES, pageCopy, SITE_ROUTES } from '../../apps/web/src/site-content.js';
import { pageSections } from '../../apps/web/src/site-sections.js';
import { metaFor } from '../../apps/web/src/site-meta.js';

const source=await readFile(new URL('../../apps/web/src/App.jsx',import.meta.url),'utf8');
const baseKeys=Object.keys(catalogs[DEFAULT_LOCALE]).sort();
const failures=[];
for(const locale of SUPPORTED_LOCALES){
  const keys=Object.keys(catalogs[locale]).sort();
  const missing=baseKeys.filter((key)=>!keys.includes(key));
  const extra=keys.filter((key)=>!baseKeys.includes(key));
  const empty=baseKeys.filter((key)=>catalogs[locale][key]===undefined||catalogs[locale][key]===null);
  if(missing.length||extra.length||empty.length)failures.push(`${locale}: missing=${missing.join(',')} extra=${extra.join(',')} empty=${empty.join(',')}`);
  const commonKeys=Object.keys(commonCopy.en).sort();
  const localizedCommon=Object.keys(commonCopy[locale]||{}).sort();
  const commonMissing=commonKeys.filter((key)=>!localizedCommon.includes(key));
  const requiredPages=['home',...SITE_ROUTES,...LEGAL_ROUTES];
  const pageMissing=requiredPages.filter((key)=>!pageCopy[locale]?.[key]);
  if(commonMissing.length||pageMissing.length)failures.push(`${locale}: site_common_missing=${commonMissing.join(',')} site_pages_missing=${pageMissing.join(',')}`);
  // Detailed page sections must exist for the same routes in every locale, with the same
  // section count, so a partially translated page cannot ship.
  const sectionRoutes=Object.keys(pageSections.en).sort();
  const localeSections=pageSections[locale]||{};
  const sectionsMissing=sectionRoutes.filter((route)=>!Array.isArray(localeSections[route])||!localeSections[route].length);
  const sectionsShort=sectionRoutes.filter((route)=>Array.isArray(localeSections[route])&&localeSections[route].length!==pageSections.en[route].length);
  const sectionsEmpty=sectionRoutes.filter((route)=>(localeSections[route]||[]).some((section)=>!section.h||(!section.p&&!section.items?.length)));
  if(sectionsMissing.length||sectionsShort.length||sectionsEmpty.length)failures.push(`${locale}: sections_missing=${sectionsMissing.join(',')} sections_count_mismatch=${sectionsShort.join(',')} sections_empty=${sectionsEmpty.join(',')}`);
  // Every route needs a localized SEO title and description.
  const metaRoutes=['home',...SITE_ROUTES,...LEGAL_ROUTES];
  const metaMissing=metaRoutes.filter((route)=>{const entry=metaFor(locale,route);return !entry?.t||!entry?.d;});
  const metaUntranslated=locale==='en'?[]:metaRoutes.filter((route)=>{const entry=metaFor(locale,route);const base=metaFor('en',route);return entry.t===base.t&&entry.d===base.d;});
  if(metaMissing.length||metaUntranslated.length)failures.push(`${locale}: meta_missing=${metaMissing.join(',')} meta_untranslated=${metaUntranslated.join(',')}`);
}
// Enum values reach the screen as data, so a missing translation is not a build error — it is a
// Polish screen showing "infected". Every status value the schema permits, plus every assessment
// outcome, must therefore have a label in every locale, and that label must differ from English
// wherever English is not the locale: an untranslated fallback is exactly the mixed-language defect
// this gate exists to catch.
const schema=await readFile(new URL('../../packages/database/migrations/001_phase4_foundation.sql',import.meta.url),'utf8');
const quoted=(text)=>[...text.matchAll(/'([^']+)'/gu)].map((match)=>match[1]);

// Every closed CHECK enum in the schema, keyed by column. The previous pattern matched only columns
// *named* `*status`, and what makes a value need a translation is that the schema closes the set, not
// what the column happens to be called: `packaging_type` is as closed as `scan_status` is, and its five
// stored English words — sales, grouped, transport, ecommerce, reusable — reached a Polish and a German
// catalog table unchanged while this gate reported a pass.
const schemaEnums=new Map();
for(const match of schema.matchAll(/(?:^|[\s(,])(\w+)\s+text\b[^,]*?CHECK\s*\(\s*\1\s+IN\s*\(([^)]*)\)/gimu)){
  const column=match[1].toLowerCase();
  if(!schemaEnums.has(column))schemaEnums.set(column,new Set());
  for(const value of quoted(match[2]))schemaEnums.get(column).add(value.toLowerCase());
}
if(schemaEnums.size<8)failures.push(`enum: schema parse produced only ${schemaEnums.size} closed enum columns`);

// The columns the interface renders as translated badges, read out of the source rather than restated
// here — so adding a column to that set is what brings its values under this gate, and forgetting to add
// one is what the cross-check further down reports.
const enumColumnDeclaration=/enumColumns\s*=\s*new Set\(\[([^\]]*)\]\)/u.exec(source);
if(!enumColumnDeclaration)failures.push('enum: enumColumns could not be read from App.jsx');
const displayedEnumColumns=new Set(quoted(enumColumnDeclaration?.[1]||''));

const schemaValues=new Set([...schemaEnums]
  .filter(([column])=>/status$/u.test(column))
  .flatMap(([,values])=>[...values]));
for(const column of displayedEnumColumns)for(const value of schemaEnums.get(column)||[])schemaValues.add(value);
for(const outcome of ['pass','fail','unknown','not_applicable'])schemaValues.add(outcome);
for(const derived of ['current','superseded'])schemaValues.add(derived);
if(schemaValues.size<15)failures.push(`enum: schema parse produced only ${schemaValues.size} status values`);

// Column headings are the other half of the same defect, and this gate saw only half of those too.
// `/columns=\{\[…\]/` matches an inline array literal, which is how the evidence, gap and scan-queue
// tables are written — but the catalog passes `columns={catalogColumns[catalogResource]}`, a reference to
// a declaration at the top of the file, so its eight columns were checked by nothing at all and every one
// of them was missing a label in all three locales.
function declarationBody(name){
  const start=source.search(new RegExp(`\\bconst\\s+${name}\\s*=`,'u'));
  if(start<0)return null;
  let depth=0;
  for(let index=source.indexOf('=',start);index<source.length;index+=1){
    const character=source[index];
    if(character==='{'||character==='[')depth+=1;
    else if(character==='}'||character===']'){depth-=1;if(depth===0)return source.slice(start,index+1);}
    else if(depth===0&&character===';')return source.slice(start,index);
  }
  return null;
}
const renderedColumns=new Set();
for(const match of source.matchAll(/columns=\{\[([^\]]*)\]/gu))for(const column of quoted(match[1]))renderedColumns.add(column);
for(const match of source.matchAll(/columns=\{([A-Za-z_$][\w$]*)/gu)){
  const body=declarationBody(match[1]);
  if(body===null){failures.push(`column: columns={${match[1]}…} names a declaration this gate cannot read`);continue;}
  for(const group of body.matchAll(/\[([^\]]*)\]/gu))for(const column of quoted(group[1]))renderedColumns.add(column);
}
// A floor on the parse itself. Both extractions above are regular expressions over source text; if either
// silently stops matching, the checks below pass by finding nothing to check, which is the exact failure
// mode being repaired here.
if(renderedColumns.size<20)failures.push(`column: source parse produced only ${renderedColumns.size} rendered columns`);

// A rendered column whose value set the schema closes must be rendered as a translated enum. Omitted from
// `enumColumns`, the interface prints the stored English word straight into the table — which is what
// `packaging_type` did, in every locale, for as long as the catalog screen has existed.
const rawEnumColumns=[...renderedColumns].filter((column)=>schemaEnums.has(column)&&!displayedEnumColumns.has(column));
if(rawEnumColumns.length)failures.push(`enum: rendered column(s) with a closed schema value set are not translated: ${rawEnumColumns.sort().join(',')}`);

for(const locale of SUPPORTED_LOCALES){
  const untranslatedEnums=[];
  const missingEnums=[];
  for(const value of schemaValues){
    const label=catalogs[locale][`val_${value}`];
    if(!label)missingEnums.push(value);
    else if(locale!==DEFAULT_LOCALE&&label===catalogs[DEFAULT_LOCALE][`val_${value}`]&&!/^[A-Z0-9-]+$/u.test(label))untranslatedEnums.push(value);
  }
  const missingColumns=[...renderedColumns].filter((column)=>!catalogs[locale][`col_${column}`]);
  const roles=[...new Set([...source.matchAll(/role_\$\{account\.role\}/gu)].length?Object.keys(catalogs[DEFAULT_LOCALE]).filter((key)=>key.startsWith('role_')).map((key)=>key.slice(5)):[])];
  const missingRoles=roles.filter((role)=>!catalogs[locale][`role_${role}`]||!catalogs[locale][`roleUse_${role}`]);
  if(missingEnums.length||untranslatedEnums.length||missingColumns.length||missingRoles.length){
    failures.push(`${locale}: enum_missing=${missingEnums.sort().join(',')} enum_untranslated=${untranslatedEnums.sort().join(',')} column_missing=${missingColumns.sort().join(',')} role_missing=${missingRoles.sort().join(',')}`);
  }
}

// Every component that translates, not only the largest one. `Locked.jsx` was carved out of `App.jsx`
// so that the application navigation could share the disabled-control mechanism, and it took
// `t('lockPermission')` with it — a key this check stopped seeing the moment the file moved. The
// column and enum parsing above stays on `App.jsx`, which is where those declarations live.
const translating=source+await readFile(new URL('../../apps/web/src/Locked.jsx',import.meta.url),'utf8');
const used=new Set([...translating.matchAll(/\bt\('([^']+)'\)/g)].map((match)=>match[1]));
const missingUsage=[...used].filter((key)=>!baseKeys.includes(key));
if(missingUsage.length)failures.push(`usage: missing=${missingUsage.sort().join(',')}`);
// The German catalog previously had to carry `REQUIRES HUMAN DE REGULATORY REVIEW`, and this gate
// enforced its presence — so the interface was required to display an internal review status to
// German users, and removing it broke the build. The review gate itself is unchanged and still
// tracked in the regulatory review record; what changed is that it is no longer
// published to the user. content-marker-gate.mjs now asserts the opposite, against the built bundle.
for(const locale of SUPPORTED_LOCALES){
  if('regulatoryReview' in catalogs[locale])failures.push(`${locale}: the regulatory review marker must not be a user-visible string`);
}
if(failures.length){console.error(`I18N_GATE_FAIL\n${failures.join('\n')}`);process.exitCode=1;}
else console.log(`I18N_GATE_PASS locales=${SUPPORTED_LOCALES.join(',')} keys=${baseKeys.length} used=${used.size} site_pages=${1+SITE_ROUTES.length+LEGAL_ROUTES.length} fallback=${DEFAULT_LOCALE} enum_values=${schemaValues.size}`);
