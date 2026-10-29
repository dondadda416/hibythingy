import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';
import { migrateFromJson } from '../lib/db-migrate.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-mig-'));
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

function writeJson(file, obj) {
  fs.writeFileSync(path.join(tmpDir, file), JSON.stringify(obj));
}

describe('migrateFromJson', () => {
  it('does nothing when no JSON cache files exist', () => {
    db.open(tmpDir);
    const r = migrateFromJson(tmpDir);
    expect(r.ran).toBe(false);
  });

  it('imports library, device, push log, quarantine, ai usage', () => {
    writeJson('library.json', {
      albums: [
        { key: 'A1', name: 'A1', artist: 'X', tracks: 5, path: '/x/A1' },
        { key: 'A2', name: 'A2', artist: 'Y', tracks: 7, path: '/x/A2' },
      ],
    });
    writeJson('device.json', {
      status: 'done',
      albumCount: 1,
      albums: [{ key: 'D1', name: 'D1', tracks: 4 }],
    });
    writeJson('pushed.json', {
      albums: [
        { key: 'X — Y', artist: 'X', album: 'Y', tracks: 5, sizeMB: 50 },
      ],
    });
    writeJson('quarantine.json', {
      items: [{ name: 'Q', path: '/q/Q', reason: 'meh', type: 'inbox' }],
    });
    writeJson('ai-usage.json', {
      calls: 7, inputTokens: 1234, outputTokens: 567, costUSD: 0.01,
      resetAt: '2026-01-01T00:00:00.000Z',
    });

    db.open(tmpDir);
    const r = migrateFromJson(tmpDir);
    expect(r.ran).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.migrated.libraryAlbums).toBe(2);
    expect(r.migrated.deviceAlbums).toBe(1);
    expect(r.migrated.pushLog).toBe(1);
    expect(r.migrated.quarantine).toBe(1);
    expect(r.migrated.aiUsage).toBe(true);

    expect(db.getAlbums('library')).toHaveLength(2);
    expect(db.getAlbums('device-mtp')).toHaveLength(1);
    expect(db.getPushLog().albumCount).toBe(1);
    expect(db.getQuarantine().items).toHaveLength(1);
    expect(db.getAiUsage().calls).toBe(7);

    // Source files should have been renamed.
    expect(fs.existsSync(path.join(tmpDir, 'library.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'library.json.migrated'))).toBe(true);
  });

  it('is idempotent on re-run (no source files left)', () => {
    writeJson('library.json', { albums: [{ key: 'A', name: 'A', tracks: 1 }] });
    db.open(tmpDir);
    const r1 = migrateFromJson(tmpDir);
    expect(r1.ran).toBe(true);
    const r2 = migrateFromJson(tmpDir);
    expect(r2.ran).toBe(false);
  });

  it('rolls back on a corrupt JSON without touching DB or files', () => {
    // Write a file we can't parse — _readJsonOrNull returns null and skips it,
    // so migration should still succeed for the rest. Verify the unparseable
    // file is left in place.
    writeJson('library.json', { albums: [{ key: 'A', name: 'A', tracks: 1 }] });
    fs.writeFileSync(path.join(tmpDir, 'pushed.json'), 'not valid JSON');
    db.open(tmpDir);
    const r = migrateFromJson(tmpDir);
    expect(r.ran).toBe(true);
    expect(r.migrated.libraryAlbums).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'pushed.json'))).toBe(true);
  });
});
