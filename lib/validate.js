'use strict';
// ── lib/validate.js ──────────────────────────────────────────────────────────
// Express middleware factories for Zod schema validation. Bind a schema to a
// request part (body, query, params); on parse failure, return a structured
// 400 with field-level errors and stop the handler chain. On success, the
// validated/coerced value replaces the original (e.g. `req.body` is now the
// parsed object).
//
//   const { z } = require('zod');
//   const { validateBody } = require('../lib/validate');
//   const Schema = z.object({ folder: z.string().min(1) });
//   router.post('/apply', validateBody(Schema), (req, res) => { ... });

// Duck-type check instead of `instanceof ZodError`. Vitest loads `zod` through
// Vite's ESM transformer while `require('zod')` here resolves the CJS build —
// the two ZodError classes are different identities, so instanceof would
// silently miss in tests (and could miss in production if a dep ever pulls a
// duplicate copy of zod). The real signal is the `.issues` array Zod attaches.
function isZodError(err) {
  return err && (err.name === 'ZodError' || Array.isArray(err.issues));
}

function buildErrorPayload(err) {
  const fieldErrors = {};
  for (const issue of err.issues || []) {
    const key = (issue.path || []).join('.') || '_root';
    if (!fieldErrors[key]) fieldErrors[key] = [];
    fieldErrors[key].push(issue.message);
  }
  return { error: 'Invalid request', fieldErrors };
}

function validateBody(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body || {});
      req.body = parsed;
      next();
    } catch (err) {
      if (isZodError(err)) return res.status(400).json(buildErrorPayload(err));
      next(err);
    }
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.query || {});
      // Keep the parsed copy on req.validatedQuery — overwriting req.query is
      // not allowed in Express 5 (it's a getter).
      req.validatedQuery = parsed;
      next();
    } catch (err) {
      if (isZodError(err)) return res.status(400).json(buildErrorPayload(err));
      next(err);
    }
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.params || {});
      req.validatedParams = parsed;
      next();
    } catch (err) {
      if (isZodError(err)) return res.status(400).json(buildErrorPayload(err));
      next(err);
    }
  };
}

module.exports = { validateBody, validateQuery, validateParams };
