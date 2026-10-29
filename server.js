// ── HiBy Hub — Server ────────────────────────────────────────────────────────
'use strict';
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const chokidar    = require('chokidar');
const config      = require('./config');
const { platformLabel } = require('./lib/platform');
const db          = require('./lib/db');
const { migrateFromJson } = require('./lib/db-migrate');

const app = express();

// Trust proxy when running behind cloudflared / Tailscale Serve / nginx /
// any reverse proxy. Honours X-Forwarded-* headers so req.ip and the
// express-rate-limit key are the real client IP, not the proxy's loopback.
if (config.TRUST_PROXY) {
  // 'loopback' = trust headers only from the localhost proxy. Safe default;
  // not the wide-open 'true' which trusts any upstream.
  app.set('trust proxy', 'loopback');
  console.log('[server] TRUST_PROXY enabled — expecting X-Forwarded-* from a local reverse proxy.');
}

// CORS — local origins by default. Add tunnel/Tailscale hosts via the
// ALLOWED_ORIGINS env var (comma-separated, full origins with scheme).
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${config.PORT}`,
  `http://127.0.0.1:${config.PORT}`,
  ...(config.ALLOWED_ORIGINS || []),
]);
app.use(cors({
  origin(origin, cb) {
    // Same-origin requests have no Origin header — allow them.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
}));

// Optional HTTP Basic auth — defence-in-depth alongside Cloudflare Access /
// Tailscale ACLs. Only engages when BASIC_AUTH_USER and BASIC_AUTH_PASS are
// both set; otherwise it's a no-op pass-through.
const basicAuth = require('./lib/basicAuth').build(config);
app.use(basicAuth);

// Wheelhouse (the R4 app) authenticates with its own bearer token, so this
// router sits outside Basic auth (see SKIP_PREFIXES in lib/basicAuth.js).
const wheelhouseRoute = require('./routes/wheelhouse');

app.use(compression());
// Wheelhouse posts large inventories, so it uses its own (4 MB) JSON parser
// and is mounted before the app-wide 1 MB one.
app.use('/api/wheelhouse', wheelhouseRoute);
app.use(express.json({ limit: '1mb' }));

// Ensure cache directory exists
if (!fs.existsSync(config.CACHE_DIR)) {
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
}

// ── Open SQLite + run one-shot JSON migration ───────────────────────────────
// Uses node:sqlite (built into Node 22.5+) so there's no native-module build
// step. If the import fails the user gets a friendly error from db.open().
db.open(config.CACHE_DIR);
const migration = migrateFromJson(config.CACHE_DIR);
if (migration.ran) {
  if (migration.errors.length) {
    console.warn('[db-migrate] errors:', migration.errors.join('; '));
  } else {
    console.log('[db-migrate] migrated:', JSON.stringify(migration.migrated));
  }
}

// ── Static: serve the dashboard HTML ─────────────────────────────────────────
// Prefer the production build (dist/hiby-hub.html) when present — produced by
// `npm run build`. Falls back to the source file in dev.
const PROD_HTML = path.join(__dirname, 'dist', 'hiby-hub.html');
const DEV_HTML  = path.join(__dirname, 'hiby-hub.html');

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(fs.existsSync(PROD_HTML) ? PROD_HTML : DEV_HTML);
});

// ── API routes ────────────────────────────────────────────────────────────────
const inboxRoute      = require('./routes/inbox');
const libraryRoute    = require('./routes/library');
const deviceRoute     = require('./routes/device');
const syncRoute       = require('./routes/sync');
const softwareRoute   = require('./routes/software');
const taggerRoute     = require('./routes/tagger');
const identifyRoute   = require('./routes/identify');
const statsRoute      = require('./routes/stats');
const coverartRoute   = require('./routes/coverart');
const playlistRoute   = require('./routes/playlist');
const healthRoute     = require('./routes/health');
const replaygainRoute = require('./routes/replaygain');
const metadataRoute   = require('./routes/metadata');
const wishlistRoute   = require('./routes/wishlist');
const lastfmRoute     = require('./routes/lastfm');
const smartPlaylistRoute = require('./routes/smart-playlist');
const activityRoute      = require('./routes/activity');
const settingsRoute      = require('./routes/settings');

app.use('/api/inbox',      inboxRoute);
app.use('/api/library',    libraryRoute);
app.use('/api/device',     deviceRoute);
app.use('/api/sync',       syncRoute);
app.use('/api/software',   softwareRoute);
app.use('/api/tags',       taggerRoute);
app.use('/api/identify',   identifyRoute);
app.use('/api/stats',      statsRoute);
app.use('/api/coverart',   coverartRoute);
app.use('/api/playlist',   playlistRoute);
app.use('/api/health',     healthRoute);
app.use('/api/replaygain', replaygainRoute);
app.use('/api/metadata',   metadataRoute);
app.use('/api/wishlist',   wishlistRoute);
app.use('/api/lastfm',     lastfmRoute);
app.use('/api/smart-playlists', smartPlaylistRoute);
app.use('/api/activity',        activityRoute);
app.use('/api/settings',        settingsRoute);
// Convenience alias so /api/setup-status hits the same handler.
app.get('/api/setup-status', (req, res, next) => {
  req.url = '/setup-status';
  settingsRoute.handle(req, res, next);
});

