// Bounding a wait is not the same as releasing the resource.
//
// Wrapping an await in `Promise.race` makes the *caller* stop waiting. It does not cancel the operation
// and it does not close the handle, so a `pool.end()` that times out leaves its sockets open and still
// ref'd in libuv — and the process still cannot exit. The log then shows a teardown warning followed by
// silence, which reads exactly like the unbounded hang the bound was added to prevent. Several teardown
// paths in this repository were bounded that way and still stalled, which is why both halves live here.
//
// Measured on this host, Node 24.16.0:
//
//   pg Pool.end() with one client checked out and never released does not settle. With nothing else
//   holding the loop open Node exits 13 ("unsettled top-level await"); with a socket or a server still
//   alive — the normal case in these scripts — it hangs with no output at all.
//
// So each helper here does both halves: bound the wait, then destroy what the wait gave up on.

const DEFAULT_MS = 10_000;

// Bounds one teardown step. Returns true when it completed, false when it timed out or threw.
// Never rethrows: a teardown that fails must not mask the result the run already produced.
export async function boundedStep(label, operation, ms = DEFAULT_MS) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_ignored, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
    return true;
  } catch (error) {
    // embedded-postgres and some pg paths reject with a bare value rather than an Error; reading
    // `.message` on that throws from inside this catch and skips the caller's cleanup entirely.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`TEARDOWN_WARNING step=${label} reason=${reason}`);
    return false;
  } finally { clearTimeout(timer); }
}

// Last resort after a pool refused to end politely.
//
// `pool.end()` waits for every checked-out client to be returned, with no deadline of its own. When it
// does not settle, the clients are still holding open TCP sockets. Destroying them is what actually
// lets the process exit; without this the bound above only changes a silent hang into a warning
// followed by a silent hang.
function destroyPoolSockets(pool, label) {
  const clients = Array.isArray(pool?._clients) ? [...pool._clients] : [];
  let destroyed = 0;
  for (const client of clients) {
    try {
      // A *checked-out* client is not covered by the Pool's own error handling — the Pool only listens
      // on idle clients. Destroying its socket makes pg emit "Connection terminated unexpectedly" as an
      // unhandled 'error' event on the Client, which takes the whole process down. Measured here: without
      // this listener the proof run died with `throw er; // Unhandled 'error' event` instead of exiting.
      // Trading a hang for a crash is not a fix, so absorb it: this client is being discarded anyway.
      client?.on?.('error', () => {});
      const stream = client?.connection?.stream;
      if (stream && !stream.destroyed) { stream.destroy(); destroyed += 1; }
    } catch { /* a client that throws while being destroyed is already unusable */ }
  }
  console.error(`TEARDOWN_FORCED step=${label} destroyedSockets=${destroyed} of=${clients.length}`);
}

// Ends a pg Pool with a deadline, and forcibly destroys its sockets if the deadline passes.
export async function endPool(pool, label = 'pool', ms = DEFAULT_MS) {
  if (!pool) return true;
  const ended = await boundedStep(label, () => pool.end(), ms);
  if (!ended) destroyPoolSockets(pool, label);
  return ended;
}

// Closes an http.Server with a deadline.
//
// `closeAllConnections()` first: `close()` alone stops the listener and waits for live connections, and
// a keep-alive socket held by undici (the global `fetch`) is a live connection. Node 24 does drop idle
// keep-alive sockets on close(), but a request still in flight is not idle, and relying on that
// distinction is how this repository got here.
export async function closeServer(server, label = 'server', ms = DEFAULT_MS) {
  if (!server) return true;
  return boundedStep(label, () => new Promise((closed) => {
    server.closeAllConnections?.();
    server.close(closed);
  }), ms);
}
