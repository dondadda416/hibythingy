import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { atomicWriteJsonSync, atomicWriteJson } from '../lib/atomicWriteJson.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-atomic-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('atomicWriteJsonSync', () => {
  it('writes valid JSON to the target path', () => {
    const target = path.join(tmpDir, 'data.json');
    const data   = { a: 1, b: [2, 3], c: 'hello' };
    atomicWriteJsonSync(target, data);
    const round = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(round).toEqual(data);
  });

  it('overwrites an existing file', () => {
    const target = path.join(tmpDir, 'data.json');
    fs.writeFileSync(target, '"old"');
    atomicWriteJsonSync(target, { fresh: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ fresh: true });
  });

  it('does not leave .tmp files behind on success', () => {
    const target = path.join(tmpDir, 'data.json');
    atomicWriteJsonSync(target, { ok: 1 });
    const leftover = fs.readdirSync(tmpDir).filter(n => n.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('uses 2-space indentation by default', () => {
    const target = path.join(tmpDir, 'data.json');
    atomicWriteJsonSync(target, { a: 1 });
    const text = fs.readFileSync(target, 'utf8');
    expect(text).toContain('\n  "a"');
  });

  it('throws on a write failure (directory does not exist)', () => {
    const target = path.join(tmpDir, 'no-such-dir', 'data.json');
    expect(() => atomicWriteJsonSync(target, { a: 1 })).toThrow();
  });
});

describe('atomicWriteJson (async)', () => {
  it('writes valid JSON', async () => {
    const target = path.join(tmpDir, 'data.json');
    await atomicWriteJson(target, { a: 1 });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1 });
  });

  it('handles concurrent writers without corrupting the target', async () => {
    const target = path.join(tmpDir, 'data.json');
    const writes = Array.from({ length: 20 }, (_, i) => atomicWriteJson(target, { i }));
    await Promise.all(writes);
    // The final result should be valid JSON — exactly one of the writers wins.
    const final = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(typeof final.i).toBe('number');
    expect(final.i).toBeGreaterThanOrEqual(0);
    expect(final.i).toBeLessThan(20);
  });
});
