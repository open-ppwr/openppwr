// The gate for everything `full-gate.mjs` cannot run: the suites that need a deployment.
//
// Seven gates were found able to report success having verified nothing. Every one of them was fixed —
// and every one of them shared a second defect the fix did not touch: nothing called them. They were run
// by hand, against deployments, and their exit codes were read by a person or by nobody. That is the
// reason a black-box security scan could print `FAIL` and exit 0 for as long as it did. Restoring the
// exit codes without giving them a caller leaves the same blind spot one level up.
//
// This is the caller. It runs each deployment-dependent suite, reads every exit code, and prints one
// verdict line.
//
//   npm run deployment-gate
//
// ---------------------------------------------------------------------------------------------------
// Skip semantics — the whole point of this file
//
// These suites need things a workstation does not have: a running deployment, a bootstrap identities
// file, a second tenant, an operator credential. The obvious design — skip a stage whose prerequisites
// are absent and count the run clean — reproduces exactly the defect this runner exists to eliminate. A
// gate that skips silently is a gate that cannot fail.
//
// So an unmet prerequisite is a named outcome, not an absence:
//
//   PREREQUISITES_MISSING   the stage did not run, and the verdict line says so, and names it
//   NOT_REACHED             an earlier stage failed, so this one was never attempted
//
// and the verdict line has three shapes, never two:
//
//   DEPLOYMENT_GATE_PASS         every declared stage ran and passed                      exit 0
//   DEPLOYMENT_GATE_INCOMPLETE   everything that ran passed, but not everything ran       exit 1
//   DEPLOYMENT_GATE_FAIL         a stage failed, or nothing could run at all              exit 1
//
// INCOMPLETE is non-zero deliberately. The house rule these seven fixes established is that the exit
// code says what the summary says, and "some of the security suites were never executed" is not what a
// zero exit code says. A run in which *nothing* could execute is a FAIL rather than an INCOMPLETE,
// because a runner that reports a tidy `unmet=6` on a laptop and calls it a soft pass is the same lie in
// a new costume.
//
// The verdict logic is pure and self-tested on every run (`--self-test` runs only that). A runner whose
// own pass/fail arithmetic is unverified would be one more gate nobody had checked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---- prerequisites --------------------------------------------------------------------------------
// Each returns { name, met, detail }. Read from the scripts themselves, not assumed: every variable
// named below is one the target suite requires and throws without.

const envSet = (name) => async () => ({
  name: `${name} is set`,
  met: Boolean(process.env[name]),
  detail: process.env[name] ? '' : 'not set',
});

// A variable naming a file is only a prerequisite once the file is actually there. The bootstrap
// identities files hold live bearer credentials and are written by the installer under the deployment's
// state directory, so a stale or mistyped path is the common failure — and it fails inside the suite,
// after it has already started, rather than here where it can be named.
const envFileExists = (name) => async () => {
  const value = process.env[name];
  if (!value) return { name: `${name} names an existing file`, met: false, detail: 'not set' };
  const met = existsSync(value);
  return { name: `${name} names an existing file`, met, detail: met ? '' : 'names a path that does not exist' };
};

const playwrightBrowser = async () => {
  try {
    const { chromium } = await import('@playwright/test');
    const executable = chromium.executablePath();
    const met = Boolean(executable) && existsSync(executable);
    return { name: 'a Playwright Chromium build is installed', met, detail: met ? '' : 'run `npx playwright install chromium`' };
  } catch (error) {
    return { name: 'a Playwright Chromium build is installed', met: false, detail: `not resolvable: ${error?.code || error?.message}` };
  }
};

// The shell harnesses read container state, socket listeners and a database through the local compose
// project. They are host tools, not portable scripts, and running them anywhere else produces noise
// rather than findings.
const posixShellHost = async () => ({
  name: 'a POSIX host with /bin/bash',
  met: process.platform !== 'win32' && existsSync('/bin/bash'),
  detail: process.platform === 'win32' ? 'this is a Windows host' : '/bin/bash was not found',
});

// The harnesses source an operator credential file whose location belongs to the deployment, not to this
// repository. Naming the variable rather than the path keeps the check honest without writing a private
// path into a file that ships publicly. Point it at the same file the harnesses source.
const ACCESS_ENV_VARIABLE = 'OPENPPWR_DEPLOYMENT_GATE_ACCESS_ENV';

// ---- declared stages ------------------------------------------------------------------------------
// Order is not alphabetical and not arbitrary. Authentication is rate limited, and the limit works: the
// suites that spend the budget must run after the suites that need it. `security:dast` ends with twelve
// deliberate failed logins, and the negative-test harness ends by exhausting the per-address budget
// outright, which is why it declares the highest order number of anything here.

