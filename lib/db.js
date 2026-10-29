'use strict';
// ── lib/db.js ────────────────────────────────────────────────────────────────
// SQLite-backed storage for HiBy Hub. Replaces the previous fan of JSON cache
// files (cache/library.json, device.json, pushed.json, quarantine.json,
// ai-usage.json). Reasons:
//   - Atomic writes are free (transactions).
//   - Concurrent-write safety is free (BEGIN IMMEDIATE).
//   - Indexed reads stay sub-ms even at 10k+ albums.
//   - Smart-playlist queries become trivial.
//
// All persistence flows through this module. Routes never touch sqlite
// directly — they call the named accessors below. This keeps the schema
// behind a single seam so future migrations only have to touch one file.
//
// On boot:
//   const { open } = require('./lib/db');
//   open(config.CACHE_DIR);
//   require('./lib/db-migrate').migrateFromJson(config.CACHE_DIR);

const fs   = require('fs');
const path = require('path');

// Cross-instance singleton. Vitest loads .js source through Vite's ESM
// transformer for tests but lib/db-migrate.js still does `require('./db')`,
// so the two copies of this module would otherwise hold separate `_state.db`
// references. Storing the handle on globalThis under a registered Symbol
// guarantees both copies see the same connection.
const GLOBAL_KEY = Symbol.for('hibyhub.db.state');
const _state = globalThis[GLOBAL_KEY] || (globalThis[GLOBAL_KEY] = { db: null, stmts: null });

const CURRENT_SCHEMA_VERSION = 5;

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Albums table is shared by both the master library and the MTP device cache.
-- The 'source' column distinguishes them. Composite UNIQUE on (source, key)
-- means we can bulk-replace either set without touching the other.
CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,                -- 'library' | 'device-mtp'
  key         TEXT    NOT NULL,                -- folder key / matching key
  name        TEXT    NOT NULL,
  artist      TEXT    DEFAULT '',
  album       TEXT    DEFAULT '',
  tracks      INTEGER DEFAULT 0,
  size_mb     REAL    DEFAULT 0,
  path        TEXT,                            -- absolute fs path (NULL on MTP)
  added_at    INTEGER,                         -- ms epoch
  scanned_at  INTEGER,                         -- ms epoch
  extra_json  TEXT,                            -- catch-all for source-specific fields
  UNIQUE(source, key)
);

CREATE INDEX IF NOT EXISTS idx_albums_source ON albums(source);
CREATE INDEX IF NOT EXISTS idx_albums_key    ON albums(key);
CREATE INDEX IF NOT EXISTS idx_albums_added  ON albums(added_at);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist);

-- Persistent record of every successful push to the device. Append-only-ish
-- (re-pushes update the existing row keyed on the canonical "Artist — Album").
CREATE TABLE IF NOT EXISTS push_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL UNIQUE,
  artist     TEXT,
  album      TEXT,
  tracks     INTEGER DEFAULT 0,
  size_mb    REAL    DEFAULT 0,
  pushed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_log_pushed ON push_log(pushed_at);

-- User-flagged items the wizard / sync should skip.
CREATE TABLE IF NOT EXISTS quarantine (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  path            TEXT    NOT NULL UNIQUE,
  reason          TEXT    DEFAULT '',
  type            TEXT    NOT NULL DEFAULT 'inbox',  -- 'inbox' | 'sync' | 'library'
  quarantined_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_type ON quarantine(type);

-- Single-row table for cumulative AI cost tracking.
CREATE TABLE IF NOT EXISTS ai_usage (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  calls          INTEGER DEFAULT 0,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  cost_usd       REAL    DEFAULT 0,
  reset_at       INTEGER NOT NULL,
  updated_at     INTEGER
);

-- MTP scan status (single row). The previous 'scanning'/'done' marker was
-- shoehorned into device.json; here it's a real column with a clear shape.
CREATE TABLE IF NOT EXISTS device_scan_status (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  status      TEXT,
  started_at  INTEGER,
  scanned_at  INTEGER,
  album_count INTEGER,
  connected   INTEGER,                         -- 0/1
  error       TEXT
);

-- Saved filter specs that re-run against the current library each time
-- they're opened. definition is a JSON blob — see lib/smartFilter for shape.
CREATE TABLE IF NOT EXISTS smart_playlists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  definition   TEXT    NOT NULL,             -- JSON
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Append-only audit log of significant actions (tags applied, albums moved
-- to library, pushed to device, push-log cleared, library scans, etc.).
-- Surfaces in the Dashboard "Recent Activity" widget.
CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT    NOT NULL,             -- 'tag' | 'move' | 'push' | 'sync' | 'scan' | 'quarantine' | 'system'
  action       TEXT    NOT NULL,             -- machine-readable verb (e.g. 'tag-applied')
  subject      TEXT,                         -- human-readable subject (album/folder name)
  details_json TEXT                          -- arbitrary JSON for kind-specific extras
);
CREATE INDEX IF NOT EXISTS idx_activity_log_ts ON activity_log(ts);
CREATE INDEX IF NOT EXISTS idx_activity_log_kind ON activity_log(kind);

