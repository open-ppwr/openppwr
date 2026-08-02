// Black-box DAST against a real, running deployment — over actual HTTP, with actual malicious-shaped
// payloads on the wire, which is what a unit or integration test cannot exercise: reverse-proxy behaviour,
// real header enforcement, and the network-facing shape of every property the source-level tests already
// assert from inside the process.
//
// A Cloudflare 302/403 in front of the target means the edge intercepted the request before the
// application ever saw it — recorded as EDGE_BLOCKED, never as a pass for the application-level checks
// that follow it, because a blocked request proves the edge, not the origin.
//
// Run against your own deployment. OPENPPWR_DAST_BASE_URL is the address the web surface answers on, and
// OPENPPWR_DAST_BOOTSTRAP_JSON is the path to the bootstrap response the installer wrote under the
// deployment's state directory — it holds live bearer credentials, so treat it as a secret:
//
//   OPENPPWR_DAST_BASE_URL=http://127.0.0.1:<port> \
//   OPENPPWR_DAST_BOOTSTRAP_JSON=<install-root>/state/acme-bootstrap.json \
//   node scripts/validation/dast-scan.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// A crash must never be silent, and it must never be mistaken for a clean scan. Every probe below runs at
// the top level, so an exception anywhere — a target that stops answering, a malformed bootstrap file —
// unwinds past every remaining check. Without this the run ends with no DAST_SCAN line at all, which reads
// as "nothing to report" rather than "nothing was tested". Named distinctly and forced non-zero, for the
// same reason SUPPLIER_ISOLATION_SAME_TENANT_CRASH exists.
const crash = (error) => {
  console.error(`DAST_SCAN_CRASH ${error?.stack || error}`);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const baseUrl = (process.env.OPENPPWR_DAST_BASE_URL || '').replace(/\/$/u, '');
if (!baseUrl) throw new Error('OPENPPWR_DAST_BASE_URL is required.');
const bootstrapPath = process.env.OPENPPWR_DAST_BOOTSTRAP_JSON;
if (!bootstrapPath) throw new Error('OPENPPWR_DAST_BOOTSTRAP_JSON is required.');
const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'));
const identities = bootstrap.identities;
const outputRoot = resolve(process.env.OPENPPWR_DAST_OUTPUT_ROOT || 'artifacts/dast');
await mkdir(outputRoot, { recursive: true });
const reportPath = resolve(outputRoot, 'dast-report.json');
// Removed before the first probe, not overwritten after the last one. `artifacts/` is not tracked, so a
// report from a previous run survives on disk indefinitely; if this run crashes before writing its own,
// whatever is left carries an older `generatedAt` and looks like the current result. Deleting it up front
// means the absence of a report is itself the signal that the run did not finish.
await rm(reportPath, { force: true });

const results = [];
const record = (category, name, ok, detail) => {
  results.push({ category, name, ok, detail });
  const label = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`${label} [${category}] ${name}${detail ? ' — ' + detail : ''}`);
};

// A Cloudflare edge answers 302 (to Access) or 403 well before the origin does. Any such response here
// means the *edge* was reached, not the application — every category below records EDGE_BLOCKED instead
// of a real result when this is detected, rather than treating an edge refusal as an application pass.
let edgeBlocked = false;
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
  if ((response.status === 302 || response.status === 403) && !options.expectRedirect) {
    const location = response.headers.get('location') || '';
    if (/cloudflareaccess\.com|cdn-cgi\/access/u.test(location) || response.headers.get('cf-ray')) {
      edgeBlocked = true;
    }
  }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { response, body, headers: response.headers };
};
const auth = (role, extra = {}) => ({ authorization: `Bearer ${identities[role].token}`, ...extra });

const recordOrEdgeBlocked = (category, name, check) => {
  if (edgeBlocked) { record(category, name, null, 'EDGE_BLOCKED — application not tested'); return; }
  check();
};

// 1. Authentication
{
  const noAuth = await request('/v1/catalog/summary');
  recordOrEdgeBlocked('authentication', 'no-credential-refused', () =>
    record('authentication', 'no-credential-refused', noAuth.response.status === 401, `status=${noAuth.response.status}`));

  const garbage = await request('/v1/catalog/summary', { headers: { authorization: 'Bearer not-a-real-token-at-all' } });
  recordOrEdgeBlocked('authentication', 'garbage-credential-refused', () =>
    record('authentication', 'garbage-credential-refused', garbage.response.status === 401, `status=${garbage.response.status}`));

  const malformedHeader = await request('/v1/catalog/summary', { headers: { authorization: identities.tenant_admin.token } });
  recordOrEdgeBlocked('authentication', 'missing-bearer-scheme-refused', () =>
    record('authentication', 'missing-bearer-scheme-refused', malformedHeader.response.status === 401, `status=${malformedHeader.response.status}`));
}

