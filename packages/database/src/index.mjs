import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
export { migrate } from './migrate.mjs';
export { prepareRuntime } from './prepare.mjs';

const { Pool } = pg;

// Query and pool-checkout deadlines: the mechanism ships, and now two of the three numbers do too.
//
// Deadlines were added here once and reverted the same session, for three reasons. All three have now been
// measured against a tenant of representative size rather than the 32-record ACME fixture —
// `scripts/testing/synthetic-scale-tenant.mjs` builds 3 000 packaging records, 60 suppliers, 60 materials,
// 400 components and 4 200 BOM lines through real writes (import, assessment, gap remediation, six
// reassessment rounds), which is also how its audit history reached 18 338 events rather than being seeded
// as a row count. `scripts/testing/deadline-scale-measurement.mjs` is the harness that measured it. Nothing
// in this repository's published product material states a packaging-record count for a real deployment,
// so 3 000 was chosen as the middle of a stated representative range of 2 000–5 000, not extrapolated from
// the fixture.
//
//   1. `connectionTimeoutMillis` in `pg-pool` bounds *pool checkout*, not only the TCP handshake. With
//      `max: 10`, the eleventh concurrent caller fails after the deadline instead of queuing. The 250 ms
//      one-shot measurement is now a curve: at concurrency 10 (exactly filling the pool) the checkout p95
//      was 205 ms; at 20 (double the pool) 356 ms; at 50, 1 125 ms — and a real `freezeReviewSnapshot` or
//      `generateDossier` holds its connection for the whole operation, 0.4–3.2 s at this tenant's size and
//      up to roughly 10 s at 50 000 audit events by the curve below. So a checkout timeout sized to catch a
//      truly stuck connection would fail an ordinary caller queued behind a handful of concurrent extended
//      operations, and one sized to tolerate that queuing would not catch a stuck connection in any useful
//      time. This is a property of a deployment's own concurrency, not of data, so no measurement taken here
//      can size it correctly for a given deployment — but on 2026-08-01 the owner decided a conservative
//      shipped default was still better than none, on the reasoning that a caller failing outright with no
//      timeout set at all is not a real alternative operators were choosing; see the reasoning next to
//      `OPENPPWR_DB_CHECKOUT_TIMEOUT_MS` in `deploy/community/docker-compose.yml` and
//      `deploy/community/openppwr.env.example` for the number and its explicit "tune this for your own load"
//      operator note. `checkoutMs` itself carries no hardcoded default — see `extendedStatementMs` below for
//      why that is the compose file's job, not this function's.
//   2. A blanket `statement_timeout` bounds one statement, not an operation, and the two extended-class
//      operations that walk the whole tenant are dominated by many cheap statements rather than one slow
//      one: `freezeReviewSnapshot` issued 18 354 statements at 18 338 events, 92% of its 3.16 s wall time in
//      the per-event audit-hash recompute (median 0.124 ms, max 3.2 ms per call) — so the operation is slow
//      because it makes 18 000 round trips, not because any one of them is close to slow. The statements
//      that are *not* per-event — the whole-snapshot `review_snapshots` insert, the snapshot read back for
//      `generateDossier`, the initial audit-event fetch — are the ones a statement timeout can actually
//      bound, and they topped out at 134 ms and 110 ms across two full runs at this tenant's size. That is
//      real, controlled evidence for the extended class, and `extendedStatementMs` now ships a default
//      derived from it. The interactive class has no equivalent measurement: this harness measured the
//      three named extended operations, not the ordinary CRUD routes the interactive class is meant to
//      bound. Two things found along the way would have made guessing one worse than merely unmeasured —
//      `GET /v1/assessments` and `GET /v1/gaps` returned every row with no `LIMIT`, and `runAssessments`
//      (and therefore `POST /v1/gaps/:id/reassess`) looped the whole packaging catalogue inside one
//      `interactive`-class transaction despite being exactly the "walks a whole tenant" shape this file
//      split extended out for. Both are fixed as of 2026-08-01 — the two routes now paginate (see
//      `parsePagination` in `apps/api/src/app.mjs`) and `runAssessments` now declares `{ deadline:
//      'extended' }` — but fixing them does not manufacture the measurement `interactiveStatementMs` still
//      lacks: no ordinary single-row read or write in this codebase has been timed the way the three
//      extended operations were, so a number sized for one would still be a guess. It stays unset.
//   3. The environment overrides that were meant to make this tunable were never passed through
//      `deploy/community/docker-compose.yml`. That one was fixed separately: every variable below is
//      declared for the `api` and `worker` services, so an operator who has measured their own deployment —
//      or is applying the one default this file now ships — can do so without editing a shipped file.
//
// The audit-chain scaling curve (one incrementally-grown chain, five settled trials per checkpoint rather
// than one run per size) is cleaner than the figure this comment previously carried, and still worth
// stating honestly: medians scale near-linearly, roughly 0.18–0.20 ms per event (190 ms at 1 000 events,
// 878 ms at 5 000, 1 767 ms at 10 000, 3 570 ms at 20 000, 7 589 ms at 40 000, 9 923 ms at 50 000), but the
// spread across five trials at one checkpoint stayed 49–84% of the median through every size except the
// last. Repeating the trial and holding the chain fixed ruled out different data as the cause; what is left
// is host and scheduling noise this harness cannot separate further on one machine, and it is why this
// curve informs the extended-statement default only through the per-event statement cost it measured
// directly (0.124 ms median, single-digit-millisecond max even at 50 000 events) rather than through the
// noisy whole-operation wall time, which is exactly what an operation-level timeout — not a per-statement
// one — would need, and is not what `statement_timeout` provides.
const DEADLINE_VARIABLES = Object.freeze({
  // Pool checkout. See (1): bounds acquisition, not work. No hardcoded default here, on the same principle
  // as `extendedStatementMs` below — but unlike `interactiveStatementMs`, this one does have a shipped
  // default, applied in `deploy/community/docker-compose.yml`. See (1) above for why a conservative default
  // was chosen anyway despite no deployment-specific measurement being possible from here.
  checkoutMs: 'OPENPPWR_DB_CHECKOUT_TIMEOUT_MS',
  // The default class: an authenticated read or a single-row write serving one request. Still no default —
  // see (2) above, including the two routes and the one operation that do not actually fit that
  // description today.
  interactiveStatementMs: 'OPENPPWR_DB_INTERACTIVE_STATEMENT_TIMEOUT_MS',
  // Freezing a review, generating a dossier, verifying an audit chain — the operations that walk a whole
  // tenant. Separated from the class above because one number across both is the shape that was rejected.
  // The one class with a shipped default, applied in `deploy/community/docker-compose.yml`, not here: this
  // function treats absence uniformly, and the compose file is where a deployment-specific default belongs.
  extendedStatementMs: 'OPENPPWR_DB_EXTENDED_STATEMENT_TIMEOUT_MS',
});

