/**
 * The adjustments that are not a function of one pixel — spec 05 §A: Shadows/Highlights,
 * Replace Color, Match Color and HDR Toning. Photoshop has none of them as adjustment layers
 * (Shadows/Highlights can be a smart filter, which is M5), so they run destructively over a
 * layer's pixels: an RGBA8 raster in, the same raster adjusted in place, alpha untouched.
 *
 * All four are `[fit]` — none is published — and each says below what its model is.
 */
import { boxBlur } from './selection.js';
import { clipRange } from './auto.js';
import { hslToRgb, rgbToHsl } from './adjust.js';

export type SpatialAdjustment =
  | {
      kind: 'shadowsHighlights';
      shadows: { amount: number; tone: number; radius: number };
      highlights: { amount: number; tone: number; radius: number };
      /** −100…100 */
      colorCorrection: number;
      /** −100…100 */
      midtoneContrast: number;
      /** Percent, 0…50. */
      blackClip: number;
      whiteClip: number;
    }
  | {
      kind: 'replaceColor';
      /** The sampled colour, 0…1. */
      color: [number, number, number];
      /** 0…200 */
      fuzziness: number;
      hue: number;
      saturation: number;
      lightness: number;
    }
  | {
      kind: 'matchColor';
      /** A layer of this document, or null for the whole (merged) image. */
      sourceLayerId: number | null;
      /** 1…200 */
      luminance: number;
      /** 1…200 */
      colorIntensity: number;
      /** 0…100 */
      fade: number;
      neutralize: boolean;
    }
  | {
      kind: 'hdrToning';
      method: 'localAdaptation' | 'equalize' | 'exposureGamma' | 'highlightCompression';
      /** Local Adaptation: edge glow radius (px) and strength. */
      radius: number;
      strength: number;
      gamma: number;
      exposure: number;
      /** −100…300 */
      detail: number;
      shadow: number;
      highlight: number;
      vibrance: number;
      saturation: number;
    };

export const SPATIAL_LABEL: Record<SpatialAdjustment['kind'], string> = {
  shadowsHighlights: 'Shadows/Highlights',
  replaceColor: 'Replace Color',
  matchColor: 'Match Color',
  hdrToning: 'HDR Toning',
};

