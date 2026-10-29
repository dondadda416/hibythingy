// ── HiBy Hub Configuration ──────────────────────────────────────────────────
// Everything machine-specific comes from environment variables (normally the
// .env file next to this one — see .env.example). The defaults below match the
// cloud server layout created by deploy/setup.sh:
//
//   /srv/hiby/inbox     uploads land here (local disk on the server)
//   /srv/hiby/library   the music library — an rclone mount of the R2 bucket
//   /srv/hiby/data      SQLite database + caches
//
// For local development, point the three HUB_*_PATH / HUB_DATA_DIR values at
// any folders you like.

'use strict';
const path = require('path');

// Load .env early. Failure is non-fatal; config still loads.
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {
  console.warn('[config] dotenv not installed — run `npm install` to enable .env support.');
}

function envOrEmpty(name) {
  const v = process.env[name];
  return (typeof v === 'string') ? v.trim() : '';
}

function envInt(name, fallback) {
  const n = parseInt(envOrEmpty(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {

  // ── AI Identification ─────────────────────────────────────────────────────
  ANTHROPIC_API_KEY:      envOrEmpty('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL:        envOrEmpty('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001',
  ANTHROPIC_PRICE_INPUT:  0.80,
  ANTHROPIC_PRICE_OUTPUT: 4.00,

  // ── Folders ──────────────────────────────────────────────────────────────
  // Where uploads land before they're tagged and moved into the library.
  INBOX_PATH: envOrEmpty('HUB_INBOX_PATH') || '/srv/hiby/inbox',

  // How many days back to show in inbox (0 = show everything)
  INBOX_DAYS: envInt('HUB_INBOX_DAYS', 30),

  // The master library. On the server this is the rclone mount of
  // r2:<bucket>/library, so every file here is also an object in R2.
  LIBRARY_PATH: envOrEmpty('HUB_LIBRARY_PATH') || '/srv/hiby/library',

  // How often to re-walk the library folder in the background (minutes).
  // Each walk only lists folders; tags are read once per album and cached.
  LIBRARY_SCAN_MINUTES: envInt('HUB_LIBRARY_SCAN_MINUTES', 15),

  // ── Cloudflare R2 ────────────────────────────────────────────────────────
  // Used to hand the R4 short-lived direct download links, so music never
  // routes through the small server. If these are blank, downloads are
  // streamed through the Hub instead (slower, but works).
  R2: {
    ACCOUNT_ID:        envOrEmpty('R2_ACCOUNT_ID'),
    ACCESS_KEY_ID:     envOrEmpty('R2_ACCESS_KEY_ID'),
    SECRET_ACCESS_KEY: envOrEmpty('R2_SECRET_ACCESS_KEY'),
    BUCKET:            envOrEmpty('R2_BUCKET') || 'hiby-library',
    // Optional override, e.g. for testing against another S3-compatible store.
    ENDPOINT:          envOrEmpty('R2_ENDPOINT'),
    // Object-key prefix that LIBRARY_PATH maps onto (no leading slash).
    LIBRARY_PREFIX:    (envOrEmpty('R2_LIBRARY_PREFIX') || 'library').replace(/^\/+|\/+$/g, ''),
    // Lifetime of download links handed to the R4, in seconds.
    LINK_TTL_SECONDS:  envInt('R2_LINK_TTL_SECONDS', 6 * 3600),
  },

  // ── Device (HiBy R4 running Wheelhouse) ──────────────────────────────────
  DEVICE_NAME: envOrEmpty('DEVICE_NAME') || 'R4',

  // Shared secret Wheelhouse sends as "Authorization: Bearer <token>".
  // /api/wheelhouse/* is refused when this is blank.
  WHEELHOUSE_TOKEN: envOrEmpty('WHEELHOUSE_TOKEN'),

  // Minutes since Wheelhouse last checked in before the R4 shows as offline.
  WHEELHOUSE_ONLINE_MINUTES: envInt('WHEELHOUSE_ONLINE_MINUTES', 10),

  // Kept for the Settings page; not used by Wheelhouse sync.
  DEVICE_MUSIC_FOLDER: envOrEmpty('DEVICE_MUSIC_FOLDER'),

  // ── Last.fm ──────────────────────────────────────────────────────────────
  LASTFM_API_KEY:  envOrEmpty('LASTFM_API_KEY'),
  LASTFM_USERNAME: envOrEmpty('LASTFM_USERNAME'),

  // Contact email used in outbound HTTP User-Agent strings (MusicBrainz etc.).
  CONTACT_EMAIL: envOrEmpty('HIBYHUB_CONTACT_EMAIL') || 'admin@example.com',

  // ── Remote access ────────────────────────────────────────────────────────
  // 'true' when Hub sits behind cloudflared on the same machine.
  TRUST_PROXY: envOrEmpty('HUB_TRUST_PROXY').toLowerCase() === 'true',

  // Comma-separated list of extra origins allowed to talk to /api/*.
  ALLOWED_ORIGINS: envOrEmpty('ALLOWED_ORIGINS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Optional HTTP Basic auth, defence-in-depth alongside Cloudflare Access.
  BASIC_AUTH_USER: envOrEmpty('BASIC_AUTH_USER'),
  BASIC_AUTH_PASS: envOrEmpty('BASIC_AUTH_PASS'),

  // ── Server ───────────────────────────────────────────────────────────────
  PORT: envInt('PORT', 3847),
  // Bind address. 127.0.0.1 on the server so only cloudflared can reach it.
  HOST: envOrEmpty('HUB_HOST') || '127.0.0.1',

  // Database + cache directory (created automatically on first run)
  CACHE_DIR: envOrEmpty('HUB_DATA_DIR') || path.join(__dirname, 'cache'),

  // ── Software launchers ───────────────────────────────────────────────────
  // Desktop app launchers only make sense when Hub runs on your own PC.
  SOFTWARE: {},
};
