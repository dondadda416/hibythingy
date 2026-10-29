'use strict';
// ── lib/platform.js ──────────────────────────────────────────────────────────
// Tiny platform detection + middleware for routes that hard-depend on Windows
// (PowerShell + MTP, .exe launchers). On non-Windows hosts the app still boots
// — those routes just return 503 with a helpful message.

const isWindows = process.platform === 'win32';
const isMacOS   = process.platform === 'darwin';
const isLinux   = process.platform === 'linux';

function platformLabel() {
  if (isWindows) return 'Windows';
  if (isMacOS)   return 'macOS';
  if (isLinux)   return 'Linux';
  return process.platform;
}

// Express middleware: gate a route behind a Windows-only dependency.
function requireWindows(featureName = 'this feature') {
  return (req, res, next) => {
    if (isWindows) return next();
    res.status(503).json({
      error: `${featureName} is Windows-only`,
      detail: `HiBy Hub uses PowerShell + Windows MTP for device control and .exe launchers for the Software tab. Running on ${platformLabel()}; this endpoint is disabled.`,
      platform: platformLabel(),
    });
  };
}

module.exports = { isWindows, isMacOS, isLinux, platformLabel, requireWindows };
