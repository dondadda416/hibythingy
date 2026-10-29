import { describe, it, expect, vi } from 'vitest';
import { validateBody, validateQuery, validateParams } from '../lib/validate.js';
import { z } from 'zod';

// Tiny Express-like req/res stubs.
function makeReqRes(part, value) {
  const req = { body: undefined, query: undefined, params: undefined };
  req[part] = value;
  let statusCode = 200;
  let payload = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(p)   { payload = p; return res; },
    get _statusCode() { return statusCode; },
    get _payload() { return payload; },
  };
  return { req, res };
}

describe('validate.validateBody', () => {
  const Schema = z.object({ folder: z.string().min(1), force: z.boolean().optional() });
  const mw = validateBody(Schema);

  it('passes valid input through and replaces req.body', () => {
    const { req, res } = makeReqRes('body', { folder: 'A', extra: 'dropped' });
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body.folder).toBe('A');
    expect('extra' in req.body).toBe(false); // unknown keys stripped
  });

  it('returns 400 with field errors on invalid input', () => {
    const { req, res } = makeReqRes('body', { folder: '' });
    const next = vi.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
    expect(res._payload.error).toBe('Invalid request');
    expect(res._payload.fieldErrors.folder).toBeDefined();
  });

  it('treats null body as an empty object', () => {
    const { req, res } = makeReqRes('body', null);
    const next = vi.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(400);
  });

  it('forwards non-Zod errors to next()', () => {
    const explodingSchema = { parse() { throw new Error('boom'); } };
    const mwBad = validateBody(explodingSchema);
    const { req, res } = makeReqRes('body', {});
    const next = vi.fn();
    mwBad(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('validate.validateQuery', () => {
  const Schema = z.object({ q: z.string().min(1) });
  const mw = validateQuery(Schema);

  it('stores parsed result on req.validatedQuery', () => {
    const { req, res } = makeReqRes('query', { q: 'hello' });
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.validatedQuery.q).toBe('hello');
  });

  it('rejects empty query parameter', () => {
    const { req, res } = makeReqRes('query', { q: '' });
    const next = vi.fn();
    mw(req, res, next);
    expect(res._statusCode).toBe(400);
  });
});

describe('validate.validateParams', () => {
  const Schema = z.object({ app: z.enum(['mp3tag', 'soulseek']) });
  const mw = validateParams(Schema);

  it('accepts a valid enum value', () => {
    const { req, res } = makeReqRes('params', { app: 'mp3tag' });
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an unknown enum value', () => {
    const { req, res } = makeReqRes('params', { app: 'nope' });
    const next = vi.fn();
    mw(req, res, next);
    expect(res._statusCode).toBe(400);
  });
});
