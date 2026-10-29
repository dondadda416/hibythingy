import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-sp-'));
  db.open(tmpDir);
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('db smart playlists', () => {
  it('returns empty list initially', () => {
    expect(db.listSmartPlaylists()).toEqual([]);
  });

  it('creates and reads back', () => {
    const sp = db.createSmartPlaylist('Recent FLAC', { format: ['FLAC'], addedAfterDays: 30 });
    expect(sp.id).toBeGreaterThan(0);
    expect(sp.name).toBe('Recent FLAC');
    expect(sp.definition.format).toEqual(['FLAC']);

    const list = db.listSmartPlaylists();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Recent FLAC');
  });

  it('rejects duplicate names', () => {
    db.createSmartPlaylist('A', {});
    expect(() => db.createSmartPlaylist('A', {})).toThrow(/UNIQUE/);
  });

  it('updates name and definition', () => {
    const sp = db.createSmartPlaylist('A', { format: ['FLAC'] });
    const updated = db.updateSmartPlaylist(sp.id, 'B', { format: ['MP3'] });
    expect(updated.name).toBe('B');
    expect(updated.definition.format).toEqual(['MP3']);
  });

  it('returns null when updating a missing id', () => {
    expect(db.updateSmartPlaylist(99999, 'X', {})).toBeNull();
  });

  it('deletes', () => {
    const sp = db.createSmartPlaylist('A', {});
    expect(db.deleteSmartPlaylist(sp.id)).toBe(1);
    expect(db.listSmartPlaylists()).toHaveLength(0);
  });
});
