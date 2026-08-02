import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createApp } from '../src/app.mjs';

// Regression tests for a finding from the Stage 3 live negative-test run.
//
// `GET /v1/dossiers/{id}/download` and `POST /v1/review-snapshots/{id}/dossier` accepted any string
// as an identifier and passed it to a query that casts to uuid. PostgreSQL raised 22P02, which became
// a 500 — and the error handler echoed `22P02` back to the caller as `error.code`.
//
// Two defects in one response. The SQLSTATE told an attacker the backend is PostgreSQL and that their
// input reached a query. And the 500 itself was an oracle: everywhere else a caller gets 404 whether
// a resource is missing or merely not theirs, deliberately, so that error codes cannot be used to map
// what exists. A 500 meaning "malformed" broke that symmetry.

function requestTo(app, method, path, headers = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
      const text = await response.text();
      server.close();
      let body;
      try { body = JSON.parse(text); } catch { body = { text }; }
      resolve({ status: response.status, body });
    });
  });
}

// A pool that fails the way the real driver did, so the test exercises the handler rather than a mock
// that politely returns nothing.
const throwingPool = {
  connect: async () => ({
    query: async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); },
    release: () => {},
  }),
  query: async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); },
};

test('a database error code is never echoed to the caller', async () => {
  const app = express();
  app.get('/boom', (_request, _response, next) => {
    next(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));
  });
  // The same handler shape the application installs.
  const built = createApp({ pool: throwingPool, bootstrapToken: 'x', rateLimiterFactory: () => () => (_q, _s, next) => next() });
  app._router.stack.push(built._router.stack.at(-1));

  const result = await requestTo(app, 'GET', '/boom');
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR', 'a driver SQLSTATE reached the caller');
  assert.doesNotMatch(JSON.stringify(result.body), /22P02|invalid input syntax|uuid/iu, 'the response describes the database');
});

test('a deliberate error code still reaches the caller', async () => {
  // The hardening must not flatten the codes this codebase raises on purpose — the interface reads
  // them to explain a failure in the user's language.
  const app = express();
  app.get('/refused', (_request, _response, next) => {
    next(Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 }));
  });
  const built = createApp({ pool: throwingPool, bootstrapToken: 'x', rateLimiterFactory: () => () => (_q, _s, next) => next() });
  app._router.stack.push(built._router.stack.at(-1));

  const result = await requestTo(app, 'GET', '/refused');
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'RESOURCE_NOT_FOUND');
});

test('a lowercase or numeric code is not treated as deliberate', async () => {
  // The rule is shape-based, so it has to be checked against things that are not SQLSTATEs too.
  for (const code of ['22P02', 'econnrefused', 'ETIMEDOUT ', '42P01']) {
    const app = express();
    app.get('/x', (_request, _response, next) => next(Object.assign(new Error('boom'), { code, status: 500 })));
    const built = createApp({ pool: throwingPool, bootstrapToken: 'x', rateLimiterFactory: () => () => (_q, _s, next) => next() });
    app._router.stack.push(built._router.stack.at(-1));
    const result = await requestTo(app, 'GET', '/x');
    assert.equal(result.body.error.code, 'INTERNAL_ERROR', `${code} was echoed back`);
  }
});

test('a deliberate code with a 500 status still reaches the caller', async () => {
  // EVIDENCE_INTEGRITY_MISMATCH is raised with status 500 on purpose: stored bytes no longer match
  // their persisted metadata, and the caller is meant to see which failure that was. An earlier
  // version of the disclosure rule keyed on the status band and flattened it, hiding a real integrity
  // signal in order to hide a driver's vocabulary. The discriminator is an explicit status, not a low
  // one.
  const app = express();
  app.get('/integrity', (_request, _response, next) => {
    next(Object.assign(new Error('Evidence integrity verification failed.'), { code: 'EVIDENCE_INTEGRITY_MISMATCH', status: 500 }));
  });
  const built = createApp({ pool: throwingPool, bootstrapToken: 'x', rateLimiterFactory: () => () => (_q, _s, next) => next() });
  app._router.stack.push(built._router.stack.at(-1));
  const result = await requestTo(app, 'GET', '/integrity');
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'EVIDENCE_INTEGRITY_MISMATCH');
});

