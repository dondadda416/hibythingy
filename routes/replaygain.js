'use strict';
// ── ReplayGain route — scan for missing RG tags, apply via rsgain ────────────
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const mm           = require('music-metadata');
const { execFile } = require('child_process');
const libraryRoute = require('./library');
const { AUDIO_EXTS } = require('../lib/format');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns true if the first audio file in albumPath has any ReplayGain tag
async function hasReplayGain(albumPath) {
  try {
    const files = fs.readdirSync(albumPath)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    if (files.length === 0) return null; // no audio

    const meta = await mm.parseFile(path.join(albumPath, files[0]), { duration: false, skipCovers: true });

    // Check common tags first
    if (meta.common.replaygain_album_gain !== undefined) return true;
    if (meta.common.replaygain_track_gain !== undefined) return true;

    // Check native tags (covers ID3 TXXX frames, Vorbis comments, etc.)
    for (const tags of Object.values(meta.native || {})) {
      for (const tag of tags) {
        if (tag.id && tag.id.toLowerCase().includes('replaygain')) return true;
        if (tag.id === 'TXXX' && tag.value && typeof tag.value === 'object') {
          const desc = (tag.value.description || '').toLowerCase();
          if (desc.includes('replaygain')) return true;
        }
      }
    }
    return false;
  } catch (_) { return null; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/replaygain/scan — albums missing ReplayGain tags
router.get('/scan', async (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, message: 'Run a library scan first.', items: [] });
  }

  const missing = [];
  let checked   = 0;

  for (const album of libData.albums) {
    if (!album.path) continue;
    const has = await hasReplayGain(album.path);
    checked++;
    if (has === false) {  // null = no audio files, skip
      missing.push({
        name:   album.name,
        artist: album.artist || '',
        path:   album.path,
        tracks: album.tracks || 0,
      });
    }
  }

  res.json({ ok: true, items: missing, count: missing.length, checked, total: libData.albums.length });
});

// POST /api/replaygain/apply — run rsgain on a single album folder
// Body: { albumPath }
router.post('/apply', (req, res) => {
  const { albumPath } = req.body || {};
  if (!albumPath)              return res.status(400).json({ error: 'albumPath required' });
  if (!fs.existsSync(albumPath)) return res.status(400).json({ error: 'Path not found on disk' });

  // rsgain easy mode:
  //  easy  scan folder, write album + track gain tags, skip already-tagged files
  execFile(
    'rsgain',
    ['easy', albumPath],
    { timeout: 120_000 },
    (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').slice(-500);
        if (err.code === 'ENOENT') {
          return res.status(500).json({
            error: 'rsgain not found. Download rsgain.exe from https://github.com/complexlogic/rsgain/releases and add it to your PATH.',
            detail,
          });
        }
        return res.status(500).json({ error: err.message, detail });
      }
      res.json({ ok: true, output: (stdout || stderr || '').slice(-500) });
    }
  );
});

// POST /api/replaygain/apply-batch — queue multiple albums
// Body: { albums: [{name, path}, ...] }
// Processes sequentially to avoid overwhelming the disk; streams progress via JSON array
router.post('/apply-batch', async (req, res) => {
  const { albums } = req.body || {};
  if (!albums || !Array.isArray(albums) || albums.length === 0) {
    return res.status(400).json({ error: 'albums array required' });
  }

  // Use streaming JSON so the client can see progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.flushHeaders();

  for (const album of albums) {
    if (!album.path || !fs.existsSync(album.path)) {
      res.write(JSON.stringify({ name: album.name, ok: false, error: 'Path not found' }) + '\n');
      continue;
    }

    await new Promise(resolve => {
      execFile('rsgain', ['easy', album.path], { timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          res.write(JSON.stringify({ name: album.name, ok: false, error: err.code === 'ENOENT' ? 'rsgain not found — download from github.com/complexlogic/rsgain/releases' : err.message }) + '\n');
        } else {
          res.write(JSON.stringify({ name: album.name, ok: true }) + '\n');
        }
        resolve();
      });
    });
  }

  res.end();
});

module.exports = router;
