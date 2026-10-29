// ── Inbox route — reads Soulseek download folder ─────────────────────────────
'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const normalise      = require('../lib/normalise');
const libraryRoute   = require('./library');
const { mapLimit, isAudioFile, readDirEntries, statOrNull } = require('../lib/walk');
const db            = require('../lib/db');

// Measure a folder: count direct audio files + total size. Async — readdir +
// stat are both off the request thread.
async function measureFolder(folderPath) {
  let tracks = 0, sizeBytes = 0;
  const entries = await readDirEntries(folderPath);
  if (!entries) return { tracks, sizeBytes };
  const audioFiles = entries.filter(f => f.isFile() && isAudioFile(f.name));
  await mapLimit(audioFiles, 8, async f => {
    tracks++;
    const st = await statOrNull(path.join(folderPath, f.name));
    if (st) sizeBytes += st.size;
  });
  return { tracks, sizeBytes };
}

// Scan the inbox folder and return a list of album folders with metadata.
// The inbox is a flat list of `Artist - Album` (or similar) folders dropped
// there by Soulseek. Each folder is treated as one release.
async function scanInbox() {
  const inboxPath = config.INBOX_PATH;

  const entries = await readDirEntries(inboxPath);
  if (!entries) {
    return { ok: false, error: `Inbox folder not found: ${inboxPath}`, items: [], count: 0 };
  }

  const dirs = entries.filter(e => e.isDirectory());
  const items = [];

  // Top-level pass — process up to 4 folders concurrently.
  await mapLimit(dirs, 4, async entry => {
    const folderPath = path.join(inboxPath, entry.name);
    const stat = await statOrNull(folderPath);

    const { tracks, sizeBytes } = await measureFolder(folderPath);

    if (tracks > 0) {
      items.push({
        name:    entry.name,
        tracks,
        sizeMB:  Math.round(sizeBytes / (1024 * 1024)),
        addedAt: stat ? stat.birthtimeMs : 0,
        path:    folderPath,
      });
      return;
    }

    // No direct audio files — look one level deeper (e.g. "RAW SLSK DLs")
    const children = await readDirEntries(folderPath);
    if (!children) return;
    const childDirs = children.filter(c => c.isDirectory());

    await mapLimit(childDirs, 4, async child => {
      const childPath = path.join(folderPath, child.name);
      const { tracks: ct, sizeBytes: cs } = await measureFolder(childPath);
      if (ct === 0) return;
      const childStat = await statOrNull(childPath);
      items.push({
        name:    child.name,
        tracks:  ct,
        sizeMB:  Math.round(cs / (1024 * 1024)),
        addedAt: childStat ? childStat.birthtimeMs : 0,
        path:    childPath,
        _subFolder: entry.name,
      });
    });
  });

  // ── Duplicate detection ──────────────────────────────────────────────────
  // Cross-reference each inbox item against the library cache so the UI can
  // show a "this is already in your library" badge and the wizard can prompt
  // for a merge instead of creating a sibling. Match by normalised name (lib/
  // normalise.js) so case, dash style, and parenthetical annotations don't
  // throw it off.
  try {
    const libCache = libraryRoute.getCache && libraryRoute.getCache();
    if (libCache && Array.isArray(libCache.albums) && libCache.albums.length) {
      const libMap = new Map();
      for (const a of libCache.albums) {
        const k = normalise(a.key || a.name || '');
        if (k && !libMap.has(k)) libMap.set(k, a);
        // Also index album-only so flat folders match nested layouts.
        if (a.album) {
          const alt = normalise(a.album);
          if (alt && !libMap.has(alt)) libMap.set(alt, a);
        }
      }
      for (const item of items) {
        const k = normalise(item.name || '');
        if (k && libMap.has(k)) {
          const match = libMap.get(k);
          item.duplicateOf = {
            key:    match.key  || match.name || '',
            name:   match.name || '',
            artist: match.artist || '',
            path:   match.path || '',
            tracks: match.tracks || 0,
          };
        }
      }
    }
  } catch (e) {
    // Non-fatal — duplicate hints are an enhancement, not a requirement.
    console.warn('[inbox] duplicate detection skipped:', e.message);
  }

  // Newest first
  items.sort((a, b) => b.addedAt - a.addedAt);

  // Apply recency filter if configured (INBOX_DAYS = 0 means show all)
  const days = config.INBOX_DAYS || 0;
  const filtered = days > 0
    ? items.filter(i => i.addedAt > Date.now() - days * 24 * 60 * 60 * 1000)
    : items;

  const duplicateCount = items.filter(i => i.duplicateOf).length;
  return { ok: true, items: filtered, count: filtered.length, totalCount: items.length, duplicateCount, _allItems: items, path: inboxPath, days };
}

