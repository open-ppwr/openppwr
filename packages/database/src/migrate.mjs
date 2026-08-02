import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// The one deadline in this package that has a default, and it bounds a handshake rather than any work.
//
// On a raw `Client` — which is what this file and `prepare.mjs` use — `connectionTimeoutMillis` covers
// only establishing the connection: socket, TLS and authentication. There is no pool and therefore no
// checkout queue, so the objection that sank a blanket value on the request pool does not apply here: no
// caller can be made to fail by waiting behind another, because there is exactly one caller.
//
// Measured on the embedded cluster this repository tests against, establishment takes 28–38 ms, dominated
// by SCRAM. `deploy/community/docker-compose.yml` starts this container only after the database reports
// healthy, and the test harness in `scripts/testing/embedded-postgres.mjs` has used 10 000 ms for the same
// parameter since it was written. Thirty seconds is therefore roughly a thousand times the observed cost
// and three times the value this repository already relies on elsewhere.
//
// What it prevents is specific and has no other guard: a database that accepts the TCP connection and then
// never completes authentication leaves the installer's migration step waiting forever, with no output and
// no failure. `OPENPPWR_DB_CONNECT_TIMEOUT_MS` overrides it for a deployment where that is wrong.
//
// Deliberately no `statement_timeout` here. A migration may legitimately hold a lock or build an index for
// a long time on a large database, and a migration cancelled halfway is the failure this bound would cause
// rather than prevent — each migration runs in its own transaction and would roll back, leaving an upgrade
// that reports failure it could have completed.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export function migrationConnectTimeoutMs(environment = process.env) {
  const raw = environment.OPENPPWR_DB_CONNECT_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_CONNECT_TIMEOUT_MS;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value <= 0) throw new Error(`OPENPPWR_DB_CONNECT_TIMEOUT_MS must be a positive whole number of milliseconds; received ${JSON.stringify(raw)}.`);
  return value;
}

export async function migrate(connectionString = process.env.OPENPPWR_MIGRATION_DATABASE_URL) {
  if (!connectionString) throw new Error('OPENPPWR_MIGRATION_DATABASE_URL is required.');
  const client = new Client({ connectionString, connectionTimeoutMillis: migrationConnectTimeoutMs() });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS openppwr_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const applied = await client.query('SELECT 1 FROM openppwr_schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO openppwr_schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw Object.assign(error, { migration: name });
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().then(() => console.log('OpenPPWR migrations applied.')).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

