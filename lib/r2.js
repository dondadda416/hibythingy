'use strict';
// ── lib/r2.js ────────────────────────────────────────────────────────────────
// Cloudflare R2 helpers. The library folder on the server is an rclone mount
// of r2:<bucket>/<LIBRARY_PREFIX>, so a file at
//   <LIBRARY_PATH>/Artist/Album/01 Track.flac
// is the object
//   <LIBRARY_PREFIX>/Artist/Album/01 Track.flac
// in the bucket. This module turns library paths into object keys and signs
// short-lived GET links so the R4 can download straight from R2.

const path = require('path');

let _client = null;
let _clientKey = '';

function r2Config(config) {
  return (config && config.R2) || {};
}

function isConfigured(config) {
  const r = r2Config(config);
  return !!(r.ACCOUNT_ID && r.ACCESS_KEY_ID && r.SECRET_ACCESS_KEY && r.BUCKET);
}

function endpointFor(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function getClient(config) {
  const r = r2Config(config);
  const key = [r.ACCOUNT_ID, r.ACCESS_KEY_ID, r.SECRET_ACCESS_KEY, r.ENDPOINT || ''].join('|');
  if (_client && _clientKey === key) return _client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: r.ENDPOINT || endpointFor(r.ACCOUNT_ID),
    credentials: { accessKeyId: r.ACCESS_KEY_ID, secretAccessKey: r.SECRET_ACCESS_KEY },
    // R2 wants path-style or virtual-host; path-style keeps the bucket name
    // out of the hostname, which matters for bucket names with dots.
    forcePathStyle: true,
  });
  _clientKey = key;
  return _client;
}

// Relative library path ("Artist/Album/01.flac", forward slashes) for an
// absolute path under LIBRARY_PATH. Returns null for anything outside it.
function relFromLibrary(config, absPath) {
  if (typeof absPath !== 'string' || !absPath) return null;
  const root = path.resolve(config.LIBRARY_PATH);
  const abs  = path.resolve(absPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep).join('/');
}

// Validate a client-supplied relative library path and return the absolute
// path, or null when it tries to escape the library.
function absFromRel(config, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some(seg => seg === '..')) return null;
  const root = path.resolve(config.LIBRARY_PATH);
  const abs  = path.resolve(root, ...cleaned.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function keyForRel(config, rel) {
  const prefix = r2Config(config).LIBRARY_PREFIX || '';
  return prefix ? `${prefix}/${rel}` : rel;
}

// Signed GET URL for a library-relative path. `filename` (optional) sets the
// Content-Disposition so a browser download keeps the real file name.
async function presignRel(config, rel, opts = {}) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl }     = require('@aws-sdk/s3-request-presigner');
  const r = r2Config(config);
  const params = { Bucket: r.BUCKET, Key: keyForRel(config, rel) };
  if (opts.filename) {
    const ascii = String(opts.filename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    params.ResponseContentDisposition =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.filename)}`;
  }
  const expiresIn = Math.max(60, Math.min(opts.expiresIn || r.LINK_TTL_SECONDS || 21600, 7 * 24 * 3600));
  return getSignedUrl(getClient(config), new GetObjectCommand(params), { expiresIn });
}

module.exports = {
  isConfigured,
  endpointFor,
  relFromLibrary,
  absFromRel,
  keyForRel,
  presignRel,
  // test hook
  _resetClient() { _client = null; _clientKey = ''; },
};
