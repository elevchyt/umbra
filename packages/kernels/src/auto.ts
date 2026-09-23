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
import { normaliseCurve, type CurvePoint } from './curve.js';

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

// ---- Auto Color Correction Options, and the Levels/Curves eyedroppers ---------------------------

export type AutoAlgorithm = 'monochromatic' | 'perChannel' | 'darkLight';

/** The Auto Color Correction Options dialog's settings; the defaults are Photoshop's. */
export interface AutoOptions {
  algorithm: AutoAlgorithm;
  snapNeutral: boolean;
  /** Percent clipped at each end, 0…9.99. */
  shadowClip: number;
  highlightClip: number;
}

export const DEFAULT_AUTO_OPTIONS: AutoOptions = { algorithm: 'perChannel', snapNeutral: false, shadowClip: 0.1, highlightClip: 0.1 };

/**
 * The Auto button in Levels and Curves. Monochromatic clips all channels together, Per
 * Channel each on its own, and Find Dark & Light Colors is Per Channel anchored on the darkest
 * and lightest average colours — here the same per-channel ranges, `[fit]`. Snap Neutral
 * Midtones adds Auto Color's per-channel gamma.
 */
export function autoLevelsWith(h: Histogram3, o: AutoOptions): Extract<Adjustment, { kind: 'levels' }> {
  const clipped = (hist: ArrayLike<number>): [number, number] => {
    const lo = clipRange(hist, o.shadowClip / 100)[0];
    const hi = clipRange(hist, o.highlightClip / 100)[1];
    return hi - lo < 2 ? [0, 255] : [lo, hi];
  };
  const base =
    o.algorithm === 'monochromatic'
      ? (autoContrast(h) as Extract<Adjustment, { kind: 'levels' }>)
      : (autoTone(h) as Extract<Adjustment, { kind: 'levels' }>);
  let out: Extract<Adjustment, { kind: 'levels' }>;
  if (o.algorithm === 'monochromatic') {
    const combined = new Float64Array(256);
    for (let i = 0; i < 256; i++) combined[i] = h.r[i]! + h.g[i]! + h.b[i]!;
    out = { ...base, master: stretch(clipped(combined)) };
  } else {
    out = { ...base, r: stretch(clipped(h.r)), g: stretch(clipped(h.g)), b: stretch(clipped(h.b)) };
  }
  if (o.snapNeutral) {
    const color = autoColor(h, o.shadowClip / 100) as Extract<Adjustment, { kind: 'levels' }>;
    out = {
      ...out,
      r: { ...out.r, gamma: color.r.gamma },
      g: { ...out.g, gamma: color.g.gamma },
      b: { ...out.b, gamma: color.b.gamma },
    };
  }
  return out;
}

type Levels = Extract<Adjustment, { kind: 'levels' }>;
const CH = ['r', 'g', 'b'] as const;

/** Levels' black-point eyedropper: the sampled colour becomes black, channel by channel. */
export function levelsBlackPoint(adj: Levels, rgb8: readonly number[]): Levels {
  const next = { ...adj };
  CH.forEach((c, i) => {
    next[c] = { ...adj[c], inBlack: Math.min(Math.round(rgb8[i]!), adj[c].inWhite - 2) };
  });
  return next;
}

/** Levels' white-point eyedropper: the sampled colour becomes white. */
export function levelsWhitePoint(adj: Levels, rgb8: readonly number[]): Levels {
  const next = { ...adj };
  CH.forEach((c, i) => {
    next[c] = { ...adj[c], inWhite: Math.max(Math.round(rgb8[i]!), adj[c].inBlack + 2) };
  });
  return next;
}

/**
 * Levels' grey-point eyedropper: per-channel gammas that make the sampled colour neutral at
 * the mean of its channels, so its brightness is kept and only its cast removed.
 */
export function levelsGrayPoint(adj: Levels, rgb8: readonly number[]): Levels {
  const t = CH.map((c, i) => Math.min(0.999, Math.max(0.001, (rgb8[i]! - adj[c].inBlack) / (adj[c].inWhite - adj[c].inBlack))));
  const target = (t[0]! + t[1]! + t[2]!) / 3;
  const next = { ...adj };
  CH.forEach((c, i) => {
    const g = Math.log(t[i]!) / Math.log(target);
    next[c] = { ...adj[c], gamma: Math.round(Math.min(9.99, Math.max(0.1, g)) * 100) / 100 };
  });
  return next;
}

type Curves = Extract<Adjustment, { kind: 'curves' }>;

/** Replace a channel's end point (0 = black, last = white) or add a mid point, keeping order. */
function withPoint(points: readonly CurvePoint[], p: CurvePoint, which: 'black' | 'white' | 'gray'): CurvePoint[] {
  const pts = [...points];
  if (which === 'black') pts[0] = { x: Math.min(p.x, pts[pts.length - 1]!.x - 2 / 255), y: 0 };
  else if (which === 'white') pts[pts.length - 1] = { x: Math.max(p.x, pts[0]!.x + 2 / 255), y: 1 };
  else return normaliseCurve([...pts.filter((q) => Math.abs(q.x - p.x) > 1 / 255), p]);
  return pts;
}

/**
 * Curves' eyedroppers: black and white move each colour channel's end point to the sampled
 * value; grey adds a point on each channel that maps the sampled value to the mean of the
 * three, which neutralises it without changing its brightness.
 */
export function curvesEyedropper(adj: Curves, rgb8: readonly number[], which: 'black' | 'white' | 'gray'): Curves {
  const v = rgb8.map((c) => Math.round(c) / 255);
  const target = (v[0]! + v[1]! + v[2]!) / 3;
  const next: Curves = { ...adj, maps: adj.maps ? { ...adj.maps } : undefined };
  CH.forEach((c, i) => {
    if (next.maps) delete next.maps[c];
    next[c] = withPoint(adj[c], { x: v[i]!, y: which === 'gray' ? target : which === 'black' ? 0 : 1 }, which);
  });
  return next;
}

/** A Levels setting as the equivalent Curves points — how Curves' Auto button is expressed. */
export function levelsToCurves(l: Levels): Curves {
  const pts = (c: LevelsChannel): CurvePoint[] => {
    const out: CurvePoint[] = [
      { x: c.inBlack / 255, y: c.outBlack / 255 },
      { x: c.inWhite / 255, y: c.outWhite / 255 },
    ];
    if (Math.abs(c.gamma - 1) > 0.005) {
      const x = (c.inBlack + (c.inWhite - c.inBlack) * 0.5 ** c.gamma) / 255;
      out.splice(1, 0, { x, y: (c.outBlack + (c.outWhite - c.outBlack) * 0.5) / 255 });
    }
    return out;
  };
  return { kind: 'curves', master: pts(l.master), r: pts(l.r), g: pts(l.g), b: pts(l.b) };
}

/** A pencil-drawn map as at most 16 points, for saving (a PSD's curves hold points). */
export function mapToPoints(map: readonly number[], count = 16): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round((i * 255) / (count - 1));
    out.push({ x: x / 255, y: Math.min(255, Math.max(0, map[x]!)) / 255 });
  }
  return out;
}
