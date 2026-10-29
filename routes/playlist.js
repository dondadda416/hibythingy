'use strict';
// ── Playlist route — generate .m3u playlists from library slices ─────────────
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const { spawn }    = require('child_process');
const config       = require('../config');
const libraryRoute = require('./library');
const { AUDIO_EXTS } = require('../lib/format');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

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

// POST /api/playlist/push — copy a saved playlist to the HiBy SD card via MTP
router.post('/push', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  // Accept either extension; prefer the newer .m3u8 if both exist.
  const base = name.replace(/\.(m3u8?|m3u)$/i, '');
  const m3u8 = path.join(PLAYLISTS_DIR, base + '.m3u8');
  const m3u  = path.join(PLAYLISTS_DIR, base + '.m3u');
  const file = fs.existsSync(m3u8) ? m3u8 : m3u;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Playlist not found: ' + name });

  const scriptPath = path.join(SCRIPTS_DIR, 'push-playlist.ps1');
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: 'push-playlist.ps1 not found' });

  const outFile = path.join(config.CACHE_DIR, `playlist-push-${Date.now()}.json`);
  const esc = s => s.replace(/'/g, "''");
  const psCmd = `& '${esc(scriptPath)}' -SourceFile '${esc(file)}' -OutFile '${esc(outFile)}'`;
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd];

  const stdoutChunks = [], stderrChunks = [];
  const ps = spawn('powershell.exe', psArgs, { windowsHide: true });
  ps.stdout.on('data', d => stdoutChunks.push(d));
  ps.stderr.on('data', d => stderrChunks.push(d));

  // Wait for PS1 to finish (up to 2 min) so we can return the real result.
  // The previous 45s budget wasn't enough when the SD root has many items —
  // Shell.Application's MTP enumeration is genuinely slow regardless of the
  // tiny playlist file size. ParseName fast-path in the script should bring
  // this well under 30s in practice; the higher cap just absorbs spikes.
  const PLAYLIST_PUSH_TIMEOUT_MS = 120_000;
  const killTimer = setTimeout(() => {
    ps.kill();
    try { fs.unlinkSync(outFile); } catch (_) {}
    if (!res.headersSent) res.status(504).json({ ok: false, error: `Push timed out after ${PLAYLIST_PUSH_TIMEOUT_MS / 1000}s. Is the HiBy connected via USB in MTP mode?` });
  }, PLAYLIST_PUSH_TIMEOUT_MS);

  ps.on('close', exitCode => {
    clearTimeout(killTimer);
    if (res.headersSent) return;

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    let result = null;
    try {
      if (fs.existsSync(outFile)) {
        result = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim());
      }
    } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}

    if (stderr) console.error(`[playlist-push stderr] ${stderr.slice(0, 400)}`);

    if (result && result.ok) {
      const landedAs = result.file || result.originalName || name;
      console.log(`Playlist pushed: ${name} -> ${(result.pushed || []).join(', ')} (as ${landedAs})`);
      try {
        const db = require('../lib/db');
        db.logActivity('push', 'playlist-pushed', name, {
          locations:    result.pushed || [],
          landedAs,
          originalName: result.originalName || null,
        });
      } catch (_) {}
      res.json({
        ok:           true,
        name,
        file:         result.file,
        originalName: result.originalName || null,
        pushed:       result.pushed || [],
        warnings:     result.errors  || [],
      });
    } else {
      const err = (result && result.error) || stderr.trim().slice(-400) || `Exit code ${exitCode}`;
      console.error(`Playlist push failed (${name}):`, err);
      // Persist the failure to the activity log so the user can review it
      // in Jobs & Logs even if the toast disappeared before they noticed it.
      try {
        const db = require('../lib/db');
        db.logActivity('push', 'playlist-push-failed', name, {
          error: err,
          stderr: stderr ? stderr.slice(-400) : '',
          exitCode,
          partial: result && result.pushed ? result.pushed : [],
        });
      } catch (_) {}
      res.status(500).json({ ok: false, error: err });
    }
  });
});

// ── Device playlist cleanup ──────────────────────────────────────────────────
// Two endpoints for the "Clean Duplicates" UI: one to list playlist files on
// the device, one to delete a user-selected subset. Both shell out to
// PowerShell scripts because everything on the R4 lives behind the MTP
// namespace which only Shell.Application can talk to.