// Summary used by /api/status (fast — same scan but only returns count)
async function getSummary() {
  try {
    const r = await scanInbox();
    return { count: r.count, ok: r.ok, error: r.error };
  } catch (e) {
    return { count: 0, ok: false, error: e.message };
  }
}

// GET /api/inbox — full list. Pass ?all=1 to bypass the recency filter.
router.get('/', async (req, res) => {
  try {
    const result = await scanInbox();
    if (req.query.all === '1' && result.ok) {
      const all = result._allItems || result.items;
      return res.json({ ...result, items: all, count: all.length, days: 0 });
    }
    res.json(result);
  } catch (err) {
    console.error('[inbox]', err.message);
    res.status(500).json({ error: 'Inbox scan failed' });
  }
});

// Returns all inbox items (no day filter) — used by sync/upgrades
async function getAllItems() {
  try {
    const r = await scanInbox();
    return r._allItems || r.items || [];
  } catch (_) { return []; }
}

// GET /api/inbox/precheck
// Categorise every inbox folder into one of five buckets so the user can
// decide what to import before running the wizard:
//
//   - downloading : folder is actively being written to (Soulseek mid-transfer).
//                   We never want to flag these as broken — they're growing.
//   - incomplete  : folder has 0 audio files OR average track size is tiny,
//                   AND no signs of active download. Likely a failed transfer.
//   - duplicate   : a library album with the same normalised name exists AND
//                   the inbox copy is the same-or-worse audio quality.
//   - upgrade     : same as duplicate BUT the inbox copy is a higher-rank
//                   format (e.g. FLAC vs library MP3) — worth replacing.
//   - new         : not in the library and looks complete.
const { getBestFormat, getRank } = require('../lib/format');

// File-extension markers that mean "this file is still being downloaded".
// Soulseek (slskd / Nicotine+ / official) writes partial data with one of
// these suffixes and renames on completion. Chromium/Firefox-style markers
// included for the drag-and-drop import path.
const ACTIVE_DOWNLOAD_EXTS = new Set([
  '.incomplete', '.part', '.partial', '.crdownload', '.dwnl', '.tmp', '.!ut',
]);

// Freshness windows. Soulseek transfers are bursty — tracks land seconds
// apart from a fast source, or 10+ minutes apart from a slow one. We use
// three layered signals so the detector doesn't flap when a folder happens
// to be quiet between tracks:
//
//   - FILE_MTIME_FRESH  : any file inside touched within this window means
//                         the download is actively writing right now.
//   - FOLDER_MTIME_FRESH: the FOLDER's mtime ticks every time a new file is
//                         dropped in. Wider window — covers the gap between
//                         consecutive Soulseek tracks.
//   - FOLDER_BIRTH_FRESH: a brand-new folder with too few tracks is almost
//                         certainly mid-download regardless of mtime; sources
//                         can stall for hours and still resume.
const FILE_MTIME_FRESH   = 5  * 60 * 1000;   //  5 min
const FOLDER_MTIME_FRESH = 30 * 60 * 1000;   // 30 min
const FOLDER_BIRTH_FRESH = 6  * 60 * 60 * 1000; //  6 h

