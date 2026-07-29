import { describe, it, expect } from 'vitest';
import { parseCssTime, cropStyle } from './player.js';

describe('parseCssTime', () => {
  it('reads milliseconds', () => {
    expect(parseCssTime('1050ms', 0)).toBe(1050);
    expect(parseCssTime(' 1ms ', 0)).toBe(1);
  });

  it('reads seconds — this is what the minifier emits', () => {
    // vite rewrites `1050ms` to `1.05s`; reading that as 1.05 disabled every
    // animation on the deployed site while dev was fine
    expect(parseCssTime('1.05s', 0)).toBe(1050);
    expect(parseCssTime('.18s', 0)).toBeCloseTo(180, 6);
    expect(parseCssTime('2s', 0)).toBe(2000);
  });

  it('treats a bare number as milliseconds', () => {
    expect(parseCssTime('300', 0)).toBe(300);
  });

  it('falls back when the property is missing or unreadable', () => {
    expect(parseCssTime('', 999)).toBe(999);
    expect(parseCssTime(undefined, 999)).toBe(999);
    expect(parseCssTime('inherit', 999)).toBe(999);
  });

  it('keeps both spellings of the same duration equal', () => {
    expect(parseCssTime('1.05s', 0)).toBe(parseCssTime('1050ms', 0));
    expect(parseCssTime('0.18s', 0)).toBeCloseTo(parseCssTime('180ms', 0), 6);
  });

  it('never turns a real duration into one small enough to skip', () => {
    // the player treats <= 2ms as "no animation"
    for (const v of ['1050ms', '1.05s', '.5s', '500ms', '0.18s'])
      expect(parseCssTime(v, 0), v).toBeGreaterThan(2);
  });
});

describe('cropStyle', () => {
  it('is a no-op for an uncropped screen', () => {
    const s = cropStyle({ w: 100, h: 100 });
    expect(s).toMatch(/width:100\.0000%/);
    expect(s).toMatch(/left:0\.0000%|left:-0\.0000%/);
  });

  it('scales up and offsets so the cropped region fills the plate', () => {
    const s = cropStyle({ w: 100, h: 100, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
    expect(s).toMatch(/width:200\.0000%/);
    expect(s).toMatch(/left:-50\.0000%/);
    expect(s).toMatch(/height:100\.0000%/);
  });
});