// GET /api/playlist/device-list
// Returns every .m3u / .m3u8 file in SD:\Playlists\ and SD:\Music\Playlists\,
// annotated with whether each one looks like a duplicate that can be safely
// cleaned. The annotation is conservative — anything that isn't an obvious
// duplicate stays unflagged so the user can decide.
router.get('/device-list', (req, res) => {
  const scriptPath = path.join(SCRIPTS_DIR, 'list-device-playlists.ps1');
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: 'list-device-playlists.ps1 not found' });

  const outFile = path.join(config.CACHE_DIR, `device-pl-list-${Date.now()}.json`);
  const esc = s => s.replace(/'/g, "''");
  const psCmd = `& '${esc(scriptPath)}' -OutFile '${esc(outFile)}'`;
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd];

  const stdoutChunks = [], stderrChunks = [];
  const ps = spawn('powershell.exe', psArgs, { windowsHide: true });
  ps.stdout.on('data', d => stdoutChunks.push(d));
  ps.stderr.on('data', d => stderrChunks.push(d));

  const killTimer = setTimeout(() => {
    ps.kill();
    try { fs.unlinkSync(outFile); } catch (_) {}
    if (!res.headersSent) res.status(504).json({ ok: false, error: 'Device scan timed out after 60s.' });
  }, 60000);

  ps.on('close', exitCode => {
    clearTimeout(killTimer);
    if (res.headersSent) return;
    let result = null;
    try {
      if (fs.existsSync(outFile)) result = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim());
    } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}

    if (!result) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(-400);
      return res.status(500).json({ ok: false, error: stderr || `Script exited with code ${exitCode}` });
    }
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || 'Scan failed', files: [] });
    }

    // Build the duplicate-detection annotations. Rules:
    //   - Any file in Music\Playlists\ -> duplicate of the canonical SD root
    //     copy (or stale legacy file).
    //   - Any .m3u file anywhere -> superseded by the .m3u8 generation, mark
    //     as duplicate if a same-stem .m3u8 also exists.
    //   - "name 1.m3u8" / "name 2.m3u8" auto-suffix forms when "name.m3u8"
    //     also exists -> duplicate (HiByMusic disambiguation leftover).
    const files  = (result.files || []);
    const stems  = new Map();   // lowercased-stem -> [files...] for cross-check
    for (const f of files) {
      const stem = f.name.replace(/\.(m3u8?|m3u)$/i, '').toLowerCase();
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push(f);
    }

    // Reduce a stem to its canonical playlist name so timestamped Hub
    // pushes and HiByMusic's "name 1" auto-suffix forms get grouped with
    // their canonical sibling. "Dance.20260519-214530" -> "Dance",
    // "Dance 1" -> "Dance".
    function canonicalStem(stem) {
      let s = stem.replace(/\s+\d+$/, '').trim();          // strip " 1", " 2" auto-suffix
      s = s.replace(/\.\d{8}-\d{6}$/, '').trim();           // strip Hub's ".YYYYMMDD-HHMMSS" timestamp
      return s;
    }

    const annotated = files.map(f => {
      const stem  = f.name.replace(/\.(m3u8?|m3u)$/i, '').toLowerCase();
      const reasons = [];
      let suggested = false;

      // Location strings now include the volume prefix, e.g.
      // "SanDisk SD card\Music\Playlists" or "Internal Storage\Playlists".
      // Canonical destination on this firmware is <volume>\Music\Playlists\.
      // Anything OUTSIDE that — root-level Playlists\, HiByMusic\Playlists\,
      // etc. — is treated as a stale or duplicate copy.
      const loc = String(f.location || '');
      const isCanonical = /\\Music\\Playlists$/i.test(loc);
      const isRootPL    = /^[^\\]+\\Playlists$/i.test(loc);
      const isHiByPL    = /\\HiByMusic\\Playlists$/i.test(loc);
      if (isRootPL) {
        reasons.push('legacy SD-root Playlists location (Hub now pushes to Music\\Playlists)');
        suggested = true;
      }
      if (isHiByPL) {
        reasons.push('inside HiByMusic\\Playlists (managed by the app — usually safe to remove if duplicated elsewhere)');
        suggested = true;
      }
      if (f.ext === '.m3u') {
        const m3u8twin = stems.get(stem) && stems.get(stem).some(o => o !== f && o.ext === '.m3u8');
        if (m3u8twin) {
          reasons.push('superseded by the .m3u8 copy');
          suggested = true;
        } else {
          reasons.push('legacy .m3u format (Hub generates .m3u8 now)');
          suggested = true;
        }
      }
      // "name 1" / "name 2" auto-suffix forms when the un-suffixed name also
      // exists somewhere -> duplicate.
      const canon = canonicalStem(stem);
      if (canon !== stem) {
        const baseExists = files.some(o => o !== f && o.name.replace(/\.(m3u8?|m3u)$/i, '').toLowerCase() === canon);
        if (baseExists) {
          reasons.push('auto-suffix duplicate of "' + canon + '"');
          suggested = true;
        }
      }

      return { ...f, suggested, reasons, _canon: canon, _stem: stem };
    });

    // Second pass: if multiple files share a canonical stem (e.g. several
    // timestamped Hub pushes of the same playlist), mark all but the newest
    // as duplicates so the user can sweep them in one go.
    const canonGroups = new Map();
    for (const f of annotated) {
      if (!canonGroups.has(f._canon)) canonGroups.set(f._canon, []);
      canonGroups.get(f._canon).push(f);
    }
    for (const [canon, group] of canonGroups) {
      if (group.length <= 1) continue;
      // Treat Hub's timestamp suffix as the sort key when present; fall back
      // to the raw stem so non-timestamped files still order deterministically.
      group.sort((a, b) => (b._stem > a._stem ? 1 : (b._stem < a._stem ? -1 : 0)));
      // Skip [0] (the newest), mark the rest.
      for (let i = 1; i < group.length; i++) {
        const f = group[i];
        if (!f.reasons.some(r => r.startsWith('older version'))) {
          f.reasons.push(`older version of "${canon}" (newest: ${group[0].name})`);
          f.suggested = true;
        }
      }
    }
    // Strip the internal helper fields before sending to client.
    for (const f of annotated) { delete f._canon; delete f._stem; }

    const suggestedCount = annotated.filter(f => f.suggested).length;
    res.json({
      ok: true,
      deviceName:  result.deviceName,
      volume:      result.volume,
      volumes:     result.volumes     || [],
      diagnostics: result.diagnostics || [],
      files:       annotated,
      total:       annotated.length,
      suggestedCount,
    });
  });
});

