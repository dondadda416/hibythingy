'use strict';
// ── lib/atomicWriteJson.js ───────────────────────────────────────────────────
// Atomic JSON writer. Replaces fs.writeFileSync(target, JSON.stringify(data))
// so that a crash mid-write cannot leave a half-written cache file. Strategy:
// write to <target>.<pid>.tmp, fsync, then rename over the target.
//
// Windows quirks:
//   - rename can fail with EPERM/EBUSY when another process (or another
//     thread of the same process) has the destination open momentarily, e.g.
//     under heavy concurrent writes. We retry a handful of times with a short
//     backoff.
//   - For in-process writers we serialise per-target so concurrent
//     atomicWriteJson() calls against the same path can't race the rename
//     against each other.
//
//   atomicWriteJsonSync(PUSHED_FILE, log);
//   await atomicWriteJson(PUSHED_FILE, log);

const fs   = require('fs');
const path = require('path');

let _counter = 0;

// Brief backoff retry for transient Windows rename failures.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);
const RENAME_RETRIES = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function renameWithRetrySync(from, to) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (err) {
      lastErr = err;
      if (!RENAME_RETRY_CODES.has(err.code)) throw err;
      // Tiny synchronous backoff. Yes, busy-wait — but only on rare collisions.
      const until = Date.now() + (5 << attempt);
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

async function renameWithRetry(from, to) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try { await fs.promises.rename(from, to); return; }
    catch (err) {
      lastErr = err;
      if (!RENAME_RETRY_CODES.has(err.code)) throw err;
      await sleep(5 << attempt);
    }
  }
  throw lastErr;
}

function atomicWriteJsonSync(target, data, indent = 2) {
  const dir  = path.dirname(target);
  const base = path.basename(target);
  const tmp  = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${++_counter}.tmp`);

  let fd;
  try {
    const json = JSON.stringify(data, null, indent);
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, json);
    try { fs.fsyncSync(fd); } catch (_) { /* fsync may not be supported */ }
    fs.closeSync(fd);
    fd = null;
    renameWithRetrySync(tmp, target);
  } catch (err) {
    try { if (fd != null) fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

// In-process per-target serialisation. Concurrent atomicWriteJson() calls for
// the same path queue behind each other so a winner is decided cleanly.
const _inflight = new Map(); // target → Promise

async function _doAtomicWriteJson(target, data, indent) {
  const dir  = path.dirname(target);
  const base = path.basename(target);
  const tmp  = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${++_counter}.tmp`);
  const fsp  = fs.promises;
  let handle;
  try {
    const json = JSON.stringify(data, null, indent);
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(json);
    try { await handle.sync(); } catch (_) {}
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, target);
  } catch (err) {
    try { if (handle) await handle.close(); } catch (_) {}
    try { await fsp.unlink(tmp); } catch (_) {}
    throw err;
  }
}

async function atomicWriteJson(target, data, indent = 2) {
  // Chain onto any in-flight write to the same target so we never have two
  // renames racing against each other (Windows trips on this).
  const prev = _inflight.get(target) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => _doAtomicWriteJson(target, data, indent));
  _inflight.set(target, next);
  try { await next; }
  finally {
    // Only clear the slot if we're the most recent writer.
    if (_inflight.get(target) === next) _inflight.delete(target);
  }
}

module.exports = { atomicWriteJsonSync, atomicWriteJson };
