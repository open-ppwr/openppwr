import assert from 'node:assert/strict';
import { test } from 'node:test';
import { log, logSync } from '../src/index.mjs';

// Runtime redaction, tested at runtime.
//
// The redacting logger existed in this package for the whole programme and was imported by nothing.
// A control that is claimed by source existing and delivered by no running code is NOT_IMPLEMENTED
// under Attentus SECURITY v2 §2, not "implemented but unverified" — and it was recorded as the latter
// for a stage. These tests capture what the process actually writes.

function captured(callback) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { callback(); } finally { process.stdout.write = original; }
  return written.join('');
}

test('a secret-bearing field name is dropped entirely', () => {
  const line = captured(() => logSync('warn', 'api.request.refused', {
    authorization: 'Bearer opp_live_abcdefghijklmnop',
    password: 'hunter2',
    secret: 'shhh',
    token: 'opp_test_xyz',
    apiKey: 'k-123',
    code: 'AUTHENTICATION_FAILED',
  }));
  assert.doesNotMatch(line, /opp_live_abcdefghijklmnop/u, 'a bearer token reached the log');
  assert.doesNotMatch(line, /hunter2/u, 'a password reached the log');
  assert.doesNotMatch(line, /shhh/u);
  assert.doesNotMatch(line, /opp_test_xyz/u);
  assert.match(line, /AUTHENTICATION_FAILED/u, 'the event code must survive — it is the point of the entry');
});

test('a secret embedded in a value is redacted', () => {
  const line = captured(() => logSync('warn', 'probe', {
    message: 'upstream said authorization=Bearer-abc123 and token=t-987 failed',
  }));
  assert.doesNotMatch(line, /Bearer-abc123/u);
  assert.doesNotMatch(line, /t-987/u);
  assert.match(line, /\[REDACTED\]/u);
});

test('the entry is one line of JSON with a timestamp and level', () => {
  const line = captured(() => logSync('error', 'api.request.refused', { code: 'INTERNAL_ERROR', status: 500 }));
  assert.equal(line.trimEnd().split('\n').length, 1, 'a multi-line entry breaks line-based collection');
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.event, 'api.request.refused');
  assert.equal(parsed.code, 'INTERNAL_ERROR');
  assert.ok(Date.parse(parsed.timestamp), 'no parseable timestamp');
});

test('a newline in a value cannot forge a second log entry', () => {
  // A log record must not be forgeable from a value inside it. JSON.stringify escapes the newline, so the
  // forged entry arrives as text inside one record rather than as a record of its own.
  const line = captured(() => logSync('warn', 'probe', {
    note: 'benign\n{"level":"info","event":"admin.granted","actorId":"attacker"}',
  }));
  assert.equal(line.trimEnd().split('\n').length, 1, 'a value forged a second log line');
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'probe', 'the forged event replaced the real one');
  assert.match(parsed.note, /admin\.granted/u, 'the payload should be preserved as inert text');
});

test('the API refusal path uses this logger', async () => {
  // Wiring is the half that was missing. This asserts the import exists rather than trusting that
  // someone remembered to add it.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await readFile(fileURLToPath(new URL('../../../apps/api/src/app.mjs', import.meta.url)), 'utf8');
  assert.match(source, /from '@openppwr\/observability'/u, 'the API does not import the redacting logger');
  assert.match(source, /log\(status >= 500 \? 'error' : 'warn', 'api\.request\.refused'/u, 'refusals are not logged');
  assert.doesNotMatch(source, /log\([^)]*authorization/iu, 'the API passes an authorization value to the logger');
});

test('the deferred write does not block the caller and still emits', async () => {
  // The reason `log` defers: process.stdout is synchronous when it points at a file, so logging inline
  // put a blocking filesystem write on the request path. A 74-second suite became a 20-minute timeout
  // under a gate that redirects output to a file, and the same coupling would stall request handling
  // whenever the log destination was slow to drain.
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    log('warn', 'deferred.probe', { code: 'RESOURCE_NOT_FOUND' });
    // The test runner writes to stdout too, so count only this event rather than every line.
    assert.equal(written.filter((line) => line.includes('deferred.probe')).length, 0,
      'the write happened on the caller stack');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stdout.write = original;
  }
  const mine = written.filter((line) => line.includes('deferred.probe'));
  assert.equal(mine.length, 1, 'the deferred write never happened');
  assert.match(mine[0], /RESOURCE_NOT_FOUND/u);
});
