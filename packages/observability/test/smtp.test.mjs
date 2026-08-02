// The SMTP client, against an SMTP server this file implements.
//
// Nothing here connects to a real mail host, and nothing here sends a real credential anywhere. Every
// server is a `net`/`tls` listener on 127.0.0.1 on an ephemeral port, started and stopped inside the
// test, and the credentials are literals invented here.
//
// What is worth asserting about a hand-written line protocol is not "it can send mail" — that is the
// easy half and it is visible the first time anyone tries it. It is the set of failures that are silent:
// a body truncated at a dot, a credential sent before the TLS upgrade, a session that hangs because the
// far end accepted the connection and then said nothing.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { after, test } from 'node:test';
import { buildMessage, isEnvelopeAddress, sendMail, stuffDots } from '../src/smtp.mjs';

const CRLF = '\r\n';

// ---------------------------------------------------------------------------------------------
// A throwaway certificate, built here at run time.
//
// It is generated rather than committed for two reasons: a private key checked into this repository is
// a finding by the repository's own secret scanner and rightly so, and a fixture certificate has an
// expiry date, which means a committed one eventually fails the suite on a Tuesday for no reason.
//
// Node can generate a key pair but cannot issue a certificate, so the X.509 structure is assembled by
// hand in DER. It carries no extensions because it needs none: the client connects with
// `rejectUnauthorized: false` in these tests, so nothing verifies a name or a chain. What is being
// tested is that the handshake happens at all, and that the client refuses to talk before it does.

function derLength(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  let value = size;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
const sequence = (...parts) => tlv(0x30, Buffer.concat(parts));
const setOf = (...parts) => tlv(0x31, Buffer.concat(parts));
const objectId = (bytes) => tlv(0x06, Buffer.from(bytes));
const bitString = (value) => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const printable = (text) => tlv(0x13, Buffer.from(text, 'ascii'));
const explicit = (index, value) => tlv(0xa0 | index, value);
const utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/gu, '')}Z`, 'ascii'));

function integer(value) {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function selfSigned() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // sha256WithRSAEncryption, and commonName.
  const algorithm = sequence(objectId([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = sequence(setOf(sequence(objectId([0x55, 0x04, 0x03]), printable('openppwr-smtp-test'))));
  const now = Date.now();
  const validity = sequence(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 86400000)));
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(0x4f_50_50_01),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const certificate = sequence(tbs, algorithm, bitString(sign('sha256', tbs, privateKey)));
  const body = certificate.toString('base64').replace(/.{1,64}/gu, '$&\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`,
  };
}

const IDENTITY = selfSigned();

// ---------------------------------------------------------------------------------------------
// The server.

const servers = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((closed) => server.close(closed));
  }
});

