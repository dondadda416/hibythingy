// ── Device route — HiBy R4 via Wheelhouse (Wi-Fi) ───────────────────────────
// Hub no longer talks to the R4 over USB. Instead:
//   - "Push to HiBy" adds the album to a download queue (db.device_queue).
//   - Wheelhouse on the R4 checks in over Wi-Fi (routes/wheelhouse.js),
//     downloads queued albums straight from R2, and reports each one done.
//   - "Scan device" asks Wheelhouse to send its album list on its next check-in.
// The response shapes below match what the old USB endpoints returned, so the
// dashboard keeps working; jobs simply sit at "queued" until the R4 syncs.
'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');

const normalise = require('../lib/normalise');
const { resolveUnder }        = require('../lib/safePath');
const { validateBody }        = require('../lib/validate');
const { DevicePushBody, DevicePushBatchBody } = require('../lib/schemas');
const db                      = require('../lib/db');
const r2                      = require('../lib/r2');
const { isAudioFile }         = require('../lib/walk');

// Is the R4 "connected"? Now means: Wheelhouse checked in recently.
async function getStatus() {
  let hb = null;
  try { hb = db.getHeartbeat(); } catch (_) {}
  const name = (hb && hb.deviceName) || config.DEVICE_NAME || 'R4';
  if (!hb || !hb.lastSeenMs) {
    return { connected: false, name, via: 'wheelhouse', lastSeen: null,
      message: 'Wheelhouse has not checked in yet.' };
  }
  const ageMs = Date.now() - hb.lastSeenMs;
  const online = ageMs <= (config.WHEELHOUSE_ONLINE_MINUTES || 10) * 60 * 1000;
  return {
    connected:  online,
    name,
    via:        'wheelhouse',
    lastSeen:   hb.lastSeen,
    appVersion: hb.appVersion,
    freeMB:     hb.freeMB,
    totalMB:    hb.totalMB,
    queued:     safeOpenQueueCount(),
  };
}

function safeOpenQueueCount() {
  try { return db.getOpenQueue().length; } catch (_) { return 0; }
}

// Read the timestamp of the last successful MTP scan. Used to decide which
// push-log entries are "verifiable" against the scan.
function getLastScanTime() {
  try {
    const s = db.getDeviceScanStatus() || {};
    if (!s.scannedAt) return null;
    const t = Date.parse(s.scannedAt);
    return Number.isFinite(t) ? t : null;
  } catch (_) { return null; }
}

// Build a Set of normalised keys for everything currently believed to be on
// the device (post-filter via getCachedAlbums). Used for backlog match +
// duplicate skip.
function getDeviceNormKeys() {
  const keys = new Set();
  for (const a of getCachedAlbums()) {
    if (a.key) keys.add(normalise(a.key));
    if (a.name) keys.add(normalise(a.name));
    if (a.artist && a.album) keys.add(normalise(`${a.artist} \u2014 ${a.album}`));
  }
  return keys;
}

// Return true if this artist+album combination is already on the device
function isAlreadyOnDevice(artist, album) {
  const keys = getDeviceNormKeys();
  if (keys.size === 0) return false;  // no data — can't confirm, allow push
  const candidate = normalise(`${artist} \u2014 ${album}`);
  const albumOnly = normalise(album);
  return keys.has(candidate) || keys.has(albumOnly);
}

// Return device album list. The two sources are merged with MTP scan as the
// authoritative truth and the push log as a hint that's only trusted when the
// scan can't disprove it:
//
//   - MTP scan entries           -> kept, _verified: true.
//   - Push log AFTER last scan   -> kept, _verified: false (pending).
//   - Push log BEFORE last scan
//     but missing from the scan  -> dropped. These are pushes that Hub claimed
//                                   worked but the device disagrees. Counting
//                                   them as "on device" is what made the
//                                   dashboard say "fully in sync" while songs
//                                   weren't actually on the player.
//   - No scan has ever run       -> trust everything in the push log (no
//                                   ground truth to compare against).
function getCachedAlbums() {
  const albumMap = new Map();
  const scanTime = getLastScanTime();
  const hasScan  = scanTime !== null;

  // MTP scan: authoritative when present.
  try {
    for (const a of db.getAlbums('device-mtp')) {
      if (a.key) albumMap.set(a.key, { ...a, _source: 'mtp-scan', _verified: true });
    }
  } catch (e) { console.warn('[device/cached]', e.message); }

  // Push log: only the entries the scan hasn't disproven.
  const log = loadPushLog();
  for (const a of (log.albums || [])) {
    if (!a.key || albumMap.has(a.key)) continue;  // scan already confirmed
    if (!hasScan) {
      albumMap.set(a.key, { ...a, _source: 'push-log', _verified: false });
      continue;
    }
    const pushedAt = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    if (pushedAt > scanTime) {
      // Pushed after last scan -> pending verification, count as on-device.
      albumMap.set(a.key, { ...a, _source: 'push-log-pending', _verified: false });
    }
    // else: pushed before scan, scan didn't see it -> confirmed missing, drop.
  }
  return Array.from(albumMap.values());
}