test('every route taking an :id validates it', async () => {
  // The class, not the instance.
  //
  // The original disclosure was found on two routes and fixed on two routes. A route-by-route audit then found six
  // more taking an :id without validating it, three of which still returned 500 on a malformed value
  // — the same not-found oracle, in the same release, after the "fix".
  //
  // This asserts the property across the whole surface, so a new route cannot reintroduce it by
  // being written the way every existing one was.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await readFile(fileURLToPath(new URL('../src/app.mjs', import.meta.url)), 'utf8');
  const lines = source.split('\n');
  const routes = [];
  for (const [index, line] of lines.entries()) {
    const match = /app\.(get|post|put|patch|delete)\('([^']+)'/u.exec(line);
    if (match) routes.push({ line: index, path: match[2] });
  }
  // Every `:id` route validates before the value reaches a query. Which validator applies depends on the
  // column type: a `uuid` key uses `requireUuid`, and the gap routes use `requireGapId`, because
  // `gaps.id` is `text` and requiring a UUID there refuses every legitimate identifier.
  //
  // The gap routes were excluded from this audit entirely until 2026-07-30, on the reasoning that a `text`
  // column takes no cast, so a malformed value produces an ordinary empty result and the existing 404
  // rather than the 500 the uuid-keyed routes produced. That is true and beside the point: nothing broke,
  // and an unvalidated attacker-controlled value still reached a query, a log line and an audit record.
  const TEXT_KEYED = ['/v1/gaps/:id/assign', '/v1/gaps/:id/remediate', '/v1/gaps/:id/reassess'];
  const validatorFor = (path) => (TEXT_KEYED.includes(path) ? 'requireGapId' : 'requireUuid');
  const unvalidated = [];
  for (const [index, route] of routes.entries()) {
    if (!route.path.includes(':id')) continue;
    const end = routes[index + 1]?.line ?? lines.length;
    if (!lines.slice(route.line, end).join('\n').includes(validatorFor(route.path))) unvalidated.push(route.path);
  }
  assert.deepEqual(unvalidated, [], `these routes pass an unvalidated identifier to a query: ${unvalidated.join(', ')}`);
  assert.ok(routes.some((route) => route.path.includes(':id')), 'the audit found no :id routes at all, so it proved nothing');
  for (const path of TEXT_KEYED) {
    assert.ok(routes.some((route) => route.path === path), `${path} no longer exists — revisit its validator`);
  }
  // And a text-keyed route must not be checked as a UUID: that refuses every legitimate identifier, which
  // is what happened when the original fix was applied to every :id route indiscriminately.
  for (const [index, route] of routes.entries()) {
    if (!TEXT_KEYED.includes(route.path)) continue;
    const end = routes[index + 1]?.line ?? lines.length;
    assert.ok(
      !lines.slice(route.line, end).join('\n').includes('requireUuid('),
      `${route.path} keys on text and must not require a UUID`,
    );
  }

  // Presence is not enough, and this assertion exists because the weaker one passed while the defect
  // was still live: the evidence-download route called requireUuid three lines *below* a query that
  // had already received the raw value. Within any :id route, the raw parameter must never be used
  // unwrapped.
  const bare = [];
  for (const [index, route] of routes.entries()) {
    if (!route.path.includes(':id')) continue;
    const end = routes[index + 1]?.line ?? lines.length;
    const validator = validatorFor(route.path);
    for (const offset of lines.slice(route.line, end).keys()) {
      const line = lines[route.line + offset];
      if (line.trimStart().startsWith('//')) continue;
      for (const match of line.matchAll(/request\.params\.id/gu)) {
        const preceding = line.slice(Math.max(0, match.index - 14), match.index);
        if (!preceding.includes(`${validator}(`)) bare.push(`${route.path} line ${route.line + offset + 1}`);
      }
    }
  }
  assert.deepEqual(bare, [], `an unvalidated identifier is used at:\n${bare.join('\n')}`);
});
