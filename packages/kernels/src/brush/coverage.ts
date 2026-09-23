/**
 * The CPU reference for a dab's coverage — what the GPU dab shader draws, pixel for pixel in
 * intent: the computed round tip or a sampled bitmap tip (rotated, squashed, flipped), masked
 * by the dual brush's stamps in its mode, textured by a pattern in its mode, with noise on the
 * soft edges. It paints brush previews, feeds the retouching tools (which work on the CPU), and
 * is what the tests hold the brush to.
 */
import type { Dab, DualStamp } from '../brush.js';
import type { DualMode, TextureMode } from './model.js';
import { hash01 } from './rng.js';

/** A sampled tip: 8-bit coverage, row-major. */
export interface TipBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A texture pattern for the brush: luminance 0…1, repeating. */
export interface BrushPattern {
  width: number;
  height: number;
  lum: Float32Array;
}

export interface CoverageContext {
  tips?: (id: string) => TipBitmap | undefined;
  /** The dual brush's tip (sampled) and hardness (computed), and how it combines. */
  dual?: { tip?: TipBitmap; hardness: number; mode: DualMode };
  texture?: { pattern: BrushPattern; scale: number; invert: boolean; brightness: number; contrast: number; mode: TextureMode };
  noise?: boolean;
  noiseSeed?: number;
}

const smooth = (t: number) => 1 - t * t * (3 - 2 * t);

/** A bilinear sample of a tip bitmap at normalised (u, v) in [0, 1]². */
function sampleTip(t: TipBitmap, u: number, v: number): number {
  if (u < 0 || v < 0 || u > 1 || v > 1) return 0;
  const x = u * t.width - 0.5;
  const y = v * t.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= t.width || j >= t.height ? 0 : t.data[j * t.width + i]! / 255);
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * The shape of a tip at a point, 0…1, before flow: rotated into tip space, the minor axis
 * squashed by roundness, flipped. A sampled tip fills the dab's box with its longer side.
 */
export function tipShape(
  s: { x: number; y: number; radius: number; angle: number; roundness: number; flipX?: boolean; flipY?: boolean },
  hardness: number,
  tip: TipBitmap | undefined,
  x: number,
  y: number,
): number {
  const dx = x - s.x;
  const dy = y - s.y;
  const c = Math.cos(-s.angle);
  const sn = Math.sin(-s.angle);
  let rx = dx * c - dy * sn;
  let ry = (dx * sn + dy * c) / Math.max(0.01, s.roundness);
  if (s.flipX) rx = -rx;
  if (s.flipY) ry = -ry;
  if (tip) {
    const m = Math.max(tip.width, tip.height);
    const u = 0.5 + (rx / (2 * s.radius)) * (m / tip.width);
    const v = 0.5 + (ry / (2 * s.radius)) * (m / tip.height);
    return sampleTip(tip, u, v);
  }
  const d = Math.hypot(rx, ry);
  const inner = s.radius * hardness;
  const outer = Math.max(s.radius, inner + 0.5);
  if (d >= outer) return 0;
  if (d <= inner) return 1;
  return smooth((d - inner) / (outer - inner));
}

/** How the dual brush's coverage `s` shapes the primary's `p`. */
export function dualBlend(mode: DualMode, p: number, s: number): number {
  switch (mode) {
    case 'multiply':
      return p * s;
    case 'darken':
      return Math.min(p, s);
    case 'overlay':
      return p < 0.5 ? 2 * p * s : 1 - 2 * (1 - p) * (1 - s);
    case 'colorDodge':
      return s >= 1 ? (p > 0 ? 1 : 0) : Math.min(1, p / (1 - s)) * s;
    case 'colorBurn':
      return s <= 0 ? 0 : Math.max(0, 1 - (1 - p) / s);
    case 'linearBurn':
      return Math.max(0, p + s - 1);
    case 'hardMix':
      return p + s >= 1 ? p : 0;
    case 'linearHeight':
      return Math.max(0, Math.min(1, p * (0.5 + s)));
  }
}

