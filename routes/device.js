// ── Device route — HiBy R4 via Windows MTP (PowerShell Shell.Application) ────
const express = require('express');
const router  = express.Router();
const { exec, spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');

const normalise = require('../lib/normalise');
const { resolveUnder }        = require('../lib/safePath');
const { validateBody }        = require('../lib/validate');
const { DevicePushBody, DevicePushBatchBody } = require('../lib/schemas');
const { requireWindows }      = require('../lib/platform');
const db                      = require('../lib/db');

// Every PowerShell-backed endpoint in this router needs Windows. Apply the
// gate at the router level so non-Windows hosts get a clean 503 with a hint
// instead of a cryptic ENOENT for `powershell.exe`.
router.use(requireWindows('Device control'));

const CACHE_FILE    = path.join(config.CACHE_DIR, 'device.json');
const PUSHED_FILE   = path.join(config.CACHE_DIR, 'pushed.json');
const SCRIPTS_DIR   = path.join(__dirname, '..', 'scripts');

// ── Timeouts ────────────────────────────────────────────────────────────────
// Generous on purpose — PowerShell startup alone is ~1s and MTP transfers
// over USB can be slow on a busy device. These are upper bounds; the script
// usually finishes long before.
const PS_CMD_TIMEOUT_MS    = 15_000;   // 15s   — quick inline PS commands (status check)
const PS_SCRIPT_TIMEOUT_MS = 120_000;  // 2 min — running a .ps1 file
const SCAN_TIMEOUT_MS      = 600_000;  // 10 min — full MTP namespace walk
const PUSH_JOB_TIMEOUT_MS  = 360_000;  // 6 min  — single album push
const BATCH_PUSH_TIMEOUT_MS = 480_000; // 8 min  — per album in a batch
const PUSH_POLL_INTERVAL_MS = 5_000;   // 5s     — UI poll cadence during push

// Run a PowerShell command string, return stdout as string
function runPS(command, timeoutMs = PS_CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // -NonInteractive prevents prompts; -NoProfile speeds startup
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

// Run a PowerShell script file, return stdout
function runPSFile(scriptPath, timeoutMs = PS_SCRIPT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
    exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

// Quick check: is the device connected? Uses WPD device class (fast, <1s).
async function getStatus() {
  try {
    // List ALL WPD devices — filter client-side so escaping is simple
    const ps = `Get-PnpDevice -Class WPD -Status OK -ErrorAction SilentlyContinue | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress`;
    const result = await runPS(ps);
    if (!result || result === 'null') return { connected: false };

    let devs;
    try {
      devs = JSON.parse(result);
      // PowerShell returns a single object (not array) when there's only one device
      if (!Array.isArray(devs)) devs = [devs];
    } catch (_) {
      return { connected: false };
    }

    if (devs.length === 0) return { connected: false };

    // Only match devices that look like the target DAP — never fall back to random USB drives
    const namePattern = new RegExp(`${config.DEVICE_NAME}|HiBy|R[0-9]`, 'i');
    const dev = devs.find(d => d.FriendlyName && namePattern.test(d.FriendlyName));

    if (!dev) return { connected: false, available: devs.map(d => d.FriendlyName).join(', ') };
    return { connected: true, name: dev.FriendlyName || config.DEVICE_NAME, instanceId: dev.InstanceId || '' };
  } catch (e) {
    return { connected: null, error: e.message };
  }
}

// Read the timestamp of the last successful MTP scan. Used to decide which
// push-log entries are "verifiable" against the scan.
function getLastScanTime() {
  try {
    const s = db.getDeviceScanStatus() || {};
    if (!s.scannedAt) return null;
    const t = Date.parse(s.scannedAt);
    return Number.isFinite(t) ? t : null;
  } catch (_) { return null; }
}

// Build a Set of normalised keys for everything currently believed to be on
// the device (post-filter via getCachedAlbums). Used for backlog match +
// duplicate skip.
function getDeviceNormKeys() {
  const keys = new Set();
  for (const a of getCachedAlbums()) {
    if (a.key) keys.add(normalise(a.key));
    if (a.name) keys.add(normalise(a.name));
    if (a.artist && a.album) keys.add(normalise(`${a.artist} \u2014 ${a.album}`));
  }
  return keys;
}

// Return true if this artist+album combination is already on the device
function isAlreadyOnDevice(artist, album) {
  const keys = getDeviceNormKeys();
  if (keys.size === 0) return false;  // no data — can't confirm, allow push
  const candidate = normalise(`${artist} \u2014 ${album}`);
  const albumOnly = normalise(album);
  return keys.has(candidate) || keys.has(albumOnly);
}

// Return device album list. The two sources are merged with MTP scan as the
// authoritative truth and the push log as a hint that's only trusted when the
// scan can't disprove it:
//
//   - MTP scan entries           -> kept, _verified: true.
//   - Push log AFTER last scan   -> kept, _verified: false (pending).
//   - Push log BEFORE last scan
//     but missing from the scan  -> dropped. These are pushes that Hub claimed
//                                   worked but the device disagrees. Counting
//                                   them as "on device" is what made the
//                                   dashboard say "fully in sync" while songs
//                                   weren't actually on the player.
//   - No scan has ever run       -> trust everything in the push log (no
//                                   ground truth to compare against).
function getCachedAlbums() {
  const albumMap = new Map();
  const scanTime = getLastScanTime();
  const hasScan  = scanTime !== null;

  // MTP scan: authoritative when present.
  try {
    for (const a of db.getAlbums('device-mtp')) {
      if (a.key) albumMap.set(a.key, { ...a, _source: 'mtp-scan', _verified: true });
    }
  } catch (e) { console.warn('[device/cached]', e.message); }

  // Push log: only the entries the scan hasn't disproven.
  const log = loadPushLog();
  for (const a of (log.albums || [])) {
    if (!a.key || albumMap.has(a.key)) continue;  // scan already confirmed
    if (!hasScan) {
      albumMap.set(a.key, { ...a, _source: 'push-log', _verified: false });
      continue;
    }
    const pushedAt = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    if (pushedAt > scanTime) {
      // Pushed after last scan -> pending verification, count as on-device.
      albumMap.set(a.key, { ...a, _source: 'push-log-pending', _verified: false });
    }
    // else: pushed before scan, scan didn't see it -> confirmed missing, drop.
  }
  return Array.from(albumMap.values());
}

// ── Push log helpers ──────────────────────────────────────────────────────────

function loadPushLog() {
  try { return db.getPushLog(); }
  catch (e) { console.warn('[device/pushlog]', e.message); return { albums: [], albumCount: 0 }; }
}

// Persist a successful push. SQLite's UPSERT on the 'key' column means
// re-pushes update in place — no manual filter+sort dance needed.
function recordPush(artist, album, tracks, sizeMB) {
  try { db.recordPush(artist, album, tracks, sizeMB); }
  catch (e) { console.warn('[device] push-log write failed:', e.message); }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/device/status — quick connection check
router.get('/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/device/files — merge MTP scan + push log so nothing is missed.
// MTP scan gives the baseline (what was already on the device before Hub).
// Push log adds albums Hub has pushed since the last scan.
// Together they give the most complete picture of what's on the device.
router.get('/files', (req, res) => {
  const albumMap = new Map();  // key → album object (deduped by key)

  // Layer 1: MTP scan (baseline)
  try {
    for (const a of db.getAlbums('device-mtp')) {
      if (a.key) albumMap.set(a.key, a);
    }
  } catch (e) { console.warn('[device/files]', e.message); }

  // Layer 2: Push log (albums Hub has pushed — these override/add to the scan)
  const log = loadPushLog();
  if (Array.isArray(log.albums)) {
    for (const a of log.albums) {
      if (a.key) albumMap.set(a.key, a);
    }
  }

  if (albumMap.size === 0) {
    return res.json({ albums: [], albumCount: 0, fromCache: false, source: 'none',
      message: 'No data yet. Run Force MTP Scan on Devices tab, or push an album.' });
  }

  const albums = Array.from(albumMap.values()).sort((a, b) => (a.key || '').localeCompare(b.key || ''));
  res.json({ albums, albumCount: albums.length, fromCache: true, source: 'merged' });
});

// DELETE /api/device/pushed — clear the push log
router.delete('/pushed', (req, res) => {
  try {
    const before = db.getPushLog().albumCount;
    db.clearPushLog();
    db.logActivity('system', 'push-log-cleared', null, { removed: before });
    res.json({ ok: true, message: 'Push log cleared.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Clear failed' });
  }
});

// GET /api/device/test-walk — diagnostic: walk the R4 MTP namespace step by step, return raw log
router.get('/test-walk', async (req, res) => {
  const scriptPath = path.join(SCRIPTS_DIR, 'test-device-walk.ps1');
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: 'test-device-walk.ps1 not found' });
  try {
    const output = await runPSFile(scriptPath, 60000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/device/detect — diagnostic: list ALL portable devices and Shell.Application items
// Use this to find the exact name Windows gives the HiBy so you can update DEVICE_NAME in config.js
router.get('/detect', async (req, res) => {
  const os   = require('os');
  const tmpScript = path.join(os.tmpdir(), 'hiby-detect.ps1');
  const psContent = `
$out = @{ wpdDevices = @(); shellItems = @() }
try {
  $wpd = Get-PnpDevice -Class WPD -Status OK -ErrorAction SilentlyContinue | Select-Object FriendlyName,InstanceId
  if ($wpd) {
    $out.wpdDevices = @($wpd | ForEach-Object { "$($_.FriendlyName) [$($_.InstanceId)]" })
  }
} catch {}
try {
  $shell  = New-Object -ComObject Shell.Application
  $thisPC = $shell.NameSpace(17)
  $out.shellItems = @($thisPC.Items() | ForEach-Object { $_.Name })
} catch {}
$out | ConvertTo-Json -Compress
`;
  try {
    fs.writeFileSync(tmpScript, psContent, 'utf8');
    const result = await runPSFile(tmpScript, 20000);
    let parsed;
    try { parsed = JSON.parse(result); } catch (_) { parsed = { raw: result }; }
    res.json({ ok: true, ...parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    try { fs.unlinkSync(tmpScript); } catch (_) {}
  }
});

// POST /api/device/scan — full MTP file tree scan (slow, runs in background, caches result)
router.post('/scan', async (req, res) => {
  const scriptPath = path.join(SCRIPTS_DIR, 'list-device-files.ps1');

  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ error: 'Script not found: ' + scriptPath });
  }

  // Write a "scanning" marker so the poller can tell the scan is in progress
  const startedAt = new Date().toISOString();
  try { db.setDeviceScanStatus({ status: 'scanning', startedAt }); }
  catch (_) {}

  // Respond immediately so the UI can show a "scanning…" state
  res.json({ status: 'scanning', startedAt, message: 'Device scan started.' });

  // Use a temp file for output — avoids stdout encoding/buffer issues with large MTP scans
  const TEMP_FILE = path.join(config.CACHE_DIR, 'device-scan-temp.json');

  // Build PS command with -OutFile param so the script writes JSON directly
  // to disk. Pass an optional -MusicFolder so users with non-default folder
  // layouts (anything other than "Music") can configure it via .env.
  const musicFolder = (config.DEVICE_MUSIC_FOLDER || '').trim();
  const runScan = () => new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                  '-File', scriptPath,
                  '-OutFile', TEMP_FILE];
    if (musicFolder) { args.push('-MusicFolder', musicFolder); }
    const { spawn: spawnChild } = require('child_process');
    const proc = spawnChild('powershell.exe', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    const killTimer = setTimeout(() => { proc.kill(); reject(new Error('Scan timed out after 10 minutes')); }, SCAN_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0) return reject(new Error((stderr || `Exit code ${code}`).trim()));
      resolve();
    });
    proc.on('error', reject);
  });

  // Run in background — 10 min timeout
  runScan()
    .then(() => {
      try {
        const raw = fs.readFileSync(TEMP_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
        let data = JSON.parse(raw);
        if (Array.isArray(data)) data = data[0];
        // Persist the album list + status separately. Status drives the poll
        // UI; the album list feeds backlog calculations.
        const albums = Array.isArray(data.albums) ? data.albums : [];
        db.setAlbums('device-mtp', albums);
        db.setDeviceScanStatus({
          status:     'done',
          startedAt,
          scannedAt:  new Date().toISOString(),
          albumCount: data.albumCount || albums.length,
          connected:  data.connected,
        });
        console.log(`Device scan complete: ${data.albumCount || albums.length} albums found`);
      } catch (parseErr) {
        try {
          db.setDeviceScanStatus({
            status: 'error',
            error:  'Could not parse scan output: ' + parseErr.message,
            scannedAt: new Date().toISOString(),
          });
        } catch (_) {}
        console.error('Device scan parse error:', parseErr.message);
      }
    })
    .catch(err => {
      try {
        db.setDeviceScanStatus({
          status: 'error',
          error:  err.message,
          scannedAt: new Date().toISOString(),
        });
      } catch (_) {}
      console.error('Device scan error:', err.message);
    });
});

// GET /api/device/scan-status — returns current scan state from DB
router.get('/scan-status', (req, res) => {
  try {
    res.json(db.getDeviceScanStatus());
  } catch (_) {
    res.json({ status: 'none' });
  }
});

// GET /api/device/verify
// Diagnose drift between what Hub thinks it pushed and what is actually on
// the device. Compares the push log against the latest MTP scan and returns:
//   - missing:   push-log entries the scan can't find (Hub lied to itself)
//   - pending:   push-log entries newer than the scan (not yet verifiable)
//   - confirmed: push-log entries the scan agrees are there
// If no MTP scan has ever run, the user is told to run one first.
router.get('/verify', (req, res) => {
  let scanAlbums = [];
  try { scanAlbums = db.getAlbums('device-mtp') || []; }
  catch (_) { scanAlbums = []; }

  const scanTime = getLastScanTime();
  if (!scanTime || scanAlbums.length === 0) {
    return res.json({
      ok: false,
      reason: 'no-scan',
      message: 'Run Force MTP Scan on the Devices tab first — without a scan there is no ground truth to verify the push log against.',
    });
  }

  // Build normalised key set from the scan (multiple aliases per album).
  const mtpKeys = new Set();
  for (const a of scanAlbums) {
    if (a.key)  mtpKeys.add(normalise(a.key));
    if (a.name) mtpKeys.add(normalise(a.name));
    if (a.artist && a.album) mtpKeys.add(normalise(`${a.artist} — ${a.album}`));
  }

  const log = loadPushLog();
  const missing   = [];
  const pending   = [];
  const confirmed = [];

  for (const a of (log.albums || [])) {
    const pushedAt = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const entry = {
      key:      a.key,
      artist:   a.artist || '',
      album:    a.album  || '',
      tracks:   a.tracks || 0,
      pushedAt: a.pushedAt || null,
    };
    if (pushedAt > scanTime) { pending.push(entry); continue; }

    const k1 = a.key ? normalise(a.key) : '';
    const k2 = a.artist && a.album ? normalise(`${a.artist} — ${a.album}`) : '';
    const k3 = a.album ? normalise(a.album) : '';
    if (mtpKeys.has(k1) || mtpKeys.has(k2) || mtpKeys.has(k3)) {
      confirmed.push(entry);
    } else {
      missing.push(entry);
    }
  }

  res.json({
    ok: true,
    scannedAt:     new Date(scanTime).toISOString(),
    mtpScanCount:  scanAlbums.length,
    pushLogCount:  (log.albums || []).length,
    confirmedCount: confirmed.length,
    pendingCount:   pending.length,
    missingCount:   missing.length,
    missing,    // claimed pushed but not on device
    pending,    // pushed after last scan; rescan to verify
    confirmed,
  });
});

// POST /api/device/verify/prune
// Remove push-log entries that the latest MTP scan can't find. Use after
// /api/device/verify shows missing entries — clearing them lets those albums
// flow back into the Sync backlog so they can be re-pushed.
router.post('/verify/prune', (req, res) => {
  let scanAlbums = [];
  try { scanAlbums = db.getAlbums('device-mtp') || []; }
  catch (_) { scanAlbums = []; }
  const scanTime = getLastScanTime();
  if (!scanTime || scanAlbums.length === 0) {
    return res.status(400).json({ ok: false, error: 'Run Force MTP Scan first.' });
  }

  const mtpKeys = new Set();
  for (const a of scanAlbums) {
    if (a.key)  mtpKeys.add(normalise(a.key));
    if (a.name) mtpKeys.add(normalise(a.name));
    if (a.artist && a.album) mtpKeys.add(normalise(`${a.artist} — ${a.album}`));
  }

  const log = loadPushLog();
  const keysToDrop = [];
  for (const a of (log.albums || [])) {
    const pushedAt = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    if (pushedAt > scanTime) continue;  // newer than scan, not yet verifiable
    const k1 = a.key ? normalise(a.key) : '';
    const k2 = a.artist && a.album ? normalise(`${a.artist} — ${a.album}`) : '';
    const k3 = a.album ? normalise(a.album) : '';
    if (!mtpKeys.has(k1) && !mtpKeys.has(k2) && !mtpKeys.has(k3)) {
      keysToDrop.push(a.key);
    }
  }

  let removed = 0;
  for (const k of keysToDrop) {
    try { removed += db.removePushLogEntry(k) ? 1 : 0; }
    catch (e) { console.warn('[device/verify/prune]', k, e.message); }
  }
  try { db.logActivity('system', 'push-log-pruned', null, { removed }); } catch (_) {}
  res.json({ ok: true, removed, candidates: keysToDrop.length });
});

// ── Push tracking — simple in-memory queue ─────────────────────────────────────
const pushJobs = [];  // { id, artist, album, status, progress, error, startedAt, finishedAt }
let _pushIdCounter = 1;

// GET /api/device/push — return current push job list
router.get('/push', (req, res) => {
  res.json({ jobs: pushJobs.slice(-20) });  // last 20 jobs
});

// POST /api/device/push
// Body: { sourcePath, artist, album, force }
// Pushes one album folder from master library to the HiBy SD card via MTP.
// Pass force:true to skip the duplicate check.
router.post('/push', validateBody(DevicePushBody), (req, res) => {
  const { sourcePath: suppliedPath, artist, album, force } = req.body;
  // sourcePath must sit under LIBRARY_PATH (or INBOX_PATH for direct-from-inbox pushes).
  const sourcePath = resolveUnder(suppliedPath, [config.LIBRARY_PATH, config.INBOX_PATH]);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source path not found' });
  }

  // ── Duplicate check ───────────────────────────────────────────────────────
  if (!force && isAlreadyOnDevice(artist, album)) {
    return res.json({
      ok:      true,
      skipped: true,
      reason:  'already_on_device',
      artist,
      album,
      message: `"${artist} — ${album}" is already on your HiBy — skipped.`,
    });
  }

  const scriptPath = path.join(SCRIPTS_DIR, 'push-to-device.ps1');
  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ error: 'Push script not found' });
  }

  const jobId = _pushIdCounter++;
  const job = { id: jobId, artist, album, sourcePath, status: 'running', startedAt: new Date().toISOString() };
  pushJobs.push(job);
  if (pushJobs.length > 200) pushJobs.splice(0, pushJobs.length - 200);

  // Respond immediately — the push runs in background
  res.json({ ok: true, jobId, status: 'running', message: `Pushing "${artist} — ${album}" to device…` });

  // Use a temp file for JSON output — avoids all stdout encoding issues
  const pushOutFile = path.join(config.CACHE_DIR, `push-result-${jobId}.json`);

  // Ensure cache dir exists
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });

  // Build a PowerShell -Command string using single-quoted PS strings (no injection, no -File binding issues)
  const esc = s => s.replace(/'/g, "''");  // PS single-quote escape
  const psCmd = `& '${esc(scriptPath)}' -SourcePath '${esc(sourcePath)}' -Artist '${esc(artist || '_')}' -Album '${esc(album)}' -OutFile '${esc(pushOutFile)}'`;

  // Use spawn() so no cmd.exe wrapper; -Command takes the whole script-call as one string
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd];

  const stdoutChunks = [];
  const stderrChunks = [];
  const ps = spawn('powershell.exe', psArgs, { windowsHide: true });

  ps.stdout.on('data', d => stdoutChunks.push(d));
  ps.stderr.on('data', d => stderrChunks.push(d));

  // Safety timeout: kill after PUSH_JOB_TIMEOUT_MS.
  const killTimer = setTimeout(() => {
    ps.kill();
    job.status = 'error';
    job.error  = `Push timed out after ${Math.round(PUSH_JOB_TIMEOUT_MS / 60000)} minutes`;
  }, PUSH_JOB_TIMEOUT_MS);

  ps.on('close', exitCode => {
    clearTimeout(killTimer);
    job.finishedAt = new Date().toISOString();
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    // Always try to read result from OutFile — Bail() also writes there
    let result = null;
    try {
      if (fs.existsSync(pushOutFile)) {
        const raw = fs.readFileSync(pushOutFile, 'utf8').replace(/^\uFEFF/, '').trim();
        result = JSON.parse(raw);
        if (Array.isArray(result)) result = result[0];
      }
    } catch (parseErr) {
      console.error(`Push job ${jobId} outfile parse error:`, parseErr.message);
    }
    try { fs.unlinkSync(pushOutFile); } catch (_) {}

    // Fallback: scan stdout for JSON line
    if (!result) {
      const lines = stdout.replace(/^\uFEFF/, '').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (l.startsWith('{')) {
          try { result = JSON.parse(l); break; } catch (_) {}
        }
      }
    }

    if (result && result.ok) {
      job.status = 'done';
      // Record the count actually verified on the device (falls back to the
      // expected count for legacy callers that don't return tracksOnDevice).
      const recordedTracks = Number.isFinite(result.tracksOnDevice)
        ? result.tracksOnDevice
        : result.tracks;
      job.tracks         = result.tracks;
      job.tracksOnDevice = recordedTracks;
      job.sizeMB         = result.sizeMB;
      job.verified       = result.verified !== false;
      if (result.warning) job.warning = result.warning;
      try { recordPush(artist, album, recordedTracks, result.sizeMB); } catch (_) {}
      try {
        db.logActivity('push', 'pushed', `${artist} — ${album}`, {
          tracks:         result.tracks,
          tracksOnDevice: recordedTracks,
          verified:       job.verified,
          sizeMB:         result.sizeMB,
          warning:        result.warning || null,
        });
      } catch (_) {}
      const verifLabel = job.verified ? 'verified' : `PARTIAL (${recordedTracks}/${result.tracks})`;
      console.log(`Push job ${jobId}: "${artist} — ${album}" -> device [${verifLabel}, ${result.sizeMB} MB]`);
    } else {
      job.status = 'error';
      const stderrMsg = stderr.trim().slice(-400);
      job.error  = (result && result.error)
        || (exitCode !== 0 ? (stderrMsg || `Script exited with code ${exitCode}`) : null)
        || (stderrMsg ? `Exit 0 but no output — stderr: ${stderrMsg}` : 'Script exited cleanly but wrote no output');
      console.error(`Push job ${jobId} error:`, job.error);
    }
  });
});

