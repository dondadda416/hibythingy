import { describe, it, expect } from 'vitest';
import { applySmartFilter, detectFormat, detectYear } from '../lib/smartFilter.js';

const ALBUMS = [
  { key: 'A1', name: 'Pink Floyd - The Wall (1979) [FLAC]', artist: 'Pink Floyd', tracks: 26, addedAt: 1700000000000 },
  { key: 'A2', name: 'Daft Punk - Discovery [2001] (FLAC)',  artist: 'Daft Punk',   tracks: 14, addedAt: 1710000000000 },
  { key: 'A3', name: 'Adele - 30 (2021) MP3',                artist: 'Adele',       tracks: 12, addedAt: 1720000000000 },
  { key: 'A4', name: 'VA - Compilation 2024 WAV',            artist: '',            tracks: 30, addedAt: 1730000000000 },
  { key: 'A5', name: 'Some EP (2025)',                       artist: 'Indie Band',  tracks: 4,  addedAt: Date.now() },
];

describe('smartFilter.detectFormat', () => {
  it('finds FLAC, MP3, WAV in the album name', () => {
    expect(detectFormat({ name: 'Album [FLAC]' })).toBe('FLAC');
    expect(detectFormat({ name: 'Album mp3' })).toBe('MP3');
    expect(detectFormat({ name: 'Stuff WAV' })).toBe('WAV');
  });
  it('returns empty when no format is named', () => {
    expect(detectFormat({ name: 'Just an album' })).toBe('');
    expect(detectFormat({ name: '' })).toBe('');
    expect(detectFormat({})).toBe('');
  });
});

describe('smartFilter.detectYear', () => {
  it('extracts a 4-digit year', () => {
    expect(detectYear({ name: 'Album (1979)' })).toBe(1979);
    expect(detectYear({ name: 'Album [2024] FLAC' })).toBe(2024);
  });
  it('returns null when no year is present', () => {
    expect(detectYear({ name: 'Untitled' })).toBeNull();
  });
});

describe('smartFilter.applySmartFilter', () => {
  it('returns everything when spec is empty (sorted by name)', () => {
    const out = applySmartFilter(ALBUMS, {});
    expect(out).toHaveLength(5);
    // 'Adele' starts with 'A', should be first.
    expect(out[0].artist).toBe('Adele');
  });

  it('search across name + artist', () => {
    expect(applySmartFilter(ALBUMS, { search: 'pink' })).toHaveLength(1);
    expect(applySmartFilter(ALBUMS, { search: 'PUNK' })).toHaveLength(1);
  });

  it('artist filter (string and array)', () => {
    expect(applySmartFilter(ALBUMS, { artist: 'Adele' })).toHaveLength(1);
    expect(applySmartFilter(ALBUMS, { artist: ['Daft Punk', 'Adele'] })).toHaveLength(2);
  });

  it('format filter', () => {
    const flac = applySmartFilter(ALBUMS, { format: ['FLAC'] });
    expect(flac.map(a => a.key).sort()).toEqual(['A1', 'A2']);
  });

  it('decade range', () => {
    const out = applySmartFilter(ALBUMS, { decadeFrom: 2000, decadeTo: 2024 });
    expect(out.map(a => a.key).sort()).toEqual(['A2', 'A3', 'A4']);
  });

  it('addedAfterDays bound', () => {
    const out = applySmartFilter(ALBUMS, { addedAfterDays: 1 });
    // Only A5 has addedAt within the last day.
    expect(out.map(a => a.key)).toEqual(['A5']);
  });

  it('minTracks / maxTracks', () => {
    expect(applySmartFilter(ALBUMS, { minTracks: 20 }).map(a => a.key).sort()).toEqual(['A1', 'A4']);
    expect(applySmartFilter(ALBUMS, { maxTracks: 10 }).map(a => a.key)).toEqual(['A5']);
  });

  it('sort options', () => {
    const newest = applySmartFilter(ALBUMS, { sort: 'addedDesc' });
    expect(newest[0].key).toBe('A5');
    const fewest = applySmartFilter(ALBUMS, { sort: 'tracksDesc' });
    expect(fewest[0].key).toBe('A4');
  });

  it('limit truncates', () => {
    expect(applySmartFilter(ALBUMS, { limit: 2 })).toHaveLength(2);
  });

  it('shuffle does not change the count', () => {
    const out = applySmartFilter(ALBUMS, { shuffle: true });
    expect(out).toHaveLength(5);
  });

  it('combined filter spec', () => {
    const spec = { format: ['FLAC'], minTracks: 15, sort: 'tracksDesc' };
    const out = applySmartFilter(ALBUMS, spec);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('A1'); // 26-track FLAC
  });
});
