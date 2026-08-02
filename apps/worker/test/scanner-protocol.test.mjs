// The ClamAV wire protocol, against a real socket.
//
// `apps/worker/test/health.test.mjs` proves what the health model does with a probe *result*: it injects
// `{ ok: true }` or `{ ok: false }` and asserts the state machine. That is the right test for the state
// machine and it is why the defect survived — it never called `ClamAvScanner.ping()`, so the parsing of the
// reply was untested, and the first implementation accepted `PONG\0` followed by arbitrary bytes as a
// healthy scanner — which a loopback socket answering those bytes is enough to demonstrate.
//
// So this file speaks the protocol. A fake scanner returns exact bytes, including the malformed shapes, and
// the assertions are about what the adapter concludes from them. `scan()` is covered here too, because the
// probe's leniency was a divergence *from* `scan()` — the two parse the same protocol and must be equally
// strict about it.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { ClamAvScanner } from '../src/index.mjs';

const servers = [];

// A scanner that replies with exactly the bytes it is given, then closes — which is what clamd does after a
// `z`-prefixed command, and what these fakes did not do at first. The adapter now judges the completed
// response rather than the chunk in hand, so a fake that never closes is a fake of a scanner that does not
// exist, and it made three tests pass against a parser that accepted delayed trailing bytes.
async function fakeScanner(reply, { closeWithoutReply = false, delayMs = 0 } = {}) {
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      const isPing = request.includes(Buffer.from('zPING'));
      // INSTREAM ends with a zero-length chunk header; PING is complete as soon as it arrives.
      const complete = isPing || (request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4)));
      if (!complete) return;
      if (closeWithoutReply) {
        socket.end();
        return;
      }
      const bytes = typeof reply === 'function' ? reply(request) : reply;
      const send = () => { socket.end(bytes); };
      if (delayMs) setTimeout(send, delayMs).unref?.();
      else send();
    });
    socket.on('error', () => {});
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  servers.push(server);
  return { host: '127.0.0.1', port: server.address().port };
}

after(async () => {
  for (const server of servers) await new Promise((closed) => server.close(closed));
});

const scannerFor = async (reply, options, overrides = {}) => {
  const address = await fakeScanner(reply, options);
  return new ClamAvScanner({ ...address, timeoutMs: 500, ...overrides });
};

// --- ping ------------------------------------------------------------------------------------------

test('ping accepts exactly PONG with its terminator', async () => {
  const scanner = await scannerFor(Buffer.from('PONG\0', 'ascii'));
  assert.equal(await scanner.ping(), true);
});

// The defect. Before the fix this returned true, and a true here clears an infrastructure fault and reports
// a dead scanner as recovered.
test('ping refuses PONG followed by trailing bytes', async () => {
  for (const trailing of ['junk', '\0', 'PONG\0', ' ', '\n', 'X'.repeat(100)]) {
    const scanner = await scannerFor(Buffer.from(`PONG\0${trailing}`, 'ascii'));
    assert.equal(await scanner.ping(), false, `PONG\\0${JSON.stringify(trailing)} must not report a healthy scanner`);
  }
});

test('ping refuses a reply that is not PONG', async () => {
  for (const reply of ['PANG\0', 'pong\0', 'PONG', 'ERROR\0', '\0', '', 'PON\0G', 'PONGG', 'OK\0']) {
    const scanner = await scannerFor(Buffer.from(reply, 'ascii'));
    assert.equal(await scanner.ping(), false, `${JSON.stringify(reply)} must not report a healthy scanner`);
  }
});

test('ping refuses a reply that never arrives, and does so within its timeout', async () => {
  const scanner = await scannerFor(Buffer.from('PONG\0'), { delayMs: 5000 });
  const started = Date.now();
  assert.equal(await scanner.ping(), false);
  assert.ok(Date.now() - started < 3000, 'the probe must fail on its own timeout rather than waiting for the reply');
});