/** How a texture's value `t` (0…1) at `depth` shapes coverage `a`. */
export function textureBlend(mode: TextureMode, a: number, t: number, depth: number): number {
  // Photoshop's texture works like a height: depth scales how far the pattern cuts in.
  const k = Math.max(0, Math.min(1, depth));
  let v: number;
  switch (mode) {
    case 'multiply':
      v = a * t;
      break;
    case 'subtract':
      v = a - (1 - t);
      break;
    case 'darken':
      v = Math.min(a, t);
      break;
    case 'overlay':
      v = a < 0.5 ? 2 * a * t : 1 - 2 * (1 - a) * (1 - t);
      break;
    case 'colorDodge':
      v = t >= 1 ? 1 : Math.min(1, a / (1 - t));
      break;
    case 'colorBurn':
      v = t <= 0 ? 0 : Math.max(0, 1 - (1 - a) / t);
      break;
    case 'linearBurn':
      v = a + t - 1;
      break;
    case 'hardMix':
      v = a + t >= 1 ? 1 : 0;
      break;
    case 'linearHeight':
      v = a * (0.5 + t);
      break;
    case 'height':
      v = a * t * 2;
      break;
  }
  v = Math.max(0, Math.min(1, v));
  return a + (v - a) * k;
}

/** A pattern's value at a document point, after scale, brightness, contrast and invert. */
export function patternAt(tex: NonNullable<CoverageContext['texture']>, x: number, y: number): number {
  const p = tex.pattern;
  const k = Math.max(0.01, tex.scale / 100);
  const px = ((Math.floor(x / k) % p.width) + p.width) % p.width;
  const py = ((Math.floor(y / k) % p.height) + p.height) % p.height;
  let t = p.lum[py * p.width + px]!;
  t = t + tex.brightness / 150;
  t = 0.5 + (t - 0.5) * (1 + tex.contrast / 50);
  t = Math.max(0, Math.min(1, t));
  return tex.invert ? 1 - t : t;
}

/** A dab's coverage at a pixel centre (x + ½, y + ½ is the caller's choice): 0…flow. */
export function dabAlpha(dab: Dab, x: number, y: number, ctx: CoverageContext = {}): number {
  const tip = dab.tip ? ctx.tips?.(dab.tip) : undefined;
  let a = tipShape(dab, dab.hardness, tip, x, y);
  if (a <= 0) return 0;
  if (dab.dual && ctx.dual) {
    let s = 0;
    for (const st of dab.dual as DualStamp[]) s = Math.max(s, tipShape(st, ctx.dual.hardness, ctx.dual.tip, x, y));
    a = dualBlend(ctx.dual.mode, a, s);
  }
  if (ctx.texture && dab.textureDepth !== undefined) a = textureBlend(ctx.texture.mode, a, patternAt(ctx.texture, x, y), dab.textureDepth);
  if (ctx.noise && a > 0 && a < 1) {
    // Noise grains the soft edge only: most where coverage is half, none where it is solid.
    const n = hash01(Math.floor(x), Math.floor(y), ctx.noiseSeed ?? 0) - 0.5;
    a = Math.max(0, Math.min(1, a + n * 4 * a * (1 - a)));
  }
  return a * dab.flow;
}

/**
 * Wet Edges, applied to the stroke's accumulated coverage S [fit]: the middle of the stroke
 * settles to half, the rim rises above it — paint pooling at the edge as it dries.
 */
export function wetEdges(s: number): number {
  return s * (0.5 + 2 * s * (1 - s));
}

/**
 * Render dabs into a coverage buffer on the CPU (S ← S + d·(1 − S) per dab, the stroke
 * buffer's rule): brush previews and tests.
 */
export function renderDabs(dabs: readonly Dab[], width: number, height: number, ctx: CoverageContext = {}, originX = 0, originY = 0): Float32Array {
  const out = new Float32Array(width * height);
  for (const d of dabs) {
    const reach = d.radius / Math.max(0.01, Math.min(1, d.roundness)) + 1;
    const x0 = Math.max(0, Math.floor(d.x - reach - originX));
    const y0 = Math.max(0, Math.floor(d.y - reach - originY));
    const x1 = Math.min(width, Math.ceil(d.x + reach - originX));
    const y1 = Math.min(height, Math.ceil(d.y + reach - originY));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = dabAlpha(d, x + originX + 0.5, y + originY + 0.5, ctx);
        if (a <= 0) continue;
        const i = y * width + x;
        out[i] = out[i]! + a * (1 - out[i]!);
      }
    }
  }
  return out;
}
