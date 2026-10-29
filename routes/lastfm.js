'use strict';
// ── Last.fm route — compare listening history against local library ───────────
const express      = require('express');
const router       = express.Router();
const https        = require('https');
const config       = require('../config');
const libraryRoute = require('./library');
const normalise    = require('../lib/normalise');

const API_KEY  = config.LASTFM_API_KEY  || '';
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lfmGet(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      ...params,
      api_key: API_KEY,
      format:  'json',
    }).toString();

    const url = BASE_URL + '?' + qs;
    https.get(url, { headers: { 'User-Agent': 'HiByHub/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON from Last.fm')); }
      });
    }).on('error', reject);
  });
}

// Fetch ALL top albums (paginates automatically up to maxPages)
async function fetchTopAlbums(username, period, limit = 500) {
  const pageSize = 200;
  const maxPages = Math.ceil(limit / pageSize);
  const albums   = [];

  for (let page = 1; page <= maxPages; page++) {
    const data = await lfmGet({
      method:   'user.gettopalbums',
      user:     username,
      period,
      limit:    pageSize,
      page,
    });

    if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);

    const items = (data.topalbums && data.topalbums.album) || [];
    if (items.length === 0) break;

    for (const a of items) {
      albums.push({
        name:      a.name   || '',
        artist:    (a.artist && a.artist.name) || '',
        playcount: parseInt(a.playcount, 10) || 0,
        url:       a.url || '',
        image:     (a.image && a.image.find(i => i.size === 'medium')?.['#text']) || '',
        rank:      parseInt((a['@attr'] && a['@attr'].rank) || 0, 10),
      });
    }

    // Stop early if Last.fm returned fewer than a full page
    if (items.length < pageSize) break;
    if (albums.length >= limit)  break;
  }

  return albums.slice(0, limit);
}

