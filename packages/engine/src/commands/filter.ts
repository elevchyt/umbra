/**
 * Running a filter on a layer — spec 05 §B conventions: through the selection (feathered
 * blend), honouring the transparency lock, onto a targeted mask when the mask is targeted.
 *
 * Execution is region-of-interest: a filter declares how far each output pixel reads, and only
 * the affected rectangle (the selection's bounds, or the canvas) grown by that pad is
 * rasterised and filtered. The dialog's preview box uses the same path on its visible crop.
 */
import type { Rect } from '@umbra/core/geom';
import { fromRgba8, toRgba8, type FilterContext, type FilterDef, type FilterParams, type Raster } from '@umbra/kernels/filters/index';
import { findLayer, updateLayer, type Doc } from '../document.js';
import { MipPlane } from '../tiles/mip.js';
import { bitmapFromPlane } from '../psd-save.js';
import { writeRaster } from './spatial.js';
import { setMaskFromGrey } from './mask-paint.js';

export interface FilterRun {
  def: FilterDef;
  params: FilterParams;
  foreground: [number, number, number];
  background: [number, number, number];
}

/** Grow `r` by `pad`, clamped to the canvas; 'full' is the whole canvas. */
function grown(doc: Doc, r: Rect, pad: number | 'full'): Rect {
  if (pad === 'full') return { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  return {
    x0: Math.max(0, r.x0 - pad),
    y0: Math.max(0, r.y0 - pad),
    x1: Math.min(doc.width, r.x1 + pad),
    y1: Math.min(doc.height, r.y1 + pad),
  };
}

/**
 * Filter `region` of a canvas-sized straight RGBA8 raster; returns the filtered REGION as
 * straight RGBA8 (width × height of `region`). The source crop includes the pad so edges of
 * the region see real neighbours, not replicated ones.
 */
export function filterRegion(doc: Doc, canvas: ArrayLike<number>, region: Rect, run: FilterRun, coverage: Uint8Array | null, map?: ArrayLike<number> | null): Uint8ClampedArray {
  const src = grown(doc, region, run.def.pad(run.params));
  const sw = src.x1 - src.x0;
  const sh = src.y1 - src.y0;
  const crop = new Uint8ClampedArray(sw * sh * 4);
  const cropMap = map ? new Uint8ClampedArray(sw * sh * 4) : null;
  for (let y = 0; y < sh; y++) {
    const from = ((src.y0 + y) * doc.width + src.x0) * 4;
    for (let i = 0; i < sw * 4; i++) crop[y * sw * 4 + i] = canvas[from + i]!;
    if (cropMap && map) for (let i = 0; i < sw * 4; i++) cropMap[y * sw * 4 + i] = map[from + i]!;
  }
  let cov: Uint8Array | null = null;
  if (coverage) {
    cov = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) cov.set(coverage.subarray((src.y0 + y) * doc.width + src.x0, (src.y0 + y) * doc.width + src.x1), y * sw);
  }
  const ctx: FilterContext = {
    originX: src.x0,
    originY: src.y0,
    docWidth: doc.width,
    docHeight: doc.height,
    foreground: run.foreground,
    background: run.background,
    coverage: cov,
    map: cropMap ? fromRgba8(cropMap, sw, sh) : null,
  };
  const out: Raster = run.def.run(fromRgba8(crop, sw, sh), run.params, ctx);
  const full = toRgba8(out);
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  const res = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const from = ((region.y0 - src.y0 + y) * sw + (region.x0 - src.x0)) * 4;
    res.set(full.subarray(from, from + rw * 4), y * rw * 4);
  }
  return res;
}

/** The rectangle a filter changes: the selection's bounds, or the whole canvas. */
export function affectedRegion(doc: Doc): Rect {
  const sel = doc.selection;
  if (!sel) return { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  let x0 = doc.width;
  let y0 = doc.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      if (!sel.mask[y * doc.width + x]) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** Apply a filter to the target: `mask` true filters the layer's mask as grey. */
export function applyFilter(doc: Doc, layerId: number, mask: boolean, run: FilterRun, map?: ArrayLike<number> | null): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer) return doc;
  const rect = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  const region = affectedRegion(doc);
  if (region.x1 <= region.x0) return doc;
  const sel = doc.selection?.mask ?? null;

  if (mask) {
    if (!layer.mask) return doc;
    const canvas = bitmapFromPlane(layer.mask.plane.base, rect).data;
    const out = filterRegion(doc, canvas, region, run, sel, map);
    const grey = new Uint8Array(doc.width * doc.height);
    for (let i = 0; i < grey.length; i++) grey[i] = canvas[i * 4]!;
    blendRegion(grey, 1, out, region, doc.width, sel, (o) => Math.round(0.3 * out[o]! + 0.59 * out[o + 1]! + 0.11 * out[o + 2]!));
    return setMaskFromGrey(doc, layerId, grey);
  }

  if (layer.kind !== 'pixel' || layer.locks.pixels || layer.locks.all) return doc;
  const canvas = bitmapFromPlane(layer.plane.base, rect).data;
  const out = filterRegion(doc, canvas, region, run, sel, map);
  const keepAlpha = layer.locks.transparency;
  const rw = region.x1 - region.x0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * doc.width + x) * 4;
      const o = ((y - region.y0) * rw + (x - region.x0)) * 4;
      const k = sel ? sel[y * doc.width + x]! / 255 : 1;
      if (k <= 0) continue;
      // Blend premultiplied, so a filter that changes alpha fades sensibly at a soft edge.
      const a0 = canvas[i + 3]! / 255;
      const a1 = keepAlpha ? a0 : out[o + 3]! / 255;
      const a = a0 + (a1 - a0) * k;
      for (let c = 0; c < 3; c++) {
        const p0 = (canvas[i + c]! / 255) * a0;
        const p1 = (out[o + c]! / 255) * (keepAlpha ? a0 : a1);
        const p = p0 + (p1 - p0) * k;
        canvas[i + c] = a > 0 ? Math.round((p / a) * 255) : 0;
      }
      canvas[i + 3] = Math.round(a * 255);
    }
  }
  const plane = new MipPlane(writeRaster(layer.plane.base, doc.width, doc.height, canvas as Uint8ClampedArray));
  return { ...doc, layers: updateLayer(doc.layers, layerId, (l) => ({ ...l, plane }) as typeof l) };
}

function blendRegion(
  grey: Uint8Array,
  _n: number,
  out: Uint8ClampedArray,
  region: Rect,
  width: number,
  sel: Uint8Array | null,
  value: (o: number) => number,
): void {
  const rw = region.x1 - region.x0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = y * width + x;
      const k = sel ? sel[i]! / 255 : 1;
      if (k <= 0) continue;
      const v = value(((y - region.y0) * rw + (x - region.x0)) * 4);
      grey[i] = Math.round(grey[i]! + (v - grey[i]!) * k);
    }
  }
}
