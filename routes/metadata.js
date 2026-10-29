'use strict';
// ── Metadata route — scan library for albums with missing artist tags ─────────
const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const mm           = require('music-metadata');
const libraryRoute = require('./library');
const { AUDIO_EXTS } = require('../lib/format');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Read the first audio file in a folder and return its tags
async function readFirstTags(albumPath) {
  try {
    const files = fs.readdirSync(albumPath)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    if (files.length === 0) return null;
    const meta = await mm.parseFile(path.join(albumPath, files[0]), {
      duration: false,
      skipCovers: true,
    });
    return meta.common;
  } catch (_) {
    return null;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/metadata/scan
// Walks library and flags albums where the artist tag is blank or missing.
// Optional: ?field=artist (default) — reserved for future extension to other fields.
router.get('/scan', async (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, message: 'Run a library scan first.', items: [] });
  }

  const missing = [];
  let checked   = 0;

  for (const album of libData.albums) {
    if (!album.path) continue;
    const tags = await readFirstTags(album.path);
    checked++;

    const artist = tags ? (tags.albumartist || tags.artist || '').trim() : '';
    if (!artist) {
      missing.push({
        name:     album.name,
        key:      album.key  || album.name,
        path:     album.path,
        tracks:   album.tracks || 0,
        // Surface whatever tags we could read so the UI can show context
        tagTitle: tags ? (tags.album || '').trim() : '',
        tagYear:  tags ? (tags.year  || null)       : null,
      });
    }
  }

  res.json({
    ok:      true,
    items:   missing,
    count:   missing.length,
    checked,
    total:   libData.albums.length,
  });
});

// POST /api/metadata/open-mp3tag
// Convenience: opens the album folder in Mp3tag (Windows only via explorer).
// Body: { path }
router.post('/open-mp3tag', (req, res) => {
  const { path: albumPath } = req.body || {};
  if (!albumPath || !fs.existsSync(albumPath)) {
    return res.status(400).json({ error: 'Path not found' });
  }
  const { execFile } = require('child_process');
  // Try Mp3tag first, fall back to opening folder in Explorer
  execFile('Mp3tag.exe', [albumPath], { detached: true }, err => {
    if (err) {
      // Fall back to explorer
      execFile('explorer.exe', [albumPath], { detached: true }, () => {});
    }
  });
  res.json({ ok: true });
});

module.exports = router;