// POST /api/playlist/device-delete
// Body: { paths: ["Playlists\\foo.m3u", "Music\\Playlists\\bar.m3u8", ...] }
// Each path must be inside SD:\Playlists\ or SD:\Music\Playlists\ and must
// be a .m3u or .m3u8 file. Path validation happens here AND in the script.
router.post('/device-delete', (req, res) => {
  const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : null;
  if (!paths || paths.length === 0) return res.status(400).json({ ok: false, error: 'paths array required' });

  // Server-side filter — even though the script re-validates, refusing the
  // request earlier means a typo in the frontend can never reach PS.
  // Paths look like "<Volume>\Playlists\file.m3u8" or
  //                 "<Volume>\Music\Playlists\file.m3u8" or
  //                 "<Volume>\HiByMusic\Playlists\file.m3u8"
  const safe = paths.filter(p => {
    if (typeof p !== 'string') return false;
    if (p.includes('..') || p.includes('/')) return false;
    const segs = p.split('\\');
    if (segs.length < 3) return false;
    // NOTE: we do NOT require a .m3u8 extension here — MTP strips extensions
    // from displayed names ("Dance" instead of "Dance.m3u8"). The real guard
    // is that the path must sit inside a Playlists folder, which only ever
    // contains playlist files.
    const inRoot  = segs.length === 3 && segs[1] === 'Playlists';
    const inMusic = segs.length === 4 && segs[1] === 'Music'     && segs[2] === 'Playlists';
    const inHiby  = segs.length === 4 && segs[1] === 'HiByMusic' && segs[2] === 'Playlists';
    return inRoot || inMusic || inHiby;
  });
  if (safe.length === 0) return res.status(400).json({ ok: false, error: 'No valid playlist paths in request' });

  const scriptPath = path.join(SCRIPTS_DIR, 'delete-device-playlists.ps1');
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ ok: false, error: 'delete-device-playlists.ps1 not found' });

  // Write the path list to a temp JSON file. Avoids PowerShell command-line
  // quoting headaches for filenames containing quotes, ampersands, etc.
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  const pathsFile = path.join(config.CACHE_DIR, `device-pl-paths-${Date.now()}.json`);
  fs.writeFileSync(pathsFile, JSON.stringify(safe), 'utf8');
  const outFile = path.join(config.CACHE_DIR, `device-pl-del-${Date.now()}.json`);

  const esc = s => s.replace(/'/g, "''");
  const psCmd = `& '${esc(scriptPath)}' -PathsFile '${esc(pathsFile)}' -OutFile '${esc(outFile)}'`;
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd];

  const stdoutChunks = [], stderrChunks = [];
  const ps = spawn('powershell.exe', psArgs, { windowsHide: true });
  ps.stdout.on('data', d => stdoutChunks.push(d));
  ps.stderr.on('data', d => stderrChunks.push(d));

  // Generous timeout — MTP deletes can be slow if there are many files or
  // if Windows shows internal confirmation prompts (suppressed in script).
  const killTimer = setTimeout(() => {
    ps.kill();
    try { fs.unlinkSync(pathsFile); } catch (_) {}
    try { fs.unlinkSync(outFile);   } catch (_) {}
    if (!res.headersSent) res.status(504).json({ ok: false, error: 'Delete timed out after 3 min.' });
  }, 180_000);

  ps.on('close', exitCode => {
    clearTimeout(killTimer);
    if (res.headersSent) return;
    let result = null;
    try { if (fs.existsSync(outFile)) result = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim()); }
    catch (_) {}
    try { fs.unlinkSync(pathsFile); } catch (_) {}
    try { fs.unlinkSync(outFile);   } catch (_) {}

    if (!result) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(-400);
      return res.status(500).json({ ok: false, error: stderr || `Script exited with code ${exitCode}` });
    }

    try {
      const db = require('../lib/db');
      db.logActivity('quarantine', 'device-playlists-cleaned', null, {
        deleted: result.deleted || [],
        errors:  result.errors  || [],
        total:   result.total   || 0,
      });
    } catch (_) {}

    res.json(result);
  });
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