function speak(socket, session, options) {
  let buffer = '';
  let inData = false;
  let awaitingLoginUsername = false;
  let awaitingLoginPassword = false;
  const reply = (line) => socket.write(`${line}${CRLF}`);

  const command = (line) => {
    session.commands.push(line);
    const verb = line.split(' ')[0].toUpperCase();
    if (options.rejectAt === verb) {
      reply(`${options.rejectCode ?? 550} refused by the test server`);
      return;
    }
    if (verb === 'EHLO') {
      const extensions = session.secure ? options.secureExtensions : options.extensions;
      reply(`250-test greets ${line.slice(5)}`);
      for (const [index, extension] of extensions.entries()) {
        reply(`${index === extensions.length - 1 ? '250 ' : '250-'}${extension}`);
      }
      return;
    }
    if (verb === 'STARTTLS') {
      reply('220 ready to start TLS');
      // Straight after the 220 and before the handshake. A client that keeps its buffer across the
      // upgrade would execute this as though it had arrived inside the encrypted session.
      if (options.injectAfterStartTls) socket.write(`250 injected${CRLF}`);
      socket.removeAllListeners('data');
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext({ key: IDENTITY.key, cert: IDENTITY.cert }),
      });
      secure.on('error', () => {});
      secure.once('secure', () => {
        session.secure = true;
        speak(secure, session, options);
      });
      return;
    }
    if (verb === 'AUTH') {
      const mechanism = (line.split(' ')[1] || '').toUpperCase();
      session.authSecure = session.secure;
      if (mechanism === 'PLAIN') {
        session.auth = { mechanism: 'PLAIN', value: Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8') };
        reply(options.authCode ?? '235 2.7.0 authenticated');
        return;
      }
      if (mechanism === 'LOGIN') {
        awaitingLoginUsername = true;
        reply('334 VXNlcm5hbWU6');
        return;
      }
      reply('504 unrecognised mechanism');
      return;
    }
    if (awaitingLoginUsername) return;
    if (verb === 'DATA') {
      inData = true;
      session.data = [];
      reply('354 end with a line containing only a dot');
      return;
    }
    if (verb === 'QUIT') {
      reply('221 bye');
      socket.end();
      return;
    }
    reply('250 2.0.0 ok');
  };

  const line = (text) => {
    if (awaitingLoginUsername) {
      awaitingLoginUsername = false;
      awaitingLoginPassword = true;
      session.auth = { mechanism: 'LOGIN', username: Buffer.from(text, 'base64').toString('utf8') };
      reply('334 UGFzc3dvcmQ6');
      return;
    }
    if (awaitingLoginPassword) {
      awaitingLoginPassword = false;
      session.auth.password = Buffer.from(text, 'base64').toString('utf8');
      reply(options.authCode ?? '235 2.7.0 authenticated');
      return;
    }
    if (inData) {
      // A real server ends DATA here, which is precisely why an unstuffed dot truncates the message.
      if (text === '.') {
        inData = false;
        session.raw = session.data.join(CRLF);
        // Transparency undone, RFC 5321 §4.5.2: a leading dot on the wire was added by the sender.
        session.message = session.data.map((entry) => (entry.startsWith('.') ? entry.slice(1) : entry)).join(CRLF);
        session.finished = true;
        reply('250 2.0.0 accepted');
        return;
      }
      session.data.push(text);
      return;
    }
    command(text);
  };

  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf(CRLF);
      if (newline < 0) return;
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + CRLF.length);
      line(text);
    }
  });
}

async function startServer(options = {}) {
  const settings = {
    extensions: ['STARTTLS', 'AUTH PLAIN LOGIN', 'SIZE 10240000'],
    secureExtensions: ['AUTH PLAIN LOGIN', 'SIZE 10240000'],
    greeting: '220 test.invalid ESMTP',
    implicit: false,
    silent: false,
    ...options,
  };
  const sessions = [];
  const onConnection = (socket) => {
    const session = { commands: [], secure: Boolean(settings.implicit), finished: false };
    sessions.push(session);
    if (settings.silent) {
      // Accepts the connection, then says nothing at all. This is the mail-server failure the whole
      // deadline exists for, and it is not the same as a refused connection.
      socket.on('error', () => {});
      return;
    }
    speak(socket, session, settings);
    socket.write(`${settings.greeting}${CRLF}`);
  };
  const server = settings.implicit
    ? tls.createServer({ key: IDENTITY.key, cert: IDENTITY.cert }, onConnection)
    : net.createServer(onConnection);
  server.on('error', () => {});
  servers.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { sessions, port: server.address().port, host: '127.0.0.1' };
}

const HEADERS = [['From', 'alerts@example.invalid'], ['To', 'ops@example.invalid'], ['Subject', 'test']];

