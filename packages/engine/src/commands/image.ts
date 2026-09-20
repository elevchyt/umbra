/**
 * Document-level image commands — spec 01 §3 (Image menu), spec 02 §1.
 *
 * Canvas Size, Image Rotation, Trim and Reveal All only move pixels around, so they are exact.
 * Image Size resamples, and its interpolation choice is the one Photoshop exposes; the kernel
 * constants that decide how close a match it is are tagged [fit] in spec 05 §7.
 */
import { TILE_SIZE, TILE_SHIFT, channelCount, maxValue } from '@umbra/core/pixels';
import { rectUnion, rectIsEmpty, type Rect } from '@umbra/core/geom';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import { tightBounds } from '../psd-save.js';
import { walkLayers, type Doc, type Layer } from '../document.js';

export type Resample =
  | 'nearest'
  | 'bilinear'
  | 'bicubic'
  | 'bicubicSmoother'
  | 'bicubicSharper';

/** Keys cubic. `a` controls the overshoot; Photoshop's three bicubic modes differ here. */
function keysKernel(x: number, a: number): number {
  const t = Math.abs(x);
  if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
  if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
  return 0;
}

const KERNEL_A: Record<string, number> = {
  // Community measurement puts Photoshop's plain Bicubic near -0.75; Smoother/Sharper are
  // softer and harder variants. Tagged [fit] until goldens settle them (spec 05 §7).
  bicubic: -0.75,
  bicubicSmoother: -0.4,
  bicubicSharper: -1.0,
};

/** Sample a plane with straight alpha, premultiplying so transparent pixels cannot bleed. */
function sampleBilinear(read: (x: number, y: number, out: Float32Array) => void, x: number, y: number, out: Float32Array): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const p = new Float32Array(4);
  out.fill(0);
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= 1; i++) {
      read(x0 + i, y0 + j, p);
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      // Premultiplied accumulation.
      out[0]! += p[0]! * p[3]! * w;
      out[1]! += p[1]! * p[3]! * w;
      out[2]! += p[2]! * p[3]! * w;
      out[3]! += p[3]! * w;
    }
  }
}

function sampleCubic(
  read: (x: number, y: number, out: Float32Array) => void,
  x: number,
  y: number,
  a: number,
  out: Float32Array,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const p = new Float32Array(4);
  out.fill(0);
  let wsum = 0;
  for (let j = -1; j <= 2; j++) {
    const wy = keysKernel(y - (y0 + j), a);
    if (wy === 0) continue;
    for (let i = -1; i <= 2; i++) {
      const wx = keysKernel(x - (x0 + i), a);
      if (wx === 0) continue;
      read(x0 + i, y0 + j, p);
      const w = wx * wy;
      out[0]! += p[0]! * p[3]! * w;
      out[1]! += p[1]! * p[3]! * w;
      out[2]! += p[2]! * p[3]! * w;
      out[3]! += p[3]! * w;
      wsum += w;
    }
  }
  if (wsum !== 0) for (let c = 0; c < 4; c++) out[c]! /= wsum;
}

/**
 * Read a pixel as normalised RGBA regardless of the plane's channel layout.
 *
 * Masks are single-channel, and every one of these commands is applied to a layer's mask as
 * well as to its pixels. Assuming RGBA here reads four bytes out of a one-byte-per-pixel tile,
 * which silently destroys the mask — so the layout has to be respected.
 */
function planeReader(plane: Plane): (x: number, y: number, out: Float32Array) => void {
  const n = channelCount(plane.format.layout);
  const max = maxValue(plane.format.sample);
  return (x, y, out) => {
    const tile = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const o = tile.uniform
      ? 0
      : ((y - ((y >> TILE_SHIFT) << TILE_SHIFT)) * TILE_SIZE + (x - ((x >> TILE_SHIFT) << TILE_SHIFT))) * n;
    if (n === 1) {
      // Coverage travels in the alpha slot so the shared resampling maths applies unchanged.
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = tile.data[o]! / max;
      return;
    }
    out[0] = tile.data[o]! / max;
    out[1] = tile.data[o + 1]! / max;
    out[2] = tile.data[o + 2]! / max;
    out[3] = tile.data[o + 3]! / max;
  };
}

