'use strict';
// ── Health route — folder integrity + bitrate quality checks ─────────────────
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const fsp          = fs.promises;
const path         = require('path');
const mm           = require('music-metadata');
const { execFile } = require('child_process');
const config       = require('../config');
const libraryRoute = require('./library');
const { resolveUnder } = require('../lib/safePath');
const { validateBody } = require('../lib/validate');
const { HealthFolderBody } = require('../lib/schemas');
const { mapLimit, isAudioFile, readDirEntries, statOrNull } = require('../lib/walk');

const MIN_TRACK_BYTES     = 512 * 1024;   // 500 KB — below = suspicious
const MIN_FOLDER_BYTES    = 1024 * 1024;  // 1 MB total
const LOSSY_THRESHOLD_KBPS = 256;          // kbps — below = low quality

const LOSSY_EXTS = new Set(['.mp3', '.aac', '.m4a', '.ogg', '.wma', '.opus']);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function auditFolder(folderPath, folderName, source) {
  const entries = await readDirEntries(folderPath);
  if (!entries) return null;

  const audioFiles = entries.filter(f => f.isFile() && isAudioFile(f.name));

  if (audioFiles.length === 0) {
    return { name: folderName, path: folderPath, source, issue: 'empty', detail: 'No audio files found', tracks: 0, sizeMB: 0 };
  }

  let totalBytes = 0;
  const smallFiles = [];

  await mapLimit(audioFiles, 8, async f => {
    const st = await statOrNull(path.join(folderPath, f.name));
    if (!st) return;
    totalBytes += st.size;
    if (st.size < MIN_TRACK_BYTES) smallFiles.push(f.name);
  });

  const sizeMB = +(totalBytes / 1e6).toFixed(1);
  const tracks = audioFiles.length;
  const base   = { name: folderName, path: folderPath, source, tracks, sizeMB };

  if (tracks === 1) {
    return { ...base, issue: 'single-track', detail: 'Only 1 audio file — possibly an incomplete download' };
  }
  if (smallFiles.length > 0) {
    return { ...base, issue: 'small-files', detail: `${smallFiles.length} file(s) under 500 KB — possibly corrupt or truncated`, smallFiles };
  }
  if (totalBytes < MIN_FOLDER_BYTES) {
    return { ...base, issue: 'tiny-folder', detail: `Total ${Math.round(totalBytes / 1024)} KB — suspiciously small for a full album` };
  }

  return null; // healthy
}

// Recursive: does this folder (or any descendant) contain audio files?
async function hasAudioRecursive(dir) {
  const entries = await readDirEntries(dir);
  if (!entries) return false;
  for (const e of entries) {
    if (e.isFile() && isAudioFile(e.name)) return true;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (await hasAudioRecursive(path.join(dir, e.name))) return true;
    }
  }
  return false;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/health/folders — scan inbox + library for incomplete/suspicious folders
// ?source=both|inbox|library  (default: both)
router.get('/folders', async (req, res) => {
  const source = req.query.source || 'both';
  const issues = [];

  if (source !== 'inbox') {
    const libData = libraryRoute.getCache();
    if (libData && libData.albums) {
      await mapLimit(libData.albums, 6, async album => {
        if (!album.path) return;
        const r = await auditFolder(album.path, album.key || album.name, 'library');
        if (r) issues.push(r);
      });
    }
  }

  if (source !== 'library') {
    try {
      const inboxPath = config.INBOX_PATH;
      const inboxEntries = await readDirEntries(inboxPath);
      if (inboxEntries) {
        const dirs = inboxEntries.filter(e => e.isDirectory());
        await mapLimit(dirs, 6, async e => {
          const r = await auditFolder(path.join(inboxPath, e.name), e.name, 'inbox');
          if (r) issues.push(r);
        });
      }
    } catch (_) {}
  }

  // Sort: empties first, then small-files, then single-track, then tiny
  const ORDER = { empty: 0, 'small-files': 1, 'single-track': 2, 'tiny-folder': 3 };
  issues.sort((a, b) => (ORDER[a.issue] ?? 9) - (ORDER[b.issue] ?? 9));

  res.json({ ok: true, issues, count: issues.length });
});

// GET /api/health/quality — scan library lossy albums for low bitrate
// Reads the first audio track per album using music-metadata (tag-based, no ffprobe needed)
router.get('/quality', async (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, message: 'Run a library scan first.', items: [] });
  }

  const lowQuality = [];

  // Bound concurrency — music-metadata reads tag headers, but on a slow drive
  // hammering it 1000-wide will trash IO.
  await mapLimit(libData.albums, 4, async album => {
    if (!album.path) return;
    const entries = await readDirEntries(album.path);
    if (!entries) return;
    const lossy = entries
      .filter(f => f.isFile() && LOSSY_EXTS.has(path.extname(f.name).toLowerCase()))
      .map(f => f.name)
      .sort();
    if (lossy.length === 0) return; // lossless — skip

    const firstFile = path.join(album.path, lossy[0]);
    try {
      const meta        = await mm.parseFile(firstFile, { duration: false, skipCovers: true });
      const bitrateKbps = meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null;
      const format      = path.extname(lossy[0]).slice(1).toUpperCase();

      if (bitrateKbps && bitrateKbps < LOSSY_THRESHOLD_KBPS) {
        lowQuality.push({
          name:        album.name,
          artist:      album.artist || '',
          path:        album.path,
          format,
          bitrateKbps,
          tracks:      album.tracks || lossy.length,
        });
      }
    } catch (_) {}
  });

  lowQuality.sort((a, b) => a.bitrateKbps - b.bitrateKbps); // worst first

  res.json({
    ok:        true,
    items:     lowQuality,
    count:     lowQuality.length,
    total:     libData.albums.length,
    threshold: LOSSY_THRESHOLD_KBPS,
  });
});

