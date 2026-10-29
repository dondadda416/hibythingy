'use strict';
// Shared audio format detection + ranking helpers
const fs   = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set(['.flac','.mp3','.wav','.aac','.m4a','.ogg','.wma','.ape','.opus','.dsf','.dff']);

// Higher = better quality
const FORMAT_RANK = {
  dsf: 11, dff: 11,        // DSD (highest)
  flac: 10, wav: 10, ape: 9, // Lossless PCM
  opus: 7, aac: 6, m4a: 6,  // Lossy modern
  ogg: 5, wma: 4, mp3: 3,   // Lossy legacy
};

// Returns { format: 'FLAC', rank: 10, count: 12 } for the dominant format in a folder
function getBestFormat(folderPath) {
  try {
    const counts = {};
    const files = fs.readdirSync(folderPath);
    for (const f of files) {
      const ext = path.extname(f).toLowerCase().slice(1);
      if (FORMAT_RANK[ext] !== undefined) counts[ext] = (counts[ext] || 0) + 1;
    }
    const entries = Object.entries(counts);
    if (entries.length === 0) return null;
    const [ext, count] = entries.sort((a, b) => (FORMAT_RANK[b[0]] ?? 0) - (FORMAT_RANK[a[0]] ?? 0))[0];
    return { format: ext.toUpperCase(), rank: FORMAT_RANK[ext] ?? 0, count };
  } catch (_) { return null; }
}

function getRank(format) {
  return FORMAT_RANK[(format || '').toLowerCase()] ?? -1;
}

module.exports = { getBestFormat, getRank, FORMAT_RANK, AUDIO_EXTS };