export function defaultSpatial(kind: SpatialAdjustment['kind']): SpatialAdjustment {
  switch (kind) {
    case 'shadowsHighlights':
      // Photoshop's defaults: 35% shadows, highlights off.
      return {
        kind,
        shadows: { amount: 35, tone: 50, radius: 30 },
        highlights: { amount: 0, tone: 50, radius: 30 },
        colorCorrection: 20,
        midtoneContrast: 0,
        blackClip: 0.01,
        whiteClip: 0.01,
      };
    case 'replaceColor':
      return { kind, color: [1, 1, 1], fuzziness: 40, hue: 0, saturation: 0, lightness: 0 };
    case 'matchColor':
      return { kind, sourceLayerId: null, luminance: 100, colorIntensity: 100, fade: 0, neutralize: false };
    case 'hdrToning':
      return {
        kind,
        method: 'localAdaptation',
        radius: 16,
        strength: 0.52,
        gamma: 1,
        exposure: 0,
        detail: 30,
        shadow: 0,
        highlight: 0,
        vibrance: 0,
        saturation: 20,
      };
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lumOf = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Gaussian blur of a float plane, as three box blurs (the feather's approximation). */
export function gaussianBlur(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const out = new Float32Array(src);
  if (sigma <= 0.3) return out;
  // Three passes of a box of width w have variance 3·(w²−1)/12; solve for w.
  const w = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  const r = Math.max(1, Math.round((w - 1) / 2));
  const tmp = new Float32Array(src.length);
  boxBlur(out, tmp, width, height, r);
  boxBlur(tmp, out, width, height, r);
  boxBlur(out, tmp, width, height, r);
  return tmp;
}

function luminancePlane(px: Uint8ClampedArray | Uint8Array): Float32Array {
  const n = px.length / 4;
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = lumOf(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!) / 255;
  return l;
}

/** Scale a pixel's chroma about its luminance — how the "colour" sliders act on a result. */
function scaleChroma(rgb: [number, number, number], k: number): [number, number, number] {
  const l = lumOf(rgb[0], rgb[1], rgb[2]);
  return [l + (rgb[0] - l) * k, l + (rgb[1] - l) * k, l + (rgb[2] - l) * k];
}

// ---- Shadows/Highlights ------------------------------------------------------------------

/**
 * `[fit]`. A blurred luminance (Radius) decides where the shadows and highlights are, so a
 * dark region is lifted as a region rather than pixel by pixel — that is what keeps local
 * contrast. Within each Tone (the tonal width) the mask ramps quadratically toward the
 * extreme; Amount drives a gamma that lifts shadows or pulls highlights while pinning black
 * and white. The luminance change is applied as a ratio so hue is kept, Color Correction
 * scales chroma where the image moved, Midtone Contrast is an S-curve about 50%, and the
 * clip percentages are an auto-levels stretch of the result.
 */
export function shadowsHighlights(
  px: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  a: Extract<SpatialAdjustment, { kind: 'shadowsHighlights' }>,
): void {
  const L = luminancePlane(px);
  const blurS = a.shadows.amount > 0 ? gaussianBlur(L, width, height, a.shadows.radius / 2) : null;
  const blurH =
    a.highlights.amount > 0
      ? a.highlights.radius === a.shadows.radius && blurS
        ? blurS
        : gaussianBlur(L, width, height, a.highlights.radius / 2)
      : null;
  const ts = Math.max(0.01, a.shadows.tone / 100);
  const th = Math.max(0.01, a.highlights.tone / 100);
  const n = width * height;
  const outL = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (px[i * 4 + 3] === 0) continue;
    const l = L[i]!;
    let v = l;
    if (blurS) {
      const m = (1 - clamp01(blurS[i]! / ts)) ** 2;
      const g = 1 + 3 * (a.shadows.amount / 100) * m;
      v = v ** (1 / g);
    }
    if (blurH) {
      const m = clamp01((blurH[i]! - (1 - th)) / th) ** 2;
      const g = 1 + 3 * (a.highlights.amount / 100) * m;
      v = 1 - (1 - v) ** (1 / g);
    }
    if (a.midtoneContrast !== 0) {
      const s = v * v * (3 - 2 * v);
      v += (a.midtoneContrast / 100) * (s - v);
    }
    outL[i] = v;
  }

  // Black/White Clip: stretch the new luminance so those fractions clip, like Auto Contrast.
  let lo = 0;
  let hi = 1;
  if (a.blackClip > 0 || a.whiteClip > 0) {
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) if (px[i * 4 + 3]) hist[Math.round(clamp01(outL[i]!) * 255)]!++;
    const [b0] = clipRange(hist, a.blackClip / 100);
    const [, w0] = clipRange(hist, a.whiteClip / 100);
    lo = b0 / 255;
    hi = w0 / 255;
    if (hi - lo < 0.02) {
      lo = 0;
      hi = 1;
    }
  }

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (px[o + 3] === 0) continue;
    const l = L[i]!;
    const target = clamp01((outL[i]! - lo) / (hi - lo));
    let rgb: [number, number, number] = [px[o]! / 255, px[o + 1]! / 255, px[o + 2]! / 255];
    if (l > 1e-4) {
      const k = target / l;
      rgb = [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    } else {
      rgb = [target, target, target];
    }
    // Colour correction acts in proportion to how far the tone moved.
    const moved = Math.min(1, Math.abs(target - l) * 4);
    const chroma = 1 + (a.colorCorrection / 100) * moved - moved * 0.2 * (target > l ? 1 : 0);
    rgb = scaleChroma(rgb, Math.max(0, chroma));
    px[o] = Math.round(clamp01(rgb[0]) * 255);
    px[o + 1] = Math.round(clamp01(rgb[1]) * 255);
    px[o + 2] = Math.round(clamp01(rgb[2]) * 255);
  }
}

// ---- Replace Color ------------------------------------------------------------------------

/**
 * `[fit]`. The selection half is Color Range's: a pixel's weight falls linearly with its
 * distance from the sampled colour, reaching zero at Fuzziness (in 8-bit RGB units, the scale
 * Color Range's slider reads in). The replacement half is Hue/Saturation's master sliders,
 * applied fully and blended in by that weight.
 */
export function replaceColorWeight(r: number, g: number, b: number, color: readonly number[], fuzziness: number): number {
  const d = Math.hypot(r - color[0]! * 255, g - color[1]! * 255, b - color[2]! * 255);
  if (fuzziness <= 0) return d < 0.5 ? 1 : 0;
  return clamp01(1 - d / (fuzziness * 1.5));
}

export function replaceColor(px: Uint8ClampedArray | Uint8Array, a: Extract<SpatialAdjustment, { kind: 'replaceColor' }>): void {
  for (let o = 0; o < px.length; o += 4) {
    if (px[o + 3] === 0) continue;
    const r = px[o]!;
    const g = px[o + 1]!;
    const b = px[o + 2]!;
    const w = replaceColorWeight(r, g, b, a.color, a.fuzziness);
    if (w <= 0) continue;
    const [h, s, l] = rgbToHsl(r / 255, g / 255, b / 255);
    const s2 = clamp01(s * (1 + a.saturation / 100));
    const l2 = a.lightness >= 0 ? l + (1 - l) * (a.lightness / 100) : l * (1 + a.lightness / 100);
    const out = hslToRgb(h + a.hue, s2, l2);
    px[o] = Math.round(r + (out[0] * 255 - r) * w);
    px[o + 1] = Math.round(g + (out[1] * 255 - g) * w);
    px[o + 2] = Math.round(b + (out[2] * 255 - b) * w);
  }
}

/** The Replace Color dialog's preview: its selection as a grey mask. */
export function replaceColorMask(px: Uint8ClampedArray | Uint8Array, color: readonly number[], fuzziness: number): Uint8Array {
  const out = new Uint8Array(px.length / 4);
  for (let i = 0, o = 0; o < px.length; o += 4, i++) {
    out[i] = px[o + 3] ? Math.round(replaceColorWeight(px[o]!, px[o + 1]!, px[o + 2]!, color, fuzziness) * 255) : 0;
  }
  return out;
}

// ---- Match Color -----------------------------------------------------------------------------

/**
 * Colour statistics in an opponent space — luminance plus two colour-difference axes — which
 * is the decorrelated space Reinhard et al.'s colour transfer works in `[doc]`. Photoshop's
 * exact space is not published; this is the standard one made cheap.
 */
export interface ColorStats {
  mean: [number, number, number];
  std: [number, number, number];
}

const toOpp = (r: number, g: number, b: number): [number, number, number] => [lumOf(r, g, b), r - g, (r + g) / 2 - b];
/** Inverse of `toOpp`: r = g + a, b = g + a/2 − bb, and the luminance weights sum to 1. */
const fromOpp = (l: number, a: number, bb: number): [number, number, number] => {
  const g = l - 0.3 * a - 0.11 * (a / 2 - bb);
  return [g + a, g, g + a / 2 - bb];
};

export function colorStats(px: Uint8ClampedArray | Uint8Array, mask?: Uint8Array): ColorStats {
  let n = 0;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0, o = 0; o < px.length; o += 4, i++) {
    if (px[o + 3] === 0 || (mask && mask[i]! < 128)) continue;
    const v = toOpp(px[o]! / 255, px[o + 1]! / 255, px[o + 2]! / 255);
    for (let c = 0; c < 3; c++) {
      sum[c]! += v[c]!;
      sq[c]! += v[c]! * v[c]!;
    }
    n++;
  }
  if (n === 0) return { mean: [0.5, 0, 0], std: [0.25, 0.1, 0.1] };
  const mean = sum.map((s) => s / n) as [number, number, number];
  const std = sq.map((s, c) => Math.sqrt(Math.max(1e-8, s / n - mean[c]! ** 2))) as [number, number, number];
  return { mean, std };
}

