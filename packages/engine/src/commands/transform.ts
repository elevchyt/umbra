/**
 * Move and Free Transform — spec 04 §5.
 *
 * One code path serves both, and Transform Selection as well: everything is an affine matrix
 * applied to a plane. The only branch is the fast one — a whole-pixel translation moves tiles
 * without resampling, which is what keeps dragging a layer around lossless no matter how many
 * times it is done. Photoshop behaves the same way, and it matters: a Move that resampled
 * would soften a layer a little on every nudge.
 */
import { TILE_SIZE, TILE_SHIFT, channelCount } from '@umbra/core/pixels';
import { rectIsEmpty, type Rect } from '@umbra/core/geom';
import {
  apply,
  invert,
  isIdentity,
  isIntegerTranslation,
  transformedBounds,
  type Mat,
} from '@umbra/kernels/matrix';
import { createMask, type Mask } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import {
  KERNEL_A,
  planeReader,
  planeWriter,
  sampleBilinear,
  sampleCubic,
  type Resample,
} from './image.js';
import { findLayer, hasPlane, updateLayer, walkLayers, type Doc, type Layer, type SmartObjectLayer, type VectorLayer } from '../document.js';
import { retransformVector, typeBounds } from '../type-layers.js';
import { transformVectorMasks } from './image.js';
import { pathBounds } from '@umbra/kernels/vector/path';
import { contentBounds, retransform } from '../smart.js';
import type { Selection } from '../selection.js';

/** Move a plane by whole pixels, re-keying its tiles and never touching a sample. */
export function shiftPlane(plane: Plane, dx: number, dy: number): Plane {
  if (dx === 0 && dy === 0) return plane;

  if (dx % TILE_SIZE === 0 && dy % TILE_SIZE === 0) {
    // The cheapest case of all: whole tiles change address and keep their buffers, so a
    // layer nudged by a multiple of the tile size costs nothing but a map rebuild.
    const n = channelCount(plane.format.layout);
    const writer = Plane.empty(plane.format, n === 1 ? [0] : undefined).writer();
    const tdx = dx >> TILE_SHIFT;
    const tdy = dy >> TILE_SHIFT;
    for (const { tx, ty } of plane.tileCells()) writer.put(tx + tdx, ty + tdy, plane.tileAt(tx, ty));
    return writer.commit();
  }

  // Otherwise the pixels change tile-local address, but every sample is still copied
  // verbatim — a whole-pixel move must never resample.
  const read = planeReader(plane);
  const { writer, put } = planeWriter(plane);
  const px = new Float32Array(4);
  const b = plane.bounds;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      read(x, y, px);
      if (px[3]! <= 0) continue;
      put(x + dx, y + dy, px);
    }
  }
  return writer.commit();
}

/**
 * Apply an affine transform to a plane.
 *
 * Destination-driven: every output pixel is mapped BACK through the inverse and sampled, which
 * is the only way to avoid holes when the transform magnifies. `clip` bounds the output, so a
 * layer transformed off the canvas costs nothing.
 */
export function transformPlane(
  plane: Plane,
  matrix: Mat,
  clip: Rect,
  method: Resample = 'bicubic',
): Plane {
  if (isIdentity(matrix)) return plane;
  if (isIntegerTranslation(matrix)) return shiftPlane(plane, Math.round(matrix.e), Math.round(matrix.f));

  const inverse = invert(matrix);
  const { writer, put } = planeWriter(plane);
  if (!inverse || rectIsEmpty(plane.bounds)) return writer.commit();

  // Only the part of the canvas the source can actually reach is worth walking.
  const reach = transformedBounds(matrix, plane.bounds);
  const x0 = Math.max(clip.x0, Math.floor(reach.x0) - 1);
  const x1 = Math.min(clip.x1, Math.ceil(reach.x1) + 1);
  const y0 = Math.max(clip.y0, Math.floor(reach.y0) - 1);
  const y1 = Math.min(clip.y1, Math.ceil(reach.y1) + 1);
  if (x1 <= x0 || y1 <= y0) return writer.commit();

  const read = planeReader(plane);
  const px = new Float32Array(4);
  const a = KERNEL_A[method];
  const src = plane.bounds;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const s = apply(inverse, { x: x + 0.5, y: y + 0.5 });
      // A half-pixel margin, so the filter taps that straddle the edge still contribute.
      if (s.x < src.x0 - 2 || s.x > src.x1 + 2 || s.y < src.y0 - 2 || s.y > src.y1 + 2) continue;
      if (method === 'nearest') {
        read(Math.floor(s.x), Math.floor(s.y), px);
      } else if (a === undefined) {
        sampleBilinear(read, s.x - 0.5, s.y - 0.5, px);
        unpremultiply(px);
      } else {
        sampleCubic(read, s.x - 0.5, s.y - 0.5, a, px);
        unpremultiply(px);
      }
      if (px[3]! <= 0) continue;
      put(x, y, px);
    }
  }
  return writer.commit();
}

/** The samplers accumulate premultiplied; planes store straight alpha. */
function unpremultiply(px: Float32Array): void {
  const a = px[3]!;
  if (a <= 0) {
    px[0] = 0;
    px[1] = 0;
    px[2] = 0;
    px[3] = 0;
    return;
  }
  px[0] = Math.min(1, px[0]! / a);
  px[1] = Math.min(1, px[1]! / a);
  px[2] = Math.min(1, px[2]! / a);
  px[3] = Math.min(1, a);
}

// ---- document-level commands --------------------------------------------------------------

