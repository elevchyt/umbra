/**
 * Edit ▸ Fill and Edit ▸ Stroke — spec 04 §7.
 *
 * Both write a flat colour through a coverage mask, so they share one routine: Fill's mask is
 * the selection (or the whole canvas when there is none), and Stroke's is a band derived from
 * the selection edge. Running them through the same CPU blend the reference compositor uses
 * means "Fill with Multiply at 50%" agrees with putting the same colour on a layer above.
 */
import { wetEdges } from '@umbra/kernels/brush';
import { TILE_SIZE, TILE_SHIFT, channelCount } from '@umbra/core/pixels';
import { rectIntersect, rectIsEmpty, type Rect } from '@umbra/core/geom';
import { compositePixel } from '@umbra/kernels/blend';
import type { BlendMode } from '@umbra/core/blend';
import { contract, expand, maskBounds, type Mask } from '@umbra/kernels/selection';
import {
  gradientRamp,
  gradientT,
  type Gradient,
  type GradientStyle,
} from '@umbra/kernels/gradient';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import type { Doc, Layer, PixelLayer } from '../document.js';
import { findLayer, updateLayer } from '../document.js';
import type { Selection } from '../selection.js';

export type FillSource =
  | 'foreground'
  | 'background'
  | 'color'
  | 'black'
  | 'white'
  | 'gray50'
  | 'transparent';

export interface FillOptions {
  /** 0…1 straight RGB; the caller resolves foreground/background/named sources to this. */
  color: [number, number, number];
  mode: BlendMode;
  /** 0…1 */
  opacity: number;
  /**
   * Restrict the fill to pixels that already have alpha, and leave that alpha alone. This is
   * the "Preserve Transparency" checkbox and the layer's transparency lock.
   */
  preserveTransparency: boolean;
  /** Erase instead of paint — Fill with Transparent, and what Delete does inside a selection. */
  clear?: boolean;
}

export type StrokeLocation = 'inside' | 'center' | 'outside';

export interface StrokeOptions extends FillOptions {
  width: number;
  location: StrokeLocation;
}

/**
 * The band a stroke covers, as a coverage mask.
 *
 * Built from the distance transform the Expand/Contract commands already use rather than from
 * a path, because the selection is a mask: there is no outline to offset, and a feathered or
 * painted edge has no single position to offset from.
 */
export function strokeBand(sel: Selection, width: number, location: StrokeLocation): Mask {
  const size = { width: sel.width, height: sel.height };
  const outerBy = location === 'outside' ? width : location === 'center' ? width / 2 : 0;
  const innerBy = location === 'inside' ? width : location === 'center' ? width / 2 : 0;

  const outer = Uint8Array.from(sel.mask);
  if (outerBy > 0) expand(outer, size, outerBy);
  const inner = Uint8Array.from(sel.mask);
  if (innerBy > 0) contract(inner, size, innerBy);

  // The band is what the grown edge covers and the shrunk edge does not.
  for (let i = 0; i < outer.length; i++) {
    outer[i] = outer[i]! > inner[i]! ? outer[i]! - inner[i]! : 0;
  }
  return outer;
}

/** Rect the operation touches, in document pixels. A null mask means the whole canvas. */
function affectedRect(doc: Doc, mask: Mask | null): Rect {
  const canvas: Rect = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  if (!mask) return canvas;
  const b = maskBounds(mask, { width: doc.width, height: doc.height });
  return b ? rectIntersect(b, canvas) : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** Paint `opts.color` into `layer` through `mask`, returning the layer's new plane. */
function paintThrough(doc: Doc, layer: PixelLayer, mask: Mask | null, opts: FillOptions): Plane {
  const plane = layer.plane.base;
  const n = channelCount(plane.format.layout);
  // Pixel layers are RGBA; the alpha arithmetic below has no meaning for anything else.
  if (n !== 4) return plane;
  const rect = affectedRect(doc, mask);
  const writer = plane.writer();
  if (rectIsEmpty(rect)) return writer.commit();

  const [sr, sg, sb] = opts.color;
  const backdrop: [number, number, number] = [0, 0, 0];
  const source: [number, number, number] = [sr, sg, sb];

  const tx0 = rect.x0 >> TILE_SHIFT;
  const tx1 = (rect.x1 - 1) >> TILE_SHIFT;
  const ty0 = rect.y0 >> TILE_SHIFT;
  const ty1 = (rect.y1 - 1) >> TILE_SHIFT;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const originX = tx << TILE_SHIFT;
      const originY = ty << TILE_SHIFT;
      const px0 = Math.max(rect.x0, originX);
      const px1 = Math.min(rect.x1, originX + TILE_SIZE);
      const py0 = Math.max(rect.y0, originY);
      const py1 = Math.min(rect.y1, originY + TILE_SIZE);
      if (px1 <= px0 || py1 <= py0) continue;

      const data = writer.mutable(tx, ty);
      for (let y = py0; y < py1; y++) {
        const maskRow = y * doc.width;
        const tileRow = (y - originY) * TILE_SIZE;
        for (let x = px0; x < px1; x++) {
          let a = opts.opacity;
          if (mask) a *= mask[maskRow + x]! / 255;
          if (a <= 0) continue;

          const o = (tileRow + (x - originX)) * n;
          const da = data[o + 3]! / 255;
          if (opts.preserveTransparency && da <= 0) continue;

          if (opts.clear) {
            // Erasing leaves the colour alone and takes the alpha down; anything fully erased
            // would otherwise keep a colour that shows up again the moment it is painted over.
            data[o + 3] = Math.round(da * (1 - a) * 255);
            continue;
          }

          backdrop[0] = data[o]! / 255;
          backdrop[1] = data[o + 1]! / 255;
          backdrop[2] = data[o + 2]! / 255;
          const out = compositePixel(opts.mode, backdrop, da, source, a);
          data[o] = Math.round(out.color[0]! * 255);
          data[o + 1] = Math.round(out.color[1]! * 255);
          data[o + 2] = Math.round(out.color[2]! * 255);
          // Preserve Transparency keeps the existing alpha and only recolours what is there.
          data[o + 3] = opts.preserveTransparency ? data[o + 3]! : Math.round(out.alpha * 255);
        }
      }
    }
  }
  return writer.commit();
}

