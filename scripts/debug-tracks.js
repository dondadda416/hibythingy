'use strict';
// Quick debug: find specific missing tracks across available albums
const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'cache', 'library.json');
const AUDIO_EXTS = new Set(['.flac', '.mp3', '.wav', '.aac', '.m4a', '.ogg', '.wma', '.ape', '.opus']);

const libData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

// List files in an album folder
function listFiles(a) {
  try {
    return fs.readdirSync(a.path)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch(e) { return [`ERROR: ${e.message}`]; }
}

// Search for a keyword in filename across all albums for an artist
function findTrack(artistKw, trackKw) {
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(trackKw);
  const results = [];
  for (const a of libData.albums) {
    if (!a.key.toLowerCase().includes(artistKw.toLowerCase())) continue;
    const files = listFiles(a);
    for (const f of files) {
      const base = norm(path.basename(f, path.extname(f)));
      if (base.includes(t)) {
        results.push({ album: a.key, file: f });
      }
    }
  }
  return results;
}

console.log('\n=== Looking for "Amarillo" across George Strait ===');
const amarillo = findTrack('George Strait', 'Amarillo');
if (amarillo.length) amarillo.forEach(r => console.log(`  [${r.album}] ${r.file}`));
else {
  console.log('  Not found — listing 50 Number Ones disc 1 tracks 1-5:');
  const a = libData.albums.find(x => x.key === 'George Strait — 50 Number Ones');
  if (a) listFiles(a).slice(0, 5).forEach(f => console.log('  ', f));
}

console.log('\n=== Looking for "Santeria" across Sublime ===');
const santeria = findTrack('Sublime', 'Santeria');
if (santeria.length) santeria.forEach(r => console.log(`  [${r.album}] ${r.file}`));
else {
  console.log('  Not found anywhere — listing Sublime Greatest Hits:');
  const a = libData.albums.find(x => x.key === 'Sublime — Greatest Hits');
  if (a) listFiles(a).forEach(f => console.log('  ', f));
}

console.log('\n=== Looking for "Whitehouse" across Tyler Childers ===');
const whitehouse = findTrack('Tyler Childers', 'Whitehouse');
if (whitehouse.length) whitehouse.forEach(r => console.log(`  [${r.album}] ${r.file}`));
else console.log('  Not found anywhere in Tyler Childers catalog');