// DELETE /api/health/folder — delete a single folder (safety: must be empty of audio)
// Body: { folderPath }
router.delete('/folder', validateBody(HealthFolderBody), async (req, res) => {
  const { folderPath: suppliedPath } = req.body;
  // Canonicalise + verify the candidate path sits under one of the managed roots.
  const folderPath = resolveUnder(suppliedPath, [config.INBOX_PATH, config.LIBRARY_PATH]);
  if (!folderPath) return res.status(403).json({ error: 'Path is outside managed folders' });

  if (!fs.existsSync(folderPath)) return res.json({ ok: true, message: 'Already gone' });

  if (await hasAudioRecursive(folderPath)) {
    return res.status(400).json({ error: 'Folder contains audio files — delete manually if intentional' });
  }

  try {
    await fsp.rm(folderPath, { recursive: true, force: true });
    res.json({ ok: true, deleted: folderPath });
  } catch (err) {
    console.error('[health/folder]', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// POST /api/health/delete-empty — bulk delete ALL empty (no-audio) inbox folders
router.post('/delete-empty', async (req, res) => {
  const inboxPath = config.INBOX_PATH;
  if (!fs.existsSync(inboxPath)) return res.status(400).json({ error: 'Inbox path not found' });

  const deleted = [];
  const errors  = [];

  const entries = await readDirEntries(inboxPath);
  if (!entries) return res.status(500).json({ error: 'Could not read inbox' });

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(inboxPath, e.name);
    if (!await hasAudioRecursive(full)) {
      try {
        await fsp.rm(full, { recursive: true, force: true });
        deleted.push(e.name);
      } catch (err) {
        errors.push({ name: e.name, error: err.message });
      }
    }
  }

  res.json({ ok: true, deleted, errors, count: deleted.length });
});

// GET /api/health/flac-integrity — scan FLACs in the library for signs of
// truncation or improper encoding. Pure-JS check: every healthy FLAC has a
// non-zero MD5 of its decoded audio in the STREAMINFO block. Files with an
// all-zero MD5 were either re-encoded with --no-md5sum or weren't finalised
// after a transcode. Files significantly smaller than their declared sample
// count suggest truncation. Full bit-rot verification still needs `flac -t`
// run externally.
router.get('/flac-integrity', async (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, message: 'Run a library scan first.', items: [] });
  }

  const issues = [];
  let scanned = 0;

  await mapLimit(libData.albums, 4, async album => {
    if (!album.path) return;
    const entries = await readDirEntries(album.path);
    if (!entries) return;
    const flacs = entries
      .filter(f => f.isFile() && path.extname(f.name).toLowerCase() === '.flac')
      .map(f => f.name)
      .sort();

    for (const name of flacs) {
      scanned++;
      const filePath = path.join(album.path, name);
      let meta;
      try {
        meta = await mm.parseFile(filePath, { duration: false, skipCovers: true });
      } catch (e) {
        issues.push({
          file: name, album: album.name, artist: album.artist || '',
          path: filePath, kind: 'unreadable', detail: 'Header parse failed: ' + e.message,
        });
        continue;
      }
      const md5 = (meta.format && meta.format.audioMD5) || null;
      // music-metadata returns md5 as a Buffer; check for all-zero.
      const md5Hex = md5 ? Buffer.from(md5).toString('hex') : '';
      if (!md5Hex || /^0+$/.test(md5Hex)) {
        issues.push({
          file: name, album: album.name, artist: album.artist || '',
          path: filePath, kind: 'no-md5',
          detail: 'Stream MD5 is missing or all-zeros — file may not have been properly finalised',
        });
        continue;
      }
      // Sample-count vs file-size sanity check. A 16-bit/44.1kHz stereo FLAC
      // compresses to ~50-60% of raw, so observed bytes must be at least
      // ~30% of (sampleCount * channels * bitsPerSample / 8) to be plausible.
      const fmt = meta.format || {};
      if (fmt.numberOfSamples && fmt.sampleRate && fmt.bitsPerSample && fmt.numberOfChannels) {
        const rawBytes = fmt.numberOfSamples * fmt.numberOfChannels * (fmt.bitsPerSample / 8);
        const minPlausible = Math.floor(rawBytes * 0.30);
        const stat = await statOrNull(filePath);
        if (stat && stat.size < minPlausible && stat.size > 0) {
          issues.push({
            file: name, album: album.name, artist: album.artist || '',
            path: filePath, kind: 'truncated',
            detail: `File is ${(stat.size / 1024 / 1024).toFixed(1)} MB but declares ${(rawBytes / 1024 / 1024).toFixed(0)} MB of audio — likely truncated`,
          });
        }
      }
    }
  });

  res.json({
    ok: true,
    scanned,
    items: issues,
    count: issues.length,
    note: 'Pure-JS check. For full bit-rot verification run `flac -t *.flac` externally.',
  });
});

// POST /api/health/open-folder — open a folder in Windows Explorer
// Body: { folderPath }
router.post('/open-folder', validateBody(HealthFolderBody), (req, res) => {
  const { folderPath: suppliedPath } = req.body;
  const folderPath = resolveUnder(suppliedPath, [config.INBOX_PATH, config.LIBRARY_PATH]);
  if (!folderPath) return res.status(403).json({ error: 'Path is outside managed folders' });

  execFile('explorer.exe', [folderPath], () => {
    // Explorer always returns a non-zero exit code — ignore it
    res.json({ ok: true });
  });
});

module.exports = router;
