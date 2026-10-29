// ── Library route — scans master library on external drive ───────────────────
'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const db      = require('../lib/db');
const { mapLimit, isAudioFile, readDirEntries, statOrNull } = require('../lib/walk');
// Lazy-loaded so a missing/broken music-metadata install doesn't kill the
// whole route module — genre extraction is best-effort.
let _mm = null;
function getMM() {
  if (_mm === null) {
    try { _mm = require('music-metadata'); }
    catch (e) { console.warn('[library] music-metadata not available, genre disabled:', e.message); _mm = false; }
  }
  return _mm || null;
}

let _scanRunning = false;
let _lastScannedAt = null;

async function countAudio(folderPath) {
  const entries = await readDirEntries(folderPath);
  if (!entries) return 0;
  return entries.filter(f => f.isFile() && isAudioFile(f.name)).length;
}

async function getMtime(p) {
  const st = await statOrNull(p);
  return st ? st.mtimeMs : 0;
}

// Pick the first audio file in an album folder. Used as the representative
// track for tag-based metadata extraction.
async function firstAudioFile(folderPath) {
  const entries = await readDirEntries(folderPath);
  if (!entries) return null;
  const audio = entries.filter(e => e.isFile() && isAudioFile(e.name))
                       .map(e => e.name).sort();
  return audio.length ? path.join(folderPath, audio[0]) : null;
}

// Normalise a free-text genre tag. Trims whitespace, collapses spaces, drops
// obvious junk values, and picks the FIRST entry when multiple are encoded
// with a separator (";", "/", "|", ",", or NUL). Returns null when the value
// isn't useful.
function normaliseGenre(raw) {
  if (raw == null) return null;
  let s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!s) return null;
  // Many taggers cram multiple genres into one string; take the first.
  s = s.split(/\s*[;/|,\x00]\s*/)[0].trim();
  if (!s) return null;
  // Strip ID3v1-style "(17)" numeric refs that occasionally leak through.
  s = s.replace(/^\(\d+\)\s*/, '').trim();
  if (!s || /^\d+$/.test(s)) return null;          // bare numeric → drop
  if (/^(unknown|other|n\/a|none)$/i.test(s)) return null;
  // Title-case for consistency, but preserve all-caps acronyms (e.g. "R&B").
  return s.length > 64 ? s.slice(0, 64) : s;
}

// Read genre from the first audio file's tags. Returns null on any failure.
async function readAlbumGenre(albumPath) {
  const mm = getMM();
  if (!mm) return null;
  const file = await firstAudioFile(albumPath);
  if (!file) return null;
  try {
    const meta = await mm.parseFile(file, { duration: false, skipCovers: true });
    return normaliseGenre(meta && meta.common && meta.common.genre);
  } catch (_) { return null; }
}