// Look at a folder and decide if it's still being downloaded into. Returns
// the reason string for the UI, or null if the folder looks settled.
async function detectActiveDownload(folderPath, currentTracks, currentSizeMB) {
  let entries;
  try { entries = await fs.promises.readdir(folderPath, { withFileTypes: true }); }
  catch (_) { return null; }
  if (!entries) return null;

  const now = Date.now();
  let partialFile = null;
  let recentFileMtime = 0;

  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    // Direct extension match (e.g. "Track 03.flac.incomplete")
    for (const ext of ACTIVE_DOWNLOAD_EXTS) {
      if (lower.endsWith(ext)) { partialFile = e.name; break; }
    }
    if (partialFile) break;

    // slskd / Nicotine+ sometimes prefix the temp file with INCOMPLETE...
    if (lower.startsWith('incomplete')) { partialFile = e.name; break; }

    // Track the most recent file mtime for the per-file freshness signal.
    try {
      const st = await fs.promises.stat(path.join(folderPath, e.name));
      if (st && st.mtimeMs > recentFileMtime) recentFileMtime = st.mtimeMs;
    } catch (_) {}
  }

  // 1) In-progress marker — definitive, no further checks needed.
  if (partialFile) return `in-progress file: ${partialFile}`;

  // 2) A file inside was just written → active write happening.
  if (recentFileMtime && (now - recentFileMtime) < FILE_MTIME_FRESH) {
    return `last file written ${_fmtAgo(now - recentFileMtime)} ago`;
  }

  // 3) Folder-level mtime — updates every time Soulseek drops a new track
  //    in. Wider window to absorb slow Soulseek queues that trickle tracks
  //    in 10+ minutes apart.
  let folderStat = null;
  try { folderStat = await fs.promises.stat(folderPath); } catch (_) {}
  if (folderStat && (now - folderStat.mtimeMs) < FOLDER_MTIME_FRESH) {
    return `folder updated ${_fmtAgo(now - folderStat.mtimeMs)} ago`;
  }

  // 4) Brand-new sparse folder — Soulseek created this folder recently and
  //    it doesn't have many tracks yet. Even if there's no current activity,
  //    the most likely explanation is the queue is still working through
  //    sources for the rest of the album. Suppresses the "incomplete" nag
  //    while the download is still expected to land.
  if (folderStat && (now - folderStat.birthtimeMs) < FOLDER_BIRTH_FRESH) {
    const tracks = currentTracks || 0;
    const sizeMB = currentSizeMB || 0;
    if (tracks <= 3 || sizeMB < 50) {
      return `folder created ${_fmtAgo(now - folderStat.birthtimeMs)} ago, only ${tracks} track${tracks === 1 ? '' : 's'} so far`;
    }
  }

  return null;
}

function _fmtAgo(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60)    return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)    return `${m}min`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

router.get('/precheck', async (req, res) => {
  try {
    const scan = await scanInbox();
    if (!scan.ok) return res.status(500).json({ error: scan.error || 'Inbox scan failed' });

    const items = scan._allItems || scan.items || [];
    const groups = { downloading: [], incomplete: [], duplicate: [], upgrade: [], new: [] };

    for (const it of items) {
      const fmt = getBestFormat(it.path);   // { format, rank, count } | null
      const tracks = it.tracks || 0;
      const sizeMB = it.sizeMB || 0;
      const avgKB  = tracks > 0 ? Math.round((sizeMB * 1024) / tracks) : 0;

      const baseEntry = {
        name:    it.name,
        path:    it.path,
        tracks,
        sizeMB,
        addedAt: it.addedAt || 0,
        format:  fmt ? fmt.format : null,
        rank:    fmt ? fmt.rank  : -1,
      };

      // ── Active-download detection ──────────────────────────────────────────
      // Looks for Soulseek's in-progress markers (.incomplete / .part / ...)
      // or a freshly-written file in the folder. Either signal means the
      // download is in flight and should NOT be treated as broken — it's
      // still growing. Skip the other buckets so the wizard / Check Downloads
      // panel doesn't nag the user about active transfers.
      const activeReason = await detectActiveDownload(it.path, tracks, sizeMB);
      if (activeReason) {
        groups.downloading.push({ ...baseEntry, reason: activeReason });
        continue;
      }

      // ── Incomplete heuristics (only for settled folders) ──────────────────
      // 0 tracks    → empty / failed download
      // tracks≥1 and total <5 MB → likely truncated (single 3-min track is
      //   ~6 MB at 320kbps MP3; anything smaller across the whole folder is
      //   almost certainly partial)
      // avg track <200 KB → individual files are way too small to be real audio
      const reasons = [];
      if (tracks === 0)                  reasons.push('no audio files');
      else if (sizeMB < 5)               reasons.push(`only ${sizeMB} MB total`);
      else if (avgKB > 0 && avgKB < 200) reasons.push(`avg track ~${avgKB} KB`);
      if (reasons.length > 0) {
        groups.incomplete.push({ ...baseEntry, reasons });
        continue;
      }

      // ── Duplicate / Upgrade vs library ─────────────────────────────────────
      if (it.duplicateOf) {
        const libFmt = it.duplicateOf.path ? getBestFormat(it.duplicateOf.path) : null;
        const dup = {
          ...baseEntry,
          libraryPath:   it.duplicateOf.path   || '',
          libraryName:   it.duplicateOf.name   || '',
          libraryArtist: it.duplicateOf.artist || '',
          libraryTracks: it.duplicateOf.tracks || 0,
          libraryFormat: libFmt ? libFmt.format : null,
          libraryRank:   libFmt ? libFmt.rank  : -1,
        };
        if (fmt && libFmt && getRank(fmt.format) > getRank(libFmt.format)) {
          groups.upgrade.push(dup);
        } else {
          groups.duplicate.push(dup);
        }
        continue;
      }

      groups.new.push(baseEntry);
    }

    // Newest first inside each bucket — matches the inbox sort.
    for (const g of Object.values(groups)) g.sort((a, b) => b.addedAt - a.addedAt);

    res.json({
      ok:           true,
      scannedAt:    new Date().toISOString(),
      totalItems:   items.length,
      newCount:         groups.new.length,
      duplicateCount:   groups.duplicate.length,
      upgradeCount:     groups.upgrade.length,
      incompleteCount:  groups.incomplete.length,
      downloadingCount: groups.downloading.length,
      groups,
    });
  } catch (err) {
    console.error('[inbox/precheck]', err.message);
    res.status(500).json({ error: 'Precheck failed' });
  }
});