/** Writer matching `planeReader`, so single-channel planes stay single-channel. */
function planeWriter(plane: Plane) {
  const n = channelCount(plane.format.layout);
  const writer = Plane.empty(plane.format, n === 1 ? [0] : undefined).writer();
  const put = (x: number, y: number, px: Float32Array): void => {
    const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const o = ((y - ((y >> TILE_SHIFT) << TILE_SHIFT)) * TILE_SIZE + (x - ((x >> TILE_SHIFT) << TILE_SHIFT))) * n;
    if (n === 1) {
      data[o] = Math.round(Math.min(1, Math.max(0, px[3]!)) * 255);
      return;
    }
    data[o] = Math.round(px[0]! * 255);
    data[o + 1] = Math.round(px[1]! * 255);
    data[o + 2] = Math.round(px[2]! * 255);
    data[o + 3] = Math.round(px[3]! * 255);
  };
  return { writer, put, channels: n };
}

/** Resample a plane by an arbitrary scale factor. */
export function resamplePlane(plane: Plane, sx: number, sy: number, method: Resample, bounds: Rect): Plane {
  const { writer, put, channels } = planeWriter(plane);
  if (rectIsEmpty(bounds)) return writer.commit();
  const read = planeReader(plane);
  const px = new Float32Array(4);
  const a = KERNEL_A[method];

  const dx0 = Math.floor(bounds.x0 * sx);
  const dy0 = Math.floor(bounds.y0 * sy);
  const dx1 = Math.ceil(bounds.x1 * sx);
  const dy1 = Math.ceil(bounds.y1 * sy);

  for (let y = dy0; y < dy1; y++) {
    // Map the destination pixel centre back into source space.
    const srcY = (y + 0.5) / sy - 0.5;
    for (let x = dx0; x < dx1; x++) {
      const srcX = (x + 0.5) / sx - 0.5;
      if (method === 'nearest') read(Math.round(srcX), Math.round(srcY), px);
      else if (method === 'bilinear') sampleBilinear(read, srcX, srcY, px);
      else sampleCubic(read, srcX, srcY, a ?? -0.75, px);

      const alpha = method === 'nearest' ? px[3]! : Math.min(1, Math.max(0, px[3]!));
      if (alpha <= 0) continue;
      const out = new Float32Array(4);
      out[3] = alpha;
      if (channels > 1) {
        if (method === 'nearest') {
          out[0] = px[0]!;
          out[1] = px[1]!;
          out[2] = px[2]!;
        } else {
          // Un-premultiply, clamping colour to alpha so cubic overshoot cannot make a pixel
          // brighter than it is opaque.
          for (let c = 0; c < 3; c++) out[c] = Math.min(1, Math.min(alpha, Math.max(0, px[c]!)) / alpha);
        }
      }
      put(x, y, out);
    }
  }
  return writer.commit();
}

function mapLayers(layers: readonly Layer[], fn: (p: Plane) => Plane): Layer[] {
  return layers.map((l) => {
    const mask = l.mask ? { ...l.mask, plane: new MipPlane(fn(l.mask.plane.base)) } : l.mask;
    if (l.kind === 'group') return { ...l, mask, children: mapLayers(l.children, fn) };
    return { ...l, mask, plane: new MipPlane(fn(l.plane.base)) };
  });
}

export function imageSize(doc: Doc, width: number, height: number, method: Resample = 'bicubic'): Doc {
  if (width === doc.width && height === doc.height) return doc;
  const sx = width / doc.width;
  const sy = height / doc.height;
  const bounds: Rect = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  return {
    ...doc,
    width,
    height,
    layers: mapLayers(doc.layers, (p) => resamplePlane(p, sx, sy, method, bounds)),
  };
}

export type Anchor =
  | 'topLeft' | 'top' | 'topRight'
  | 'left' | 'center' | 'right'
  | 'bottomLeft' | 'bottom' | 'bottomRight';

/** Offset that places the old canvas inside the new one for a given anchor. */
export function anchorOffset(anchor: Anchor, dw: number, dh: number): { dx: number; dy: number } {
  const col = anchor.includes('Left') || anchor === 'left' ? 0 : anchor.includes('Right') || anchor === 'right' ? 2 : 1;
  const row = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 2 : 1;
  return { dx: Math.round((dw * col) / 2), dy: Math.round((dh * row) / 2) };
}

