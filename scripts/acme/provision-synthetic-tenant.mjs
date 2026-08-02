// SPDX-License-Identifier: Apache-2.0
// Provision an additional synthetic demonstration tenant on an existing deployment.
//
//   node scripts/acme/provision-synthetic-tenant.mjs --slug=acme-c-fresh-demo --email-suffix=-c --dry-run
//   OPENPPWR_PROVISION_CONFIRM=yes node scripts/acme/provision-synthetic-tenant.mjs --slug=... --email-suffix=-c
//
// `/v1/bootstrap` deliberately refuses to run twice — it is a one-time operation and returns
// BOOTSTRAP_ALREADY_COMPLETED once any tenant exists. That is correct for a product, and it means a
// second synthetic tenant has to be provisioned directly. This script does exactly what bootstrap does,
// for one additional tenant, and nothing more:
//
//   - one tenant row carrying a synthetic-data disclaimer;
//   - one identity per role, each with its own bearer token;
//   - one demonstration sign-in account per interactive role, with distinct e-mail addresses;
//   - the demonstration rule version the assessment engine needs.
//
// It creates no business data. The tenant starts empty on purpose, so that the deployed end-to-end run
// produces the pre-remediation figures from a genuine import rather than from a fixture.
//
// Fails closed: it refuses to touch an existing tenant, refuses to run without an explicit
// confirmation, and refuses to write a tenant that is not marked as synthetic.
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const argumentValue = (name) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const dryRun = process.argv.includes('--dry-run');
const confirmed = process.env.OPENPPWR_PROVISION_CONFIRM === 'yes';
const connectionString = process.env.OPENPPWR_DEMO_DATABASE_URL || process.env.OPENPPWR_MIGRATION_DATABASE_URL;
const slug = argumentValue('slug');
const emailSuffix = argumentValue('email-suffix') || '';
const emailDomain = process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example';
const demoPassword = process.env.OPENPPWR_DEMO_PASSWORD;

const DISCLAIMER = 'Synthetic tenant. All companies, products, materials, suppliers and documents are fictional.';
const ROLES = ['tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor',
  'evidence_reviewer', 'read_only_auditor', 'supplier_user', 'service_account', 'worker'];
// Machine identities hold no interactive sign-in, exactly as bootstrap does it.
const INTERACTIVE = new Set(['tenant_admin', 'compliance_manager', 'packaging_editor',
  'evidence_contributor', 'evidence_reviewer', 'read_only_auditor', 'supplier_user']);

// Same derivation as packages/database: sha256 for bearer tokens, scrypt for passwords. Reimplemented
// here rather than imported, because this script runs on a deployment host that has no repository.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  return { passwordHash: scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex'), passwordSalt: salt };
};
const emailFor = (role) => `${role === 'compliance_manager' ? 'demo' : role.replaceAll('_', '-')}${emailSuffix}@${emailDomain}`;

function fail(message) {
  console.error(`PROVISION_FAIL ${message}`);
  process.exitCode = 1;
  return null;
}