// Walk the master library. Handles two layouts:
//   Flat:   complete/Artist - Album/track.flac
//   Nested: complete/Artist/Album/track.flac
// Returns a normalised list of { key, name, artist, album, tracks, path }
async function scanLibrary() {
  const libPath = config.LIBRARY_PATH;

  const topEntries = await readDirEntries(libPath);
  if (!topEntries) {
    return { ok: false, error: `Library not found: ${libPath}`, albums: [], albumCount: 0, trackCount: 0 };
  }

  const albums = [];
  const topDirs = topEntries.filter(e => e.isDirectory());

  // Process up to 4 top-level folders concurrently.
  await mapLimit(topDirs, 4, async top => {
    const topPath = path.join(libPath, top.name);
    const children = await readDirEntries(topPath);
    if (!children) return;

    const subDirs  = children.filter(c => c.isDirectory());
    const hasAudio = children.some(c => c.isFile() && isAudioFile(c.name));

    if (hasAudio || subDirs.length === 0) {
      // Flat: this folder IS the album
      const tracks = children.filter(c => c.isFile() && isAudioFile(c.name)).length;
      albums.push({
        key: top.name, name: top.name, artist: '', album: top.name,
        tracks, path: topPath, addedAt: await getMtime(topPath),
      });
      return;
    }

    // Nested — look one level deeper
    await mapLimit(subDirs, 4, async sub => {
      const subPath = path.join(topPath, sub.name);
      const subChildren = await readDirEntries(subPath);
      if (!subChildren) return;

      const subSubDirs  = subChildren.filter(c => c.isDirectory());
      const subHasAudio = subChildren.some(c => c.isFile() && isAudioFile(c.name));

      if (subHasAudio || subSubDirs.length === 0) {
        // Level 2: Artist / Album
        const tracks = subChildren.filter(f => f.isFile() && isAudioFile(f.name)).length;
        const key = `${top.name} — ${sub.name}`;
        albums.push({
          key, name: sub.name, artist: top.name, album: sub.name,
          tracks, path: subPath, addedAt: await getMtime(subPath),
        });
        return;
      }

      // Level 3: Container / Artist / Album (e.g. RAW SLSK DLs / archiveb / Pink Elephant)
      await mapLimit(subSubDirs, 4, async deep => {
        const deepPath   = path.join(subPath, deep.name);
        const deepTracks = await countAudio(deepPath);
        if (deepTracks === 0) return;
        albums.push({
          key: deep.name, name: deep.name, artist: sub.name, album: deep.name,
          tracks: deepTracks, path: deepPath, addedAt: await getMtime(deepPath),
        });
      });
    });
  });

  // ── Genre enrichment ────────────────────────────────────────────────────
  // Read the first audio file's tags per album to extract genre. Each parse
  // is just a tag-header read (no full audio decode), so a couple-hundred
  // albums on an external drive completes in seconds at concurrency 8.
  // Errors per album are swallowed: genre is best-effort, not load-bearing.
  //
  // On the server the library is an rclone mount of R2, where every tag read
  // is a network fetch. So reuse the genre from the previous scan whenever an
  // album folder is unchanged (same path, same modified time) and only read
  // tags for new or edited albums.
  const previous = new Map();
  try {
    for (const p of db.getAlbums('library')) {
      if (p.path && Object.prototype.hasOwnProperty.call(p, 'genre')) previous.set(p.path, p);
    }
  } catch (_) { /* first scan or DB unavailable — read everything */ }

  let genreReads = 0;
  await mapLimit(albums, 8, async a => {
    const prior = previous.get(a.path);
    if (prior && prior.addedAt === a.addedAt) { a.genre = prior.genre; return; }
    genreReads++;
    try { a.genre = await readAlbumGenre(a.path); }
    catch (_) { a.genre = null; }
  });

  const scannedAtIso = new Date().toISOString();
  const stamped = albums.map(a => ({ ...a, scannedAt: scannedAtIso }));

  const result = {
    ok: true,
    albums: stamped,
    albumCount: stamped.length,
    trackCount: stamped.reduce((s, a) => s + a.tracks, 0),
    path: libPath,
    scannedAt: scannedAtIso,
    genreReads,
  };

  // Persist to SQLite. setAlbums replaces the entire 'library' set inside a
  // single transaction so readers never see a half-replaced library.
  try {
    db.setAlbums('library', stamped);
    _lastScannedAt = scannedAtIso;
    db.logActivity('scan', 'library-scanned', null, {
      albumCount: result.albumCount,
      trackCount: result.trackCount,
    });
  } catch (e) {
    console.warn('[library] Failed to write to DB:', e.message);
  }

  return result;
}

// Read the full library snapshot from SQLite. Shape matches the legacy
// cache/library.json so callers don't need updating.
function getCache() {
  try {
    const albums = db.getAlbums('library');
    if (albums.length === 0) return null;
    const { albumCount, trackCount } = db.getAlbumCount('library');
    return {
      ok:        true,
      albums,
      albumCount,
      trackCount,
      path:      config.LIBRARY_PATH,
      scannedAt: _lastScannedAt || (albums[0] && albums[0].scannedAt) || null,
    };
  } catch (e) {
    console.warn('[library/getCache]', e.message);
    return null;
  }
}

function getSummary() {
  try {
    const { albumCount, trackCount } = db.getAlbumCount('library');
    if (albumCount === 0) {
      return { albumCount: 0, trackCount: 0, ok: false, message: 'Not scanned yet', path: config.LIBRARY_PATH };
    }
    return { albumCount, trackCount, scannedAt: _lastScannedAt, ok: true, path: config.LIBRARY_PATH };
  } catch (e) {
    return { albumCount: 0, trackCount: 0, ok: false, error: e.message };
  }
}

// GET /api/library — return cached data (or empty if not scanned)
router.get('/', (req, res) => {
  const c = getCache();
  if (c) return res.json(c);
  res.json({ ok: false, message: 'Library not scanned yet. POST /api/library/scan to scan.', albums: [] });
});

