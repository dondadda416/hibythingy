import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { mapLimit, isAudioFile, readDirEntries, statOrNull } from '../lib/walk.js';

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-walk-')); });
afterEach(()  => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

describe('walk.mapLimit', () => {
  it('returns an empty array for empty input', async () => {
    expect(await mapLimit([], 4, x => x)).toEqual([]);
    expect(await mapLimit(null, 4, x => x)).toEqual([]);
  });

  it('preserves input order in the output', async () => {
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => {
      // Random sleep so workers finish out of order.
      await new Promise(r => setTimeout(r, Math.random() * 5));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
  });

  it('caps in-flight work at `limit`', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 2));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('passes the index as the second argument', async () => {
    const out = await mapLimit(['a', 'b', 'c'], 2, (item, idx) => `${idx}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });
});

describe('walk.isAudioFile', () => {
  it('matches common audio extensions case-insensitively', () => {
    for (const f of ['song.flac', 'SONG.FLAC', 'a/b/c.mp3', 'cover.WAV', 'x.opus', 'y.dsf']) {
      expect(isAudioFile(f)).toBe(true);
    }
  });
  it('rejects non-audio files', () => {
    for (const f of ['cover.jpg', 'notes.txt', 'README', 'song.flac.bak']) {
      expect(isAudioFile(f)).toBe(false);
    }
  });
});

describe('walk.readDirEntries', () => {
  it('returns Dirent[] with isFile()/isDirectory() for a real folder', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.flac'), '');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    const entries = await readDirEntries(tmpDir);
    expect(entries).toHaveLength(2);
    const a = entries.find(e => e.name === 'a.flac');
    const s = entries.find(e => e.name === 'sub');
    expect(a.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(true);
  });

  it('returns null for a missing directory (no throw)', async () => {
    expect(await readDirEntries(path.join(tmpDir, 'nope'))).toBeNull();
  });
});

describe('walk.statOrNull', () => {
  it('returns a Stats object for a real file', async () => {
    const p = path.join(tmpDir, 'x.txt');
    fs.writeFileSync(p, 'hi');
    const st = await statOrNull(p);
    expect(st).toBeTruthy();
    expect(st.size).toBe(2);
  });
  it('returns null for a missing file', async () => {
    expect(await statOrNull(path.join(tmpDir, 'nope'))).toBeNull();
  });
});
