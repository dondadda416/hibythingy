// ── Software route — launch registered apps ───────────────────────────────────
'use strict';
const express = require('express');
const router  = express.Router();
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const { validateBody } = require('../lib/validate');
const { SoftwareLaunchBody } = require('../lib/schemas');
const { requireWindows } = require('../lib/platform');

// .exe launchers + .lnk shortcuts only make sense on Windows. The GET handler
// is read-only (just inspects which exe paths exist) so we leave it open;
// only the launchers are gated.

// Find the first existing path from a list of candidates
function resolveExe(exePaths) {
  for (const p of (exePaths || [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Find a .lnk shortcut inside a Start Menu folder
function resolveShortcut(shortcutDir) {
  if (!shortcutDir || !fs.existsSync(shortcutDir)) return null;
  try {
    const files = fs.readdirSync(shortcutDir);
    const lnk = files.find(f => f.endsWith('.lnk'));
    return lnk ? path.join(shortcutDir, lnk) : null;
  } catch (_) { return null; }
}

// Launch a process detached so the parent doesn't block. Args are passed as an
// array so the OS does no shell interpretation — closes the command-injection
// vector that existed when this used `exec(string, {shell:true})`.
function launchDetached(file, args) {
  const child = spawn(file, args, {
    windowsHide: true,
    detached:    true,
    stdio:       'ignore',
  });
  child.on('error', err => console.warn('[software] spawn error:', err.message));
  child.unref();
}

// Launch a registered app, optionally passing a target path/folder.
// targetPath, when supplied, must be an existing absolute path — we never let
// arbitrary user strings through to the shell.
function launch(appKey, targetPath) {
  const app = config.SOFTWARE[appKey];
  if (!app) return { ok: false, error: `Unknown app key: "${appKey}"` };

  // Reject anything that doesn't look like a real existing path.
  let safeTarget = null;
  if (typeof targetPath === 'string' && targetPath.length) {
    if (targetPath.includes('\0')) return { ok: false, error: 'Invalid target path' };
    if (fs.existsSync(targetPath)) safeTarget = path.resolve(targetPath);
  }

  // 1. Try direct .exe
  const exe = resolveExe(app.exePaths);
  if (exe) {
    const args = safeTarget ? [safeTarget] : [];
    try { launchDetached(exe, args); }
    catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, app: app.name, method: 'exe', path: exe };
  }

  // 2. Try .lnk shortcut in Start Menu folder — open via cmd /c start so the
  //    .lnk is resolved by the shell, but no user input is concatenated in.
  const lnk = resolveShortcut(app.shortcutDir);
  if (lnk) {
    try { launchDetached('cmd.exe', ['/c', 'start', '', lnk]); }
    catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, app: app.name, method: 'shortcut', path: lnk };
  }

  // 3. Last resort: ask Windows to find it by app.name (a config-only value).
  try { launchDetached('cmd.exe', ['/c', 'start', '', app.name]); }
  catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, app: app.name, method: 'name-lookup' };
}

// GET /api/software — list all registered apps and whether their exe was found
router.get('/', (req, res) => {
  const apps = Object.entries(config.SOFTWARE).map(([key, app]) => {
    const exe = resolveExe(app.exePaths);
    const lnk = resolveShortcut(app.shortcutDir);
    return {
      key,
      name:      app.name,
      found:     !!(exe || lnk),
      exePath:   exe || null,
      lnkPath:   lnk || null,
    };
  });
  res.json({ apps });
});

// POST /api/software/launch/:app — launch an app
// Optional body: { targetPath: "C:\\path\\to\\folder" }
router.post('/launch/:app', requireWindows('App launching'), validateBody(SoftwareLaunchBody), (req, res) => {
  const { app }        = req.params;
  const { targetPath } = req.body;
  res.json(launch(app, targetPath));
});

// POST /api/software/launch-inbox/:app — launch an app with the inbox folder as target
router.post('/launch-inbox/:app', requireWindows('App launching'), (req, res) => {
  res.json(launch(req.params.app, config.INBOX_PATH));
});

module.exports = router;