function send(server, overrides = {}) {
  return sendMail({
    host: server.host,
    port: server.port,
    tls: 'disabled',
    from: 'alerts@example.invalid',
    recipients: ['ops@example.invalid'],
    headers: HEADERS,
    body: 'body',
    timeoutMs: 4000,
    rejectUnauthorized: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------

test('a message is delivered over an ordinary session, in the order SMTP requires', async () => {
  const server = await startServer();
  await send(server, { body: 'hello' });
  const [session] = server.sessions;
  const verbs = session.commands.map((line) => line.split(' ')[0].toUpperCase());
  assert.deepEqual(verbs, ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  assert.ok(session.finished, 'DATA was never terminated, so the server never accepted the message');
  assert.ok(session.message.endsWith(`${CRLF}${CRLF}hello`), `body was ${JSON.stringify(session.message)}`);
});

// THE ONE THAT FAILS SILENTLY.
//
// A body line consisting of a single `.` is the DATA terminator unless the client doubles it. Get it
// wrong and nothing errors: the server accepts a truncated message and returns 250, the sender's logs
// say delivered, and every message that happens not to contain such a line keeps working. The remainder
// of the body is then read by the server as SMTP commands, which is its own problem.
test('a body line that is a single dot survives, and is not the end of the message', async () => {
  const server = await startServer();
  const body = ['first line', '.', 'after the dot', '..already doubled', '.leading dot', 'last line'].join('\n');
  await send(server, { body });
  const [session] = server.sessions;
  assert.ok(session.finished, 'the server never saw a terminator');
  const received = session.message.slice(session.message.indexOf(`${CRLF}${CRLF}`) + 4);
  assert.equal(received, body.replaceAll('\n', CRLF), 'the body was truncated or altered in transit');
  // And the wire form was genuinely stuffed rather than the server being lenient.
  assert.ok(session.raw.includes(`${CRLF}..${CRLF}`), 'the lone dot was not doubled on the wire');
  assert.ok(session.raw.includes(`${CRLF}...already doubled${CRLF}`), 'an already-doubled dot was not stuffed again');
});

test('line endings on the wire are CRLF regardless of what the caller supplied', async () => {
  const server = await startServer();
  await send(server, { body: 'alpha\nbeta\r\ngamma\rdelta' });
  const [session] = server.sessions;
  const received = session.message.slice(session.message.indexOf(`${CRLF}${CRLF}`) + 4);
  assert.equal(received, ['alpha', 'beta', 'gamma', 'delta'].join(CRLF));
  assert.ok(!/[^\r]\n/u.test(session.raw), 'a bare LF reached the wire');
});

test('STARTTLS upgrades the connection, and the credential is sent only afterwards', async () => {
  const server = await startServer();
  await send(server, {
    tls: 'starttls',
    username: 'alert-user',
    password: 'alert-secret-x9',
  });
  const [session] = server.sessions;
  assert.ok(session.secure, 'the connection was never upgraded');
  assert.equal(session.auth.mechanism, 'PLAIN');
  assert.equal(session.auth.value, '\0alert-user\0alert-secret-x9');
  assert.ok(session.authSecure, 'the credential was sent before the TLS handshake');
  // EHLO twice: once in the clear, once inside the session. The capability list from the first is
  // discarded, because whoever could rewrite it could also have removed STARTTLS from it.
  assert.equal(session.commands.filter((line) => line.startsWith('EHLO')).length, 2);
  assert.ok(session.finished);
});

test('implicit TLS speaks nothing in the clear at all', async () => {
  const server = await startServer({ implicit: true, extensions: ['AUTH PLAIN LOGIN'], secureExtensions: ['AUTH PLAIN LOGIN'] });
  await send(server, { tls: 'implicit', username: 'alert-user', password: 'alert-secret-x9' });
  const [session] = server.sessions;
  assert.ok(session.authSecure, 'a credential was sent outside the TLS session');
  assert.ok(session.finished);
});

test('AUTH LOGIN is used when the server offers nothing better', async () => {
  const server = await startServer({ secureExtensions: ['AUTH LOGIN'] });
  await send(server, { tls: 'starttls', username: 'alert-user', password: 'alert-secret-x9' });
  const [session] = server.sessions;
  assert.equal(session.auth.mechanism, 'LOGIN');
  assert.equal(session.auth.username, 'alert-user');
  assert.equal(session.auth.password, 'alert-secret-x9');
  assert.ok(session.authSecure);
});

test('a server that stops advertising STARTTLS is refused rather than downgraded', async () => {
  const server = await startServer({ extensions: ['AUTH PLAIN LOGIN'] });
  await assert.rejects(
    send(server, { tls: 'starttls', username: 'alert-user', password: 'alert-secret-x9' }),
    (error) => error.reason === 'starttls_unsupported',
  );
  const [session] = server.sessions;
  // Nothing past EHLO. Continuing in the clear is what an attacker stripping the capability wants.
  assert.deepEqual(session.commands.map((line) => line.split(' ')[0].toUpperCase()), ['EHLO']);
  assert.equal(session.auth, undefined, 'a credential was sent to a server that refused to encrypt');
});

test('bytes sent before the TLS handshake end the session instead of being executed', async () => {
  const server = await startServer({ injectAfterStartTls: true });
  await assert.rejects(
    send(server, { tls: 'starttls' }),
    (error) => error.reason === 'starttls_injection',
  );
});

test('a server offering no mechanism this client can use is refused, not fallen back from', async () => {
  const server = await startServer({ secureExtensions: ['SIZE 1024'] });
  await assert.rejects(
    send(server, { tls: 'starttls', username: 'alert-user', password: 'alert-secret-x9' }),
    (error) => error.reason === 'auth_unsupported',
  );
});

test('credentials are never handed to a connection that is not encrypted', async () => {
  const server = await startServer();
  await assert.rejects(
    send(server, { tls: 'disabled', username: 'alert-user', password: 'alert-secret-x9' }),
    (error) => error.reason === 'credentials_without_tls',
  );
  assert.equal(server.sessions.length, 0, 'the client connected before deciding it must not authenticate');
});

// The failure mode that distinguishes SMTP from a webhook: the far end accepts the TCP connection and
// then never speaks. Nothing times this out on its own — the OS connect timeout has already been
// satisfied — so without a deadline the socket is held until the process ends.
test('a server that accepts the connection and says nothing is abandoned on time', async () => {
  const server = await startServer({ silent: true });
  const started = process.hrtime.bigint();
  await assert.rejects(send(server, { timeoutMs: 400 }), (error) => error.reason === 'timeout');
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed >= 300 && elapsed < 3000, `gave up after ${elapsed.toFixed(0)}ms`);
});

// The stage matters. A server that greets, answers EHLO and MAIL, and then goes quiet at RCPT has
// already passed everything a connect-level bound would check. One deadline over the whole session is
// what covers this, and it is why there is not a separate connect timeout and command timeout.
test('a server that stalls in the middle of the transaction is abandoned on the same deadline', async () => {
  const reached = [];
  const listener = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.write(`220 test ESMTP${CRLF}`);
    socket.on('data', (chunk) => {
      for (const line of String(chunk).split(CRLF).filter(Boolean)) {
        reached.push(line.split(' ')[0].toUpperCase());
        if (line.startsWith('EHLO')) socket.write(`250 test${CRLF}`);
        else if (line.startsWith('MAIL')) socket.write(`250 ok${CRLF}`);
        // RCPT and everything after it: silence, with the socket held open.
      }
    });
  });
  servers.push(listener);
  await new Promise((ready) => listener.listen(0, '127.0.0.1', ready));
  const started = process.hrtime.bigint();
  await assert.rejects(
    sendMail({
      host: '127.0.0.1',
      port: listener.address().port,
      tls: 'disabled',
      from: 'alerts@example.invalid',
      recipients: ['ops@example.invalid'],
      headers: HEADERS,
      body: 'body',
      timeoutMs: 400,
    }),
    (error) => error.reason === 'timeout',
  );
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed >= 300 && elapsed < 3000, `gave up after ${elapsed.toFixed(0)}ms`);
  assert.deepEqual(reached, ['EHLO', 'MAIL', 'RCPT'], 'the session did not stall where this test needs it to');
});

