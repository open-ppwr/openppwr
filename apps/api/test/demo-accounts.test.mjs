// What `/v1/demo/accounts` tells an anonymous caller about this deployment.
//
// The route exists so that a demonstration can publish the one thing a demonstration must publish: how to
// sign in to it. It now also reports whether the demonstration reset is wired, because the workbench had no
// way to tell a demonstration from a production installation and therefore offered its destructive "Reset
// environment" panel to every signed-in user of every deployment — a red button that deletes data,
// described as restoring a demonstration environment, which on a self-hosted installation is both dead and
// untrue.
//
// No database is involved: the route answers from configuration alone, and this suite exercises exactly
// that, so the contract the browser depends on is checked without an integration environment.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { HUMAN_ROLE_NAMES, MACHINE_ROLE_NAMES } from '../src/permissions.mjs';

const previousDemoLogin = process.env.OPENPPWR_DEMO_LOGIN;
after(() => {
  if (previousDemoLogin === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
  else process.env.OPENPPWR_DEMO_LOGIN = previousDemoLogin;
});

// A pool that would throw if anything touched it. Nothing on this path may.
const POOL = { connect() { throw new Error('the demonstration accounts route must not reach the database'); } };
const PRESENT = { connect() { throw new Error('unused'); } };
const rateLimiterFactory = () => () => (_request, _response, next) => next();

async function accountsResponse({ demoLogin, authPool, maintenancePool }) {
  if (demoLogin === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
  else process.env.OPENPPWR_DEMO_LOGIN = demoLogin;
  const app = createApp({ pool: POOL, authPool, maintenancePool, bootstrapToken: 'unused', rateLimiterFactory });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/demo/accounts`);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a demonstration says whether its reset endpoint exists', async () => {
  const wired = await accountsResponse({ demoLogin: 'true', authPool: PRESENT, maintenancePool: PRESENT });
  assert.equal(wired.status, 200);
  assert.equal(wired.body.resetAvailable, true, 'the workbench may offer the reset panel here');
  assert.ok(wired.body.accounts.length, 'the accounts it already published are unchanged');

  // `POST /v1/demo/reset` runs on the maintenance credential and answers 404 for every role without it.
  // Reporting that honestly is the difference between a panel that works and a panel that only looks like
  // it does.
  const unwired = await accountsResponse({ demoLogin: 'true', authPool: PRESENT, maintenancePool: null });
  assert.equal(unwired.status, 200);
  assert.equal(unwired.body.resetAvailable, false);
});

// What this route publishes is also what `bootstrap` provisions, and the two used to be different lists:
// seven addresses were offered and nine accounts were created, so the worker and the service account held
// the published password at a predictable address that nothing announced. The route is checked against the
// registry's own human-role list here, and the accounts against the route in
// `login.integration.test.mjs` — one claim, asserted at both ends.
test('the accounts offered are exactly the roles a person signs in as', async () => {
  const { status, body } = await accountsResponse({ demoLogin: 'true', authPool: PRESENT, maintenancePool: PRESENT });
  assert.equal(status, 200);
  const offered = body.accounts.map((account) => account.role);
  assert.deepEqual([...offered].sort(), [...HUMAN_ROLE_NAMES].sort(), 'the demonstration must offer every human role and only those');
  // Named rather than only derived: if `MACHINE_ROLE_NAMES` were ever emptied, the assertion above would
  // still pass while these two addresses came back.
  for (const role of [...MACHINE_ROLE_NAMES, 'worker', 'service_account']) {
    assert.ok(!offered.includes(role), `a machine identity must not be offered as a sign-in choice: ${role}`);
  }
});

test('a deployment without demonstration sign-in discloses nothing at all', async () => {
  // Not `resetAvailable: false` — the route does not exist, which is what an ordinary self-hosted
  // installation is entitled to and is why the browser can treat its absence as "this is not a
  // demonstration".
  const off = await accountsResponse({ demoLogin: undefined, authPool: PRESENT, maintenancePool: PRESENT });
  assert.equal(off.status, 404);
  assert.equal(off.body.error?.code, 'RESOURCE_NOT_FOUND');
  assert.ok(!('resetAvailable' in (off.body || {})));
});
