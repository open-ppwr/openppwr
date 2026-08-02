// Real-browser UI state check against an already-deployed OpenPPWR instance. These states have to be
// verified from the actual web frontend, not just by API-level assertions. Run against a live
// deployment: OPENPPWR_UI_BASE_URL=http://127.0.0.1:31114 OPENPPWR_UI_BOOTSTRAP_JSON=/opt/openppwr/state/acme-bootstrap.json node scripts/testing/ui-states-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// A crash must never be silent. The journey below runs at the top level and drives a real browser, so an
// exception — a selector that stopped matching, a deployment that stopped answering — unwinds past every
// remaining state with no summary line printed at all. Named distinctly and forced non-zero, for the same
// reason SUPPLIER_ISOLATION_SAME_TENANT_CRASH exists.
const crash = (error) => {
  console.error(`UI_STATES_CHECK_CRASH ${error?.stack || error}`);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const baseUrl = (process.env.OPENPPWR_UI_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) throw new Error('OPENPPWR_UI_BASE_URL is required.');
const bootstrapPath = process.env.OPENPPWR_UI_BOOTSTRAP_JSON;
if (!bootstrapPath) throw new Error('OPENPPWR_UI_BOOTSTRAP_JSON is required.');
const identities = JSON.parse(await readFile(bootstrapPath, 'utf8')).identities;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const label = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`${label} ${name}${detail ? ' — ' + detail : ''}`);
};

// `/\d/.test(text)` passed on any digit anywhere in the string — the label itself ("Operator credential —
// no automatic expiry") contains none, so it happened to discriminate the two cases correctly by accident,
// but it would just as happily have passed on a garbled or already-elapsed date — neither checked expiry
// text was ever confirmed to be a real, parseable, *future* timestamp. Parses the text
// after its label and requires the result to be a valid date still ahead of now.
const isParseableFutureExpiry = (text) => {
  const match = /:\s*(.+)$/u.exec(text || '');
  if (!match) return false;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) && parsed > Date.now();
};

// A bare `waitForSelector('[account-panel], [sign-in-status]')` resolves the instant *either* matches —
// including the transient "Verifying credential…" text `sign-in-status` shows while a password sign-in's
// verify-then-issue round trip is still in flight. For a token sign-in that round trip is fast enough this
// never showed; a demo password sign-in is exactly the case that made it visible. Settled means the panel
// exists, or the status text stopped saying "Verifying" (a real terminal outcome — success or error).
const waitForSignInSettled = (page) => page.waitForFunction(() => {
  if (document.querySelector('[data-testid="account-panel"]')) return true;
  const status = document.querySelector('[data-testid="sign-in-status"]');
  return status && !status.textContent.includes('Verifying');
}, { timeout: 15000 });

