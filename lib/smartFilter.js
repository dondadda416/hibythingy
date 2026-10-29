'use strict';
// ── lib/smartFilter.js ───────────────────────────────────────────────────────
// Apply a smart-playlist filter spec to a list of albums (the library cache
// shape from db.js). The spec is a JSON object — see SmartPlaylistDefinition
// in lib/schemas.js. Pure function, no I/O — easy to test.
//
// Filter shape:
//   {
//     search:         "...",                    // text contains across name/artist
//     artist:         "Pink Floyd" | ["A","B"], // exact match (any of, OR-style)
//     format:         ["FLAC","DSF"],           // detected via name (lossless > lossy)
//     decadeFrom:     1990,
//     decadeTo:       2020,                     // inclusive
//     addedAfterDays: 30,                       // recency: addedAt >= now - N days
//     addedBefore:    1700000000000,            // ms epoch
//     minTracks:      5,
//     maxTracks:      20,
//     sort:           "name" | "artist" | "addedDesc" | "addedAsc" | "tracksDesc",
//     limit:          100,
//     shuffle:        false,
//   }

const FORMAT_RX = [
  ['FLAC',  /\bflac\b/i],
  ['DSD',   /\b(?:dsf|dff|dsd)\b/i],
  ['WAV',   /\bwav\b/i],
  ['Opus',  /\bopus\b/i],
  ['AAC',   /\b(?:aac|m4a)\b/i],
  ['OGG',   /\bogg\b/i],
  ['MP3',   /\bmp3\b/i],
];

// Best-effort format detection from the album name. Cheaper than reading the
// folder; good enough for the smart-playlist filter UI. If detection fails,
// returns ''.
function detectFormat(album) {
  const name = (album && album.name) || '';
  for (const [label, rx] of FORMAT_RX) {
    if (rx.test(name)) return label;
  }
  return '';
}

function detectYear(album) {
  const m = ((album && album.name) || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function _arr(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v : null;
  return [v];
}

function applySmartFilter(albums, spec = {}) {
  if (!Array.isArray(albums)) return [];
  let out = albums.slice();

  // ── Filter ────────────────────────────────────────────────────────────────
  if (spec.search) {
    const q = String(spec.search).toLowerCase();
    out = out.filter(a =>
      (a.name   || '').toLowerCase().includes(q) ||
      (a.artist || '').toLowerCase().includes(q) ||
      (a.key    || '').toLowerCase().includes(q)
    );
  }

  const artists = _arr(spec.artist);
  if (artists) {
    const set = new Set(artists.map(s => String(s).toLowerCase()));
    out = out.filter(a => set.has(String(a.artist || '').toLowerCase()));
  }

  const formats = _arr(spec.format);
  if (formats) {
    const set = new Set(formats.map(s => String(s).toUpperCase()));
    out = out.filter(a => set.has(detectFormat(a).toUpperCase()));
  }

  if (Number.isFinite(spec.decadeFrom) || Number.isFinite(spec.decadeTo)) {
    const from = Number.isFinite(spec.decadeFrom) ? spec.decadeFrom : -Infinity;
    const to   = Number.isFinite(spec.decadeTo)   ? spec.decadeTo   :  Infinity;
    out = out.filter(a => {
      const y = detectYear(a);
      return y != null && y >= from && y <= to;
    });
  }

  if (Number.isFinite(spec.addedAfterDays) && spec.addedAfterDays > 0) {
    const cutoff = Date.now() - spec.addedAfterDays * 24 * 60 * 60 * 1000;
    out = out.filter(a => (a.addedAt || 0) >= cutoff);
  }

  if (Number.isFinite(spec.addedBefore)) {
    out = out.filter(a => (a.addedAt || 0) < spec.addedBefore);
  }

  if (Number.isFinite(spec.minTracks)) out = out.filter(a => (a.tracks || 0) >= spec.minTracks);
  if (Number.isFinite(spec.maxTracks)) out = out.filter(a => (a.tracks || 0) <= spec.maxTracks);

  // ── Sort ──────────────────────────────────────────────────────────────────
  if (spec.shuffle) {
    // Fisher–Yates so we don't bias toward the start of the list.
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  } else {
    switch (spec.sort) {
      case 'artist':     out.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.name || '').localeCompare(b.name || '')); break;
      case 'addedDesc':  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); break;
      case 'addedAsc':   out.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)); break;
      case 'tracksDesc': out.sort((a, b) => (b.tracks  || 0) - (a.tracks  || 0)); break;
      case 'name':
      default:           out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
  }

  if (Number.isFinite(spec.limit) && spec.limit > 0) out = out.slice(0, spec.limit);
  return out;
}

module.exports = { applySmartFilter, detectFormat, detectYear };
