// SPDX-License-Identifier: Apache-2.0
// Whether the gate that just finished left anything running.
//
// The integration suites start a real PostgreSQL through `embedded-postgres`. When a suite exits without
// stopping it — a failed assertion mid-run, a timeout, an interrupted process — the cluster's child
// processes are reparented and keep running. Nothing noticed, because a test runner's exit code describes
// its assertions and not its housekeeping.
//
// Measured on this workstation after a day of gate runs: six orphaned `postgres.exe` processes, every one
// with a dead parent, the oldest eight hours old, accumulated across runs that had all reported PASS. That
// is the shape of the problem — not one leak, but a slow accumulation underneath a green verdict, on the
// exact machine whose green verdict is supposed to be release evidence.
//
// So the verdict and the housekeeping are reported separately. A release gate that passed its assertions
// and leaked a database is not the same thing as one that passed and cleaned up, and collapsing the two
// into a single word is how the difference stops being visible.
//
//   node scripts/validation/orphan-check.mjs            reports; exit 1 if anything was left behind
//   node scripts/validation/orphan-check.mjs --reap     also stops what it finds, then re-checks
//
// Scoped to this checkout. A developer's own PostgreSQL, or another checkout's gate running in parallel,
// is not this run's litter and must not be killed by it — so a process is only considered when its command
// line names this repository's own `node_modules`.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// The binaries a suite in this repository can leave running. `postgres` is the one measured; the others are
// listed because the same reparenting applies to anything a suite spawns and does not wait for.
const WATCHED = ['postgres', 'clamd', 'freshclam'];

function windowsProcesses() {
  // CIM rather than `tasklist`: the command line is what scopes a process to this checkout, and `tasklist`
  // does not report it. `-NoProfile` so a developer's profile cannot change the output shape.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ($_.CommandLine -replace '\\|', ' ') }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [pid, parent, name, ...rest] = line.split('|');
    return { pid: Number(pid), parent: Number(parent), name, command: rest.join('|') };
  });
}

function posixProcesses() {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) return null;
    return { pid: Number(match[1]), parent: Number(match[2]), name: match[3], command: match[4] };
  }).filter(Boolean);
}

export function listProcesses() {
  return process.platform === 'win32' ? windowsProcesses() : posixProcesses();
}

// The classification, exported and pure.
//
// Deliberately separated from the process listing, because the condition it decides — a watched binary,
// belonging to this checkout, whose parent is gone — cannot be provoked on demand: killing a test runner
// takes its database down with it, which is the tidy case rather than the leaking one. The leak happens
// on paths that are hard to reproduce and easy to get wrong, so the logic is tested against constructed
// process tables instead of against a race nobody can stage reliably.
//
// `root` is normalised because a command line may spell a checkout with either separator, and on Windows
// the drive letter's case is not stable between the tools that report it.
export function findOrphans(processes, root, watched = WATCHED) {
  const here = String(root).replaceAll('\\', '/').toLowerCase();
  const alive = new Set(processes.map((entry) => entry.pid));
  const mine = processes.filter((entry) => {
    const command = (entry.command || '').replaceAll('\\', '/').toLowerCase();
    if (!command.includes(here)) return false;
    const name = (entry.name || '').replace(/\.exe$/iu, '').toLowerCase();
    return watched.includes(name);
  });
  // A live parent means something is still supervising it — a gate still running, or a developer's own
  // session. Only the reparented ones are this run's litter.
  return { matched: mine, orphans: mine.filter((entry) => !alive.has(entry.parent)) };
}

const belongsToThisCheckout = (entry) => findOrphans([entry], ROOT).matched.length === 1;

function main() {
  const reap = process.argv.includes('--reap');
  let processes;
  try {
    processes = listProcesses();
  } catch (error) {
    // Reporting "cannot tell" rather than "clean" is the whole point: an unknown cleanup is not a passing
    // cleanup, and a gate that cannot inspect its own machine should say so.
    console.error(`ORPHAN_CHECK_UNKNOWN reason=process_listing_failed detail=${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { matched: mine, orphans } = findOrphans(processes, ROOT);

  if (!orphans.length) {
    console.log(`ORPHAN_CHECK_PASS watched=${WATCHED.join(',')} matched=${mine.length} orphaned=0 checkout=${ROOT}`);
    return;
  }

  console.error('ORPHAN_CHECK_FAIL');
  for (const entry of orphans) console.error(`  pid=${entry.pid} parent=${entry.parent} (gone) ${entry.name}`);

  if (!reap) {
    console.error(`${orphans.length} process(es) from this checkout outlived the run that started them. Re-run with --reap to stop them.`);
    process.exitCode = 1;
    return;
  }

  for (const entry of orphans) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`  could not stop pid=${entry.pid}: ${error.message}`);
    }
  }

  // Re-listed rather than assumed: `kill` returning without error means the signal was delivered, not that
  // the process is gone, and reporting a successful clean-up that did not happen is the failure this file
  // exists to prevent.
  const remaining = listProcesses().filter(belongsToThisCheckout).filter((entry) => orphans.some((orphan) => orphan.pid === entry.pid));
  if (remaining.length) {
    console.error(`ORPHAN_CHECK_FAIL reaped=${orphans.length - remaining.length} remaining=${remaining.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ORPHAN_CHECK_REAPED count=${orphans.length} remaining=0`);
}

// Only when run as a command. `findOrphans` and `listProcesses` are imported by the test that proves this
// classification and by the database harness that reaps after itself, and an import that also *acts* --
// setting an exit code from the importer's machine state -- made the test file inherit a verdict about
// this workstation rather than about the code. It failed for a reason that had nothing to do with it.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
