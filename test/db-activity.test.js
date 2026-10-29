import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-act-'));
  db.open(tmpDir);
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('db.logActivity / getActivity', () => {
  it('starts empty', () => {
    expect(db.getActivity()).toEqual([]);
    expect(db.getActivityCount()).toBe(0);
  });

  it('records and returns entries newest first', async () => {
    db.logActivity('tag', 'tag-applied', 'Album A', { tracks: 10 });
    // Force a measurable timestamp gap.
    await new Promise(r => setTimeout(r, 5));
    db.logActivity('push', 'pushed', 'Album B', { tracks: 12, sizeMB: 100 });
    const items = db.getActivity();
    expect(items).toHaveLength(2);
    expect(items[0].subject).toBe('Album B');
    expect(items[1].subject).toBe('Album A');
    expect(db.getActivityCount()).toBe(2);
  });

  it('round-trips JSON details', () => {
    db.logActivity('tag', 'tag-applied', 'X', { genre: 'rock', year: '2024' });
    const items = db.getActivity();
    expect(items[0].details.genre).toBe('rock');
    expect(items[0].details.year).toBe('2024');
  });

  it('handles null details', () => {
    db.logActivity('system', 'push-log-cleared', null, null);
    const items = db.getActivity();
    expect(items[0].details).toBeNull();
    expect(items[0].subject).toBe('');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) db.logActivity('tag', 'tag-applied', `Album ${i}`, null);
    const first = db.getActivity(2, 0);
    const second = db.getActivity(2, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0].subject).not.toBe(second[0].subject);
  });

  it('caps limit at 500', () => {
    db.logActivity('tag', 'tag-applied', 'A', null);
    expect(() => db.getActivity(99999, 0)).not.toThrow();
  });
});

describe('db.pruneActivity', () => {
  it('deletes entries older than the cutoff', () => {
    db.logActivity('tag', 'tag-applied', 'Old', null);
    const cutoff = Date.now() + 1000;       // 1 second in the future
    expect(db.pruneActivity(cutoff)).toBe(1);
    expect(db.getActivityCount()).toBe(0);
  });

  it('keeps entries newer than the cutoff', () => {
    db.logActivity('tag', 'tag-applied', 'Recent', null);
    const cutoff = Date.now() - 1000;       // 1 second in the past
    expect(db.pruneActivity(cutoff)).toBe(0);
    expect(db.getActivityCount()).toBe(1);
  });
});
