/**
 * Image ▸ Apply Image and Image ▸ Calculations — spec 05 §A. Both blend one image (or one
 * channel of it) with another using the layer blend functions of spec 06, plus the two modes
 * only these dialogs have: Add and Subtract, with Scale and Offset — `(a ± b) / scale +
 * offset`, the documented formulas. Calculations works on single channels and produces one.
 */
import type { BlendMode } from '@umbra/core/blend';
import { blendPixel, type Rgb } from './blend.js';

/** Which part of a source image to use. Gray is the luminance of RGB. */
export type ChannelPick = 'rgb' | 'r' | 'g' | 'b' | 'gray' | 'alpha';
export type ApplyBlend = BlendMode | 'add' | 'subtract';

export interface ApplyImageOptions {
  /** A layer of the document, or null for the merged image. */
  sourceLayerId: number | null;
  channel: ChannelPick;
  invert: boolean;
  blend: ApplyBlend;
  /** 0…1 */
  opacity: number;
  /** Add/Subtract only: 1…2 and −255…255. */
  scale: number;
  offset: number;
  preserveTransparency: boolean;
}

export const DEFAULT_APPLY_IMAGE: ApplyImageOptions = {
  sourceLayerId: null,
  channel: 'rgb',
  invert: false,
  blend: 'multiply',
  opacity: 1,
  scale: 1,
  offset: 0,
  preserveTransparency: false,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One channel of a raster pixel, 0…1. */
export function pickChannel(px: ArrayLike<number>, o: number, channel: Exclude<ChannelPick, 'rgb'>): number {
  switch (channel) {
    case 'r':
      return px[o]! / 255;
    case 'g':
      return px[o + 1]! / 255;
    case 'b':
      return px[o + 2]! / 255;
    case 'alpha':
      return px[o + 3]! / 255;
    default:
      return (0.3 * px[o]! + 0.59 * px[o + 1]! + 0.11 * px[o + 2]!) / 255;
  }
}

function blendValues(mode: ApplyBlend, t: Rgb, s: Rgb, scale: number, offset: number): Rgb {
  if (mode === 'add' || mode === 'subtract') {
    const sign = mode === 'add' ? 1 : -1;
    return [0, 1, 2].map((c) => clamp01((t[c]! + sign * s[c]!) / scale + offset / 255)) as unknown as Rgb;
  }
  return blendPixel(mode, t, s);
}

/**
 * Apply Image, in place on `target` (canvas-sized straight RGBA8). Transparent target pixels
 * are left alone — with Preserve Transparency off, Photoshop fills them with the result;
 * here they stay empty either way, since a blend has nothing to act on there. `coverage`
 * (0…255, e.g. the selection) scales the effect.
 */
export function applyImage(
  target: Uint8ClampedArray | Uint8Array,
  source: ArrayLike<number>,
  o: ApplyImageOptions,
  coverage?: Uint8Array,
): void {
  for (let i = 0, p = 0; p < target.length; p += 4, i++) {
    if (target[p + 3] === 0) continue;
    const k = o.opacity * (coverage ? coverage[i]! / 255 : 1);
    if (k <= 0) continue;
    let s: Rgb;
    if (o.channel === 'rgb') s = [source[p]! / 255, source[p + 1]! / 255, source[p + 2]! / 255];
    else {
      const v = pickChannel(source, p, o.channel);
      s = [v, v, v];
    }
    if (o.invert) s = [1 - s[0], 1 - s[1], 1 - s[2]];
    const t: Rgb = [target[p]! / 255, target[p + 1]! / 255, target[p + 2]! / 255];
    const r = blendValues(o.blend, t, s, o.scale, o.offset);
    for (let c = 0; c < 3; c++) target[p + c] = Math.round((t[c]! + (clamp01(r[c]!) - t[c]!) * k) * 255);
  }
}

export interface CalculationsOptions {
  source1: { layerId: number | null; channel: Exclude<ChannelPick, 'rgb'>; invert: boolean };
  source2: { layerId: number | null; channel: Exclude<ChannelPick, 'rgb'>; invert: boolean };
  blend: ApplyBlend;
  opacity: number;
  scale: number;
  offset: number;
  result: 'channel' | 'selection';
}

export const DEFAULT_CALCULATIONS: CalculationsOptions = {
  source1: { layerId: null, channel: 'gray', invert: false },
  source2: { layerId: null, channel: 'gray', invert: false },
  blend: 'multiply',
  opacity: 1,
  scale: 1,
  offset: 0,
  result: 'channel',
};

/** Calculations: source 2 is the backdrop, source 1 blends onto it; one grey channel out. */
export function calculations(a: ArrayLike<number>, b: ArrayLike<number>, o: CalculationsOptions): Uint8Array {
  const n = a.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let s1 = pickChannel(a, p, o.source1.channel);
    let s2 = pickChannel(b, p, o.source2.channel);
    if (o.source1.invert) s1 = 1 - s1;
    if (o.source2.invert) s2 = 1 - s2;
    const r = blendValues(o.blend, [s2, s2, s2], [s1, s1, s1], o.scale, o.offset)[0];
    out[i] = Math.round(clamp01(s2 + (clamp01(r) - s2) * o.opacity) * 255);
  }
  return out;
}
