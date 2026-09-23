/**
 * The healing and content-aware tools' pixel work — spec 04 §4.2: Healing Brush, Spot Healing
 * (content-aware, create texture, proximity match), Remove, Patch, Content-Aware Move,
 * Content-Aware Fill and Red Eye. Each takes the layer's pixels (or, with Sample All Layers,
 * the composite) over a working rectangle, and returns new layer pixels.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { heal } from '@umbra/kernels/heal';
import { inpaint } from '@umbra/kernels/patchmatch';
import type { Plane } from './tiles/plane.js';

export interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Straight RGBA of a plane over a rectangle, 0…1. */
export function readRect(plane: Plane, r: IRect): { rgb: Float32Array; alpha: Float32Array; w: number; h: number } {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const rgb = new Float32Array(w * h * 3);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = r.x0 + x;
      const Y = r.y0 + y;
      const t = plane.tileAt(X >> TILE_SHIFT, Y >> TILE_SHIFT);
      const o = t.uniform ? 0 : ((Y & (TILE_SIZE - 1)) * TILE_SIZE + (X & (TILE_SIZE - 1))) * 4;
      const i = y * w + x;
      rgb[i * 3] = t.data[o]! / 255;
      rgb[i * 3 + 1] = t.data[o + 1]! / 255;
      rgb[i * 3 + 2] = t.data[o + 2]! / 255;
      alpha[i] = t.data[o + 3]! / 255;
    }
  }
  return { rgb, alpha, w, h };
}

/**
 * Write `rgb` into a copy of `plane` over `r`, blended by `weight` (0…1 per pixel). Alpha
 * rises to the weight where the layer was transparent (Sample All Layers onto an empty layer).
 */
export function writeRect(plane: Plane, r: IRect, rgb: Float32Array, weight: Float32Array, fillAlpha = false): Plane {
  const w = r.x1 - r.x0;
  const writer = plane.writer();
  for (let y = 0; y < r.y1 - r.y0; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = weight[i]!;
      if (k <= 0) continue;
      const X = r.x0 + x;
      const Y = r.y0 + y;
      const d = writer.mutable(X >> TILE_SHIFT, Y >> TILE_SHIFT);
      const o = ((Y & (TILE_SIZE - 1)) * TILE_SIZE + (X & (TILE_SIZE - 1))) * 4;
      const a0 = d[o + 3]! / 255;
      const a1 = fillAlpha ? Math.max(a0, k) : a0;
      for (let c = 0; c < 3; c++) {
        const v0 = d[o + c]! / 255;
        // Premultiplied mix, then back to straight.
        const pm = v0 * a0 * (1 - k) + rgb[i * 3 + c]! * (fillAlpha ? 1 : a0) * k;
        d[o + c] = a1 > 0 ? Math.round(Math.max(0, Math.min(1, pm / a1)) * 255) : 0;
      }
      d[o + 3] = Math.round(a1 * 255);
    }
  }
  return writer.commit();
}

/** Grow a rectangle, clipped to the canvas. */
export function grow(r: IRect, by: number, W: number, H: number): IRect {
  return { x0: Math.max(0, r.x0 - by), y0: Math.max(0, r.y0 - by), x1: Math.min(W, r.x1 + by), y1: Math.min(H, r.y1 + by) };
}

/** Dilate a binary mask by `n` pixels (square). */
function dilate(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let cur = m;
  for (let k = 0; k < n; k++) {
    const out = Uint8Array.from(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1]) || (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) out[y * w + x] = 1;
      }
    cur = out;
  }
  return cur;
}

/**
 * Healing Brush, at the end of its stroke: the cloned pixels (the stroke buffer's colour,
 * where its coverage is) are healed into the layer. Returns the healed colours for the
 * stroke buffer (same coverage).
 */
export function healStroke(layer: Plane, strokeRgb: Float32Array, strokeAlpha: Float32Array, r: IRect, diffusion: number): Float32Array {
  const { rgb: dest } = readRect(layer, r);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const region = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) region[i] = strokeAlpha[i]! > 0 ? 1 : 0;
  // The source outside the stroke is unknown; the membrane only needs its boundary, which the
  // ring of destination pixels provides, so extend the source by the destination there.
  const src = Float32Array.from(dest);
  for (let i = 0; i < w * h; i++) if (region[i]) src.set(strokeRgb.subarray(i * 3, i * 3 + 3), i * 3);
  return heal(src, dest, region, w, h, diffusion);
}

export type SpotType = 'contentAware' | 'createTexture' | 'proximityMatch';

/**
 * Spot Healing and Remove, at the end of the stroke: the painted area (`cover` over `r`,
 * already grown by a margin to sample from) is filled.
 * - Content-Aware: PatchMatch completion from the surroundings.
 * - Create Texture [fit]: the same with small patches (texture rather than structure), healed
 *   to the surrounding tone.
 * - Proximity Match: the best-matching nearby area of the same shape, copied and healed.
 */
export function spotHeal(source: Plane, r: IRect, cover: Float32Array, type: SpotType, seed = 1): { rgb: Float32Array; weight: Float32Array } {
  const { rgb } = readRect(source, r);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const hole0 = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) hole0[i] = cover[i]! > 0.02 ? 1 : 0;
  // A pixel of slack, so the fill's seam lies outside what was painted.
  const hole = dilate(hole0, w, h, 2);
  let out: Float32Array;
  if (type === 'proximityMatch') out = proximity(rgb, hole, w, h);
  else if (type === 'createTexture') out = heal(inpaint(rgb, w, h, hole, { patch: 5, seed }), rgb, hole, w, h, 3);
  else out = inpaint(rgb, w, h, hole, { seed });
  // Blend: fully inside the grown hole, feathered by the stroke's own soft edge outside it.
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) weight[i] = hole[i] ? 1 : 0;
  return { rgb: out, weight };
}

