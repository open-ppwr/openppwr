// What the workbench offers a user, and what it tells them when the deployment does not answer.
//
// Both defects covered here were invisible to every existing test, because nothing could import a
// component: the reset panel's gate was checked by reading the source, and a transport failure was only
// ever exercised against a running deployment that was, by definition, running. `jsx-loader.mjs` lets
// `node --test` import the shipped components, so these assert the rendered output and the raised error.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.mjs', import.meta.url);
const { canResetEnvironment, fetchOrNetworkError, ResetPanel } = await import('../src/App.jsx');
const { describeError, SUPPORTED_LOCALES, translate } = await import('../src/i18n.js');

const label = (key) => key;
const ADMIN = { role: 'tenant_admin', permissions: ['read', 'scan:requeue', 'gap:manage'] };
const REVIEWER = { role: 'evidence_reviewer', permissions: ['read', 'evidence:review'] };
const DEMONSTRATION = { password: 'demo', accounts: [{ role: 'tenant_admin', email: 'a@example.invalid' }], resetAvailable: true };
const render = (props) => renderToStaticMarkup(createElement(ResetPanel, { t: label, busy: false, onReset: () => {}, ...props }));

test('the reset panel is offered only where the reset can actually succeed', () => {
  // The one case the endpoint accepts: a demonstration that wired the maintenance credential, and a
  // role holding the permission `POST /v1/demo/reset` requires.
  assert.equal(canResetEnvironment({ identity: ADMIN, demo: DEMONSTRATION }), true);
  // Every other case is a guaranteed refusal, and the interface must not invite the user into it.
  assert.equal(canResetEnvironment({ identity: REVIEWER, demo: DEMONSTRATION }), false, 'six of the seven demonstration roles do not hold scan:requeue');
  assert.equal(canResetEnvironment({ identity: ADMIN, demo: null }), false, 'a self-hosted deployment has no demonstration to reset');
  assert.equal(canResetEnvironment({ identity: ADMIN, demo: { ...DEMONSTRATION, resetAvailable: false } }), false, 'demonstration sign-in without the maintenance credential still answers 404');
  assert.equal(canResetEnvironment({ identity: null, demo: DEMONSTRATION }), false, 'nobody is signed in');
  assert.equal(canResetEnvironment(), false);
});

test('a self-hosted deployment is never shown a button that deletes its data', () => {
  // The defect exactly: signed in, no demonstration anywhere on this installation, and a red destructive
  // control under a heading claiming it restores a demonstration environment.
  assert.equal(render({ identity: ADMIN, demo: null }), '', 'nothing at all is rendered on an ordinary installation');
  assert.equal(render({ identity: REVIEWER, demo: DEMONSTRATION }), '', 'nothing is rendered for a role that cannot use it');
  const offered = render({ identity: ADMIN, demo: DEMONSTRATION });
  assert.match(offered, /data-testid="reset-environment"/u, 'the administrator of a demonstration still gets it');
  assert.match(offered, /resetTitle/u);
});

test('a deployment that cannot be reached is reported as unreachable, not as a server error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  try {
    const error = await fetchOrNetworkError('/v1/session').then(() => null, (raised) => raised);
    assert.equal(error.code, 'CLIENT_NETWORK_ERROR');
    // There was no response, so there is no status and no support reference to quote. The generic
    // service message asks the user for one; that is the sentence this defect produced.
    assert.equal(error.status, null);
    assert.equal(error.correlationId, null);
    for (const locale of SUPPORTED_LOCALES) {
      assert.equal(describeError(locale, { code: error.code, status: error.status }), translate(locale, 'errNetwork'), `${locale} explains the failure as unreachable`);
      assert.notEqual(describeError(locale, { code: error.code, status: error.status }), translate(locale, 'errServer'), `${locale} does not ask for a support reference that cannot exist`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a response that arrives is passed through untouched, whatever its status', async () => {
  const original = globalThis.fetch;
  const answer = { ok: false, status: 404 };
  globalThis.fetch = () => Promise.resolve(answer);
  try {
    // Only a transport failure is a network error. A refusal is a response and keeps its own code, or
    // every 404 in the product would start claiming the deployment is down.
    assert.equal(await fetchOrNetworkError('/v1/demo/reset', { method: 'POST' }), answer);
  } finally {
    globalThis.fetch = original;
  }
});
