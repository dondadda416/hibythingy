'use strict';
// ── Smart playlists route ───────────────────────────────────────────────────
// CRUD over saved filter specs + a /run endpoint that re-applies the filter
// to the current library cache. The query is JS-side (lib/smartFilter.js)
// because the library cache lives in DB rows shaped for the legacy JSON
// format. SQL-direct querying is a future optimisation; today the dataset is
// small (thousands of albums max) and JS filtering is sub-ms.

const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const libraryRoute    = require('./library');
const { applySmartFilter, detectFormat, detectYear } = require('../lib/smartFilter');
const { validateBody } = require('../lib/validate');
const { SmartPlaylistCreateBody, SmartPlaylistUpdateBody, SmartFilterSpec } = require('../lib/schemas');

// GET /api/smart-playlists — list every saved spec
router.get('/', (req, res) => {
  try { res.json({ ok: true, items: db.listSmartPlaylists() }); }
  catch (e) { console.error('[smart-playlist/list]', e.message); res.status(500).json({ error: 'List failed' }); }
});

// POST /api/smart-playlists — save a new spec
router.post('/', validateBody(SmartPlaylistCreateBody), (req, res) => {
  try {
    const { name, definition } = req.body;
    const created = db.createSmartPlaylist(name, definition);
    res.json({ ok: true, item: created });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'A smart playlist with that name already exists' });
    console.error('[smart-playlist/create]', e.message);
    res.status(500).json({ error: 'Save failed' });
  }
});

// GET /api/smart-playlists/:id — fetch one
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const item = db.getSmartPlaylist(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, item });
});

// PUT /api/smart-playlists/:id — update name and/or definition
router.put('/:id', validateBody(SmartPlaylistUpdateBody), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cur = db.getSmartPlaylist(id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { name, definition } = req.body;
  try {
    const updated = db.updateSmartPlaylist(id, name || cur.name, definition || cur.definition);
    res.json({ ok: true, item: updated });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'Name already in use' });
    console.error('[smart-playlist/update]', e.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/smart-playlists/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const removed = db.deleteSmartPlaylist(id);
  res.json({ ok: true, removed });
});

// GET /api/smart-playlists/:id/run — apply the saved spec, return albums
router.get('/:id/run', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const sp = db.getSmartPlaylist(id);
  if (!sp) return res.status(404).json({ error: 'Not found' });

  const cache = libraryRoute.getCache();
  if (!cache || !cache.albums) return res.json({ ok: true, items: [], count: 0, message: 'Library not scanned yet' });

  const items = applySmartFilter(cache.albums, sp.definition).map(a => ({
    ...a,
    format: detectFormat(a),
    year:   detectYear(a),
  }));
  res.json({ ok: true, items, count: items.length, name: sp.name, definition: sp.definition });
});

// POST /api/smart-playlists/preview — run an unsaved spec for the filter UI
router.post('/preview', validateBody(SmartFilterSpec), (req, res) => {
  const cache = libraryRoute.getCache();
  if (!cache || !cache.albums) return res.json({ ok: true, items: [], count: 0, message: 'Library not scanned yet' });

  const items = applySmartFilter(cache.albums, req.body).map(a => ({
    ...a,
    format: detectFormat(a),
    year:   detectYear(a),
  }));
  res.json({ ok: true, items, count: items.length });
});

module.exports = router;
