/**
 * Shape layers and vector masks — spec 02 §2–3, spec 04 §6.
 *
 * A shape layer's pixels are its fill inside the path, with its stroke over them, rendered on
 * the CPU over the path's bounds (grown by the stroke) and kept on the layer. Geometric
 * commands transform the path exactly and re-render. A vector mask is folded into the layer's
 * raster mask for drawing (coverage multiplied), cached per layer until the path, the raster
 * mask or the canvas change.
 */
import { rectIntersect, rectIsEmpty, type Rect } from '@umbra/core/geom';
import { compositePixel } from '@umbra/kernels/blend';
import { fillSampler, type FillContent } from '@umbra/kernels/fill';
import type { Mat } from '@umbra/kernels/matrix';
import { pathBounds, transformPath, type Path } from '@umbra/kernels/vector/path';
import { rasterizePath, rasterizeShapes } from '@umbra/kernels/vector/raster';
import { strokeShapes } from '@umbra/kernels/vector/stroke';
import { liveShapePath, type LiveShape } from '@umbra/kernels/vector/shapes';
import { DEFAULT_BLENDING_STATE, NO_LOCKS, nextLayerId, type Layer, type RasterMask, type ShapeLayer, type VectorStroke } from './document.js';
import { MipPlane } from './tiles/mip.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { planeFromBitmap } from './psd-open.js';
import { bitmapFromPlane } from './psd-save.js';

export interface Size {
  width: number;
  height: number;
}

const MASK8 = { layout: 'A', sample: 'u8' } as const;

/** How far past the path its stroke can reach. */
function strokeReach(stroke: VectorStroke | null): number {
  if (!stroke?.enabled) return 1;
  const w = stroke.style.width;
  const miter = stroke.style.join === 'miter' ? stroke.style.miterLimit : 1;
  return Math.ceil(w * Math.max(1, miter) + 2);
}