/**
 * Transfer: each opponent axis is standardised against the target and re-scaled to the
 * source's statistics. Luminance scales the result's brightness, Color Intensity its chroma,
 * Neutralize drops the source's colour cast (its colour means become 0), and Fade mixes back
 * toward the original.
 */
export function matchColor(
  px: Uint8ClampedArray | Uint8Array,
  target: ColorStats,
  source: ColorStats,
  a: Extract<SpatialAdjustment, { kind: 'matchColor' }>,
): void {
  const srcMean: [number, number, number] = a.neutralize ? [source.mean[0], 0, 0] : source.mean;
  const lumK = a.luminance / 100;
  const chromaK = a.colorIntensity / 100;
  const keep = a.fade / 100;
  for (let o = 0; o < px.length; o += 4) {
    if (px[o + 3] === 0) continue;
    const r = px[o]! / 255;
    const g = px[o + 1]! / 255;
    const b = px[o + 2]! / 255;
    const v = toOpp(r, g, b);
    const t: number[] = [];
    for (let c = 0; c < 3; c++) {
      t[c] = ((v[c]! - target.mean[c]!) / target.std[c]!) * source.std[c]! + srcMean[c]!;
    }
    t[0] = t[0]! * lumK;
    t[1] = t[1]! * chromaK;
    t[2] = t[2]! * chromaK;
    const out = fromOpp(t[0]!, t[1]!, t[2]!);
    px[o] = Math.round(clamp01(out[0] + (r - out[0]) * keep) * 255);
    px[o + 1] = Math.round(clamp01(out[1] + (g - out[1]) * keep) * 255);
    px[o + 2] = Math.round(clamp01(out[2] + (b - out[2]) * keep) * 255);
  }
}

