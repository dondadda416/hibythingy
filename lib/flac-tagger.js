// ── Pure-JS FLAC Vorbis Comment writer ───────────────────────────────────────
// Reads/writes tags in FLAC files by directly manipulating the binary metadata
// blocks. No native compilation required.
//
// FLAC structure:
//   4 bytes  : "fLaC" marker
//   N blocks : [1-byte header (isLast|blockType)] [3-byte LE length] [data]
//   Audio    : remainder of file (untouched)
//
// Block type 4 = VORBIS_COMMENT (Vorbis Comment = key=value tag pairs)

'use strict';
const fs = require('fs');

// ── Low-level helpers ─────────────────────────────────────────────────────────

function read3BE(buf, offset) {
  return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
}

// Encode a new Vorbis Comment block from a tags object
// Supported keys: artist, albumArtist, album, year, genre, comment
function encodeVorbisComment(tags) {
  const vendor = Buffer.from('HiBy Hub Tagger 1.0', 'utf8');

  const pairs = [];
  const add = (k, v) => { if (v != null && String(v).trim() !== '') pairs.push(`${k}=${String(v).trim()}`); };

  add('ARTIST',      tags.artist);
  add('ALBUMARTIST', tags.albumArtist || tags.artist);
  add('ALBUM',       tags.album);
  add('DATE',        tags.year);
  add('GENRE',       tags.genre);
  add('TITLE',       tags.title);
  add('TRACKNUMBER', tags.track);
  add('COMMENT',     tags.comment);
  // Preserve any other existing pairs passed through
  if (Array.isArray(tags._extra)) tags._extra.forEach(p => pairs.push(p));

  const commentBufs = pairs.map(p => Buffer.from(p, 'utf8'));

  const size =
    4 + vendor.length +                               // vendor
    4 +                                               // comment count
    commentBufs.reduce((s, b) => s + 4 + b.length, 0); // each comment

  const out = Buffer.alloc(size);
  let off = 0;

  out.writeUInt32LE(vendor.length, off);   off += 4;
  vendor.copy(out, off);                   off += vendor.length;
  out.writeUInt32LE(commentBufs.length, off); off += 4;

  for (const cb of commentBufs) {
    out.writeUInt32LE(cb.length, off); off += 4;
    cb.copy(out, off);                  off += cb.length;
  }

  return out;
}

// Decode a Vorbis Comment block into a plain object
function decodeVorbisComment(data) {
  let off = 0;
  const vendorLen = data.readUInt32LE(off); off += 4;
  const vendor    = data.toString('utf8', off, off + vendorLen); off += vendorLen;
  const count     = data.readUInt32LE(off); off += 4;

  const tags = { _vendor: vendor, _extra: [] };
  for (let i = 0; i < count; i++) {
    const len = data.readUInt32LE(off); off += 4;
    const pair = data.toString('utf8', off, off + len); off += len;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).toUpperCase();
    const val = pair.slice(eq + 1);

    switch (key) {
      case 'ARTIST':      tags.artist      = val; break;
      case 'ALBUMARTIST': tags.albumArtist = val; break;
      case 'ALBUM':       tags.album       = val; break;
      case 'DATE':
      case 'YEAR':        tags.year        = val.slice(0, 4); break;
      case 'GENRE':       tags.genre       = val; break;
      case 'TRACKNUMBER': tags.track       = val; break;
      case 'TITLE':       tags.title       = val; break;
      default:            tags._extra.push(pair);
    }
  }
  return tags;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read Vorbis Comment tags from a FLAC file.
 * Returns null if no VORBIS_COMMENT block exists.
 */
function readFlacTags(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'fLaC') throw new Error('Not a FLAC file: ' + filePath);

  let off = 4;
  while (off < buf.length - 4) {
    const header    = buf[off];
    const blockType = header & 0x7F;
    const isLast    = !!(header & 0x80);
    const length    = read3BE(buf, off + 1);
    off += 4;

    if (blockType === 4) { // VORBIS_COMMENT
      return decodeVorbisComment(buf.slice(off, off + length));
    }

    off += length;
    if (isLast) break;
  }
  return {};
}

/**
 * Write tags to a FLAC file, preserving all other metadata blocks and audio.
 * @param {string} filePath  Absolute path to the .flac file
 * @param {object} tags      { artist, albumArtist, album, year, genre, ... }
 */
function writeFlacTags(filePath, tags) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'fLaC') throw new Error('Not a FLAC file: ' + filePath);

  // Parse all metadata blocks
  const blocks = [];
  let off = 4;

  while (off < buf.length - 4) {
    const header    = buf[off];
    const blockType = header & 0x7F;
    const isLast    = !!(header & 0x80);
    const length    = read3BE(buf, off + 1);
    off += 4;

    blocks.push({ type: blockType, data: buf.slice(off, off + length) });
    off += length;
    if (isLast) break;
  }

  const audioData = buf.slice(off);

  // Merge incoming tags with any _extra pairs from the existing VC block
  const existing = blocks.find(b => b.type === 4);
  const existingTags = existing ? decodeVorbisComment(existing.data) : {};
  const merged = { ...existingTags, ...tags, _extra: existingTags._extra || [] };

  // Replace (or add) the VORBIS_COMMENT block
  const newVC   = encodeVorbisComment(merged);
  const filtered = blocks.filter(b => b.type !== 4);
  filtered.push({ type: 4, data: newVC });

  // Sort: STREAMINFO (0) first, PICTURE (6) last, everything else in between
  filtered.sort((a, b) => {
    if (a.type === 0) return -1;
    if (b.type === 0) return 1;
    if (a.type === 6) return 1;
    if (b.type === 6) return -1;
    return 0;
  });

  // Reassemble
  const parts = [Buffer.from('fLaC')];
  for (let i = 0; i < filtered.length; i++) {
    const blk      = filtered[i];
    const isLast   = i === filtered.length - 1;
    const len      = blk.data.length;
    const hdr      = Buffer.from([
      ((isLast ? 0x80 : 0x00) | (blk.type & 0x7F)),
      (len >> 16) & 0xFF,
      (len >>  8) & 0xFF,
       len        & 0xFF,
    ]);
    parts.push(hdr, blk.data);
  }
  parts.push(audioData);

  fs.writeFileSync(filePath, Buffer.concat(parts));
}

module.exports = { readFlacTags, writeFlacTags };