// Absent means unbounded. Present and not a positive whole number of milliseconds is refused rather than
// ignored: a deadline silently discarded because it was written `30s` is worse than no deadline, because
// the operator believes they have one.
export function databaseDeadlines(environment = process.env) {
  const resolved = {};
  for (const [field, variable] of Object.entries(DEADLINE_VARIABLES)) {
    const raw = environment[variable];
    if (raw === undefined || raw === null || String(raw).trim() === '') { resolved[field] = null; continue; }
    const value = Number(String(raw).trim());
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${variable} must be a positive whole number of milliseconds; received ${JSON.stringify(raw)}.`);
    resolved[field] = value;
  }
  return Object.freeze(resolved);
}

export function createPool(connectionString = process.env.OPENPPWR_DATABASE_URL, environment = process.env) {
  if (!connectionString) throw new Error('OPENPPWR_DATABASE_URL is required.');
  const deadlines = databaseDeadlines(environment);
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Omitted entirely when unset. `pg-pool` treats `0` as "no timeout" and `undefined` as its own default,
    // so the property is added only when there is a value to add.
    ...(deadlines.checkoutMs ? { connectionTimeoutMillis: deadlines.checkoutMs } : {}),
  });
}

// The migration level the database actually carries, as opposed to the one the image was built claiming.
//
// `migrate.mjs` selects its files with `/^\d+.*\.sql$/` and applies them in `sort()` order, so the highest
// name is the highest applied migration and the leading digits are its level. This reads the same table by
// the same ordering, which is what makes the two impossible to disagree by construction rather than by
// convention.
//
// Returns null rather than throwing when the table is empty — a database that has never been migrated has
// no applied level, and that is an answer, not an error. A caller that cannot reach the database at all
// gets the rejection, because "unreachable" and "not migrated" are different facts and reporting them as
// the same one is how the defect this closes was introduced.
export async function appliedMigrationLevel(pool) {
  const result = await pool.query('SELECT name FROM openppwr_schema_migrations ORDER BY name DESC LIMIT 1');
  const name = result.rows[0]?.name;
  const level = typeof name === 'string' ? /^(\d+)/u.exec(name) : null;
  return level ? level[1] : null;
}

export function tokenHash(token) {
  if (!token || typeof token !== 'string') throw new TypeError('Bearer token is required.');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function authenticateToken(pool, token) {
  const result = await pool.query('SELECT * FROM authenticate_openppwr_token($1)', [tokenHash(token)]);
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  return {
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    // The digest of the credential that proved this identity. It travels with the context so that an audit
    // event can be attributed to an actor the database verifies rather than to one the caller names
    // it names. `openppwr_app` cannot read `token_hash`, so presenting this is possession.
    credentialHash: tokenHash(token),
    role: row.actor_role,
    supplierId: row.supplier_id,
    // Present only for an interactive session. A static operator token has neither, which is how the
    // application knows a sign-out cannot revoke it.
    sessionId: row.session_id || null,
    expiresAt: row.session_expires_at ? new Date(row.session_expires_at).toISOString() : null,
  };
}

// Ends one session: the one whose token was presented, never every session the identity holds.
// Returns false when there was nothing to revoke, which is the honest answer for a second sign-out
// or an already-expired session rather than an error the caller must handle.
export async function revokeSession(pool, { tenantId, sessionId }) {
  if (!tenantId || !sessionId) return false;
  const result = await pool.query('SELECT revoke_openppwr_session($1,$2) AS revoked', [tenantId, sessionId]);
  return result.rows[0]?.revoked === true;
}

// `deadline` names which class of work this transaction is, not how many milliseconds it may take. The
// milliseconds are the deployment's to choose (see DEADLINE_VARIABLES above) and are absent by default, so
// naming the class costs nothing until an operator has measured their own deployment and set one.
//
// Applied with `set_config(..., true)`, which is `SET LOCAL`: it reverts when the transaction ends, so a
// deadline can never leak onto the next caller to check out this pooled connection. That distinction is the
// whole reason it is safe to set per transaction on a shared pool at all.
export async function withTenantTransaction(pool, context, operation, { deadline = 'interactive' } = {}) {
  if (!context?.tenantId || !context?.actorId) throw new TypeError('Verified tenant and actor context required.');
  if (!['interactive', 'extended'].includes(deadline)) throw new TypeError(`Unknown transaction deadline class: ${deadline}.`);
  const statementMs = databaseDeadlines()[deadline === 'extended' ? 'extendedStatementMs' : 'interactiveStatementMs'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true), set_config('openppwr.actor_id', $2, true)`, [context.tenantId, context.actorId]);
    // One extra round trip, and only when the deployment asked for one.
    if (statementMs) await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(statementMs)]);
    // Carried on the connection rather than threaded through fifteen call sites. It is not the boundary —
    // the boundary is that the database resolves the actor from this digest and refuses an invalid one.
    client.openppwrActorCredential = context.credentialHash ?? null;
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// The chain is written by the database now, and this is the whole of the application's part in it.
//
// The previous version computed the hash here and handed it to a function that checked only that the
// digests *looked* like digests. A caller could read the tail, supply it as the link, and then supply any
// actor, action and payload with a hash of its choosing — a random one breaking verification permanently, a
// computed one forging an event attributed to someone else.
//
// Keeping one encoder was the right instinct and the wrong conclusion: validating linkage without
// validating content is not integrity. So there is still exactly one encoder, and it is
// `openppwr_audit_canonical_hash` — which the verifier below also uses, so writer and reader cannot drift.
// `tenantId`, `actorId` and `occurredAt` are accepted and ignored. They were the finding: a caller that
// chooses the actor, the action and the time does not need to choose the digest, and `occurredAt` could be
// `infinity`, which takes chain verification down with it. The database derives all three now — the actor
// from the credential on the connection, the tenant from that actor, and the time from its own clock.
export async function appendAudit(client, { action, entityType, entityId, payload = {}, actorCredential }) {
  const credential = actorCredential ?? client.openppwrActorCredential ?? null;
  const appended = await client.query(
    'SELECT event_id, event_hash, previous_hash FROM append_openppwr_audit_event($1,$2,$3,$4,$5::jsonb)',
    [credential, action, entityType, String(entityId), JSON.stringify(payload)],
  );
  const row = appended.rows[0];
  return { eventId: row.event_id, eventHash: row.event_hash, previousHash: row.previous_hash };
}