// ── Drag-and-drop import ────────────────────────────────────────────────────
// Frontend walks a dropped folder via webkitGetAsEntry and POSTs each file
// here with its X-Rel-Path header. We write the raw body to INBOX_PATH +
// the rel-path. No multer dep — Express's raw-body middleware on this single
// endpoint keeps the surface tiny.
//
// Headers:
//   X-Rel-Path: <root-folder>/<sub>/<file>   (forward slashes, validated)
//   Content-Type: application/octet-stream
// Body: raw file bytes (cap: 200 MB per file)

const RAW_LIMIT_BYTES = 200 * 1024 * 1024;
const rawBody = express.raw({ type: '*/*', limit: RAW_LIMIT_BYTES });

router.post('/import-file', rawBody, async (req, res) => {
  const relPath = String(req.get('X-Rel-Path') || '').trim();
  if (!relPath) return res.status(400).json({ error: 'Missing X-Rel-Path header' });

  // Validate the rel-path: forward slashes only, no leading slash, no '..',
  // no null bytes, no Windows-illegal characters.
  if (/[\\\0]/.test(relPath))     return res.status(400).json({ error: 'Invalid path' });
  if (relPath.includes('..'))     return res.status(400).json({ error: 'Path traversal rejected' });
  if (relPath.startsWith('/'))    return res.status(400).json({ error: 'Path must be relative' });
  if (/[<>:"|?*]/.test(relPath))  return res.status(400).json({ error: 'Path contains illegal characters' });
  if (relPath.length > 1024)      return res.status(400).json({ error: 'Path too long' });

  // Build target absolute path under INBOX_PATH, then verify the resolved
  // path is still under INBOX_PATH (defence-in-depth against creative inputs).
  const inboxRoot = path.resolve(config.INBOX_PATH);
  const target = path.resolve(inboxRoot, relPath.replace(/\//g, path.sep));
  if (!target.startsWith(inboxRoot + path.sep) && target !== inboxRoot) {
    return res.status(400).json({ error: 'Resolved path is outside inbox' });
  }

  // Ensure parent folder exists, then write the file.
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, req.body);
    res.json({ ok: true, path: target, bytes: req.body.length });
  } catch (e) {
    console.error('[inbox/import-file]', e.message);
    res.status(500).json({ error: 'Write failed' });
  }
});

// POST /api/inbox/import-done { folderName, fileCount } — called after the
// frontend has uploaded every file. Logs the activity and returns the resolved
// folder path so the UI can hand off to the wizard.
router.post('/import-done', (req, res) => {
  const { folderName, fileCount } = req.body || {};
  if (!folderName || typeof folderName !== 'string') {
    return res.status(400).json({ error: 'folderName required' });
  }
  const folderPath = path.join(config.INBOX_PATH, folderName);
  try {
    db.logActivity('move', 'imported', folderName, { fileCount: fileCount || 0, source: 'drag-drop' });
  } catch (_) {}
  res.json({ ok: true, folderName, folderPath });
});

module.exports = router;
module.exports.getSummary  = getSummary;
module.exports.getAllItems = getAllItems;
