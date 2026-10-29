'use strict';
// ── Activity log route ──────────────────────────────────────────────────────
// Read-only feed of recent destructive/state-changing actions. Routes that
// matter call db.logActivity directly; this route surfaces the result.

const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');

// GET /api/activity?limit=50&offset=0
// Defaults: most-recent first, 50 entries. Cap at 500 to keep payloads sane.
router.get('/', (req, res) => {
  const limit  = parseInt(req.query.limit,  10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  try {
    const items = db.getActivity(limit, offset);
    const total = db.getActivityCount();
    res.json({ ok: true, items, total });
  } catch (e) {
    console.error('[activity]', e.message);
    res.status(500).json({ error: 'Failed to read activity' });
  }
});

// DELETE /api/activity?olderThanDays=30 — prune entries older than N days.
// Without the param, deletes everything (kept opt-in for now).
router.delete('/', (req, res) => {
  const days = parseInt(req.query.olderThanDays, 10);
  let cutoff;
  if (Number.isFinite(days) && days > 0) {
    cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  } else {
    cutoff = Date.now();
  }
  try {
    const removed = db.pruneActivity(cutoff);
    db.logActivity('system', 'activity-pruned', null, { removed, days: Number.isFinite(days) ? days : null });
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: 'Prune failed' });
  }
});

module.exports = router;