// ── Push log helpers ──────────────────────────────────────────────────────────

function loadPushLog() {
  try { return db.getPushLog(); }
  catch (e) { console.warn('[device/pushlog]', e.message); return { albums: [], albumCount: 0 }; }
}


// ── Queue helpers ─────────────────────────────────────────────────────────────

// Count audio tracks + total size of an album folder (one level, like the
// library scan). Reads go through the rclone directory cache, so this is cheap.
function measureAlbum(absPath) {
  let tracks = 0, bytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { bytes += fs.statSync(path.join(absPath, e.name)).size; } catch (_) {}
    if (isAudioFile(e.name)) tracks++;
  }
  return { tracks, sizeMB: Math.round(bytes / 1048576 * 10) / 10 };
}

// Map a queue row onto the job shape the dashboard already understands.
function queueItemToJob(q) {
  const finished = ['done', 'error', 'cancelled'].includes(q.status);
  return {
    id:         q.id,
    batchId:    q.batchId,
    kind:       q.kind,
    action:     q.action,
    artist:     q.artist,
    album:      q.album,
    relPath:    q.relPath,
    sourcePath: q.kind === 'album' ? path.join(config.LIBRARY_PATH, ...q.relPath.split('/')) : null,
    status:     q.status === 'cancelled' ? 'error' : q.status,
    cancelled:  q.status === 'cancelled' || undefined,
    queued:     true,
    tracks:     q.tracks,
    sizeMB:     q.sizeMB,
    error:      q.status === 'cancelled' ? 'Cancelled' : q.error,
    startedAt:  q.createdAt,
    finishedAt: finished ? q.updatedAt : null,
  };
}

