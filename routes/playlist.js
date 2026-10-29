'use strict';
// ── Playlist route — generate .m3u playlists from library slices ─────────────
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const config       = require('../config');
const libraryRoute = require('./library');
const { AUDIO_EXTS } = require('../lib/format');

const PLAYLISTS_DIR = path.join(config.LIBRARY_PATH, 'Playlists');

// Ensure Playlists dir exists
function ensurePlaylistsDir() {
  if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
}

// Get sorted audio files from a folder
function getTracksFromFolder(folderPath) {
  try {
    return fs.readdirSync(folderPath)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(folderPath, f));
  } catch (_) { return []; }
}

// Build relative path from Playlists dir to a track
function relPath(trackPath) {
  return path.relative(PLAYLISTS_DIR, trackPath).replace(/\\/g, '/');
}

// GET /api/playlist/filters — available artists, genres, year range for the UI
router.get('/filters', (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, artists: [], genres: [], yearMin: null, yearMax: null });
  }

  const artistSet = new Set();
  // Map of lowercased-genre -> { display, count } so we can return both a
  // canonical capitalisation and how many albums fall under it.
  const genreMap  = new Map();
  let yearMin = 9999, yearMax = 0;

  for (const a of libData.albums) {
    if (a.artist) artistSet.add(a.artist);
    if (a.genre) {
      const key = String(a.genre).toLowerCase();
      const cur = genreMap.get(key);
      if (cur) { cur.count++; }
      else     { genreMap.set(key, { display: a.genre, count: 1 }); }
    }
    // Try to parse year from album name
    const m = (a.name || '').match(/[\(\[]((?:19|20)\d{2})[\)\]]/);
    if (m) {
      const y = parseInt(m[1]);
      if (y < yearMin) yearMin = y;
      if (y > yearMax) yearMax = y;
    }
  }

  const genres = [...genreMap.values()]
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .map(g => ({ name: g.display, count: g.count }));

  // Decade rollup — each decade is the year (Math.floor(y/10)*10) for any
  // album whose name contains a 4-digit year tag. Returned in ascending order.
  const decadeMap = new Map();   // decade-start (number) -> count
  for (const a of libData.albums) {
    const m = (a.name || '').match(/[\(\[]((?:19|20)\d{2})[\)\]]/);
    if (!m) continue;
    const y = parseInt(m[1]);
    const d = Math.floor(y / 10) * 10;
    decadeMap.set(d, (decadeMap.get(d) || 0) + 1);
  }
  const decades = [...decadeMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, count]) => ({ year, label: `${year}s`, count }));

  res.json({
    ok:      true,
    artists: [...artistSet].sort(),
    genres,
    decades,
    yearMin: yearMin < 9999 ? yearMin : null,
    yearMax: yearMax > 0    ? yearMax : null,
  });
});

// POST /api/playlist/preview — return filtered album list without saving
// Body: { filter: 'recent'|'artist'|'year'|'all', artist?, days?, yearFrom?, yearTo?, shuffle?, limit? }
router.post('/preview', (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) return res.json({ ok: false, albums: [] });

  let albums = applyFilter(libData.albums, req.body);
  res.json({ ok: true, albums: albums.map(a => ({ name: a.name, artist: a.artist, tracks: a.tracks, path: a.path })), count: albums.length });
});