const SHELL_HARNESS_DEFAULT_ORDER = 60;
const SHELL_HARNESS_TIMEOUT_MS = 25 * 60_000;

const declaredStages = [
  {
    id: 'test:ui-states',
    order: 10,
    kind: 'npm',
    target: 'test:ui-states',
    timeoutMs: 10 * 60_000,
    why: 'the eight UI states, driven through a real browser against a deployment',
    prerequisites: [envSet('OPENPPWR_UI_BASE_URL'), envFileExists('OPENPPWR_UI_BOOTSTRAP_JSON'), playwrightBrowser],
  },
  {
    id: 'security:two-tenant-matrix',
    order: 20,
    kind: 'npm',
    target: 'security:two-tenant-matrix',
    timeoutMs: 15 * 60_000,
    why: 'cross-tenant isolation at the API and in the database, both directions',
    // OPENPPWR_MATRIX_RUNTIME_URL is optional to the suite and required here. Without it the database
    // half is skipped and the suite still prints a PASS — it discloses the skip on the verdict line, so
    // it is not lying, but a stage that can pass having asked PostgreSQL nothing is not a stage this
    // runner should be able to record as executed. Required, not loosened: the suite's own checks are
    // untouched.
    prerequisites: [
      envSet('OPENPPWR_MATRIX_DATABASE_URL'),
      envSet('OPENPPWR_MATRIX_PASSWORD'),
      envSet('OPENPPWR_MATRIX_RUNTIME_URL'),
    ],
  },
  {
    id: 'security:dast',
    order: 50,
    kind: 'npm',
    target: 'security:dast',
    timeoutMs: 15 * 60_000,
    why: 'black-box probes over real HTTP against a running deployment',
    prerequisites: [envSet('OPENPPWR_DAST_BASE_URL'), envFileExists('OPENPPWR_DAST_BOOTSTRAP_JSON')],
  },
];

// The shell harnesses are discovered rather than listed. Two reasons, and the second is the one that
// matters: a harness added later is picked up automatically instead of joining the set of suites nobody
// calls, which is the defect this runner exists to close. Each declares its own position in the
// rate-limit ordering with a `deployment-gate-order` comment; one that declares none lands after the
// black-box scan and before the budget-exhausting one.
const SECURITY_HARNESS_DIRECTORY = new URL('../security/', import.meta.url);
const ORDER_HINT = /#\s*deployment-gate-order:\s*(\d+)/u;

async function discoverShellHarnesses() {
  let entries;
  try {
    entries = await readdir(SECURITY_HARNESS_DIRECTORY);
  } catch {
    return [];
  }
  const harnesses = [];
  for (const entry of entries.filter((name) => name.endsWith('.sh')).sort()) {
    const url = new URL(entry, SECURITY_HARNESS_DIRECTORY);
    const hint = ORDER_HINT.exec(await readFile(url, 'utf8'));
    harnesses.push({
      id: entry.replace(/\.sh$/u, ''),
      order: hint ? Number(hint[1]) : SHELL_HARNESS_DEFAULT_ORDER,
      kind: 'shell',
      target: fileURLToPath(url),
      timeoutMs: SHELL_HARNESS_TIMEOUT_MS,
      why: 'security harness run against the live deployment host',
      prerequisites: [posixShellHost, envFileExists(ACCESS_ENV_VARIABLE)],
    });
  }
  return harnesses;
}

