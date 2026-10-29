import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { readEnv, getValue, applyUpdates, serialise, atomicWriteEnvSync } from '../lib/envFile.js';

let tmpDir, envPath;
beforeEach(() => {
  tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-env-'));
  envPath = path.join(tmpDir, '.env');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('readEnv', () => {
  it('returns empty array when file is missing', () => {
    expect(readEnv(envPath)).toEqual([]);
  });

  it('parses comments, blanks and KV lines', () => {
    fs.writeFileSync(envPath, '# header comment\n\nFOO=bar\nBAZ="hello world"\n');
    const lines = readEnv(envPath);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const kv = lines.filter(l => l.kind === 'kv');
    expect(kv).toHaveLength(2);
    expect(kv[0].key).toBe('FOO');
    expect(kv[1].key).toBe('BAZ');
  });
});

describe('getValue', () => {
  it('returns the stored value, unquoted', () => {
    fs.writeFileSync(envPath, 'FOO=bar\nBAZ="quoted"\n');
    const lines = readEnv(envPath);
    expect(getValue(lines, 'FOO')).toBe('bar');
    expect(getValue(lines, 'BAZ')).toBe('quoted');
    expect(getValue(lines, 'NOPE')).toBe('');
  });
});

describe('applyUpdates', () => {
  it('updates an existing key in place', () => {
    fs.writeFileSync(envPath, '# c1\nFOO=old\nBAR=keep\n');
    const lines = applyUpdates(readEnv(envPath), { FOO: 'new' });
    const ser = serialise(lines);
    expect(ser).toContain('FOO=new');
    expect(ser).toContain('BAR=keep');
    expect(ser).toContain('# c1');
  });

  it('appends a new key at the end', () => {
    fs.writeFileSync(envPath, 'FOO=bar\n');
    const lines = applyUpdates(readEnv(envPath), { NEW_KEY: 'value' });
    const ser = serialise(lines);
    expect(ser).toMatch(/NEW_KEY=value/);
  });

  it('preserves blank-line/comment ordering', () => {
    fs.writeFileSync(envPath, '# top\n\nFOO=1\n\n# end\n');
    const lines = applyUpdates(readEnv(envPath), { FOO: '2' });
    const ser = serialise(lines);
    expect(ser).toMatch(/^# top\n\nFOO=2\n\n# end\n?$/);
  });

  it('quotes values that contain spaces', () => {
    const lines = applyUpdates(readEnv(envPath), { MSG: 'hello world' });
    expect(serialise(lines)).toMatch(/MSG="hello world"/);
  });

  it('clears a key when value is empty string', () => {
    fs.writeFileSync(envPath, 'FOO=bar\n');
    const lines = applyUpdates(readEnv(envPath), { FOO: '' });
    expect(serialise(lines)).toMatch(/^FOO=\n/);
  });
});

describe('atomicWriteEnvSync', () => {
  it('writes the file at the target path', () => {
    const lines = applyUpdates([], { FOO: 'bar' });
    atomicWriteEnvSync(envPath, lines);
    expect(fs.readFileSync(envPath, 'utf8')).toContain('FOO=bar');
  });

  it('round-trips a real-looking .env', () => {
    const original = [
      '# HiBy Hub environment',
      '',
      'ANTHROPIC_API_KEY=sk-ant-test-1234',
      'LASTFM_API_KEY=abc123',
      'LASTFM_USERNAME=tester',
      '',
      '# Optional',
      '# DAILY_AI_BUDGET_USD=5',
    ].join('\n') + '\n';
    fs.writeFileSync(envPath, original);

    const updated = applyUpdates(readEnv(envPath), { LASTFM_USERNAME: 'newname' });
    atomicWriteEnvSync(envPath, updated);
    const reloaded = fs.readFileSync(envPath, 'utf8');
    expect(reloaded).toContain('# HiBy Hub environment');
    expect(reloaded).toContain('LASTFM_USERNAME=newname');
    expect(reloaded).toContain('# Optional');
    expect(reloaded).toContain('# DAILY_AI_BUDGET_USD=5');   // commented-out line preserved
  });
});
