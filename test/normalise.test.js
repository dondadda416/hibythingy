import { describe, it, expect } from 'vitest';
import normalise from '../lib/normalise.js';

describe('lib/normalise', () => {
  it('lower-cases the result', () => {
    expect(normalise('Pink Floyd')).toBe('pink floyd');
  });

  it('canonicalises hyphens to em-dashes between artist and album', () => {
    const a = normalise('Pink Floyd - The Wall');
    const b = normalise('Pink Floyd — The Wall');
    const c = normalise('Pink Floyd – The Wall'); // en-dash
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('strips parenthetical and bracketed annotations', () => {
    expect(normalise('Album (2020 Remaster)')).toBe('album');
    expect(normalise('Album [Deluxe Edition]')).toBe('album');
  });

  it('collapses repeated whitespace', () => {
    expect(normalise('Pink     Floyd')).toBe('pink floyd');
  });

  it('treats null/undefined as empty', () => {
    expect(normalise(null)).toBe('');
    expect(normalise(undefined)).toBe('');
    expect(normalise('')).toBe('');
  });

  it('matches different separator styles to the same key', () => {
    const variants = [
      'Pink Floyd - The Wall',
      'Pink Floyd — The Wall',
      'Pink Floyd – The Wall',
      'Pink Floyd  --  The Wall',
    ];
    const norms = new Set(variants.map(normalise));
    expect(norms.size).toBe(1);
  });
});
