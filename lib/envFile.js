'use strict';
// ── lib/envFile.js ───────────────────────────────────────────────────────────
// Read/write .env files while preserving comments, blank lines, and the
// existing key order. Used by the Settings UI so user-edited keys can be
// updated in place without nuking comment blocks or unknown variables.

const fs   = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomicWriteJson');

// Parse a line — returns one of:
//   { kind: 'kv', key, value, raw }  for KEY=value
//   { kind: 'comment',  raw }        for "# comment" / blank lines
function _parseLine(raw) {
  // Trim trailing newline only — preserve indentation/etc.
  const stripped = raw.replace(/\r?\n$/, '');
  const trim = stripped.trim();
  if (trim === '' || trim.startsWith('#')) return { kind: 'comment', raw: stripped };
  const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return { kind: 'comment', raw: stripped };  // malformed, treat as opaque
  return { kind: 'kv', key: m[1], value: m[2], raw: stripped };
}

// Quote a value if it contains characters that require it. Conservative —
// only quotes when needed so the round-trip stays clean for simple values.
function _quoteValue(v) {
  if (v == null) return '';
  const s = String(v);
  if (s === '') return '';
  if (/^[A-Za-z0-9_./:@\-]+$/.test(s)) return s; // safe set
  // Wrap in double quotes; escape inner double quotes.
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// Strip surrounding quotes for read.
function _unquote(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return s;
}

// Read .env into an array of parsed lines. If the file doesn't exist, returns
// an empty array — caller should still be able to add new keys.
function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return [];
  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  // Drop the trailing empty element that's an artifact of the file ending in
  // a newline — otherwise serialise() round-trips into two trailing newlines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(_parseLine);
}

// Get a single value as a string (empty string if absent).
function getValue(lines, key) {
  for (const l of lines) {
    if (l.kind === 'kv' && l.key === key) return _unquote(l.value);
  }
  return '';
}

// Apply a map of {KEY: value} updates and return the new lines array. Keys
// that already exist are updated in place; new keys are appended at the end.
// Setting a value to '' or null removes the key (collapses the line).
function applyUpdates(lines, updates) {
  const out = lines.slice();
  const seen = new Set();
  for (const i of out.keys()) {
    const l = out[i];
    if (l.kind !== 'kv') continue;
    if (Object.prototype.hasOwnProperty.call(updates, l.key)) {
      const v = updates[l.key];
      seen.add(l.key);
      if (v == null || v === '') {
        // Replace with an empty key (preserves position better than a remove).
        out[i] = { kind: 'kv', key: l.key, value: '', raw: `${l.key}=` };
      } else {
        out[i] = { kind: 'kv', key: l.key, value: _quoteValue(v), raw: `${l.key}=${_quoteValue(v)}` };
      }
    }
  }
  // Append any new keys not yet present.
  for (const [k, v] of Object.entries(updates)) {
    if (seen.has(k)) continue;
    if (v == null || v === '') continue; // skip empty new keys
    out.push({ kind: 'kv', key: k, value: _quoteValue(v), raw: `${k}=${_quoteValue(v)}` });
  }
  return out;
}

// Serialise back to a string. Trailing newline kept for tidiness.
function serialise(lines) {
  return lines.map(l => l.raw).join('\n') + '\n';
}

// Atomic write — uses lib/atomicWriteJson's tmp-then-rename pattern but for
// a text file. Bypasses JSON.stringify; we already serialised.
function atomicWriteEnvSync(envPath, lines) {
  const tmp = envPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, serialise(lines), 'utf8');
  fs.renameSync(tmp, envPath);
}

module.exports = { readEnv, getValue, applyUpdates, serialise, atomicWriteEnvSync };