function remapPlane(
  plane: Plane,
  source: Rect,
  map: (x: number, y: number) => { x: number; y: number },
): Plane {
  const { writer, put } = planeWriter(plane);
  if (rectIsEmpty(source)) return writer.commit();
  const read = planeReader(plane);
  const px = new Float32Array(4);
  for (let y = source.y0; y < source.y1; y++) {
    for (let x = source.x0; x < source.x1; x++) {
      read(x, y, px);
      if (px[3]! <= 0) continue;
      const p = map(x, y);
      put(p.x, p.y, px);
    }
  }
  return writer.commit();
}

function translatePlane(plane: Plane, dx: number, dy: number): Plane {
  if (dx === 0 && dy === 0) return plane;
  return remapPlane(plane, plane.bounds, (x, y) => ({ x: x + dx, y: y + dy }));
}

export function canvasSize(doc: Doc, width: number, height: number, anchor: Anchor = 'center'): Doc {
  const { dx, dy } = anchorOffset(anchor, width - doc.width, height - doc.height);
  return { ...doc, width, height, layers: mapLayers(doc.layers, (p) => translatePlane(p, dx, dy)) };
}

/** Grow the canvas to include every pixel that currently sits outside it. */
export function revealAll(doc: Doc): Doc {
  let bounds: Rect = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  for (const { layer } of walkLayers(doc.layers)) {
    if (layer.kind === 'pixel') bounds = rectUnion(bounds, tightBounds(layer.plane.base));
  }
  const dx = -bounds.x0;
  const dy = -bounds.y0;
  return {
    ...doc,
    width: bounds.x1 - bounds.x0,
    height: bounds.y1 - bounds.y0,
    layers: mapLayers(doc.layers, (p) => translatePlane(p, dx, dy)),
  };
}

/** Shrink the canvas to the union of the layers' non-transparent pixels. */
export function trim(doc: Doc): Doc {
  let bounds: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let any = false;
  for (const { layer } of walkLayers(doc.layers)) {
    if (layer.kind !== 'pixel') continue;
    const b = tightBounds(layer.plane.base);
    if (rectIsEmpty(b)) continue;
    any = true;
    bounds = rectUnion(rectIsEmpty(bounds) ? b : bounds, b);
  }
  if (!any) return doc;
  const clipped: Rect = {
    x0: Math.max(0, bounds.x0),
    y0: Math.max(0, bounds.y0),
    x1: Math.min(doc.width, bounds.x1),
    y1: Math.min(doc.height, bounds.y1),
  };
  return {
    ...doc,
    width: clipped.x1 - clipped.x0,
    height: clipped.y1 - clipped.y0,
    layers: mapLayers(doc.layers, (p) => translatePlane(p, -clipped.x0, -clipped.y0)),
  };
}

export type Rotation = 90 | 180 | 270;

function rotatePlane(plane: Plane, angle: Rotation, w: number, h: number): Plane {
  // Destination coordinates for a clockwise rotation of the canvas.
  return remapPlane(plane, { x0: 0, y0: 0, x1: w, y1: h }, (x, y) => ({
    x: angle === 90 ? h - 1 - y : angle === 180 ? w - 1 - x : y,
    y: angle === 90 ? x : angle === 180 ? h - 1 - y : w - 1 - x,
  }));
}

export function rotateImage(doc: Doc, angle: Rotation): Doc {
  const swap = angle !== 180;
  return {
    ...doc,
    width: swap ? doc.height : doc.width,
    height: swap ? doc.width : doc.height,
    layers: mapLayers(doc.layers, (p) => rotatePlane(p, angle, doc.width, doc.height)),
  };
}

function flipPlane(plane: Plane, horizontal: boolean, w: number, h: number): Plane {
  return remapPlane(plane, { x0: 0, y0: 0, x1: w, y1: h }, (x, y) => ({
    x: horizontal ? w - 1 - x : x,
    y: horizontal ? y : h - 1 - y,
  }));
}

export function flipImage(doc: Doc, horizontal: boolean): Doc {
  return { ...doc, layers: mapLayers(doc.layers, (p) => flipPlane(p, horizontal, doc.width, doc.height)) };
}