// Exported so `full-gate.mjs` can state how many deployment stages exist without duplicating the list —
// a hardcoded count there would drift the first time one is added, and a local gate that understates
// what it did not run is the misreading this notice exists to prevent.
export async function deploymentStages() {
  const stages = [...declaredStages, ...(await discoverShellHarnesses())];
  return stages.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

// ---- verdict --------------------------------------------------------------------------------------
// Pure, so it can be tested without a deployment. See the header for why INCOMPLETE is non-zero.

export function verdict(results) {
  const executed = results.filter((result) => ['PASS', 'FAIL', 'TIMEOUT'].includes(result.status));
  const passed = results.filter((result) => result.status === 'PASS');
  const failed = results.filter((result) => ['FAIL', 'TIMEOUT'].includes(result.status));
  const unmet = results.filter((result) => result.status === 'PREREQUISITES_MISSING');
  const notReached = results.filter((result) => result.status === 'NOT_REACHED');
  const counts = `stages=${results.length} executed=${executed.length} passed=${passed.length} failed=${failed.length} unmet=${unmet.length} not_reached=${notReached.length}`;

  if (results.length === 0) {
    return { status: 'FAIL', exitCode: 1, line: `DEPLOYMENT_GATE_FAIL ${counts} reason=no-stages-declared` };
  }
  if (failed.length > 0) {
    return {
      status: 'FAIL',
      exitCode: 1,
      line: `DEPLOYMENT_GATE_FAIL ${counts} first_failure=${failed[0].id} failed_stages=${failed.map((result) => result.id).join(',')}`,
    };
  }
  if (executed.length === 0) {
    return {
      status: 'FAIL',
      exitCode: 1,
      line: `DEPLOYMENT_GATE_FAIL ${counts} reason=no-stage-could-run unmet_stages=${unmet.map((result) => result.id).join(',') || 'none'}`,
    };
  }
  if (unmet.length > 0 || notReached.length > 0) {
    return {
      status: 'INCOMPLETE',
      exitCode: 1,
      line: `DEPLOYMENT_GATE_INCOMPLETE ${counts} unmet_stages=${[...unmet, ...notReached].map((result) => result.id).join(',')}`,
    };
  }
  return { status: 'PASS', exitCode: 0, line: `DEPLOYMENT_GATE_PASS ${counts}` };
}

// Every branch of the arithmetic above, asserted before any stage runs. The public-export validator carries
// the same construction for the same reason: a gate whose own decision procedure is unverified is one more
// gate nobody checked. Named by role rather than by file, because that validator is itself withheld from the
// export and this comment ships in it.
export function runSelfTest() {
  const stage = (id, status) => ({ id, status });
  const cases = [
    {
      label: 'every stage ran and passed',
      results: [stage('a', 'PASS'), stage('b', 'PASS')],
      expectStatus: 'PASS',
      expectExit: 0,
    },
    {
      label: 'one stage failed',
      results: [stage('a', 'PASS'), stage('b', 'FAIL'), stage('c', 'NOT_REACHED')],
      expectStatus: 'FAIL',
      expectExit: 1,
      expectLine: /first_failure=b/u,
    },
    {
      label: 'a timeout counts as a failure',
      results: [stage('a', 'TIMEOUT')],
      expectStatus: 'FAIL',
      expectExit: 1,
      expectLine: /first_failure=a/u,
    },
    {
      label: 'nothing could run',
      results: [stage('a', 'PREREQUISITES_MISSING'), stage('b', 'PREREQUISITES_MISSING')],
      expectStatus: 'FAIL',
      expectExit: 1,
      expectLine: /reason=no-stage-could-run/u,
    },
    {
      label: 'some ran and passed, others could not run',
      results: [stage('a', 'PASS'), stage('b', 'PREREQUISITES_MISSING')],
      expectStatus: 'INCOMPLETE',
      expectExit: 1,
      expectLine: /unmet_stages=b/u,
    },
    { label: 'no stages at all', results: [], expectStatus: 'FAIL', expectExit: 1, expectLine: /no-stages-declared/u },
  ];
  for (const testCase of cases) {
    const outcome = verdict(testCase.results);
    assert.equal(outcome.status, testCase.expectStatus, `self-test "${testCase.label}": status`);
    assert.equal(outcome.exitCode, testCase.expectExit, `self-test "${testCase.label}": exit code`);
    if (testCase.expectLine) assert.match(outcome.line, testCase.expectLine, `self-test "${testCase.label}": verdict line`);
    // The one property every case shares: only a PASS may print a PASS-shaped line.
    assert.equal(outcome.line.startsWith('DEPLOYMENT_GATE_PASS'), outcome.status === 'PASS', `self-test "${testCase.label}": PASS line`);
  }
  return cases.length;
}

// ---- execution ------------------------------------------------------------------------------------
// Budgets, heartbeat and tree-killing follow `full-gate.mjs`: a stage that produces no output for
// minutes is indistinguishable from a hang without them, and killing the wrapper leaves the real work
// running.

const HEARTBEAT_MS = 60_000;

function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function runStage(stage, npmCli) {
  return new Promise((resolveStage) => {
    const startedAt = Date.now();
    const [executable, args] = stage.kind === 'shell'
      ? ['/bin/bash', [stage.target]]
      : [process.execPath, [npmCli, 'run', stage.target]];
    console.log(`\nDEPLOYMENT_STAGE_START ${stage.id} timeout=${Math.round(stage.timeoutMs / 1000)}s at=${new Date().toISOString()}`);
    const child = spawn(executable, args, {
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    });
    console.log(`DEPLOYMENT_STAGE_PID ${stage.id} pid=${child.pid}`);

    const heartbeat = setInterval(() => {
      console.log(`DEPLOYMENT_STAGE_RUNNING ${stage.id} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s pid=${child.pid}`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`DEPLOYMENT_STAGE_TIMEOUT ${stage.id} after=${Math.round(stage.timeoutMs / 1000)}s pid=${child.pid} — terminating process tree`);
      killTree(child);
    }, stage.timeoutMs);

    const finish = (exitCode, spawnError) => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
      const status = timedOut ? 'TIMEOUT' : exitCode === 0 ? 'PASS' : 'FAIL';
      console.log(`DEPLOYMENT_STAGE_END ${stage.id} status=${status} exit=${exitCode} duration=${durationSeconds}s`);
      resolveStage({ id: stage.id, kind: stage.kind, status, exitCode, durationSeconds, spawnError: spawnError || null, unmet: [] });
    };

    // A stage that could not be spawned at all has not passed, and neither has one killed by a signal.
    child.on('error', (error) => finish(null, error.code || error.message));
    child.on('close', (code, signal) => finish(signal ? null : code, signal ? `signal:${signal}` : null));
  });
}

