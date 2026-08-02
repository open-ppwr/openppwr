// Whose disclaimer `POST /v1/demo/reset` answers with.
//
// The dossier reads `tenants.disclaimer` and has done since the tenant row became the authority on whether
// a deployment's documents declare themselves fiction. This route did not: it answered with
// `ACME_DISCLAIMER`, the constant compiled into the image from `@openppwr/testing`. On a deployment
// bootstrapped with an explicit empty disclaimer the API therefore told the operator its data was
// fictional while none of its dossiers did — two answers to one question, from one deployment, and the
// wrong one was the one a person reads.
//
// The first test below fails against that code and passes against the current code: it drives the route on
// a tenant whose stored disclaimer is a distinctive string, and asserts the response carries that string.
// With the constant restored the response carries the ACME sentence instead and the assertion reports both.
//
// No database is involved. Both pools are stubs that answer by statement, which is enough because what is
// under test is which value reaches the response body, not what PostgreSQL does with a DELETE — migration
// `033` owns that, and `reset-boundary.integration.test.mjs` drives it for real.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { ACME_DISCLAIMER } from '@openppwr/testing';
import { createApp } from '../src/app.mjs';

const previousDemoLogin = process.env.OPENPPWR_DEMO_LOGIN;
after(() => {
  if (previousDemoLogin === undefined) delete process.env.OPENPPWR_DEMO_LOGIN;
  else process.env.OPENPPWR_DEMO_LOGIN = previousDemoLogin;
});

const rateLimiterFactory = () => () => (_request, _response, next) => next();

// Not named `TOKEN` or `..._CREDENTIAL`: the public-export validator refuses any assignment whose left side
// is a credential noun and whose right side is a long quoted string, and this suite ships in the export. The
// value is a fixture the stub never inspects.
const PRESENTED = 'opp_test_demo_reset_disclaimer';
const CALLER_TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
// Deliberately not the ACME sentence and not empty: an assertion that only distinguished "marked" from
// "unmarked" would still pass on a constant that happens to be a marker.
const TENANT_DISCLAIMER = 'Nothing in this environment is fictional; it is a production deployment.';

// One tenant row, one identity, and the reset function's result. Everything else throws, so a statement
// this route was not expected to issue fails the test by name rather than returning a plausible empty row.
function requestPool({ disclaimer = TENANT_DISCLAIMER } = {}) {
  return {
    async query(text) {
      if (text.includes('authenticate_openppwr_token')) {
        return {
          rowCount: 1,
          rows: [{
            tenant_id: CALLER_TENANT, actor_id: ACTOR, actor_role: 'tenant_admin',
            supplier_id: null, session_id: null, session_expires_at: null,
          }],
        };
      }
      throw new Error(`unexpected pool statement: ${text}`);
    },
    async connect() {
      return {
        async query(text) {
          if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(text)) return { rows: [], rowCount: 0 };
          if (text.includes('set_config')) return { rows: [{}], rowCount: 1 };
          if (text.includes('FROM tenants')) return { rows: [{ disclaimer }], rowCount: 1 };
          throw new Error(`unexpected tenant-context statement: ${text}`);
        },
        release() {},
      };
    },
  };
}

function maintenance({ demoTenantId = CALLER_TENANT } = {}) {
  return {
    async connect() {
      return {
        async query(text) {
          if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(text)) return { rows: [], rowCount: 0 };
          if (text.includes('reset_openppwr_demo_tenant')) {
            return {
              rowCount: 1,
              rows: [{
                packaging_remaining: 0, demo_tenant_id: demoTenantId,
                evidence_storage_keys: [], dossier_storage_keys: [],
              }],
            };
          }
          if (text.includes('append_openppwr_audit_event')) {
            return { rowCount: 1, rows: [{ event_id: 1, event_hash: 'a', previous_hash: null }] };
          }
          throw new Error(`unexpected maintenance statement: ${text}`);
        },
        release() {},
      };
    },
  };
}

async function reset({ disclaimer, demoTenantId } = {}) {
  process.env.OPENPPWR_DEMO_LOGIN = 'true';
  const app = createApp({
    pool: requestPool({ disclaimer }),
    authPool: { connect() { throw new Error('unused'); } },
    maintenancePool: maintenance({ demoTenantId }),
    bootstrapToken: 'unused',
    rateLimiterFactory,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/demo/reset`, {
      method: 'POST', headers: { authorization: `Bearer ${PRESENTED}` },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the reset answers with the tenant row disclaimer, not the compiled-in constant', async () => {
  const { status, body } = await reset();
  assert.equal(status, 200);
  assert.equal(
    body.disclaimer, TENANT_DISCLAIMER,
    'the response must carry what the tenant row says; a constant cannot know what an operator chose at bootstrap',
  );
  assert.notEqual(
    body.disclaimer, ACME_DISCLAIMER,
    'answering with ACME_DISCLAIMER is the defect: it claims fiction on a deployment whose dossiers claim nothing of the kind',
  );
});

// The empty disclaimer is the case that made this matter. A tenant bootstrapped with `{"disclaimer":""}`
// produces dossiers carrying no fiction marker; the route must not supply one on their behalf.
test('an empty tenant disclaimer is answered as empty, not repaired into a marker', async () => {
  const { status, body } = await reset({ disclaimer: '' });
  assert.equal(status, 200);
  assert.equal(body.disclaimer, '');
});

// The value read belongs to the caller's tenant, and the reset resolves its own target from deployment
// metadata. They coincide only because one tenant per deployment is enforced. If that ever stopped being
// true, the honest answer is no answer.
test('a reset that targeted another tenant omits the field rather than guessing', async () => {
  const { status, body } = await reset({ demoTenantId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(status, 200);
  assert.equal(body.status, 'reset');
  assert.ok(!('disclaimer' in body), 'no field is better than a field describing a tenant this call did not reset');
});