// 2. Session / token lifecycle
{
  // demoEmailFor (apps/api/src/app.mjs): compliance_manager is the one role addressed as "demo@", every
  // other role as "role-with-hyphens@" — not simply "role@", which would 401 against the real convention.
  const demoEmailDomain = process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example';
  const login = await request('/v1/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `demo@${demoEmailDomain}`, password: process.env.OPENPPWR_DEMO_PASSWORD || 'demo' }),
  });
  const loginOk = login.response.status === 200 && login.body.token;
  recordOrEdgeBlocked('session-lifecycle', 'password-login-issues-session', () =>
    record('session-lifecycle', 'password-login-issues-session', loginOk, `status=${login.response.status}`));

  if (loginOk) {
    const sessionToken = login.body.token;
    const whoAmI = await request('/v1/session', { headers: { authorization: `Bearer ${sessionToken}` } });
    recordOrEdgeBlocked('session-lifecycle', 'session-token-authenticates', () =>
      record('session-lifecycle', 'session-token-authenticates', whoAmI.response.status === 200, `status=${whoAmI.response.status}`));

    const logout = await request('/v1/logout', { method: 'POST', headers: { authorization: `Bearer ${sessionToken}` } });
    const reuse = await request('/v1/session', { headers: { authorization: `Bearer ${sessionToken}` } });
    recordOrEdgeBlocked('session-lifecycle', 'revoked-session-rejected-after-logout', () =>
      record('session-lifecycle', 'revoked-session-rejected-after-logout',
        logout.response.status === 204 && reuse.response.status === 401,
        `logout=${logout.response.status} reuse=${reuse.response.status}`));
  } else {
    record('session-lifecycle', 'session-token-authenticates', null, 'login did not succeed; dependent check skipped');
    record('session-lifecycle', 'revoked-session-rejected-after-logout', null, 'login did not succeed; dependent check skipped');
  }
}

// 3. Universal 404 — an authenticated but unauthorized caller must not be able to distinguish
// "forbidden" from "does not exist" via status code.
{
  const denied = await request(`/v1/gaps/${randomUUID()}/assign`, {
    method: 'POST', headers: auth('read_only_auditor', { 'content-type': 'application/json' }),
    body: JSON.stringify({ ownerId: randomUUID() }),
  });
  recordOrEdgeBlocked('universal-404', 'unauthorized-action-returns-404-not-403', () =>
    record('universal-404', 'unauthorized-action-returns-404-not-403', denied.response.status === 404, `status=${denied.response.status}`));
}

// 4. Authorization / permission matrix over real HTTP (read_only_auditor must not write)
{
  const write = await request('/v1/imports', {
    method: 'POST', headers: auth('read_only_auditor', { 'content-type': 'application/json', 'idempotency-key': `dast-${randomUUID()}` }),
    body: JSON.stringify({ packaging: [], materials: [], components: [], boms: [] }),
  });
  recordOrEdgeBlocked('authorization', 'read-only-role-cannot-write', () =>
    record('authorization', 'read-only-role-cannot-write', write.response.status === 404, `status=${write.response.status}`));
}

// 5. BOLA/IDOR — a supplier user reaching for another supplier's / the tenant's own admin-only resource by
// guessing or enumerating an id it was never given.
{
  const asSupplier = await request('/v1/scan-jobs', { headers: auth('supplier_user') });
  recordOrEdgeBlocked('bola-idor', 'supplier-cannot-reach-operator-only-resource', () =>
    record('bola-idor', 'supplier-cannot-reach-operator-only-resource', asSupplier.response.status === 404, `status=${asSupplier.response.status}`));

  const randomEvidence = await request(`/v1/evidence/${randomUUID()}/download`, { headers: auth('supplier_user') });
  recordOrEdgeBlocked('bola-idor', 'random-id-does-not-leak-existence', () =>
    record('bola-idor', 'random-id-does-not-leak-existence', [404].includes(randomEvidence.response.status), `status=${randomEvidence.response.status}`));
}

// 6. Tenant isolation — this deployment has exactly one tenant (single-tenant enforcement), so a
// cross-tenant read is tested by asserting a foreign tenant id embedded in a request body/header is
// ignored, not honoured — the tenant comes from the credential, never from caller-supplied input.
{
  const spoofedTenant = await request('/v1/catalog/summary', {
    headers: { ...auth('tenant_admin'), 'x-openppwr-tenant-id': randomUUID() },
  });
  recordOrEdgeBlocked('tenant-isolation', 'caller-supplied-tenant-header-ignored', () =>
    record('tenant-isolation', 'caller-supplied-tenant-header-ignored', spoofedTenant.response.status === 200, `status=${spoofedTenant.response.status}`));
}

