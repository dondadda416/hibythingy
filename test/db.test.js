import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-db-'));
  db.open(tmpDir);
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('db.open', () => {
  it('creates hub.db in the cache dir', () => {
    expect(fs.existsSync(path.join(tmpDir, 'hub.db'))).toBe(true);
  });

  it('is idempotent', () => {
    const a = db.getDb();
    db.open(tmpDir);
    expect(db.getDb()).toBe(a);
  });
});

describe('db albums round-trip', () => {
  it('returns empty list before any writes', () => {
    expect(db.getAlbums('library')).toEqual([]);
    expect(db.getAlbumCount('library')).toEqual({ albumCount: 0, trackCount: 0 });
  });

  it('persists and reads back library albums', () => {
    db.setAlbums('library', [
      { key: 'A1', name: 'A1', artist: 'X', album: 'A1', tracks: 10, sizeMB: 50, path: '/x/A1', addedAt: 1000 },
      { key: 'A2', name: 'A2', artist: 'Y', album: 'A2', tracks: 8,  sizeMB: 40, path: '/x/A2', addedAt: 2000 },
    ]);
    const back = db.getAlbums('library');
    expect(back).toHaveLength(2);
    expect(back.map(a => a.key).sort()).toEqual(['A1', 'A2']);
    const counts = db.getAlbumCount('library');
    expect(counts.albumCount).toBe(2);
    expect(counts.trackCount).toBe(18);
  });

  it('isolates library and device-mtp sources', () => {
    db.setAlbums('library', [{ key: 'L1', name: 'L1', tracks: 5 }]);
    db.setAlbums('device-mtp', [{ key: 'D1', name: 'D1', tracks: 3 }]);
    expect(db.getAlbums('library')).toHaveLength(1);
    expect(db.getAlbums('device-mtp')).toHaveLength(1);
    expect(db.getAlbums('library')[0].key).toBe('L1');
    expect(db.getAlbums('device-mtp')[0].key).toBe('D1');
  });

  it('setAlbums replaces the entire source set atomically', () => {
    db.setAlbums('library', [{ key: 'old', name: 'old', tracks: 1 }]);
    db.setAlbums('library', [{ key: 'new', name: 'new', tracks: 2 }]);
    const back = db.getAlbums('library');
    expect(back).toHaveLength(1);
    expect(back[0].key).toBe('new');
  });

  it('preserves unknown fields via extra_json round-trip', () => {
    db.setAlbums('library', [{
      key: 'A', name: 'A', tracks: 5,
      customField: 'preserved', nested: { foo: 1 },
    }]);
    const back = db.getAlbums('library')[0];
    expect(back.customField).toBe('preserved');
    expect(back.nested).toEqual({ foo: 1 });
  });
});

describe('db push log', () => {
  it('records and reads back', () => {
    db.recordPush('Pink Floyd', 'The Wall', 26, 420.5);
    const log = db.getPushLog();
    expect(log.albumCount).toBe(1);
    expect(log.albums[0].artist).toBe('Pink Floyd');
    expect(log.albums[0].tracks).toBe(26);
  });

  it('UPSERTs on the same artist+album key', () => {
    db.recordPush('A', 'B', 10, 100);
    db.recordPush('A', 'B', 12, 110);
    const log = db.getPushLog();
    expect(log.albumCount).toBe(1);
    expect(log.albums[0].tracks).toBe(12);
  });

  it('clearPushLog wipes everything', () => {
    db.recordPush('A', 'B', 10, 100);
    db.clearPushLog();
    expect(db.getPushLog().albumCount).toBe(0);
  });
});

describe('db quarantine', () => {
  it('add + list + remove by name', () => {
    db.addQuarantine({ name: 'X', path: '/p/X', reason: 'bad', type: 'inbox' });
    db.addQuarantine({ name: 'Y', path: '/p/Y', reason: 'sync skip', type: 'sync' });
    expect(db.getQuarantine().items).toHaveLength(2);
    db.removeQuarantineByName('X');
    expect(db.getQuarantine().items).toHaveLength(1);
    expect(db.getQuarantine().items[0].name).toBe('Y');
  });

  it('UPSERTs on path conflict', () => {
    db.addQuarantine({ name: 'X', path: '/p/X', reason: 'first' });
    db.addQuarantine({ name: 'X', path: '/p/X', reason: 'second' });
    expect(db.getQuarantine().items).toHaveLength(1);
    expect(db.getQuarantine().items[0].reason).toBe('second');
  });

  it('getSyncQuarantinedPaths returns only type=sync items', () => {
    db.addQuarantine({ name: 'I', path: '/p/I', type: 'inbox' });
    db.addQuarantine({ name: 'S', path: '/p/S', type: 'sync' });
    const sync = db.getSyncQuarantinedPaths();
    expect(sync.has('/p/S')).toBe(true);
    expect(sync.has('/p/I')).toBe(false);
  });
});

describe('db AI usage', () => {
  it('returns zero state initially', () => {
    const u = db.getAiUsage();
    expect(u.calls).toBe(0);
    expect(u.costUSD).toBe(0);
  });

  it('recordAiUsage accumulates and computes cost', () => {
    const u1 = db.recordAiUsage(1000, 500, 0.80, 4.00);
    expect(u1.calls).toBe(1);
    expect(u1.inputTokens).toBe(1000);
    expect(u1.outputTokens).toBe(500);
    expect(u1.costUSD).toBeGreaterThan(0);
    const u2 = db.recordAiUsage(2000, 1000, 0.80, 4.00);
    expect(u2.calls).toBe(2);
    expect(u2.inputTokens).toBe(3000);
    expect(u2.outputTokens).toBe(1500);
  });

  it('resetAiUsage zeros the counters', () => {
    db.recordAiUsage(500, 250, 0.80, 4.00);
    const u = db.resetAiUsage();
    expect(u.calls).toBe(0);
    expect(u.inputTokens).toBe(0);
    expect(u.costUSD).toBe(0);
  });
});

describe('db device scan status', () => {
  it('returns none when never set', () => {
    expect(db.getDeviceScanStatus().status).toBe('none');
  });

  it('round-trips a status row', () => {
    db.setDeviceScanStatus({
      status: 'done', scannedAt: '2026-01-01T00:00:00.000Z',
      albumCount: 42, connected: true,
    });
    const r = db.getDeviceScanStatus();
    expect(r.status).toBe('done');
    expect(r.albumCount).toBe(42);
    expect(r.connected).toBe(true);
  });
});
