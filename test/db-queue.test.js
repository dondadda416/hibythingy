import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import db   from '../lib/db.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-queue-'));
  db.open(tmpDir);
});
afterEach(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

const album = (rel, extra = {}) => ({ kind: 'album', action: 'download', relPath: rel, artist: 'A', album: rel, tracks: 10, sizeMB: 300, ...extra });

describe('device queue', () => {
  it('enqueues items under one batch id', () => {
    const { batchId, items } = db.enqueueDevice([album('A/One'), album('A/Two')]);
    expect(items).toHaveLength(2);
    expect(items.every(i => i.batchId === batchId && i.status === 'queued')).toBe(true);
    expect(db.getOpenQueue().map(i => i.relPath)).toEqual(['A/One', 'A/Two']);
  });

  it('reuses an identical open item instead of duplicating it', () => {
    db.enqueueDevice([album('A/One')]);
    const second = db.enqueueDevice([album('A/One')]);
    expect(second.items[0].reused).toBe(true);
    expect(db.getOpenQueue()).toHaveLength(1);
  });

  it('allows re-queueing once the previous item finished', () => {
    const { items } = db.enqueueDevice([album('A/One')]);
    db.setQueueStatus(items[0].id, 'done');
    db.enqueueDevice([album('A/One')]);
    expect(db.getOpenQueue()).toHaveLength(1);
    expect(db.getRecentQueue(10)).toHaveLength(2);
  });

  it('treats download and delete of the same path as different work', () => {
    db.enqueueDevice([album('Playlists/x.m3u8', { kind: 'playlist' })]);
    db.enqueueDevice([album('Playlists/x.m3u8', { kind: 'playlist', action: 'delete' })]);
    expect(db.getOpenQueue()).toHaveLength(2);
  });

  it('updates status and error', () => {
    const { items } = db.enqueueDevice([album('A/One')]);
    expect(db.setQueueStatus(items[0].id, 'error', 'Card full')).toBe(true);
    const row = db.getQueueItem(items[0].id);
    expect(row.status).toBe('error');
    expect(row.error).toBe('Card full');
    expect(db.getOpenQueue()).toHaveLength(0);
  });

  it('puts long-stuck running items back in line', () => {
    const { items } = db.enqueueDevice([album('A/One')]);
    db.setQueueStatus(items[0].id, 'running');
    db.getDb().prepare('UPDATE device_queue SET updated_at = ? WHERE id = ?').run(Date.now() - 7 * 3600 * 1000, items[0].id);
    db.tidyQueue();
    expect(db.getQueueItem(items[0].id).status).toBe('queued');
  });
});

describe('wheelhouse heartbeat', () => {
  it('records and reads back a check-in', () => {
    expect(db.getHeartbeat()).toBeNull();
    db.recordHeartbeat({ deviceName: 'R4', appVersion: '1.2', freeMB: 1000, totalMB: 2000, ip: '1.2.3.4' });
    const hb = db.getHeartbeat();
    expect(hb.deviceName).toBe('R4');
    expect(hb.freeMB).toBe(1000);
    expect(Date.now() - hb.lastSeenMs).toBeLessThan(5000);
  });

  it('keeps known fields when a later check-in omits them', () => {
    db.recordHeartbeat({ deviceName: 'R4', freeMB: 1000 });
    db.recordHeartbeat({});
    expect(db.getHeartbeat().deviceName).toBe('R4');
    expect(db.getHeartbeat().freeMB).toBe(1000);
  });

  it('tracks a pending scan request', () => {
    db.setScanWanted(true);
    expect(db.getHeartbeat().scanWanted).toBe(true);
    db.setScanWanted(false);
    expect(db.getHeartbeat().scanWanted).toBe(false);
  });
});
