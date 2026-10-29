// ── Sync route — computes backlog (master library minus device) ───────────────
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const libraryRoute = require('./library');
const deviceRoute  = require('./device');
const inboxRoute   = require('./inbox');

const normalise          = require('../lib/normalise');
const { getBestFormat, getRank, AUDIO_EXTS } = require('../lib/format');
const db                 = require('../lib/db');

function loadQuarantinedPaths() {
  try { return db.getSyncQuarantinedPaths(); }
  catch (_) { return new Set(); }
}

// Build the backlog: albums in the master library that are NOT on the device.
// Also returns the reverse (on device, not in master) for the "orphan" list.
function computeBacklog(libData, deviceAlbums) {
  if (!libData || !libData.albums) {
    return { backlog: [], orphans: [], backlogCount: 0, syncedCount: 0, deviceScanned: false };
  }

  // Build a Map of normalised device album names → original device album entry
  const deviceMap = new Map();
  for (const a of (deviceAlbums || [])) {
    const k = normalise(a.key || a.name || '');
    if (k) deviceMap.set(k, a);
    // Push-log entries record key as "Artist — Album" but the library key for flat
    // folders is just the folder name. Also index by album name alone so they match.
    if (a.album) {
      const albumOnly = normalise(a.album);
      if (albumOnly) deviceMap.set(albumOnly, a);
    }
    // Also index by name alone in case key and name differ
    if (a.name && a.name !== a.key) {
      const nameOnly = normalise(a.name);
      if (nameOnly) deviceMap.set(nameOnly, a);
    }
  }
  const deviceScanned = deviceMap.size > 0;

  const backlog = [];
  const synced  = [];

  for (const album of libData.albums) {
    const norm = normalise(album.key || album.name || '');
    if (deviceScanned && deviceMap.has(norm)) {
      synced.push({ ...album, _matchedTo: deviceMap.get(norm).key || deviceMap.get(norm).name || '?' });
    } else {
      backlog.push(album);
    }
  }

  // Orphans: on device but not in master
  const libKeys = new Set(libData.albums.map(a => normalise(a.key || a.name || '')));
  const orphans = (deviceAlbums || []).filter(a => !libKeys.has(normalise(a.key || a.name || '')));

  // Filter out quarantined library items and sort (newest first)
  const quarantinedPaths = loadQuarantinedPaths();
  const filtered = (quarantinedPaths.size > 0
    ? backlog.filter(a => !quarantinedPaths.has(a.path))
    : backlog.slice()                        // .slice() avoids mutating the original
  ).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  return {
    backlog:        filtered,
    synced,
    orphans,
    backlogCount:   filtered.length,
    syncedCount:    synced.length,
    orphanCount:    orphans.length,
    totalInLibrary: libData.albumCount || 0,
    deviceScanned,
    note: deviceScanned ? null : 'Device not scanned yet — all library albums shown as backlog.',
  };
}

// Lightweight version for /api/status
function getBacklogCount(libData, deviceAlbums) {
  try {
    if (!libData) libData = libraryRoute.getCache();
    if (!deviceAlbums) deviceAlbums = deviceRoute.getCachedAlbums();
    const r = computeBacklog(libData, deviceAlbums);
    return { count: r.backlogCount, deviceScanned: r.deviceScanned };
  } catch (e) {
    return { count: 0, error: e.message };
  }
}