const signIn = async (page, token) => {
  await page.goto(`${baseUrl}/en/app`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.advanced-token summary').click();
  await page.locator('[data-testid="credential"]').fill(token);
  await page.locator('[data-testid="sign-in-action"]').click();
  await waitForSignInSettled(page);
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // 1. Universal 404 — this product's own documented property (docs-content.js: "a caller lacking a
  // permission receives 404 rather than 403, so an unauthorized caller cannot use error codes to map what
  // exists"), verified from the browser's own network stack with a real, currently-valid credential that
  // simply lacks the permission — not a generic client-side route, which this SPA deliberately serves via
  // fallback to index.html regardless of path (server.mjs) and is not what "universal 404" refers to here.
  await page.goto(`${baseUrl}/en/app`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.advanced-token summary').click();
  await page.locator('[data-testid="credential"]').fill(identities.read_only_auditor.token);
  await page.locator('[data-testid="sign-in-action"]').click();
  await page.waitForSelector('[data-testid="account-panel"]', { timeout: 15000 });
  const forbiddenStatus = await page.evaluate(async (token) => {
    const response = await fetch('/v1/gaps/00000000-0000-4000-8000-000000000000/assign', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"ownerId":"00000000-0000-4000-8000-000000000000"}',
    });
    return response.status;
  }, identities.read_only_auditor.token);
  record('universal-404-for-unauthorized-action', forbiddenStatus === 404, `status=${forbiddenStatus}`);

  // 2. Unauthenticated app access — no token stored, the credential panel is what's shown, not data.
  await page.goto(`${baseUrl}/en/app`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  const signInPanelVisible = await page.locator('[data-testid="sign-in"]').isVisible().catch(() => false);
  const accountPanelAbsent = (await page.locator('[data-testid="account-panel"]').count()) === 0;
  record('unauthenticated-shows-sign-in-not-data', signInPanelVisible && accountPanelAbsent);

  // 3. Sign-in error state — a syntactically-plausible but wrong credential.
  await signIn(page, 'opp_test_wrong_credential_0000000000000000');
  const errorStatus = await page.locator('[data-testid="sign-in-status"]').textContent().catch(() => '');
  const signInErrorShown = (await page.locator('[data-testid="account-panel"]').count()) === 0;
  record('wrong-credential-shows-error-not-signed-in', signInErrorShown, `status-text="${errorStatus}"`);

  // 4. Loading -> populated: a real session-based demo sign-in (password flow) shows an actual session
  // expiry — only reachable if this deployment has demo login enabled.
  await page.goto(`${baseUrl}/en/app`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  const demoRoleButton = page.locator('[data-testid="use-role-compliance_manager"]');
  if (await demoRoleButton.count() > 0) {
    await demoRoleButton.click();
    await page.locator('[data-testid="sign-in-password"]').click();
    await waitForSignInSettled(page);
    const accountPanelVisible = await page.locator('[data-testid="account-panel"]').isVisible().catch(() => false);
    const sessionExpiryText = await page.locator('[data-testid="session-expiry"]').textContent().catch(() => '');
    record(
      'demo-session-sign-in-reaches-account-panel-with-real-expiry',
      accountPanelVisible && isParseableFutureExpiry(sessionExpiryText),
      `expiry="${sessionExpiryText}"`,
    );
  } else {
    record('demo-session-sign-in-reaches-account-panel-with-real-expiry', null, 'demo login not enabled on this deployment');
  }

  // 4b. The bootstrap operator credential case — a fixed bearer token, not a login-issued session, but not
  // non-expiring either: migration 009 gives every identity's token a real, enforced 90-day expiry
  // (before that, a privileged credential never aged out). Before migration 032, `authenticate_openppwr_token`
  // enforced that expiry in its `WHERE` clause while returning a hardcoded `NULL` for the same column, so
  // this panel showed "no automatic expiry" for a credential that, in the database, already had one — this
  // check used to assert that misrepresentation as correct. It now asserts the honest behaviour: a real,
  // future date.
  await signIn(page, identities.compliance_manager.token);
  const operatorAccountPanelVisible = await page.locator('[data-testid="account-panel"]').isVisible().catch(() => false);
  const operatorExpiryText = await page.locator('[data-testid="session-expiry"]').textContent().catch(() => '');
  record(
    'operator-credential-shows-its-real-enforced-expiry',
    operatorAccountPanelVisible && isParseableFutureExpiry(operatorExpiryText) && !/no automatic expiry/i.test(operatorExpiryText),
    `expiry="${operatorExpiryText}"`,
  );

  // 5. Permission-denied surface: a read-only role's write controls are rendered disabled, not silently
  // hidden — the permission registry decides server-side (401/404), and the client mirrors that by
  // disabling rather than omitting, so a role's own UI never implies a capability it doesn't have.
  await signIn(page, identities.read_only_auditor.token);
  const runImportDisabled = await page.locator('[data-testid="run-import"]').isDisabled().catch(() => null);
  const uploadEvidenceDisabled = await page.locator('[data-testid="upload-evidence"]').isDisabled().catch(() => null);
  record(
    'read-only-auditor-write-controls-disabled',
    runImportDisabled === true && uploadEvidenceDisabled === true,
    `run-import-disabled=${runImportDisabled} upload-evidence-disabled=${uploadEvidenceDisabled}`,
  );

  // 6. Empty state: the catalog is gated behind an explicit `load-catalog` action (App.jsx: `catalog &&
  // <>…</>`, populated only once `loadCatalog` has run) — the pre-load state exists on *every* tenant,
  // populated or not, and is reachable right after sign-in rather than needing a never-imported-into
  // tenant. The stale reasoning this replaced ("the catalog view populates immediately on sign-in") no
  // longer matches this component and was never re-checked once the load gate was added.
  const catalogCountsBeforeLoad = await page.locator('.catalog-counts').count();
  const loadCatalogButton = page.locator('[data-testid="load-catalog"]');
  const loadButtonPresent = await loadCatalogButton.count() > 0;
  record(
    'empty-state-before-catalog-load',
    catalogCountsBeforeLoad === 0 && loadButtonPresent,
    `catalog-counts-present=${catalogCountsBeforeLoad > 0} load-button-present=${loadButtonPresent}`,
  );

  // 7. Session expiry / revoked session: the credential lives in React state after sign-in, not re-read
  // from storage per request, so corrupting storage alone does not affect an already-mounted session — a
  // reload is required to force the app to re-hydrate from the (now invalid) stored value before the next
  // authenticated action is attempted.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (/token|credential|session/i.test(key)) localStorage.setItem(key, 'opp_test_invalidated_00000000000000000000');
    }
  });
  await page.reload({ waitUntil: 'networkidle' });
  const stillShowsAccountPanel = await page.locator('[data-testid="account-panel"]').isVisible().catch(() => false);
  record(
    'invalidated-stored-credential-does-not-survive-reload',
    !stillShowsAccountPanel,
    `account-panel-visible-after-reload=${stillShowsAccountPanel}`,
  );
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null);
// A skip is not a pass: this deployment did not independently verify every state, and the summary line
// must not claim otherwise: `failed.length === 0` alone let a run with demo login disabled print PASS
// while one or two states were never actually checked, which is exactly what a 6/8 run has to be
// distinguishable from a genuine 8/8 one.
// Every state above is recorded unconditionally, so an empty `results` means the journey never reached
// them — a run that checked nothing must not be able to print a summary at all.
assert.ok(results.length > 0, 'UI_STATES_CHECK recorded no states — the journey did not run');

const status = failed.length === 0 && skipped.length === 0 ? 'PASS' : 'PARTIAL';
console.log(`\nUI_STATES_CHECK ${status} checked=${results.length} failed=${failed.length} skipped=${skipped.length}`);
if (failed.length > 0) console.log('Failed:', failed.map((r) => r.name).join(', '));
// This printed PARTIAL — or listed outright failures — and still exited 0, so nothing that ran this script
// could tell a clean run from a broken one without reading the text. The reasoning directly above already
// concluded that a skip is not a pass; the exit code now says the same thing the summary says.
if (status !== 'PASS') process.exitCode = 1;
if (skipped.length > 0) console.log('Not independently verifiable this run:', skipped.map((r) => r.name).join(', '));