// ---- HDR Toning ------------------------------------------------------------------------------

/**
 * `[fit]`, and the loosest of the four. On an 8-bit image HDR Toning is a tone-mapping look:
 *
 *  - Local Adaptation: log-luminance split into a base (Gaussian of Radius) and detail; the
 *    base is compressed by Strength and the detail boosted by Detail — the classic
 *    base/detail decomposition spec 05 §A points at, with a Gaussian where Photoshop is
 *    edge-aware (its "Edge Glow" is exactly the halo a Gaussian base produces). Then
 *    Exposure, Gamma, Shadow/Highlight lifts, Vibrance and Saturation.
 *  - Exposure and Gamma: those two only. Highlight Compression: Reinhard's L/(1+L).
 *  - Equalize Histogram: the Equalize command on luminance.
 */
export function hdrToning(
  px: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  a: Extract<SpatialAdjustment, { kind: 'hdrToning' }>,
): void {
  const n = width * height;
  const L = luminancePlane(px);
  const out = new Float32Array(n);

  if (a.method === 'localAdaptation') {
    const logL = new Float32Array(n);
    for (let i = 0; i < n; i++) logL[i] = Math.log(L[i]! + 1e-3);
    const base = gaussianBlur(logL, width, height, Math.max(0.5, a.radius / 2));
    // Compress the base about its mean; boost the detail.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += base[i]!;
    mean /= n || 1;
    const k = Math.max(0.1, a.strength);
    const detail = 1 + a.detail / 100;
    for (let i = 0; i < n; i++) {
      const b = mean + (base[i]! - mean) / (1 + k);
      const v = Math.exp(b + (logL[i]! - base[i]!) * detail) - 1e-3;
      out[i] = v;
    }
  } else if (a.method === 'equalize') {
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) if (px[i * 4 + 3]) hist[Math.round(L[i]! * 255)]!++;
    let total = 0;
    for (let i = 0; i < 256; i++) total += hist[i]!;
    const cdf = new Float64Array(256);
    let acc = 0;
    for (let i = 0; i < 256; i++) cdf[i] = (acc += hist[i]!) / (total || 1);
    for (let i = 0; i < n; i++) out[i] = cdf[Math.round(L[i]! * 255)]!;
  } else if (a.method === 'highlightCompression') {
    for (let i = 0; i < n; i++) {
      const v = L[i]! * 2;
      out[i] = (v / (1 + v)) * 1.5;
    }
  } else {
    out.set(L);
  }

  const expK = 2 ** a.exposure;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (px[o + 3] === 0) continue;
    let v = clamp01(out[i]! * (a.method === 'equalize' ? 1 : expK));
    v = v ** (1 / Math.max(0.1, a.gamma));
    if (a.shadow) v += (a.shadow / 100) * 0.5 * (1 - v) ** 2 * (1 - v);
    if (a.highlight) v += (a.highlight / 100) * 0.5 * v * v * v;
    v = clamp01(v);
    const l = L[i]!;
    let rgb: [number, number, number] = l > 1e-4
      ? [(px[o]! / 255) * (v / l), (px[o + 1]! / 255) * (v / l), (px[o + 2]! / 255) * (v / l)]
      : [v, v, v];
    if (a.vibrance || a.saturation) {
      const [h, s, ll] = rgbToHsl(clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]));
      let s2 = s * (1 + (a.vibrance / 100) * (1 - s));
      s2 *= 1 + a.saturation / 100;
      rgb = hslToRgb(h, clamp01(s2), ll);
    }
    px[o] = Math.round(clamp01(rgb[0]) * 255);
    px[o + 1] = Math.round(clamp01(rgb[1]) * 255);
    px[o + 2] = Math.round(clamp01(rgb[2]) * 255);
  }
}