test('ping refuses a connection closed without a reply', async () => {
  const scanner = await scannerFor(null, { closeWithoutReply: true });
  assert.equal(await scanner.ping(), false);
});

test('ping refuses an unreachable scanner rather than throwing', async () => {
  // Port 1 on loopback: nothing listens, so the connection is refused immediately.
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
  assert.equal(await scanner.ping(), false, 'a failed probe is an answer, not an exception');
});

// A slow but complete reply must still be accepted, or a loaded scanner would be declared dead.
test('ping accepts a reply that arrives in pieces', async () => {
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write(Buffer.from('PO', 'ascii'));
      // `end` rather than `write`: clamd closes after answering a `z`-prefixed command, and the adapter now
      // judges the completed response rather than the chunk in hand. A fake that never closes is
      // a fake of a scanner that does not exist.
      setTimeout(() => socket.end(Buffer.from('NG\0', 'ascii')), 20).unref?.();
    });
    socket.on('error', () => {});
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  servers.push(server);
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: server.address().port, timeoutMs: 1000 });
  assert.equal(await scanner.ping(), true, 'a split reply is not a malformed one');
});

// --- scan ------------------------------------------------------------------------------------------
//
// The reason the probe's leniency was a defect rather than a style difference: `scan()` is strict, and the
// two parse the same protocol. These assertions pin that strictness so the divergence cannot reappear from
// the other side.

test('scan accepts only the exact clean and infected verdicts', async () => {
  const clean = await scannerFor(Buffer.from('stream: OK\0', 'ascii'));
  assert.deepEqual(await clean.scan(Buffer.from('x')), { status: 'clean', engine: 'clamav' });
  const infected = await scannerFor(Buffer.from('stream: Eicar-Signature FOUND\0', 'ascii'));
  assert.deepEqual(await infected.scan(Buffer.from('x')), { status: 'infected', engine: 'clamav' });
});

// `stream: NOT OK` is the shape that matters: a substring test for "OK" calls it clean. The production
// adapter must not, and this asserts it directly.
test('scan refuses an ambiguous verdict rather than reading OK out of it', async () => {
  for (const reply of ['stream: NOT OK\0', 'stream: OK\0trailing', 'OK\0', 'stream: FOUND\0', 'garbage\0']) {
    const scanner = await scannerFor(Buffer.from(reply, 'ascii'));
    await assert.rejects(
      () => scanner.scan(Buffer.from('x')),
      (error) => {
        assert.match(error.code, /^MALWARE_SCANNER_MALFORMED_RESPONSE$/u, `${JSON.stringify(reply)} produced ${error.code}`);
        return true;
      },
      `${JSON.stringify(reply)} must not produce a verdict`,
    );
  }
});

// An unterminated reply is not a malformed one yet — the rest may still be coming. It resolves as a timeout,
// or as malformed if the socket closes first, and both are refusals. This case was originally written into
// the malformed list above and failed with `MALWARE_SCAN_TIMEOUT`; the adapter was right and the assertion
// was wrong, so it moved here rather than the code changing to satisfy it.
test('scan treats an unterminated reply as a refusal, by timeout or by close', async () => {
  const hanging = await scannerFor(Buffer.from('stream: OK', 'ascii'));
  await assert.rejects(
    () => hanging.scan(Buffer.from('x')),
    (error) => {
      assert.ok(['MALWARE_SCAN_TIMEOUT', 'MALWARE_SCANNER_MALFORMED_RESPONSE'].includes(error.code), `unexpected code ${error.code}`);
      return true;
    },
  );
});

test('scan fails closed on an unreachable scanner, a silent one and a timeout', async () => {
  const unreachable = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
  await assert.rejects(() => unreachable.scan(Buffer.from('x')), (error) => error.code === 'MALWARE_SCANNER_UNAVAILABLE');

  const silent = await scannerFor(null, { closeWithoutReply: true });
  await assert.rejects(() => silent.scan(Buffer.from('x')), (error) => error.code === 'MALWARE_SCANNER_MALFORMED_RESPONSE');

  const slow = await scannerFor(Buffer.from('stream: OK\0'), { delayMs: 5000 });
  await assert.rejects(() => slow.scan(Buffer.from('x')), (error) => error.code === 'MALWARE_SCAN_TIMEOUT');
});

