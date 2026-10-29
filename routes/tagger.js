// ── Tagger route — read/write tags, rename folders, move to master ────────────
'use strict';
const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const config   = require('../config');
const { readFlacTags, writeFlacTags } = require('../lib/flac-tagger');
const { AUDIO_EXTS } = require('../lib/format');
const { resolveUnder, resolveUnderOrJoin } = require('../lib/safePath');
const { validateBody, validateQuery } = require('../lib/validate');
const S = require('../lib/schemas');
const db = require('../lib/db');

const FLAC_EXT   = '.flac';
const SAFE_ROOTS = [config.INBOX_PATH, config.LIBRARY_PATH];

// ── Helpers ───────────────────────────────────────────────────────────────────

// List audio files in a folder, sorted by filename
function listAudioFiles(folderPath) {
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter(f => f.isFile() && AUDIO_EXTS.has(path.extname(f.name).toLowerCase()))
    .map(f => path.join(folderPath, f.name))
    .sort();
}

// Safe filename: remove characters that cause problems on Windows
function safeName(str) {
  return str.replace(/[\\/:*?"<>|]/g, '_').trim();
}

// Recursively copy a directory (needed for cross-drive moves)
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Delete a directory recursively
function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/tags/read?folder=<name>[&path=<absolutePath>]
// Read tags from the first audio file in an inbox folder.
// If 'path' is supplied it is used directly; otherwise folder is resolved under INBOX_PATH.
router.get('/read', validateQuery(S.TagsReadQuery), async (req, res) => {
  const { folder: folderName, path: suppliedPath } = req.validatedQuery;
  // Allow callers to pass the absolute path directly (needed for nested inbox items)
  const folderPath = resolveUnderOrJoin(suppliedPath, folderName, SAFE_ROOTS);
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  try {
    const files = listAudioFiles(folderPath);
    if (files.length === 0) return res.json({ tags: {}, files: 0 });

    // Read tags from first file (representative of the album)
    let tags = {};
    const firstFile = files[0];
    const ext = path.extname(firstFile).toLowerCase();

    if (ext === FLAC_EXT) {
      tags = readFlacTags(firstFile);
    } else {
      // For MP3 and others, use music-metadata
      try {
        const mm = require('music-metadata');
        const meta = await mm.parseFile(firstFile, { duration: false });
        const c = meta.common;
        tags = {
          artist:      c.artist || '',
          albumArtist: c.albumartist || '',
          album:       c.album || '',
          year:        c.year ? String(c.year) : '',
          genre:       c.genre ? c.genre[0] : '',
        };
      } catch (_) {}
    }

    // Remove internal fields before sending
    const { _vendor, _extra, ...publicTags } = tags;

    res.json({
      tags:        publicTags,
      files:       files.length,
      firstFile:   path.basename(firstFile),
      folderName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tags/apply
// Write tags to ALL audio files in an inbox folder, then rename the folder.
// Body: { folder, folderPath (optional absolute), artist, album, year, genre,
//         newFolderName, tracks: [{ filename, title, trackNum }] }
router.post('/apply', validateBody(S.TagsApplyBody), (req, res) => {
  const { folder, folderPath: suppliedPath, artist, album, year, genre, newFolderName,
          tracks: trackFixes = [] } = req.body;

  // Resolve a safe path under one of the managed roots.
  const folderPath = resolveUnderOrJoin(suppliedPath, folder, SAFE_ROOTS);
  if (!folderPath || !fs.existsSync(folderPath)) {
    console.error('[tagger/apply] Folder not found or path rejected. supplied:', suppliedPath, ' folder:', folder);
    return res.status(404).json({ error: 'Folder not found' });
  }

  const tags   = { artist, albumArtist: artist, album, year, genre };
  const files  = listAudioFiles(folderPath);

  // ── Stage → commit ──────────────────────────────────────────────────────
  // Snapshot existing tags first so we can roll back if any individual write
  // fails. Without this, a partial failure leaves the album half-tagged with
  // no record of the prior state.
  const snapshots = new Map();   // filePath → previous tags
  const written   = [];          // filePath list — files we did mutate
  const errors    = [];

  // Phase 1: read existing tags into the snapshot map.
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== FLAC_EXT) continue; // we only roll back FLACs (the format we own)
    try { snapshots.set(filePath, readFlacTags(filePath)); }
    catch (e) { /* if snapshot fails, we won't rollback that file — log and proceed */
      console.warn('[tagger/apply] snapshot read failed:', filePath, e.message);
    }
  }

  // Phase 2: write album-level tags. On any failure, rollback every written
  // file from the snapshot before returning an error.
  let aborted = false;
  for (const filePath of files) {
    if (aborted) break;
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === FLAC_EXT) {
        writeFlacTags(filePath, tags);
        written.push(filePath);
      } else if (ext === '.mp3') {
        let NodeID3;
        try { NodeID3 = require('node-id3'); }
        catch (_) { throw new Error('node-id3 not installed — run: npm install in the project folder'); }
        NodeID3.update({
          artist, album,
          year:          year || undefined,
          performerInfo: artist,
        }, filePath);
        // No rollback for MP3 — node-id3 doesn't expose a clean snapshot path.
      }
    } catch (e) {
      errors.push({ file: path.basename(filePath), error: e.message });
      aborted = true;
    }
  }

  if (aborted) {
    // Restore previous tags on every FLAC we touched.
    for (const filePath of written) {
      const prev = snapshots.get(filePath);
      if (!prev) continue;
      try { writeFlacTags(filePath, prev); }
      catch (e) { console.error('[tagger/apply] rollback failed for', filePath, e.message); }
    }
    return res.status(500).json({
      ok: false,
      tagged: 0,
      errors,
      message: 'Tag write failed; previous tags restored where possible.',
    });
  }

  // Phase 3: per-track title / track-number overrides from MusicBrainz verify.
  if (Array.isArray(trackFixes) && trackFixes.length > 0) {
    const fixMap = Object.fromEntries(trackFixes.map(t => [t.filename, t]));
    for (const filePath of files) {
      const fix = fixMap[path.basename(filePath)];
      if (!fix) continue;
      const ext = path.extname(filePath).toLowerCase();
      try {
        if (ext === FLAC_EXT) {
          writeFlacTags(filePath, {
            title: fix.title    || undefined,
            track: fix.trackNum || undefined,
          });
        } else if (ext === '.mp3') {
          try {
            const NodeID3 = require('node-id3');
            NodeID3.update({ title: fix.title || undefined }, filePath);
          } catch (_) {}
        }
      } catch (e) {
        errors.push({ file: path.basename(filePath), error: 'track fix: ' + e.message });
      }
    }
  }

  // Phase 4: rename folder. This is the last step so a failed rename doesn't
  // strand us in a half-state — the tags are already written, the folder name
  // is the only thing that didn't change.
  let finalFolderName = folder;
  let finalFolderPath = folderPath;
  if (newFolderName && newFolderName !== folder) {
    const safeFolderName = safeName(newFolderName);
    const candidate      = path.join(path.dirname(folderPath), safeFolderName);
    // Resolved candidate must still sit under one of the safe roots.
    const safeCandidate  = resolveUnder(candidate, SAFE_ROOTS);
    if (!safeCandidate) {
      errors.push({ folder: true, error: 'Refusing to rename outside managed roots' });
    } else if (fs.existsSync(safeCandidate)) {
      errors.push({ folder: true, error: 'Target folder name already exists' });
    } else {
      try {
        fs.renameSync(folderPath, safeCandidate);
        finalFolderName = safeFolderName;
        finalFolderPath = safeCandidate;
      } catch (e) {
        errors.push({ folder: true, error: e.message });
      }
    }
  }

  if (errors.length === 0) {
    db.logActivity('tag', 'tag-applied', finalFolderName, {
      artist, album, year, genre,
      tracks: files.length,
      renamed: finalFolderName !== folder,
    });
  }

  res.json({
    ok:             errors.length === 0,
    tagged:         files.length,
    errors,
    finalFolderName,
    finalFolderPath,
  });
});

// POST /api/tags/move
// Move a processed inbox folder to the master library on D:
// Body: { folder, folderPath (optional absolute src) }
router.post('/move', validateBody(S.TagsMoveBody), (req, res) => {
  const { folder, folderPath: suppliedPath } = req.body;

  // Source must resolve under INBOX_PATH; destination must resolve under LIBRARY_PATH.
  const srcPath = resolveUnderOrJoin(suppliedPath, folder, [config.INBOX_PATH]);
  const dstCandidate = path.join(config.LIBRARY_PATH, safeName(folder));
  const dstPath = resolveUnder(dstCandidate, [config.LIBRARY_PATH]);

  if (!srcPath || !fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source folder not found' });
  if (!dstPath) return res.status(400).json({ error: 'Invalid destination path' });
  if (!fs.existsSync(config.LIBRARY_PATH)) return res.status(500).json({ error: 'Master library path not configured' });
  if (fs.existsSync(dstPath)) return res.status(409).json({ error: 'A folder with this name already exists in master library.' });

  try {
    // Try a simple rename first (works when src and dst are on the same drive)
    try {
      fs.renameSync(srcPath, dstPath);
    } catch (crossDriveErr) {
      // Cross-drive: copy then delete
      copyDirSync(srcPath, dstPath);
      rmDirSync(srcPath);
    }

    db.logActivity('move', 'moved-to-library', folder, { from: srcPath, to: dstPath });
    res.json({ ok: true, movedTo: dstPath, folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tags/tracklist?path=<absoluteFolderPath>
// Returns per-track tag info for every audio file in the folder.
router.get('/tracklist', validateQuery(S.TagsTracklistQuery), async (req, res) => {
  const folderPath = resolveUnder(req.validatedQuery.path, SAFE_ROOTS);
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  try {
    const files  = listAudioFiles(folderPath);
    const tracks = [];
    let totalSize = 0;

    for (const f of files) {
      const ext  = path.extname(f).toLowerCase();
      const name = path.basename(f);
      let   size = 0;
      try { size = fs.statSync(f).size; } catch (_) {}
      totalSize += size;

      let tags = {};
      if (ext === FLAC_EXT) {
        try { tags = readFlacTags(f); } catch (_) {}
      } else {
        try {
          const mm = require('music-metadata');
          const meta = await mm.parseFile(f, { duration: false });
          tags = {
            title:  meta.common.title || '',
            track:  meta.common.track?.no ? String(meta.common.track.no) : '',
            artist: meta.common.artist || '',
            album:  meta.common.album  || '',
            year:   meta.common.year   ? String(meta.common.year) : '',
            genre:  meta.common.genre?.[0] || '',
          };
        } catch (_) {}
      }

      tracks.push({
        filename: name,
        ext:      ext.slice(1).toUpperCase(),
        sizeMB:   size ? (size / (1024 * 1024)).toFixed(1) : null,
        title:    tags.title    || '',
        track:    tags.track    || '',
        artist:   tags.artist   || '',
        album:    tags.album    || '',
        year:     tags.year     || '',
        genre:    tags.genre    || '',
      });
    }

    // Sort by track number if present, else filename
    tracks.sort((a, b) => {
      const na = parseInt(a.track, 10) || 0;
      const nb = parseInt(b.track, 10) || 0;
      if (na && nb) return na - nb;
      return a.filename.localeCompare(b.filename);
    });

    res.json({
      ok: true,
      folderPath,
      trackCount: tracks.length,
      totalMB:    totalSize ? (totalSize / (1024 * 1024)).toFixed(1) : null,
      tracks,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tags/update
// Write album + per-track tags to files in ANY folder (library or inbox).
// Does NOT rename or move anything.
// Body: { folderPath, artist, album, year, genre, tracks: [{filename, title, trackNum}] }
router.post('/update', validateBody(S.TagsUpdateBody), (req, res) => {
  const { folderPath: suppliedPath, artist, album, year, genre, tracks: trackUpdates = [] } = req.body;
  const folderPath = resolveUnder(suppliedPath, SAFE_ROOTS);
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  const files  = listAudioFiles(folderPath);
  const errors = [];

  // Build track-override map: filename → { title, trackNum }
  const trackMap = Object.fromEntries(trackUpdates.map(t => [t.filename, t]));

  for (const filePath of files) {
    const ext  = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const fix  = trackMap[name];

    try {
      if (ext === FLAC_EXT) {
        const albumTags = {};
        if (artist !== undefined) { albumTags.artist = artist; albumTags.albumArtist = artist; }
        if (album  !== undefined)   albumTags.album  = album;
        if (year   !== undefined)   albumTags.year   = year;
        if (genre  !== undefined)   albumTags.genre  = genre;
        if (fix?.title)             albumTags.title  = fix.title;
        if (fix?.trackNum)          albumTags.track  = fix.trackNum;
        writeFlacTags(filePath, albumTags);
      } else if (ext === '.mp3') {
        try {
          const NodeID3 = require('node-id3');
          const mp3Tags = {};
          if (artist !== undefined) { mp3Tags.artist = artist; mp3Tags.performerInfo = artist; }
          if (album  !== undefined)   mp3Tags.album  = album;
          if (year   !== undefined)   mp3Tags.year   = year;
          if (fix?.title)             mp3Tags.title  = fix.title;
          NodeID3.update(mp3Tags, filePath);
        } catch (_) {}
      }
    } catch (e) {
      errors.push({ file: name, error: e.message });
    }
  }

  res.json({ ok: errors.length === 0, updated: files.length - errors.length, errors });
});

// GET /api/tags/compare?source=<name>[&sourcePath=<abs>]&dest=<libraryFolderName>
// Compare inbox folder vs existing library folder — returns new tracks + duplicates.
router.get('/compare', validateQuery(S.TagsCompareQuery), (req, res) => {
  const { source, sourcePath: suppliedSrc, dest } = req.validatedQuery;
  const srcPath = resolveUnderOrJoin(suppliedSrc, source, [config.INBOX_PATH, config.LIBRARY_PATH]);
  const dstPath = resolveUnder(path.join(config.LIBRARY_PATH, dest), [config.LIBRARY_PATH]);

  if (!srcPath || !fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source not found' });
  if (!dstPath || !fs.existsSync(dstPath)) return res.status(404).json({ error: 'Library folder not found' });

  const srcFiles = listAudioFiles(srcPath);
  const dstFiles = listAudioFiles(dstPath);

  // Build lookup maps for the library folder
  const dstNames = new Set(dstFiles.map(f => path.basename(f).toLowerCase()));
  const dstSizes = new Map();
  for (const f of dstFiles) {
    try { dstSizes.set(fs.statSync(f).size, path.basename(f)); } catch (_) {}
  }

  const toAdd      = [];
  const duplicates = [];

  for (const f of srcFiles) {
    const name  = path.basename(f);
    const lname = name.toLowerCase();
    let   size  = 0;
    try { size = fs.statSync(f).size; } catch (_) {}

    if (dstNames.has(lname)) {
      duplicates.push({ filename: name, reason: 'same filename' });
    } else if (size > 0 && dstSizes.has(size)) {
      duplicates.push({ filename: name, reason: `same size as "${dstSizes.get(size)}"` });
    } else {
      toAdd.push({ filename: name });
    }
  }

  res.json({
    ok: true,
    srcPath,
    dstPath,
    srcCount:  srcFiles.length,
    dstCount:  dstFiles.length,
    toAdd,
    duplicates,
  });
});

// POST /api/tags/merge
// Copy only new (non-duplicate) tracks from inbox folder into existing library folder.
// Body: { sourceFolder, sourcePath (optional abs), destFolder, tags: {artist,album,year,genre}, tracks (optional MB fixes) }
router.post('/merge', validateBody(S.TagsMergeBody), (req, res) => {
  const { sourceFolder, sourcePath: suppliedSrc, destFolder,
          tags = {}, tracks: trackFixes = [] } = req.body;
  const srcPath = resolveUnderOrJoin(suppliedSrc, sourceFolder, [config.INBOX_PATH, config.LIBRARY_PATH]);
  const dstPath = resolveUnder(path.join(config.LIBRARY_PATH, destFolder), [config.LIBRARY_PATH]);

  if (!srcPath || !fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source not found' });
  if (!dstPath || !fs.existsSync(dstPath)) return res.status(404).json({ error: 'Library folder not found' });

  const srcFiles = listAudioFiles(srcPath);
  const dstFiles = listAudioFiles(dstPath);

  const dstNames = new Set(dstFiles.map(f => path.basename(f).toLowerCase()));
  const dstSizes = new Map();
  for (const f of dstFiles) {
    try { dstSizes.set(fs.statSync(f).size, path.basename(f)); } catch (_) {}
  }

  const fixMap = Object.fromEntries(trackFixes.map(t => [t.filename, t]));
  const added    = [];
  const skipped  = [];
  const errors   = [];

  for (const f of srcFiles) {
    const name  = path.basename(f);
    const lname = name.toLowerCase();
    let   size  = 0;
    try { size = fs.statSync(f).size; } catch (_) {}

    // Duplicate check
    if (dstNames.has(lname)) {
      skipped.push({ filename: name, reason: 'same filename' });
      continue;
    }
    if (size > 0 && dstSizes.has(size)) {
      skipped.push({ filename: name, reason: `same size as "${dstSizes.get(size)}"` });
      continue;
    }

    // Copy file to library
    const dstFile = path.join(dstPath, name);
    try {
      fs.copyFileSync(f, dstFile);

      // Write album-level tags (FLAC only)
      const ext = path.extname(f).toLowerCase();
      if (ext === FLAC_EXT && (tags.artist || tags.album)) {
        writeFlacTags(dstFile, {
          artist:      tags.artist,
          albumArtist: tags.artist,
          album:       tags.album,
          year:        tags.year,
          genre:       tags.genre,
        });
      }

      // Apply any per-track MB fixes
      const fix = fixMap[name];
      if (fix && ext === FLAC_EXT) {
        writeFlacTags(dstFile, {
          title: fix.title    || undefined,
          track: fix.trackNum || undefined,
        });
      }

      added.push({ filename: name });
    } catch (e) {
      errors.push({ filename: name, error: e.message });
    }
  }

  // Remove the source inbox folder if everything was handled cleanly
  if (errors.length === 0) {
    try { rmDirSync(srcPath); } catch (_) {}
    db.logActivity('move', 'merged', destFolder, {
      from: srcPath, to: dstPath,
      added: added.length, skipped: skipped.length,
    });
  }

  res.json({
    ok:       errors.length === 0,
    added,
    skipped,
    errors,
    destPath: dstPath,
  });
});

// ── Audio preview — stream first track from a folder ─────────────────────────
// GET /api/tags/preview?path=<absoluteFolderPath>
// Streams the first audio file found; supports Range header for seeking.
const AUDIO_MIME = {
  '.flac': 'audio/flac',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.aac':  'audio/aac',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma':  'audio/x-ms-wma',
  '.ape':  'audio/x-ape',
};

router.get('/preview', validateQuery(S.TagsPreviewQuery), (req, res) => {
  const folderPath = resolveUnder(req.validatedQuery.path, SAFE_ROOTS);
  if (!folderPath || !fs.existsSync(folderPath)) {
    return res.status(404).json({ error: 'Folder not found' });
  }

  const trackIdx = Math.max(0, parseInt(req.validatedQuery.track || 0, 10) || 0);

  let files;
  try { files = listAudioFiles(folderPath); } catch (_) { files = []; }
  if (files.length === 0) return res.status(404).json({ error: 'No audio files in folder' });

  const filePath = files[Math.min(trackIdx, files.length - 1)];
  const ext      = path.extname(filePath).toLowerCase();
  const mime     = AUDIO_MIME[ext] || 'audio/mpeg';

  let stat;
  try { stat = fs.statSync(filePath); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start     = parseInt(startStr, 10);
    const end       = endStr ? parseInt(endStr, 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Quarantine ────────────────────────────────────────────────────────────────
// Storage lives in SQLite (table: quarantine) via lib/db.js. The endpoint
// shapes match the legacy JSON-backed responses so the frontend doesn't need
// changing.

router.get('/quarantine', (req, res) => {
  const q = db.getQuarantine();
  q.items = q.items.map(item => ({ ...item, exists: fs.existsSync(item.path) }));
  res.json(q);
});

router.post('/quarantine', validateBody(S.TagsQuarantineBody), (req, res) => {
  const { name, path: itemPath, reason, type } = req.body;
  db.addQuarantine({ name, path: itemPath, reason: reason || '', type: type || 'inbox' });
  db.logActivity('quarantine', 'quarantined', name, { type: type || 'inbox', reason: reason || '' });
  res.json({ ok: true, count: db.getQuarantine().items.length });
});

router.delete('/quarantine/:name', (req, res) => {
  const name    = decodeURIComponent(req.params.name);
  const removed = db.removeQuarantineByName(name);
  res.json({ ok: true, removed });
});

module.exports = router;
