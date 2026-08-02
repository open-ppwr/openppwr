// SPDX-License-Identifier: Apache-2.0
// Postgres-backed rate limiting (OPP-CODE-020). Deployment-safe: Community ships
// only Postgres (no Redis), so counters live in `rate_limit_buckets` and are
// correct across process restarts and, if ever run, multiple replicas.

export const DEFAULT_RATE_LIMIT_RULES = {
  bootstrap: [{ dimension: 'ip', windowMs: 15 * 60_000, max: 5 }],
  // Interactive sign-in. Strict, because this is the one endpoint an attacker can reach without a
  // credential and guess against. Counted per IP regardless of whether the address exists, so a
  // 429 discloses nothing about which accounts are real.
  //
  // A second rule, added 2026-08-01, closes the gap the first cannot: the per-IP budget does nothing
  // against an attacker who spreads attempts across many addresses, one per IP, staying under ten each.
  // `loginTarget` is keyed on the *attempted* address rather than an authenticated subject — the only
  // identity available at sign-in is the one the caller typed — so it caps how many times any one
  // address can be tried regardless of how many source IPs make the attempts. Because the bucket key is
  // the literal string the caller sent, this cannot leak whether an account exists: the same limit
  // applies whether the address belongs to a real identity or not, and the existence check happens
  // afterwards, inside `signIn`, on a path this rule never inspects.
  login: [
    { dimension: 'ip', windowMs: 15 * 60_000, max: 10 },
    { dimension: 'loginTarget', windowMs: 15 * 60_000, max: 20 },
  ],
  demoReset: [{ dimension: 'tenant', windowMs: 60 * 60_000, max: 5 }],
  read: [{ dimension: 'subject', windowMs: 60_000, max: 300 }],
  // Signing out must stay generous: a user who cannot end a session because they are rate limited is
  // left holding a live credential, which is worse than the abuse the limit would prevent.
  logout: [{ dimension: 'subject', windowMs: 60_000, max: 60 }],
  import: [
    { dimension: 'tenant', windowMs: 5 * 60_000, max: 20 },
    { dimension: 'ip', windowMs: 5 * 60_000, max: 60 },
  ],
  // Evidence upload is deliberately looser than it first looks. A compliance user
  // legitimately uploads supplier documents for many packaging records in one sitting, and
  // the reference journey alone performs eight uploads in a few seconds. A 10/minute budget
  // turned normal batch work into 429s, so it is set to a level that still makes sustained
  // automated abuse impractical without punishing the intended workflow.
  evidenceUpload: [
    { dimension: 'subject', windowMs: 60_000, max: 30 },
    { dimension: 'tenant', windowMs: 60_000, max: 100 },
  ],
  evidenceReview: [{ dimension: 'subject', windowMs: 60_000, max: 60 }],
  evidenceDownload: [{ dimension: 'subject', windowMs: 60_000, max: 60 }],
  scanRequeue: [{ dimension: 'subject', windowMs: 60_000, max: 10 }],
  assessmentRun: [{ dimension: 'tenant', windowMs: 60_000, max: 20 }],
  gapWrite: [{ dimension: 'subject', windowMs: 60_000, max: 60 }],
  reviewFreeze: [{ dimension: 'tenant', windowMs: 60_000, max: 10 }],
  dossierGenerate: [{ dimension: 'tenant', windowMs: 60_000, max: 10 }],
  dossierDownload: [{ dimension: 'subject', windowMs: 60_000, max: 30 }],
  auditVerify: [{ dimension: 'subject', windowMs: 60_000, max: 30 }],
  // Replacing a bearer credential. Tight on both dimensions, and per hour rather than per minute: a
  // legitimate operator rotates a credential when one leaks or when it is about to expire, which is a rare
  // deliberate act, while an attacker holding a stolen administrator token would use this to churn every
  // credential in the tenant and lock the real operators out. The tenant ceiling bounds exactly that.
  credentialRotate: [
    { dimension: 'subject', windowMs: 60 * 60_000, max: 10 },
    { dimension: 'tenant', windowMs: 60 * 60_000, max: 30 },
  ],
};

function resolveIdentifier(dimension, req) {
  if (dimension === 'ip') return (req.ip || req.socket?.remoteAddress || 'unknown').replace('::ffff:', '');
  if (dimension === 'tenant') return req.identity?.tenantId || null;
  if (dimension === 'subject') return req.identity?.actorId || null;
  if (dimension === 'loginTarget') return resolveLoginTarget(req.body?.email);
  return null;
}

// Normalized the same way the database compares it (`lower(u.email) = lower(p_email)`, migration 018),
// so a case variation of one address cannot be used to spread attempts across separate buckets. Bounded
// to a length no real address exceeds (RFC 5321 caps the whole address at 254 octets); a caller sending
// something longer is not an address this rule needs to key on precisely, and hashing an unbounded
// string into a database key is its own small liability. `null` for anything that is not a non-empty
// string, so a malformed or absent field skips this rule rather than colliding every malformed request
// into one shared bucket keyed on `undefined`.
function resolveLoginTarget(rawEmail) {
  if (typeof rawEmail !== 'string') return null;
  const normalized = rawEmail.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) return null;
  return normalized;
}

export function createRateLimiter({ pool, rules = DEFAULT_RATE_LIMIT_RULES, now = () => Date.now() }) {
  if (!pool) throw new TypeError('Database pool is required.');

  async function increment(bucketKey, windowMs) {
    const windowIndex = Math.floor(now() / windowMs);
    const key = `${bucketKey}:${windowIndex}`;
    const windowStart = new Date(windowIndex * windowMs);
    const result = await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
       VALUES ($1,$2,1)
       ON CONFLICT (bucket_key) DO UPDATE SET count = rate_limit_buckets.count + 1, updated_at = now()
       RETURNING count`,
      [key, windowStart],
    );
    if (Math.random() < 0.01) pool.query(`DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 hour'`).catch(() => {});
    return { count: result.rows[0].count, resetAt: windowStart.getTime() + windowMs };
  }

  return function rateLimit(operation) {
    const limits = rules[operation];
    if (!limits) throw new TypeError(`Unknown rate limit operation: ${operation}`);
    return async function rateLimitMiddleware(req, res, next) {
      try {
        const checks = [];
        for (const rule of limits) {
          const identifier = resolveIdentifier(rule.dimension, req);
          if (!identifier) continue;
          const bucketKey = `${operation}:${rule.dimension}:${identifier}`;
          checks.push({ rule, result: await increment(bucketKey, rule.windowMs) });
        }
        const exceeded = checks.find(({ rule, result }) => result.count > rule.max);
        if (exceeded) {
          const retryAfterSeconds = Math.max(1, Math.ceil((exceeded.result.resetAt - now()) / 1000));
          res.set('Retry-After', String(retryAfterSeconds));
          // Raised rather than returned, so it passes through the global error handler — which is the one
          // place every refusal is logged.
          //
          // This returned the response directly, so a rate-limit trip never reached that handler and was
          // never recorded, while `docs/security/RATE_LIMITING.md` describes it as a logged
          // security event. A limit that fires silently tells an operator nothing about the
          // attempt it just absorbed.
          //
          // The status, code and body are unchanged: `Retry-After` is already set above, and the handler
          // echoes a deliberate code with its deliberate status.
          return next(Object.assign(new Error('Too many requests.'), {
            code: 'RATE_LIMITED', status: 429, retryAfterSeconds,
          }));
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  };
}
