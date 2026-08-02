import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// Only to count and name them. A green local gate is not a complete gate, and nothing in this file's
// output said so: the suites that need a running deployment are invisible here, which is how seven of
// them went years without a caller. Imported rather than hardcoded so the count cannot drift.
import { deploymentStages } from './deployment-gate.mjs';

// Per-stage budgets, not one global timeout.
//
// The gate previously ran every stage with spawnSync and no time limit. When the browser journey
// finished but its process did not exit, the gate stalled with no output, no stage name and no
// indication of which step was stuck. It looked identical to slow progress, and the only way to end
// it was to kill the run and lose the evidence.
//
// Each budget is set from observed duration with generous headroom, so a stage that exceeds it is
// genuinely stuck rather than merely slow on a loaded machine.
const stages = [
  { command: 'format:check', timeoutMs: 2 * 60_000 },
  { command: 'lint', timeoutMs: 3 * 60_000 },
  { command: 'typecheck', timeoutMs: 5 * 60_000 },
  { command: 'test:unit', timeoutMs: 5 * 60_000 },
  { command: 'test:contract', timeoutMs: 5 * 60_000 },
  { command: 'test:integration', timeoutMs: 20 * 60_000 },
  { command: 'test:e2e', timeoutMs: 30 * 60_000 },
  // The demonstration process an evaluator is invited to reproduce, asserted against the published
  // outcome counts rather than against "some of each". Separate from test:e2e, which proves the
  // reference workflow is deterministic; this proves the demonstration is complete and its numbers are
  // the numbers we publish.
  { command: 'test:demo:full-e2e', timeoutMs: 10 * 60_000 },
  { command: 'i18n:gate', timeoutMs: 2 * 60_000 },
  { command: 'website:gate', timeoutMs: 2 * 60_000 },
  // `website:gate` reads the source of truth; this renders all 57 localized pages in a real browser and
  // asserts the head tags and expanded sections are actually in the DOM. It had no caller at all — one of
  // the seven gates found able to report success having verified nothing, and the only one of the seven
  // that needs no deployment. It builds its own web bundle and drives the same browser `a11y:gate` and
  // `test:e2e:browser` already drive here, so it belongs in the local gate rather than the deployment one.
  { command: 'website:browser', timeoutMs: 15 * 60_000 },
  { command: 'copy:gate', timeoutMs: 2 * 60_000 },
  // Parity between what the interface says a role may do and what the server grants.
  { command: 'permissions:gate', timeoutMs: 2 * 60_000 },
  // The approved documentation language policy, and the cross-host link contracts.
  { command: 'docs:language:gate', timeoutMs: 2 * 60_000 },
  { command: 'link:gate', timeoutMs: 2 * 60_000 },
  // The documented first-run sequence against the installer's own dispatch table. A page that names a
  // subcommand the script does not have, or that changes invocation form mid-block and thereby depends on
  // a side effect of `install` it never states, is a first-impression failure for every self-hoster.
  { command: 'installer:docs:gate', timeoutMs: 2 * 60_000 },
  // The documentation the product itself serves, against the code it describes. `installer:docs:gate`
  // checks that the commands on those pages exist; this checks that the procedures around them work — the
  // precondition a refusal names, the variable the stack will not start without, the migration level, the
  // packages called unreachable, the routes the API reference lists, and the routes no document may deny
  // while the server registers them. Every other parity gate here compares code with code or a contract
  // with code; these pages are what a self-hoster actually reads, in three languages, and until this stage
  // existed nothing compared them with anything.
  { command: 'product:docs:gate', timeoutMs: 2 * 60_000 },
  // The identifier-validation property, checked across every route rather than the ones that failed.
  { command: 'routes:gate', timeoutMs: 2 * 60_000 },
  // The release contract against the code it describes. Beside the other parity gates on purpose: it is
  // the same kind of check they are — a document and the thing it claims, compared — applied to the one
  // document a stranger reads before deciding whether to run any of this. A promise nothing keeps is the
  // failure this whole list exists to make impossible, and until now the file making the most promises
  // was the only one nothing read.
  { command: 'release:contract:gate', timeoutMs: 2 * 60_000 },
  // One version, said once. Fourteen manifests, a lockfile, a build argument, eight places in the release
  // workflow, a deployment example an operator copies and a portal in three languages all state the
  // version, and nothing compared them: the tree carried release notes for `1.0.0` while every manifest,
  // workflow and gate still said `0.2.0-beta.1`, and no check could see it. A manifest that disagrees with
  // the workflow builds an image under one identity and publishes it under another.
  { command: 'version:coherence:gate', timeoutMs: 2 * 60_000 },
  // A service that loses its journald block falls back to the daemon default (json-file) and silently
  // stops having any age bound at all, and the shipped wording drifts to "30 days" the moment nobody is
  // asserting that the promise is bounded by size too.
  { command: 'logs:retention:gate', timeoutMs: 2 * 60_000 },
  // Supplier isolation *inside* one tenant. Separate from the cross-tenant suite on purpose: every
  // isolation test in this programme asked the cross-tenant question and none asked this one, which is how
  // the supplier leak survived. Boots its own database, so it needs a real budget rather than a gate-script one.
  { command: 'security:supplier-isolation', timeoutMs: 10 * 60_000 },
  // Browser-driven, so it needs a real budget rather than a gate-script one.
  { command: 'a11y:gate', timeoutMs: 15 * 60_000 },
  { command: 'acme:validate', timeoutMs: 5 * 60_000 },
  { command: 'secret:scan', timeoutMs: 5 * 60_000 },
  { command: 'gate:sast', timeoutMs: 10 * 60_000 },
  { command: 'dependency:audit', timeoutMs: 10 * 60_000 },
  { command: 'build', timeoutMs: 10 * 60_000 },
  // After the build, because it scans the emitted bundle rather than the source: a marker composed
  // at runtime from a translation key does not appear in any component file.
  { command: 'markers:gate', timeoutMs: 2 * 60_000 },
  // `public-export:validate` used to run here and no longer exists as an npm script. The export validator,
  // the allowlist it reads, the shared parser and the archiving script are all withheld from the public
  // export — the allowlist is by construction an index of every withheld document, and publishing the
  // machinery alongside the archive publishes the redaction list with the redacted document. An exported
  // `package.json` therefore cannot name the validator, and this gate — which a public user runs — cannot
  // invoke it.
  //
  // That is not a loss of coverage, because the check moved rather than disappeared: the clean-install
  // release script — withheld with the rest of the export machinery, and so not named here — runs the
  // validator directly before it builds an archive, which is the fail-closed place for it. A public
  // user is not producing an export and has nothing for this stage to validate. Removing the stage here was
  // a correction; leaving it declared after the script was deleted made every full-gate run fail on a
  // missing script, which is how this was found.
  { command: 'release:image:validate', timeoutMs: 10 * 60_000 },
];

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to run the gate without a shell.');

