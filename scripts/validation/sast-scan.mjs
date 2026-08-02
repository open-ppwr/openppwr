// What `npm run gate:sast` actually is.
//
// Five regular expressions over every tracked `.js`, `.jsx` and `.mjs` file. That is the whole of it, and
// this header exists because the output line used to say something else.
//
// Until 2026-08-02 the pass line ended `semgrep=unavailable`, and nothing in this file had ever looked for
// semgrep — no `execFileSync('semgrep', ['--version'])`, no PATH probe, no exit-code branch. It was a
// statement about a fact the program did not examine, printed with the same authority as the two counts
// beside it, in the line the release contract cites as the gate's evidence. That is the defect class this
// repository keeps finding in its own tooling: a tool reporting on something it never examined. Finding it
// in the security gate's own output line is the reason the wording below is as long as it is.
//
// Two repairs were considered.
//
//   - **Probe for semgrep and report what the probe found.** Rejected. It would make the field honest and
//     leave it useless: semgrep is not installed on any machine this gate runs on, is not a declared
//     dependency, and is not installed by any workflow here, so the probe's answer is known before it runs.
//     A field whose value never varies is decoration, and a green `semgrep=absent` still invites the reader
//     to believe a semgrep-class analysis is the intended shape of this stage and merely missing today.
//   - **Install semgrep and depend on it.** Out of scope for a release closure, and it would add a Python
//     toolchain to the gate's dependency surface. Recorded as rejected rather than silently not done.
//
// So the marker states what ran. `analysis=regex-literal` says the technique; `rules=` names all five
// rather than counting them, because a count tells a reader nothing about coverage; `unchecked=` names what
// no regular expression over file text can reach, so the limitation travels with the evidence instead of
// living in a document the reader may not open. The five rules are real and this gate does fail on them —
// each match exits non-zero — but a pattern match is not a data-flow analysis and this line no longer
// implies otherwise.
//
//   node scripts/validation/sast-scan.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split(/\r?\n/).filter((file)=>/\.(?:js|jsx|mjs)$/.test(file));
const rules=[
  ['DYNAMIC_EVAL',/\beval\s*\(/],
  ['DYNAMIC_FUNCTION',/new\s+Function\s*\(/],
  ['SHELL_EXEC',/\bexecSync?\s*\(/],
  ['CLIENT_TENANT_HEADER',/x-(?:tenant|actor|role)(?:-id)?/i],
  ['TLS_DISABLED',/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/],
];
// Every rule matches literal text in one file at a time. Nothing here parses JavaScript, follows a value
// from an HTTP request to a query, crosses a module boundary, or reads anything that is not one of the
// three extensions above — `.sql`, `.sh`, `.yml`, the installer and the Dockerfile are all outside it.
const UNCHECKED='dataflow,taint,cross-file,ast,non-js-files';
const findings=[];
for(const file of files){const text=readFileSync(file,'utf8');for(const [name,pattern] of rules)if(pattern.test(text))findings.push(`${name}:${file}`);}
if(findings.length){for(const finding of findings)console.error(`SAST_FALLBACK_FINDING ${finding}`);process.exitCode=1;}
else console.log(`SAST_FALLBACK_PASS analysis=regex-literal targets=${files.length} rules=${rules.map(([name])=>name).join(',')} unchecked=${UNCHECKED}`);