// Retained for the rows written before migration 021, which carry `js-canonical-v1`. Verification dispatches
// on the algorithm each row records, so an upgrade does not invalidate a chain it did not write.
function legacyEventHash({ eventId, tenantId, actorId, action, entityType, entityId, payload, occurredAt, previousHash }) {
  const normalized = JSON.stringify(canonical({ eventId, tenantId, actorId, action, entityType, entityId, payload, occurredAt, previousHash }));
  return createHash('sha256').update(normalized).digest('hex');
}

// The range the verification actually covered. Reporting only "valid: true" asks the reader to take
// the result on faith; stating how many events were checked and which period they span is what makes
// the answer inspectable.
function auditRange(rows) {
  if (!rows.length) return { firstEventAt: null, lastEventAt: null };
  // A value the driver renders as a non-finite Date throws here, and this is called *from* the branch that
  // exists to report such a row — so a poisoned first or last event still took the verifier down with it
  // rather than being reported. Years beyond 275760-09-13 behave the same way.
  const renderable = (value) => {
    const at = new Date(value);
    return Number.isFinite(at.valueOf()) ? at.toISOString() : null;
  };
  return {
    firstEventAt: renderable(rows[0].occurred_at),
    lastEventAt: renderable(rows.at(-1).occurred_at),
  };
}

