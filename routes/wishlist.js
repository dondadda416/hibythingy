'use strict';
// ── Wishlist route — albums you want to find/acquire ─────────────────────────
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');

const WISHLIST_FILE = path.join(config.CACHE_DIR, 'wishlist.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadWishlist() {
  try {
    if (fs.existsSync(WISHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WISHLIST_FILE, 'utf8'));
    }
  } catch (_) {}
  return { items: [] };
}

function saveWishlist(data) {
  fs.writeFileSync(WISHLIST_FILE, JSON.stringify(data, null, 2));
}

function nextId(items) {
  return items.length > 0 ? Math.max(...items.map(i => i.id || 0)) + 1 : 1;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/wishlist
router.get('/', (req, res) => {
  const data = loadWishlist();
  // Separate wanted vs found, sort each by addedAt desc
  const wanted = data.items.filter(i => i.status !== 'found').sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const found  = data.items.filter(i => i.status === 'found').sort((a, b) => (b.foundAt  || 0) - (a.foundAt  || 0));
  res.json({ items: data.items, wanted, found, wantedCount: wanted.length, foundCount: found.length });
});

// POST /api/wishlist — add a new item
// Body: { name, artist, note, source }
router.post('/', (req, res) => {
  const { name, artist, note, source } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

  const data = loadWishlist();
  const item = {
    id:       nextId(data.items),
    name:     name.trim(),
    artist:   (artist || '').trim(),
    note:     (note   || '').trim(),
    source:   source || 'manual',   // 'manual' | 'lastfm' | 'find'
    status:   'wanted',
    addedAt:  Date.now(),
    foundAt:  null,
  };
  data.items.push(item);
  saveWishlist(data);
  res.json({ ok: true, item });
});

// PATCH /api/wishlist/:id — update (mark found, edit note, etc.)
// Body: { status, note, foundPath }
router.patch('/:id', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const data = loadWishlist();
  const item = data.items.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { status, note, foundPath } = req.body || {};
  if (status !== undefined)    item.status = status;
  if (note   !== undefined)    item.note   = note.trim();
  if (foundPath !== undefined) item.foundPath = foundPath;
  if (status === 'found' && !item.foundAt) item.foundAt = Date.now();
  if (status === 'wanted') item.foundAt = null;

  saveWishlist(data);
  res.json({ ok: true, item });
});

// DELETE /api/wishlist/:id
router.delete('/:id', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const data = loadWishlist();
  const idx  = data.items.findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Item not found' });
  data.items.splice(idx, 1);
  saveWishlist(data);
  res.json({ ok: true });
});

// POST /api/wishlist/bulk — add multiple items at once (used by Last.fm import)
// Body: { items: [{ name, artist, source }] }
router.post('/bulk', (req, res) => {
  const { items: incoming } = req.body || {};
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }

  const data    = loadWishlist();
  const added   = [];
  const skipped = [];

  for (const inc of incoming) {
    if (!inc.name || !inc.name.trim()) continue;
    // Skip if already on the wishlist (by name, case-insensitive)
    const norm = inc.name.toLowerCase().trim();
    if (data.items.some(i => i.name.toLowerCase().trim() === norm)) {
      skipped.push(inc.name);
      continue;
    }
    const item = {
      id:       nextId(data.items),
      name:     inc.name.trim(),
      artist:   (inc.artist || '').trim(),
      note:     (inc.note   || '').trim(),
      source:   inc.source || 'manual',
      status:   'wanted',
      addedAt:  Date.now(),
      foundAt:  null,
    };
    data.items.push(item);
    added.push(item);
  }

  saveWishlist(data);
  res.json({ ok: true, added: added.length, skipped: skipped.length });
});

module.exports = router;