// 7. Supplier isolation
{
  // /v1/catalog/:resource requires plain `read` (apps/api/src/app.mjs), which supplier_user does not
  // hold — it holds only the narrower `read-own` (apps/api/src/permissions.mjs). The route that actually
  // grants suppliers access checks for either permission explicitly.
  const supplierReqs = await request('/v1/evidence-requirements', { headers: auth('supplier_user') });
  const ownRowsOnly = supplierReqs.response.status === 200
    && Array.isArray(supplierReqs.body.items)
    && supplierReqs.body.items.length > 0
    && supplierReqs.body.items.every((item) => item.supplier_id === identities.supplier_user.supplierId);
  recordOrEdgeBlocked('supplier-isolation', 'supplier-sees-only-own-rows', () =>
    record('supplier-isolation', 'supplier-sees-only-own-rows', ownRowsOnly, `status=${supplierReqs.response.status} items=${supplierReqs.body.items?.length}`));
}

// 8. CSV formula injection over real HTTP (RFC4180-malformed variant)
{
  const form = new FormData();
  const reqList = await request('/v1/evidence-requirements', { headers: auth('evidence_contributor') });
  const requirement = reqList.body.items?.[0];
  if (requirement) {
    form.set('requirementId', requirement.id);
    form.set('supplierId', requirement.supplier_id);
    form.set('evidenceType', requirement.evidence_type);
    form.set('file', new Blob([Buffer.from('safe"foo,=2+2')], { type: 'text/csv' }), 'declaration.csv');
    const upload = await request('/v1/evidence', { method: 'POST', headers: auth('evidence_contributor'), body: form });
    recordOrEdgeBlocked('csv-injection', 'malformed-quoted-formula-rejected', () =>
      record('csv-injection', 'malformed-quoted-formula-rejected',
        upload.response.status === 422 && upload.body.error?.code === 'EVIDENCE_SPREADSHEET_FORMULA',
        `status=${upload.response.status} code=${upload.body.error?.code}`));
  } else {
    record('csv-injection', 'malformed-quoted-formula-rejected', null, 'no evidence requirement available to target');
  }
}

// 9. Path traversal — a storage-key-shaped id is never taken as a literal filesystem path by any route
// that accepts one as a route parameter.
{
  const traversal = await request(`/v1/evidence/${encodeURIComponent('../../../../etc/passwd')}/download`, { headers: auth('evidence_reviewer') });
  recordOrEdgeBlocked('path-traversal', 'traversal-shaped-id-rejected', () =>
    record('path-traversal', 'traversal-shaped-id-rejected', [400, 404].includes(traversal.response.status), `status=${traversal.response.status}`));
}

// 10. XSS — every API response must be application/json; a script-shaped value round-tripped through an
// error message must never come back as an executable content type.
{
  const xssPayload = '<script>alert(1)</script>';
  const probe = await request(`/v1/catalog/${encodeURIComponent(xssPayload)}`, { headers: auth('tenant_admin') });
  const contentType = probe.headers.get('content-type') || '';
  recordOrEdgeBlocked('xss', 'error-response-is-json-not-html', () =>
    record('xss', 'error-response-is-json-not-html', contentType.includes('application/json'), `content-type=${contentType} status=${probe.response.status}`));
}

// 11. SQL injection indicators — a classic payload in a route parameter must be treated as an opaque
// string (404/400), never as a database error leaking schema information.
{
  const sqli = await request(`/v1/evidence/${encodeURIComponent("' OR '1'='1")}/download`, { headers: auth('evidence_reviewer') });
  const bodyText = JSON.stringify(sqli.body).toLowerCase();
  const noLeakage = !/postgres|syntax error|relation ".*" does not exist|column ".*" does not exist/u.test(bodyText);
  recordOrEdgeBlocked('sql-injection', 'sqli-shaped-id-no-db-error-leakage', () =>
    record('sql-injection', 'sqli-shaped-id-no-db-error-leakage', [400, 404].includes(sqli.response.status) && noLeakage, `status=${sqli.response.status}`));
}

// 12. Open redirect — the marketing/host-routing redirect never sends a caller to a host it did not name
// in its own OPENPPWR_HOST_MAP; tested here only as an absence check (the isolated stack runs single-host,
// so no cross-host redirect exists to probe) — recorded as not applicable rather than forced.
record('open-redirect', 'host-map-not-configured-on-this-stack', null, 'single-host deployment; cross-host redirect logic covered by surfaces.test.mjs unit tests instead');

