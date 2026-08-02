// SPDX-License-Identifier: Apache-2.0
// Issue a fresh worker bearer token for one synthetic tenant.
//
//   OPENPPWR_ISSUE_CONFIRM=yes node scripts/acme/issue-worker-token.mjs \
//     --slug=acme-c-fresh-demo --out=/root/.openppwr-worker-acme-c.env
//
// Why this exists: a tenant's worker identity is created with a random token whose **hash** is stored,
// and the token itself is never persisted. That is the right design — a credential nobody kept cannot
// leak from storage — and it means a worker for an additional tenant cannot be started later without
// issuing a new token.
//
// The token is written to a file with mode 0600 and is never printed, logged or passed on a command
// line. Only a short fingerprint is reported, which is enough to correlate the file with the identity
// without disclosing the credential.
//
// Fails closed: refuses without an explicit confirmation, refuses a tenant carrying no synthetic-data
// disclaimer, and refuses to overwrite an existing output file.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const argumentValue = (name) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const confirmed = process.env.OPENPPWR_ISSUE_CONFIRM === 'yes';
const connectionString = process.env.OPENPPWR_DEMO_DATABASE_URL || process.env.OPENPPWR_MIGRATION_DATABASE_URL;
const slug = argumentValue('slug');
const out = argumentValue('out');

const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function fail(message) {
  console.error(`ISSUE_WORKER_TOKEN_FAIL ${message}`);
  process.exitCode = 1;
  return null;
}

async function main() {
  if (!connectionString) return fail('no database URL: set OPENPPWR_DEMO_DATABASE_URL');
  if (!slug) return fail('--slug is required');
  if (!out) return fail('--out is required: the token is written to a file, never to stdout');
  if (!confirmed) return fail('refusing to rotate a credential without OPENPPWR_ISSUE_CONFIRM=yes');
  if (existsSync(out)) return fail(`refusing to overwrite ${out}`);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tenant = await client.query('SELECT id, slug, disclaimer FROM tenants WHERE slug=$1', [slug]);
    if (tenant.rowCount !== 1) return fail(`no single tenant with slug "${slug}"`);
    const { id, disclaimer } = tenant.rows[0];
    // Same fail-closed rule as the scoped reset: only tenants positively marked as fictional.
    if (!disclaimer || !/synthetic|fictional|fiction/iu.test(disclaimer)) {
      return fail(`refusing to act: tenant "${slug}" carries no synthetic-data disclaimer`);
    }

    const worker = await client.query(`SELECT id FROM identities WHERE tenant_id=$1 AND role='worker'`, [id]);
    if (worker.rowCount !== 1) return fail(`expected exactly one worker identity for "${slug}", found ${worker.rowCount}`);

    const token = `opp_wrk_${randomBytes(24).toString('base64url')}`;
    await client.query(`UPDATE identities SET token_hash=$1 WHERE tenant_id=$2 AND role='worker'`, [tokenHash(token), id]);

    // 0600, and the file holds only this one variable so it can be handed to a container by --env-file
    // without exposing anything else.
    writeFileSync(out, `OPENPPWR_WORKER_TOKEN=${token}\n`, { mode: 0o600 });

    // A fingerprint, not the credential: enough to tie the file to the identity, useless as a secret.
    const fingerprint = tokenHash(token).slice(0, 12);
    console.log(`ISSUE_WORKER_TOKEN_PASS slug=${slug} tenant_id=${id} identity=${worker.rows[0].id} out=${out} mode=0600 token_fingerprint=${fingerprint} token_printed=no`);
    return null;
  } catch (error) {
    return fail(error.message);
  } finally {
    await client.end();
  }
}

await main();