export async function verifyAuditChain(client) {
  const result = await client.query(
    `SELECT event_id, tenant_id, actor_id, action, entity_type, entity_id, payload, occurred_at,
            previous_hash, event_hash, hash_algorithm,
            -- As text, because the driver renders a timestamptz through a JavaScript Date and loses the
            -- microseconds the v2 canonical form depends on. A verifier that rounds cannot match a writer
            -- that does not.
            occurred_at::text AS occurred_at_text
       FROM audit_events ORDER BY sequence`);
  let previousHash = 'GENESIS';
  for (const row of result.rows) {
    // A pre-023 chain can hold `occurred_at = 'infinity'`, written through the old caller-supplied path.
    // `new Date(Infinity).toISOString()` throws, so one poisoned row took verification down with it instead
    // of being reported as the broken row it is.
    const occurredAtValue = new Date(row.occurred_at);
    if (!Number.isFinite(occurredAtValue.valueOf())) {
      return { valid: false, count: result.rowCount, failedEventId: row.event_id, ...auditRange(result.rows) };
    }
    const occurredAt = occurredAtValue.toISOString();
    let expected;
    if (row.hash_algorithm === 'sql-canonical-v2') {
      const recomputed = await client.query(
        'SELECT openppwr_audit_canonical_hash_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS hash',
        [row.event_id, row.tenant_id, row.actor_id, row.action, row.entity_type, row.entity_id,
          JSON.stringify(row.payload), row.occurred_at_text, previousHash],
      );
      expected = recomputed.rows[0].hash;
    } else if (row.hash_algorithm === 'sql-canonical-v1') {
      // Recomputed by the same function that wrote it. One encoder, used by writer and reader, so the two
      // cannot drift — which was the reason for keeping the encoder in one place to begin with.
      const recomputed = await client.query(
        'SELECT openppwr_audit_canonical_hash($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS hash',
        [row.event_id, row.tenant_id, row.actor_id, row.action, row.entity_type, row.entity_id,
          JSON.stringify(row.payload), row.occurred_at, previousHash],
      );
      expected = recomputed.rows[0].hash;
    } else if (row.hash_algorithm === 'js-canonical-v1') {
      // Written before migration 021 moved the encoder into the database. Verified the way it was written,
      // so an upgrade does not invalidate a chain it did not produce.
      expected = legacyEventHash({
        eventId: row.event_id, tenantId: row.tenant_id, actorId: row.actor_id, action: row.action,
        entityType: row.entity_type, entityId: row.entity_id, payload: row.payload, occurredAt, previousHash,
      });
    } else {
      // An unrecognised algorithm marker is not evidence the row is legacy — it is evidence the row is
      // wrong. The prior fallback treated every value other than the two SQL-side names as legacy JS,
      // which verified successfully against any row whose event_hash happened to match that one encoder,
      // regardless of what hash_algorithm actually said. Reject and report, exactly as the
      // non-finite-timestamp case above does, rather than guessing an encoder for it.
      return { valid: false, count: result.rowCount, failedEventId: row.event_id, ...auditRange(result.rows) };
    }
    if (row.previous_hash !== previousHash || row.event_hash !== expected) {
      return { valid: false, count: result.rowCount, failedEventId: row.event_id, ...auditRange(result.rows) };
    }
    previousHash = row.event_hash;
  }
  return { valid: true, count: result.rowCount, head: previousHash, ...auditRange(result.rows) };
}

