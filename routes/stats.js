'use strict';
// ── Stats route — library analytics ──────────────────────────────────────────
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const libraryRoute = require('./library');
const deviceRoute  = require('./device');
const { AUDIO_EXTS } = require('../lib/format');

// GET /api/stats — computes collection analytics from the library cache
router.get('/', (req, res) => {
  try {
    const libData      = libraryRoute.getCache();
    const deviceAlbums = deviceRoute.getCachedAlbums() || [];

    if (!libData || !libData.albums) {
      return res.json({ ok: false, message: 'Run a library scan first.' });
    }

    const albums = libData.albums;

    // ── Top artists by album count ─────────────────────────────────────────
    const artistMap = new Map();
    for (const a of albums) {
      const artist = (a.artist || '').trim() || 'Unknown';
      artistMap.set(artist, (artistMap.get(artist) || 0) + 1);
    }
    const topArtists = [...artistMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    // ── Albums added per month (last 24 months) ───────────────────────────
    const monthMap = new Map();
    for (const a of albums) {
      if (!a.addedAt) continue;
      const d   = new Date(a.addedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, (monthMap.get(key) || 0) + 1);
    }
    const albumsByMonth = [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-24)
      .map(([month, count]) => ({ month, count }));

    // ── Format breakdown + total size (walk library album folders) ─────────
    const formatMap    = new Map();
    let totalSizeBytes = 0;
    let scannedTracks  = 0;

    for (const album of albums) {
      if (!album.path) continue;
      try {
        const files = fs.readdirSync(album.path, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const ext = path.extname(f.name).toLowerCase();
          if (!AUDIO_EXTS.has(ext)) continue;
          const label = ext.slice(1).toUpperCase();
          formatMap.set(label, (formatMap.get(label) || 0) + 1);
          scannedTracks++;
          try { totalSizeBytes += fs.statSync(path.join(album.path, f.name)).size; } catch (_) {}
        }
      } catch (_) {}
    }

    const formats = [...formatMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([format, count]) => ({ format, count }));

    // ── Recently added (last 30 days) ─────────────────────────────────────
    const cutoff30  = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent30  = albums.filter(a => (a.addedAt || 0) > cutoff30).length;

    res.json({
      ok:               true,
      albumCount:       libData.albumCount || albums.length,
      trackCount:       scannedTracks || libData.trackCount || 0,
      totalSizeGB:      +(totalSizeBytes / 1e9).toFixed(2),
      recentAlbums30:   recent30,
      topArtists,
      albumsByMonth,
      formats,
      deviceAlbumCount: deviceAlbums.length,
      scannedAt:        libData.scannedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
