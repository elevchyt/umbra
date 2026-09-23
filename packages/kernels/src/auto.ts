/**
 * Image ▸ Auto Tone / Auto Contrast / Auto Color and Image ▸ Adjustments ▸ Equalize —
 * spec 05 §A. All four are a histogram in, a table out.
 *
 * The auto commands are Levels settings Photoshop computes for you, with the defaults of its
 * Auto Color Correction Options dialog: 0.10% clipped at each end.
 *
 *  - Auto Contrast ("Enhance Monochromatic Contrast") clips the three channels TOGETHER, so
 *    colour relationships survive and only contrast changes.
 *  - Auto Tone ("Enhance Per Channel Contrast") clips each channel on its own, which also
 *    neutralises a cast.
 *  - Auto Color ("Find Dark & Light Colors" + "Snap Neutral Midtones") is per-channel
 *    clipping plus a per-channel gamma that pulls the average colour to grey. `[fit]`:
 *    Photoshop searches for near-neutral pixels to decide the midtone; the mean used here is
 *    the simplest stand-in and is what a HALD comparison would replace.
 *
 * Equalize remaps brightness so the cumulative histogram is a straight line, one table
 * applied to all three channels. `[fit]` on the choice of the brightness histogram.
 */
import { DEFAULT_LEVELS, type Adjustment, type LevelsChannel } from './adjust.js';

export interface Histogram3 {
  r: ArrayLike<number>;
  g: ArrayLike<number>;
  b: ArrayLike<number>;
  lum: ArrayLike<number>;
}

export const AUTO_CLIP = 0.001;

/** The lowest and highest levels once `clip` of the pixels is discarded at each end. */
export function clipRange(hist: ArrayLike<number>, clip = AUTO_CLIP): [number, number] {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i]!;
  if (total === 0) return [0, 255];
  const cut = total * clip;
  let lo = 0;
  for (let acc = 0; lo < 255; lo++) {
    acc += hist[lo]!;
    if (acc > cut) break;
  }
  let hi = 255;
  for (let acc = 0; hi > 0; hi--) {
    acc += hist[hi]!;
    if (acc > cut) break;
  }
  // A flat image (or a clip that swallowed everything) has nothing to stretch.
  if (hi - lo < 2) return [0, 255];
  return [lo, hi];
}

const stretch = ([lo, hi]: [number, number]): LevelsChannel => ({ ...DEFAULT_LEVELS, inBlack: lo, inWhite: hi });

export function autoContrast(h: Histogram3, clip = AUTO_CLIP): Adjustment {
  const combined = new Float64Array(256);
  for (let i = 0; i < 256; i++) combined[i] = h.r[i]! + h.g[i]! + h.b[i]!;
  return { kind: 'levels', master: stretch(clipRange(combined, clip)), r: DEFAULT_LEVELS, g: DEFAULT_LEVELS, b: DEFAULT_LEVELS };
}

export function autoTone(h: Histogram3, clip = AUTO_CLIP): Adjustment {
  return {
    kind: 'levels',
    master: DEFAULT_LEVELS,
    r: stretch(clipRange(h.r, clip)),
    g: stretch(clipRange(h.g, clip)),
    b: stretch(clipRange(h.b, clip)),
  };
}

/** Mean of a channel after a Levels input stretch, 0…1. */
function stretchedMean(hist: ArrayLike<number>, [lo, hi]: [number, number]): number {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, Math.max(0, (i - lo) / (hi - lo)));
    n += hist[i]!;
    sum += v * hist[i]!;
  }
  return n ? sum / n : 0.5;
}

export function autoColor(h: Histogram3, clip = AUTO_CLIP): Adjustment {
  const ranges = [clipRange(h.r, clip), clipRange(h.g, clip), clipRange(h.b, clip)] as const;
  const means = [stretchedMean(h.r, ranges[0]), stretchedMean(h.g, ranges[1]), stretchedMean(h.b, ranges[2])];
  const target = (means[0]! + means[1]! + means[2]!) / 3;
  const gamma = (m: number) => {
    // m^(1/γ) = target  ⇒  γ = ln m / ln target. Held to a sane range: a nearly black or
    // white channel mean would otherwise ask for an extreme correction.
    if (m <= 0 || m >= 1 || target <= 0 || target >= 1) return 1;
    return Math.round(Math.min(2, Math.max(0.5, Math.log(m) / Math.log(target))) * 100) / 100;
  };
  const ch = (i: 0 | 1 | 2): LevelsChannel => ({ ...stretch(ranges[i]), gamma: gamma(means[i]!) });
  return { kind: 'levels', master: DEFAULT_LEVELS, r: ch(0), g: ch(1), b: ch(2) };
}

/** Equalize: brightness CDF → a table, the same for R, G and B. */
export function equalizeLut(h: Histogram3): Uint8Array {
  const lut = new Uint8Array(256);
  let total = 0;
  for (let i = 0; i < 256; i++) total += h.lum[i]!;
  if (total === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  let first = 0;
  while (first < 255 && h.lum[first] === 0) first++;
  const base = h.lum[first]!;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h.lum[i]!;
    // Standard histogram equalisation, anchored so the darkest occupied level maps to 0.
    lut[i] = total === base ? i : Math.round((Math.max(0, acc - base) / (total - base)) * 255);
  }
  return lut;
}
