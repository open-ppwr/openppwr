// A minimal SMTP submission client, in tree, over `node:net` and `node:tls`.
//
// WHY THIS IS NOT A DEPENDENCY.
//
// The API image is `distroless/static-debian13` carrying a musl-linked Node and no shell. Anything
// that compiles, anything with a postinstall step, and anything that shells out does not run there, so
// the candidate set was never "any SMTP library" — it was "a pure-JavaScript one". Within that set the
// argument is surface rather than capability: what is needed here is EHLO, one optional STARTTLS
// upgrade, AUTH PLAIN or LOGIN, one MAIL FROM, one or more RCPT TO, and one DATA. A general mail
// library brings attachment assembly, address parsing, template rendering, DKIM signing, OAuth2 token
// refresh, connection pooling and proxy support — none of it reachable from this call site, all of it
// resident in the process that serves requests, and all of it inside the trust boundary of a container
// deliberately built with nothing else in it. This repository also gates dependencies on licence,
// notices and a supply-chain check, which is a real cost to pay for code that would sit unused.
//
// Against that: writing a line protocol by hand is how mail clients acquire defects. So the protocol
// surface is kept small enough to read in one sitting, every stage is bounded by one deadline, and the
// three places where hand-written SMTP historically goes wrong are each asserted by a test — transparent
// dot-stuffing, CRLF line endings, and refusing to hand credentials to a connection that is not
// encrypted.
//
// What this client deliberately does NOT do: pipelining, CHUNKING/BDAT, attachments, multipart bodies,
// address parsing beyond validation, connection reuse, or retry. One message, one connection, one
// bounded attempt, then the socket is destroyed.

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

// A hostile or broken server can otherwise stream an unbounded greeting into memory. 64 KiB is far more
// than any real EHLO capability list, and reaching it ends the session rather than growing the buffer.
const MAX_REPLY_BYTES = 65536;

// Base64 payload lines. RFC 2045 puts the limit at 76 characters.
const BASE64_LINE = 76;