function targetLayer(doc: Doc): PixelLayer | null {
  const id = doc.activeLayerIds[0];
  const found = id === undefined ? undefined : findLayer(doc.layers, id);
  if (found && found.kind === 'pixel') return found;
  // A group or adjustment layer is active: Photoshop refuses rather than painting somewhere
  // else. (Painting an adjustment layer's MASK needs mask targeting, which is not built.)
  if (found) return null;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i]!;
    if (l.kind === 'pixel') return l;
  }
  return null;
}

function withPlane(doc: Doc, layer: Layer, plane: Plane): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, layer.id, (l) =>
      l.kind === 'pixel' ? { ...l, plane: new MipPlane(plane) } : l,
    ),
  };
}

/** Edit ▸ Fill. Fills the selection, or the whole layer when nothing is selected. */
export function fill(doc: Doc, opts: FillOptions): Doc {
  const layer = targetLayer(doc);
  if (!layer) return doc;
  const preserve = opts.preserveTransparency || layer.locks.transparency;
  if (layer.locks.pixels || layer.locks.all) return doc;
  const mask = doc.selection ? doc.selection.mask : null;
  return withPlane(doc, layer, paintThrough(doc, layer, mask, { ...opts, preserveTransparency: preserve }));
}

/** Edit ▸ Stroke. Needs a selection — there is nothing else to take an edge from. */
export function stroke(doc: Doc, opts: StrokeOptions): Doc {
  const layer = targetLayer(doc);
  if (!layer || !doc.selection || opts.width <= 0) return doc;
  if (layer.locks.pixels || layer.locks.all) return doc;
  const band = strokeBand(doc.selection, opts.width, opts.location);
  const preserve = opts.preserveTransparency || layer.locks.transparency;
  return withPlane(doc, layer, paintThrough(doc, layer, band, { ...opts, preserveTransparency: preserve }));
}

/**
 * Paint Bucket and Gradient write through a coverage mask exactly as Fill does, so they reuse
 * `paintThrough` and differ only in what produces the mask and the colour.
 */
export function bucketFill(
  doc: Doc,
  mask: Mask,
  opts: FillOptions,
): Doc {
  const layer = targetLayer(doc);
  if (!layer || layer.locks.pixels || layer.locks.all) return doc;
  // Confine the flood to the selection, which is what makes "bucket inside a selection" work.
  const combined = doc.selection ? intersect(mask, doc.selection.mask) : mask;
  const preserve = opts.preserveTransparency || layer.locks.transparency;
  return withPlane(doc, layer, paintThrough(doc, layer, combined, { ...opts, preserveTransparency: preserve }));
}

function intersect(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round((a[i]! * b[i]!) / 255);
  return out;
}

export interface GradientOptions {
  gradient: Gradient;
  style: GradientStyle;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reverse: boolean;
  dither: boolean;
  mode: BlendMode;
  opacity: number;
  preserveTransparency: boolean;
}

/**
 * Draw a gradient across the layer, through the selection.
 *
 * Dithering is a small ordered perturbation of the ramp position, not of the output colour:
 * banding in a gradient comes from quantising `t`, so that is where it has to be broken up.
 */
