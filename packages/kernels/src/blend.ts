/**
 * Blend functions — the executable definition of docs/spec/06-compositing-math.md §2.
 *
 * Everything here works on straight-alpha values in 0…1 and is deliberately written for
 * clarity over speed: this is the reference the GPU shaders are tested against, and the CPU
 * path used for export and when no GL context is available (spec 03 §5.3).
 *
 * Blending happens on ENCODED channel values (Photoshop's default), not linear light.
 */
import type { BlendMode } from '@umbra/core/blend';

export type Rgb = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- separable modes -----------------------------------------------------------------

/** B(backdrop, source) for one channel. */
export type SeparableBlend = (b: number, s: number) => number;

function colorBurn(b: number, s: number): number {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}

function colorDodge(b: number, s: number): number {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
}

function hardLight(b: number, s: number): number {
  return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
}

/**
 * The community "Photoshop" form. It is algebraically identical to the PDF/W3C form except
 * where `s > 0.5 && b <= 0.25`, where W3C substitutes a cubic for the square root. Which one
 * Photoshop actually ships is tagged [fit] in the spec and is settled by the golden matrix.
 */
function softLight(b: number, s: number): number {
  return s <= 0.5
    ? 2 * b * s + b * b * (1 - 2 * s)
    : 2 * b * (1 - s) + Math.sqrt(b) * (2 * s - 1);
}

export const SEPARABLE: Partial<Record<BlendMode, SeparableBlend>> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s, // coverage is thresholded in the compositor, not here
  darken: (b, s) => Math.min(b, s),
  multiply: (b, s) => b * s,
  colorBurn,
  linearBurn: (b, s) => Math.max(0, b + s - 1),
  lighten: (b, s) => Math.max(b, s),
  screen: (b, s) => b + s - b * s,
  colorDodge,
  linearDodge: (b, s) => Math.min(1, b + s),
  overlay: (b, s) => hardLight(s, b),
  softLight,
  hardLight,
  vividLight: (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1)),
  linearLight: (b, s) => clamp01(b + 2 * s - 1),
  pinLight: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  hardMix: (b, s) => (b + s >= 1 ? 1 : 0),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? 1 : Math.min(1, b / s)),
};

// ---- non-separable helpers (spec 06 §2.1) ---------------------------------------------

export function lum(c: Rgb): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

export function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: Rgb = [c[0], c[1], c[2]];
  if (n < 0) {
    const d = l - n;
    out = d === 0 ? [l, l, l] : [
      l + ((out[0] - l) * l) / d,
      l + ((out[1] - l) * l) / d,
      l + ((out[2] - l) * l) / d,
    ];
  }
  if (x > 1) {
    const d = x - l;
    out = d === 0 ? [l, l, l] : [
      l + ((out[0] - l) * (1 - l)) / d,
      l + ((out[1] - l) * (1 - l)) / d,
      l + ((out[2] - l) * (1 - l)) / d,
    ];
  }
  return out;
}

export function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

export function sat(c: Rgb): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

export function setSat(c: Rgb, s: number): Rgb {
  // Order the channels, rescale the mid value into [0,s], and zero the minimum.
  const idx: [number, number, number] = [0, 1, 2];
  idx.sort((a, b) => c[a]! - c[b]!);
  const [lo, mid, hi] = idx;
  const out: Rgb = [0, 0, 0];
  if (c[hi!]! > c[lo!]!) {
    out[mid!] = ((c[mid!]! - c[lo!]!) * s) / (c[hi!]! - c[lo!]!);
    out[hi!] = s;
  }
  out[lo!] = 0;
  return out;
}

/** Whole-pixel blend for the six modes that are not per-channel. */
export function blendNonSeparable(mode: BlendMode, b: Rgb, s: Rgb): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(s, sat(b)), lum(b));
    case 'saturation':
      return setLum(setSat(b, sat(s)), lum(b));
    case 'color':
      return setLum(s, lum(b));
    case 'luminosity':
      return setLum(b, lum(s));
    case 'darkerColor':
      return lum(s) < lum(b) ? [...s] as Rgb : [...b] as Rgb;
    case 'lighterColor':
      return lum(s) > lum(b) ? [...s] as Rgb : [...b] as Rgb;
    default:
      return [...s] as Rgb;
  }
}

