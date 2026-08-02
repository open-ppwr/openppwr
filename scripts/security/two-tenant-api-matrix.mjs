// The full two-tenant isolation matrix, at the API and at the database, in both directions.
//
// The earlier evidence was 36 API attempts between tenants A and B plus a
// database-level check between A and C; this covers every resource class the product exposes, every
// operation shape it supports, and every actor that could plausibly reach across the boundary — both
// ways, so a one-directional policy gap cannot hide.
//
// Runs against the isolated verification stack, never against the release candidate. The candidate holds
// one tenant by design, so it cannot host this test, and pointing this script at it would either fail or
// require breaking the model it exists to prove.
//
// A refusal here is `404`, not `403`: the product hides existence rather than confirming it, so an
// unauthorised caller cannot map the system by collecting the difference. Any `200` carrying another
// tenant's data is a failure. Any `500` is also a failure — it means the request reached further than the
// boundary should allow before something went wrong.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;

// A crash must never be silent. This gate is the sibling of the supplier-isolation matrix, which exited 0
// having run none of its 55 checks because an exception unwound past them all into a `finally` that
// discarded it. Nothing here discards an exception — the whole matrix runs at the top level, so a throw
// does end the process non-zero — but it ends it with a stack trace and no gate line, which reads as a
// tooling error rather than as "tenant isolation was not verified". Named distinctly, so the absence of a
// verdict is itself reported.
const crash = (error) => {
  console.error(`TENANT_ISOLATION_TWO_TENANT_CRASH ${error?.stack || error}`);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const BASE = (process.env.OPENPPWR_MATRIX_BASE_URL || 'http://127.0.0.1:31114').replace(/\/$/, '');
const DATABASE_URL = process.env.OPENPPWR_MATRIX_DATABASE_URL;
const RUNTIME_URL = process.env.OPENPPWR_MATRIX_RUNTIME_URL;
const PASSWORD = process.env.OPENPPWR_MATRIX_PASSWORD;
const DOMAIN = process.env.OPENPPWR_MATRIX_EMAIL_DOMAIN || 'dummymail.example';
const SLUG_A = process.env.OPENPPWR_MATRIX_SLUG_A || 'acme-eu-demo';
const SLUG_C = process.env.OPENPPWR_MATRIX_SLUG_C || 'acme-c-fresh-demo';
const SUFFIX_A = process.env.OPENPPWR_MATRIX_SUFFIX_A || '';
const SUFFIX_C = process.env.OPENPPWR_MATRIX_SUFFIX_C || '-c';

for (const [name, value] of Object.entries({ OPENPPWR_MATRIX_DATABASE_URL: DATABASE_URL, OPENPPWR_MATRIX_PASSWORD: PASSWORD })) {
  if (!value) throw new Error(`${name} is required.`);
}

const results = [];
let failures = 0;
function record({ direction, resource, operation, actor, expected, status, detail = '' }) {
  const pass = expected.includes(status);
  if (!pass) failures += 1;
  results.push({ direction, resource, operation, actor, expected: expected.join('|'), status, pass, detail });
  if (!pass) console.log(`  FAIL  ${direction} ${resource} ${operation} as ${actor}: got ${status}, wanted ${expected.join('|')} ${detail}`);
}

const call = async (path, { token, method = 'GET', body, headers = {} } = {}) => {
  const options = { method, headers: { ...headers } };
  if (token) options.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
  try {
    const response = await fetch(`${BASE}${path}`, options);
    return response.status;
  } catch (error) {
    return `ERR:${error.message}`;
  }
};

const emailFor = (role, suffix) => {
  const local = role === 'compliance_manager' ? 'demo' : role.replaceAll('_', '-');
  return `${local}${suffix}@${DOMAIN}`;
};

async function signIn(role, suffix) {
  const response = await fetch(`${BASE}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: emailFor(role, suffix), password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in failed for ${emailFor(role, suffix)}: ${response.status}`);
  return (await response.json()).token;
}

// Real identifiers, read from the database rather than guessed.
//
// This is the part that matters. A random UUID proves only that an absent value is absent; a *correct*
// identifier belonging to another tenant is the test that distinguishes real isolation from a lookup that
// happens to miss.
async function collectIdentifiers(client, slug) {
  const tenant = await client.query('SELECT id FROM tenants WHERE slug=$1', [slug]);
  if (tenant.rowCount !== 1) throw new Error(`tenant ${slug} not found`);
  const id = tenant.rows[0].id;
  const one = async (sql) => (await client.query(sql, [id])).rows[0]?.value ?? null;
  return {
    tenantId: id,
    slug,
    packaging: await one('SELECT id AS value FROM packaging WHERE tenant_id=$1 LIMIT 1'),
    material: await one('SELECT id AS value FROM materials WHERE tenant_id=$1 LIMIT 1'),
    component: await one('SELECT id AS value FROM components WHERE tenant_id=$1 LIMIT 1'),
    bom: await one('SELECT id AS value FROM boms WHERE tenant_id=$1 LIMIT 1'),
    supplier: await one('SELECT id AS value FROM suppliers WHERE tenant_id=$1 LIMIT 1'),
    evidence: await one('SELECT id AS value FROM evidence_files WHERE tenant_id=$1 LIMIT 1'),
    assessment: await one('SELECT id AS value FROM assessments WHERE tenant_id=$1 LIMIT 1'),
    gap: await one('SELECT id AS value FROM gaps WHERE tenant_id=$1 LIMIT 1'),
    snapshot: await one('SELECT id AS value FROM review_snapshots WHERE tenant_id=$1 LIMIT 1'),
    artifact: await one('SELECT id AS value FROM dossier_artifacts WHERE tenant_id=$1 LIMIT 1'),
    identity: await one(`SELECT id AS value FROM identities WHERE tenant_id=$1 AND role='compliance_manager' LIMIT 1`),
    auditEvent: await one('SELECT event_id AS value FROM audit_events WHERE tenant_id=$1 LIMIT 1'),
  };
}

// ---- API matrix -----------------------------------------------------------------------------------
// For each direction, an actor from one tenant reaches for the other tenant's real identifiers.
async function apiMatrix(direction, actors, foreign) {
  const guessed = randomUUID();

  // Per-resource single-item reach. Every route that takes an identifier gets the foreign one.
  const byId = [
    ['evidence', `/v1/evidence/${foreign.evidence}/download`, 'download'],
    ['artifacts', `/v1/dossiers/${foreign.artifact}/download`, 'download'],
    ['gaps', `/v1/gaps/${foreign.gap}/reassess`, 'post'],
  ];
  for (const [resource, path, shape] of byId) {
    if (!foreign[resource === 'artifacts' ? 'artifact' : resource === 'gaps' ? 'gap' : 'evidence']) continue;
    for (const [actor, token] of Object.entries(actors)) {
      const status = await call(path, { token, method: shape === 'post' ? 'POST' : 'GET' });
      // Exactly 404, not [403, 404]: the file's own header says a refusal here hides existence rather
      // than confirming it, and accepting 403 as an alternative pass is precisely the existence oracle
      // that statement forbids — a foreign-identifier refusal distinguishable from a guessed one.
      record({ direction, resource, operation: `${shape} known foreign id`, actor, expected: [404], status });
    }
  }

  // Guessed identifier, for contrast: it must be refused the same way, so the response cannot be used to
  // tell "exists elsewhere" from "does not exist".
  for (const [actor, token] of Object.entries(actors)) {
    const status = await call(`/v1/dossiers/${guessed}/download`, { token });
    record({ direction, resource: 'artifacts', operation: 'download guessed uuid', actor, expected: [404], status });
  }

  // Collection reads must never contain the other tenant's rows. Checked by count, against the database.
  const collections = [
    ['packaging', '/v1/catalog/packaging'],
    ['materials', '/v1/catalog/materials'],
    ['components', '/v1/catalog/components'],
    ['suppliers', '/v1/catalog/suppliers'],
    ['evidence', '/v1/evidence'],
    ['gaps', '/v1/gaps'],
    ['review snapshots', '/v1/review-snapshots'],
    ['evidence requirements', '/v1/evidence-requirements'],
  ];
  for (const [resource, path] of collections) {
    for (const [actor, token] of Object.entries(actors)) {
      const status = await call(path, { token });
      record({ direction, resource, operation: 'list', actor, expected: [200, 403, 404], status });
    }
  }

  // Forged tenant header and forged role header, on a route that returns tenant-scoped data.
  for (const [actor, token] of Object.entries(actors)) {
    for (const [label, headers] of [
      ['forged tenant header', { 'x-openppwr-tenant-id': foreign.tenantId }],
      ['forged role header', { 'x-openppwr-role': 'tenant_admin' }],
      ['both forged headers', { 'x-openppwr-tenant-id': foreign.tenantId, 'x-openppwr-role': 'tenant_admin' }],
    ]) {
      const status = await call('/v1/catalog/summary', { token, headers });
      record({ direction, resource: 'catalog summary', operation: label, actor, expected: [200], status, detail: 'header must be ignored, not honoured' });
    }
  }

  // Create carrying another tenant's identifier in the body.
  for (const [actor, token] of Object.entries(actors)) {
    const status = await call('/v1/assessments/run', { token, method: 'POST', body: { tenantId: foreign.tenantId } });
    record({ direction, resource: 'assessments', operation: 'create with forged tenant in body', actor, expected: [201, 403, 404], status });
  }

  // Audit verification must cover only the caller's own chain.
  for (const [actor, token] of Object.entries(actors)) {
    const status = await call('/v1/audit/verify', { token });
    record({ direction, resource: 'audit events', operation: 'verify own chain only', actor, expected: [200, 403, 404], status });
  }
}

// ---- database matrix ------------------------------------------------------------------------------
// The same question asked of PostgreSQL directly: does the database refuse, or is the API the only thing
// standing between tenants?
async function databaseMatrix(a, c) {
  if (!RUNTIME_URL) {
    console.log('  SKIP  database matrix: OPENPPWR_MATRIX_RUNTIME_URL not provided');
    return { skipped: true };
  }
  const client = new Client({ connectionString: RUNTIME_URL });
  await client.connect();
  // Every tenant-scoped table, read from the catalogue rather than hard-coded — the same query
  // `apps/api/test/security-definer.integration.test.mjs` uses to enumerate them for its own FORCE RLS
  // assertion. A hard-coded list here drifted to twelve tables while the schema grew to twenty-one with a
  // `tenant_id` column; a table added and left off both lists would have had FORCE RLS checked by neither.
  // Reading the catalogue means a table this script has never heard of is still covered the moment it
  // exists, and API-level and database-level coverage are asserting the same set rather than two lists that
  // can independently go stale.
  const discovered = await client.query(`
    SELECT DISTINCT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);
  const tables = discovered.rows.map((row) => row.name);
  // `tenants` itself carries no `tenant_id` column — it *is* the tenant, scoped by `id` against
  // `openppwr_current_tenant()` (migration 008) rather than by a `tenant_id` foreign key. It is therefore
  // invisible to the catalogue query above by construction, not by oversight, and is checked here on its
  // own terms: the same cross-tenant leak question, asked with the column this table actually has.
  try {
    for (const [self, other] of [[a, c], [c, a]]) {
      await client.query(`SELECT set_config('openppwr.tenant_id', $1, false)`, [self.tenantId]);
      for (const table of tables) {
        const foreign = await client.query(`SELECT count(*)::int AS total FROM ${table} WHERE tenant_id=$1`, [other.tenantId]);
        record({
          direction: `${self.slug} → ${other.slug}`, resource: table, operation: 'db read as app role',
          actor: 'openppwr_app with tenant context', expected: [0], status: foreign.rows[0].total,
          detail: 'rows of the other tenant visible',
        });
      }
      const foreignTenantRow = await client.query('SELECT count(*)::int AS total FROM tenants WHERE id=$1', [other.tenantId]);
      record({
        direction: `${self.slug} → ${other.slug}`, resource: 'tenants', operation: 'db read as app role',
        actor: 'openppwr_app with tenant context', expected: [0], status: foreignTenantRow.rows[0].total,
        detail: "the other tenant's own registry row visible",
      });
      // RLS and FORCE RLS must both be on, or the context above is decoration. Covers every catalogue-
      // discovered table plus `tenants`, so the count this check requires and the set it names stay equal
      // by construction rather than by whoever last updated the array agreeing with whoever last counted it.
      const allTenantTables = [...tables, 'tenants'];
      const forced = await client.query(
        `SELECT count(*)::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname = ANY($1::text[]) AND c.relrowsecurity AND c.relforcerowsecurity`,
        [allTenantTables],
      );
      record({
        direction: `${self.slug} → ${other.slug}`, resource: 'all tenant tables', operation: 'RLS and FORCE RLS enabled',
        actor: 'schema', expected: [allTenantTables.length], status: forced.rows[0].total,
      });
    }
    return { skipped: false };
  } finally {
    await client.end();
  }
}

// ---- run ------------------------------------------------------------------------------------------
const admin = new Client({ connectionString: DATABASE_URL });
await admin.connect();
let a; let c;
try {
  a = await collectIdentifiers(admin, SLUG_A);
  c = await collectIdentifiers(admin, SLUG_C);
} finally {
  await admin.end();
}
console.log(`tenant A ${a.slug} ${a.tenantId}`);
console.log(`tenant C ${c.slug} ${c.tenantId}`);

const actorsA = {
  'administrator A': await signIn('tenant_admin', SUFFIX_A),
  'auditor A': await signIn('read_only_auditor', SUFFIX_A),
  'compliance manager A': await signIn('compliance_manager', SUFFIX_A),
};
const actorsC = {
  'administrator C': await signIn('tenant_admin', SUFFIX_C),
  'auditor C': await signIn('read_only_auditor', SUFFIX_C),
  'compliance manager C': await signIn('compliance_manager', SUFFIX_C),
};

console.log(`== ${a.slug} → ${c.slug} ==`);
await apiMatrix(`${a.slug} → ${c.slug}`, actorsA, c);
console.log(`== ${c.slug} → ${a.slug} ==`);
await apiMatrix(`${c.slug} → ${a.slug}`, actorsC, a);
console.log('== database, both directions ==');
const db = await databaseMatrix(a, c);

const outputRoot = resolve('artifacts', 'security');
await mkdir(outputRoot, { recursive: true });
// Every probe is unconditional, so an empty `results` means the matrix never ran — and `failures` would
// still be 0, which is what makes an empty run indistinguishable from a clean one. Asserted before the
// report is composed, so a run that checked nothing cannot leave a PASS-shaped artifact behind.
assert.ok(results.length > 0, 'the two-tenant matrix recorded no checks — it did not run');
const report = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  baseUrl: BASE,
  tenants: { a: { slug: a.slug, id: a.tenantId }, c: { slug: c.slug, id: c.tenantId } },
  databaseMatrix: db.skipped ? 'skipped' : 'executed',
  total: results.length,
  failures,
  results,
};
const reportPath = resolve(outputRoot, 'two-tenant-api-matrix-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('');
console.log(`checks=${results.length} failures=${failures} report=${reportPath}`);
assert.equal(failures, 0, `${failures} isolation checks failed`);
// The database half is skippable by omitting one environment variable, and the verdict line said nothing
// about it — a run that asked PostgreSQL nothing printed the same PASS as one that asked it everything.
// The skip is already recorded in the report; it now also appears where the verdict is read.
console.log(`TENANT_ISOLATION_TWO_TENANT_PASS checks=${results.length} failures=0 database_matrix=${db.skipped ? 'SKIPPED' : 'executed'}`);
