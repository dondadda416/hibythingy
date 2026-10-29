'use strict';
// ── Settings route ──────────────────────────────────────────────────────────
// In-app editor for the variables that live in .env (and a handful that live
// in config.js). Reads sanitised values, writes back preserving comments and
// key order. Path settings are stored as HUB_INBOX_PATH / HUB_LIBRARY_PATH.
//
// API keys are masked on read — UI shows last 4 chars + ••••. To rotate, the
// user supplies a new value; sending an empty string clears the key.

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const { validateBody } = require('../lib/validate');
const { SettingsBody } = require('../lib/schemas');
const env = require('../lib/envFile');

const ENV_PATH    = path.join(__dirname, '..', '.env');

// Mask a secret for display — keep last 4 chars so the user can recognise it
// without seeing the whole value.
function maskSecret(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= 4) return '••••';
  return '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4);
}

// GET /api/settings — current sanitised settings
router.get('/', (req, res) => {
  // Prefer live values from the loaded config (already merges .env). The
  // raw .env is read separately so we can detect "explicitly set to empty"
  // vs "never set".
  const lines  = env.readEnv(ENV_PATH);
  const envHas = (k) => lines.some(l => l.kind === 'kv' && l.key === k && l.value);

  const setupOk = !!(config.LIBRARY_PATH && config.INBOX_PATH);

  res.json({
    ok: true,
    setupOk,
    paths: {
      INBOX_PATH:   config.INBOX_PATH   || '',
      LIBRARY_PATH: config.LIBRARY_PATH || '',
      DEVICE_NAME:  config.DEVICE_NAME  || '',
      DEVICE_MUSIC_FOLDER: env.getValue(lines, 'DEVICE_MUSIC_FOLDER') || '',
    },
    ai: {
      ANTHROPIC_MODEL: config.ANTHROPIC_MODEL || '',
      ANTHROPIC_KEY_set:    envHas('ANTHROPIC_API_KEY'),
      ANTHROPIC_KEY_masked: maskSecret(config.ANTHROPIC_API_KEY),
      DAILY_AI_BUDGET_USD:  env.getValue(lines, 'DAILY_AI_BUDGET_USD') || '',
    },
    lastfm: {
      LASTFM_USERNAME:    config.LASTFM_USERNAME || '',
      LASTFM_KEY_set:     envHas('LASTFM_API_KEY'),
      LASTFM_KEY_masked:  maskSecret(config.LASTFM_API_KEY),
    },
    misc: {
      HIBYHUB_CONTACT_EMAIL: config.CONTACT_EMAIL || '',
      PORT: env.getValue(lines, 'PORT') || String(config.PORT || ''),
    },
    remote: {
      HUB_TRUST_PROXY:    !!config.TRUST_PROXY,
      ALLOWED_ORIGINS:    (config.ALLOWED_ORIGINS || []).join(', '),
      BASIC_AUTH_USER:    config.BASIC_AUTH_USER || '',
      BASIC_AUTH_PASS_set: envHas('BASIC_AUTH_PASS'),
      BASIC_AUTH_PASS_masked: maskSecret(config.BASIC_AUTH_PASS),
    },
    wheelhouse: {
      WHEELHOUSE_TOKEN_set:    !!config.WHEELHOUSE_TOKEN,
      WHEELHOUSE_TOKEN_masked: maskSecret(config.WHEELHOUSE_TOKEN),
      R2_configured:           require('../lib/r2').isConfigured(config),
      R2_BUCKET:               (config.R2 && config.R2.BUCKET) || '',
    },
  });
});

// POST /api/settings — apply changes
//
// Body: any subset of the fields. Empty string clears the value. Returns
// {ok: true, restartRequired: true} — server keeps running with the OLD
// values until the next start; the UI nudges the user to restart.
router.post('/', validateBody(SettingsBody), (req, res) => {
  const body = req.body;
  // Paths are environment settings too (HUB_INBOX_PATH / HUB_LIBRARY_PATH).
  const PATH_KEYS = { INBOX_PATH: 'HUB_INBOX_PATH', LIBRARY_PATH: 'HUB_LIBRARY_PATH', DEVICE_NAME: 'DEVICE_NAME' };

  // Everything else lives in .env — apply diff.
  const envUpdates = {};
  for (const [k, envKey] of Object.entries(PATH_KEYS)) {
    if (body[k] !== undefined) envUpdates[envKey] = body[k];
  }
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'LASTFM_API_KEY', 'LASTFM_USERNAME',
    'HIBYHUB_CONTACT_EMAIL', 'DEVICE_MUSIC_FOLDER', 'DAILY_AI_BUDGET_USD', 'PORT',
    'HUB_TRUST_PROXY', 'ALLOWED_ORIGINS', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS',
    'WHEELHOUSE_TOKEN',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      // Coerce booleans → "true"/"false" strings so .env stays text-only.
      const v = body[k];
      envUpdates[k] = (typeof v === 'boolean') ? String(v) : v;
    }
  }

  try {
    if (Object.keys(envUpdates).length > 0) {
      const lines = env.readEnv(ENV_PATH);
      env.atomicWriteEnvSync(ENV_PATH, env.applyUpdates(lines, envUpdates));
    }
  } catch (e) {
    console.error('[settings/save]', e.message);
    return res.status(500).json({ error: 'Save failed: ' + e.message });
  }

  // Log to the activity feed.
  try {
    const db = require('../lib/db');
    db.logActivity('system', 'settings-changed', null, {
      changedKeys: Object.keys(envUpdates),
    });
  } catch (_) {}

  res.json({ ok: true, restartRequired: true });
});

// GET /api/settings/backup — stream the SQLite database file as a download.
// Insurance against a corrupted WAL or a borked migration. Restore is manual:
// stop the server, replace cache/hub.db, restart.
router.get('/backup', (req, res) => {
  const dbPath = path.join(config.CACHE_DIR, 'hub.db');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'No database file to back up' });

  // Trigger a WAL checkpoint first so the snapshot includes everything that's
  // currently in the write-ahead log. Otherwise the .db file alone is stale.
  try {
    const db = require('../lib/db');
    db.getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[backup] checkpoint failed:', e.message);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="hub-${stamp}.db"`);
  fs.createReadStream(dbPath).pipe(res);
});

// GET /api/setup-status — used by the first-run wizard. Returns { ok: bool }.
router.get('/setup-status', (req, res) => {
  const haveLib   = !!(config.LIBRARY_PATH && fs.existsSync(config.LIBRARY_PATH));
  const haveInbox = !!(config.INBOX_PATH   && fs.existsSync(config.INBOX_PATH));
  res.json({
    ok:           haveLib && haveInbox,
    libraryPath:  config.LIBRARY_PATH || '',
    inboxPath:    config.INBOX_PATH || '',
    libraryExists: haveLib,
    inboxExists:  haveInbox,
    deviceName:   config.DEVICE_NAME || '',
    haveAnthropicKey: !!config.ANTHROPIC_API_KEY,
  });
});

module.exports = router;
