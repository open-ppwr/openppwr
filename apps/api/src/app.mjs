import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { appendAudit, appliedMigrationLevel, authenticateToken, hashPassword, revokeSession, signIn, tokenHash, verifyAuditChain, withTenantTransaction } from '@openppwr/database';
import { ACME_DISCLAIMER } from '@openppwr/testing';
import { API_CSP, contentDisposition, correlationId, cors, createRateLimiter, securityHeaders, buildInfo } from '@openppwr/security';
import { assignGap, remediateGap, runAssessments } from './assessment-service.mjs';
import { downloadDossierArtifact, freezeReviewSnapshot, generateDossier, removeDossierStorageKey } from './dossier-service.mjs';
import { evidencePathForDownload, listScanJobs, receiveEvidenceUpload, removeEvidenceStorageKey, requeueDeadScanJob, reviewEvidence } from './evidence-service.mjs';
import { executeImport } from './import-service.mjs';
import { errorMessage, requestLocale } from './error-messages.mjs';
import { log } from '@openppwr/observability';
import { HUMAN_ROLE_NAMES, isAllowed, mayRotateCredential, permissionsFor, requirePermission } from './permissions.mjs';

const roles = ['tenant_admin','compliance_manager','packaging_editor','evidence_contributor','evidence_reviewer','read_only_auditor','supplier_user','service_account','worker'];

// All OpenPPWR public hostnames route to the same web/api pair.
// Overridable per-deployment via OPENPPWR_CORS_ALLOWED_ORIGINS (comma-separated) — e.g. a clean
// self-host installer run under a single custom domain.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://openppwr.eu','https://app.openppwr.eu','https://demo.openppwr.eu','https://docs.openppwr.eu',
  'https://api.openppwr.eu','https://status.openppwr.eu','https://community.openppwr.eu',
];

function allowedOrigins() {
  const configured = process.env.OPENPPWR_CORS_ALLOWED_ORIGINS;
  return configured ? configured.split(',').map((value) => value.trim()).filter(Boolean) : DEFAULT_ALLOWED_ORIGINS;
}

// Identifiers arriving in a URL are attacker-controlled. Handing a malformed one to a query that
// casts to uuid made PostgreSQL raise 22P02, which surfaced as a 500 — and, before the error handler
// was corrected, echoed the SQLSTATE back to the caller.
//
// It also broke the deliberate 404-everywhere rule: a 500 meant "malformed" and a 404 meant
// "well-formed but not yours", which is an oracle. Every identifier is now shape-checked first and
// refused exactly as an unknown one is, so the two cases are indistinguishable from outside.
//
// Applies to the tables whose primary key is `uuid`: evidence_files, scan_jobs, review_snapshots and
// dossier_artifacts. It must NOT be applied to `gaps`, whose id is `text` — requiring a UUID there
// rejects legitimate identifiers, which is exactly what happened when this fix was first applied too
// broadly and the gap integration tests failed. `requireGapId` below is the validator for that type.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function requireUuid(value) {
  if (typeof value === 'string' && UUID.test(value)) return value;
  throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
}

// `gaps.id` is `text`, and the previous reasoning stopped one step short: because no cast happens, a
// malformed value produces an empty result and an ordinary 404, so nothing *breaks*. But "nothing breaks"
// is not the property the route-validation gate claims. The
// claim is that no untrusted identifier reaches a query before validation, and on three gap routes it
// did — the gate simply recorded `validator: null` and moved on.
//
// The type is textual on purpose and stays textual. A gap identifier is *derived*, not minted: it is
// `GAP-` followed by the leading 24 hex characters of SHA-256 over `tenant:packaging:rule:discriminator`
// (`gapIdentity` in `assessment-service.mjs`). That derivation is what makes the same defect found twice
// the same gap rather than two, so replacing it with a UUID would remove a correctness property to
// satisfy a validator. The full contract is `docs/security/GAP_IDENTIFIER_CONTRACT.md`.
//
// Uppercase, and mixed case is **refused rather than normalised**. Normalising would make `gap-1a2b…`
// and `GAP-1A2B…` two spellings of one object, which then appear as two spellings in audit records,
// logs and dossier references — an identifier with more than one accepted form is not an identifier.
const GAP_ID = /^GAP-[0-9A-F]{24}$/u;
export function requireGapId(value) {
  if (typeof value === 'string' && GAP_ID.test(value)) return value;
  throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

// Pagination for every list route. Two of them grow with a tenant's *history* rather than with its
// current catalogue size: an assessment is superseded, never deleted, and a gap persists closed
// rather than being removed. `GET /v1/assessments` and `GET /v1/gaps` returned every row with no `LIMIT`
// until 2026-08-01. The third, `GET /v1/catalog/:resource`, grows with the catalogue itself and used the
// opposite mistake — a hard `LIMIT 100` per statement with no `offset` and no `hasMore`, so a tenant with
// 480 packaging records saw 100 and was told nothing. It uses this helper too. Measured against the representative synthetic tenant this repository already builds
// for database-deadline calibration (3 000 packaging records; see the comment above `DEADLINE_VARIABLES`
// in `packages/database/src/index.mjs`), six reassessment rounds over that catalogue produced 18 000
// assessment rows and 103 gap rows — real numbers, not a guess, and both already past what a single
// unpaginated page could sanely return. A hard cap with no way to reach the rest was rejected for exactly
// that reason: it would have silently hidden the majority of a real tenant's own assessment history from
// its own compliance manager.
//
// `limit` defaults to 100 and is refused — not silently clamped — once it leaves [1, 500]. Clamping an
// out-of-range value to the maximum would let a caller who asked for 5 000 rows and received 500 read
// that as "there are only 500", indistinguishable from the truth. An explicit 400 keeps the two apart.
// Exported because a client has to be able to state the ceiling rather than discover it by being refused.
// The evidence-requirement selector in the workbench asks for `PAGE_LIMIT_MAX` rows in one request — see
// `SELECT_PAGE_SIZE` in `apps/web/src/paging.js` — and asking for one more than this is a 400, not a
// clamp, so the two numbers have to be the same number.
const PAGE_LIMIT_DEFAULT = 100;
export const PAGE_LIMIT_MAX = 500;
function parsePagination(query) {
  const parseBounded = (raw, { min, max, name }) => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
      throw Object.assign(
        new Error(`${name} must be a whole number between ${min} and ${max ?? 'unlimited'}.`),
        { code: 'PAGINATION_INVALID', status: 400 },
      );
    }
    return value;
  };
  const limit = parseBounded(query?.limit, { min: 1, max: PAGE_LIMIT_MAX, name: 'limit' }) ?? PAGE_LIMIT_DEFAULT;
  const offset = parseBounded(query?.offset, { min: 0, name: 'offset' }) ?? 0;
  return { limit, offset };
}

// How long readiness may spend proving the database is reachable before it answers "no".
//
// A readiness probe that hangs is worse than no readiness probe: the orchestrator keeps the container's
// previous verdict until its own timeout expires, so the moment the answer matters most — the pool is
// exhausted, the database is gone — is exactly when no answer arrives. `createPool` bounds *checkout*
// with `OPENPPWR_DB_CHECKOUT_TIMEOUT_MS`, which `deploy/community/docker-compose.yml` ships at 30 000 ms
// for good reasons that are entirely about serving requests and entirely wrong for a probe.
//
// 2 000 ms, chosen against the one measurement this repository actually holds rather than by feel: the
// checkout curve recorded in `deploy/community/docker-compose.yml` and `packages/database/src/index.mjs`
// reached 1 125 ms p95 at concurrency 50 against a pool of ten. So 2 000 ms sits just above the worst
// queuing wait ever measured here — a busy API is not reported unready — while staying well inside the
// 5 s the container healthcheck allows itself, so the probe always answers before the healthcheck gives
// up on it.
const READINESS_TIMEOUT_MS = 2_000;

// Can this process serve a request right now? For the API that is one question — is the database
// reachable through the pool — because every authenticated route opens a transaction on it, so an API
// that cannot reach the database answers nothing but errors while reporting itself available.
//
// `SELECT 1` is the cheapest statement that proves the whole path end to end: a pooled connection was
// obtained, the socket is alive, and the server answered. It reads no table, takes no lock, and needs no
// tenant context.
//
// Exported so the rule can be tested without starting a server or a database.
export async function probeReadiness(pool, { timeoutMs = READINESS_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Readiness probe timed out.'), { code: 'DATABASE_UNAVAILABLE' })), timeoutMs);
      }),
    ]);
    return { ready: true, reasons: [] };
  } catch {
    // One code, from a closed list, for every failure — which is how `apps/worker/src/health.mjs`
    // answers the same question. This route is unauthenticated, so whatever it returns is public: a
    // driver message names the host, the database and the role; an SQLSTATE names the engine; and
    // distinguishing a timeout from a refusal tells an anonymous caller which of the two they found.
    // The operator's diagnosis comes from the logs, which are not public.
    return { ready: false, reasons: ['DATABASE_UNAVAILABLE'] };
  } finally {
    clearTimeout(timer);
  }
}