// POST /api/playlist/generate — build and save a playlist file.
// Output is .m3u8 (UTF-8) with a BOM and CRLF line endings so the HiBy
// firmware parses it correctly. Track paths are relative to the playlist's
// own location, with forward slashes for the Linux-based player.
//
// Body: { name, filter, artist?, days?, yearFrom?, yearTo?, shuffle?, limit? }
router.post('/generate', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) return res.status(400).json({ error: 'Run a library scan first.' });

  try {
    ensurePlaylistsDir();

    let albums = applyFilter(libData.albums, req.body);
    if (albums.length === 0) return res.json({ ok: false, error: 'No albums match the filter.' });

    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);

    // #EXTM3U header + #PLAYLIST directive. The #PLAYLIST tag is the M3U
    // extension players use for the playlist's display title. HiByMusic
    // shows this name instead of the raw filename, so the user sees "Dance"
    // rather than "Dance.m3u8" in the Playlists tab.
    const lines = ['#EXTM3U', `#PLAYLIST:${safeName}`];
    let trackCount = 0;
    for (const album of albums) {
      const tracks = getTracksFromFolder(album.path);
      for (const t of tracks) {
        const rel = relPath(t);
        const base = path.basename(t, path.extname(t));
        // #EXTINF needs a duration; we don't compute one, so leave it as -1.
        lines.push(`#EXTINF:-1,${album.artist ? album.artist + ' - ' : ''}${base}`);
        lines.push(rel);
        trackCount++;
      }
    }

    // .m3u8 + UTF-8 BOM + CRLF — three small details that together make the
    // difference between "shows up" and "ghost file" on a HiBy R4.
    const outPath  = path.join(PLAYLISTS_DIR, `${safeName}.m3u8`);
    const body     = '﻿' + lines.join('\r\n') + '\r\n';
    fs.writeFileSync(outPath, body, 'utf8');

    res.json({
      ok:         true,
      path:       outPath,
      albumCount: albums.length,
      trackCount,
      name:       safeName,
      filename:   `${safeName}.m3u8`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/playlist/generate-from-albums — build a saved .m3u8 from an explicit
// list of album folders. Used by "Save as playlist" on a smart playlist: the
// smart filter is run client-side, then the matched albums are handed here so
// the dynamic query becomes a concrete file on the Saved Playlists side (which
// is what the device push works against). Same M3U/BOM/#PLAYLIST format as
// /generate so the result is indistinguishable from a hand-built playlist.
//
// Body: { name, albums: [{ path, artist? }] | [pathString] }
router.post('/generate-from-albums', (req, res) => {
  const { name } = req.body || {};
  let { albums } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(albums) || albums.length === 0) {
    return res.status(400).json({ error: 'albums required' });
  }

  try {
    ensurePlaylistsDir();

    // Only accept folders that live inside the configured library root. The
    // album paths come from the library cache, but we re-check here so this
    // endpoint can never be coaxed into reading arbitrary filesystem folders.
    const libRoot = path.resolve(config.LIBRARY_PATH).toLowerCase();

    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    const lines = ['#EXTM3U', `#PLAYLIST:${safeName}`];
    let trackCount = 0;
    let albumCount = 0;

    for (const entry of albums) {
      const ap     = typeof entry === 'string' ? entry : (entry && entry.path);
      const artist = typeof entry === 'object' && entry ? entry.artist : '';
      if (!ap) continue;
      const resolved = path.resolve(ap);
      if (!resolved.toLowerCase().startsWith(libRoot)) continue;

      const tracks = getTracksFromFolder(resolved);
      if (tracks.length === 0) continue;
      albumCount++;
      for (const t of tracks) {
        const rel  = relPath(t);
        const base = path.basename(t, path.extname(t));
        lines.push(`#EXTINF:-1,${artist ? artist + ' - ' : ''}${base}`);
        lines.push(rel);
        trackCount++;
      }
    }

    if (trackCount === 0) return res.json({ ok: false, error: 'No tracks found in those albums.' });

    const outPath = path.join(PLAYLISTS_DIR, `${safeName}.m3u8`);
    const body    = '﻿' + lines.join('\r\n') + '\r\n';
    fs.writeFileSync(outPath, body, 'utf8');

    res.json({
      ok:         true,
      path:       outPath,
      albumCount,
      trackCount,
      name:       safeName,
      filename:   `${safeName}.m3u8`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/playlist/list — list saved playlists
router.get('/list', (req, res) => {
  try {
    if (!fs.existsSync(PLAYLISTS_DIR)) return res.json({ playlists: [] });
    const files = fs.readdirSync(PLAYLISTS_DIR)
      .filter(f => f.endsWith('.m3u') || f.endsWith('.m3u8'))
      .map(f => {
        const fullPath = path.join(PLAYLISTS_DIR, f);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch (_) {}
        // Strip the UTF-8 BOM before counting lines so .m3u8 files report
        // the right track count.
        const text   = fs.readFileSync(fullPath, 'utf8').replace(/^﻿/, '');
        const lines  = text.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
        return { name: path.basename(f, path.extname(f)), file: f, path: fullPath, tracks: lines.length, mtime: stat ? stat.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ playlists: files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/playlist/inspect?name=<name> — return the first few lines and the
// header bytes of a playlist file so the UI can show what's actually on disk.
// Useful diagnostic: "did the push really write the right file?".
router.get('/inspect', (req, res) => {
  const name = (req.query.name || '').toString().replace(/\.(m3u8?|m3u)$/i, '');
  if (!name) return res.status(400).json({ error: 'name required' });
  // Try .m3u8 first, fall back to .m3u for legacy generated files.
  let file = path.join(PLAYLISTS_DIR, `${name}.m3u8`);
  if (!fs.existsSync(file)) file = path.join(PLAYLISTS_DIR, `${name}.m3u`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    const buf  = fs.readFileSync(file);
    const hasBOM = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const text  = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    const tracks = lines.filter(l => l && !l.startsWith('#'));
    res.json({
      ok:           true,
      file:         path.basename(file),
      sizeBytes:    buf.length,
      hasBOM,
      lineEndings:  /\r\n/.test(text) ? 'CRLF' : 'LF',
      trackCount:   tracks.length,
      head:         lines.slice(0, 12),
      sampleTrack:  tracks[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/playlist/:name — delete a saved playlist (.m3u or .m3u8)
router.delete('/:name', (req, res) => {
  const base = req.params.name.replace(/\.(m3u8?|m3u)$/i, '');
  const m3u8 = path.join(PLAYLISTS_DIR, base + '.m3u8');
  const m3u  = path.join(PLAYLISTS_DIR, base + '.m3u');
  const file = fs.existsSync(m3u8) ? m3u8 : m3u;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(file); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/playlist/push — queue a saved playlist for the R4. Wheelhouse
// downloads it into <music>/Playlists/ on its next sync. The .m3u8 uses paths
// relative to Playlists/ (../Artist/Album/track.flac), which resolve on the R4
// because Wheelhouse mirrors the library's folder layout.
router.post('/push', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const base = String(name).replace(/\.(m3u8?|m3u)$/i, '');
  if (/[\\/]|\.\./.test(base)) return res.status(400).json({ error: 'Invalid playlist name' });
  const m3u8 = path.join(PLAYLISTS_DIR, base + '.m3u8');
  const m3u  = path.join(PLAYLISTS_DIR, base + '.m3u');
  const file = fs.existsSync(m3u8) ? m3u8 : m3u;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Playlist not found: ' + name });

  try {
    const db = require('../lib/db');
    const relPath = `Playlists/${path.basename(file)}`;
    const { items } = db.enqueueDevice([{ kind: 'playlist', action: 'download', relPath, album: base }]);
    db.logActivity('push', 'playlist-queued', base, { relPath });
    res.json({
      ok: true, queued: true, jobId: items[0].id, name: base, file: path.basename(file),
      pushed: [], warnings: [],
      message: `Queued "${base}" for the R4. It downloads the next time Wheelhouse syncs.`,
    });
  } catch (e) {
    console.error('[playlist/push]', e.message);
    res.status(500).json({ ok: false, error: 'Could not queue playlist' });
  }
});

// GET /api/playlist/device-list — playlists the R4 reported on its last
// Wheelhouse inventory, annotated the same way the old USB scan was.
router.get('/device-list', (req, res) => {
  const wheelhouse = require('./wheelhouse');
  const { playlists, reportedAt } = wheelhouse.devicePlaylists();
  if (!playlists) {
    return res.json({ ok: true, deviceName: config.DEVICE_NAME, volume: null, volumes: [],
      diagnostics: ['The R4 has not reported its playlists yet. Run Scan Device, then open Wheelhouse on the R4.'],
      files: [], total: 0, suggestedCount: 0 });
  }
  const files = playlists.map(p => {
    const rel = String(p).replace(/\\/g, '/');
    return { path: rel, name: rel.split('/').pop(), reasons: [], suggested: false };
  });
  // Flag obvious duplicates: same name apart from a "(1)"/" - Copy" suffix.
  const canon = n => n.replace(/\.(m3u8?)$/i, '').replace(/\s*(\(\d+\)|- copy|copy)$/i, '').trim().toLowerCase();
  const seen = new Map();
  for (const f of files) {
    const c = canon(f.name);
    if (seen.has(c)) { f.suggested = true; f.reasons.push(`duplicate of "${seen.get(c).name}"`); }
    else seen.set(c, f);
  }
  res.json({ ok: true, deviceName: config.DEVICE_NAME, volume: null, volumes: [],
    diagnostics: [`Reported by Wheelhouse at ${reportedAt}`],
    files, total: files.length, suggestedCount: files.filter(f => f.suggested).length });
});

// POST /api/playlist/device-delete { paths: [...] } — queue deletions for the
// R4. Only playlist files under a Playlists folder are accepted.
router.post('/device-delete', (req, res) => {
  const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : null;
  if (!paths || paths.length === 0) return res.status(400).json({ ok: false, error: 'paths array required' });
  const safe = paths
    .filter(p => typeof p === 'string')
    .map(p => p.replace(/\\/g, '/'))
    .filter(p => !p.split('/').includes('..') && /\.m3u8?$/i.test(p) && /(^|\/)Playlists\//i.test(p));
  if (safe.length === 0) return res.status(400).json({ ok: false, error: 'No valid playlist paths' });
  try {
    const db = require('../lib/db');
    db.enqueueDevice(safe.map(relPath => ({ kind: 'playlist', action: 'delete', relPath })));
    db.logActivity('quarantine', 'device-playlists-delete-queued', null, { paths: safe });
    res.json({ ok: true, queued: true, deleted: [], errors: [], total: safe.length,
      message: `Queued ${safe.length} playlist deletion(s). The R4 removes them on its next sync.` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not queue deletions' });
  }
});

// ── Filter logic ──────────────────────────────────────────────────────────────
// `filter` picks the PRIMARY filter mode (all / recent / artist / year / genre).
// `genre` and `days` can ALSO be supplied alongside any primary mode and are
// applied as additional constraints — that's what lets the Mood presets combine
// e.g. "Chill" genres with "recent 90d" + shuffle + limit.
//
// Genre matching is case-insensitive and accepts either a single string or an
// array of strings; an album matches if its genre tag matches ANY entry.
function applyFilter(albums, opts = {}) {
  const { filter = 'all', artist, days, yearFrom, yearTo, shuffle, limit, genre, decades } = opts;
  let out = [...albums];

  // Primary filter
  if (filter === 'recent') {
    const d = parseInt(days) || 30;
    const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
    out = out.filter(a => (a.addedAt || 0) > cutoff);
  } else if (filter === 'artist' && artist) {
    out = out.filter(a => (a.artist || '').toLowerCase() === artist.toLowerCase());
  } else if (filter === 'year' && (yearFrom || yearTo)) {
    out = out.filter(a => {
      const m = (a.name || '').match(/[\(\[]((?:19|20)\d{2})[\)\]]/);
      if (!m) return false;
      const y = parseInt(m[1]);
      return (!yearFrom || y >= yearFrom) && (!yearTo || y <= yearTo);
    });
  } else if (filter === 'genre' && genre) {
    // Handled by the constraint pass below; setting filter='genre' just makes
    // genre the primary mode in the UI without changing behaviour here.
  }
  // 'all' → no primary filter

  // Optional genre constraint (works alongside any primary mode).
  if (genre) {
    const wanted = (Array.isArray(genre) ? genre : [genre])
      .map(g => String(g || '').toLowerCase().trim())
      .filter(Boolean);
    if (wanted.length > 0) {
      out = out.filter(a => {
        const g = String(a.genre || '').toLowerCase();
        if (!g) return false;
        // Match if any wanted entry appears in or equals the album's genre.
        return wanted.some(w => g === w || g.includes(w));
      });
    }
  }

  // Optional "recent N days" constraint (lets mood presets layer recency on
  // top of a genre filter without changing the primary mode).
  if (filter !== 'recent' && days) {
    const d = parseInt(days);
    if (Number.isFinite(d) && d > 0) {
      const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
      out = out.filter(a => (a.addedAt || 0) > cutoff);
    }
  }

  // Optional decades constraint — array of decade-start years (e.g. [1980, 2010]).
  // Matches albums whose year tag falls anywhere inside any selected decade.
  // Combines with yearFrom/yearTo: an album must satisfy BOTH if both supplied.
  if (Array.isArray(decades) && decades.length > 0) {
    const wantedDecades = new Set(
      decades.map(d => parseInt(d)).filter(d => Number.isFinite(d))
    );
    if (wantedDecades.size > 0) {
      out = out.filter(a => {
        const m = (a.name || '').match(/[\(\[]((?:19|20)\d{2})[\)\]]/);
        if (!m) return false;
        const y = parseInt(m[1]);
        return wantedDecades.has(Math.floor(y / 10) * 10);
      });
    }
  }

  if (shuffle) out = out.sort(() => Math.random() - 0.5);
  else         out = out.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));

  if (limit && parseInt(limit) > 0) out = out.slice(0, parseInt(limit));
  return out;
}

module.exports = router;
