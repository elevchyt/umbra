import { describe, expect, it } from 'vitest';
import {
  autoColor,
  autoContrast,
  autoLevelsWith,
  autoTone,
  clipRange,
  curvesEyedropper,
  equalizeLut,
  levelsBlackPoint,
  levelsGrayPoint,
  levelsToCurves,
  levelsWhitePoint,
  mapToPoints,
} from './auto.js';
import { applyToRgb, defaultAdjustment, type Adjustment } from './adjust.js';

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

describe('Levels and Curves eyedroppers', () => {
  const levels = () => defaultAdjustment('levels') as Extract<Adjustment, { kind: 'levels' }>;
  const curves = () => defaultAdjustment('curves') as Extract<Adjustment, { kind: 'curves' }>;

  it('black and white points send the sampled colour to black and white', () => {
    const a = levelsWhitePoint(levelsBlackPoint(levels(), [30, 40, 20]), [220, 230, 200]);
    expect(applyToRgb(a, 30, 40, 20)).toEqual([0, 0, 0]);
    expect(applyToRgb(a, 220, 230, 200)).toEqual([255, 255, 255]);
    const c = curvesEyedropper(curvesEyedropper(curves(), [30, 40, 20], 'black'), [220, 230, 200], 'white');
    expect(applyToRgb(c, 30, 40, 20)).toEqual([0, 0, 0]);
    expect(applyToRgb(c, 220, 230, 200)).toEqual([255, 255, 255]);
  });

  it('the grey point neutralises the sampled colour and keeps its brightness', () => {
    for (const [r, g, b] of [[150, 120, 90], [60, 90, 140]] as const) {
      for (const a of [levelsGrayPoint(levels(), [r, g, b]), curvesEyedropper(curves(), [r, g, b], 'gray')]) {
        const out = applyToRgb(a, r, g, b);
        expect(Math.max(...out) - Math.min(...out)).toBeLessThanOrEqual(2);
        expect(Math.abs(out[0]! - (r + g + b) / 3)).toBeLessThan(4);
      }
    }
  });
});

describe('Auto options and conversions', () => {
  const warm = { r: band(100, 250), g: band(60, 200), b: band(20, 160), lum: band(60, 200) };

  it('Monochromatic keeps the cast; Per Channel removes it', () => {
    const mono = autoLevelsWith(warm, { algorithm: 'monochromatic', snapNeutral: false, shadowClip: 0.1, highlightClip: 0.1 });
    const per = autoLevelsWith(warm, { algorithm: 'perChannel', snapNeutral: false, shadowClip: 0.1, highlightClip: 0.1 });
    const [mr, , mb] = applyToRgb(mono, 175, 130, 90);
    const [pr, , pb] = applyToRgb(per, 175, 130, 90);
    expect(mr - mb).toBeGreaterThan(pr - pb);
  });

  it('a Levels setting and its Curves translation agree', () => {
    const l = autoLevelsWith(warm, { algorithm: 'perChannel', snapNeutral: true, shadowClip: 0.1, highlightClip: 0.1 });
    const c = levelsToCurves(l);
    const samples: [number, number, number][] = [[120, 100, 60], [200, 150, 100], [110, 70, 30]];
    for (const [r, g, bl] of samples) {
      const a = applyToRgb(l, r, g, bl);
      const b = applyToRgb(c, r, g, bl);
      // A spline through three points is not a gamma curve; they agree at the ends and middle.
      a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(14));
    }
  });

  it('a pencil map replaces the channel\'s points, and reduces to 16 points for saving', () => {
    const map = Array.from({ length: 256 }, (_, i) => 255 - i);
    const c: Adjustment = { ...(defaultAdjustment('curves') as Extract<Adjustment, { kind: 'curves' }>), maps: { master: map } };
    expect(applyToRgb(c, 10, 128, 250)).toEqual([245, 127, 5]);
    const pts = mapToPoints(map);
    expect(pts.length).toBe(16);
    expect(pts[0]).toEqual({ x: 0, y: 1 });
    expect(pts[15]).toEqual({ x: 1, y: 0 });
  });
});