/** Render a shape layer's pixels. */
export function renderShape(layer: Pick<ShapeLayer, 'path' | 'fillContent' | 'stroke'>, size: Size): MipPlane {
  const b = pathBounds(layer.path, 0.5);
  const canvas: Rect = { x0: 0, y0: 0, x1: size.width, y1: size.height };
  if (!b) return new MipPlane(Plane.empty(RGBA8));
  const g = strokeReach(layer.stroke);
  const rect = rectIntersect({ x0: Math.floor(b.x0) - g, y0: Math.floor(b.y0) - g, x1: Math.ceil(b.x1) + g, y1: Math.ceil(b.y1) + g }, canvas);
  if (rectIsEmpty(rect)) return new MipPlane(Plane.empty(RGBA8));
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const out = new Uint8Array(w * h * 4);
  const fillCov = layer.fillContent ? rasterizePath(layer.path, rect) : null;
  const fillAt = layer.fillContent ? fillSampler(layer.fillContent, size.width, size.height) : null;
  const s = layer.stroke?.enabled ? layer.stroke : null;
  const strokeCov = s ? rasterizeShapes(strokeShapes(layer.path, s.style), rect) : null;
  const strokeAt = s ? fillSampler(s.content, size.width, size.height) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let color: [number, number, number] = [0, 0, 0];
      let alpha = 0;
      if (fillCov && fillAt && fillCov[i]! > 0) {
        const f = fillAt(x + rect.x0, y + rect.y0);
        color = f.color;
        alpha = f.alpha * fillCov[i]!;
      }
      if (strokeCov && strokeAt && s && strokeCov[i]! > 0) {
        const f = strokeAt(x + rect.x0, y + rect.y0);
        const r = compositePixel(s.blendMode, color, alpha, f.color, f.alpha * strokeCov[i]! * s.opacity);
        color = r.color as [number, number, number];
        alpha = r.alpha;
      }
      if (alpha <= 0) continue;
      out[i * 4] = Math.round(color[0] * 255);
      out[i * 4 + 1] = Math.round(color[1] * 255);
      out[i * 4 + 2] = Math.round(color[2] * 255);
      out[i * 4 + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return new MipPlane(planeFromBitmap({ data: out, width: w, height: h, left: rect.x0, top: rect.y0 }));
}

export function makeShapeLayer(name: string, path: Path, fillContent: FillContent | null, stroke: VectorStroke | null, size: Size, over: Partial<ShapeLayer> = {}): ShapeLayer {
  const layer: ShapeLayer = {
    kind: 'shape',
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 1,
    fill: 1,
    blendMode: 'normal',
    clipped: false,
    locks: NO_LOCKS,
    color: 'none',
    blending: DEFAULT_BLENDING_STATE,
    seed: 0,
    path,
    fillContent,
    stroke,
    plane: new MipPlane(Plane.empty(RGBA8)),
    ...over,
  };
  return over.plane ? layer : { ...layer, plane: renderShape(layer, size) };
}

/** A shape layer with its pixels re-rendered (after its path, fill or stroke changed). */
export function reshaped(layer: ShapeLayer, size: Size): ShapeLayer {
  return { ...layer, plane: renderShape(layer, size) };
}

/**
 * Transform a shape layer exactly. A live shape stays live under moves and axis-aligned
 * scaling; anything else turns it into an ordinary path, as Photoshop warns it will.
 */
export function retransformShape(layer: ShapeLayer, m: Mat, size: Size, planeFn: (p: Plane) => Plane): ShapeLayer {
  const mask = layer.mask ? { ...layer.mask, plane: new MipPlane(planeFn(layer.mask.plane.base)) } : layer.mask;
  const path = transformPath(layer.path, m);
  const live = layer.live && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 ? scaleLive(layer.live, m) : undefined;
  const vectorMask = layer.vectorMask ? { ...layer.vectorMask, path: transformPath(layer.vectorMask.path, m) } : undefined;
  return reshaped({ ...layer, mask, path, live, vectorMask }, size);
}

function scaleLive(s: LiveShape, m: Mat): LiveShape | undefined {
  const X = (x: number) => m.a * x + m.e;
  const Y = (y: number) => m.d * y + m.f;
  const k = Math.min(Math.abs(m.a), Math.abs(m.d));
  switch (s.kind) {
    case 'rect':
      return { ...s, x: Math.min(X(s.x), X(s.x + s.w)), y: Math.min(Y(s.y), Y(s.y + s.h)), w: Math.abs(s.w * m.a), h: Math.abs(s.h * m.d), radii: s.radii.map((r) => r * k) as [number, number, number, number] };
    case 'triangle':
      return m.a > 0 && m.d > 0 ? { ...s, x: X(s.x), y: Y(s.y), w: s.w * m.a, h: s.h * m.d, radius: s.radius * k } : undefined;
    case 'ellipse':
      return { ...s, cx: X(s.cx), cy: Y(s.cy), rx: Math.abs(s.rx * m.a), ry: Math.abs(s.ry * m.d) };
    case 'polygon':
      return Math.abs(m.a - m.d) < 1e-9 && m.a > 0 ? { ...s, cx: X(s.cx), cy: Y(s.cy), r: s.r * m.a, radius: s.radius * k } : undefined;
    case 'line':
      return { ...s, x0: X(s.x0), y0: Y(s.y0), x1: X(s.x1), y1: Y(s.y1), weight: s.weight * k };
  }
}

/**
 * The live shape a shape layer keeps after its path was edited: moved as a whole it stays
 * live; any other edit (an anchor dragged, a component added) makes it an ordinary path.
 */
export function liveAfterEdit(layer: ShapeLayer, path: Path): LiveShape | undefined {
  if (!layer.live) return undefined;
  const a = layer.path.subpaths;
  const b = path.subpaths;
  if (a.length !== b.length) return undefined;
  const k0 = a[0]?.knots[0]?.anchor;
  const k1 = b[0]?.knots[0]?.anchor;
  if (!k0 || !k1) return undefined;
  const dx = k1.x - k0.x;
  const dy = k1.y - k0.y;
  const same = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(q.x - p.x - dx) < 1e-6 && Math.abs(q.y - p.y - dy) < 1e-6;
  for (let s = 0; s < a.length; s++) {
    const ka = a[s]!.knots;
    const kb = b[s]!.knots;
    if (ka.length !== kb.length || a[s]!.op !== b[s]!.op) return undefined;
    for (let i = 0; i < ka.length; i++) if (!same(ka[i]!.anchor, kb[i]!.anchor) || !same(ka[i]!.in, kb[i]!.in) || !same(ka[i]!.out, kb[i]!.out)) return undefined;
  }
  return scaleLive(layer.live, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
}

/** A live shape's path, for a shape layer whose parameters were just edited. */
export function withLive(layer: ShapeLayer, live: LiveShape, size: Size): ShapeLayer {
  return reshaped({ ...layer, live, path: liveShapePath(live) }, size);
}

// ---- vector masks --------------------------------------------------------------------------

interface MaskEntry {
  path: Path;
  hideAll: boolean;
  raster: MipPlane | null;
  size: string;
  mask: RasterMask;
}

/** Vector masks folded into raster masks, per layer, reused until something changes. */
export class VectorMaskCache {
  private entries = new Map<number, MaskEntry>();

  /** The raster mask a layer draws with, its vector mask included. */
  effectiveMask(layer: Layer, size: Size): RasterMask | undefined {
    const vm = layer.vectorMask;
    if (!vm?.enabled) return layer.mask;
    const empty = vm.path.subpaths.every((sp) => sp.knots.length < 2);
    if (empty && !vm.hideAll) return layer.mask;
    const raster = layer.mask?.enabled ? layer.mask.plane : null;
    const key = `${size.width}x${size.height}`;
    const hit = this.entries.get(layer.id);
    if (hit && hit.path === vm.path && hit.raster === raster && hit.size === key && hit.hideAll === !!vm.hideAll) return hit.mask;
    const rect: Rect = { x0: 0, y0: 0, x1: size.width, y1: size.height };
    const cov = rasterizePath(vm.path, rect);
    const rm = raster ? bitmapFromPlane(raster.base, rect).data : null;
    const density = layer.mask?.density ?? 1;
    const w = Plane.empty(MASK8, [0]).writer();
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const i = y * size.width + x;
        let v = cov[i]!;
        if (rm) v *= 1 - density * (1 - rm[i * 4]! / 255);
        if (v <= 0) continue;
        const tile = w.mutable(x >> 8, y >> 8);
        tile[(y & 255) * 256 + (x & 255)] = Math.round(v * 255);
      }
    }
    const mask: RasterMask = { plane: new MipPlane(w.commit()), enabled: true, linked: true, density: 1, feather: 0, defaultColor: 0 };
    this.entries.set(layer.id, { path: vm.path, hideAll: !!vm.hideAll, raster, size: key, mask });
    return mask;
  }
}

/** The layer list with vector masks folded into masks; the input itself when there are none. */
export function foldVectorMasks(layers: readonly Layer[], size: Size, cache: VectorMaskCache): readonly Layer[] {
  let any = false;
  const out = layers.map((l) => {
    let next = l;
    if (l.kind === 'group') {
      const children = foldVectorMasks(l.children, size, cache);
      if (children !== l.children) next = { ...l, children };
    }
    if (l.vectorMask?.enabled) next = { ...next, mask: cache.effectiveMask(l, size) };
    if (next !== l) any = true;
    return next;
  });
  return any ? out : layers;
}