async function main() {
  if (!connectionString) return fail('no database URL: set OPENPPWR_DEMO_DATABASE_URL');
  if (!slug) return fail('--slug is required');
  if (!/^[a-z0-9-]{3,60}$/u.test(slug)) return fail(`slug "${slug}" must be lowercase letters, digits and hyphens`);
  if (!demoPassword) return fail('OPENPPWR_DEMO_PASSWORD is required to create demonstration sign-in accounts');
  if (!dryRun && !confirmed) return fail('refusing to write without OPENPPWR_PROVISION_CONFIRM=yes');
  // A second tenant whose accounts collide with the first is worse than no second tenant:
  // lookup_openppwr_demo_user returns a single row, so a duplicate address breaks sign-in for both.
  if (!emailSuffix) return fail('--email-suffix is required: demonstration addresses must be unique across tenants');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const existing = await client.query('SELECT id FROM tenants WHERE slug=$1', [slug]);
    if (existing.rowCount) return fail(`tenant "${slug}" already exists; this script never modifies an existing tenant`);

    const addresses = [...INTERACTIVE].map(emailFor);
    const collision = await client.query('SELECT email FROM demo_users WHERE email = ANY($1::text[])', [addresses]);
    if (collision.rowCount) return fail(`demonstration addresses already in use: ${collision.rows.map((row) => row.email).join(', ')}`);

    const tenantId = randomUUID();
    const users = ROLES.map((role) => ({
      id: randomUUID(),
      role,
      supplierId: role === 'supplier_user' ? 'ACME-SUP-001' : null,
      token: `opp_live_${randomBytes(24).toString('base64url')}`,
    }));

    if (dryRun) {
      console.log(`PROVISION_DRY_RUN slug=${slug} identities=${users.length} demo_accounts=${addresses.length} addresses=${addresses.join(',')} creates_business_data=no`);
      return null;
    }

    await client.query('BEGIN');
    await client.query('INSERT INTO tenants (id,slug,name,disclaimer) VALUES ($1,$2,$3,$4)',
      [tenantId, slug, 'ACME-C Fresh Demonstration GmbH (fictional)', DISCLAIMER]);
    // FORCE ROW LEVEL SECURITY applies to the table owner too, so the tenant context has to be set
    // before any tenant-scoped insert. Bootstrap does the same thing for the same reason.
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true), set_config('openppwr.actor_id', $2, true)`,
      [tenantId, users[0].id]);
    for (const user of users) {
      await client.query(
        `INSERT INTO identities (tenant_id,id,display_name,role,supplier_id,token_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, user.id, `ACME-C ${user.role.replaceAll('_', ' ')}`, user.role, user.supplierId, tokenHash(user.token)],
      );
      if (!INTERACTIVE.has(user.role)) continue;
      const { passwordHash, passwordSalt } = hashPassword(demoPassword);
      await client.query(
        `INSERT INTO demo_users (tenant_id,id,email,password_hash,password_salt,identity_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, randomUUID(), emailFor(user.role), passwordHash, passwordSalt, user.id],
      );
    }
    // The demonstration rule, identical to the one bootstrap installs. Without it the assessment engine
    // has nothing to evaluate and the run would report zero outcomes rather than the published figures.
    await client.query(
      `INSERT INTO rule_versions (tenant_id,rule_id,version,source_reference,publication_date,effective_from,lifecycle_status,reviewer_status,required_inputs,required_evidence,applicability,checks,explanation_keys)
       VALUES ($1,'OPENPPWR-DEMO-RC','1.0.0','Regulation (EU) 2025/40 demonstration subset; non-authoritative','2025-02-28','2025-01-01','draft','requires_human_regulatory_review',$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)`,
      [tenantId, JSON.stringify(['recycledContentPct']), JSON.stringify(['RECYCLED_CONTENT_DECLARATION']),
        JSON.stringify({ countries: [], packagingTypes: ['sales', 'grouped', 'reusable'] }),
        JSON.stringify([{ id: 'minimum-recycled-content', input: 'recycledContentPct', operator: 'gte', value: 30, explanationKey: 'assessment.recycled_content.minimum' }]),
        JSON.stringify(['assessment.recycled_content.minimum'])],
    );
    await client.query('COMMIT');

    // Verify what was created, and that the tenant really is isolated by the database rather than by
    // this script having been careful.
    const identities = await client.query('SELECT count(*)::int AS total FROM identities WHERE tenant_id=$1', [tenantId]);
    const accounts = await client.query('SELECT count(*)::int AS total FROM demo_users WHERE tenant_id=$1', [tenantId]);
    const business = await client.query('SELECT count(*)::int AS total FROM packaging WHERE tenant_id=$1', [tenantId]);
    const rls = await client.query(
      `SELECT count(*)::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
         AND c.relname IN ('packaging','evidence_files','assessments','gaps','review_snapshots','dossier_artifacts','audit_events','demo_users','identities')`,
    );
    if (identities.rows[0].total !== ROLES.length) return fail(`expected ${ROLES.length} identities, found ${identities.rows[0].total}`);
    if (accounts.rows[0].total !== INTERACTIVE.size) return fail(`expected ${INTERACTIVE.size} demonstration accounts, found ${accounts.rows[0].total}`);
    if (business.rows[0].total !== 0) return fail('a freshly provisioned tenant must hold no business data');

    console.log(`PROVISION_PASS slug=${slug} tenant_id=${tenantId} identities=${identities.rows[0].total} demo_accounts=${accounts.rows[0].total} business_rows=0 rls_forced_tables=${rls.rows[0].total} disclaimer=present`);
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(error.message);
  } finally {
    await client.end();
  }
}

await main();
