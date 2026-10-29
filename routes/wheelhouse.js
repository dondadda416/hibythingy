// ── Wheelhouse sync API ─────────────────────────────────────────────────────
// The endpoints Wheelhouse (the R4 app) calls over Wi-Fi. Full description in
// WHEELHOUSE_SYNC.md. Every request must carry
//   Authorization: Bearer <WHEELHOUSE_TOKEN>
// This path is exempt from Basic auth and needs a Cloudflare Access "Bypass"
// rule, because the R4 can't do an email PIN login; the token is the gate.
'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const db      = require('../lib/db');
const r2      = require('../lib/r2');
const { safeEqual } = require('../lib/basicAuth');
const { isAudioFile } = require('../lib/walk');

const API_VERSION   = 1;
const MAX_SYNC_ITEMS = 25;          // queue items handed out per /sync call
const SKIP_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

// ── Auth ─────────────────────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const expected = config.WHEELHOUSE_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'Wheelhouse sync is off: set WHEELHOUSE_TOKEN on the server.' });
  }
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !safeEqual(m[1].trim(), expected)) {
    return res.status(401).json({ ok: false, error: 'Bad or missing token' });
  }
  next();
}
router.use(requireToken);
router.use(express.json({ limit: '4mb' }));

// Every authenticated call counts as a check-in. Wheelhouse can describe
// itself with optional headers so the dashboard shows space left on the card.
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; }
router.use((req, res, next) => {
  try {
    db.recordHeartbeat({
      deviceName: req.get('X-Device-Name'),
      appVersion: req.get('X-App-Version'),
      freeMB:     num(req.get('X-Free-MB')),
      totalMB:    num(req.get('X-Total-MB')),
      ip:         req.ip,
    });
  } catch (e) { console.warn('[wheelhouse] heartbeat failed:', e.message); }
  next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// A download link for a library-relative file: a signed R2 link when R2 is
// configured, otherwise this server's own /file endpoint (streamed).
async function linkFor(req, rel) {
  if (r2.isConfigured(config)) {
    try { return await r2.presignRel(config, rel); }
    catch (e) { console.warn('[wheelhouse] presign failed, falling back to stream:', e.message); }
  }
  return `${baseUrl(req)}/api/wheelhouse/file?path=${encodeURIComponent(rel)}`;
}

// Every file in an album folder that belongs on the player: audio plus
// artwork, cue sheets and lyrics. Sorted so downloads go in track order.
function listAlbumFiles(absDir) {
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return null; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.') || SKIP_FILES.has(e.name.toLowerCase())) continue;
    let st = null;
    try { st = fs.statSync(path.join(absDir, e.name)); } catch (_) { continue; }
    out.push({ name: e.name, size: st.size, mtime: Math.round(st.mtimeMs), audio: isAudioFile(e.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

const PLAYLISTS_SUBDIR = 'Playlists';

function listPlaylists() {
  const dir = path.join(config.LIBRARY_PATH, PLAYLISTS_SUBDIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.m3u8?$/i.test(n)) continue;
    let st = null;
    try { st = fs.statSync(path.join(dir, n)); } catch (_) { continue; }
    out.push({ name: n.replace(/\.m3u8?$/i, ''), file: n, relPath: `${PLAYLISTS_SUBDIR}/${n}`, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function expandQueueItem(req, q) {
  const base = {
    id: q.id, kind: q.kind, action: q.action, relPath: q.relPath,
    artist: q.artist, album: q.album, tracks: q.tracks, sizeMB: q.sizeMB, status: q.status,
  };
  if (q.action !== 'download') return base;

  const abs = r2.absFromRel(config, q.relPath);
  if (!abs) return { ...base, error: 'Invalid path' };

  if (q.kind === 'playlist') {
    let st = null;
    try { st = fs.statSync(abs); } catch (_) { return { ...base, error: 'Playlist no longer exists' }; }
    return { ...base, files: [{ path: q.relPath, size: st.size, url: await linkFor(req, q.relPath) }] };
  }

  const files = listAlbumFiles(abs);
  if (!files) return { ...base, error: 'Album folder no longer exists' };
  const withLinks = [];
  for (const f of files) {
    const rel = `${q.relPath}/${f.name}`;
    withLinks.push({ path: rel, size: f.size, mtime: f.mtime, audio: f.audio, url: await linkFor(req, rel) });
  }
  return { ...base, files: withLinks };
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// GET /api/wheelhouse/ping — cheap "are we connected and is there work?"
router.get('/ping', (req, res) => {
  let queued = 0, scanWanted = false;
  try { queued = db.getOpenQueue().length; } catch (_) {}
  try { scanWanted = !!(db.getHeartbeat() || {}).scanWanted; } catch (_) {}
  res.json({ ok: true, apiVersion: API_VERSION, server: 'HiBy Hub', time: new Date().toISOString(), queued, scanWanted });
});

// GET /api/wheelhouse/sync — the main call. Returns queued work with download
// links for every file, plus the current playlist list.
router.get('/sync', async (req, res) => {
  try {
    try { db.tidyQueue(); } catch (_) {}
    const open = db.getOpenQueue().filter(q => q.status === 'queued' || q.status === 'running');
    const slice = open.slice(0, MAX_SYNC_ITEMS);
    const items = [];
    for (const q of slice) items.push(await expandQueueItem(req, q));
    const hb = db.getHeartbeat() || {};
    res.json({
      ok: true,
      apiVersion: API_VERSION,
      time: new Date().toISOString(),
      scanWanted: !!hb.scanWanted,
      queue: items,
      remaining: Math.max(0, open.length - slice.length),
      playlists: listPlaylists(),
      linkTtlSeconds: r2.isConfigured(config) ? config.R2.LINK_TTL_SECONDS : null,
      linksVia: r2.isConfigured(config) ? 'r2' : 'hub',
    });
  } catch (e) {
    console.error('[wheelhouse/sync]', e.message);
    res.status(500).json({ ok: false, error: 'Sync failed' });
  }
});

// POST /api/wheelhouse/queue/:id  { status: 'running'|'done'|'error', error?, tracksOnDevice? }
router.post('/queue/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = Number.isFinite(id) ? db.getQueueItem(id) : null;
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });

  const status = String((req.body && req.body.status) || '');
  if (!['running', 'done', 'error'].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be 'running', 'done' or 'error'" });
  }
  if (item.status === 'cancelled') return res.json({ ok: true, cancelled: true });

  const error = status === 'error' ? String((req.body && req.body.error) || 'Failed on device').slice(0, 500) : null;
  db.setQueueStatus(id, status, error);

  if (status === 'done') {
    const subject = item.kind === 'album'
      ? `${item.artist} — ${item.album}`
      : item.relPath;
    if (item.kind === 'album' && item.action === 'download') {
      const onDevice = Number.isFinite(req.body.tracksOnDevice) ? req.body.tracksOnDevice : item.tracks;
      try { db.recordPush(item.artist, item.album, onDevice, item.sizeMB); } catch (_) {}
    }
    try {
      db.logActivity('push', item.action === 'delete' ? 'deleted-on-device' : (item.kind === 'playlist' ? 'playlist-pushed' : 'pushed'),
        subject, { via: 'wheelhouse', tracks: item.tracks, sizeMB: item.sizeMB });
    } catch (_) {}
  } else if (status === 'error') {
    try { db.logActivity('push', 'device-download-failed', item.relPath, { via: 'wheelhouse', error }); } catch (_) {}
  }
  res.json({ ok: true });
});

// POST /api/wheelhouse/inventory
// { albums: [{ artist, album, tracks, sizeMB, relPath? }], playlists?: [name], freeMB?, totalMB? }
// What is actually on the R4. Replaces the device album list and completes a
// "Scan device" request from the dashboard.
router.post('/inventory', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.albums)) return res.status(400).json({ ok: false, error: 'albums array required' });
  if (body.albums.length > 50000) return res.status(413).json({ ok: false, error: 'Too many albums' });

  const albums = [];
  for (const a of body.albums) {
    if (!a || typeof a !== 'object') continue;
    const artist = String(a.artist || '').slice(0, 512);
    const album  = String(a.album  || '').slice(0, 512);
    if (!artist && !album) continue;
    albums.push({
      key:    artist && album ? `${artist} — ${album}` : (album || artist),
      name:   album || artist,
      artist,
      album,
      tracks: Number.isFinite(a.tracks) ? a.tracks : 0,
      sizeMB: Number.isFinite(a.sizeMB) ? a.sizeMB : 0,
      relPath: typeof a.relPath === 'string' ? a.relPath.slice(0, 1024) : undefined,
    });
  }
  const playlists = Array.isArray(body.playlists)
    ? body.playlists.filter(p => typeof p === 'string').map(p => p.slice(0, 256)).slice(0, 5000)
    : null;

  try {
    db.setAlbums('device-mtp', albums);
    db.setDeviceScanStatus({ status: 'done', scannedAt: new Date().toISOString(), albumCount: albums.length, connected: true });
    db.setScanWanted(false);
    if (Number.isFinite(body.freeMB) || Number.isFinite(body.totalMB)) {
      db.recordHeartbeat({ freeMB: body.freeMB, totalMB: body.totalMB, ip: req.ip });
    }
    if (playlists) devicePlaylistsCache.set(playlists);
    db.logActivity('sync', 'device-inventory', null, { albums: albums.length, playlists: playlists ? playlists.length : null, via: 'wheelhouse' });
    res.json({ ok: true, albums: albums.length });
  } catch (e) {
    console.error('[wheelhouse/inventory]', e.message);
    res.status(500).json({ ok: false, error: 'Could not save inventory' });
  }
});

// GET /api/wheelhouse/library?q=&limit=&offset= — browse the library from the R4
router.get('/library', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let albums = [];
  try { albums = db.getAlbums('library'); } catch (_) {}
  const mapped = [];
  for (const a of albums) {
    const relPath = r2.relFromLibrary(config, a.path);
    if (!relPath) continue;
    if (q && !(`${a.artist} ${a.album} ${a.name}`.toLowerCase().includes(q))) continue;
    mapped.push({ key: a.key, artist: a.artist || '', album: a.album || a.name, relPath, tracks: a.tracks, genre: a.genre || null, addedAt: a.addedAt || null });
  }
  res.json({ ok: true, total: mapped.length, albums: mapped.slice(offset, offset + limit) });
});

// POST /api/wheelhouse/request { relPath } — queue an album picked on the R4
router.post('/request', (req, res) => {
  const rel = req.body && req.body.relPath;
  const abs = r2.absFromRel(config, rel);
  if (!abs) return res.status(400).json({ ok: false, error: 'Invalid relPath' });
  const files = listAlbumFiles(abs);
  if (!files || !files.some(f => f.audio)) return res.status(404).json({ ok: false, error: 'No album at that path' });
  let match = null;
  try { match = db.getAlbums('library').find(a => a.path === abs) || null; } catch (_) {}
  const segs = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  const item = {
    kind: 'album', action: 'download', relPath: segs.join('/'),
    artist: (match && match.artist) || (segs.length > 1 ? segs[segs.length - 2] : ''),
    album:  (match && (match.album || match.name)) || segs[segs.length - 1],
    tracks: files.filter(f => f.audio).length,
    sizeMB: Math.round(files.reduce((s, f) => s + f.size, 0) / 1048576 * 10) / 10,
  };
  const { items } = db.enqueueDevice([item]);
  try { db.logActivity('push', 'queued-for-device', `${item.artist} — ${item.album}`, { via: 'wheelhouse-request' }); } catch (_) {}
  res.json({ ok: true, id: items[0].id });
});

// GET /api/wheelhouse/file?path=<relPath> — one library file. Redirects to a
// signed R2 link when R2 is configured; otherwise streams it (Range supported).
router.get('/file', async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = r2.absFromRel(config, rel);
  if (!abs) return res.status(400).json({ ok: false, error: 'Invalid path' });
  const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (r2.isConfigured(config) && req.query.stream !== '1') {
    try { return res.redirect(302, await r2.presignRel(config, cleanRel)); }
    catch (e) { console.warn('[wheelhouse/file] presign failed:', e.message); }
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ ok: false, error: 'Not found' });
    res.sendFile(abs, { dotfiles: 'deny', acceptRanges: true });
  });
});

// Playlists the R4 last reported, for the dashboard's device-playlist view.
const devicePlaylistsCache = {
  _list: null, _at: null,
  set(list) { this._list = list; this._at = new Date().toISOString(); },
  get() { return { playlists: this._list, reportedAt: this._at }; },
};

module.exports = router;
module.exports.devicePlaylists = () => devicePlaylistsCache.get();
module.exports.listPlaylists   = listPlaylists;
module.exports.API_VERSION     = API_VERSION;