const HEARTBEAT_MS = 60_000;

// Killing the npm wrapper leaves the real work running: npm spawns node, which spawns test runners,
// browsers and database processes. On Windows only taskkill /T reliably ends the tree, so a timeout
// stops the work rather than orphaning it and moving on.
function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function runStage({ command, timeoutMs }) {
  return new Promise((resolveStage) => {
    const startedAt = Date.now();
    console.log(`\nGATE_STAGE_START ${command} timeout=${Math.round(timeoutMs / 1000)}s at=${new Date().toISOString()}`);
    const child = spawn(process.execPath, [npmCli, 'run', command], {
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    });
    console.log(`GATE_STAGE_PID ${command} pid=${child.pid}`);

    // A stage that produces no output for minutes is indistinguishable from a hang without this.
    const heartbeat = setInterval(() => {
      console.log(`GATE_STAGE_RUNNING ${command} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s pid=${child.pid}`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`GATE_STAGE_TIMEOUT ${command} after=${Math.round(timeoutMs / 1000)}s pid=${child.pid} — terminating process tree`);
      killTree(child);
    }, timeoutMs);

    const finish = (exitCode, spawnError) => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
      const status = timedOut ? 'TIMEOUT' : exitCode === 0 ? 'PASS' : 'FAIL';
      console.log(`GATE_STAGE_END ${command} status=${status} exit=${exitCode} duration=${durationSeconds}s`);
      resolveStage({ command, status, exitCode, durationSeconds, timedOut, spawnError: spawnError || null, pid: child.pid });
    };

    child.on('error', (error) => finish(null, error.code || error.message));
    // A stage killed by a signal has not passed, whatever exit code accompanies it.
    child.on('close', (code, signal) => finish(signal ? null : code, signal ? `signal:${signal}` : null));
  });
}

