// SPDX-License-Identifier: Apache-2.0
// Creates or updates demonstration sign-in accounts for a tenant that already exists.
//
// Bootstrap creates these accounts, but bootstrap is a one-time operation: a deployment created
// before sign-in existed has identities and no accounts, and cannot be bootstrapped again. Without
// this command such a deployment could never offer a login at all.
//
//   OPENPPWR_DEMO_LOGIN=true OPENPPWR_DEMO_RESET_CONFIRM=yes \
//   OPENPPWR_DEMO_DATABASE_URL=postgres://... node scripts/acme/provision-demo-login.mjs
import pg from 'pg';
import { hashPassword } from '../../packages/database/src/index.mjs';
// The roles a person signs in as, read from the registry the server authorises against rather than
// restated here. This script provisioned an account for *every* identity in the tenant, which on a
// bootstrapped deployment means the worker and the service account as well — the same defect `bootstrap`
// carried, in the one command whose whole purpose is to repair a deployment that has no accounts. A second
// list would have been a second thing to keep in step; there is one list and it lives in `permissions.mjs`.
import { HUMAN_ROLE_NAMES } from '../../apps/api/src/permissions.mjs';

const { Client } = pg;
const connectionString = process.env.OPENPPWR_DEMO_DATABASE_URL || process.env.OPENPPWR_MIGRATION_DATABASE_URL;
const enabled = String(process.env.OPENPPWR_DEMO_LOGIN || '').toLowerCase() === 'true';
const confirmed = process.env.OPENPPWR_DEMO_RESET_CONFIRM === 'yes';
const password = process.env.OPENPPWR_DEMO_PASSWORD || 'demo';
const domain = process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example';
const expectedSlug = process.env.OPENPPWR_DEMO_TENANT_SLUG || 'acme-eu-demo';

const emailFor = (role) => (role === 'compliance_manager' ? `demo@${domain}` : `${role.replaceAll('_', '-')}@${domain}`);

function fail(message) {
  console.error(`DEMO_LOGIN_PROVISION_FAIL ${message}`);
  process.exitCode = 1;
  return null;
}

// Fails closed for the same reasons as the reset command: this writes credentials, so it must never
// act on a tenant it cannot positively identify as the demonstration tenant.
if (!connectionString) fail('no database URL: set OPENPPWR_DEMO_DATABASE_URL');
else if (!enabled) fail('refusing to provision: set OPENPPWR_DEMO_LOGIN=true to acknowledge that this creates accounts with a known password');
else if (!confirmed) fail('refusing to write credentials without OPENPPWR_DEMO_RESET_CONFIRM=yes');
else {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tenants = await client.query('SELECT id, slug FROM tenants ORDER BY slug');
    if (tenants.rowCount === 0) fail('no tenant exists; run the installer bootstrap first');
    else if (tenants.rowCount > 1) fail(`refusing to act: ${tenants.rowCount} tenants present, so this is not an isolated demo database`);
    else if (tenants.rows[0].slug !== expectedSlug) fail(`refusing to act: tenant slug is "${tenants.rows[0].slug}", expected "${expectedSlug}"`);
    else {
      const tenant = tenants.rows[0];
      const identities = await client.query('SELECT id, role FROM identities WHERE tenant_id = $1 ORDER BY role', [tenant.id]);
      await client.query('BEGIN');
      // Tenant context is required because demo_users enforces FORCE row level security.
      await client.query(`SELECT set_config('openppwr.tenant_id', $1, true)`, [tenant.id]);
      let created = 0;
      let skipped = 0;
      for (const identity of identities.rows) {
        // A machine identity holds a bearer credential its operator was given at bootstrap. Handing it a
        // password as well creates a sign-in nothing announces and nobody needs.
        if (!HUMAN_ROLE_NAMES.includes(identity.role)) { skipped += 1; continue; }
        const { passwordHash, passwordSalt } = hashPassword(password);
        const result = await client.query(
          `INSERT INTO demo_users (tenant_id,id,email,password_hash,password_salt,identity_id)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, $5)
           ON CONFLICT (tenant_id, email)
           DO UPDATE SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt,
                         identity_id = EXCLUDED.identity_id, active = true`,
          [tenant.id, emailFor(identity.role), passwordHash, passwordSalt, identity.id],
        );
        created += result.rowCount;
      }
      await client.query('COMMIT');
      console.log(`DEMO_LOGIN_PROVISION_PASS tenant=${tenant.slug} accounts=${created} machine_identities_skipped=${skipped} domain=${domain} sign_in_email=${emailFor('compliance_manager')} password_printed=false`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    fail(error.message);
  } finally {
    await client.end();
  }
}
