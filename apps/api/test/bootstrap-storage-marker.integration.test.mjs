// SPDX-License-Identifier: Apache-2.0
//
// Bootstrap records the evidence volume's identity, and the worker refuses to expire evidence without it.
//
// Only the installer wrote `.openppwr-storage-initialized`, from the host, after calling `/v1/bootstrap`.
// Anyone bootstrapping through the API directly — which the QuickStart documents, and which is the only
// route available without the installer — got a deployment whose retention sweep failed closed for ever
// with `RETENTION_STORAGE_UNREADABLE`. Failing closed was correct and it was still a deployment that could
// never expire anything, with the reason visible only in worker logs.
//
// The marker belongs to whoever performs the bootstrap, and bootstrap is an API operation.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createPool, migrate } from '@openppwr/database';
import { startTestDatabase } from '../../../scripts/testing/embedded-postgres.mjs';

let database;
let pool;
let server;
let baseUrl;
let bootstrapSecret;
const storageRoot = `.runtime-test/bootstrap-marker-${randomUUID()}`;
const markerPath = join(storageRoot, '.openppwr-storage-initialized');

before(async () => {
  database = await startTestDatabase('api-bootstrap-marker');
  await migrate(database.adminUrl);
  pool = createPool(database.runtimeUrl);
  bootstrapSecret = randomUUID();
  const app = createApp({ pool, bootstrapToken: bootstrapSecret, storageRoot });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await database.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

test('the storage root carries no identity before bootstrap', async () => {
  await assert.rejects(stat(markerPath), { code: 'ENOENT' },
    'a marker existing before bootstrap would make this test prove nothing');
});

test('bootstrap through the API records the evidence volume identity', async () => {
  const response = await fetch(`${baseUrl}/v1/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openppwr-bootstrap-token': bootstrapSecret },
    body: JSON.stringify({ slug: 'marker-test', name: 'Marker Test Ltd' }),
  });
  assert.equal(response.status, 201);

  // The marker's value is that it cannot exist unless a bootstrap succeeded against this volume, so the
  // assertion is on the file rather than on the response: a deployment is repaired by the file being
  // there, not by the API having said it wrote one.
  const written = await readFile(markerPath, 'utf8');
  assert.match(written.trim(), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
    'the marker records when bootstrap ran, so an operator can tell it apart from a file restored by hand');
});
