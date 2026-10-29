// ── HiBy Hub — Smoke Test ────────────────────────────────────────────────────
// Run from the project folder: node smoke-test.js
const http = require('http');

const BASE = 'http://localhost:3847';
let pass = 0, fail = 0;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, data: body.slice(0, 120) }); }
      });
    }).on('error', reject);
  });
}

async function check(label, path, assert) {
  try {
    const r = await get(path);
    const ok = assert(r);
    if (ok) {
      console.log('  ✓', label);
      pass++;
    } else {
      console.log('  ✗', label, '— unexpected response:', JSON.stringify(r.data).slice(0, 100));
      fail++;
    }
  } catch (e) {
    console.log('  ✗', label, '— ERROR:', e.message);
    fail++;
  }
}

(async () => {
  console.log('\n── HiBy Hub Smoke Test ──────────────────────────────\n');

  console.log('Core:');
  await check('GET /api/status',          '/api/status',          r => r.status === 200 && r.data.serverVersion);
  await check('GET /api/library',         '/api/library',         r => r.status === 200);
  await check('GET /api/inbox',           '/api/inbox',           r => r.status === 200);

  console.log('\nHealth:');
  await check('GET /api/health/folders',  '/api/health/folders',  r => r.status === 200 && Array.isArray(r.data.issues));
  await check('GET /api/stats',           '/api/stats',           r => r.status === 200);

  console.log('\nSync:');
  await check('GET /api/sync/backlog',    '/api/sync/backlog',    r => r.status === 200 && Array.isArray(r.data.backlog));
  await check('GET /api/sync/space-plan', '/api/sync/space-plan', r => r.status === 200 && Array.isArray(r.data.albums));
  await check('GET /api/sync/upgrades',   '/api/sync/upgrades',   r => r.status === 200);

  console.log('\nLibrary:');
  await check('GET /api/library/albums',  '/api/library/albums',  r => r.status === 200 && Array.isArray(r.data.albums));
  await check('GET /api/library/duplicates', '/api/library/duplicates', r => r.status === 200);

  console.log('\nWishlist:');
  await check('GET /api/wishlist',        '/api/wishlist',        r => r.status === 200 && Array.isArray(r.data.items));

  console.log('\nLast.fm:');
  await check('GET /api/lastfm/config',   '/api/lastfm/config',   r => r.status === 200 && !!r.data.username && r.data.hasApiKey === true);
  await check('GET /api/lastfm/recent',   '/api/lastfm/recent',   r => r.status === 200 && Array.isArray(r.data.tracks));

  console.log('\nReplayGain:');
  await check('GET /api/replaygain/scan (no wait)', '/api/replaygain/scan', r => r.status === 200 || r.data.message);

  console.log('\nCover Art:');
  await check('GET /api/coverart/missing', '/api/coverart/missing', r => r.status === 200);

  console.log('\nPlaylist:');
  await check('GET /api/playlist/list',   '/api/playlist/list',   r => r.status === 200);
  await check('GET /api/playlist/filters','/api/playlist/filters', r => r.status === 200);

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  ${pass} passed  ${fail} failed\n`);
  if (fail === 0) console.log('  All good — Hub is healthy ✓\n');
  else console.log('  Some checks failed — see above ✗\n');
})();