// Validate one push request and turn it into a queue item, or return
// { error } explaining why it can't be queued.
function buildAlbumQueueItem({ sourcePath: supplied, artist, album }) {
  const libPath = resolveUnder(supplied, [config.LIBRARY_PATH]);
  if (!libPath) {
    const inInbox = resolveUnder(supplied, [config.INBOX_PATH]);
    return { error: inInbox
      ? 'This album is still in the inbox. Move it into the library first; the R4 downloads from the library.'
      : 'Source path is not in the library.' };
  }
  const rel = r2.relFromLibrary(config, libPath);
  if (!rel) return { error: 'Source path is not in the library.' };
  const m = measureAlbum(libPath);
  if (!m) return { error: 'Album folder not found.' };
  if (m.tracks === 0) return { error: 'No audio files in that folder.' };
  return { item: { kind: 'album', action: 'download', relPath: rel, artist: artist || '', album: album || '', tracks: m.tracks, sizeMB: m.sizeMB } };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/device/status — has Wheelhouse checked in recently?
router.get('/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/device/files — merge MTP scan + push log so nothing is missed.
// MTP scan gives the baseline (what was already on the device before Hub).
// Push log adds albums Hub has pushed since the last scan.
// Together they give the most complete picture of what's on the device.
router.get('/files', (req, res) => {
  const albumMap = new Map();  // key → album object (deduped by key)

  // Layer 1: MTP scan (baseline)
  try {
    for (const a of db.getAlbums('device-mtp')) {
      if (a.key) albumMap.set(a.key, a);
    }
  } catch (e) { console.warn('[device/files]', e.message); }

  // Layer 2: Push log (albums Hub has pushed — these override/add to the scan)
  const log = loadPushLog();
  if (Array.isArray(log.albums)) {
    for (const a of log.albums) {
      if (a.key) albumMap.set(a.key, a);
    }
  }

  if (albumMap.size === 0) {
    return res.json({ albums: [], albumCount: 0, fromCache: false, source: 'none',
      message: 'No data yet. Tap Scan Device (Wheelhouse reports its albums on its next sync), or push an album.' });
  }

  const albums = Array.from(albumMap.values()).sort((a, b) => (a.key || '').localeCompare(b.key || ''));
  res.json({ albums, albumCount: albums.length, fromCache: true, source: 'merged' });
});

// POST /api/device/scan — ask Wheelhouse for its album list. It answers on its
// next check-in (POST /api/wheelhouse/inventory), which flips the status to
// 'done'. The dashboard polls /scan-status exactly as it did for USB scans.
router.post('/scan', (req, res) => {
  const startedAt = new Date().toISOString();
  try {
    db.setScanWanted(true);
    db.setDeviceScanStatus({ status: 'scanning', startedAt, scannedAt: null });
  } catch (e) {
    return res.status(500).json({ error: 'Could not request a scan' });
  }
  res.json({ status: 'scanning', startedAt,
    message: 'Asked the R4 for its album list. Open Wheelhouse on the R4 (Wi-Fi on) and it will report in.' });
});

// GET /api/device/scan-status — returns current scan state from DB
router.get('/scan-status', (req, res) => {
  try {
    res.json(db.getDeviceScanStatus());
  } catch (_) {
    res.json({ status: 'none' });
  }
});

// ── Push = add to the Wheelhouse download queue ────────────────────────────────

// GET /api/device/push — recent queue items in the old "jobs" shape
router.get('/push', (req, res) => {
  try { db.tidyQueue(); } catch (_) {}
  let items = [];
  try { items = db.getRecentQueue(200); } catch (_) {}
  res.json({ jobs: items.map(queueItemToJob), queued: safeOpenQueueCount() });
});

// POST /api/device/push  { sourcePath, artist, album, force }
router.post('/push', validateBody(DevicePushBody), (req, res) => {
  const { artist, album, force } = req.body;

  if (!force && isAlreadyOnDevice(artist, album)) {
    return res.json({
      ok: true, skipped: true, reason: 'already_on_device', artist, album,
      message: `"${artist} — ${album}" is already on your HiBy — skipped.`,
    });
  }

  const built = buildAlbumQueueItem(req.body);
  if (built.error) return res.status(400).json({ ok: false, error: built.error });

  try {
    const { items } = db.enqueueDevice([built.item]);
    const job = items[0];
    db.logActivity('push', 'queued-for-device', `${artist} — ${album}`, { tracks: job.tracks, sizeMB: job.sizeMB });
    res.json({
      ok: true, queued: true, jobId: job.id, status: 'queued',
      message: `Queued "${artist} — ${album}" for the R4. It downloads the next time Wheelhouse syncs.`,
    });
  } catch (e) {
    console.error('[device/push]', e.message);
    res.status(500).json({ ok: false, error: 'Could not queue album' });
  }
});

// POST /api/device/push-batch  { albums: [{ sourcePath, artist, album, force }] }
router.post('/push-batch', validateBody(DevicePushBatchBody), (req, res) => {
  const toQueue = [];
  const problems = [];
  let skipped = 0;
  for (const a of req.body.albums) {
    if (!a.force && isAlreadyOnDevice(a.artist, a.album)) { skipped++; continue; }
    const built = buildAlbumQueueItem(a);
    if (built.error) problems.push({ artist: a.artist, album: a.album, error: built.error });
    else toQueue.push(built.item);
  }

  if (toQueue.length === 0) {
    return res.json({
      ok: problems.length === 0, queued: true, batchId: null, total: 0, skipped, problems,
      error: problems.length ? problems[0].error : undefined,
      message: skipped ? `All ${skipped} album(s) are already on the R4.` : 'Nothing to queue.',
    });
  }

  try {
    const { batchId, items } = db.enqueueDevice(toQueue);
    db.logActivity('push', 'queued-for-device', `${items.length} album(s)`, { batchId, skipped, problems: problems.length });
    res.json({
      ok: true, queued: true, batchId, total: items.length, skipped, problems,
      message: `Queued ${items.length} album(s) for the R4. They download the next time Wheelhouse syncs.`,
    });
  } catch (e) {
    console.error('[device/push-batch]', e.message);
    res.status(500).json({ ok: false, error: 'Could not queue albums' });
  }
});

// GET /api/device/queue — what the R4 still has to fetch
router.get('/queue', (req, res) => {
  try {
    const open = db.getOpenQueue();
    res.json({ ok: true, items: open.map(queueItemToJob), count: open.length,
      totalMB: Math.round(open.reduce((s, q) => s + (q.sizeMB || 0), 0)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not read queue' });
  }
});

// DELETE /api/device/queue/:id — cancel a queued item
router.delete('/queue/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = Number.isFinite(id) ? db.getQueueItem(id) : null;
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
  if (!['queued', 'running'].includes(item.status)) {
    return res.status(409).json({ ok: false, error: `Already ${item.status}` });
  }
  db.setQueueStatus(id, 'cancelled', null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.getStatus       = getStatus;
module.exports.getCachedAlbums = getCachedAlbums;
module.exports.queueItemToJob  = queueItemToJob;
