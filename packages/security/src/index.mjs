import { randomUUID } from 'node:crypto';

// API is JSON-only and never renders HTML: lock everything down.
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// Web serves the React SPA (same-origin assets + same-origin /v1/* proxy) and
// nothing else; no third-party origins, no inline/eval script, no plugins.
export const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "font-src 'self'; connect-src 'self' https://api.openppwr.eu; object-src 'none'; frame-ancestors 'none'; "
  + "base-uri 'self'; form-action 'self'";

// Six months. Raised from the initial one-day value on 2026-07-29 with owner approval, after all
// seven OpenPPWR hostnames were verified HTTPS-only behind the edge.
//
// includeSubDomains and preload remain deliberately absent. preload is effectively irreversible on
// a human timescale — removal requires a browser-vendor delisting cycle — and includeSubDomains
// binds every current and future *.openppwr.eu name to HTTPS-only for the cached lifetime. Neither
// is needed to protect the hostnames that exist today. See docs/security/WEB_SECURITY_HEADERS.md.
export const DEFAULT_HSTS = 'max-age=15768000';

export function buildSecurityHeaders({
  csp = API_CSP,
  hsts = DEFAULT_HSTS,
  cacheControl = 'no-store',
  permissionsPolicy = 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
} = {}) {
  const headers = {
    'Content-Security-Policy': csp,
    'Strict-Transport-Security': hsts,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': permissionsPolicy,
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return headers;
}

export function securityHeaders(options) {
  const headers = buildSecurityHeaders(options);
  return (_req, res, next) => {
    res.set(headers);
    next();
  };
}

export function correlationId(req,res,next) {
  const incoming = req.get('x-correlation-id');
  req.correlationId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.set('x-correlation-id',req.correlationId);
  next();
}

const CORS_ALLOWED_METHODS = 'GET,POST,OPTIONS';
const CORS_ALLOWED_HEADERS = 'Authorization,Content-Type,Idempotency-Key,X-Correlation-ID,X-Openppwr-Bootstrap-Token';

// Browsers attach Origin to same-origin POSTs too, so an Origin that matches the host the
// request was actually sent to is same-origin traffic — the app calling itself. Rejecting it
// would break every self-hosted deployment on a domain the allowlist cannot know in advance.
function isSameOrigin(origin, req) {
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== host) return false;
    // The scheme is part of an origin, and this comparison used to ignore it — so `http://app.example` was
    // treated as same-origin with an HTTPS deployment on `app.example` and echoed back in
    // `Access-Control-Allow-Origin`. The existing negative test varied the hostname and never the
    // scheme, so it passed throughout.
    //
    // `req.protocol` rather than reading `X-Forwarded-Proto` here: Express already resolves it from that
    // header under the `trust proxy` setting the API configures for exactly one hop, so consulting the raw
    // header would either duplicate that logic or bypass the hop limit.
    //
    // If the protocol cannot be determined at all, the origin is refused. Falling back to a guess would put
    // the bypass back: guess `http` and HTTPS same-origin traffic breaks, guess "either" and the scheme is
    // unchecked again.
    if (!req.protocol) return false;
    return parsed.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

export function cors(allowedOrigins) {
  return (req,res,next) => {
    const origin = req.get('origin');
    if (!origin) return next();
    if (!allowedOrigins.includes(origin) && !isSameOrigin(origin, req)) return res.status(403).json({error:'origin_not_allowed',correlationId:req.correlationId});
    // Never combined with credentialed wildcard: allowlist is explicit and echoed only for matches (OPP-CODE-007).
    res.set('Access-Control-Allow-Origin',origin).set('Vary','Origin');
    if (req.method === 'OPTIONS') return res.status(204).set('Access-Control-Allow-Methods',CORS_ALLOWED_METHODS).set('Access-Control-Allow-Headers',CORS_ALLOWED_HEADERS).set('Access-Control-Max-Age','600').end();
    return next();
  };
}

// A `Content-Disposition` value that survives a filename the product already accepts.
//
// Evidence filenames keep any Unicode letter, deliberately — a Polish supplier's `zaświadczenie.pdf` and a
// German `Prüfbericht.pdf` are ordinary names for this product, and rejecting them would be worse than the
// problem. But an HTTP header field value is Latin-1, and Node refuses anything outside it with
// `ERR_INVALID_CHAR`. So interpolating the stored name straight into `filename="…"` threw at the moment of
// download: `zaświadczenie.pdf` uploads cleanly and can then never be retrieved by anyone, for ever. The
// `ś` is enough; `ü` happens to be inside Latin-1 and worked, which is why this survived testing.
//
// RFC 6266 exists for exactly this. Emit both: `filename=` carrying an ASCII fallback for anything that
// only understands the old form, and `filename*=UTF-8''…` carrying the real name percent-encoded. Every
// current browser prefers the second. The fallback is transliterated rather than dropped so the file still
// arrives with a usable name in the worst case.
export function contentDisposition(filename) {
  const asciiFallback = String(filename)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^\x20-\x7e]/gu, '_')
    // A quote or a backslash inside the quoted-string would end it early; a control character is refused
    // by the header layer for the same reason the Unicode name was.
    .replace(/["\\]/gu, '_')
    .replace(/^_+$/u, 'download');
  const encoded = encodeURIComponent(String(filename)).replace(/['()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export { createRateLimiter, DEFAULT_RATE_LIMIT_RULES } from './rate-limit.mjs';
export { buildInfo, buildMismatches } from './build-info.mjs';
export { assertStrongSecrets, describeSecretWeakness, MINIMUM_SECRET_LENGTH } from './secret-strength.mjs';