export class SmtpError extends Error {
  constructor(reason, replyCode = null) {
    super(reason);
    this.name = 'SmtpError';
    // A short, enumerated token. Never the server's text and never the host: a delivery-failure record
    // is written to the log, and the log is the thing most likely to be pasted into a ticket.
    this.reason = reason;
    this.replyCode = replyCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Message encoding.

// Transparency, RFC 5321 §4.5.2. A body line consisting of a single `.` is indistinguishable from the
// end-of-data terminator unless the client doubles it, and getting this wrong does not error — it
// truncates the message silently at that line, and every message short enough not to contain one keeps
// working. That is why it has its own test.
export function stuffDots(text) {
  return String(text)
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

// SMTP line endings are CRLF and only CRLF. A bare LF in a body is accepted by some servers, rewritten
// by others, and rejected by a few; normalising here means the wire form does not depend on which
// platform produced the string.
export function normalizeEol(text) {
  return String(text).replace(/\r\n|\r|\n/gu, CRLF);
}

export function base64Body(bytes) {
  const encoded = Buffer.from(bytes).toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += BASE64_LINE) lines.push(encoded.slice(index, index + BASE64_LINE));
  return lines.join(CRLF);
}

// A header value carrying CR or LF is header injection: it ends the header and begins whatever the
// injected text says, including a second recipient or a replacement body. Everything interpolated into a
// header here is either operator configuration or an event name from a call site in this repository, and
// both are checked rather than trusted.
function assertHeaderSafe(name, value) {
  if (/[\r\n\0]/u.test(String(value))) throw new SmtpError('header_injection');
  if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(String(name))) throw new SmtpError('header_injection');
}

// The same rule for an envelope address, which is interpolated into a command rather than a header. A
// space or an angle bracket in `MAIL FROM:<...>` is how a crafted address becomes a second command.
export function isEnvelopeAddress(value) {
  return typeof value === 'string' && /^[^\s<>,;:"'\\\r\n\0]+@[^\s<>,;:"'\\\r\n\0]+$/u.test(value);
}

export function buildMessage({ headers, body, encoding }) {
  for (const [name, value] of headers) assertHeaderSafe(name, value);
  const encoded = encoding === 'base64' ? base64Body(body) : normalizeEol(body);
  const head = headers.map(([name, value]) => `${name}: ${value}`).join(CRLF);
  // One blank line separates headers from body, then the body, then the terminator on a line of its
  // own. `stuffDots` runs over the body only: doubling a dot in a header would corrupt the header.
  return `${head}${CRLF}${CRLF}${stuffDots(encoded)}${CRLF}.${CRLF}`;
}

// ---------------------------------------------------------------------------------------------
// Reply parsing.
//
// A reply is one or more lines. Continuation lines carry `250-`; the final line carries `250 `. Anything
// else is malformed and ends the session rather than being guessed at.

const COMPLETE = /^(\d{3})(?:[ ]|$)/u;
const CONTINUES = /^\d{3}-/u;

function replyEnd(buffer) {
  let index = 0;
  for (;;) {
    const newline = buffer.indexOf(CRLF, index);
    if (newline < 0) return { end: -1 };
    const line = buffer.slice(index, newline);
    if (COMPLETE.test(line)) return { end: newline + CRLF.length };
    if (!CONTINUES.test(line)) return { end: -2 };
    index = newline + CRLF.length;
  }
}

function parseReply(raw) {
  const lines = raw.split(CRLF).filter((line) => line.length > 0);
  return { code: Number(lines[0].slice(0, 3)), lines: lines.map((line) => line.slice(4)) };
}

// One socket, one reader. A STARTTLS upgrade replaces the socket, so it replaces the reader too — which
// is what makes the residual-buffer check below meaningful.
function createChannel(socket) {
  let buffer = '';
  let pending = null;
  let failure = null;
  socket.setEncoding('utf8');

  const settle = () => {
    if (!pending) return;
    if (failure) {
      const waiter = pending;
      pending = null;
      waiter.reject(failure);
      return;
    }
    const { end } = replyEnd(buffer);
    if (end === -1) return;
    const waiter = pending;
    pending = null;
    if (end === -2) {
      failure = new SmtpError('malformed_reply');
      waiter.reject(failure);
      return;
    }
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end);
    waiter.resolve(parseReply(raw));
  };

  const fail = (reason) => {
    failure = failure ?? new SmtpError(reason);
    settle();
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_REPLY_BYTES) {
      buffer = '';
      fail('reply_too_large');
      return;
    }
    settle();
  });
  // The cause is never carried forward. A connect error message embeds the host and port, and this
  // reason ends up in a log record.
  socket.on('error', () => fail('socket_error'));
  socket.on('close', () => fail('connection_closed'));

  return {
    read() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        settle();
      });
    },
    write(text) {
      socket.write(text);
    },
    // What arrived but has not been consumed. After a `220` to STARTTLS this must be empty: anything
    // buffered was sent by the far end before the handshake, in the clear, and would then be executed as
    // though it had arrived inside the encrypted session. That is the STARTTLS command-injection defect,
    // and discarding the buffer silently is the wrong repair — a server that did it is not one to keep
    // talking to.
    residual() {
      return buffer;
    },
    detach() {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
    },
  };
}

function whenReady(socket, event) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new SmtpError('connect_failed'));
    socket.once(event, () => {
      socket.removeListener('error', onError);
      resolve();
    });
    socket.once('error', onError);
  });
}

// ---------------------------------------------------------------------------------------------
// The session.

function capabilities(reply) {
  // The first line of an EHLO reply is the greeting, not a capability.
  return new Set(reply.lines.slice(1).map((line) => line.trim().toUpperCase()));
}

function supportsAuth(caps, mechanism) {
  for (const line of caps) {
    if (line === 'AUTH' || line.startsWith('AUTH ')) {
      if (line.slice(4).split(/\s+/u).includes(mechanism)) return true;
    }
  }
  return false;
}

/**
 * Send one message over one connection, bounded end to end by `timeoutMs`.
 *
 * The deadline is a single timer covering connect, TLS handshake, greeting, every command and the DATA
 * transfer. That is the shape the failure mode requires: an SMTP server can stall at any one of those
 * stages, a per-stage bound leaves an attacker or an outage free to stall at each stage in turn for the
 * full allowance, and the OS-level TCP connect timeout is minutes. When the deadline fires the socket is
 * destroyed, so an unreachable mail host cannot accumulate sockets.
 */