// ---------------------------------------------------------------------------
// Interactive sign-in for the demonstration environment.
//
// Sign-in returns a bearer session token, never a cookie. A cookie would make CSRF applicable and
// invalidate the documented NOT_APPLICABLE assessment; a header-carried credential keeps that
// property while still giving users a real login.

const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, SCRYPT_PARAMETERS.keylen, SCRYPT_PARAMETERS);
  return { passwordHash: derived.toString('hex'), passwordSalt: salt };
}

// Constant-time comparison. A length mismatch is reported as a mismatch rather than throwing, so
// that a malformed stored hash cannot be distinguished from a wrong password by timing or by error.
export function verifyPassword(password, passwordHash, passwordSalt) {
  if (!password || !passwordHash || !passwordSalt) return false;
  const expected = Buffer.from(passwordHash, 'hex');
  const actual = scryptSync(password, passwordSalt, SCRYPT_PARAMETERS.keylen, SCRYPT_PARAMETERS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function signIn(pool, { email, password }) {
  // Every failure path returns the same null, and the caller emits one message. Nothing
  // distinguishes an unknown address from a wrong password.
  if (!email || !password) return null;

  // The salt, and only the salt. The previous version fetched the stored hash and compared it here, which
  // meant the connection performing sign-in could read any user's verifier — and then mint a session for any
  // identity through a separate primitive. Holding both is holding neither boundary.
  //
  // An unknown address returns a deterministic decoy salt rather than nothing, so this path spends the same
  // work and reveals nothing by its shape.
  const salted = await pool.query('SELECT openppwr_demo_login_salt($1) AS salt', [String(email)]);
  const salt = salted.rows[0]?.salt;
  if (!salt) return null;

  // scrypt stays here because PostgreSQL has none. What changed is the direction: the derived value is
  // *presented* rather than the stored value *received*, so producing it requires the password.
  const { passwordHash } = hashPassword(String(password), salt);

  // Verification and issuance in one call. The identity comes from the address, the tenant and role from
  // that identity, the expiry from server policy, and the token from the database — none of them from here.
  const issued = await pool.query(
    'SELECT session_token, expires_at, actor_role, tenant FROM authenticate_openppwr_demo_login($1,$2,$3)',
    [String(email), passwordHash, Math.floor(SESSION_TTL_MS / 1000)],
  );
  if (issued.rowCount !== 1) return null;

  const row = issued.rows[0];
  return {
    token: row.session_token,
    expiresAt: new Date(row.expires_at).toISOString(),
    role: row.actor_role,
    tenantId: row.tenant,
  };
}