// Read before the first stage, so a broken deployment-stage list fails immediately and loudly rather
// than after an hour of work.
const deferred = await deploymentStages();

const report = { startedAt: new Date().toISOString(), stages: [] };
for (const stage of stages) {
  const result = await runStage(stage);
  report.stages.push(result);
  if (result.status !== 'PASS') { report.status = result.status === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL'; break; }
}
report.finishedAt = new Date().toISOString();
report.status ||= 'PASS';
report.totalSeconds = Number(((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000).toFixed(3));
// Kept under the previous key as well, so existing tooling that reads the report does not break.
report.commands = report.stages;
// In the report as well as on the terminal: a reader who takes `status: "PASS"` from this file and
// nothing else would otherwise have no way to know what it does not cover.
report.deploymentStagesNotRun = deferred.map((stage) => stage.id);

const directory = resolve('artifacts', 'gates');
await mkdir(directory, { recursive: true });
const path = resolve(directory, 'full-gate-report.json');
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('\nGATE_SUMMARY');
for (const stage of report.stages) console.log(`  ${stage.status.padEnd(7)} ${stage.command.padEnd(24)} ${stage.durationSeconds}s`);
console.log(`FULL_GATE_${report.status} stages=${report.stages.length} total=${report.totalSeconds}s report=${path}`);
// Printed on every run, pass or fail, and after the verdict so it is the last thing read. This gate
// covers what a workstation can check; it does not and cannot cover the suites that need a running
// deployment, and a reader who sees only the line above will believe otherwise.
// The housekeeping, reported separately from the verdict and after it.
//
// A gate that passed every assertion and left a database running is not the same thing as one that passed
// and cleaned up. Measured here: six orphaned PostgreSQL processes accumulated across a day of runs that
// had all reported PASS, on the workstation whose PASS is the release evidence. Collapsing the two into
// one word is how that stopped being visible, so `cleanup` is its own line and its own exit condition.
//
// It does not reap. A release run should report what it left behind rather than tidy it away silently,
// because the tidying is what hid the accumulation in the first place; `--reap` exists for the operator
// who has read the line and wants it gone.
let cleanup = 'UNKNOWN';
try {
  const listed = execFileSync(process.execPath, [resolve('scripts', 'validation', 'orphan-check.mjs')], { encoding: 'utf8' });
  cleanup = listed.includes('ORPHAN_CHECK_PASS') ? 'PASS' : 'FAIL';
  process.stdout.write(listed);
} catch (error) {
  cleanup = 'FAIL';
  process.stdout.write(`${error.stdout || ''}${error.stderr || ''}`);
}
report.cleanup = cleanup;
await writeFile(path, `${JSON.stringify(report, null, 2)}
`, 'utf8');
console.log(`FULL_GATE_CLEANUP=${cleanup}`);
if (cleanup !== 'PASS') {
  console.log('  A PASS that leaked a process is not a release PASS. Run `node scripts/validation/orphan-check.mjs --reap`.');
  process.exitCode = 1;
}
console.log(`DEPLOYMENT_GATES_NOT_RUN_HERE count=${deferred.length} stages=${deferred.map((stage) => stage.id).join(',')} runner=deployment-gate`);
console.log('  A passing local gate is not a complete gate. Run `npm run deployment-gate` against a deployment.');
if (report.status !== 'PASS') process.exitCode = 1;