// 13. CORS — an unapproved Origin must never be reflected back.
{
  const cors = await request('/v1/catalog/summary', { headers: { ...auth('tenant_admin'), origin: 'https://attacker.example' } });
  const acao = cors.headers.get('access-control-allow-origin');
  recordOrEdgeBlocked('cors', 'unapproved-origin-not-reflected', () =>
    record('cors', 'unapproved-origin-not-reflected', acao !== 'https://attacker.example', `access-control-allow-origin=${acao}`));
}

// 14. Security headers
{
  // /health deliberately skips withSecurityHeaders() (apps/web/server.mjs) — monitoring-only route,
  // not representative. Every other route wraps its response in withSecurityHeaders(), so probe a
  // real page route instead.
  const headersProbe = await request('/en/app');
  const csp = headersProbe.headers.get('content-security-policy');
  const xcto = headersProbe.headers.get('x-content-type-options');
  const xfo = headersProbe.headers.get('x-frame-options');
  recordOrEdgeBlocked('headers', 'security-headers-present', () =>
    record('headers', 'security-headers-present', Boolean(csp) && xcto === 'nosniff' && Boolean(xfo),
      `csp=${Boolean(csp)} xcto=${xcto} xfo=${xfo}`));
}

// 15. TLS — not meaningful against a loopback HTTP-only origin; TLS termination happens at the edge/reverse
// proxy, which this isolated stack does not run. Deferred to a real edge/origin rehearsal.
record('tls', 'tls-configuration', null, 'not applicable — this target has no TLS termination; requires the real edge/origin');

// 16. Rate limits
{
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const attempt = await request('/v1/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@dummymail.example', password: 'wrong' }),
    });
    if (attempt.response.status === 429) { limited = true; break; }
  }
  recordOrEdgeBlocked('rate-limiting', 'login-brute-force-throttled', () =>
    record('rate-limiting', 'login-brute-force-throttled', limited, `limited=${limited}`));
}

// 17. Worker/status — /health must not leak internal paths, credentials or stack traces to an
// unauthenticated caller.
{
  const health = await request('/health');
  const bodyText = JSON.stringify(health.body);
  const noLeakage = !/\/(home|root|var\/lib|Users)\//u.test(bodyText) && !/password|token|secret/iu.test(bodyText);
  recordOrEdgeBlocked('worker-status', 'health-endpoint-does-not-leak-internals', () =>
    record('worker-status', 'health-endpoint-does-not-leak-internals', noLeakage, `body=${bodyText.slice(0, 200)}`));
}

// 18. Error leakage — an intentionally malformed request body must return a clean 4xx with no stack trace.
{
  const malformed = await request('/v1/imports', {
    method: 'POST', headers: auth('packaging_editor', { 'content-type': 'application/json', 'idempotency-key': `dast-malformed-${randomUUID()}` }),
    body: '{not valid json',
  });
  const bodyText = JSON.stringify(malformed.body);
  const noStackTrace = !/at\s+\S+\s+\(.*:\d+:\d+\)/u.test(bodyText) && !bodyText.includes('node_modules');
  recordOrEdgeBlocked('error-leakage', 'malformed-body-no-stack-trace', () =>
    record('error-leakage', 'malformed-body-no-stack-trace', noStackTrace && malformed.response.status >= 400 && malformed.response.status < 500,
      `status=${malformed.response.status}`));
}

const report = { baseUrl, edgeBlocked, results, generatedAt: new Date().toISOString() };
await writeFile(reportPath, JSON.stringify(report, null, 2));

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null);
// A scan that recorded nothing has not cleared the target, whatever the summary would otherwise say.
// Every probe above is unconditional, so an empty `results` means the run never reached them.
assert.ok(results.length > 0, 'DAST_SCAN recorded no checks — the scan did not run');

const status = edgeBlocked ? 'EDGE_BLOCKED' : failed.length === 0 ? 'PASS' : 'FAIL';
console.log(`\nDAST_SCAN ${status} checked=${results.length} failed=${failed.length} skipped=${skipped.length} report=${reportPath}`);
if (failed.length > 0) console.log('Failed:', failed.map((r) => `${r.category}/${r.name}`).join(', '));
if (skipped.length > 0) console.log('Skipped/not-applicable:', skipped.map((r) => `${r.category}/${r.name}`).join(', '));
// The exit code has to say what the summary says. This printed FAIL and exited 0: every caller — the
// shell, CI, a release checklist — saw a clean scan while the line above listed the failures. EDGE_BLOCKED
// is non-zero for the same reason the report records it separately: the edge answered, so the application
// was never tested, and an untested application must not be reported as a cleared one.
if (status !== 'PASS') process.exitCode = 1;
