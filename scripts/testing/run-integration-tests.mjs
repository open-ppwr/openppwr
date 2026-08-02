// Runs a workspace's integration files against one shared PostgreSQL cluster.
//
//   node ../../scripts/testing/run-integration-tests.mjs <label> <test path or pattern>...
//
// Why this exists rather than `node --test` directly: see the header of embedded-postgres.mjs. In short,
// every file used to start a cluster of its own, and the twentieth `initdb` on a loaded host crossed the
// 30-second bound that guards it — a green suite turning red with nothing wrong in the code under test.
// This process starts the cluster once, publishes its address to the child through the environment, and
// each file creates its own database inside it.
//
// This process owns the cluster and nothing else owns it, so:
//
//   - the child is spawned with stdio inherited, so `node --test`'s own reporter output, including the
//     per-file summary a reader compares between runs, is untouched by this wrapper;
//   - the cluster is stopped in a `finally`, so a child that fails, throws or is killed still releases it;
//   - SIGINT and SIGTERM are handled, because a developer pressing Ctrl+C is the ordinary way this run
//     ends early and an orphaned cluster is what that used to leave behind;
//   - the child's exit code is this process's exit code, unmodified. A wrapper that swallows a failure is
//     worse than no wrapper.
import { spawn } from 'node:child_process';
import { startTestCluster, SHARED_CLUSTER_VARIABLE } from './embedded-postgres.mjs';

const [label, ...targets] = process.argv.slice(2);
if (!label || targets.length === 0) {
  console.error('usage: run-integration-tests.mjs <label> <test path or pattern>...');
  process.exit(2);
}

const cluster = await startTestCluster(label);
console.error(`TEST_CLUSTER_SHARED label=${label} port=${cluster.port} files=${targets.join(' ')}`);

let child;
let stopping = false;

async function releaseCluster() {
  if (stopping) return;
  stopping = true;
  await cluster.stop();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child?.kill(signal);
    // Not awaited: a signal handler cannot hold the process open indefinitely, and stop() is itself
    // bounded at every step. Exiting non-zero is correct — the run did not finish.
    releaseCluster().finally(() => process.exit(130));
  });
}

let code = 1;
try {
  code = await new Promise((settle, fail) => {
    child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...targets], {
      stdio: 'inherit',
      env: { ...process.env, [SHARED_CLUSTER_VARIABLE]: cluster.url },
    });
    child.on('error', fail);
    // A child killed by a signal reports a null exit code; that is a failure, not a success.
    child.on('close', (exitCode, signal) => settle(signal ? 1 : exitCode ?? 1));
  });
} finally {
  await releaseCluster();
}

process.exit(code);