/** Proximity Match: try the hole's box shifted around it; take the best boundary match; heal. */
function proximity(rgb: Float32Array, hole: Uint8Array, w: number, h: number): Float32Array {
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (hole[y * w + x]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
  const bw = x1 - x0;
  const bh = y1 - y0;
  // The ring just outside the hole: what a candidate must match.
  const ring = dilate(hole, w, h, 3);
  let best = { dx: 0, dy: 0, e: Infinity };
  for (let dy = -2 * bh; dy <= 2 * bh; dy += Math.max(1, bh >> 2)) {
    for (let dx = -2 * bw; dx <= 2 * bw; dx += Math.max(1, bw >> 2)) {
      if (Math.abs(dx) < bw && Math.abs(dy) < bh) continue;
      let e = 0;
      let n = 0;
      let ok = true;
      for (let y = y0 - 3; y < y1 + 3 && ok; y++) {
        for (let x = x0 - 3; x < x1 + 3; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (!ring[i]) continue;
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h || ring[sy * w + sx]) {
            ok = false;
            break;
          }
          if (hole[i]) continue;
          const j = sy * w + sx;
          for (let c = 0; c < 3; c++) e += (rgb[i * 3 + c]! - rgb[j * 3 + c]!) ** 2;
          n++;
        }
      }
      if (ok && n && e / n < best.e) best = { dx, dy, e: e / n };
    }
  }
  if (!Number.isFinite(best.e)) return inpaint(rgb, w, h, hole);
  const src = Float32Array.from(rgb);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const j = (y + best.dy) * w + (x + best.dx);
      src.set(rgb.subarray(j * 3, j * 3 + 3), i * 3);
    }
  return heal(src, rgb, hole, w, h, 5);
}

/**
 * Patch (and Content-Aware Move's placing step): the area `mask` over `r` takes the pixels
 * from `delta` away. Normal heals them in (Poisson); Content-Aware fills with PatchMatch,
 * sampling only the source area. Returns colours over `r` and their weight.
 */
export function patchArea(source: Plane, r: IRect, mask: Float32Array, delta: { dx: number; dy: number }, contentAware: boolean, seed = 1): { rgb: Float32Array; weight: Float32Array } {
  const { rgb } = readRect(source, r);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const hole = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) hole[i] = mask[i]! > 0.5 ? 1 : 0;
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) weight[i] = mask[i]!;
  if (contentAware) {
    // Sample only the source area: the patch shifted by the drag.
    const allowed = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = x - delta.dx;
        const sy = y - delta.dy;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h && hole[sy * w + sx]) allowed[y * w + x] = 1;
      }
    // A generous band of the source's surroundings too, so patches fit.
    const band = dilate(allowed, w, h, 6);
    for (let i = 0; i < w * h; i++) band[i] = band[i] && !hole[i] ? 1 : 0;
    return { rgb: inpaint(rgb, w, h, hole, { allowed: band, seed }), weight };
  }
  const src = Float32Array.from(rgb);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const sx = Math.min(w - 1, Math.max(0, x + delta.dx));
      const sy = Math.min(h - 1, Math.max(0, y + delta.dy));
      src.set(rgb.subarray((sy * w + sx) * 3, (sy * w + sx) * 3 + 3), i * 3);
    }
  return { rgb: heal(src, rgb, hole, w, h, 5), weight };
}

/**
 * Red Eye: around the click, the connected region of strongly red pixels (the pupil) is
 * desaturated and darkened by Darken Amount; Pupil Size bounds how far it may reach.
 */
export function redEye(layer: Plane, cx: number, cy: number, W: number, H: number, pupilSize: number, darken: number): Plane | null {
  const reach = Math.max(8, Math.round(40 * pupilSize));
  const r = grow({ x0: Math.floor(cx), y0: Math.floor(cy), x1: Math.floor(cx) + 1, y1: Math.floor(cy) + 1 }, reach, W, H);
  const { rgb, alpha, w, h } = readRect(layer, r);
  const redness = (i: number) => {
    const R = rgb[i * 3]!;
    const G = rgb[i * 3 + 1]!;
    const B = rgb[i * 3 + 2]!;
    return R > 0.25 && R > 1.5 * Math.max(G, B) ? (R - Math.max(G, B)) / R : 0;
  };
  // Seed: the reddest pixel near the click.
  let seed = -1;
  let best = 0;
  const px = Math.floor(cx) - r.x0;
  const py = Math.floor(cy) - r.y0;
  for (let y = Math.max(0, py - 6); y < Math.min(h, py + 7); y++)
    for (let x = Math.max(0, px - 6); x < Math.min(w, px + 7); x++) {
      const v = redness(y * w + x);
      if (v > best) {
        best = v;
        seed = y * w + x;
      }
    }
  if (seed < 0) return null;
  const inside = new Uint8Array(w * h);
  const stack = [seed];
  inside[seed] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (inside[j] || redness(j) <= 0.15) continue;
      inside[j] = 1;
      stack.push(j);
    }
  }
  // Soft edge: a pixel of feathering around the pupil.
  const soft = dilate(inside, w, h, 1);
  const out = Float32Array.from(rgb);
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!soft[i] || alpha[i]! <= 0) continue;
    const G = rgb[i * 3 + 1]!;
    const B = rgb[i * 3 + 2]!;
    // The red channel takes the others' level, then everything darkens.
    const base = (G + B) / 2;
    const k = 1 - darken * 0.8;
    out[i * 3] = base * k;
    out[i * 3 + 1] = G * k;
    out[i * 3 + 2] = B * k;
    weight[i] = inside[i] ? 1 : 0.5;
  }
  return writeRect(layer, r, out, weight);
}