// Demonstration sign-in. Deliberately opt-in: a deployment holding real data must never start with
// a known password, so the default is off and enabling it is an explicit operator decision.
export function demoLoginEnabled() {
  return String(process.env.OPENPPWR_DEMO_LOGIN || '').toLowerCase() === 'true';
}

// Which privileged database URLs a process in this posture may load, decided in one place so the rule can be
// tested without starting a server.
//
// `openppwr_auth` and `openppwr_maintenance` exist only for the demonstration profile. Loading either into a
// production API process would put session issuance and tenant deletion inside the long-running process an
// attacker reaches first, which is the separation migration 014 exists for — and separated grants achieve
// nothing if both credentials sit in the same process. Refused rather than ignored: declining to *use* a
// credential still leaves it in the environment, in the process, and in anything that reads either.
//
// `OPENPPWR_ROTATION_DATABASE_URL` is deliberately absent from this list, and it is the only privileged URL
// that is. `openppwr_rotation` (migration 035) holds EXECUTE on the rotation function and nothing else, and
// that EXECUTE is not authority by itself: the function resolves the actor from the credential presented and
// bounds what follows to what that credential already grants. A connection alone rotates nothing. Session
// issuance is the opposite — EXECUTE on it produces a working session for any identity, having proved
// nothing — and that asymmetry, not the fact that both are "privileged", is what decides which credential a
// production deployment may hold.
export function forbiddenPrivilegedVariables(environment = process.env, demoEnabled = demoLoginEnabled()) {
  if (demoEnabled) return [];
  return ['OPENPPWR_AUTH_DATABASE_URL', 'OPENPPWR_MAINTENANCE_DATABASE_URL'].filter((name) => environment[name]);
}

// The mirror of the rule above, and the one that was missing.
//
// `forbiddenPrivilegedVariables` refuses "demonstration sign-in is off, and the sign-in credential is loaded
// anyway". Nothing refused the opposite: "demonstration sign-in is declared on, and the credential that
// performs it is absent". That state is not a safe degradation, it is a deployment that contradicts itself,
// and it shipped as silence — `/v1/login` answered `404` because `authPool` was null, while
// `/v1/demo/accounts` kept answering `200` with the published password and every demonstration address,
// because that route checked only the flag. The product advertised credentials it then refused, and the
// operator's only signal was a not-found error on the sign-in screen.
//
// Found on a real deployment: one configured before migration 014 introduced `openppwr_auth`, carrying
// `OPENPPWR_DEMO_LOGIN=true` from that era, upgraded forward to the current schema. `upgrade` back-filled the
// worker password that migration 022 introduced and no other principal, so `prepareRuntime` — correctly, by
// its own rule that an absent password retires a role rather than leaving it dormant — issued
// `ALTER ROLE openppwr_auth NOLOGIN PASSWORD NULL`, and the deployment lost interactive sign-in without one
// line of output saying so. The installer gap is fixed separately; this is the check that would have named
// it at the first start rather than leaving it to be discovered by a person trying to sign in.
//
// Fatal, on the same reasoning `migrationLevelFinding` uses to decide direction. There is no legitimate
// window in which this disagreement is transient: both values are read from one environment file at one
// instant, unlike a migration level, where an upgrade and a deliberate rollback both legitimately produce a
// mismatch for a while. A deployment that cannot do the thing it says it does should say so once, loudly, at
// the moment it starts.
export function demoProfileFinding(environment = process.env, demoEnabled = demoLoginEnabled()) {
  if (!demoEnabled || environment.OPENPPWR_AUTH_DATABASE_URL) return null;
  return {
    fatal: true,
    message: 'OPENPPWR_DEMO_LOGIN=true but OPENPPWR_AUTH_DATABASE_URL is not set, so no credential can verify a password or issue a session and demonstration sign-in cannot work. Set OPENPPWR_AUTH_DATABASE_PASSWORD in the deployment environment file (openppwr-installer configure regenerates it), or set OPENPPWR_DEMO_LOGIN=false if this deployment is not a demonstration.',
  };
}
// What a disagreement between the declared and the applied migration level means, decided in one place so
// the rule can be tested without starting a server or a database.
//
// The register offered two mitigations — report the applied level, or assert equality at startup — and this
// takes both, but they are not the same instrument and must not be given the same force.
//
//   Reporting is unconditional. `/v1/version` states both numbers and whether they agree, always.
//
//   Refusing to start is reserved for the one direction that is a defect rather than a state: the database
//   is *behind* the image. Code that expects a table, column or function migration 036 adds cannot run
//   correctly against a schema that stopped at 035, and it will fail later as a 500 naming something the
//   operator cannot connect to the cause. A refusal at startup names it once, at the moment the deployment
//   was changed.
//
//   The database being *ahead* is a warning and never fatal, because it is what an ordinary upgrade and an
//   ordinary rollback both look like from inside a container. `deploy/community/docker-compose.yml` runs
//   `migrate` to completion and only then starts `api`, so during an upgrade there is a window in which the
//   schema has advanced and the previous API container has not yet been replaced — and a rollback to the
//   last good image is deliberately a running deployment on a newer schema. Refusing either would turn the
//   recovery path into a second outage, which is precisely the "must not deadlock an upgrade" case.
//
// `unknown` on either side compares to nothing. A locally built image carries the Dockerfile's default
// `OPENPPWR_MIGRATION_LEVEL=unknown`, and a database that has never been migrated has no applied level;
// neither is evidence of a mismatch, and treating absence as disagreement would make the check noise.
export function migrationLevelFinding(declared, applied) {
  const known = (value) => typeof value === 'string' && /^\d+$/u.test(value);
  if (!known(declared) || !known(applied)) return null;
  if (Number(declared) === Number(applied)) return null;
  if (Number(applied) < Number(declared)) {
    return {
      fatal: true,
      message: `This image expects database migration level ${declared} and the database is at ${applied}. Run the migrations before starting the API; the schema this build requires has not been applied.`,
    };
  }
  return {
    fatal: false,
    message: `This image declares database migration level ${declared} and the database is at ${applied}. That is expected during an upgrade or a deliberate rollback; if it persists, the running image is older than the schema.`,
  };
}

function demoPassword() {
  return process.env.OPENPPWR_DEMO_PASSWORD || 'demo';
}
function demoEmailFor(role) {
  const domain = process.env.OPENPPWR_DEMO_EMAIL_DOMAIN || 'dummymail.example';
  return role === 'compliance_manager' ? `demo@${domain}` : `${role.replaceAll('_', '-')}@${domain}`;
}

// The roles a person signs in as, in the order the workflow uses them. This is the list `/v1/demo/accounts`
// publishes *and* the list `bootstrap` provisions an account for — one list, because they were two and the
// two disagreed.
//
// The machine identities are excluded, and until this was corrected the exclusion was cosmetic: the route
// offered seven accounts while bootstrap created nine, so `worker@<domain>` and `service-account@<domain>`
// held the published demonstration password at a predictable address on the default demonstration posture,
// announced by nothing. `service_account` was the worse of the two — it holds `read`, `assessment:run`,
// `dossier:generate` and `dossier:download`, so an unannounced account read the tenant and produced its
// dossiers — and `worker` contradicted the product's own statement, in `permission-matrix.js`, that nobody
// signs in as it. Neither was reachable through the interface, which is precisely what made it worth
// removing rather than documenting: a credential nobody offers is a credential nobody watches.
//
// This list is about what gets *created*, and creation alone was never enough: a deployment bootstrapped
// before this correction still held the rows, and `authenticate_openppwr_demo_login` did not filter by role.
// Migration 039 removes those rows and makes both halves of sign-in resolve a machine role the way they
// resolve an address that does not exist. The two are not alternatives — the account is what grants the
// access, so the account must not exist; and a repair with no refusal behind it lasts until the next
// restore, an older image, or one hand-written INSERT.
const DEMO_ROLE_ORDER = Object.freeze([
  'compliance_manager', 'tenant_admin', 'packaging_editor', 'evidence_contributor',
  'evidence_reviewer', 'read_only_auditor', 'supplier_user',
]);