async function main() {
  const selfTestOnly = process.argv.includes('--self-test');
  const cases = runSelfTest();
  console.log(`DEPLOYMENT_GATE_SELF_TEST_PASS cases=${cases}`);
  if (selfTestOnly) return;

  const stages = await deploymentStages();
  // A runner with nothing to run is the empty-input shape of the same lie a skipped stage tells.
  assert.ok(stages.length > 0, 'DEPLOYMENT_GATE declared no stages — there is nothing for this runner to check');

  const npmCli = process.env.npm_execpath;
  if (!npmCli && stages.some((stage) => stage.kind === 'npm')) {
    throw new Error('npm_execpath is required to run the npm stages without a shell — invoke this through `npm run deployment-gate`.');
  }

  const directory = resolve('artifacts', 'gates');
  await mkdir(directory, { recursive: true });
  const reportPath = resolve(directory, 'deployment-gate-report.json');
  // Removed before the first stage, not overwritten after the last. `artifacts/` is not tracked, so a
  // report from a previous run survives indefinitely; if this run dies before writing its own, whatever
  // is left carries an older timestamp and reads as the current result.
  await rm(reportPath, { force: true });

  const report = { startedAt: new Date().toISOString(), stages: [] };
  let stopped = false;
  for (const stage of stages) {
    if (stopped) {
      console.log(`DEPLOYMENT_STAGE_SKIP ${stage.id} status=NOT_REACHED — an earlier stage failed`);
      report.stages.push({ id: stage.id, kind: stage.kind, status: 'NOT_REACHED', exitCode: null, durationSeconds: 0, spawnError: null, unmet: [] });
      continue;
    }

    const checks = await Promise.all(stage.prerequisites.map((check) => check()));
    const unmet = checks.filter((check) => !check.met);
    if (unmet.length > 0) {
      // Named, printed and carried into the verdict line. Not a pass, not silence.
      console.log(`\nDEPLOYMENT_STAGE_PREREQUISITES_MISSING ${stage.id} — not run: ${unmet.map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`).join('; ')}`);
      report.stages.push({
        id: stage.id,
        kind: stage.kind,
        status: 'PREREQUISITES_MISSING',
        exitCode: null,
        durationSeconds: 0,
        spawnError: null,
        unmet: unmet.map((check) => ({ name: check.name, detail: check.detail })),
      });
      continue;
    }

    const result = await runStage(stage, npmCli);
    report.stages.push(result);
    // Breaks on the first real failure, as the local gate does. An unmet prerequisite does not break the
    // run: it is a fact about this host, not a fault in the deployment, and the stages after it can
    // still be checked.
    if (result.status !== 'PASS') stopped = true;
  }

  const outcome = verdict(report.stages);
  report.finishedAt = new Date().toISOString();
  report.status = outcome.status;
  report.verdict = outcome.line;
  report.totalSeconds = Number(((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000).toFixed(3));

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\nDEPLOYMENT_GATE_SUMMARY');
  for (const entry of report.stages) {
    const reason = entry.unmet.length > 0 ? `  ${entry.unmet.map((check) => check.name).join('; ')}` : '';
    console.log(`  ${entry.status.padEnd(22)} ${entry.id.padEnd(28)} ${entry.durationSeconds}s${reason}`);
  }
  console.log(`${outcome.line} total=${report.totalSeconds}s report=${reportPath}`);
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  // A crash must never be silent and must never be mistaken for a clean run — the same reason every one
  // of the suites below names its own crash rather than unwinding into a bare stack.
  const crash = (error) => {
    console.error(`DEPLOYMENT_GATE_CRASH ${error?.stack || error}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  await main();
}