// GET /api/sync/backlog
router.get('/backlog', (req, res) => {
  try {
    const libData      = libraryRoute.getCache();
    const deviceAlbums = deviceRoute.getCachedAlbums();
    const result       = computeBacklog(libData, deviceAlbums);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/find?q=<search>
// Diagnostic: searches every data source for an album name so the user can see
// exactly where it is (or isn't) — library cache, device cache, quarantine, inbox.
router.get('/find', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const results = {
    query: q,
    library:    [],
    device:     [],
    quarantine: [],
    inbox:      [],
  };

  // ── 1. Library cache ────────────────────────────────────────────────────────
  try {
    const libData = libraryRoute.getCache();
    if (libData && libData.albums) {
      for (const a of libData.albums) {
        const name = (a.key || a.name || '');
        if (name.toLowerCase().includes(q)) {
          results.library.push({ name, path: a.path || '', addedAt: a.addedAt || null });
        }
      }
    }
  } catch (e) {
    results.libraryError = e.message;
  }

  // ── 2. Device cache (merged push log + MTP scan) ────────────────────────────
  try {
    const deviceAlbums = deviceRoute.getCachedAlbums();
    for (const a of (deviceAlbums || [])) {
      const name = (a.key || a.name || '');
      if (name.toLowerCase().includes(q)) {
        results.device.push({ name, source: a._source || 'unknown' });
      }
    }
  } catch (e) {
    results.deviceError = e.message;
  }

  // ── 3. Quarantine ────────────────────────────────────────────────────────────
  try {
    const data = db.getQuarantine();
    for (const item of (data.items || [])) {
      const name = (item.name || '');
      if (name.toLowerCase().includes(q)) {
        results.quarantine.push({ name, path: item.path || '', type: item.type || '', reason: item.reason || '', quarantinedAt: item.quarantinedAt || null });
      }
    }
  } catch (_) {}

  // ── 4. Inbox folder scan ─────────────────────────────────────────────────────
  try {
    if (fs.existsSync(config.INBOX_PATH)) {
      const entries = fs.readdirSync(config.INBOX_PATH, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.toLowerCase().includes(q)) {
          const fullPath = path.join(config.INBOX_PATH, e.name);
          let mtime = null;
          try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
          results.inbox.push({ name: e.name, path: fullPath, mtime });
        }
      }
    }
  } catch (e) {
    results.inboxError = e.message;
  }

  // ── 5. Library folder scan (in case cache is stale) ──────────────────────────
  results.libraryFolders = [];
  try {
    if (fs.existsSync(config.LIBRARY_PATH)) {
      const entries = fs.readdirSync(config.LIBRARY_PATH, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.toLowerCase().includes(q)) {
          results.libraryFolders.push({ name: e.name, path: path.join(config.LIBRARY_PATH, e.name) });
        }
      }
    }
  } catch (e) {
    results.libraryFoldersError = e.message;
  }

  res.json(results);
});