test('a refusal at any stage is reported with the reply code and nothing else', async () => {
  const server = await startServer({ rejectAt: 'RCPT', rejectCode: 550 });
  await assert.rejects(
    send(server),
    (error) => error.reason === 'rejected' && error.replyCode === 550,
  );
  const server2 = await startServer({ rejectAt: 'MAIL', rejectCode: 452 });
  await assert.rejects(
    send(server2),
    (error) => error.reason === 'rejected' && error.replyCode === 452,
  );
});

test('a refusal message never carries the server text, the host or the credential', async () => {
  const server = await startServer({ rejectAt: 'MAIL', rejectCode: 550 });
  await assert.rejects(send(server), (error) => {
    const text = `${error.message} ${error.reason} ${error.stack?.split('\n')[0] ?? ''}`;
    assert.ok(!text.includes('refused by the test server'), 'the server reply text was carried forward');
    assert.ok(!text.includes(String(server.port)), 'the destination port was carried forward');
    return true;
  });
});

test('a reply larger than the client will hold ends the session instead of growing the buffer', async () => {
  const listener = net.createServer((socket) => {
    socket.on('error', () => {});
    // No CRLF-terminated complete reply, ever. Just bytes.
    socket.write(`220-${'x'.repeat(70000)}${CRLF}`);
  });
  servers.push(listener);
  await new Promise((ready) => listener.listen(0, '127.0.0.1', ready));
  await assert.rejects(
    sendMail({
      host: '127.0.0.1',
      port: listener.address().port,
      tls: 'disabled',
      from: 'alerts@example.invalid',
      recipients: ['ops@example.invalid'],
      headers: HEADERS,
      body: 'body',
      timeoutMs: 4000,
    }),
    (error) => error.reason === 'reply_too_large',
  );
});