test('scan refuses an oversized response instead of buffering it', async () => {
  const scanner = await scannerFor(Buffer.concat([Buffer.from('stream: '), Buffer.alloc(8192, 0x41), Buffer.from('\0')]));
  await assert.rejects(() => scanner.scan(Buffer.from('x')), (error) => error.code === 'MALWARE_SCANNER_MALFORMED_RESPONSE');
});

test('scan refuses content above the configured maximum before opening a socket', async () => {
  const scanner = await scannerFor(Buffer.from('stream: OK\0'), {}, { maxBytes: 16 });
  await assert.rejects(
    () => scanner.scan(Buffer.alloc(17)),
    (error) => error.code === 'MALWARE_SCAN_SIZE_EXCEEDED',
  );
});

// --- timing, not content -----------------------------------------------------------------------------
//
// Both parsers were fixed once for content and were still wrong, because both judged whichever
// bytes had arrived rather than the finished response. A scanner that writes a complete, valid reply and
// then writes junk 50 ms later was accepted: the first chunk ended with the terminator, so the adapter
// resolved before the rest arrived.
//
// Two rounds of "fixed", both with passing tests beside them, because every test constructed the *content*
// of a reply and none constructed its *timing*. These do. A stream protocol cannot be judged by a test that
// cannot delay a byte.

// Writes `first`, waits, writes `second`, then closes. The delay is what the earlier tests could not express.
async function trailingScanner(first, second, { delayMs = 50 } = {}) {
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      const isPing = request.includes(Buffer.from('zPING'));
      const complete = isPing || (request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4)));
      if (!complete) return;
      socket.write(first);
      setTimeout(() => { socket.write(second); socket.end(); }, delayMs).unref?.();
    });
    socket.on('error', () => {});
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  servers.push(server);
  return new ClamAvScanner({ host: '127.0.0.1', port: server.address().port, timeoutMs: 2000 });
}

test('ping refuses a valid reply followed later by trailing bytes', async () => {
  const scanner = await trailingScanner(Buffer.from('PONG\0', 'ascii'), Buffer.from('junk', 'ascii'));
  assert.equal(await scanner.ping(), false, 'the reply is judged when the connection completes, not when a chunk lands');
});

test('scan refuses a verdict followed later by trailing bytes', async () => {
  const scanner = await trailingScanner(Buffer.from('stream: OK\0', 'ascii'), Buffer.from('stream: Eicar FOUND\0', 'ascii'));
  await assert.rejects(
    () => scanner.scan(Buffer.from('x')),
    (error) => {
      assert.equal(error.code, 'MALWARE_SCANNER_MALFORMED_RESPONSE');
      return true;
    },
    'a clean verdict followed by anything at all must not be accepted',
  );
});

// The direction that matters most: a delayed *infected* verdict must never be read as clean because a clean
// prefix arrived first.
test('scan does not report clean when an infected verdict follows in a later chunk', async () => {
  const scanner = await trailingScanner(Buffer.from('stream: OK\0', 'ascii'), Buffer.from('\0', 'ascii'));
  await assert.rejects(() => scanner.scan(Buffer.from('x')), (error) => error.code === 'MALWARE_SCANNER_MALFORMED_RESPONSE');
});

// And the legitimate case still works: a complete reply followed by nothing but the close.
test('ping and scan accept a complete reply that is followed only by the connection closing', async () => {
  const pinged = await trailingScanner(Buffer.from('PONG\0', 'ascii'), Buffer.alloc(0));
  assert.equal(await pinged.ping(), true);
  const scanned = await trailingScanner(Buffer.from('stream: OK\0', 'ascii'), Buffer.alloc(0));
  assert.deepEqual(await scanned.scan(Buffer.from('x')), { status: 'clean', engine: 'clamav' });
});