// GET /api/sync/peek?path=<abs path>
// Read-only: list the immediate contents of a quarantined folder so we can see
// what's actually inside (audio track count, file types) before deciding to
// rename, import, or discard. Guarded: the path MUST match a current quarantine
// entry — this endpoint cannot be pointed at arbitrary filesystem locations.
//
// Uses ASYNC fs (fs.promises) throughout so a slow drive can't block Node's
// single event loop and wedge the whole server — an earlier synchronous
// version did exactly that when several peeks ran at once.
const fsp = require('fs').promises;
router.get('/peek', async (req, res) => {
  const target = (req.query.path || '').toString();
  if (!target) return res.status(400).json({ error: 'path required' });

  const quar    = (db.getQuarantine().items) || [];
  const allowed = quar.some(q => q.path === target);
  if (!allowed) return res.status(403).json({ error: 'Path is not a quarantined item' });

  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) {
      return res.json({
        ok: true, path: target, isFile: true,
        name: path.basename(target),
        ext:  path.extname(target).toLowerCase(),
        sizeMB: +(st.size / 1048576).toFixed(2),
        audioCount: 0, byExt: {}, entries: [],
      });
    }

    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];
    const byExt   = {};
    let audioCount = 0, audioBytes = 0;

    // Stat files concurrently but bounded; await all so we never block the loop.
    await Promise.all(dirents.map(async d => {
      const full = path.join(target, d.name);
      let size = 0;
      try { size = (await fsp.stat(full)).size; } catch (_) {}
      const ext = d.isDirectory() ? '<dir>' : path.extname(d.name).toLowerCase();
      byExt[ext] = (byExt[ext] || 0) + 1;
      if (!d.isDirectory() && AUDIO_EXTS.has(ext)) { audioCount++; audioBytes += size; }
      entries.push({ name: d.name, dir: d.isDirectory(), ext, sizeMB: +(size / 1048576).toFixed(2) });
    }));

    res.json({
      ok: true, path: target, name: path.basename(target),
      audioCount, audioMB: +(audioBytes / 1048576).toFixed(1),
      totalEntries: dirents.length, byExt,
      entries: entries.slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sync/rename  { path, newName }
// Rename a quarantined folder in place (same parent directory) to a clean
// "Artist - Album" name. Guarded to quarantine paths; refuses if the target
// already exists. Keeps the quarantine record consistent so the entry tracks
// the new location.
router.post('/rename', (req, res) => {
  const { path: target, newName } = req.body || {};
  if (!target || !newName) return res.status(400).json({ error: 'path and newName required' });

  const quar  = (db.getQuarantine().items) || [];
  const entry = quar.find(q => q.path === target);
  if (!entry) return res.status(403).json({ error: 'Path is not a quarantined item' });

  // Strip characters illegal in Windows folder names and trailing dots/spaces.
  const safe = newName.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  if (!safe) return res.status(400).json({ error: 'Invalid new name' });

  const parent = path.dirname(target);
  const dest   = path.join(parent, safe);
  if (dest === target) return res.json({ ok: true, unchanged: true, name: safe });
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A folder with that name already exists' });

  try {
    fs.renameSync(target, dest);
    db.removeQuarantineByPath(target);
    db.addQuarantine({ name: safe, path: dest, reason: entry.reason || '', type: entry.type || 'inbox' });
    db.logActivity('quarantine', 'renamed', safe, { from: entry.name, to: safe });
    res.json({ ok: true, from: target, to: dest, name: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recursive async copy — fallback for Node builds without fsp.cp.
async function copyDirAsync(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDirAsync(s, d);
    else                 await fsp.copyFile(s, d);
  }
}

// POST /api/sync/import-to-library  { path, name }
// Copy a quarantined folder into the master library under a clean
// "Artist - Album" name so it becomes part of the library (and can then sync to
// the device). The original folder (e.g. a backup copy) is left untouched.
// Guarded to quarantine paths; refuses to overwrite an existing library folder.
// Clears the quarantine record on success. Uses async fs throughout so a large
// copy can't block the event loop.
router.post('/import-to-library', async (req, res) => {
  const { path: target, name } = req.body || {};
  if (!target || !name) return res.status(400).json({ error: 'path and name required' });

  const quar  = (db.getQuarantine().items) || [];
  const entry = quar.find(q => q.path === target);
  if (!entry) return res.status(403).json({ error: 'Path is not a quarantined item' });

  if (!fs.existsSync(config.LIBRARY_PATH)) return res.status(500).json({ error: 'Library path not found' });

  const safe = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  if (!safe) return res.status(400).json({ error: 'Invalid name' });

  const dest = path.join(config.LIBRARY_PATH, safe);
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'Already in library: ' + safe });

  try {
    if (typeof fsp.cp === 'function') await fsp.cp(target, dest, { recursive: true });
    else                              await copyDirAsync(target, dest);

    db.removeQuarantineByPath(target);
    db.logActivity('move', 'imported-to-library', safe, { from: target, to: dest });
    res.json({ ok: true, from: target, to: dest, name: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sync/upgrades — inbox items that are better formats than the library copy
router.get('/upgrades', (req, res) => {
  try {
    const libData     = libraryRoute.getCache();
    const inboxItems  = inboxRoute.getAllItems();

    if (!libData || !libData.albums) return res.json({ upgrades: [] });

    // Build normalised library map: normKey → album entry + current format
    const libMap = new Map();
    for (const a of libData.albums) {
      const k = normalise(a.key || a.name || '');
      if (!k) continue;
      const fmt = getBestFormat(a.path);
      libMap.set(k, { ...a, currentFormat: fmt });
    }

    const upgrades = [];
    for (const item of inboxItems) {
      const k = normalise(item.name || '');
      if (!k || !libMap.has(k)) continue;      // not in library — it's just a backlog item
      const libAlbum = libMap.get(k);
      const inboxFmt = getBestFormat(item.path);
      if (!inboxFmt || !libAlbum.currentFormat) continue;
      if (getRank(inboxFmt.format) > getRank(libAlbum.currentFormat.format)) {
        upgrades.push({
          name:          item.name,
          inboxPath:     item.path,
          libraryPath:   libAlbum.path,
          inboxFormat:   inboxFmt.format,
          libraryFormat: libAlbum.currentFormat.format,
          tracks:        item.tracks || 0,
          sizeMB:        item.sizeMB || 0,
        });
      }
    }

    res.json({ upgrades, count: upgrades.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/space-plan — backlog with per-album sizes for the space planner
router.get('/space-plan', (req, res) => {
  try {
    const libData      = libraryRoute.getCache();
    const deviceAlbums = deviceRoute.getCachedAlbums();
    const { backlog }  = computeBacklog(libData, deviceAlbums);

    const albums = backlog.map(a => {
      let sizeMB = 0;
      if (a.path) {
        try {
          const files = fs.readdirSync(a.path, { withFileTypes: true });
          let bytes = 0;
          for (const f of files) {
            if (f.isFile()) {
              try { bytes += fs.statSync(path.join(a.path, f.name)).size; } catch (_) {}
            }
          }
          sizeMB = +(bytes / 1e6).toFixed(1);
        } catch (_) {}
      }
      return {
        name:    a.name,
        artist:  a.artist  || '',
        key:     a.key     || '',
        path:    a.path    || '',
        tracks:  a.tracks  || 0,
        addedAt: a.addedAt || 0,
        sizeMB,
      };
    });

    const totalMB = +albums.reduce((s, a) => s + a.sizeMB, 0).toFixed(1);
    res.json({ albums, count: albums.length, totalMB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.getBacklogCount = getBacklogCount;
module.exports.computeBacklog  = computeBacklog;