// POST /api/library/scan — run a fresh scan (can take a few seconds for large libraries)
router.post('/scan', async (req, res) => {
  if (_scanRunning) {
    return res.status(409).json({ ok: false, error: 'Scan already in progress' });
  }
  _scanRunning = true;
  try {
    const result = await scanLibrary();
    res.json(result);
  } catch (err) {
    console.error('[library/scan]', err.message);
    res.status(500).json({ error: 'Library scan failed' });
  } finally {
    _scanRunning = false;
  }
});

// GET /api/library/albums — album list with stats
router.get('/albums', (req, res) => {
  const c = getCache();
  if (!c) return res.json({ albums: [], albumCount: 0, trackCount: 0, message: 'Run a library scan first.' });
  res.json({
    albums:     c.albums,
    albumCount: c.albumCount,
    trackCount: c.trackCount,
    scannedAt:  c.scannedAt,
  });
});

// GET /api/library/export — download full library as CSV or JSON
// ?format=csv (default) | json
router.get('/export', (req, res) => {
  const c = getCache();
  if (!c || !c.albums) return res.status(400).json({ error: 'Run a library scan first.' });

  const fmt = (req.query.format || 'csv').toLowerCase();

  if (fmt === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="hiby-library.json"');
    return res.json(c.albums.map(a => ({
      artist:  a.artist  || '',
      album:   a.name    || '',
      key:     a.key     || '',
      tracks:  a.tracks  || 0,
      path:    a.path    || '',
      addedAt: a.addedAt ? new Date(a.addedAt).toISOString() : '',
    })));
  }

  // CSV (RFC 4180 — values quoted)
  const q    = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Artist', 'Album', 'Tracks', 'Added', 'Path'].map(q).join(',')];
  for (const a of c.albums) {
    rows.push([
      q(a.artist  || ''),
      q(a.name    || ''),
      a.tracks    || 0,
      q(a.addedAt ? new Date(a.addedAt).toISOString().slice(0, 10) : ''),
      q(a.path    || ''),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="hiby-library.csv"');
  res.send(rows.join('\r\n'));
});

// ── Favorites ───────────────────────────────────────────────────────────────

// GET /api/library/favorites — list of starred album keys + the matching
// album records from the latest scan (a "starred" album that's no longer in
// the library still appears, with album=null).
router.get('/favorites', (req, res) => {
  try {
    const stars = db.listFavorites();
    const keys  = new Set(stars.map(s => s.albumKey));
    const albums = db.getAlbums('library').filter(a => keys.has(a.key));
    res.json({ ok: true, items: stars, albums, count: stars.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not load favorites' });
  }
});

// POST /api/library/favorite { albumKey } — add a star
router.post('/favorite', (req, res) => {
  const albumKey = req.body && req.body.albumKey;
  if (!albumKey || typeof albumKey !== 'string') return res.status(400).json({ error: 'albumKey required' });
  try {
    const added = db.addFavorite(albumKey);
    if (added) db.logActivity('system', 'favorite-added', albumKey, null);
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: 'Could not add favorite' });
  }
});

// DELETE /api/library/favorite?albumKey=...  — remove a star
router.delete('/favorite', (req, res) => {
  const albumKey = req.query.albumKey || (req.body && req.body.albumKey);
  if (!albumKey) return res.status(400).json({ error: 'albumKey required' });
  try {
    const removed = db.removeFavorite(String(albumKey));
    if (removed) db.logActivity('system', 'favorite-removed', String(albumKey), null);
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove favorite' });
  }
});

// GET /api/library/duplicates — albums that share a normalised name
router.get('/duplicates', (req, res) => {
  const c = getCache();
  if (!c || !c.albums) return res.json({ groups: [], count: 0 });

  const normalise = require('../lib/normalise');
  const groupMap  = new Map();

  for (const a of c.albums) {
    const key = normalise(a.key || a.name || '');
    if (!key) continue;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(a);
  }

  const groups = [...groupMap.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([normKey, items]) => ({
      normKey,
      displayName: items[0].name,
      items: items.map(i => ({
        key:     i.key,
        name:    i.name,
        artist:  i.artist || '',
        path:    i.path   || '',
        tracks:  i.tracks || 0,
        addedAt: i.addedAt || null,
      })),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json({ groups, count: groups.length });
});

module.exports = router;
module.exports.getSummary  = getSummary;
module.exports.getCache    = getCache;
module.exports.scanLibrary = scanLibrary;
