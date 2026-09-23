import { describe, expect, it } from 'vitest';
import {
  colorStats,
  defaultSpatial,
  gaussianBlur,
  hdrToning,
  matchColor,
  replaceColor,
  shadowsHighlights,
  type SpatialAdjustment,
} from './spatial.js';

const W = 32;
const H = 16;
/** Left half dark, right half light, some colour. */
function image(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const v = x < W / 2 ? 30 + x : 180 + (x - W / 2) * 3;
    px.set([v, Math.round(v * 0.8), Math.round(v * 0.6), 255], o);
  }
  return px;
}
const lumAt = (px: Uint8ClampedArray, x: number, y: number) => {
  const o = (y * W + x) * 4;
  return 0.3 * px[o]! + 0.59 * px[o + 1]! + 0.11 * px[o + 2]!;
};

describe('gaussian blur', () => {
  it('preserves the mean and spreads an impulse', () => {
    const src = new Float32Array(W * H);
    src[8 * W + 16] = 100;
    const out = gaussianBlur(src, W, H, 2);
    const total = out.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 1);
    expect(out[8 * W + 16]!).toBeLessThan(100);
    expect(out[8 * W + 18]!).toBeGreaterThan(0);
  });
});

describe('shadows/highlights', () => {
  it('lifts the shadows and leaves the highlights, by default', () => {
    const px = image();
    const before = [lumAt(px, 2, 8), lumAt(px, 28, 8)];
    shadowsHighlights(px, W, H, { ...(defaultSpatial('shadowsHighlights') as Extract<SpatialAdjustment, { kind: 'shadowsHighlights' }>), blackClip: 0, whiteClip: 0 });
    expect(lumAt(px, 2, 8)).toBeGreaterThan(before[0]! + 5);
    expect(Math.abs(lumAt(px, 28, 8) - before[1]!)).toBeLessThan(3);
  });

  it('pulls highlights down when asked', () => {
    const px = image();
    const before = lumAt(px, 28, 8);
    const a = defaultSpatial('shadowsHighlights') as Extract<SpatialAdjustment, { kind: 'shadowsHighlights' }>;
    shadowsHighlights(px, W, H, { ...a, shadows: { ...a.shadows, amount: 0 }, highlights: { amount: 80, tone: 50, radius: 10 }, blackClip: 0, whiteClip: 0 });
    expect(lumAt(px, 28, 8)).toBeLessThan(before - 5);
  });
});

describe('replace color', () => {
  it('changes the sampled colour and not distant ones', () => {
    const px = new Uint8ClampedArray([200, 30, 30, 255, 30, 30, 200, 255]);
    replaceColor(px, { kind: 'replaceColor', color: [200 / 255, 30 / 255, 30 / 255], fuzziness: 40, hue: 120, saturation: 0, lightness: 0 });
    expect(px[1]!).toBeGreaterThan(150); // red became green
    expect([...px.slice(4, 8)]).toEqual([30, 30, 200, 255]);
  });
});

describe('match color', () => {
  it('moves the target statistics to the source statistics', () => {
    const target = image();
    const source = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) source.set([40 + (i % 50), 90 + (i % 30), 160, 255], i * 4);
    const t = colorStats(target);
    const s = colorStats(source);
    matchColor(target, t, s, { kind: 'matchColor', sourceLayerId: null, luminance: 100, colorIntensity: 100, fade: 0, neutralize: false });
    const after = colorStats(target);
    for (let c = 0; c < 3; c++) expect(Math.abs(after.mean[c]! - s.mean[c]!)).toBeLessThan(0.03);
  });

  it('Fade 100 leaves the image alone', () => {
    const px = image();
    const copy = px.slice();
    matchColor(px, colorStats(px), { mean: [0.2, 0.3, -0.2], std: [0.1, 0.1, 0.1] }, { kind: 'matchColor', sourceLayerId: null, luminance: 100, colorIntensity: 100, fade: 100, neutralize: false });
    expect([...px]).toEqual([...copy]);
  });
});

describe('HDR toning', () => {
  it('local adaptation compresses the range between the two halves', () => {
    const px = image();
    const before = lumAt(px, 28, 8) - lumAt(px, 2, 8);
    hdrToning(px, W, H, { ...(defaultSpatial('hdrToning') as Extract<SpatialAdjustment, { kind: 'hdrToning' }>), strength: 2, radius: 4, detail: 0, saturation: 0 });
    expect(lumAt(px, 28, 8) - lumAt(px, 2, 8)).toBeLessThan(before);
  });

  it('keeps transparent pixels transparent and untouched', () => {
    const px = image();
    px[3] = 0;
    px[0] = 7;
    hdrToning(px, W, H, defaultSpatial('hdrToning') as Extract<SpatialAdjustment, { kind: 'hdrToning' }>);
    expect([px[0], px[3]]).toEqual([7, 0]);
  });
});