// Cross-reference Last.fm albums against library
function crossReference(lfmAlbums, libData) {
  if (!libData || !libData.albums) return { inLibrary: [], missing: [] };

  // Build normalised lib set: norm(key) → album entry
  const libMap = new Map();
  for (const a of libData.albums) {
    // Index by album name alone
    libMap.set(normalise(a.name  || ''), a);
    // Also by "Artist — Album" key
    libMap.set(normalise(a.key   || ''), a);
    // And by just the album part of a compound key
    if (a.key && a.key.includes(' — ')) {
      libMap.set(normalise(a.key.split(' — ').slice(1).join(' — ')), a);
    }
  }

  const inLibrary = [];
  const missing   = [];

  for (const lfm of lfmAlbums) {
    const normName   = normalise(lfm.name);
    const normFull   = normalise(`${lfm.artist} ${lfm.name}`);
    const normHyphen = normalise(`${lfm.artist} — ${lfm.name}`);

    const match = libMap.get(normName)
               || libMap.get(normFull)
               || libMap.get(normHyphen)
               || null;

    if (match) {
      inLibrary.push({ ...lfm, libraryPath: match.path || '' });
    } else {
      missing.push(lfm);
    }
  }

  return { inLibrary, missing };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/lastfm/config — return current config values for the UI
router.get('/config', (req, res) => {
  res.json({
    username:  config.LASTFM_USERNAME || '',
    hasApiKey: !!API_KEY,
  });
});

// GET /api/lastfm/top-albums
// ?username=X  (overrides config default)
// ?period=overall|12month|6month|3month|1month  (default: overall)
// ?limit=200  (default: 200, max: 500)
router.get('/top-albums', async (req, res) => {
  if (!API_KEY) {
    return res.status(400).json({ error: 'No Last.fm API key configured. Add LASTFM_API_KEY to config.js.' });
  }

  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username provided' });

  const period  = req.query.period || 'overall';
  const limit   = Math.min(500, parseInt(req.query.limit, 10) || 200);

  const VALID_PERIODS = ['overall', '12month', '6month', '3month', '1month', '7day'];
  if (!VALID_PERIODS.includes(period)) {
    return res.status(400).json({ error: 'Invalid period. Use: ' + VALID_PERIODS.join(', ') });
  }

  try {
    const lfmAlbums = await fetchTopAlbums(username, period, limit);
    const libData   = libraryRoute.getCache();
    const { inLibrary, missing } = crossReference(lfmAlbums, libData);

    const totalPlays      = lfmAlbums.reduce((s, a) => s + a.playcount, 0);
    const libraryPlays    = inLibrary.reduce((s, a) => s + a.playcount, 0);
    const coveragePct     = lfmAlbums.length > 0
      ? Math.round(inLibrary.length / lfmAlbums.length * 100)
      : 0;

    res.json({
      ok:         true,
      username,
      period,
      totalFetched:  lfmAlbums.length,
      inLibraryCount: inLibrary.length,
      missingCount:   missing.length,
      coveragePct,
      totalPlays,
      libraryPlays,
      missingPlays:   totalPlays - libraryPlays,
      inLibrary,
      missing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lastfm/stats — user profile info (total plays, counts, registration date)
router.get('/stats', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'No API key configured' });
  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username' });
  try {
    const data = await lfmGet({ method: 'user.getinfo', user: username });
    if (data.error) return res.status(400).json({ error: data.message });
    const u = data.user || {};
    res.json({
      ok:          true,
      username,
      playcount:   parseInt(u.playcount,     10) || 0,
      artistCount: parseInt(u.artist_count,  10) || 0,
      trackCount:  parseInt(u.track_count,   10) || 0,
      albumCount:  parseInt(u.album_count,   10) || 0,
      country:     u.country || '',
      registered:  u.registered ? parseInt(u.registered.unixtime, 10) * 1000 : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lastfm/top-tracks
// ?username=X  ?period=overall|12month|…  ?limit=50
router.get('/top-tracks', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'No API key configured' });
  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username' });
  const period = req.query.period || 'overall';
  const limit  = Math.min(200, parseInt(req.query.limit, 10) || 50);
  try {
    const data = await lfmGet({ method: 'user.gettoptracks', user: username, period, limit });
    if (data.error) return res.status(400).json({ error: data.message });
    const tracks = ((data.toptracks && data.toptracks.track) || []).map(t => ({
      title:     t.name || '',
      artist:    (t.artist && t.artist.name) || '',
      playcount: parseInt(t.playcount, 10) || 0,
      rank:      parseInt((t['@attr'] && t['@attr'].rank) || 0, 10),
    }));
    res.json({ ok: true, username, period, tracks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lastfm/top-artists
// ?username=X  ?period=overall|12month|…  ?limit=50
router.get('/top-artists', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'No API key configured' });
  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username' });
  const period = req.query.period || 'overall';
  const limit  = Math.min(200, parseInt(req.query.limit, 10) || 50);
  try {
    const data = await lfmGet({ method: 'user.gettopartists', user: username, period, limit });
    if (data.error) return res.status(400).json({ error: data.message });
    const artists = ((data.topartists && data.topartists.artist) || []).map(a => ({
      name:      a.name || '',
      playcount: parseInt(a.playcount, 10) || 0,
      rank:      parseInt((a['@attr'] && a['@attr'].rank) || 0, 10),
    }));
    res.json({ ok: true, username, period, artists });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lastfm/activity — weekly scrobble counts for the last N weeks
// ?username=X  ?weeks=12
router.get('/activity', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'No API key configured' });
  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username' });
  const weeks  = Math.min(26, parseInt(req.query.weeks, 10) || 12);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const fromTs = Math.floor((Date.now() - weeks * weekMs) / 1000);

  try {
    const allTs = [];
    for (let page = 1; page <= 6; page++) {
      const data = await lfmGet({ method: 'user.getrecenttracks', user: username, limit: 200, page, from: fromTs });
      if (data.error) break;
      const tracks = ((data.recenttracks && data.recenttracks.track) || [])
        .filter(t => t.date)
        .map(t => parseInt(t.date.uts, 10) * 1000);
      allTs.push(...tracks);
      const totalPages = parseInt((data.recenttracks && data.recenttracks['@attr'] && data.recenttracks['@attr'].totalPages) || '1', 10);
      if (page >= totalPages || tracks.length < 200) break;
    }

    const now = Date.now();
    const weekData = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const wStart = now - (i + 1) * weekMs;
      const wEnd   = now - i * weekMs;
      const label  = new Date(wStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      weekData.push({ label, count: allTs.filter(ts => ts >= wStart && ts < wEnd).length });
    }
    res.json({ ok: true, username, weekData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/lastfm/recent
// ?username=X  ?limit=50
// Returns recently listened tracks (for live "now playing" feel)
router.get('/recent', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'No API key configured' });

  const username = (req.query.username || config.LASTFM_USERNAME || '').trim();
  if (!username) return res.status(400).json({ error: 'No username provided' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

  try {
    const data = await lfmGet({ method: 'user.getrecenttracks', user: username, limit });
    // Error 6 = "User not found" — common for brand-new accounts with no scrobbles yet
    if (data.error) {
      if (data.error === 6) return res.json({ ok: true, username, tracks: [], message: 'No scrobbles yet — start listening and they will appear here.' });
      return res.status(400).json({ error: data.message });
    }

    const tracks = ((data.recenttracks && data.recenttracks.track) || []).map(t => ({
      title:     t.name || '',
      artist:    (t.artist && t.artist['#text']) || '',
      album:     (t.album  && t.album['#text'])  || '',
      nowPlaying: !!(t['@attr'] && t['@attr'].nowplaying === 'true'),
      playedAt:  t.date ? parseInt(t.date.uts, 10) * 1000 : null,
      image:     (t.image && t.image.find(i => i.size === 'medium')?.['#text']) || '',
    }));

    res.json({ ok: true, username, tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
