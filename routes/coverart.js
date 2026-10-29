'use strict';
// ── Cover Art route — finds missing artwork, fetches from Cover Art Archive ──
const express      = require('express');
const router       = express.Router();
const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const http         = require('http');
const config       = require('../config');
const libraryRoute = require('./library');
const { resolveUnder } = require('../lib/safePath');

const COVER_NAMES  = ['cover.jpg','cover.jpeg','cover.png','folder.jpg','folder.png','front.jpg','albumart.jpg'];
const MB_BASE      = 'https://musicbrainz.org/ws/2';
const CAA_BASE     = 'https://coverartarchive.org';
const ITUNES_BASE  = 'https://itunes.apple.com';
const USER_AGENT   = 'HiByHub/1.0 (music manager; https://github.com)';

let _lastMbRequest = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Follow HTTP redirects and return a Buffer
function fetchBuffer(url, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        fetchBuffer(next, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// MB rate-limit: ≥1100ms between requests
async function mbGet(url) {
  const wait = 1100 - (Date.now() - _lastMbRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastMbRequest = Date.now();
  const buf  = await fetchBuffer(url);
  return JSON.parse(buf.toString('utf8'));
}

async function hasCover(albumPath) {
  for (const n of COVER_NAMES) {
    try { await fs.promises.access(path.join(albumPath, n)); return true; } catch (_) {}
  }
  return false;
}

// Find the first cover-art file inside an album folder. Returns absolute path
// or null. Synchronous because we only check 7 names against a single folder.
function findCoverInFolder(folderPath) {
  for (const name of COVER_NAMES) {
    const candidate = path.join(folderPath, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; }
    catch (_) {}
  }
  return null;
}

const MIME_BY_EXT = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/coverart/serve?path=<albumPath>
// Streams cover.jpg / cover.png / folder.jpg / etc. from an album folder.
// 404 with a tiny inline SVG fallback if no cover is found, so <img> tags
// can render something gracefully without an extra round-trip.
const ROOTS_FOR_SERVE = [config.LIBRARY_PATH, config.INBOX_PATH].filter(Boolean);
router.get('/serve', (req, res) => {
  const folderPath = resolveUnder(req.query.path, ROOTS_FOR_SERVE);
  if (!folderPath) return res.status(400).end();

  const cover = findCoverInFolder(folderPath);
  if (!cover) {
    // 404 with a tiny SVG placeholder. Stays cacheable so the browser doesn't
    // re-ask for the same missing folder on every grid render.
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(404).send(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" fill="#1e2330"/>' +
      '<text x="50" y="55" font-family="sans-serif" font-size="36" fill="#475569" text-anchor="middle">♪</text>' +
      '</svg>'
    );
  }

  let stat;
  try { stat = fs.statSync(cover); }
  catch (_) { return res.status(404).end(); }

  // ETag based on mtime + size — cheap and changes when the file changes.
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  const mime = MIME_BY_EXT[path.extname(cover).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type',  mime);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('ETag',           etag);
  res.setHeader('Cache-Control',  'public, max-age=86400');
  fs.createReadStream(cover).pipe(res);
});

// GET /api/coverart/missing — albums in library without cover art
router.get('/missing', async (req, res) => {
  const libData = libraryRoute.getCache();
  if (!libData || !libData.albums) {
    return res.json({ ok: false, items: [], count: 0, message: 'Run a library scan first.' });
  }

  const items = [];
  for (const album of libData.albums) {
    if (!album.path) continue;
    if (!await hasCover(album.path)) {
      items.push({
        name:   album.name,
        artist: album.artist || '',
        key:    album.key,
        path:   album.path,
        tracks: album.tracks || 0,
      });
    }
  }

  res.json({ ok: true, items, count: items.length, total: libData.albums.length });
});

// POST /api/coverart/search — search MusicBrainz for a release, return candidates
router.post('/search', async (req, res) => {
  const { artist, album } = req.body || {};
  if (!artist && !album) return res.status(400).json({ error: 'artist or album required' });

  try {
    const q   = encodeURIComponent(`release:"${album || ''}" AND artist:"${artist || ''}"`);
    const url = `${MB_BASE}/release/?query=${q}&limit=5&fmt=json`;
    const data = await mbGet(url);

    const candidates = (data.releases || []).slice(0, 5).map(r => ({
      mbid:        r.id,
      title:       r.title,
      artist:      (r['artist-credit'] || []).map(a => a.name || '').join(' '),
      year:        r.date ? r.date.slice(0, 4) : '',
      score:       r.score || 0,
      thumbUrl:    `${CAA_BASE}/release/${r.id}/front-250`,
    }));

    res.json({ ok: true, candidates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/coverart/fetch — download cover.jpg for one album
// Body: { albumPath, mbid }
router.post('/fetch', async (req, res) => {
  const { albumPath, mbid } = req.body || {};
  if (!albumPath) return res.status(400).json({ error: 'albumPath required' });
  if (!mbid)      return res.status(400).json({ error: 'mbid required' });
  if (!fs.existsSync(albumPath)) return res.status(400).json({ error: 'albumPath not found' });

  try {
    const imgBuf  = await fetchBuffer(`${CAA_BASE}/release/${mbid}/front`);
    const outPath = path.join(albumPath, 'cover.jpg');
    fs.writeFileSync(outPath, imgBuf);
    res.json({ ok: true, path: outPath, sizeKB: Math.round(imgBuf.length / 1024) });
  } catch (e) {
    // Try release-group if release-level fails
    try {
      // Look up release-group id from the release
      const rData  = await mbGet(`${MB_BASE}/release/${mbid}?inc=release-groups&fmt=json`);
      const rgid   = rData['release-group'] && rData['release-group'].id;
      if (!rgid) throw new Error('No release-group found');
      const imgBuf  = await fetchBuffer(`${CAA_BASE}/release-group/${rgid}/front`);
      const outPath = path.join(albumPath, 'cover.jpg');
      fs.writeFileSync(outPath, imgBuf);
      res.json({ ok: true, path: outPath, sizeKB: Math.round(imgBuf.length / 1024), via: 'release-group' });
    } catch (e2) {
      res.status(500).json({ error: e.message + ' / ' + e2.message });
    }
  }
});

// POST /api/coverart/auto-fetch — auto-search + fetch for one album (no MBID needed)
// Body: { albumPath, artist, album }
// Strategy: try artist+album, then album-only, then release-group fallback
router.post('/auto-fetch', async (req, res) => {
  const { albumPath, artist, album } = req.body || {};
  if (!albumPath) return res.status(400).json({ error: 'albumPath required' });
  if (!fs.existsSync(albumPath)) return res.status(400).json({ error: 'albumPath not found' });

  // Strip scene/torrent junk from folder names
  // e.g. "Kendrick Lamar-GNX-PROPER-24BIT-WEB-FLAC-2024-BiKO" → { artist:"Kendrick Lamar", album:"GNX" }
  // e.g. "Joy Crookes - Juniper (Deluxe) (2025) [WEB FLAC]"   → { artist:"Joy Crookes", album:"Juniper (Deluxe)" }
  function parseFolder(name) {
    let s = (name || '').trim();

    // Strip leading year like (2019) or [2019]
    s = s.replace(/^[\[(]\d{4}[\])]\s*[-–—]?\s*/, '');

    // Strip trailing scene tags: -WEB-2025-GRP, [WEB FLAC], (FLAC), [24BIT], etc.
    s = s.replace(/[\s\-_]+(PROPER|LIMITED|REMASTERED|DELUXE EDITION|WEB|CDM|CD|VINYL|LP|EP|OST|FLAC|MP3|AAC|OGG|24BIT|16BIT|320|256|192|128|WEB[\s-]FLAC|CD[\s-]FLAC)[\s\-_\w]*/gi, '');
    s = s.replace(/\s*[\[(][^\])]*(FLAC|MP3|WEB|CDM|24BIT|320|kbps|lossless|remaster)[^\])]*[\])]$/gi, '');
    // Strip trailing year (2025)
    s = s.replace(/\s*[\[(]\d{4}[\])]\s*$/, '').trim();
    // Strip trailing dashes or underscores
    s = s.replace(/[\s\-_]+$/, '').trim();

    // Check for "Artist - Album" separator (dash with spaces, or em-dash)
    const sep = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (sep) {
      return { artist: sep[1].trim(), album: sep[2].trim() };
    }

    return { artist: null, album: s };
  }

  // Is this string a Soulseek-style username? (short word + optional digits, no spaces)
  function isSoulseekUser(s) {
    return !s || /^[\w]{2,20}\d*$/i.test(s.trim()) && !s.includes(' ');
  }

  async function tryFetchCover(mbid) {
    try {
      return await fetchBuffer(`${CAA_BASE}/release/${mbid}/front`);
    } catch (_) {
      const rData = await mbGet(`${MB_BASE}/release/${mbid}?inc=release-groups&fmt=json`);
      const rgid  = rData['release-group'] && rData['release-group'].id;
      if (!rgid) throw new Error('No cover art in CAA');
      return await fetchBuffer(`${CAA_BASE}/release-group/${rgid}/front`);
    }
  }

  const parsed     = parseFolder(album);
  const cleanAlbum = parsed.album;
  // Use parsed artist if library artist looks like a username
  const realArtist = isSoulseekUser(artist) ? parsed.artist : (artist || parsed.artist);

  // Build query list — most specific first
  const queries = [];
  if (realArtist) {
    queries.push(`release:"${cleanAlbum}" AND artist:"${realArtist}"`);
  }
  queries.push(`release:"${cleanAlbum}"`);
  // If parsed album differs from raw, also try raw cleaned
  if (cleanAlbum !== (album || '').trim()) {
    const raw = (album || '').replace(/\s*[\[(][^\])]*[\])]\s*/g, '').trim();
    if (raw && raw !== cleanAlbum) queries.push(`release:"${raw}"`);
  }

  let lastError = 'No match found';
  for (const q of queries) {
    try {
      const data = await mbGet(`${MB_BASE}/release/?query=${encodeURIComponent(q)}&limit=3&fmt=json`);
      const rel  = (data.releases || []).find(r => r.score >= 40);
      if (!rel) continue;
      const imgBuf  = await tryFetchCover(rel.id);
      const outPath = path.join(albumPath, 'cover.jpg');
      fs.writeFileSync(outPath, imgBuf);
      return res.json({ ok: true, path: outPath, sizeKB: Math.round(imgBuf.length / 1024), mbid: rel.id, matchTitle: rel.title, source: 'musicbrainz' });
    } catch (e) {
      lastError = e.message;
    }
  }

  // ── iTunes fallback ────────────────────────────────────────────────────────
  // Great coverage for popular music; free public API, no auth needed
  try {
    const itunesQueries = [];
    if (realArtist) itunesQueries.push(`${realArtist} ${cleanAlbum}`);
    itunesQueries.push(cleanAlbum);

    for (const term of itunesQueries) {
      const qs   = new URLSearchParams({ term, entity: 'album', media: 'music', limit: '1' });
      const buf  = await fetchBuffer(`${ITUNES_BASE}/search?${qs}`);
      const data = JSON.parse(buf.toString('utf8'));
      const result = (data.results || [])[0];
      if (!result || !result.artworkUrl100) continue;

      // Scale up from 100x100 to 600x600
      const artUrl  = result.artworkUrl100.replace('100x100bb', '600x600bb');
      const imgBuf  = await fetchBuffer(artUrl);
      const outPath = path.join(albumPath, 'cover.jpg');
      fs.writeFileSync(outPath, imgBuf);
      return res.json({ ok: true, path: outPath, sizeKB: Math.round(imgBuf.length / 1024), matchTitle: result.collectionName, source: 'itunes' });
    }
  } catch (e) {
    lastError = e.message;
  }

  res.status(404).json({ error: lastError });
});

module.exports = router;