export function drawGradient(doc: Doc, opts: GradientOptions): Doc {
  const layer = targetLayer(doc);
  if (!layer || layer.locks.pixels || layer.locks.all) return doc;
  const plane = layer.plane.base;
  const n = channelCount(plane.format.layout);
  if (n !== 4) return doc;

  const ramp = gradientRamp(opts.gradient, 1024);
  const steps = 1024;
  const writer = plane.writer();
  const sel = doc.selection;
  const preserve = opts.preserveTransparency || layer.locks.transparency;
  const backdrop: [number, number, number] = [0, 0, 0];
  const source: [number, number, number] = [0, 0, 0];

  for (let ty = 0; ty <= (doc.height - 1) >> TILE_SHIFT; ty++) {
    for (let tx = 0; tx <= (doc.width - 1) >> TILE_SHIFT; tx++) {
      const originX = tx << TILE_SHIFT;
      const originY = ty << TILE_SHIFT;
      const px1 = Math.min(doc.width, originX + TILE_SIZE);
      const py1 = Math.min(doc.height, originY + TILE_SIZE);
      let data: ReturnType<typeof writer.mutable> | null = null;

      for (let y = originY; y < py1; y++) {
        for (let x = originX; x < px1; x++) {
          let coverage = opts.opacity;
          if (sel) coverage *= sel.mask[y * doc.width + x]! / 255;
          if (coverage <= 0) continue;

          let t = gradientT(opts.style, opts.x0, opts.y0, opts.x1, opts.y1, x + 0.5, y + 0.5);
          if (opts.reverse) t = 1 - t;
          if (opts.dither) t += (BAYER[(y & 3) * 4 + (x & 3)]! / 16 - 0.5) / steps;
          const i = Math.min(steps - 1, Math.max(0, Math.round(t * (steps - 1)))) * 4;

          const sa = (ramp[i + 3]! / 255) * coverage;
          if (sa <= 0) continue;

          data ??= writer.mutable(tx, ty);
          const o = ((y - originY) * TILE_SIZE + (x - originX)) * 4;
          const da = data[o + 3]! / 255;
          if (preserve && da <= 0) continue;

          source[0] = ramp[i]! / 255;
          source[1] = ramp[i + 1]! / 255;
          source[2] = ramp[i + 2]! / 255;
          backdrop[0] = data[o]! / 255;
          backdrop[1] = data[o + 1]! / 255;
          backdrop[2] = data[o + 2]! / 255;
          const out = compositePixel(opts.mode, backdrop, da, source, sa);
          data[o] = Math.round(out.color[0]! * 255);
          data[o + 1] = Math.round(out.color[1]! * 255);
          data[o + 2] = Math.round(out.color[2]! * 255);
          data[o + 3] = preserve ? data[o + 3]! : Math.round(out.alpha * 255);
        }
      }
    }
  }
  return withPlane(doc, layer, writer.commit());
}

/** 4×4 ordered dither, the classic Bayer matrix. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Paint modes a brush has but a layer does not. They act on alpha rather than on colour, so
 * they cannot go through the blend table.
 */
export type PaintMode = BlendMode | 'behind' | 'clear';

/**
 * Composite a finished stroke onto its layer.
 *
 * The stroke was accumulated in its own buffer at the brush's FLOW, and is applied here once
 * at its OPACITY. Doing it in this order is the whole reason for the buffer: overlapping dabs
 * build toward opacity and stop, where compositing each dab straight onto the layer would let
 * a slow stroke keep darkening.
 */
export function compositeStroke(
  doc: Doc,
  layerId: number,
  strokePlane: Plane,
  opacity: number,
  mode: PaintMode,
  /** Wet Edges: the stroke's coverage through the pooling curve. */
  wet = false,
): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer || layer.kind !== 'pixel') return doc;
  const dest = layer.plane.base;
  if (channelCount(dest.format.layout) !== 4) return doc;

  const writer = dest.writer();
  const backdrop: [number, number, number] = [0, 0, 0];
  const source: [number, number, number] = [0, 0, 0];
  const preserve = layer.locks.transparency;

  for (const { tx, ty } of strokePlane.tileCells()) {
    const src = strokePlane.tileAt(tx, ty);
    if (src.isTransparent()) continue;
    const data = writer.mutable(tx, ty);
    const sd = src.data;
    const uniform = src.uniform;

    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const so = uniform ? 0 : i * 4;
      const s0 = sd[so + 3]! / 255;
      const sa = (wet ? wetEdges(s0) : s0) * opacity;
      if (sa <= 0) continue;
      const o = i * 4;
      const da = data[o + 3]! / 255;

      if (mode === 'clear') {
        data[o + 3] = Math.round(da * (1 - sa) * 255);
        continue;
      }
      if (preserve && da <= 0) continue;

      source[0] = sd[so]! / 255;
      source[1] = sd[so + 1]! / 255;
      source[2] = sd[so + 2]! / 255;
      backdrop[0] = data[o]! / 255;
      backdrop[1] = data[o + 1]! / 255;
      backdrop[2] = data[o + 2]! / 255;

      // Behind puts the paint UNDER what is already there, which is the same equation with
      // the two sides swapped.
      const out =
        mode === 'behind'
          ? compositePixel('normal', source, sa, backdrop, da)
          : compositePixel(mode, backdrop, da, source, sa);

      data[o] = Math.round(out.color[0]! * 255);
      data[o + 1] = Math.round(out.color[1]! * 255);
      data[o + 2] = Math.round(out.color[2]! * 255);
      data[o + 3] = preserve ? data[o + 3]! : Math.round(out.alpha * 255);
    }
  }
  return withPlane(doc, layer, writer.commit());
}
