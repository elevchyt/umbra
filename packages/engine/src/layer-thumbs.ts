/**
 * Layers-panel thumbnails: each layer's own pixels (and its mask) shrunk to fit a small box
 * with the document's aspect, as Photoshop draws them. Point-sampled on a small grid per
 * output pixel straight from the tiles, so a thumbnail costs a few thousand pixel reads no
 * matter how large the document is, and is memoised on the plane — planes are immutable, so a
 * layer nobody edited is never sampled twice.
 */
import { channelCount, maxValue, type TypedPixels } from '@umbra/core/pixels';
import type { Plane } from './tiles/plane.js';

export interface LayerThumb {
  width: number;
  height: number;
  /** Straight RGBA, 8 bits. A mask comes back grey and opaque. */
  pixels: Uint8Array;
}

/** Samples per axis inside each thumbnail pixel. */
const SUPER = 3;

const cache = new WeakMap<Plane, { key: string; thumb: LayerThumb }>();

/** Thumbnail box for a document: the long side is `size`, the short one keeps the aspect. */
export function thumbSize(docW: number, docH: number, size: number): { width: number; height: number } {
  const k = size / Math.max(docW, docH, 1);
  return { width: Math.max(1, Math.round(docW * k)), height: Math.max(1, Math.round(docH * k)) };
}

export function planeThumb(plane: Plane, docW: number, docH: number, size: number): LayerThumb {
  const key = `${docW}x${docH}@${size}`;
  const hit = cache.get(plane);
  if (hit && hit.key === key) return hit.thumb;

  const { width, height } = thumbSize(docW, docH, size);
  const n = channelCount(plane.format.layout);
  const max = maxValue(plane.format.sample);
  const s = plane.format.sample;
  const px: TypedPixels = s === 'u8' ? new Uint8Array(n) : s === 'u16' ? new Uint16Array(n) : new Float32Array(n);
  const out = new Uint8Array(width * height * 4);
  const sx = docW / width;
  const sy = docH / height;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let v = 0; v < SUPER; v++) {
        const y = Math.min(docH - 1, Math.floor((j + (v + 0.5) / SUPER) * sy));
        for (let u = 0; u < SUPER; u++) {
          const x = Math.min(docW - 1, Math.floor((i + (u + 0.5) / SUPER) * sx));
          plane.readPixel(x, y, px);
          if (n === 1) {
            // A mask: coverage shown as grey.
            r += px[0]! / max;
            a += 1;
          } else {
            const al = px[n - 1]! / max;
            const c = px[0]! / max;
            // Weighted by alpha, so transparent neighbours do not darken the colour.
            r += c * al;
            g += (n === 4 ? px[1]! / max : c) * al;
            b += (n === 4 ? px[2]! / max : c) * al;
            a += al;
          }
        }
      }
      const o = (j * width + i) * 4;
      const count = SUPER * SUPER;
      if (n === 1) {
        const grey = Math.round((r / count) * 255);
        out[o] = out[o + 1] = out[o + 2] = grey;
        out[o + 3] = 255;
      } else if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
        out[o + 3] = Math.round((a / count) * 255);
      }
    }
  }
  const thumb = { width, height, pixels: out };
  cache.set(plane, { key, thumb });
  return thumb;
}
