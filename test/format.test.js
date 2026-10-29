import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { getBestFormat, getRank, FORMAT_RANK, AUDIO_EXTS } from '../lib/format.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-format-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

function writeFiles(names) {
  for (const n of names) fs.writeFileSync(path.join(tmpDir, n), 'x');
}

describe('lib/format AUDIO_EXTS', () => {
  it('contains the lossless and lossy formats we care about', () => {
    for (const ext of ['.flac', '.mp3', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.ape', '.dsf', '.dff']) {
      expect(AUDIO_EXTS.has(ext)).toBe(true);
    }
  });
  it('does not match arbitrary file extensions', () => {
    expect(AUDIO_EXTS.has('.txt')).toBe(false);
    expect(AUDIO_EXTS.has('.jpg')).toBe(false);
    expect(AUDIO_EXTS.has('.nfo')).toBe(false);
  });
});

describe('lib/format getRank', () => {
  it('ranks DSD highest, MP3 lowest among the common set', () => {
    expect(getRank('dsf')).toBeGreaterThan(getRank('flac'));
    expect(getRank('flac')).toBeGreaterThan(getRank('opus'));
    expect(getRank('opus')).toBeGreaterThan(getRank('mp3'));
  });
  it('returns -1 for unknown formats', () => {
    expect(getRank('foo')).toBe(-1);
    expect(getRank('')).toBe(-1);
    expect(getRank(null)).toBe(-1);
  });
  it('is case-insensitive', () => {
    expect(getRank('FLAC')).toBe(FORMAT_RANK.flac);
    expect(getRank('Flac')).toBe(FORMAT_RANK.flac);
  });
});

describe('lib/format getBestFormat', () => {
  it('returns null for an empty folder', () => {
    expect(getBestFormat(tmpDir)).toBeNull();
  });

  it('returns null for a non-existent folder', () => {
    expect(getBestFormat(path.join(tmpDir, 'no-such'))).toBeNull();
  });

  it('picks FLAC over MP3 in a mixed folder', () => {
    writeFiles(['01.flac', '02.flac', '03.mp3']);
    const r = getBestFormat(tmpDir);
    expect(r.format).toBe('FLAC');
    expect(r.count).toBe(2);
  });

  it('picks DSF when it is present alongside FLAC', () => {
    writeFiles(['01.dsf', '02.flac']);
    expect(getBestFormat(tmpDir).format).toBe('DSF');
  });

  it('ignores non-audio files', () => {
    writeFiles(['cover.jpg', 'notes.txt', '01.mp3']);
    const r = getBestFormat(tmpDir);
    expect(r.format).toBe('MP3');
    expect(r.count).toBe(1);
  });
});
