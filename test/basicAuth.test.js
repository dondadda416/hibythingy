import { describe, it, expect, vi } from 'vitest';
import { build, safeEqual, SKIP_PREFIXES } from '../lib/basicAuth.js';

function makeReqRes(opts = {}) {
  const req = {
    path:    opts.path || '/api/library',
    method:  opts.method || 'GET',
    headers: opts.headers || {},
  };
  let statusCode = 200;
  let payload = null;
  let headers = {};
  const res = {
    status(c) { statusCode = c; return res; },
    json(p)   { payload = p; return res; },
    set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return res; },
    get _statusCode() { return statusCode; },
    get _payload()    { return payload; },
    get _headers()    { return headers; },
  };
  return { req, res };
}

function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

describe('basicAuth.safeEqual', () => {
  it('returns true for matching strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
  it('returns false for mismatched strings of equal length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
  it('returns false for different-length strings', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('handles empty / null / undefined safely', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(null, undefined)).toBe(true);
    expect(safeEqual('x', '')).toBe(false);
  });
});

describe('basicAuth middleware — auth disabled', () => {
  it('passes through when both creds are empty', () => {
    const mw = build({ BASIC_AUTH_USER: '', BASIC_AUTH_PASS: '' });
    const next = vi.fn();
    const { req, res } = makeReqRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._statusCode).toBe(200); // never touched
  });

  it('passes through when one of the two is empty (treat as off)', () => {
    const mw = build({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: '' });
    const next = vi.fn();
    const { req, res } = makeReqRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('basicAuth middleware — auth enabled', () => {
  const cfg = { BASIC_AUTH_USER: 'admin', BASIC_AUTH_PASS: 'secret' };

  it('rejects requests without an Authorization header', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(401);
    expect(res._headers['WWW-Authenticate']).toMatch(/^Basic /);
  });

  it('rejects bad credentials', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ headers: { authorization: basicHeader('admin', 'wrong') } });
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(401);
  });

  it('rejects bad username (even with right password)', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ headers: { authorization: basicHeader('wrong', 'secret') } });
    mw(req, res, next);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts matching credentials', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ headers: { authorization: basicHeader('admin', 'secret') } });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._statusCode).toBe(200);
  });

  it('rejects a malformed header', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ headers: { authorization: 'Bearer xyz' } });
    mw(req, res, next);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('skips the cover-art serve path even without credentials', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ path: '/api/coverart/serve' });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips the audio-preview path even without credentials', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ path: '/api/tags/preview' });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('skip-list does not match unrelated paths that share a substring', () => {
    const mw = build(cfg);
    const next = vi.fn();
    const { req, res } = makeReqRes({ path: '/api/library' }); // not in skip list
    mw(req, res, next);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('exposes the skip prefix list', () => {
    expect(SKIP_PREFIXES).toContain('/api/coverart/serve');
    expect(SKIP_PREFIXES).toContain('/api/tags/preview');
    expect(SKIP_PREFIXES).toContain('/api/events');
  });
});
