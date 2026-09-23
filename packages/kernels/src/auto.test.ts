import { describe, expect, it } from 'vitest';
import { autoColor, autoContrast, autoTone, clipRange, equalizeLut } from './auto.js';
import { applyToRgb } from './adjust.js';

const hist = (fill: (i: number) => number) => Float64Array.from({ length: 256 }, (_, i) => fill(i));
const band = (lo: number, hi: number) => hist((i) => (i >= lo && i <= hi ? 100 : 0));

describe('auto levels', () => {
  it('finds the occupied range, ignoring the 0.1% tails', () => {
    expect(clipRange(band(40, 200))).toEqual([40, 200]);
    // One stray pixel at each extreme out of 16 100 does not move the ends.
    const h = band(40, 200);
    h[0] = 1;
    h[255] = 1;
    expect(clipRange(h)).toEqual([40, 200]);
    expect(clipRange(hist(() => 0))).toEqual([0, 255]);
  });

  it('Auto Contrast stretches all channels by the same amount', () => {
    const a = autoContrast({ r: band(50, 200), g: band(30, 180), b: band(60, 220), lum: band(50, 200) });
    expect(a.kind === 'levels' && [a.master.inBlack, a.master.inWhite]).toEqual([30, 220]);
    // Colour relationships survive: a pixel's channels keep their order.
    const [r, g, b] = applyToRgb(a, 120, 90, 150);
    expect(b > r && r > g).toBe(true);
  });

  it('Auto Tone stretches each channel on its own, which removes a cast', () => {
    const a = autoTone({ r: band(50, 200), g: band(30, 180), b: band(60, 220), lum: band(50, 200) });
    expect(applyToRgb(a, 50, 30, 60)).toEqual([0, 0, 0]);
    expect(applyToRgb(a, 200, 180, 220)).toEqual([255, 255, 255]);
  });

  it('Auto Color pulls the average colour toward grey', () => {
    // A warm image: red sits high, blue low.
    const h = { r: band(100, 250), g: band(60, 200), b: band(20, 160), lum: band(60, 200) };
    const a = autoColor(h);
    if (a.kind !== 'levels') throw new Error();
    const [r, g, b] = applyToRgb(a, 175, 130, 90); // the middle of each band
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(6);
  });
});

describe('equalize', () => {
  it('spreads a narrow band over the full range, monotonically', () => {
    const lut = equalizeLut({ r: [], g: [], b: [], lum: band(100, 131) });
    expect(lut[100]).toBeLessThan(10);
    expect(lut[131]).toBe(255);
    for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
  });

  it('leaves an already-flat histogram nearly unchanged', () => {
    const lut = equalizeLut({ r: [], g: [], b: [], lum: hist(() => 10) });
    for (let i = 0; i < 256; i++) expect(Math.abs(lut[i]! - i)).toBeLessThanOrEqual(1);
  });
});
