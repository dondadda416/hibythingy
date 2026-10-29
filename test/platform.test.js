import { describe, it, expect, vi } from 'vitest';
import { isWindows, isMacOS, isLinux, platformLabel, requireWindows } from '../lib/platform.js';

describe('platform detection', () => {
  it('exactly one of isWindows/isMacOS/isLinux is true on a known platform', () => {
    const p = process.platform;
    if (p === 'win32')  expect([isWindows, isMacOS, isLinux]).toEqual([true, false, false]);
    if (p === 'darwin') expect([isWindows, isMacOS, isLinux]).toEqual([false, true, false]);
    if (p === 'linux')  expect([isWindows, isMacOS, isLinux]).toEqual([false, false, true]);
  });

  it('platformLabel returns a non-empty string', () => {
    expect(typeof platformLabel()).toBe('string');
    expect(platformLabel().length).toBeGreaterThan(0);
  });
});

describe('platform.requireWindows middleware', () => {
  function fakeRes() {
    let code = 200, payload = null;
    return {
      status(c) { code = c; return this; },
      json(p)   { payload = p; return this; },
      get _code() { return code; },
      get _payload() { return payload; },
    };
  }

  it('on Windows: passes through to next()', () => {
    if (!isWindows) return;
    const next = vi.fn();
    const res = fakeRes();
    requireWindows('X')({}, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('on non-Windows: returns 503 with platform label', () => {
    if (isWindows) return;
    const next = vi.fn();
    const res = fakeRes();
    requireWindows('Device control')({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._code).toBe(503);
    expect(res._payload.error).toMatch(/Windows-only/);
    expect(res._payload.platform).toBe(platformLabel());
  });
});
