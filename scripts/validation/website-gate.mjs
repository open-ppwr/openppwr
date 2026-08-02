// Route, content-completeness and SEO checks for the localized marketing site.
// Runs without a browser: asserts the content model itself is complete and consistent
// with the owner decisions, so a page cannot ship as a fragment or with an unapproved claim.
import { LEGAL_ROUTES, pageCopy, SITE_ROUTES } from '../../apps/web/src/site-content.js';
import { pageSections, PRIVATE_ROUTES } from '../../apps/web/src/site-sections.js';
import { metaFor } from '../../apps/web/src/site-meta.js';

const locales=['en','pl','de'];
const routes=['home',...SITE_ROUTES,...LEGAL_ROUTES];
const failures=[];
const fail=(message)=>failures.push(message);

// Claims that require an owner decision that was never given. Case-insensitive.
const forbidden=[
  {pattern:/\bISO ?27001\b/i,why:'unapproved certification claim'},
  {pattern:/\bSOC ?2\b/i,why:'unapproved certification claim'},
  {pattern:/\b99\.\d+ ?%/,why:'unapproved uptime claim'},
  {pattern:/\b(EUR|USD|PLN) ?\d/i,why:'unapproved price'},
  {pattern:/\$\d/,why:'unapproved price'},
  {pattern:/\d+ ?€/,why:'unapproved price'},
];

for(const locale of locales){
  for(const route of routes){
    const copy=pageCopy[locale]?.[route];
    if(!copy){fail(`${locale}/${route}: no page copy`);continue;}
    if(!copy.title||copy.title.length<8)fail(`${locale}/${route}: title missing or too short`);
    if(!copy.summary||copy.summary.length<40)fail(`${locale}/${route}: summary missing or too short`);

    const meta=metaFor(locale,route);
    if(!meta.t||meta.t.length<10)fail(`${locale}/${route}: SEO title missing or too short`);
    if(!meta.d||meta.d.length<50)fail(`${locale}/${route}: SEO description missing or too short`);
    if(meta.d.length>320)fail(`${locale}/${route}: SEO description too long (${meta.d.length})`);

    const sections=pageSections[locale]?.[route];
    if(sections){
      if(sections.length<6)fail(`${locale}/${route}: only ${sections.length} sections, expected a complete page`);
      for(const section of sections){
        if(!section.h)fail(`${locale}/${route}: section without a heading`);
        const body=section.p||(section.items||[]).join(' ');
        if(!body||body.length<25)fail(`${locale}/${route}: section "${section.h}" is a fragment`);
      }
    }

    const haystack=[copy.title,copy.summary,meta.t,meta.d,...(sections||[]).flatMap((section)=>[section.h,section.p,...(section.items||[])])].filter(Boolean).join(' \n ');
    for(const rule of forbidden){
      if(rule.pattern.test(haystack))fail(`${locale}/${route}: ${rule.why} — matched ${rule.pattern}`);
    }
  }
}

// Pages that must exist in full, per the continuation requirements. A withheld route is excluded by
// design rather than by omission: it must have no content, which the legal-page check above asserts.
for(const required of ['enterprise','pricing','demo','roadmap','security','trust','partners','privacy','cookies','imprint'].filter((route)=>!PRIVATE_ROUTES.includes(route))){
  for(const locale of locales){
    if(!pageSections[locale]?.[required]?.length)fail(`${locale}/${required}: required expanded page is missing detailed sections`);
  }
}

// A legal page is either finished or labelled as a draft, and the gate enforces both directions.
//
// An unfinished page that is not labelled misleads the reader. A finished page that still carries a
// draft marker, or a leftover placeholder, is equally a defect: the owner approved this text on
// 2026-07-29 and a permanent "under review" notice on approved copy is noise that trains readers to
// ignore the notice when it matters.
const draftPattern=/DRAFT|PROJEKT|ENTWURF|TBD|PLACEHOLDER|WYMAGA PRZEGL/iu;
for(const locale of locales){
  for(const route of ['privacy','terms','cookies']){
    const sections=pageSections[locale][route]||[];
    const text=sections.map((section)=>`${section.h} ${section.p||''} ${(section.items||[]).join(' ')}`).join(' ');
    // A withheld route ships no content at all. Marking a page as unreviewed and shipping it anyway
    // still puts unreviewed text in front of a reader; the owner's decision was to withhold instead,
    // so the assertion is that the bundle carries nothing for it.
    if(PRIVATE_ROUTES.includes(route)){
      if(sections.length)fail(`${locale}/${route}: route is withheld but its content is still in the bundle`);
      continue;
    }
    // Every published legal page is finished, so any draft or placeholder wording in one is a defect.
    if(draftPattern.test(text))fail(`${locale}/${route}: published legal page contains draft or placeholder wording`);
  }
}

// Design Partner is the only partnership open. Owner Round 11 allows the other six to be described,
// which is a narrower permission than it sounds: each must carry a Planned status next to its name,
// and none of them may read as accepting applications or conferring anything.
//
// The rule therefore checks the qualifier that follows the name rather than forbidding the name, and
// separately forbids the two words that would turn a description into an offer.
const plannedQualifier=/Planned|Planowane|Geplant/u;
for(const locale of locales){
  const sections=pageSections[locale].partners||[];
  const text=sections.map((section)=>`${section.h} ${section.p||''} ${(section.items||[]).join(' ')}`).join(' ');
  for(const described of ['Implementation Partner','Technology Partner','Regulatory Content Partner','Training Partner','Referral Partner']){
    const index=text.indexOf(described);
    if(index<0)continue;
    if(!plannedQualifier.test(text.slice(index,index+60))){
      fail(`${locale}/partners: ${described} appears without a Planned status beside it`);
    }
  }
  // No partner may be described as certified, accredited or tiered, in any locale, ever — there is no
  // programme to be certified by.
  if(/certified partner|zertifizierter partner|certyfikowanym partnerem OpenPPWR jest|akredytowany partner/iu.test(text)){
    fail(`${locale}/partners: claims a certified or accredited partner status that does not exist`);
  }
  if(!/Design Partner/u.test(text))fail(`${locale}/partners: the one open programme is not named`);
}

if(failures.length){console.error(`WEBSITE_GATE_FAIL\n${failures.join('\n')}`);process.exitCode=1;}
else console.log(`WEBSITE_GATE_PASS locales=${locales.join(',')} routes=${routes.length} expanded_pages=${Object.keys(pageSections.en).length}`);
