import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `docs/internal` is internal-only and never exported (see scripts/validation/secret-scan.mjs, which asserts
// that invariant against the export allowlist). Its contents are produced by other tooling and by hand, and
// holding them to this repository's source formatting would fail the gate on material this repository does
// not author or publish.
const INTERNAL_ONLY_PREFIX='docs/internal/';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'})
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file)=>!file.replaceAll('\\','/').startsWith(INTERNAL_ONLY_PREFIX));
const checked=[];
const findings=[];
for(const file of files){
  if(!/\.(?:css|html|js|jsx|json|md|mjs|ps1|sql)$/.test(file))continue;
  const content=readFileSync(file);
  if(content.includes(0))continue;
  const text=content.toString('utf8');
  checked.push(file);
  if(!text.endsWith('\n'))findings.push(`${file}:FINAL_NEWLINE`);
  if(/[ \t]+$/m.test(text))findings.push(`${file}:TRAILING_WHITESPACE`);
}
if(findings.length){for(const finding of findings)console.error(`FORMAT_FINDING ${finding}`);process.exitCode=1;}else console.log(`FORMAT_CHECK_PASS files=${checked.length}`);

