'use strict';
// ── lib/basicAuth.js ─────────────────────────────────────────────────────────
// Optional HTTP Basic auth middleware. Activated when both BASIC_AUTH_USER and
// BASIC_AUTH_PASS are non-empty. Designed as belt-and-braces alongside an
// identity-aware proxy (Cloudflare Access, Tailscale, etc.) — NOT a substitute
// for one.
//
// Skips the small set of paths where the browser can't supply an Authorization
// header naturally (cover art served via <img>, audio served via <audio>) so
// the rendered page still works once the user has authenticated to the
// outer shell.

const crypto = require('crypto');

const SKIP_PREFIXES = [
  '/api/coverart/serve',   // <img src> — no Authorization header from browser
  '/api/tags/preview',     // <audio src> — same
  '/api/events',           // SSE doesn't carry auth headers in some browsers
  '/api/wheelhouse',       // the R4 app — has its own bearer-token check
];

// Constant-time string compare. Returns false on length mismatch without
// leaking the length difference into the timing channel.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) {
    // Still do a fixed-length compare against B to keep timing stable.
    crypto.timingSafeEqual(B, B);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

function _parseBasicAuth(header) {
  if (!header || typeof header !== 'string') return null;
  if (!/^Basic /i.test(header)) return null;
  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch (_) { return null; }
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

// Build the middleware. Pass the loaded config so we can check the env-derived
// credentials at request time without re-reading process.env.
function build(config) {
  return function basicAuthMiddleware(req, res, next) {
    const u = config.BASIC_AUTH_USER || '';
    const p = config.BASIC_AUTH_PASS || '';
    // Auth requires BOTH user and password. If either is missing the gate is
    // off — half-configured credentials shouldn't lock the user out of their
    // own server.
    if (!u || !p) return next();

    // Allow-list a handful of resources that browsers can't authenticate.
    if (SKIP_PREFIXES.some(prefix => req.path.startsWith(prefix))) return next();

    const parsed = _parseBasicAuth(req.headers.authorization || '');
    if (!parsed) {
      res.set('WWW-Authenticate', 'Basic realm="HiBy Hub", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!safeEqual(parsed.user, u) || !safeEqual(parsed.pass, p)) {
      res.set('WWW-Authenticate', 'Basic realm="HiBy Hub", charset="UTF-8"');
      return res.status(401).json({ error: 'Bad credentials' });
    }
    next();
  };
}

module.exports = { build, safeEqual, SKIP_PREFIXES };
