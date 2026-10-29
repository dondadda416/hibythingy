'use strict';
// ── lib/safePath.js ──────────────────────────────────────────────────────────
// Canonical-path validator. Use this whenever a request body or query carries a
// filesystem path that gets joined with INBOX_PATH or LIBRARY_PATH. It resolves
// the candidate path, strips relative segments, and rejects anything that
// escapes the allowed roots.
//
//   const safe = resolveUnder(req.body.folderPath, [config.INBOX_PATH, config.LIBRARY_PATH]);
//   if (!safe) return res.status(400).json({ error: 'invalid path' });
//
// Returns the resolved absolute path on success, or null if the path is outside
// every supplied root. Comparison is case-insensitive on Windows.

const path = require('path');

const isWindows = process.platform === 'win32';

function normaliseForCompare(p) {
  // Resolve to absolute, strip trailing separator, lower-case on Windows for
  // drive-letter case insensitivity.
  let n = path.resolve(p);
  if (n.endsWith(path.sep)) n = n.slice(0, -path.sep.length);
  return isWindows ? n.toLowerCase() : n;
}

function isInsideRoot(candidate, root) {
  const c = normaliseForCompare(candidate);
  const r = normaliseForCompare(root);
  // Either equal to the root or strictly inside it (root + sep prefix).
  return c === r || c.startsWith(r + path.sep);
}

// Resolve `inputPath` and return the absolute version IFF it sits inside one
// of the supplied root directories. Otherwise return null.
function resolveUnder(inputPath, roots) {
  if (typeof inputPath !== 'string' || !inputPath.length) return null;
  if (!Array.isArray(roots) || roots.length === 0) return null;

  // Reject obvious nonsense up front.
  if (inputPath.includes('\0')) return null;

  let resolved;
  try { resolved = path.resolve(inputPath); }
  catch (_) { return null; }

  for (const root of roots) {
    if (typeof root !== 'string' || !root.length) continue;
    if (isInsideRoot(resolved, root)) return resolved;
  }
  return null;
}

// Convenience: return a resolved path under one of the roots, or fall back to
// joining `fallbackName` under the first root. Used for the common pattern of
// "use req.query.path if it's safe, otherwise use INBOX_PATH/<folderName>".
function resolveUnderOrJoin(inputPath, fallbackName, roots) {
  if (inputPath) {
    const r = resolveUnder(inputPath, roots);
    if (r) return r;
  }
  if (!Array.isArray(roots) || roots.length === 0 || !fallbackName) return null;
  const candidate = path.join(roots[0], fallbackName);
  return resolveUnder(candidate, roots);
}

module.exports = { resolveUnder, resolveUnderOrJoin, isInsideRoot };