export async function sendMail(options) {
  const {
    host,
    port,
    tls: mode,
    username = null,
    password = null,
    from,
    recipients,
    headers,
    body,
    encoding = '7bit',
    heloName = 'openppwr',
    timeoutMs,
    rejectUnauthorized = true,
  } = options;

  if (!isEnvelopeAddress(from)) throw new SmtpError('invalid_sender');
  if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.every(isEnvelopeAddress)) {
    throw new SmtpError('invalid_recipient');
  }
  // Credentials never travel over a connection that is not encrypted. This is also refused at
  // configuration time, where it produces a readable reason; the check is repeated here because this
  // module is callable on its own and the property belongs to it, not to its caller.
  if (username && mode === 'disabled') throw new SmtpError('credentials_without_tls');

  const message = buildMessage({ headers, body, encoding });

  // RFC 6066 forbids an IP literal as a server name, and Node warns about it. A deployment pointing at
  // a relay by address gets no SNI, which is correct rather than degraded.
  const servername = net.isIP(host) ? undefined : host;
  let socket = mode === 'implicit'
    ? tls.connect({ host, port, servername, rejectUnauthorized })
    : net.connect({ host, port });
  socket.setNoDelay(true);

  let expired = false;
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // Destroying here is what makes the bound real rather than advisory: the promise race below stops
      // waiting, and this stops the socket existing.
      socket.destroy();
      reject(new SmtpError('timeout'));
    }, timeoutMs);
  });
  expiry.catch(() => {});
  const guard = (promise) => Promise.race([promise, expiry]);

  let channel = null;
  try {
    channel = createChannel(socket);
    await guard(whenReady(socket, mode === 'implicit' ? 'secureConnect' : 'connect'));

    const expect = async (...accepted) => {
      const reply = await guard(channel.read());
      if (!accepted.includes(reply.code)) throw new SmtpError('rejected', reply.code);
      return reply;
    };
    const command = async (text, ...accepted) => {
      channel.write(`${text}${CRLF}`);
      return expect(...accepted);
    };

    await expect(220);
    let caps = capabilities(await command(`EHLO ${heloName}`, 250));

    if (mode === 'starttls') {
      // Refused rather than downgraded. A server that stops advertising STARTTLS is either
      // misconfigured or being stripped by something in the path, and continuing in cleartext is
      // precisely what an attacker in that position wants.
      if (!caps.has('STARTTLS')) throw new SmtpError('starttls_unsupported');
      await command('STARTTLS', 220);
      if (channel.residual() !== '') throw new SmtpError('starttls_injection');
      channel.detach();
      const plain = socket;
      socket = tls.connect({ socket: plain, servername, rejectUnauthorized });
      channel = createChannel(socket);
      await guard(whenReady(socket, 'secureConnect'));
      // The capability list from before the upgrade is discarded. It arrived in the clear and could have
      // been rewritten by whoever was in a position to rewrite it.
      caps = capabilities(await command(`EHLO ${heloName}`, 250));
    }

    if (username) {
      if (supportsAuth(caps, 'PLAIN')) {
        const credential = Buffer.from(`\0${username}\0${password ?? ''}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${credential}`, 235);
      } else if (supportsAuth(caps, 'LOGIN')) {
        await command('AUTH LOGIN', 334);
        await command(Buffer.from(username, 'utf8').toString('base64'), 334);
        await command(Buffer.from(password ?? '', 'utf8').toString('base64'), 235);
      } else {
        // Not a downgrade to anonymous submission: a relay that will not take these credentials is not a
        // relay this deployment was configured to use.
        throw new SmtpError('auth_unsupported');
      }
    }

    // No BODY= parameter, because the message is always 7-bit clean on the wire: a record containing a
    // character outside ASCII is base64-encoded before it gets here, so 8BITMIME never needs
    // negotiating and a relay that does not support it cannot mangle anything.
    await command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients) await command(`RCPT TO:<${recipient}>`, 250, 251);
    await command('DATA', 354);
    channel.write(message);
    await expect(250);
    // Best effort. The message is accepted at the 250 above; a server that never answers QUIT has
    // already taken delivery, and waiting for it would put the deadline between us and a success.
    try {
      await command('QUIT', 221);
    } catch {
      // Deliberately empty: see above.
    }
    return { accepted: recipients.length, secure: mode !== 'disabled' };
  } catch (error) {
    if (expired) throw new SmtpError('timeout');
    throw error instanceof SmtpError ? error : new SmtpError('session_failed');
  } finally {
    clearTimeout(timer);
    channel?.detach();
    socket.destroy();
  }
}