// ── SSE — Server-Sent Events for real-time inbox notifications ────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Match the CORS policy on the rest of the server.
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.flushHeaders();

  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

function broadcastEvent(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const client of sseClients) {
    try { client.write(msg); } catch (_) { sseClients.delete(client); }
  }
}

// ── Inbox watcher — chokidar watches INBOX_PATH for new downloads ─────────────
function startInboxWatcher() {
  if (!fs.existsSync(config.INBOX_PATH)) {
    console.warn('[inbox-watcher] Inbox path not found, skipping watcher:', config.INBOX_PATH);
    return;
  }

  const watcher = chokidar.watch(config.INBOX_PATH, {
    depth: 1,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 4000,
      pollInterval: 500,
    },
  });

  watcher.on('addDir', (p) => {
    if (p === config.INBOX_PATH) return;
    const name = path.basename(p);
    console.log('[inbox-watcher] New folder:', name);
    broadcastEvent('inbox-new-folder', { name });
  });

  watcher.on('add', () => {
    broadcastEvent('inbox-file-added', {});
  });

  watcher.on('error', err => console.warn('[inbox-watcher] Error:', err.message));
  console.log('[inbox-watcher] Watching', config.INBOX_PATH);
}

// ── /api/status ───────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    // Fan-out the slowest reads in parallel — getSummary() is async since the
    // inbox-scan refactor.
    const [inbox, device] = await Promise.all([
      inboxRoute.getSummary(),
      deviceRoute.getStatus(),
    ]);
    const library = libraryRoute.getSummary();
    const backlog = syncRoute.getBacklogCount(library, deviceRoute.getCachedAlbums());

    res.json({
      inbox,
      library,
      device,
      backlog,
      serverVersion: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ── Background library auto-scan ─────────────────────────────────────────────
// The library lives on an rclone mount of R2. Folder listings are cached by
// rclone, and tags are only read for new/changed albums, so a scan is cheap,
// but there's no reason to do it every couple of minutes either.
const LIBRARY_SCAN_INTERVAL = Math.max(1, config.LIBRARY_SCAN_MINUTES || 15) * 60 * 1000;

async function backgroundLibraryScan() {
  try {
    const result = await libraryRoute.scanLibrary();
    if (result.ok) {
      console.log('[auto-scan] Library:', result.albumCount, 'albums,', result.trackCount, 'tracks,', result.genreReads, 'tag reads');
    }
  } catch (e) {
    console.warn('[auto-scan] Library scan error:', e.message);
  }
}

setTimeout(() => {
  backgroundLibraryScan();
  setInterval(backgroundLibraryScan, LIBRARY_SCAN_INTERVAL);
}, 10000);

setTimeout(startInboxWatcher, 5000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.PORT, config.HOST, () => {
  console.log('\n+==========================================+');
  console.log('|        HiBy Hub -- Control Center        |');
  console.log('+==========================================+');
  console.log('\n  Dashboard: http://' + config.HOST + ':' + config.PORT);
  console.log('  Inbox:     ' + config.INBOX_PATH);
  console.log('  Library:   ' + config.LIBRARY_PATH);
  console.log('  Device:    ' + config.DEVICE_NAME + ' via Wheelhouse (' + (config.WHEELHOUSE_TOKEN ? 'token set' : 'WHEELHOUSE_TOKEN not set — sync off') + ')');
  console.log('  Downloads: ' + (require('./lib/r2').isConfigured(config) ? 'signed R2 links (' + config.R2.BUCKET + ')' : 'streamed through Hub (R2 keys not set)'));
  console.log('  Platform:  ' + platformLabel());
  if (config.TRUST_PROXY) {
    console.log('  Proxy:     enabled (X-Forwarded-* trusted from loopback)');
  }
  if (config.BASIC_AUTH_USER && config.BASIC_AUTH_PASS) {
    console.log('  Auth:      Basic — user "' + config.BASIC_AUTH_USER + '"');
  }
  if (config.ALLOWED_ORIGINS && config.ALLOWED_ORIGINS.length > 0) {
    console.log('  Origins:   localhost + ' + config.ALLOWED_ORIGINS.join(', '));
  }
  if (!config.ANTHROPIC_API_KEY) {
    console.log('  ⚠ ANTHROPIC_API_KEY not set in .env — /api/identify disabled.');
  }
  console.log();
});
