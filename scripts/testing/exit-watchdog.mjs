// Why is this process still alive?
//
// Four times now this repository has produced a hang whose signature is identical in the log to a slow
// stage: every test prints as passing, every bounded teardown step reports completion, and the process
// simply never exits. "The work is not finishing" and "the work finished and the process will not exit"
// have completely different fixes, and the log alone cannot tell them apart.
//
// This module is a diagnostic preload. Enable it with:
//
//   NODE_OPTIONS=--import=file:///.../scripts/testing/exit-watchdog.mjs
//   OPENPPWR_EXIT_WATCHDOG_MS=15000
//
// It reaches `node --test` worker processes too, because they inherit NODE_OPTIONS.
//
// The interval is unref'd, so the watchdog can never be the reason a process stays alive: if the only
// remaining handles are unref'd, Node exits and the watchdog never fires again. Anything it does print,
// therefore, is something genuinely holding the event loop open.
//
// It is a reporter, not a killer. Set OPENPPWR_EXIT_WATCHDOG_KILL_MS to also abort the process after a
// deadline, which is useful when driving it from a script that must not block.

const periodMs = Number(process.env.OPENPPWR_EXIT_WATCHDOG_MS || 0);
if (Number.isFinite(periodMs) && periodMs > 0) {
  const startedAt = Date.now();
  const killMs = Number(process.env.OPENPPWR_EXIT_WATCHDOG_KILL_MS || 0);

  const describe = (handle) => {
    const name = handle?.constructor?.name ?? Object.prototype.toString.call(handle);
    try {
      if (name === 'Socket' || name === 'TLSSocket') {
        const remote = handle.remoteAddress ? `${handle.remoteAddress}:${handle.remotePort}` : 'unconnected';
        const fd = handle._handle?.fd;
        return `${name}(remote=${remote} local=${handle.localPort ?? '-'} fd=${fd ?? '-'} destroyed=${handle.destroyed} reading=${Boolean(handle.readable)})`;
      }
      if (name === 'Server') return `${name}(listening=${handle.listening} address=${JSON.stringify(handle.address?.() ?? null)})`;
      if (name === 'ChildProcess') return `${name}(pid=${handle.pid} file=${handle.spawnfile} killed=${handle.killed} exitCode=${handle.exitCode})`;
      if (name === 'WriteStream' || name === 'ReadStream') return `${name}(fd=${handle.fd})`;
      if (name === 'Timeout') return `${name}(ms=${handle._idleTimeout} repeat=${Boolean(handle._repeat)})`;
      if (name === 'Pipe') return `${name}(fd=${handle.fd})`;
    } catch { /* a handle that throws while being described is still worth naming */ }
    return name;
  };

  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const resources = process.getActiveResourcesInfo?.() ?? [];
    const tally = new Map();
    for (const entry of resources) tally.set(entry, (tally.get(entry) ?? 0) + 1);
    const summary = [...tally.entries()].map(([entry, count]) => `${entry}x${count}`).join(',');
    console.error(`EXIT_WATCHDOG pid=${process.pid} elapsed=${elapsed}s resources=[${summary}]`);
    // eslint-disable-next-line no-underscore-dangle
    const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
    for (const handle of handles) console.error(`  EXIT_WATCHDOG_HANDLE pid=${process.pid} ${describe(handle)}`);
    // eslint-disable-next-line no-underscore-dangle
    const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
    for (const request of requests) console.error(`  EXIT_WATCHDOG_REQUEST pid=${process.pid} ${request?.constructor?.name ?? 'unknown'}`);

    if (killMs > 0 && Date.now() - startedAt > killMs) {
      console.error(`EXIT_WATCHDOG_ABORT pid=${process.pid} after=${Math.round(killMs / 1000)}s — process would not exit on its own`);
      process.exit(70);
    }
  }, periodMs);
  timer.unref?.();
}
