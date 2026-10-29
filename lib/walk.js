'use strict';
// ── lib/walk.js ──────────────────────────────────────────────────────────────
// Shared filesystem-walk primitives. Replaces three near-identical copies of
// `mapLimit` + readdir-with-error-suppression that lived in routes/inbox.js,
// routes/library.js, and routes/health.js.

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;
const { AUDIO_EXTS } = require('./format');

// Bounded concurrency runner. Calls fn(item, idx) for each item, no more than
// `limit` in flight at once. Resolves to an array of results in input order.
async function mapLimit(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// True if `name` (a filename or path) ends with an audio extension we care about.
function isAudioFile(name) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

// Read directory entries with withFileTypes:true. Swallows ENOENT/EACCES and
// returns null so callers can short-circuit cleanly.
async function readDirEntries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch (_) { return null; }
}

// fs.stat with the same swallow-on-error contract — returns null on failure.
async function statOrNull(p) {
  try { return await fsp.stat(p); }
  catch (_) { return null; }
}

module.exports = { mapLimit, isAudioFile, readDirEntries, statOrNull };
