'use strict';
// ── lib/db-migrate.js ────────────────────────────────────────────────────────
// One-shot migration of the legacy cache/*.json files into hub.db. Called
// once at server boot — does nothing if the JSON files are gone or already
// migrated (we look for a sentinel `.migrated` rename).
//
// Strategy: read every JSON, populate the DB inside a single transaction. On
// success, rename each source file to <name>.json.migrated so the next boot
// is a no-op. On failure, the transaction rolls back and the JSONs remain —
// the server can fall back to legacy behavior or you can fix the file and
// retry.

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

function _readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn('[db-migrate] could not parse', p, '—', e.message); return null; }
}

function _renameMigrated(p) {
  if (!fs.existsSync(p)) return;
  try { fs.renameSync(p, p + '.migrated'); }
  catch (e) { console.warn('[db-migrate] rename failed for', p, '—', e.message); }
}

function migrateFromJson(cacheDir) {
  const result = { ran: false, migrated: {}, errors: [] };

  const lib    = _readJsonOrNull(path.join(cacheDir, 'library.json'));
  const dev    = _readJsonOrNull(path.join(cacheDir, 'device.json'));
  const pushed = _readJsonOrNull(path.join(cacheDir, 'pushed.json'));
  const quar   = _readJsonOrNull(path.join(cacheDir, 'quarantine.json'));
  const usage  = _readJsonOrNull(path.join(cacheDir, 'ai-usage.json'));

  // If every source is missing, nothing to do — most likely already migrated
  // or this is a fresh install.
  if (!lib && !dev && !pushed && !quar && !usage) {
    return result;
  }

  result.ran = true;
  const handle = db.getDb();

  // Wrap everything in one transaction. If any step throws, the whole thing
  // rolls back and we leave the JSON files alone. The transaction helper is
  // provided by lib/db.js since node:sqlite has no built-in equivalent.
  const tx = handle.transaction(() => {
    if (lib && Array.isArray(lib.albums)) {
      db.setAlbums('library', lib.albums);
      result.migrated.libraryAlbums = lib.albums.length;
    }

    if (dev && Array.isArray(dev.albums)) {
      db.setAlbums('device-mtp', dev.albums);
      result.migrated.deviceAlbums = dev.albums.length;
      // The previous device.json also stored a status; preserve it.
      if (dev.status) {
        db.setDeviceScanStatus({
          status:     dev.status,
          startedAt:  dev.startedAt,
          scannedAt:  dev.scannedAt,
          albumCount: dev.albumCount || dev.albums.length,
          connected:  dev.connected,
          error:      dev.error,
        });
      }
    }

    if (pushed && Array.isArray(pushed.albums)) {
      let n = 0;
      for (const a of pushed.albums) {
        if (!a || !a.key) continue;
        db.recordPush(a.artist || '', a.album || '', a.tracks || 0, a.sizeMB || 0);
        n++;
      }
      result.migrated.pushLog = n;
    }

    if (quar && Array.isArray(quar.items)) {
      let n = 0;
      for (const item of quar.items) {
        if (!item || !item.path) continue;
        db.addQuarantine(item);
        n++;
      }
      result.migrated.quarantine = n;
    }

    if (usage && (usage.calls != null || usage.inputTokens != null)) {
      const handle2 = db.getDb();
      handle2.prepare(`
        INSERT OR REPLACE INTO ai_usage (id, calls, input_tokens, output_tokens, cost_usd, reset_at, updated_at)
        VALUES (1, :calls, :input_tokens, :output_tokens, :cost_usd, :reset_at, :updated_at)
      `).run({
        calls:         usage.calls         || 0,
        input_tokens:  usage.inputTokens   || 0,
        output_tokens: usage.outputTokens  || 0,
        cost_usd:      usage.costUSD       || 0,
        reset_at:      usage.resetAt   ? new Date(usage.resetAt).getTime()   : Date.now(),
        updated_at:    usage.updatedAt ? new Date(usage.updatedAt).getTime() : Date.now(),
      });
      result.migrated.aiUsage = true;
    }
  });

  try {
    tx();
  } catch (e) {
    result.errors.push(e.message);
    return result;
  }

  // Only rename JSONs after the transaction commits.
  if (lib)    _renameMigrated(path.join(cacheDir, 'library.json'));
  if (dev)    _renameMigrated(path.join(cacheDir, 'device.json'));
  if (pushed) _renameMigrated(path.join(cacheDir, 'pushed.json'));
  if (quar)   _renameMigrated(path.join(cacheDir, 'quarantine.json'));
  if (usage)  _renameMigrated(path.join(cacheDir, 'ai-usage.json'));

  return result;
}

module.exports = { migrateFromJson };
