import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveUnder, resolveUnderOrJoin, isInsideRoot } from '../lib/safePath.js';

const isWindows = process.platform === 'win32';
const ROOT = isWindows ? 'C:\\Music' : '/music';
const OTHER = isWindows ? 'D:\\Pictures' : '/pictures';

describe('safePath.resolveUnder', () => {
  it('accepts a path inside the root', () => {
    const r = resolveUnder(path.join(ROOT, 'Album'), [ROOT]);
    expect(r).toBeTruthy();
    expect(r.toLowerCase()).toContain('album');
  });

  it('accepts the root itself', () => {
    const r = resolveUnder(ROOT, [ROOT]);
    expect(r).toBeTruthy();
  });

  it('rejects a path outside every root', () => {
    expect(resolveUnder(OTHER, [ROOT])).toBeNull();
  });

  it('rejects path traversal that escapes the root', () => {
    const evil = path.join(ROOT, '..', '..', 'etc', 'passwd');
    expect(resolveUnder(evil, [ROOT])).toBeNull();
  });

  it('accepts traversal that resolves back inside the root', () => {
    const innocent = path.join(ROOT, 'A', '..', 'B');
    const r = resolveUnder(innocent, [ROOT]);
    expect(r).toBeTruthy();
    expect(r.toLowerCase()).toContain(path.sep + 'b');
  });

  it('rejects empty / non-string input', () => {
    expect(resolveUnder('', [ROOT])).toBeNull();
    expect(resolveUnder(null, [ROOT])).toBeNull();
    expect(resolveUnder(undefined, [ROOT])).toBeNull();
    expect(resolveUnder(42, [ROOT])).toBeNull();
  });

  it('rejects null bytes', () => {
    expect(resolveUnder(path.join(ROOT, 'A\0B'), [ROOT])).toBeNull();
  });

  it('rejects when no roots are supplied', () => {
    expect(resolveUnder(path.join(ROOT, 'Album'), [])).toBeNull();
    expect(resolveUnder(path.join(ROOT, 'Album'), null)).toBeNull();
  });

  it('matches if any root contains the path', () => {
    const ok = resolveUnder(path.join(OTHER, 'X'), [ROOT, OTHER]);
    expect(ok).toBeTruthy();
  });

  if (isWindows) {
    it('Windows: drive-letter case-insensitive', () => {
      const lower = resolveUnder('c:\\Music\\Album', [ROOT]);
      expect(lower).toBeTruthy();
    });

    it('Windows: rejects sibling that shares a prefix', () => {
      // C:\MusicArchive starts with "C:\Music" but is NOT inside C:\Music.
      const sibling = 'C:\\MusicArchive\\Album';
      expect(resolveUnder(sibling, [ROOT])).toBeNull();
    });
  } else {
    it('POSIX: rejects sibling that shares a prefix', () => {
      const sibling = '/music_archive/Album';
      expect(resolveUnder(sibling, [ROOT])).toBeNull();
    });
  }
});

describe('safePath.resolveUnderOrJoin', () => {
  it('uses inputPath if it resolves under a root', () => {
    const r = resolveUnderOrJoin(path.join(ROOT, 'Album'), 'fallback', [ROOT]);
    expect(r.toLowerCase()).toContain('album');
  });

  it('falls back to root + name when input is missing', () => {
    const r = resolveUnderOrJoin(null, 'Fallback', [ROOT]);
    expect(r).toBeTruthy();
    expect(r.toLowerCase()).toContain('fallback');
  });

  it('falls back when input is unsafe', () => {
    const r = resolveUnderOrJoin(OTHER, 'Fallback', [ROOT]);
    expect(r).toBeTruthy();
    expect(r.toLowerCase()).toContain('fallback');
  });

  it('returns null with no fallback name and unsafe input', () => {
    expect(resolveUnderOrJoin(OTHER, '', [ROOT])).toBeNull();
  });
});

describe('safePath.isInsideRoot', () => {
  it('true for nested path', () => {
    expect(isInsideRoot(path.join(ROOT, 'A'), ROOT)).toBe(true);
  });
  it('true for the root itself', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true);
  });
  it('false for an outside path', () => {
    expect(isInsideRoot(OTHER, ROOT)).toBe(false);
  });
});
