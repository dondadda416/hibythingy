import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-fav-'));
  db.open(tmpDir);
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('db favorites', () => {
  it('starts empty', () => {
    expect(db.listFavorites()).toEqual([]);
    expect(db.getFavoriteKeys()).toEqual(new Set());
    expect(db.isFavorite('anything')).toBe(false);
  });

  it('addFavorite + isFavorite round-trip', () => {
    expect(db.addFavorite('Pink Floyd — The Wall')).toBe(true);
    expect(db.isFavorite('Pink Floyd — The Wall')).toBe(true);
    expect(db.getFavoriteKeys().has('Pink Floyd — The Wall')).toBe(true);
  });

  it('addFavorite is idempotent', () => {
    db.addFavorite('A');
    expect(db.addFavorite('A')).toBe(false); // INSERT OR IGNORE — no rows changed
    expect(db.listFavorites()).toHaveLength(1);
  });

  it('removeFavorite removes the row', () => {
    db.addFavorite('A');
    expect(db.removeFavorite('A')).toBe(1);
    expect(db.isFavorite('A')).toBe(false);
  });

  it('removeFavorite on a missing key returns 0', () => {
    expect(db.removeFavorite('nope')).toBe(0);
  });

  it('rejects empty / null keys', () => {
    expect(db.addFavorite('')).toBe(false);
    expect(db.addFavorite(null)).toBe(false);
    expect(db.removeFavorite('')).toBe(0);
  });

  it('survives a library bulk-replace (decoupled tables)', () => {
    db.addFavorite('Pink Floyd — The Wall');
    db.setAlbums('library', [
      { key: 'Pink Floyd — The Wall', name: 'The Wall', tracks: 26 },
      { key: 'Other Album', name: 'Other', tracks: 10 },
    ]);
    // Replace the entire library — favorites table is untouched.
    db.setAlbums('library', [{ key: 'New Album', name: 'New', tracks: 5 }]);
    expect(db.isFavorite('Pink Floyd — The Wall')).toBe(true);
  });

  it('listFavorites orders by most recent first', async () => {
    db.addFavorite('A');
    await new Promise(r => setTimeout(r, 5));
    db.addFavorite('B');
    const list = db.listFavorites();
    expect(list[0].albumKey).toBe('B');
    expect(list[1].albumKey).toBe('A');
  });
});