test('every recipient gets its own RCPT', async () => {
  const server = await startServer();
  await send(server, { recipients: ['a@example.invalid', 'b@example.invalid', 'c@example.invalid'] });
  const [session] = server.sessions;
  assert.deepEqual(
    session.commands.filter((line) => line.startsWith('RCPT')),
    ['RCPT TO:<a@example.invalid>', 'RCPT TO:<b@example.invalid>', 'RCPT TO:<c@example.invalid>'],
  );
});

test('an address or a header that could inject a command or a header is refused before connecting', async () => {
  const server = await startServer();
  const cases = [
    ['invalid_sender', { from: 'alerts@example.invalid>\r\nRCPT TO:<attacker@example.invalid' }],
    ['invalid_sender', { from: 'not an address' }],
    ['invalid_recipient', { recipients: ['ops@example.invalid>\r\nDATA'] }],
    ['invalid_recipient', { recipients: [] }],
    ['header_injection', { headers: [['Subject', `alert${CRLF}Bcc: attacker@example.invalid`]] }],
    ['header_injection', { headers: [['Subject\r\nBcc', 'x']] }],
  ];
  for (const [reason, overrides] of cases) {
    await assert.rejects(send(server, overrides), (error) => error.reason === reason, JSON.stringify(overrides));
  }
  assert.equal(server.sessions.length, 0, 'a rejected message still opened a connection to the mail server');
});

test('the encodings agree on what the body was', async () => {
  const record = JSON.stringify({ event: 'x', filename: 'zaświadczenie.pdf' });
  const plain = buildMessage({ headers: HEADERS, body: record, encoding: '7bit' });
  const encoded = buildMessage({ headers: HEADERS, body: record, encoding: 'base64' });
  const plainBody = plain.slice(plain.indexOf(`${CRLF}${CRLF}`) + 4, -`${CRLF}.${CRLF}`.length);
  const encodedBody = encoded.slice(encoded.indexOf(`${CRLF}${CRLF}`) + 4, -`${CRLF}.${CRLF}`.length);
  assert.equal(plainBody, record);
  assert.equal(Buffer.from(encodedBody.replaceAll(CRLF, ''), 'base64').toString('utf8'), record);
});

test('the pieces hold on their own', () => {
  assert.equal(stuffDots(`a${CRLF}.${CRLF}b`), `a${CRLF}..${CRLF}b`);
  assert.equal(stuffDots('.leading'), '..leading');
  assert.equal(stuffDots('no dots here'), 'no dots here');
  assert.ok(isEnvelopeAddress('security@example.invalid'));
  assert.ok(!isEnvelopeAddress('security@example.invalid\r\nDATA'));
  assert.ok(!isEnvelopeAddress('no-at-sign'));
  assert.ok(!isEnvelopeAddress('a b@example.invalid'));
  assert.ok(!isEnvelopeAddress(`x@example.invalid, y@example.invalid`));
  assert.equal(typeof randomUUID(), 'string');
});
