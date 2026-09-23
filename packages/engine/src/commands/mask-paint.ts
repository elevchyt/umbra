/**
 * Painting into a layer mask — what the brush, pencil, eraser, Edit ▸ Fill and the Gradient
 * tool do when the mask is the edit target (spec 02 §3): the thumbnail was clicked, or the
 * layer is an adjustment or fill layer, which have nothing else to paint.
 *
 * A mask holds grey, so paint is taken as its luminance, and each operation is a lerp of the
 * mask toward that grey by the paint's coverage: `m += (grey − m)·α`. That is Normal mode on a
 * single channel, which is what Photoshop's mask painting is.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { gradientRamp, gradientT } from '@umbra/kernels/gradient';
import { findLayer, updateLayer, type Doc } from '../document.js';
import { MipPlane } from '../tiles/mip.js';
import type { Plane } from '../tiles/plane.js';
import type { GradientOptions } from './fill.js';

export const lumOf = (c: readonly number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;

function withMask(doc: Doc, layerId: number, plane: Plane): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, layerId, (l) => (l.mask ? { ...l, mask: { ...l.mask, plane: new MipPlane(plane) } } : l)),
  };
}

/**
 * Lerp every mask pixel in the canvas (and the selection) toward `sample(x, y)`'s grey by its
 * alpha. `sample` returns null where it has nothing to say.
 */
function paintCanvas(doc: Doc, layerId: number, sample: (x: number, y: number) => [number, number] | null): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer?.mask) return doc;
  const writer = layer.mask.plane.base.writer();
  const sel = doc.selection;
  for (let ty = 0; ty <= (doc.height - 1) >> TILE_SHIFT; ty++) {
    for (let tx = 0; tx <= (doc.width - 1) >> TILE_SHIFT; tx++) {
      let data: ReturnType<typeof writer.mutable> | null = null;
      const x0 = tx << TILE_SHIFT;
      const y0 = ty << TILE_SHIFT;
      for (let y = y0; y < Math.min(doc.height, y0 + TILE_SIZE); y++) {
        for (let x = x0; x < Math.min(doc.width, x0 + TILE_SIZE); x++) {
          const s = sample(x, y);
          if (!s) continue;
          const a = s[1] * (sel ? sel.mask[y * doc.width + x]! / 255 : 1);
          if (a <= 0) continue;
          data ??= writer.mutable(tx, ty);
          const o = (y - y0) * TILE_SIZE + (x - x0);
          data[o] = Math.round(data[o]! + (s[0] * 255 - data[o]!) * a);
        }
      }
    }
  }
  return withMask(doc, layerId, writer.commit());
}

/** Edit ▸ Fill on a mask: the colour's grey, at `opacity`, through the selection. */
export function fillMask(doc: Doc, layerId: number, color: readonly number[], opacity: number): Doc {
  const g = lumOf(color);
  return paintCanvas(doc, layerId, () => [g, opacity]);
}

/** The Gradient tool on a mask: the ramp's grey, its opacity stops as coverage. */
export function gradientMask(doc: Doc, layerId: number, opts: GradientOptions): Doc {
  const steps = 1024;
  const ramp = gradientRamp(opts.gradient, steps);
  return paintCanvas(doc, layerId, (x, y) => {
    let t = gradientT(opts.style, opts.x0, opts.y0, opts.x1, opts.y1, x + 0.5, y + 0.5);
    if (opts.reverse) t = 1 - t;
    const i = Math.min(steps - 1, Math.max(0, Math.round(t * (steps - 1)))) * 4;
    return [lumOf([ramp[i]! / 255, ramp[i + 1]! / 255, ramp[i + 2]! / 255]), (ramp[i + 3]! / 255) * opts.opacity];
  });
}

/**
 * A finished brush or eraser stroke into a mask. The stroke plane carries the paint's grey in
 * its red channel (the engine paints masks in grey) and its coverage in alpha.
 */
export function compositeStrokeIntoMask(doc: Doc, layerId: number, stroke: Plane, opacity: number): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer?.mask) return doc;
  const writer = layer.mask.plane.base.writer();
  for (const { tx, ty } of stroke.tileCells()) {
    const src = stroke.tileAt(tx, ty);
    if (src.isTransparent()) continue;
    const data = writer.mutable(tx, ty);
    const sd = src.data;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const so = src.uniform ? 0 : i * 4;
      const a = (sd[so + 3]! / 255) * opacity;
      if (a <= 0) continue;
      data[i] = Math.round(data[i]! + (sd[so]! - data[i]!) * a);
    }
  }
  return withMask(doc, layerId, writer.commit());
}
