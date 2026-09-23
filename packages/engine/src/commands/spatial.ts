/**
 * Shadows/Highlights, Replace Color, Match Color and HDR Toning — the adjustments that read
 * neighbouring pixels or whole-image statistics (kernels/spatial.ts). They run over the target
 * layer's pixels on the canvas as one raster, then blend back through the selection.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import {
  colorStats,
  hdrToning,
  matchColor,
  replaceColor,
  shadowsHighlights,
  type ColorStats,
  type SpatialAdjustment,
} from '@umbra/kernels/spatial';
import { findLayer, updateLayer, type Doc, type PixelLayer } from '../document.js';
import { MipPlane } from '../tiles/mip.js';
import { Plane } from '../tiles/plane.js';
import { bitmapFromPlane } from '../psd-save.js';
import { flatten } from './layers.js';

export interface SpatialContext {
  /** Match Color's source statistics, which only the engine can compute (it may need the GPU). */
  sourceStats?: ColorStats;
}

/** A pixel layer's pixels over the canvas, as one straight-alpha RGBA8 raster. */
export function layerRaster(doc: Doc, layer: PixelLayer): Uint8ClampedArray {
  return bitmapFromPlane(layer.plane.base, { x0: 0, y0: 0, x1: doc.width, y1: doc.height }).data;
}

/**
 * Write a canvas-sized raster back over a plane. Pixels off the canvas are kept, and a tile
 * the plane never stored is only created where the raster has something to put in it.
 */
export function writeRaster(plane: Plane, width: number, height: number, raster: Uint8ClampedArray): Plane {
  const writer = plane.writer();
  const tx1 = Math.ceil(width / TILE_SIZE);
  const ty1 = Math.ceil(height / TILE_SIZE);
  for (let ty = 0; ty < ty1; ty++) {
    for (let tx = 0; tx < tx1; tx++) {
      const x0 = tx << TILE_SHIFT;
      const y0 = ty << TILE_SHIFT;
      const w = Math.min(TILE_SIZE, width - x0);
      const h = Math.min(TILE_SIZE, height - y0);
      if (!plane.hasTile(tx, ty)) {
        let any = false;
        for (let y = 0; y < h && !any; y++) {
          for (let x = 0; x < w; x++) {
            if (raster[((y0 + y) * width + x0 + x) * 4 + 3]) {
              any = true;
              break;
            }
          }
        }
        if (!any) continue;
      }
      const dst = writer.mutable(tx, ty);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + x0) * 4;
        dst.set(raster.subarray(src, src + w * 4), y * TILE_SIZE * 4);
      }
    }
  }
  return writer.commit();
}

/** Run `adj` over a raster in place. */
export function runSpatial(raster: Uint8ClampedArray, width: number, height: number, adj: SpatialAdjustment, ctx: SpatialContext): void {
  switch (adj.kind) {
    case 'shadowsHighlights':
      return shadowsHighlights(raster, width, height, adj);
    case 'replaceColor':
      return replaceColor(raster, adj);
    case 'matchColor':
      return matchColor(raster, colorStats(raster), ctx.sourceStats ?? colorStats(raster), adj);
    case 'hdrToning':
      return hdrToning(raster, width, height, adj);
  }
}

/**
 * Apply to a pixel layer, through the selection. HDR Toning flattens first, as Photoshop
 * does — it is defined on the whole image, and then targets the single resulting layer.
 */
export function applySpatial(doc: Doc, layerId: number, adj: SpatialAdjustment, ctx: SpatialContext = {}): Doc {
  let base = doc;
  let id = layerId;
  if (adj.kind === 'hdrToning' && (doc.layers.length !== 1 || doc.layers[0]!.kind !== 'pixel')) {
    base = flatten(doc);
    id = base.layers[0]!.id;
  }
  const layer = findLayer(base.layers, id);
  if (!layer || layer.kind !== 'pixel' || layer.locks.pixels || layer.locks.all) return doc;

  const raster = layerRaster(base, layer);
  const original = raster.slice();
  runSpatial(raster, base.width, base.height, adj, ctx);

  const sel = base.selection;
  if (sel) {
    for (let i = 0, o = 0; o < raster.length; o += 4, i++) {
      const k = sel.mask[i]! / 255;
      if (k >= 1) continue;
      for (let c = 0; c < 3; c++) raster[o + c] = Math.round(original[o + c]! + (raster[o + c]! - original[o + c]!) * k);
    }
  }
  const plane = new MipPlane(writeRaster(layer.plane.base, base.width, base.height, raster));
  return { ...base, layers: updateLayer(base.layers, id, (l) => ({ ...l, plane }) as typeof l) };
}