export interface TransformTarget {
  /** Layers the transform applies to; empty means the active layer. */
  layerIds: readonly number[];
  /** Transform the selection outline rather than any pixels. */
  selectionOnly: boolean;
}

function targetIds(doc: Doc): number[] {
  if (doc.activeLayerIds.length > 0) return [...doc.activeLayerIds];
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i]!;
    if (hasPlane(l)) return [l.id];
  }
  return [];
}

function mapLayerTree(layer: Layer, fn: (p: Plane) => Plane, smart: (l: SmartObjectLayer) => Layer, shape: (l: VectorLayer) => Layer): Layer {
  // A smart object takes the matrix into its transform and re-renders from its contents.
  if (layer.kind === 'smart') return smart(layer);
  // A shape layer transforms its path exactly.
  if (layer.kind === 'shape' || layer.kind === 'type') return shape(layer);
  const mask = layer.mask ? { ...layer.mask, plane: new MipPlane(fn(layer.mask.plane.base)) } : layer.mask;
  if (layer.kind === 'group') {
    return { ...layer, mask, children: layer.children.map((c) => mapLayerTree(c, fn, smart, shape)) };
  }
  if (layer.kind === 'adjustment' || layer.kind === 'fill') return { ...layer, mask };
  return { ...layer, mask, plane: new MipPlane(fn(layer.plane.base)) };
}

/**
 * Apply a matrix to some layers. A locked layer is skipped rather than failing the whole
 * command, because Photoshop transforms whatever it is allowed to and leaves the rest.
 */
export function transformLayers(
  doc: Doc,
  matrix: Mat,
  method: Resample = 'bicubic',
  ids?: readonly number[],
): Doc {
  if (isIdentity(matrix)) return doc;
  const targets = ids && ids.length > 0 ? ids : targetIds(doc);
  if (targets.length === 0) return doc;
  // Transforming can push pixels outside the canvas; they are kept, as Photoshop keeps them.
  const clip: Rect = {
    x0: -doc.width,
    y0: -doc.height,
    x1: doc.width * 2,
    y1: doc.height * 2,
  };

  let layers = doc.layers;
  for (const id of targets) {
    const layer = findLayer(layers, id);
    if (!layer || layer.locks.position || layer.locks.all) continue;
    const fn = (p: Plane) => transformPlane(p, matrix, clip, method);
    layers = updateLayer(layers, id, (l) => transformVectorMasks([mapLayerTree(l, fn, (s) => retransform(s, matrix, doc, fn), (s) => retransformVector(s, matrix, doc, fn))], matrix)[0]!);
  }
  return layers === doc.layers ? doc : { ...doc, layers };
}

/** Select ▸ Transform Selection: the mask moves, the pixels do not. */
export function transformSelection(sel: Selection, matrix: Mat): Selection {
  if (isIdentity(matrix)) return sel;
  const inverse = invert(matrix);
  if (!inverse) return sel;
  const { width, height } = sel;
  const out: Mask = createMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = apply(inverse, { x: x + 0.5, y: y + 0.5 });
      // Bilinear on coverage, so a rotated edge stays as soft as it was.
      const fx = s.x - 0.5;
      const fy = s.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let v = 0;
      for (let j = 0; j <= 1; j++) {
        const sy = y0 + j;
        if (sy < 0 || sy >= height) continue;
        for (let i = 0; i <= 1; i++) {
          const sx = x0 + i;
          if (sx < 0 || sx >= width) continue;
          v += sel.mask[sy * width + sx]! * (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
        }
      }
      out[y * width + x] = Math.round(Math.min(255, v));
    }
  }
  return { ...sel, mask: out };
}

/** The axis-aligned rectangle a transformed box ends up occupying. */
export function transformedRect(box: Rect, matrix: Mat): Rect {
  return transformedBounds(matrix, box);
}

/** Tight bounds of the selection, for Transform Selection's box. */
export function selectionBoundsOf(doc: Doc): Rect | null {
  if (!doc.selection) return null;
  const { mask, width } = doc.selection;
  let x0 = doc.width;
  let y0 = doc.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      if (mask[y * width + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 >= x0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
}

/**
 * Bounding box of what a transform would act on, for the handles to start from.
 *
 * This is the layer's content bounds. Photoshop transforms only the SELECTED pixels when a
 * selection is active, which needs the selection lifted into a floating layer first; until
 * that exists, Free Transform acts on the whole layer and says so in the options bar.
 */
export function transformBounds(doc: Doc, ids?: readonly number[]): Rect | null {
  const targets = ids && ids.length > 0 ? ids : targetIds(doc);
  let box: Rect | null = null;
  for (const id of targets) {
    const layer = findLayer(doc.layers, id);
    if (!layer) continue;
    for (const { layer: l } of walkLayers([layer])) {
      if (!hasPlane(l)) continue;
      // A smart object's box is its whole placed content, even where the canvas clips it; a
      // shape's is its path; type's is its ink.
      const b = l.kind === 'smart' ? contentBounds(l) : l.kind === 'shape' ? (pathBounds(l.path) ?? l.plane.base.bounds) : l.kind === 'type' ? typeBounds(l) : l.plane.base.bounds;
      if (rectIsEmpty(b)) continue;
      box = box
        ? {
            x0: Math.min(box.x0, b.x0),
            y0: Math.min(box.y0, b.y0),
            x1: Math.max(box.x1, b.x1),
            y1: Math.max(box.y1, b.y1),
          }
        : b;
    }
  }
  return box;
}