// POST /api/device/push-batch
// Body: { albums: [{ sourcePath, artist, album }, …] }
// Queues multiple albums for sequential push.
router.post('/push-batch', validateBody(DevicePushBatchBody), (req, res) => {
  const { albums } = req.body;
  const batchId = _pushIdCounter++;

  // Create a job entry for each album up front so the UI can track them.
  // Reject any path that doesn't resolve under LIBRARY_PATH or INBOX_PATH.
  const batchJobs = [];
  for (const { sourcePath: suppliedPath, artist, album, force } of albums) {
    if (!suppliedPath || !artist || !album) continue;
    const sourcePath = resolveUnder(suppliedPath, [config.LIBRARY_PATH, config.INBOX_PATH]);
    if (!sourcePath || !fs.existsSync(sourcePath)) continue;
    const jobId = _pushIdCounter++;
    const job = {
      id: jobId,
      batchId,
      artist,
      album,
      sourcePath,
      status: 'queued',
      startedAt: new Date().toISOString(),
    };
    pushJobs.push(job);
    if (pushJobs.length > 200) pushJobs.splice(0, pushJobs.length - 200);
    batchJobs.push({ job, sourcePath, artist, album, force });
  }

  res.json({ ok: true, batchId, total: batchJobs.length, message: `Queued ${batchJobs.length} album(s) for sync` });

  // Run sequentially in background, updating job status as each completes
  (async () => {
    let skipped = 0;
    for (const { job, sourcePath, artist, album, force } of batchJobs) {
      // Skip albums already on the device (unless force flag set)
      if (!force && isAlreadyOnDevice(artist, album)) {
        console.log(`Batch push: skipping "${artist} — ${album}" (already on device)`);
        job.status = 'done';
        job.skipped = true;
        job.finishedAt = new Date().toISOString();
        skipped++;
        continue;
      }

      job.status = 'running';
      const scriptPath = path.join(SCRIPTS_DIR, 'push-to-device.ps1');

      // Use a temp OutFile so the script writes structured JSON to disk (avoids stdout encoding issues)
      const pushOutFile = path.join(config.CACHE_DIR, `push-result-${job.id}.json`);
      fs.mkdirSync(config.CACHE_DIR, { recursive: true });

      // Use spawn() with -Command mode (same as single push) — avoids cmd.exe space-splitting
      // that breaks single-quoted paths when exec() is used with -File mode.
      const esc = s => s.replace(/'/g, "''");
      const psCmd = `& '${esc(scriptPath)}' -SourcePath '${esc(sourcePath)}' -Artist '${esc(artist || '_')}' -Album '${esc(album)}' -OutFile '${esc(pushOutFile)}'`;
      const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd];

      await new Promise((resolve) => {
        const stdoutChunks = [];
        const stderrChunks = [];
        const ps = spawn('powershell.exe', psArgs, { windowsHide: true });
        ps.stdout.on('data', d => stdoutChunks.push(d));
        ps.stderr.on('data', d => stderrChunks.push(d));

        // Safety timeout: BATCH_PUSH_TIMEOUT_MS per album.
        const killTimer = setTimeout(() => {
          ps.kill();
          job.status = 'error';
          job.error  = `Push timed out after ${Math.round(BATCH_PUSH_TIMEOUT_MS / 60000)} minutes`;
          resolve();
        }, BATCH_PUSH_TIMEOUT_MS);

        ps.on('close', exitCode => {
          clearTimeout(killTimer);
          job.finishedAt = new Date().toISOString();
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          const stderr = Buffer.concat(stderrChunks).toString('utf8');
          // Try to read result from OutFile
          let result = null;
          try {
            if (fs.existsSync(pushOutFile)) {
              const raw = fs.readFileSync(pushOutFile, 'utf8').replace(/^﻿/, '').trim();
              result = JSON.parse(raw);
              if (Array.isArray(result)) result = result[0];
            }
          } catch (_) {}
          try { fs.unlinkSync(pushOutFile); } catch (_) {}

          // Fallback: scan stdout for JSON line
          if (!result) {
            const lines = stdout.replace(/^﻿/, '').trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              const l = lines[i].trim();
              if (l.startsWith('{')) { try { result = JSON.parse(l); break; } catch (_) {} }
            }
          }

          if (result && result.ok) {
            job.status = 'done';
            const recordedTracks = Number.isFinite(result.tracksOnDevice)
              ? result.tracksOnDevice
              : result.tracks;
            job.tracks         = result.tracks;
            job.tracksOnDevice = recordedTracks;
            job.sizeMB         = result.sizeMB;
            job.verified       = result.verified !== false;
            if (result.warning) job.warning = result.warning;
            try { recordPush(artist, album, recordedTracks, result.sizeMB); } catch (_) {}
            try {
              db.logActivity('push', 'pushed', `${artist} — ${album}`, {
                tracks:         result.tracks,
                tracksOnDevice: recordedTracks,
                verified:       job.verified,
                sizeMB:         result.sizeMB,
                warning:        result.warning || null,
                batch:          true,
              });
            } catch (_) {}
            const verifLabel = job.verified ? 'verified' : `PARTIAL ${recordedTracks}/${result.tracks}`;
            console.log(`Batch push OK: ${artist} — ${album} [${verifLabel}, ${result.sizeMB} MB]`);
          } else {
            job.status = 'error';
            const stderrMsg = stderr.trim().slice(-400);
            job.error = (result && result.error)
              || (exitCode !== 0 ? (stderrMsg || `Script exited with code ${exitCode}`) : null)
              || (stderrMsg ? `Exit 0 but no output — stderr: ${stderrMsg}` : 'Script exited cleanly but wrote no output');
            console.error(`Batch push failed for ${artist} — ${album}:`, job.error);
          }
          resolve();
        });
      });
    }
    if (skipped > 0) console.log(`Batch push: ${skipped} album(s) already on device — skipped.`);
  })().catch(e => console.error('Batch push error:', e.message));
});

module.exports = router;
module.exports.getStatus      = getStatus;
module.exports.getCachedAlbums = getCachedAlbums;