export const NON_SEPARABLE_MODES: ReadonlySet<BlendMode> = new Set<BlendMode>([
  'hue',
  'saturation',
  'color',
  'luminosity',
  'darkerColor',
  'lighterColor',
]);

/** Apply a blend mode to a whole pixel, separable or not. */
export function blendPixel(mode: BlendMode, b: Rgb, s: Rgb): Rgb {
  if (NON_SEPARABLE_MODES.has(mode)) return blendNonSeparable(mode, b, s);
  const fn = SEPARABLE[mode] ?? SEPARABLE.normal!;
  return [fn(b[0], s[0]), fn(b[1], s[1]), fn(b[2], s[2])];
}

// ---- Fill vs Opacity for the "special 8" (spec 06 §3.1) --------------------------------

/**
 * For these modes Fill is applied INSIDE the blend function rather than as coverage, which is
 * why Fill 50% and Opacity 50% look different. The source is mixed toward the mode's neutral
 * colour — the value that makes the blend a no-op.
 */
export const SPECIAL_FILL_NEUTRAL: Partial<Record<BlendMode, number>> = {
  colorBurn: 1,
  linearBurn: 1,
  colorDodge: 0,
  linearDodge: 0,
  difference: 0,
  vividLight: 0.5,
  linearLight: 0.5,
  hardMix: 0.5,
};

export function isSpecialFillMode(mode: BlendMode): boolean {
  return mode in SPECIAL_FILL_NEUTRAL;
}

/**
 * Hard Mix's response to Fill is its own case: the public evidence is the number of output
 * levels (27 at Fill 90%, 129 at Fill 50%), which implies a slope of 1/(1-fill). The offset
 * term is a hypothesis and is tagged [fit] in the spec — the golden matrix decides it.
 */
export function hardMixWithFill(b: number, s: number, fill: number): number {
  if (fill >= 1) return b + s >= 1 ? 1 : 0;
  return clamp01((b + fill * s - fill) / (1 - fill));
}

/** Source colour after Fill has been folded in, for a special-fill mode. */
export function applySpecialFill(mode: BlendMode, s: Rgb, fill: number): Rgb {
  const neutral = SPECIAL_FILL_NEUTRAL[mode];
  if (neutral === undefined) return s;
  return [
    neutral + (s[0] - neutral) * fill,
    neutral + (s[1] - neutral) * fill,
    neutral + (s[2] - neutral) * fill,
  ];
}

// ---- the general compositing equation (spec 06 §1) --------------------------------------

export interface Composited {
  color: Rgb;
  alpha: number;
}

/**
 * Cr = [ (1-αs)·αb·Cb + αs·( (1-αb)·Cs + αb·B(Cb,Cs) ) ] / αr
 *
 * Where the backdrop is transparent the source shows through unblended, which is what makes
 * a Multiply layer over nothing still visible.
 */
export function compositePixel(
  mode: BlendMode,
  backdrop: Rgb,
  backdropAlpha: number,
  source: Rgb,
  sourceAlpha: number,
): Composited {
  const ab = backdropAlpha;
  const as = sourceAlpha;
  const ar = as + ab * (1 - as);
  if (ar <= 0) return { color: [0, 0, 0], alpha: 0 };

  const blended = blendPixel(mode, backdrop, source);
  const color: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const mixed = (1 - ab) * source[i]! + ab * blended[i]!;
    color[i] = ((1 - as) * ab * backdrop[i]! + as * mixed) / ar;
  }
  return { color, alpha: ar };
}

// ---- dissolve ---------------------------------------------------------------------------

/**
 * Position-stable hash noise. Dissolve thresholds coverage against this rather than blending,
 * and the pattern must not change as the view scrolls or the layer re-renders. Photoshop's own
 * PRNG is unknown, so this is matched statistically rather than exactly (spec 06 §2).
 */
export function dissolveNoise(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
