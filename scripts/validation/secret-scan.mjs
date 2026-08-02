import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const allFiles=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);

// `docs/internal` is internal-only by definition: it holds account audits, private infrastructure detail and
// internal Git systems, deliberately. Scanning it for private material reports the reason those files exist,
// and a scanner whose findings are all expected is one people learn to ignore.
//
// The exclusion is sound only because that tree can never be exported. That invariant used to be asserted
// here, by reading the export allowlist and failing if any entry admitted an internal path. It has moved to
// the export validator, which owns the allowlist and runs only where the allowlist exists. Two reasons: this
// scanner ships in the public export, where the allowlist deliberately does not, so the assertion degraded
// to a no-op precisely where nobody would notice — a check that cannot fail; and naming the allowlist's path
// from a public file disclosed the existence of the withheld-file index the allowlist is.
const INTERNAL_ONLY_PREFIX = 'docs/internal/';
const files = allFiles.filter((file) => !file.replaceAll('\\', '/').startsWith(INTERNAL_ONLY_PREFIX));
const privatePatternPath=resolve('.work-private','sensitive-patterns.txt');
const privatePatterns=existsSync(privatePatternPath)?readFileSync(privatePatternPath,'utf8').split(/\r?\n/).map((item)=>item.trim()).filter((item)=>item&&!item.startsWith('#')):[];
const rules=[
  ['PRIVATE_KEY',/-----BEGIN [A-Z ]+PRIVATE KEY-----/],
  ['CLOUD_KEY',/\bAKIA[0-9A-Z]{16}\b/],
  ['GITHUB_TOKEN',/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ['BEARER_LITERAL',/Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i],
  // The value must contain no whitespace. A real credential never does, while user-facing strings
  // routinely do — an i18n key such as `advancedToken: 'Sign in with an access token instead'`
  // otherwise reports as a secret, and a scanner that cries wolf gets ignored or bypassed.
  //
  // A dollar sign is NOT excluded from the value. Excluding it was tried and was a security regression:
  // passphrases and vendor keys containing one — a diceware phrase joined by a dollar sign, a live payment
  // key with one embedded — stopped matching entirely, and those are exactly what this rule exists to
  // catch, and a direct regex comparison confirmed it. The narrow case that
  // needed exempting is a shell parameter expansion, as in the installer's own positional-argument
  // handling: syntax meaning "this argument, or this placeholder if unset", naming no credential at all.
  // That shape is exempted below by structure, not by banning a character real secrets legitimately use.
  ['SECRET_ASSIGNMENT',/(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{16,}["']/i, isShellExpansionOnly],
];

// True when every value this rule matched in the text is a bare shell parameter expansion. The finding is
// only suppressed when there is nothing else it could be: one real quoted secret anywhere in the file keeps
// the finding, even if a shell expansion also appears.
function isShellExpansionOnly(text) {
  const all = text.match(/(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{16,}["']/gi) || [];
  return all.length > 0 && all.every((match) => /["']\$\{[^"']*\}["']$/.test(match));
}
const findings=[];
for(const file of files){
  let text;try{text=readFileSync(file,'utf8');}catch{continue;}
  for(const [name,pattern,suppressIf] of rules)if(pattern.test(text)&&!(suppressIf&&suppressIf(text)))findings.push(`${name}:${file}`);
  for(const pattern of privatePatterns)if(file.toLowerCase().includes(pattern.toLowerCase())||text.toLowerCase().includes(pattern.toLowerCase()))findings.push(`PRIVATE_PATTERN:${file}`);
}
const unique=[...new Set(findings)].sort();
if(unique.length){for(const finding of unique)console.error(`SECRET_SCAN_FINDING ${finding}`);process.exitCode=1;}else if(!process.exitCode)console.log(`SECRET_SCAN_PASS files=${files.length} findings=0 internal_only_skipped=${allFiles.length-files.length} private_patterns=${privatePatterns.length?'loaded':'unavailable'}`);