-- User-starred albums. Decoupled from the albums table (which is bulk-
-- replaced on every library scan) so favorites survive rescans. Linked by
-- the album's normalised key; a missing album is fine — the favorite just
-- becomes a "remembered" star ready for when the album reappears.
CREATE TABLE IF NOT EXISTS favorites (
  album_key   TEXT    NOT NULL UNIQUE,
  starred_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorites_starred_at ON favorites(starred_at);

-- Wheelhouse sync (v5). The R4 pulls music over Wi-Fi instead of Hub pushing
-- it over USB. "Push to HiBy" now adds a row here; Wheelhouse fetches the
-- queue, downloads straight from R2, and reports each item done or failed.
--   kind:   'album' | 'playlist'
--   action: 'download' | 'delete'
--   rel_path: path relative to the library root (forward slashes), which is
--             also where the file/folder goes under the R4's music folder.
CREATE TABLE IF NOT EXISTS device_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER,
  kind        TEXT    NOT NULL DEFAULT 'album',
  action      TEXT    NOT NULL DEFAULT 'download',
  rel_path    TEXT    NOT NULL,
  artist      TEXT    DEFAULT '',
  album       TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'queued',  -- queued | running | done | error | cancelled
  tracks      INTEGER DEFAULT 0,
  size_mb     REAL    DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_queue_status ON device_queue(status);

-- Last time Wheelhouse checked in (single row).
CREATE TABLE IF NOT EXISTS device_heartbeat (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen    INTEGER NOT NULL,
  device_name  TEXT,
  app_version  TEXT,
  free_mb      REAL,
  total_mb     REAL,
  ip           TEXT,
  scan_wanted  INTEGER DEFAULT 0
);
`;

function _migrateSchema(db) {
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  const current = row ? row.version : 0;
  if (current === CURRENT_SCHEMA_VERSION) return;
  // Schema CREATEs are all IF NOT EXISTS, so any new tables just appeared on
  // exec(SCHEMA_SQL) above. We only need to stamp the version row.
  if (current === 0) {
    db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  } else if (current < CURRENT_SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
  }
}

function open(cacheDir, opts = {}) {
  if (_state.db) return _state.db; // idempotent

  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const dbPath = opts.path || path.join(cacheDir, 'hub.db');

  // node:sqlite is bundled with Node 22.5+ (stable in 24+). Zero native-build
  // requirement, which matters on Windows where node-gyp + Visual Studio are
  // a heavy ask. We previously used better-sqlite3 but its prebuilt binaries
  // didn't cover bleeding-edge Node and dropped users into a node-gyp build.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error(
      'node:sqlite is unavailable. HiBy Hub requires Node 22.5 or newer (you have ' + process.version + '). ' +
      'Upgrade Node and retry.'
    );
  }

  _state.db = new DatabaseSync(dbPath);
  // Pragmas tuned for a single-process app: WAL gives concurrent readers,
  // NORMAL sync is WAL-safe and avoids fsync per write.
  _state.db.exec('PRAGMA journal_mode = WAL');
  _state.db.exec('PRAGMA synchronous = NORMAL');
  _state.db.exec('PRAGMA foreign_keys = ON');

  // node:sqlite has no .transaction(fn) helper — provide one. Wraps a function
  // in BEGIN IMMEDIATE/COMMIT/ROLLBACK so callers can reuse the better-sqlite3
  // ergonomics. BEGIN IMMEDIATE acquires a write lock up front so concurrent
  // writers serialise instead of racing then failing on commit.
  //
  // SQLite does not allow nested BEGIN/COMMIT, but several of our accessors
  // (setAlbums) wrap their own writes in a transaction. The migration also
  // wraps everything in one. The depth counter below makes inner transactions
  // a no-op: they run inline and the outer transaction owns the commit. If
  // any inner step throws, the outer ROLLBACK still covers all the writes.
  _state.txDepth = 0;
  _state.db.transaction = (fn) => {
    return (...args) => {
      if (_state.txDepth > 0) {
        // Already inside a transaction — run inline. Outer scope owns commit/rollback.
        return fn.apply(null, args);
      }
      _state.db.exec('BEGIN IMMEDIATE');
      _state.txDepth++;
      try {
        const result = fn.apply(null, args);
        _state.db.exec('COMMIT');
        return result;
      } catch (err) {
        try { _state.db.exec('ROLLBACK'); } catch (_) {}
        throw err;
      } finally {
        _state.txDepth--;
      }
    };
  };

  _migrateSchema(_state.db);
  _prepareStatements(_state.db);
  return _state.db;
}

function close() {
  if (_state.db) {
    try { _state.db.close(); } catch (_) {}
    _state.db = null;
    _state.stmts = null;
  }
}

function getDb() {
  if (!_state.db) throw new Error('db.open() has not been called');
  return _state.db;
}

// ── Prepared statements ──────────────────────────────────────────────────────

function _prepareStatements(db) {
  // node:sqlite uses :name placeholders rather than @name. Statement runs
  // accept a plain object whose keys are the placeholder names (no leading
  // colon).
  _state.stmts = {
    // Albums
    deleteAlbumsBySource: db.prepare('DELETE FROM albums WHERE source = ?'),
    insertAlbum: db.prepare(`
      INSERT INTO albums (source, key, name, artist, album, tracks, size_mb, path, added_at, scanned_at, extra_json)
      VALUES (:source, :key, :name, :artist, :album, :tracks, :size_mb, :path, :added_at, :scanned_at, :extra_json)
      ON CONFLICT(source, key) DO UPDATE SET
        name=excluded.name, artist=excluded.artist, album=excluded.album,
        tracks=excluded.tracks, size_mb=excluded.size_mb, path=excluded.path,
        added_at=excluded.added_at, scanned_at=excluded.scanned_at, extra_json=excluded.extra_json
    `),
    selectAlbumsBySource: db.prepare('SELECT * FROM albums WHERE source = ? ORDER BY key COLLATE NOCASE'),
    countAlbumsBySource:  db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tracks), 0) AS t FROM albums WHERE source = ?'),
    selectAlbumByKey:     db.prepare('SELECT * FROM albums WHERE source = ? AND key = ?'),

    // Push log
    insertPush: db.prepare(`
      INSERT INTO push_log (key, artist, album, tracks, size_mb, pushed_at)
      VALUES (:key, :artist, :album, :tracks, :size_mb, :pushed_at)
      ON CONFLICT(key) DO UPDATE SET
        artist=excluded.artist, album=excluded.album,
        tracks=excluded.tracks, size_mb=excluded.size_mb,
        pushed_at=excluded.pushed_at
    `),
    selectPushLog: db.prepare('SELECT * FROM push_log ORDER BY key COLLATE NOCASE'),
    countPushLog:  db.prepare('SELECT COUNT(*) AS n FROM push_log'),
    clearPushLog:  db.prepare('DELETE FROM push_log'),
    deletePushByKey: db.prepare('DELETE FROM push_log WHERE key = ?'),

    // Quarantine
    insertQuarantine: db.prepare(`
      INSERT INTO quarantine (name, path, reason, type, quarantined_at)
      VALUES (:name, :path, :reason, :type, :quarantined_at)
      ON CONFLICT(path) DO UPDATE SET
        name=excluded.name, reason=excluded.reason,
        type=excluded.type, quarantined_at=excluded.quarantined_at
    `),
    selectQuarantine: db.prepare('SELECT * FROM quarantine ORDER BY quarantined_at DESC'),
    deleteQuarantineByName: db.prepare('DELETE FROM quarantine WHERE name = ?'),
    deleteQuarantineByPath: db.prepare('DELETE FROM quarantine WHERE path = ?'),

    // AI usage
    selectAiUsage: db.prepare('SELECT * FROM ai_usage WHERE id = 1'),
    upsertAiUsage: db.prepare(`
      INSERT INTO ai_usage (id, calls, input_tokens, output_tokens, cost_usd, reset_at, updated_at)
      VALUES (1, :calls, :input_tokens, :output_tokens, :cost_usd, :reset_at, :updated_at)
      ON CONFLICT(id) DO UPDATE SET
        calls=excluded.calls, input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd,
        reset_at=excluded.reset_at, updated_at=excluded.updated_at
    `),

    // Device scan status
    selectScanStatus: db.prepare('SELECT * FROM device_scan_status WHERE id = 1'),
    upsertScanStatus: db.prepare(`
      INSERT INTO device_scan_status (id, status, started_at, scanned_at, album_count, connected, error)
      VALUES (1, :status, :started_at, :scanned_at, :album_count, :connected, :error)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, started_at=excluded.started_at,
        scanned_at=excluded.scanned_at, album_count=excluded.album_count,
        connected=excluded.connected, error=excluded.error
    `),

    // Wheelhouse queue
    insertQueue: db.prepare(`
      INSERT INTO device_queue (batch_id, kind, action, rel_path, artist, album, status, tracks, size_mb, created_at, updated_at)
      VALUES (:batch_id, :kind, :action, :rel_path, :artist, :album, 'queued', :tracks, :size_mb, :now, :now)
    `),
    selectQueueOpenDup: db.prepare(`SELECT * FROM device_queue WHERE kind = ? AND action = ? AND rel_path = ? AND status IN ('queued','running') LIMIT 1`),
    selectQueueOpen:   db.prepare(`SELECT * FROM device_queue WHERE status IN ('queued','running') ORDER BY id`),
    selectQueueRecent: db.prepare(`SELECT * FROM device_queue ORDER BY id DESC LIMIT ?`),
    selectQueueById:   db.prepare(`SELECT * FROM device_queue WHERE id = ?`),
    updateQueueStatus: db.prepare(`UPDATE device_queue SET status = :status, error = :error, updated_at = :now WHERE id = :id`),
    maxQueueBatch:     db.prepare(`SELECT COALESCE(MAX(batch_id), 0) AS m, COALESCE(MAX(id), 0) AS i FROM device_queue`),
    pruneQueue:        db.prepare(`DELETE FROM device_queue WHERE status IN ('done','error','cancelled') AND updated_at < ?`),
    resetStaleRunning: db.prepare(`UPDATE device_queue SET status = 'queued', updated_at = :now WHERE status = 'running' AND updated_at < :cutoff`),

    // Wheelhouse heartbeat
    selectHeartbeat: db.prepare('SELECT * FROM device_heartbeat WHERE id = 1'),
    upsertHeartbeat: db.prepare(`
      INSERT INTO device_heartbeat (id, last_seen, device_name, app_version, free_mb, total_mb, ip, scan_wanted)
      VALUES (1, :last_seen, :device_name, :app_version, :free_mb, :total_mb, :ip, 0)
      ON CONFLICT(id) DO UPDATE SET
        last_seen=excluded.last_seen,
        device_name=COALESCE(excluded.device_name, device_heartbeat.device_name),
        app_version=COALESCE(excluded.app_version, device_heartbeat.app_version),
        free_mb=COALESCE(excluded.free_mb, device_heartbeat.free_mb),
        total_mb=COALESCE(excluded.total_mb, device_heartbeat.total_mb),
        ip=excluded.ip
    `),
    setScanWanted: db.prepare(`
      INSERT INTO device_heartbeat (id, last_seen, scan_wanted) VALUES (1, 0, :wanted)
      ON CONFLICT(id) DO UPDATE SET scan_wanted = excluded.scan_wanted
    `),

    // Favorites
    selectFavorites:    db.prepare('SELECT album_key, starred_at FROM favorites ORDER BY starred_at DESC'),
    selectFavoriteKeys: db.prepare('SELECT album_key FROM favorites'),
    insertFavorite:     db.prepare('INSERT OR IGNORE INTO favorites (album_key, starred_at) VALUES (?, ?)'),
    deleteFavorite:     db.prepare('DELETE FROM favorites WHERE album_key = ?'),
    isFavorite:         db.prepare('SELECT 1 FROM favorites WHERE album_key = ?'),

    // Activity log
    insertActivity: db.prepare(`
      INSERT INTO activity_log (ts, kind, action, subject, details_json)
      VALUES (:ts, :kind, :action, :subject, :details_json)
    `),
    selectActivity: db.prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT :limit OFFSET :offset'),
    countActivity:  db.prepare('SELECT COUNT(*) AS n FROM activity_log'),
    pruneActivity:  db.prepare('DELETE FROM activity_log WHERE ts < ?'),

    // Smart playlists
    selectSmartPlaylists: db.prepare('SELECT id, name, definition, created_at, updated_at FROM smart_playlists ORDER BY name COLLATE NOCASE'),
    selectSmartPlaylistById: db.prepare('SELECT id, name, definition, created_at, updated_at FROM smart_playlists WHERE id = ?'),
    insertSmartPlaylist: db.prepare(`
      INSERT INTO smart_playlists (name, definition, created_at, updated_at)
      VALUES (:name, :definition, :created_at, :updated_at)
    `),
    updateSmartPlaylist: db.prepare(`
      UPDATE smart_playlists SET name = :name, definition = :definition, updated_at = :updated_at
      WHERE id = :id
    `),
    deleteSmartPlaylist: db.prepare('DELETE FROM smart_playlists WHERE id = ?'),
  };
}

// ── Albums ───────────────────────────────────────────────────────────────────

function _albumRowToObj(row) {
  if (!row) return null;
  const out = {
    key:       row.key,
    name:      row.name,
    artist:    row.artist || '',
    album:     row.album  || '',
    tracks:    row.tracks || 0,
    sizeMB:    row.size_mb || 0,
    path:      row.path || '',
    addedAt:   row.added_at || 0,
    scannedAt: row.scanned_at || 0,
  };
  if (row.extra_json) {
    try { Object.assign(out, JSON.parse(row.extra_json)); }
    catch (_) {}
  }
  return out;
}

function _albumObjToRow(source, a) {
  const known = new Set(['key', 'name', 'artist', 'album', 'tracks', 'sizeMB', 'path', 'addedAt', 'scannedAt']);
  const extra = {};
  for (const [k, v] of Object.entries(a)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    source,
    key:        a.key  || a.name || '',
    name:       a.name || a.key  || '',
    artist:     a.artist || '',
    album:      a.album  || '',
    tracks:     Number.isFinite(a.tracks) ? a.tracks : 0,
    size_mb:    Number.isFinite(a.sizeMB) ? a.sizeMB : 0,
    path:       a.path || null,
    added_at:   a.addedAt || null,
    scanned_at: a.scannedAt || null,
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

// Bulk-replace every album for a given source. Wrapped in a transaction so
// readers never see a half-replaced set.
function setAlbums(source, albums) {
  if (!Array.isArray(albums)) return;
  const tx = _state.db.transaction((src, list) => {
    _state.stmts.deleteAlbumsBySource.run(src);
    for (const a of list) {
      const row = _albumObjToRow(src, a);
      if (!row.key) continue;
      _state.stmts.insertAlbum.run(row);
    }
  });
  tx(source, albums);
}

function getAlbums(source) {
  return _state.stmts.selectAlbumsBySource.all(source).map(_albumRowToObj);
}

function getAlbumCount(source) {
  const r = _state.stmts.countAlbumsBySource.get(source);
  return { albumCount: r.n, trackCount: r.t };
}

function getAlbumByKey(source, key) {
  return _albumRowToObj(_state.stmts.selectAlbumByKey.get(source, key));
}

// ── Push log ────────────────────────────────────────────────────────────────

function recordPush(artist, album, tracks, sizeMB) {
  const key = `${artist || ''} — ${album || ''}`.replace(/\s*—\s*/g, ' — ');
  _state.stmts.insertPush.run({
    key,
    artist:    artist || '',
    album:     album  || '',
    tracks:    Number.isFinite(tracks) ? tracks : 0,
    size_mb:   Number.isFinite(sizeMB) ? sizeMB : 0,
    pushed_at: Date.now(),
  });
}

function getPushLog() {
  const rows = _state.stmts.selectPushLog.all();
  const albums = rows.map(r => ({
    key:      r.key,
    name:     r.album || r.artist || r.key,
    artist:   r.artist || '',
    album:    r.album  || '',
    tracks:   r.tracks || 0,
    sizeMB:   r.size_mb || 0,
    pushedAt: new Date(r.pushed_at).toISOString(),
  }));
  return { albums, albumCount: albums.length };
}

function clearPushLog() { _state.stmts.clearPushLog.run(); }

// Remove a single push-log entry by its canonical key.
// Returns true if a row was actually removed.
function removePushLogEntry(key) {
  if (!key) return false;
  const r = _state.stmts.deletePushByKey.run(key);
  return r.changes > 0;
}

// ── Quarantine ──────────────────────────────────────────────────────────────

function getQuarantine() {
  const rows = _state.stmts.selectQuarantine.all();
  return {
    items: rows.map(r => ({
      name:           r.name,
      path:           r.path,
      reason:         r.reason || '',
      type:           r.type   || 'inbox',
      quarantinedAt:  new Date(r.quarantined_at).toISOString(),
    })),
  };
}

function addQuarantine(item) {
  _state.stmts.insertQuarantine.run({
    name:           item.name || '',
    path:           item.path,
    reason:         item.reason || '',
    type:           item.type || 'inbox',
    quarantined_at: Date.now(),
  });
}

function removeQuarantineByName(name) {
  return _state.stmts.deleteQuarantineByName.run(name).changes;
}

function removeQuarantineByPath(p) {
  return _state.stmts.deleteQuarantineByPath.run(p).changes;
}

// Set of paths that are quarantined as 'sync' — used by sync.js to filter
// the backlog. Returns a Set for O(1) lookup.
const _stmtSyncQuar = () => _state.db.prepare("SELECT path FROM quarantine WHERE type = 'sync'");
function getSyncQuarantinedPaths() {
  const rows = _stmtSyncQuar().all();
  return new Set(rows.map(r => r.path));
}

// ── AI usage ─────────────────────────────────────────────────────────────────

function getAiUsage() {
  const r = _state.stmts.selectAiUsage.get();
  if (!r) {
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0, resetAt: new Date().toISOString() };
  }
  return {
    calls:        r.calls,
    inputTokens:  r.input_tokens,
    outputTokens: r.output_tokens,
    costUSD:      r.cost_usd,
    resetAt:      new Date(r.reset_at).toISOString(),
    updatedAt:    r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function recordAiUsage(inputTokens, outputTokens, priceInputPerM, priceOutputPerM) {
  const cur = _state.stmts.selectAiUsage.get();
  const now = Date.now();
  const inT = (cur ? cur.input_tokens  : 0) + (inputTokens  || 0);
  const ouT = (cur ? cur.output_tokens : 0) + (outputTokens || 0);
  const calls = (cur ? cur.calls : 0) + 1;
  const costUSD = parseFloat(((inT / 1_000_000) * priceInputPerM + (ouT / 1_000_000) * priceOutputPerM).toFixed(6));
  _state.stmts.upsertAiUsage.run({
    calls,
    input_tokens:  inT,
    output_tokens: ouT,
    cost_usd:      costUSD,
    reset_at:      cur ? cur.reset_at : now,
    updated_at:    now,
  });
  return getAiUsage();
}

function resetAiUsage() {
  _state.stmts.upsertAiUsage.run({
    calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0,
    reset_at: Date.now(), updated_at: Date.now(),
  });
  return getAiUsage();
}

// ── Device scan status ──────────────────────────────────────────────────────

function getDeviceScanStatus() {
  const r = _state.stmts.selectScanStatus.get();
  if (!r) return { status: 'none' };
  return {
    status:      r.status,
    startedAt:   r.started_at  ? new Date(r.started_at).toISOString() : null,
    scannedAt:   r.scanned_at  ? new Date(r.scanned_at).toISOString() : null,
    albumCount:  r.album_count || 0,
    connected:   !!r.connected,
    error:       r.error || null,
  };
}

// ── Favorites ───────────────────────────────────────────────────────────────

function listFavorites() {
  return _state.stmts.selectFavorites.all().map(r => ({
    albumKey:   r.album_key,
    starredAt:  new Date(r.starred_at).toISOString(),
  }));
}

function getFavoriteKeys() {
  return new Set(_state.stmts.selectFavoriteKeys.all().map(r => r.album_key));
}

function addFavorite(albumKey) {
  if (!albumKey) return false;
  return _state.stmts.insertFavorite.run(String(albumKey), Date.now()).changes > 0;
}

function removeFavorite(albumKey) {
  if (!albumKey) return 0;
  return _state.stmts.deleteFavorite.run(String(albumKey)).changes;
}

function isFavorite(albumKey) {
  if (!albumKey) return false;
  return !!_state.stmts.isFavorite.get(String(albumKey));
}

// ── Activity log ────────────────────────────────────────────────────────────

function logActivity(kind, action, subject, details) {
  if (!_state.stmts) return;        // not open yet (test edge case)
  try {
    _state.stmts.insertActivity.run({
      ts:           Date.now(),
      kind:         kind || 'system',
      action:       action || '',
      subject:      subject || null,
      details_json: details ? JSON.stringify(details) : null,
    });
  } catch (e) { console.warn('[activity]', e.message); }
}

function getActivity(limit = 50, offset = 0) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 500));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const rows = _state.stmts.selectActivity.all({ limit: lim, offset: off });
  return rows.map(r => ({
    id:      r.id,
    ts:      r.ts,
    tsIso:   new Date(r.ts).toISOString(),
    kind:    r.kind,
    action:  r.action,
    subject: r.subject || '',
    details: r.details_json ? safeJsonParse(r.details_json) : null,
  }));
}

function getActivityCount() {
  return _state.stmts.countActivity.get().n;
}

// Prune entries older than `cutoffMs` ms epoch. Returns the number deleted.
function pruneActivity(cutoffMs) {
  return _state.stmts.pruneActivity.run(cutoffMs).changes;
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ── Smart playlists ─────────────────────────────────────────────────────────

function _spRowToObj(row) {
  if (!row) return null;
  let def = {};
  try { def = JSON.parse(row.definition); } catch (_) {}
  return {
    id:         row.id,
    name:       row.name,
    definition: def,
    createdAt:  new Date(row.created_at).toISOString(),
    updatedAt:  new Date(row.updated_at).toISOString(),
  };
}

function listSmartPlaylists() {
  return _state.stmts.selectSmartPlaylists.all().map(_spRowToObj);
}

function getSmartPlaylist(id) {
  return _spRowToObj(_state.stmts.selectSmartPlaylistById.get(id));
}

function createSmartPlaylist(name, definition) {
  const now = Date.now();
  const info = _state.stmts.insertSmartPlaylist.run({
    name,
    definition: JSON.stringify(definition || {}),
    created_at: now,
    updated_at: now,
  });
  return getSmartPlaylist(info.lastInsertRowid);
}

function updateSmartPlaylist(id, name, definition) {
  const info = _state.stmts.updateSmartPlaylist.run({
    id,
    name,
    definition: JSON.stringify(definition || {}),
    updated_at: Date.now(),
  });
  if (info.changes === 0) return null;
  return getSmartPlaylist(id);
}

function deleteSmartPlaylist(id) {
  return _state.stmts.deleteSmartPlaylist.run(id).changes;
}

function setDeviceScanStatus(status) {
  _state.stmts.upsertScanStatus.run({
    status:      status.status      || 'none',
    started_at:  status.startedAt   ? new Date(status.startedAt).getTime() : null,
    scanned_at:  status.scannedAt   ? new Date(status.scannedAt).getTime() : Date.now(),
    album_count: status.albumCount  || 0,
    connected:   status.connected   ? 1 : 0,
    error:       status.error       || null,
  });
}

// ── Wheelhouse queue ────────────────────────────────────────────────────────

function _queueRowToObj(r) {
  if (!r) return null;
  return {
    id:        r.id,
    batchId:   r.batch_id || null,
    kind:      r.kind,
    action:    r.action,
    relPath:   r.rel_path,
    artist:    r.artist || '',
    album:     r.album  || '',
    status:    r.status,
    tracks:    r.tracks || 0,
    sizeMB:    r.size_mb || 0,
    error:     r.error || null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

// Add items to the queue. An identical item that is already queued or
// running is reused rather than duplicated. Returns { batchId, items }.
function enqueueDevice(items, opts = {}) {
  const tx = _state.db.transaction((list) => {
    const m = _state.stmts.maxQueueBatch.get();
    const batchId = opts.batchId || (Math.max(m.m, m.i) + 1);
    const out = [];
    for (const it of list) {
      const kind   = it.kind   || 'album';
      const action = it.action || 'download';
      const dup = _state.stmts.selectQueueOpenDup.get(kind, action, it.relPath);
      if (dup) { out.push({ ..._queueRowToObj(dup), reused: true }); continue; }
      const info = _state.stmts.insertQueue.run({
        batch_id: batchId,
        kind, action,
        rel_path: it.relPath,
        artist:   it.artist || '',
        album:    it.album  || '',
        tracks:   Number.isFinite(it.tracks) ? it.tracks : 0,
        size_mb:  Number.isFinite(it.sizeMB) ? it.sizeMB : 0,
        now:      Date.now(),
      });
      out.push(_queueRowToObj(_state.stmts.selectQueueById.get(Number(info.lastInsertRowid))));
    }
    return { batchId, items: out };
  });
  return tx(items);
}

function getOpenQueue() {
  return _state.stmts.selectQueueOpen.all().map(_queueRowToObj);
}

function getRecentQueue(limit = 50) {
  return _state.stmts.selectQueueRecent.all(limit).map(_queueRowToObj).reverse();
}

function getQueueItem(id) {
  return _queueRowToObj(_state.stmts.selectQueueById.get(id));
}

function setQueueStatus(id, status, error) {
  const info = _state.stmts.updateQueueStatus.run({ id, status, error: error || null, now: Date.now() });
  return info.changes > 0;
}

// Housekeeping: forget finished items older than `olderThanMs`, and put
// items stuck in 'running' (device went to sleep mid-download) back in line.
function tidyQueue(olderThanMs = 30 * 24 * 3600 * 1000, staleRunningMs = 6 * 3600 * 1000) {
  const now = Date.now();
  _state.stmts.pruneQueue.run(now - olderThanMs);
  _state.stmts.resetStaleRunning.run({ now, cutoff: now - staleRunningMs });
}

// ── Wheelhouse heartbeat ────────────────────────────────────────────────────

function recordHeartbeat(info = {}) {
  const num = v => (Number.isFinite(v) ? v : null);
  _state.stmts.upsertHeartbeat.run({
    last_seen:   Date.now(),
    device_name: info.deviceName ? String(info.deviceName).slice(0, 80) : null,
    app_version: info.appVersion ? String(info.appVersion).slice(0, 40) : null,
    free_mb:     num(info.freeMB),
    total_mb:    num(info.totalMB),
    ip:          info.ip ? String(info.ip).slice(0, 64) : null,
  });
}

function getHeartbeat() {
  const r = _state.stmts.selectHeartbeat.get();
  if (!r) return null;
  return {
    lastSeen:   r.last_seen ? new Date(r.last_seen).toISOString() : null,
    lastSeenMs: r.last_seen || 0,
    deviceName: r.device_name || null,
    appVersion: r.app_version || null,
    freeMB:     r.free_mb,
    totalMB:    r.total_mb,
    ip:         r.ip || null,
    scanWanted: !!r.scan_wanted,
  };
}

function setScanWanted(wanted) {
  _state.stmts.setScanWanted.run({ wanted: wanted ? 1 : 0 });
}

module.exports = {
  open, close, getDb,
  CURRENT_SCHEMA_VERSION,
  // Albums
  setAlbums, getAlbums, getAlbumCount, getAlbumByKey,
  // Push log
  recordPush, getPushLog, clearPushLog, removePushLogEntry,
  // Quarantine
  getQuarantine, addQuarantine, removeQuarantineByName, removeQuarantineByPath, getSyncQuarantinedPaths,
  // AI usage
  getAiUsage, recordAiUsage, resetAiUsage,
  // Device scan
  getDeviceScanStatus, setDeviceScanStatus,
  // Smart playlists
  listSmartPlaylists, getSmartPlaylist, createSmartPlaylist, updateSmartPlaylist, deleteSmartPlaylist,
  // Activity log
  logActivity, getActivity, getActivityCount, pruneActivity,
  // Favorites
  listFavorites, getFavoriteKeys, addFavorite, removeFavorite, isFavorite,
  // Wheelhouse
  enqueueDevice, getOpenQueue, getRecentQueue, getQueueItem, setQueueStatus, tidyQueue,
  recordHeartbeat, getHeartbeat, setScanWanted,
};