// Checked here rather than in a test, for the reason `assertRegistryIsSound` is: a test proves the two lists
// agreed when the suite last ran, this proves it in the process that is about to provision the accounts. A
// role added to `HUMAN_ROLES` and not here would ship a person with no way in; a machine role added here
// would recreate exactly the credential this list exists to withhold.
{
  const missing = HUMAN_ROLE_NAMES.filter((role) => !DEMO_ROLE_ORDER.includes(role));
  const extra = DEMO_ROLE_ORDER.filter((role) => !HUMAN_ROLE_NAMES.includes(role));
  if (missing.length || extra.length) {
    throw new Error(`Demonstration sign-in must offer exactly the roles a person signs in as. Missing: ${missing.join(', ') || 'none'}; not a human role: ${extra.join(', ') || 'none'}.`);
  }
}

function equalSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bootstrap(pool, body, storageRoot) {
  const tenantId = randomUUID();
  // The demonstration's own slug and name remain the defaults, so an operator who calls this route with an
  // empty body still gets exactly what `bootstrap-acme` has always produced.
  const slug = body.slug || 'acme-eu-demo';
  const name = body.name || 'ACME Packaging Europe GmbH';
  // The disclaimer every dossier from this tenant will carry. It defaults to the fiction marker rather than
  // to nothing: a caller who does not think about this question gets a deployment whose documents declare
  // themselves a demonstration, which is the safe direction to be wrong in. Dropping the marker requires
  // passing an explicit empty string — a decision, recorded in the tenant row, rather than an omission.
  const disclaimer = typeof body.disclaimer === 'string' ? body.disclaimer : ACME_DISCLAIMER;
  const users = roles.map((role) => ({
    id: randomUUID(),
    role,
    // Left as the demonstration supplier for every tenant, deliberately, and it is a real rough edge.
    //
    // `identities.supplier_id` carries no foreign key — it is a scope label, not a reference — so on a
    // tenant that has no such supplier this identity is scoped to something that does not exist and
    // therefore sees nothing. That is the wrong value but the right failure: widening it to NULL would
    // make the same identity unscoped, and an unscoped supplier_user is a supplier account that can read
    // every supplier's evidence. Narrowing wrongly is recoverable by an operator; widening silently is not.
    supplierId: role === 'supplier_user' ? 'ACME-SUP-001' : null,
    token: `opp_test_${randomBytes(24).toString('base64url')}`,
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Tenant creation goes through a SECURITY DEFINER function that holds the one-tenant rule itself.
    //
    // `tenants` now carries a self-only RLS policy (migration 008), so a count issued by this role would
    // always return zero and the one-tenant guarantee would silently evaporate. The global question is
    // answered inside the function, under the same advisory lock, by a role that can see the registry.
    try {
      await client.query('SELECT create_openppwr_tenant($1,$2,$3,$4)', [tenantId, slug, name, disclaimer]);
    } catch (error) {
      if (error.code === '23505' || /already been completed/u.test(error.message)) {
        throw Object.assign(new Error('Bootstrap has already been completed.'), { code: 'BOOTSTRAP_ALREADY_COMPLETED', status: 409 });
      }
      throw error;
    }
    await client.query(`SELECT set_config('openppwr.tenant_id', $1, true), set_config('openppwr.actor_id', $2, true)`, [tenantId, users[0].id]);
    // Identity provisioning is a one-time capability, not a standing grant (migration 014). A direct INSERT
    // here was how the application role could create itself a tenant_admin with a chosen token hash — an
    // attack the tests reproduce, and one that authenticated. The function refuses once any identity exists,
    // so it is open exactly during the bootstrap it exists for.
    await client.query('SELECT bootstrap_openppwr_identities($1,$2::jsonb)', [
      tenantId,
      JSON.stringify(users.map((user) => ({
        id: user.id,
        // Named after the tenant being created rather than after the demonstration. Every identity on a
        // real deployment used to be called "ACME tenant admin", which is a cosmetic defect right up until
        // someone reads it in an audit log and concludes the record belongs to a different organization.
        display_name: `${name} ${user.role.replaceAll('_', ' ')}`,
        role: user.role,
        supplier_id: user.supplierId,
        token_hash: tokenHash(user.token),
      }))),
    ]);
    await client.query(
      `INSERT INTO rule_versions (tenant_id,rule_id,version,source_reference,publication_date,effective_from,lifecycle_status,reviewer_status,required_inputs,required_evidence,applicability,checks,explanation_keys)
       VALUES ($1,'OPENPPWR-DEMO-RC','1.0.0','Regulation (EU) 2025/40 demonstration subset; non-authoritative','2025-02-28','2025-01-01','draft','requires_human_regulatory_review',$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)`,
      [tenantId,JSON.stringify(['recycledContentPct']),JSON.stringify(['RECYCLED_CONTENT_DECLARATION']),JSON.stringify({countries:[],packagingTypes:['sales','grouped','reusable']}),JSON.stringify([{id:'minimum-recycled-content',input:'recycledContentPct',operator:'gte',value:30,explanationKey:'assessment.recycled_content.minimum'}]),JSON.stringify(['assessment.recycled_content.minimum'])],
    );
    // Demonstration sign-in accounts. Opt-in and OFF by default: a self-hosted deployment holding
    // real data must never come up with a known password. Enabled only for the fictional ACME demo,
    // where the alternative is an operator pasting a raw bearer token, which is not a usable product.
    //
    // Provisioned through the same one-time capability, for a second reason: a standing INSERT on
    // `demo_users` let the application role forge the "this is a demonstration tenant" marker that the
    // reset used to trust.
    //
    // For `DEMO_ROLE_ORDER` and not for `roles`. Every one of the nine roles gets an *identity* above,
    // because the worker and the service account authenticate with bearer credentials the operator holds;
    // only the seven a person signs in as get a *password*. Those are different questions and this line
    // used to answer both with the same list.
    if (demoLoginEnabled()) {
      await client.query('SELECT bootstrap_openppwr_demo_users($1,$2::jsonb)', [
        tenantId,
        JSON.stringify(users.filter((user) => DEMO_ROLE_ORDER.includes(user.role)).map((user) => {
          const { passwordHash, passwordSalt } = hashPassword(demoPassword());
          return {
            id: randomUUID(),
            identity_id: user.id,
            email: demoEmailFor(user.role),
            password_hash: passwordHash,
            password_salt: passwordSalt,
          };
        })),
      ]);
    }
    // Bootstrap runs on a raw client, so the credential is passed explicitly: the first identity's token
    // was minted a moment ago and proves who this event belongs to. An audit event must be attributed to an
    // actor the database verifies, never to one the caller names.
    await appendAudit(client, { actorCredential: tokenHash(users[0].token), action: 'tenant.bootstrapped', entityType: 'tenant', entityId: tenantId, payload: { slug: body.slug || 'acme-eu-demo', roles: roles.length, demoLogin: demoLoginEnabled(), demoAccounts: demoLoginEnabled() ? DEMO_ROLE_ORDER.length : 0 } });
    await client.query('COMMIT');
    // The evidence volume records that bootstrap ran against it, and this is the moment that claim is
    // unambiguously true: a tenant now exists, and it exists on whatever volume is mounted right now.
    //
    // The worker refuses to treat a missing evidence file as a deletion unless this marker is present,
    // because an unmounted filesystem and a wrong volume both present as an empty, perfectly accessible
    // directory. Only the installer wrote it, from the host, so a deployment bootstrapped through this
    // route -- which the QuickStart documents, and which is the only route available to anyone not using
    // the installer -- had retention failing closed for ever with `RETENTION_STORAGE_UNREADABLE`. Failing
    // closed was the right behaviour and it was still a deployment that could never expire evidence.
    //
    // Written after COMMIT, deliberately. A marker written inside the transaction would survive a rollback
    // as a claim about a tenant that does not exist, and the marker's whole value is that it cannot be
    // present unless bootstrap actually succeeded. A failure here is logged and not raised: the tenant is
    // real by this point, and turning a successful bootstrap into an error response would leave the caller
    // believing they must retry an operation that refuses to run twice.
    try {
      await mkdir(storageRoot, { recursive: true });
      await writeFile(join(storageRoot, '.openppwr-storage-initialized'), `${new Date().toISOString()}
`, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        log('error', 'bootstrap.storage_marker_failed', { code: error.code, storageRoot });
      }
    }
    return { tenantId, disclaimer, identities: Object.fromEntries(users.map((user) => [user.role, { id: user.id, token: user.token, supplierId: user.supplierId }])) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// `authPool`, `maintenancePool` and `rotationPool` carry the credentials that `pool` deliberately lacks:
// session issuance, demonstration reset (migration 014) and credential rotation (migration 035). Each is a
// separate connection on a separate database role, and `openppwr_app` can assume none of them. All three are
// optional, and absence disables the capability rather than falling back to `pool` — a fallback would
// reinstate exactly the standing grant this separates out.
//
// Which of them a deployment may hold is not decided here; see `forbiddenPrivilegedVariables` above. In
// short: auth and maintenance exist only for the demonstration profile, rotation is the one privileged
// credential a production deployment may load.
export function createApp({ pool, authPool = null, maintenancePool = null, rotationPool = null, bootstrapToken = process.env.OPENPPWR_BOOTSTRAP_TOKEN, storageRoot = process.env.OPENPPWR_EVIDENCE_STORAGE_ROOT || '.runtime/evidence', rateLimiterFactory = createRateLimiter }) {
  if (!pool) throw new TypeError('Database pool is required.');
  // The connection rotation runs on, resolved once. `rotationPool` first, because `openppwr_rotation` holds
  // rotation and nothing else and is therefore the narrower principal wherever both exist; `authPool` second,
  // so a demonstration deployment provisioned before migration 035 keeps working unchanged. Never `pool`.
  const credentialPool = rotationPool || authPool;
  const app = express();
  app.disable('x-powered-by');
  // Exactly one trusted hop: the `web` container, which strips any client-supplied
  // X-Forwarded-For/CF-Connecting-IP and sets its own from the true edge connection
  // before proxying /v1/* (see apps/web/server.mjs). req.ip is therefore safe to use
  // as the IP rate-limit dimension and is never attacker-controlled.
  app.set('trust proxy', 1);
  app.use(correlationId);
  app.use(securityHeaders({ csp: API_CSP }));
  app.use(cors(allowedOrigins()));
  const rateLimit = rateLimiterFactory({ pool });
  // Three questions, three routes — the model `apps/worker/src/server.mjs` already answers, rather than
  // a second one invented here. The API had only the first of them, and the container healthcheck in
  // `Dockerfile` was pointed at it, so an API with an exhausted pool or a dead database reported
  // "healthy" and kept receiving traffic.
  //
  //   /health/live   — the process is running. No dependency is consulted, because a restart is the only
  //                    remedy for "no" and a database outage must never be answered with one.
  //   /health/ready  — this process can serve a request: the database answers through the pool.
  //                    "No" means take it out of service, not restart it.
  //   /health        — unchanged.
  //
  // **`/health` stays liveness rather than becoming readiness, and the container healthcheck moved to
  // `/health/ready` instead** (`Dockerfile`, and the explicit `api` healthcheck in
  // `deploy/community/docker-compose.yml`). The defect is that the healthcheck asked the wrong question;
  // the repair is to ask the right one, not to change what an already-published question means.
  // `/health` is documented as liveness in the shipped API reference (`apps/web/src/docs-content.js`),
  // `apps/web/server.mjs` answers `/health` for itself with exactly that meaning, and the recovery
  // rehearsal and the DAST probe both read it as "the process is up". Redefining it would also hand an
  // operator the wrong remedy: an orchestrator configured to restart on a failed liveness probe would
  // begin restarting a perfectly healthy API every time the database blinked — the outage the
  // liveness/readiness split exists to prevent.
  //
  // The body gains `live` and `role` and keeps `status: 'ok'`: added fields are the compatible change
  // this API's versioning rules already permit, and a changed meaning is not.
  //
  // No rate limiter on any of the three, and on `/health/ready` that is deliberate rather than
  // inherited: `rateLimit` writes to the database to count the request, so limiting the readiness probe
  // would make it fail whenever it is most needed and report a database outage as a 500 instead of a
  // 503. The cost it leaves unbounded is one `SELECT 1`, and only from inside the deployment —
  // `apps/web/server.mjs` answers `/health` itself and proxies only `/v1/*`, so neither new route is
  // reachable from outside the container network, which is where a healthcheck asks.
  const livenessBody = { status: 'ok', live: true, role: 'api' };
  app.get('/health/live', (_request, response) => response.json(livenessBody));
  app.get('/health/ready', asyncRoute(async (_request, response) => {
    const probe = await probeReadiness(pool);
    response.status(probe.ready ? 200 : 503).json({
      status: probe.ready ? 'ready' : 'unready', ready: probe.ready, reasons: probe.reasons, role: 'api',
    });
  }));
  app.get('/health', (_request, response) => response.json(livenessBody));
  // Unauthenticated on purpose. Someone checking whether a deployment carries a fix, or matching a
  // running instance against a published artifact, must be able to do that without a credential. The
  // record names no host, path or secret.
  //
  // `migrationLevel` is what the image was built claiming. `appliedMigrationLevel` is what the database
  // holds, read from `openppwr_schema_migrations` on each request rather than resolved once at startup —
  // a cached copy would be a second value nothing verifies, which is the defect being closed. The read is
  // one indexed row from a table with as many rows as this product has migrations, on a route that already
  // performs a database write for its own rate limit.
  //
  // `migrationLevelVerified` is true only when both are known and equal. A reader who previously had to
  // take `migrationLevel` on faith can now see the disagreement instead of being told a number.
  //
  // The route answers even when the database does not. It is the endpoint an operator reaches for while
  // diagnosing, and one that fails during a database outage tells them nothing at the moment they need it
  // most; the applied level degrades to `unknown` and the verification to false. No error text, no
  // SQLSTATE, no hostname: the route is unauthenticated, so what it reports is public, and an applied
  // schema number is publishable in a way that a database error is not.
  app.get('/v1/version', rateLimit('read'), asyncRoute(async (_request, response) => {
    const build = buildInfo();
    const applied = await appliedMigrationLevel(pool).catch(() => null);
    response.json({
      ...build,
      appliedMigrationLevel: applied || 'unknown',
      migrationLevelVerified: Boolean(applied) && build.migrationLevel === applied,
    });
  }));
  // The authorization contract, served from the registry that enforces it.
  //
  // A role matrix maintained as page copy drifts from the code the moment either changes, and the
  // reader has no way to tell. This is the same object `isAllowed` consults, so a matrix rendered
  // from it cannot describe permissions the server does not grant.
  //
  // Unauthenticated on purpose, like `/v1/version`: it is the published capability model, already
  // stated in `docs/security/AUTHORIZATION_MATRIX.md`. It names no user, tenant, host or secret, and
  // knowing that an evidence reviewer may review evidence grants nobody the ability to do it.
  app.get('/v1/permissions', rateLimit('read'), (_request, response) => response.json({
    roles: roles.map((role) => ({ role, permissions: permissionsFor(role) })),
  }));
  app.post('/v1/bootstrap', rateLimit('bootstrap'), express.json({ limit: '32kb' }), asyncRoute(async (request, response) => {
    if (!equalSecret(request.get('x-openppwr-bootstrap-token'), bootstrapToken)) throw Object.assign(new Error('Bootstrap authorization failed.'), { code: 'BOOTSTRAP_UNAUTHORIZED', status: 401 });
    response.status(201).json(await bootstrap(pool, request.body || {}, storageRoot));
  }));
  // Demonstration credentials, published deliberately. Unauthenticated, and placed before the
  // authentication middleware, because the panel exists precisely for a user who has no credential.
  // A demonstration nobody can sign in to is not a
  // demonstration, and these accounts only exist when the operator has explicitly set
  // OPENPPWR_DEMO_LOGIN=true, which they may only do on a deployment holding fictional data. When demo
  // sign-in is off this route does not exist at all, so a production deployment discloses nothing.
  app.get('/v1/demo/accounts', rateLimit('read'), asyncRoute(async (request, response) => {
    if (!demoLoginEnabled()) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    // Gated on the sign-in credential as well as on the flag, and for a reason found on a real deployment:
    // with the flag on and `authPool` absent this route answered `200` with the published password and every
    // demonstration address while `/v1/login` answered `404`, so the panel handed a person credentials the
    // very next request refused. `demoProfileFinding` now refuses that state at startup, which should make
    // this branch unreachable in a served deployment; it is here anyway because `createApp` is exported and
    // callable without those startup checks, and because a panel that advertises what cannot be used is the
    // failure this pair exists to prevent — asserting it where the advertisement is made keeps the two
    // routes' preconditions identical rather than merely correlated.
    if (!authPool) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    response.json({
      password: demoPassword(),
      accounts: DEMO_ROLE_ORDER.map((role) => ({ role, email: demoEmailFor(role) })),
      // Whether `POST /v1/demo/reset` exists on this deployment. The workbench presented its reset panel
      // to everyone who was signed in, which on a self-hosted installation is a destructive button no
      // caller can use, described as restoring a demonstration environment that deployment does not have.
      // The client needs one honest signal to decide with, and this is the route that already exists for
      // telling an anonymous caller what the demonstration publishes about itself.
      //
      // It reports only what this process can answer: the reset runs on the maintenance credential
      // (migration 014) and without it the route is a 404 for every role. Whether the installer declared
      // this deployment a demonstration is a fact `reset_openppwr_demo_tenant()` establishes for itself
      // and is not asserted here. Nothing is disclosed that this route does not already disclose — it
      // answers only where demonstration sign-in is enabled, and it returns the published password.
      resetAvailable: Boolean(maintenancePool),
    });
  }));

  // Interactive sign-in. Returns a bearer session token; deliberately sets no cookie, so the
  // documented CSRF NOT_APPLICABLE assessment and its regression tests continue to hold.
  // Placed before the authentication middleware because a user signing in has no credential yet.
  //
  // Body parsed before the limiter runs, the reverse of every other route in this file. The
  // `loginTarget` rate-limit dimension needs the attempted address, and that address is not known
  // until the body is parsed — the 4 KB size cap already bounds the cost of parsing an oversized or
  // malformed body, so moving it ahead of the limiter does not reopen the cost-before-limiting
  // property the other ordering exists for elsewhere.
  app.post('/v1/login', express.json({ limit: '4kb' }), rateLimit('login'), asyncRoute(async (request, response) => {
    // Password sign-in exists only for demonstration accounts: `signIn` resolves the address through
    // `lookup_openppwr_demo_user` and nothing else. So the flag that creates those accounts must also govern
    // whether they can be used.
    //
    // It did not. `/v1/demo/accounts` and `/v1/demo/reset` both checked it and this route did not,
    // so a deployment that enabled demonstration sign-in once kept accepting the published password for ever
    // — the accounts are persisted, and unsetting the variable removed only the panel that advertised them.
    //
    // Refused as not-found rather than forbidden, like the other two demo routes: with the flag off the
    // route does not exist, and saying "disabled here" would confirm that these accounts are present.
    if (!demoLoginEnabled()) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    // Sign-in runs on the authentication credential, not the request-serving one. Reading a password
    // verifier and minting a session are the two capabilities `openppwr_app` demonstrably abused, so it no
    // longer holds either — without the separate credential there is no sign-in, not a degraded one.
    if (!authPool) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    const session = await signIn(authPool, { email: request.body?.email, password: request.body?.password });
    // One message for every failure. An unknown address and a wrong password are indistinguishable,
    // and the rate limiter has already counted the attempt regardless of outcome.
    if (!session) throw Object.assign(new Error('Authentication failed.'), { code: 'AUTHENTICATION_FAILED', status: 401 });
    response.json(session);
  }));
  app.use(asyncRoute(async (request, _response, next) => {
    const match = /^Bearer (.+)$/.exec(request.get('authorization') || '');
    if (!match) throw Object.assign(new Error('Authentication required.'), { code: 'AUTHENTICATION_REQUIRED', status: 401 });
    const identity = await authenticateToken(pool, match[1]);
    if (!identity) throw Object.assign(new Error('Authentication failed.'), { code: 'AUTHENTICATION_FAILED', status: 401 });
    // A session that already exists stops working the moment demonstration sign-in is switched off.
    //
    // Blocking new sign-ins alone would have left every session issued while the flag was on valid for its
    // full lifetime, so disabling the feature would not have disabled the access it granted.
    // `sessionId` is present only on the session branch, and sessions come only from `/v1/login`, which
    // serves only demonstration accounts — so this refuses exactly the credentials the flag governs and
    // leaves operator bearer tokens untouched.
    if (identity.sessionId && !demoLoginEnabled()) {
      throw Object.assign(new Error('Authentication failed.'), { code: 'AUTHENTICATION_FAILED', status: 401 });
    }
    request.identity = identity;
    next();
  }));
  // Lets a client confirm that its credential is valid and discover what it may do, without
  // performing a business operation first. Returns only the caller's own identity — never another
  // subject's — and no secret material. Every authenticated role may call it, so a client can
  // establish a session before any permission-scoped action is attempted.
  app.get('/v1/session', rateLimit('read'), asyncRoute(async (request, response) => {
    response.json({
      tenantId: request.identity.tenantId,
      actorId: request.identity.actorId,
      role: request.identity.role,
      supplierId: request.identity.supplierId,
      permissions: permissionsFor(request.identity.role),
      expiresAt: request.identity.expiresAt || null,
    });
  }));
  // Signing out. Placed after authentication because a caller must prove which session it is ending;
  // an unauthenticated sign-out would let anyone revoke a session identifier they guessed.
  //
  // A session token is revoked server-side, so the credential is dead the moment this returns — not
  // merely forgotten by the browser. A static operator token cannot be revoked in place, and this
  // says so rather than reporting a sign-out that did not happen; the client still discards it.
  app.post('/v1/logout', rateLimit('logout'), asyncRoute(async (request, response) => {
    const revoked = await revokeSession(pool, { tenantId: request.identity.tenantId, sessionId: request.identity.sessionId });
    if (revoked) {
      response.status(204).end();
      return;
    }
    response.status(200).json({ revoked: false, reason: request.identity.sessionId ? 'SESSION_ALREADY_ENDED' : 'STATIC_CREDENTIAL_NOT_REVOCABLE' });
  }));
  // Replacing one identity's bearer credential.
  //
  // Before this route existed, recovering a leaked token meant destroying the tenant: credentials are stored
  // as digests, so nobody can read one back to reissue it, and bootstrap refuses to run a second time. That
  // was honest for a demonstration deployment holding fictional data and useless to a real self-hoster.
  //
  // Three properties, each of them load-bearing:
  //
  //   * it runs on `credentialPool`, never on `pool`. Rotation is a credential write, and the request-serving
  //     role must not hold one — that boundary is migrations 013, 014 and 016, and it was re-broken twice
  //     before it held. Absent the credential connection the route does not exist, rather than falling back to
  //     the request pool, because a fallback would reinstate exactly what the separation removed.
  //
  //     Until migration 035 that connection could only be `authPool`, which a production deployment must not
  //     load, so this route answered 404 on every deployment holding real data — the recovery story existed
  //     in the demonstration and nowhere else, and the suite could not see it because it enabled the
  //     demonstration in order to run. `openppwr_rotation` is the same capability on a principal narrow
  //     enough to load in production: rotation EXECUTE, no session issuance, no table grant;
  //   * the credential is returned once, here, and never again. The store keeps a digest, so this response is
  //     the only time the plaintext exists outside the caller's hands;
  //   * `mayRotateCredential` states the rule — your own always, somebody else's with `credential:rotate` —
  //     and the database applies the same rule against the credential it resolved itself, so this check is
  //     the fast refusal rather than the boundary.
  app.post('/v1/identities/:id/rotate-credential', rateLimit('credentialRotate'), asyncRoute(async (request, response) => {
    const identityId = requireUuid(request.params.id);
    if (!mayRotateCredential(request.identity, identityId)) requirePermission(request.identity, 'credential:rotate');
    if (!credentialPool) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    const client = await credentialPool.connect();
    try {
      // The actor is the credential presented on this request, resolved inside the function against the
      // store. Nothing about who is acting comes from the request body, the path or a context variable.
      const rotated = await client.query(
        'SELECT new_credential, credential_expires_at, revoked_sessions FROM rotate_openppwr_identity_credential($1,$2)',
        [request.identity.credentialHash, identityId],
      );
      const row = rotated.rows[0];
      response.json({
        identityId,
        credential: row.new_credential,
        expiresAt: new Date(row.credential_expires_at).toISOString(),
        revokedSessions: Number(row.revoked_sessions),
      });
    } catch (error) {
      // P0002 is the function's own answer for "no identity available to rotate", which covers an unknown
      // target, one in another tenant and one this actor may not touch — deliberately indistinguishable, and
      // answered as the same not-found every other unreachable object gets. A permission error (42501) is
      // deliberately NOT caught: that means a grant is missing, which is an operator fault and must surface
      // as one rather than masquerade as a route that does not exist.
      if (error.code === 'P0002') throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
      throw error;
    } finally {
      client.release();
    }
  }));
  app.post('/v1/imports', rateLimit('import'), express.raw({ type: ['application/json','text/csv'], limit: '2mb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'packaging:write');
    const result = await executeImport(pool, request.identity, {
      raw: Buffer.isBuffer(request.body) ? request.body : Buffer.from(''),
      contentType: request.get('content-type') || '',
      idempotencyKey: request.get('idempotency-key'),
    });
    response.status(result.replayed ? 200 : result.status === 'rejected' ? 422 : 201).json(result);
  }));
  app.get('/v1/catalog/summary', rateLimit('read'), asyncRoute(async (request, response) => {
    if (!isAllowed(request.identity, 'read')) requirePermission(request.identity, 'read');
    const result = await withTenantTransaction(pool, request.identity, (client) => client.query(
      `SELECT
        (SELECT count(*)::int FROM packaging) AS packaging,
        (SELECT count(*)::int FROM materials) AS materials,
        (SELECT count(*)::int FROM components) AS components,
        (SELECT count(*)::int FROM boms) AS boms,
        (SELECT count(*)::int FROM suppliers) AS suppliers`,
    ));
    response.json(result.rows[0]);
  }));
  // The catalog is paginated on exactly the same terms as /v1/assessments and /v1/gaps above: a real
  // `limit`/`offset` with `hasMore`, not a fixed truncation.
  //
  // It used to carry a hard `LIMIT 100` written into each statement and to answer with `{items}` alone.
  // A tenant whose catalog summary said 480 packaging records received 100 rows, no statement that the
  // other 380 existed, and no parameter that could reach them — the summary count and the table
  // disagreed by design and the interface had no way to say so.
  app.get('/v1/catalog/:resource', rateLimit('read'), asyncRoute(async (request, response) => {
    const queries = {
      packaging: 'SELECT id,name,packaging_type,country,supplier_id,status FROM packaging ORDER BY id',
      materials: 'SELECT id,name,family,recycled_content_pct FROM materials ORDER BY id',
      components: 'SELECT id,name,material_id,supplier_id,mass_g FROM components ORDER BY id',
      boms: 'SELECT id,packaging_id,version,status FROM boms ORDER BY id',
      suppliers: 'SELECT id,name,status FROM suppliers ORDER BY id',
    };
    if (!queries[request.params.resource]) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    requirePermission(request.identity, 'read');
    const { limit, offset } = parsePagination(request.query);
    // One row past `limit`, so `hasMore` comes from this query rather than from a second count(*).
    const result = await withTenantTransaction(pool, request.identity, (client) => client.query(
      `${queries[request.params.resource]} LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    ));
    const hasMore = result.rows.length > limit;
    response.json({ items: result.rows.slice(0, limit), limit, offset, hasMore });
  }));
  // Paginated on exactly the same terms as /v1/assessments, /v1/gaps and /v1/catalog/:resource above:
  // a real `limit`/`offset` with `hasMore` from a `limit + 1` fetch, not a fixed truncation.
  //
  // Both this route and `GET /v1/evidence` below returned every row with no `LIMIT` until 2026-08-01.
  // They grow with the tenant's *evidence* rather than its catalogue: a requirement is derived per
  // packaging record per required evidence type, and every upload against a requirement creates a new
  // version rather than replacing the previous one, so the evidence collection grows without bound even
  // on a catalogue that never changes. A tenant with ten thousand evidence files served all ten
  // thousand, into a browser that rendered all ten thousand.
  //
  // The ordering is stable and total — `packaging_id,evidence_type` is what the requirement derivation
  // makes unique per requirement — which is what lets `offset` mean the same thing between two requests.
  app.get('/v1/evidence-requirements', rateLimit('read'), asyncRoute(async (request, response) => {
    if (!(isAllowed(request.identity, 'read') || isAllowed(request.identity, 'read-own'))) requirePermission(request.identity, 'read');
    const { limit, offset } = parsePagination(request.query);
    const result = await withTenantTransaction(pool, request.identity, async (client) => {
      const parameters = [];
      let sql = 'SELECT id,packaging_id,supplier_id,evidence_type,rule_id,rule_version,status FROM evidence_requirements';
      if (request.identity.role === 'supplier_user') { parameters.push(request.identity.supplierId); sql += ' WHERE supplier_id=$1'; }
      sql += ` ORDER BY packaging_id,evidence_type LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`;
      // One row past `limit`, so `hasMore` comes from this query rather than from a second count(*).
      parameters.push(limit + 1, offset);
      return client.query(sql, parameters);
    });
    const hasMore = result.rows.length > limit;
    response.json({ items: result.rows.slice(0, limit), limit, offset, hasMore });
  }));
  app.post('/v1/evidence', rateLimit('evidenceUpload'), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'evidence:upload');
    response.status(202).json(await receiveEvidenceUpload(request, { pool, identity: request.identity, storageRoot }));
  }));
  // Paginated on the same terms as the requirement collection above. `created_at,id` was already the
  // ordering, and it is total — `id` breaks any tie on the timestamp — so `offset` addresses the same row
  // across two requests.
  app.get('/v1/evidence', rateLimit('read'), asyncRoute(async (request,response) => {
    if (!(isAllowed(request.identity,'read') || isAllowed(request.identity,'read-own'))) requirePermission(request.identity,'read');
    const { limit, offset } = parsePagination(request.query);
    const result=await withTenantTransaction(pool,request.identity,(client)=>{
      const parameters=[];
      let sql='SELECT id,requirement_id,supplier_id,evidence_type,version,normalized_filename,size_bytes,sha256,scan_status,review_status,expires_at,created_at FROM evidence_files';
      if(request.identity.role==='supplier_user'){parameters.push(request.identity.supplierId);sql+=' WHERE supplier_id=$1';}
      sql+=` ORDER BY created_at,id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`;
      parameters.push(limit + 1, offset);
      return client.query(sql,parameters);
    });
    const hasMore = result.rows.length > limit;
    response.json({items:result.rows.slice(0, limit), limit, offset, hasMore});
  }));
  app.post('/v1/evidence/:id/review', rateLimit('evidenceReview'), express.json({ limit: '8kb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'evidence:review');
    response.json(await reviewEvidence(pool, request.identity, { evidenceId: requireUuid(request.params.id), decision: request.body?.decision, rejectionCode: request.body?.rejectionCode }));
  }));
  // The operator's diagnosis surface for the scanning queue. Held behind `scan:requeue` rather than
  // `read`, because it reports infrastructure state — retry counters, failure classes, correlation
  // identifiers — rather than compliance data, and the operator who acts on it is the one who may requeue.
  //
  // Without it, the terminal state was actionable only by an operator who already knew the job identifier,
  // which the product gave them no way to obtain: a remedy with no diagnosis.
  app.get('/v1/scan-jobs', rateLimit('read'), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'scan:requeue');
    response.json(await listScanJobs(pool, request.identity, { requiresAttentionOnly: request.query?.requiresAttention === 'true' }));
  }));
  app.post('/v1/scan-jobs/:id/requeue', rateLimit('scanRequeue'), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'scan:requeue');
    response.json(await requeueDeadScanJob(pool, request.identity, { jobId: requireUuid(request.params.id) }));
  }));
  app.get('/v1/evidence/:id/download', rateLimit('evidenceDownload'), asyncRoute(async (request, response) => {
    // Validated before the transaction opens, not inside it. The first version of this fix validated
    // at the point of use — three lines below a query that had already received the raw value — so a
    // malformed identifier still reached the database and still produced a 500.
    const evidenceId = requireUuid(request.params.id);
    const result = await withTenantTransaction(pool, request.identity, async (client) => {
      const selected = await client.query('SELECT supplier_id FROM evidence_files WHERE id=$1', [evidenceId]);
      if (!selected.rowCount) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
      const supplierId = selected.rows[0].supplier_id;
      if (!(isAllowed(request.identity, 'evidence:download', { supplierId }) || isAllowed(request.identity, 'evidence:download-own', { supplierId }))) requirePermission(request.identity, 'evidence:download', { supplierId });
      return evidencePathForDownload(client, { evidenceId, identity: request.identity, storageRoot });
    });
    response.type(result.evidence.detected_mime).set('content-disposition', contentDisposition(result.evidence.normalized_filename)).send(result.content);
  }));
  app.post('/v1/assessments/run', rateLimit('assessmentRun'), express.json({ limit: '64kb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'assessment:run');
    response.status(201).json(await runAssessments(pool, request.identity, { packagingIds: request.body?.packagingIds || null }));
  }));
  // `read-own` means own, and until 2026-07-30 these two routes did not honour it.
  //
  // A supplier holds `read-own` and no `read`. Both routes accepted either permission and then returned
  // every assessment and every gap in the tenant, so a supplier could see other suppliers' outcomes, gap
  // descriptions, remediation notes and evidence identifiers. Tenant isolation was never affected;
  // supplier isolation was absent on exactly these two routes, while the evidence and requirement
  // collections below had always filtered correctly.
  //
  // This was not found by our own suite, because nothing tested isolation
  // *between suppliers inside one tenant* — every isolation test asked the cross-tenant question.
  //
  // A supplier's own scope is the packaging it has an evidence requirement for. That is the same
  // definition the requirement and evidence routes already use, so "own" now means one thing across the
  // API rather than one thing per route.
  const ownPackagingClause = 'packaging_id IN (SELECT packaging_id FROM evidence_requirements WHERE supplier_id=$1)';
  const scopeToOwn = (identity) => (identity.role === 'supplier_user' ? [identity.supplierId] : null);

  app.get('/v1/assessments', rateLimit('read'), asyncRoute(async (request, response) => {
    if (!(isAllowed(request.identity, 'read') || isAllowed(request.identity, 'read-own'))) requirePermission(request.identity, 'read');
    const own = scopeToOwn(request.identity);
    const { limit, offset } = parsePagination(request.query);
    const parameters = [...(own || [])];
    const limitPlaceholder = `$${parameters.length + 1}`;
    const offsetPlaceholder = `$${parameters.length + 2}`;
    // Fetched one row past `limit` so `hasMore` is known from this query alone, rather than from a second
    // `count(*)` over a table sized by a tenant's whole history.
    parameters.push(limit + 1, offset);
    const result = await withTenantTransaction(pool, request.identity, (client) => client.query(
      `SELECT a.id,a.packaging_id,a.rule_id,a.rule_version,a.supersedes_id,a.status,a.evaluated_at,r.outcome,r.explanation,r.evidence_ids
       FROM assessments a JOIN assessment_results r ON r.tenant_id=a.tenant_id AND r.assessment_id=a.id
       ${own ? `WHERE a.${ownPackagingClause}` : ''}
       ORDER BY a.evaluated_at,a.packaging_id
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      parameters,
    ));
    const hasMore = result.rows.length > limit;
    response.json({ items: result.rows.slice(0, limit), limit, offset, hasMore });
  }));
  app.get('/v1/gaps', rateLimit('read'), asyncRoute(async (request, response) => {
    if (!(isAllowed(request.identity, 'read') || isAllowed(request.identity, 'read-own'))) requirePermission(request.identity, 'read');
    const own = scopeToOwn(request.identity);
    const { limit, offset } = parsePagination(request.query);
    const parameters = [...(own || [])];
    const limitPlaceholder = `$${parameters.length + 1}`;
    const offsetPlaceholder = `$${parameters.length + 2}`;
    parameters.push(limit + 1, offset);
    const result = await withTenantTransaction(pool, request.identity, (client) => client.query(
      `SELECT id,packaging_id,rule_id,rule_version,deduplication_key,current_assessment_id,status,owner_id,remediation_notes,remediation_evidence_ids,history
       FROM gaps ${own ? `WHERE ${ownPackagingClause}` : ''} ORDER BY id
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      parameters,
    ));
    const hasMore = result.rows.length > limit;
    response.json({ items: result.rows.slice(0, limit), limit, offset, hasMore });
  }));
  app.post('/v1/gaps/:id/assign', rateLimit('gapWrite'), express.json({ limit: '8kb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'gap:manage');
    response.json(await assignGap(pool, request.identity, { gapId:requireGapId(request.params.id),ownerId:request.body?.ownerId }));
  }));
  app.post('/v1/gaps/:id/remediate', rateLimit('gapWrite'), express.json({ limit: '32kb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'gap:manage');
    response.json(await remediateGap(pool, request.identity, { gapId:requireGapId(request.params.id),notes:request.body?.notes,evidenceIds:request.body?.evidenceIds || [],packagingPatch:request.body?.packagingPatch || {} }));
  }));
  app.post('/v1/gaps/:id/reassess', rateLimit('assessmentRun'), asyncRoute(async (request, response) => {
    requirePermission(request.identity, 'gap:manage');
    const gapId = requireGapId(request.params.id);
    const gap = await withTenantTransaction(pool, request.identity, (client) => client.query('SELECT packaging_id FROM gaps WHERE id=$1', [gapId]));
    if (!gap.rowCount) throw Object.assign(new Error('Resource not found.'), { code:'RESOURCE_NOT_FOUND',status:404 });
    response.status(201).json(await runAssessments(pool, request.identity, { packagingIds:[gap.rows[0].packaging_id] }));
  }));
  app.post('/v1/review-snapshots', rateLimit('reviewFreeze'), express.json({ limit:'8kb' }), asyncRoute(async (request, response) => {
    requirePermission(request.identity,'review:freeze');
    response.status(201).json(await freezeReviewSnapshot(pool,request.identity,{locale:request.body?.locale || 'en'}));
  }));
  // Frozen reviews and the artifacts produced from them.
  //
  // Without this, a dossier could only be reached by the session that generated it, and only until
  // that session navigated away or signed out. An auditor signing in afterwards — the entire point of
  // the read-only role — had no route to the package at all. Generating evidence that only its author
  // can find is not evidence.
  //
  // Gated on dossier:download rather than read: the caller is being shown where the artifacts are, so
  // the entitlement to fetch them is the right one to require. Tenant scoping is enforced by RLS.
  app.get('/v1/review-snapshots', rateLimit('read'), asyncRoute(async (request,response) => {
    requirePermission(request.identity,'dossier:download');
    const result=await withTenantTransaction(pool,request.identity,async (client) => {
      const snapshots=await client.query('SELECT id,locale,generator_version,frozen_at,snapshot_sha256 FROM review_snapshots ORDER BY frozen_at DESC,id');
      const artifacts=await client.query('SELECT id,snapshot_id,artifact_type,sha256,size_bytes,created_at FROM dossier_artifacts ORDER BY snapshot_id,artifact_type');
      const bySnapshot=new Map();
      for(const artifact of artifacts.rows){
        const list=bySnapshot.get(artifact.snapshot_id)||[];
        list.push({id:artifact.id,artifactType:artifact.artifact_type,sha256:artifact.sha256,sizeBytes:Number(artifact.size_bytes),createdAt:artifact.created_at});
        bySnapshot.set(artifact.snapshot_id,list);
      }
      return snapshots.rows.map((snapshot) => ({
        id:snapshot.id,
        locale:snapshot.locale,
        generatorVersion:snapshot.generator_version,
        frozenAt:snapshot.frozen_at,
        snapshotSha256:snapshot.snapshot_sha256,
        artifacts:bySnapshot.get(snapshot.id)||[],
      }));
    });
    response.json({items:result});
  }));
  app.post('/v1/review-snapshots/:id/dossier', rateLimit('dossierGenerate'), asyncRoute(async (request,response) => {
    requirePermission(request.identity,'dossier:generate');
    response.status(201).json(await generateDossier(pool,request.identity,{snapshotId:requireUuid(request.params.id),storageRoot}));
  }));
  app.get('/v1/dossiers/:id/download', rateLimit('dossierDownload'), asyncRoute(async (request,response) => {
    requirePermission(request.identity,'dossier:download');
    const artifactId = requireUuid(request.params.id);
    const result = await withTenantTransaction(pool,request.identity,(client) => downloadDossierArtifact(client,{artifactId,storageRoot}));
    const mime = {json:'application/json',manifest:'application/json',pdf:'application/pdf',zip:'application/zip'}[result.artifact.artifact_type];
    response.type(mime).set('content-disposition', contentDisposition(result.artifact.artifact_type === 'manifest' ? 'checksum-manifest.json' : `dossier.${result.artifact.artifact_type}`)).send(result.content);
  }));
  // Lets the user restore the demonstration environment themselves instead of needing an operator
  // with shell access. Three independent guards, because this deletes data:
  //   1. demo login must be enabled — a deployment holding real data never exposes this at all;
  //   2. the caller must hold a role permitted to manage the tenant;
  //   3. it only ever clears domain data for the caller's own tenant, under RLS.
  // Identities, demo users and the tenant itself are preserved: bootstrap is one-time and
  // credentials are hash-only, so removing them would leave the deployment unusable.
  app.post('/v1/demo/reset', rateLimit('demoReset'), asyncRoute(async (request, response) => {
    if (!demoLoginEnabled()) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    requirePermission(request.identity, 'scan:requeue');
    // The reset runs on a credential the request-serving pool does not have (migration 014). Deriving the
    // target from the session's own tenant was not enough: `openppwr.tenant_id` is a GUC the application
    // role sets for itself, so the "own tenant" was whichever tenant the caller named, and the
    // demonstration marker the function checked lived in a table the same role could write. The attacker
    // tests reproduce both. Authority now comes from deployment metadata written at install time.
    //
    // Absent that credential the endpoint does not exist, rather than falling back to the request pool.
    if (!maintenancePool) throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
    // The tenant row is what says whether this environment is fiction, and it is read here rather than
    // asserted from a constant.
    //
    // This response used to answer `disclaimer: ACME_DISCLAIMER` — the string imported from
    // `@openppwr/testing` — while the dossier had already moved to `tenants.disclaimer` (see
    // `apps/api/src/dossier-service.mjs`). On a deployment bootstrapped with an explicit empty disclaimer,
    // the API therefore told the operator its data was fictional while none of its documents did. Of the two
    // the tenant row is the authority: it is what the dossier carries, it is what an operator chose at
    // bootstrap, and a constant compiled into the image cannot know what they chose. This was the last place
    // the constant still won.
    //
    // Read *before* the reset rather than after. The reset preserves the tenant row, so the value is the
    // same in either order; reading first means a database problem here fails the request having deleted
    // nothing, instead of reporting an error for work that has already irreversibly committed.
    //
    // Read through the request pool under the caller's own context, exactly as the dossier reads it — the
    // maintenance credential holds no `SELECT` on `tenants` (migration 014 grants it the reset function,
    // `audit_events` and nothing else), and widening it to serve one response field would put a table it has
    // never needed inside a credential that exists to be narrow.
    const callerDisclaimer = await withTenantTransaction(pool, request.identity, async (tenantClient) => {
      const tenant = await tenantClient.query('SELECT disclaimer FROM tenants WHERE id=$1', [request.identity.tenantId]);
      return tenant.rows[0]?.disclaimer ?? null;
    });
    const client = await maintenancePool.connect();
    let cleared;
    // Carried out of the block below so the response can say which tenant was actually reset.
    let resetTenantId = null;
    try {
      await client.query('BEGIN');
      // Takes no argument and reads no caller-supplied context. It resolves the target itself and refuses
      // unless the installer declared this deployment a demonstration.
      const result = await client.query('SELECT packaging_remaining, demo_tenant_id, evidence_storage_keys, dossier_storage_keys FROM reset_openppwr_demo_tenant()');
      const { packaging_remaining: packagingRemaining, demo_tenant_id: resetTarget, evidence_storage_keys: evidenceKeys, dossier_storage_keys: dossierKeys } = result.rows[0];
      resetTenantId = resetTarget;
      // Same connection, same transaction, same encoder: the record and the deletion commit together.
      // The administrator who asked for the reset, proved by the credential they presented. The maintenance
      // connection carries none of its own, and an unattributed reset is not a record worth keeping.
      await appendAudit(client, { actorCredential: request.identity.credentialHash, action: 'demo.reset', entityType: 'tenant', entityId: resetTenantId, payload: { scope: 'domain-data' } });
      await client.query('COMMIT');
      // Best-effort, after commit: the rows are already gone and are the reset's success criteria. A file
      // that fails to delete here is a cleanup gap, not a reason to report the reset itself as failed
      // — the database is authoritative, and nothing serves these bytes once their row is gone.
      // The outcome is still recorded rather than discarded: a cleanup helper's own `false`
      // used to vanish into an unread `Promise.all` result, so a permission problem, a confinement refusal,
      // or any other real failure left no trail an operator investigating orphaned files could follow.
      const evidenceOutcomes = await Promise.all(
        (evidenceKeys || []).map((key) => removeEvidenceStorageKey(storageRoot, resetTenantId, key)),
      );
      const dossierOutcomes = await Promise.all(
        (dossierKeys || []).map((key) => removeDossierStorageKey(storageRoot, resetTenantId, key)),
      );
      const failedEvidenceCount = evidenceOutcomes.filter((ok) => !ok).length;
      const failedDossierCount = dossierOutcomes.filter((ok) => !ok).length;
      if (failedEvidenceCount || failedDossierCount) {
        log('warn', 'demo.reset.storage_cleanup_incomplete', {
          tenantId: resetTenantId, failedEvidenceCount, failedDossierCount,
        });
      }
      cleared = { packagingRemaining };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // P0002 is the function's own signal that this deployment is not a declared demonstration, and it is
      // answered as a not-found like every other unavailable resource. A permission error (42501) is
      // deliberately NOT caught here: that means a grant is missing, which is an operator fault and must
      // surface as one rather than masquerade as a route that does not exist.
      if (error.code === 'P0002') throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
      throw error;
    } finally {
      client.release();
    }
    // The disclaimer read above belongs to the caller's tenant. `reset_openppwr_demo_tenant()` resolves its
    // own target from `deployment_metadata` and never from the caller, so the two are the same row only
    // because `create_openppwr_tenant` (migration 017) refuses a second tenant per deployment. Rather than
    // rely on that silently, the identity is checked: if a deployment ever held two tenants, the value read
    // would describe a tenant this call did not reset, and answering with it would be the same class of
    // mistake as answering with the constant. The field is then omitted — an absent field is a question the
    // caller can ask again, and a wrong one is not.
    if (resetTenantId && resetTenantId !== request.identity.tenantId) {
      log('error', 'demo.reset.tenant_mismatch', { resetTenantId, callerTenantId: request.identity.tenantId });
      response.json({ status: 'reset', ...cleared });
      return;
    }
    response.json({ status: 'reset', ...cleared, disclaimer: callerDisclaimer });
  }));
  app.get('/v1/audit/verify', rateLimit('auditVerify'), asyncRoute(async (request,response) => {
    requirePermission(request.identity,'audit:verify');
    // The extended deadline class. This walks every audit event the tenant has ever recorded and issues one
    // round trip per event, so its cost is a function of the deployment's history rather than of the
    // request; whatever bound suits an interactive read would abort it on any tenant that has been running.
    response.json(await withTenantTransaction(pool,request.identity,verifyAuditChain,{deadline:'extended'}));
  }));
  app.use((error, request, response, _next) => {
    const status = Number(error.status) || (error.type === 'entity.too.large' ? 413 : 500);
    // A code is only ever echoed back when this codebase chose it. `error.code` on an unhandled error
    // is whatever threw — for a database driver that is the raw SQLSTATE, and a malformed identifier
    // in a URL was returning `22P02` to the caller. It told an attacker the backend is PostgreSQL and
    // that their input reached a query, and it distinguished "malformed" from "not found", which the
    // deliberate 404-everywhere design exists to prevent.
    //
    // Anything this codebase did not raise deliberately is INTERNAL_ERROR, whatever it called itself.
    //
    // The discriminator is an explicit `status`, not the status band. Every error raised here is
    // constructed with both a code and a status; a driver error carries a code and no status. An
    // earlier version of this rule additionally required `status < 500`, which flattened
    // EVIDENCE_INTEGRITY_MISMATCH — a deliberate 500 that the caller is meant to see, because it says
    // stored bytes no longer match their metadata. Suppressing that would hide a real integrity
    // signal in order to hide a driver's vocabulary.
    const deliberate = typeof error.code === 'string'
      && /^[A-Z][A-Z0-9_]*$/u.test(error.code)
      && Number.isInteger(Number(error.status));
    const code = (deliberate && error.code)
      || (status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR');
    const fallback=status >= 500?'Internal server error.':error.message;
    // Security events are logged here because this is the one place every refusal passes through.
    //
    // The application previously logged nothing but its own startup line: no authentication failure,
    // no authorization denial, no rate-limit trip. Security events have to be logged, and to be available
    // centrally, and neither was met by a redacting logger that
    // existed in the source tree and was imported by nothing.
    //
    // The logger redacts by key and by value. What is recorded is deliberately minimal: no bearer
    // token, no request body, no evidence filename, and the actor only as an identifier the audit
    // chain can resolve.
    if (status === 401 || status === 403 || status === 404 || status === 409 || status === 429 || status >= 500) {
      log(status >= 500 ? 'error' : 'warn', 'api.request.refused', {
        code,
        status,
        method: request.method,
        // The route pattern, not the URL: a raw path carries identifiers, and an identifier in a log
        // is the thing the audit chain is for.
        route: request.route?.path || 'unmatched',
        correlationId: response.get('x-correlation-id') || null,
        // `actorId`, not `id`. The verified identity has never had an `id` property — `authenticateToken`
        // returns `actorId` — so this read was `undefined` on every authenticated request and every security
        // event was logged with a null actor. The control it serves is specifically
        // about attributing a refusal to someone; without the actor it recorded that something was refused
        // and nothing about whom.
        actorId: request.identity?.actorId || null,
        tenantId: request.identity?.tenantId || null,
      });
    }
    // `retryAfterSeconds` is part of the documented rate-limit body (docs/security/RATE_LIMITING.md), and the
    // limiter now raises rather than responding directly so that its refusals are logged like every other.
    // Carrying the field through keeps that published contract intact; without it, routing the 429 through
    // here would have silently changed the response shape while fixing the logging.
    const detail = deliberate && Number.isInteger(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {};
    response.status(status).json({ error: { code, message:errorMessage(requestLocale(request.get('accept-language')),code,fallback), ...detail } });
  });
  return app;
}

export async function createVerifiedContext(pool, token) {
  const identity = await authenticateToken(pool, token);
  if (!identity) throw new Error('AUTHENTICATION_FAILED');
  return identity;
}

export { withTenantTransaction };
