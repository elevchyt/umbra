/**
 * Smart objects and smart filters — spec 02 §3, spec 05 §B.11.
 *
 * A smart object keeps its contents (an embedded document) untouched and shows them through a
 * transform and a stack of smart filters. Every geometric edit composes into the transform and
 * re-renders from the source, so scaling a smart object down and up again loses nothing; every
 * filter edit re-runs the stack. The rendered result lives on the layer as an ordinary plane,
 * which is why the compositor, the PSD writer and everything else downstream need no special
 * case: a smart object is a pixel layer that knows how to remake its pixels.
 *
 * Rendering is on the CPU, in document space, clipped to the canvas — filters run after the
 * transform, as Photoshop runs them.
 */
import { rectIntersect, rectIsEmpty, rectUnion, type Rect } from '@umbra/core/geom';
import type { BlendMode } from '@umbra/core/blend';
import { compositePixel } from '@umbra/kernels/blend';
import { compose, scale, transformedBounds, translate, type Mat } from '@umbra/kernels/matrix';
import { FILTER_BY_ID } from '@umbra/kernels/filters/index';
import { hasVisibleEffects } from '@umbra/kernels/effects/types';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import {
  emptyDoc,
  findLayer,
  insertLayer,
  makeGroup,
  makePixelLayer,
  nextLayerId,
  replaceLayer,
  updateLayer,
  walkLayers,
  DEFAULT_BLENDING_STATE,
  NO_LOCKS,
  type Doc,
  type Layer,
  type RasterMask,
  type SmartFilter,
  type SmartObjectLayer,
  type SmartSource,
} from './document.js';
import { groupLayers, rasterize } from './commands/layers.js';
import { shiftPlane, transformPlane } from './commands/transform.js';
import { filterRegion } from './commands/filter.js';
import { writeRaster } from './commands/spatial.js';
import { mapLayers } from './commands/image.js';
import { bitmapFromPlane, tightBounds } from './psd-save.js';

export interface Size {
  width: number;
  height: number;
}

/** Resolves a smart filter's 'layer' parameter (Displace's map) to canvas pixels. */
export type MapResolver = (f: SmartFilter) => ArrayLike<number> | null;

let nextSourceId = 1;

const canvasOf = (s: Size): Rect => ({ x0: 0, y0: 0, x1: s.width, y1: s.height });

const plain = (l: Layer) => l.visible && l.opacity >= 1 && l.fill >= 1 && l.blendMode === 'normal' && !l.mask && !l.clipped && !hasVisibleEffects(l.effects);

/** The embedded document flattened. One plain pixel layer inside the canvas is used as it is. */
export function flattenSource(doc: Doc): Plane {
  const visible = doc.layers.filter((l) => l.visible);
  const canvas = canvasOf(doc);
  const only = visible.length === 1 ? visible[0]! : null;
  if (only && (only.kind === 'pixel' || only.kind === 'smart') && plain(only)) {
    const b = tightBounds(only.plane.base);
    if (rectIsEmpty(b) || (b.x0 >= 0 && b.y0 >= 0 && b.x1 <= canvas.x1 && b.y1 <= canvas.y1)) return only.plane.base;
  }
  return rasterize(visible, canvas, doc.globalLight);
}

export function makeSource(name: string, doc: Doc, id = nextSourceId++, file?: SmartSource['file']): SmartSource {
  return file ? { id, name, doc, composite: flattenSource(doc), file } : { id, name, doc, composite: flattenSource(doc) };
}

/**
 * File ▸ Place Embedded: contents placed centred on the canvas and, when bigger than it,
 * scaled down to fit — Photoshop's default "Resize Image During Place".
 */
export function placeTransform(content: Size, canvas: Size): Mat {
  const k = Math.min(1, canvas.width / content.width, canvas.height / content.height);
  return compose(scale(k), translate((canvas.width - content.width * k) / 2, (canvas.height - content.height * k) / 2));
}

/** The source's canvas as placed in the document. */
export function contentBounds(layer: Pick<SmartObjectLayer, 'source' | 'transform'>): Rect {
  return transformedBounds(layer.transform, canvasOf(layer.source.doc));
}

/** The four corners of the placed content (top-left, top-right, bottom-right, bottom-left). */
export function contentQuad(layer: Pick<SmartObjectLayer, 'source' | 'transform'>): { x: number; y: number }[] {
  const { width: w, height: h } = layer.source.doc;
  const m = layer.transform;
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => ({ x: m.a * x! + m.c * y! + m.e, y: m.b * x! + m.d * y! + m.f }));
}

/** A smart filter's result faded onto its input with the filter's mode and opacity — Fade's arithmetic. */
function blendFiltered(before: Uint8ClampedArray, after: Uint8ClampedArray, mode: BlendMode, opacity: number): Uint8ClampedArray {
  if (mode === 'normal' && opacity >= 1) return after;
  const out = new Uint8ClampedArray(before.length);
  for (let i = 0; i < before.length; i += 4) {
    if (before[i + 3] === 0 && after[i + 3] === 0) continue;
    const r = compositePixel(
      mode,
      [before[i]! / 255, before[i + 1]! / 255, before[i + 2]! / 255],
      before[i + 3]! / 255,
      [after[i]! / 255, after[i + 1]! / 255, after[i + 2]! / 255],
      (after[i + 3]! / 255) * opacity,
    );
    out[i] = Math.round(r.color[0] * 255);
    out[i + 1] = Math.round(r.color[1] * 255);
    out[i + 2] = Math.round(r.color[2] * 255);
    out[i + 3] = Math.round(Math.min(r.alpha, Math.max(before[i + 3]!, after[i + 3]!) / 255) * 255);
  }
  return out;
}

/** Where the filter mask is dark, the unfiltered pixels show through. */
function applyFilterMask(base: Uint8ClampedArray, filtered: Uint8ClampedArray, mask: RasterMask, rect: Rect): Uint8ClampedArray {
  const m = bitmapFromPlane(mask.plane.base, rect).data;
  const out = new Uint8ClampedArray(base.length);
  for (let i = 0; i < base.length; i += 4) {
    const k = 1 - mask.density * (1 - m[i]! / 255);
    for (let c = 0; c < 4; c++) out[i + c] = base[i + c]! + (filtered[i + c]! - base[i + c]!) * k;
  }
  return out;
}

/** Render a smart object's pixels: contents through the transform, then the smart filters. */
export function renderSmart(layer: Omit<SmartObjectLayer, 'plane'>, size: Size, resolveMap?: MapResolver): MipPlane {
  const canvas = canvasOf(size);
  const placed = transformPlane(layer.source.composite, layer.transform, canvas, 'bicubic');
  const active = layer.filtersEnabled ? layer.filters.filter((f) => f.enabled && FILTER_BY_ID.has(f.filterId)) : [];
  if (active.length === 0) return new MipPlane(placed);

  const base = bitmapFromPlane(placed, canvas).data;
  const sized = emptyDoc(size.width, size.height);
  // Distort's centred filters centre on the object, not on the canvas.
  const cb = contentBounds(layer);
  const bounds = rectIntersect({ x0: Math.floor(cb.x0), y0: Math.floor(cb.y0), x1: Math.ceil(cb.x1), y1: Math.ceil(cb.y1) }, canvas);
  // Each filter works on the object's area, grown by how far it spreads (a blur reaches past
  // the edge), rather than on the whole canvas.
  let reach = rectIsEmpty(bounds) ? canvas : bounds;
  let cur = base;
  for (const f of active) {
    const def = FILTER_BY_ID.get(f.filterId)!;
    const pad = def.pad(f.params);
    reach = pad === 'full' ? canvas : rectIntersect({ x0: reach.x0 - pad, y0: reach.y0 - pad, x1: reach.x1 + pad, y1: reach.y1 + pad }, canvas);
    const out = filterRegion(sized, cur, reach, { def, params: f.params, foreground: f.foreground, background: f.background, bounds: rectIsEmpty(bounds) ? canvas : bounds }, null, resolveMap?.(f) ?? null);
    const next = cur.slice();
    const rw = (reach.x1 - reach.x0) * 4;
    for (let y = reach.y0; y < reach.y1; y++) next.set(out.subarray((y - reach.y0) * rw, (y - reach.y0 + 1) * rw), (y * size.width + reach.x0) * 4);
    cur = blendFiltered(cur, next, f.blendMode, f.opacity);
  }
  if (layer.filterMask?.enabled) cur = applyFilterMask(base, cur, layer.filterMask, canvas);
  return new MipPlane(writeRaster(Plane.empty(RGBA8), size.width, size.height, cur));
}

/** A copy of `layer` with its pixels re-rendered. */
export function rendered(layer: SmartObjectLayer, size: Size, resolveMap?: MapResolver): SmartObjectLayer {
  return { ...layer, plane: renderSmart(layer, size, resolveMap) };
}

/**
 * Apply a geometric change to a smart object: compose `matrix` into its transform (lossless),
 * carry the masks with `planeFn`, and re-render at the document's new `size`.
 */
export function retransform(layer: SmartObjectLayer, matrix: Mat, size: Size, planeFn: (p: Plane) => Plane): SmartObjectLayer {
  const mask = layer.mask ? { ...layer.mask, plane: new MipPlane(planeFn(layer.mask.plane.base)) } : layer.mask;
  const filterMask = layer.filterMask ? { ...layer.filterMask, plane: new MipPlane(planeFn(layer.filterMask.plane.base)) } : layer.filterMask;
  return rendered({ ...layer, mask, filterMask, transform: compose(layer.transform, matrix) }, size);
}

const MASK_FORMAT = { layout: 'A', sample: 'u8' } as const;
export const whiteMask = (): RasterMask => ({ plane: new MipPlane(Plane.empty(MASK_FORMAT, [255])), enabled: true, linked: true, density: 1, feather: 0, defaultColor: 1 });

export function makeSmartLayer(name: string, source: SmartSource, transform: Mat, size: Size, over: Partial<SmartObjectLayer> = {}): SmartObjectLayer {
  const layer: SmartObjectLayer = {
    kind: 'smart',
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
    source,
    transform,
    filters: [],
    filtersEnabled: true,
    plane: new MipPlane(Plane.empty(RGBA8)),
    ...over,
  };
  return over.plane ? layer : rendered(layer, size);
}

/** Tight bounds of what a set of layers draws; the canvas for layers that draw everywhere. */
function contentRect(layers: readonly Layer[], canvas: Rect): Rect {
  let r: Rect | null = null;
  for (const { layer } of walkLayers(layers)) {
    let b: Rect | null = null;
    if (layer.kind === 'pixel' || layer.kind === 'smart') b = tightBounds(layer.plane.base);
    else if (layer.kind === 'fill') b = canvas;
    if (b && !rectIsEmpty(b)) r = r ? rectUnion(r, b) : b;
  }
  return r ? { x0: Math.floor(r.x0), y0: Math.floor(r.y0), x1: Math.ceil(r.x1), y1: Math.ceil(r.y1) } : canvas;
}

/** Move layers (and any smart objects among them) by whole pixels. */
function shiftLayers(layers: readonly Layer[], dx: number, dy: number, size: Size): Layer[] {
  if (dx === 0 && dy === 0) return [...layers];
  const fn = (p: Plane) => shiftPlane(p, dx, dy);
  return mapLayers(layers, fn, (l) => retransform(l, translate(dx, dy), size, fn));
}

/**
 * Layer ▸ Smart Objects ▸ Convert to Smart Object. The layers move into an embedded document
 * cropped to what they draw, placed back where they were. A single layer hands its opacity,
 * blend mode and label to the smart object and keeps its mask inside, as Photoshop does.
 */
export function convertToSmart(doc: Doc, ids: readonly number[] = doc.activeLayerIds): Doc {
  if (ids.length === 0) return doc;
  let base = doc;
  let picked: Layer[];
  let replaceId: number;
  if (ids.length === 1) {
    const layer = findLayer(doc.layers, ids[0]!);
    if (!layer) return doc;
    picked = [layer];
    replaceId = layer.id;
  } else {
    base = groupLayers(doc, ids);
    const group = base === doc ? undefined : findLayer(base.layers, base.activeLayerIds[0]!);
    if (!group || group.kind !== 'group') return doc;
    picked = [...group.children];
    replaceId = group.id;
  }
  const top = picked[picked.length - 1]!;
  const canvas = canvasOf(doc);
  const rect = contentRect(picked, canvas);
  const w = Math.max(1, rect.x1 - rect.x0);
  const h = Math.max(1, rect.y1 - rect.y0);
  const single = picked.length === 1;
  const inner = shiftLayers(
    single ? [{ ...top, opacity: 1, fill: 1, blendMode: top.kind === 'group' ? top.blendMode : 'normal', clipped: false, visible: true } as Layer] : picked,
    -rect.x0,
    -rect.y0,
    { width: w, height: h },
  );
  const embedded: Doc = { ...emptyDoc(w, h, `${top.name}.psb`), layers: inner, activeLayerIds: [inner[inner.length - 1]!.id] };
  const source = makeSource(`${top.name}.psb`, embedded);
  const smart = makeSmartLayer(top.name, source, translate(rect.x0, rect.y0), doc, single ? { opacity: top.opacity, fill: top.fill, blendMode: top.blendMode === 'passThrough' ? 'normal' : top.blendMode, clipped: top.clipped, visible: top.visible, color: top.color } : {});
  return { ...base, layers: replaceLayer(base.layers, replaceId, smart), activeLayerIds: [smart.id] };
}

/** Layer ▸ Rasterize ▸ Smart Object: the rendered pixels become an ordinary layer. */
export function rasterizeSmart(doc: Doc, id: number): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer || layer.kind !== 'smart') return doc;
  const { kind: _k, source: _s, transform: _t, filters: _f, filtersEnabled: _e, filterMask: _m, plane, ...common } = layer;
  const pixel = makePixelLayer(layer.name, plane.base, { ...common, id: layer.id });
  return { ...doc, layers: replaceLayer(doc.layers, id, pixel) };
}

/** Layer ▸ Smart Objects ▸ New Smart Object via Copy: a duplicate with contents of its own. */
export function newSmartViaCopy(doc: Doc, id: number): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer || layer.kind !== 'smart') return doc;
  const copy: SmartObjectLayer = { ...layer, id: nextLayerId(), name: `${layer.name} copy`, source: { ...layer.source, id: nextSourceId++ } };
  return { ...doc, layers: insertLayer(doc.layers, copy, id), activeLayerIds: [copy.id] };
}

/**
 * Layer ▸ Smart Objects ▸ Convert to Layers: the contents come out as a group, placed through
 * the transform. Smart filters cannot come with them and are dropped, as in Photoshop.
 */
export function convertToLayers(doc: Doc, id: number): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer || layer.kind !== 'smart') return doc;
  const m = layer.transform;
  const clip: Rect = { x0: -doc.width, y0: -doc.height, x1: doc.width * 2, y1: doc.height * 2 };
  const fn = (p: Plane) => transformPlane(p, m, clip, 'bicubic');
  const children = mapLayers(layer.source.doc.layers, fn, (l) => retransform(l, m, doc, fn));
  const group = makeGroup(layer.name, children, {
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: layer.blendMode === 'normal' ? 'passThrough' : layer.blendMode,
    mask: layer.mask,
    clipped: layer.clipped,
  });
  return { ...doc, layers: replaceLayer(doc.layers, id, group), activeLayerIds: [group.id] };
}

// ---- smart filters -----------------------------------------------------------------------

function updateSmart(doc: Doc, id: number, fn: (l: SmartObjectLayer) => SmartObjectLayer | null, resolveMap?: MapResolver): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer || layer.kind !== 'smart') return doc;
  const next = fn(layer);
  if (!next || next === layer) return doc;
  return { ...doc, layers: replaceLayer(doc.layers, id, rendered(next, doc, resolveMap)) };
}

let nextFilterId = 1;

/** Filter ▸ any filter, on a smart object: the filter goes on top of its stack. */
export function addSmartFilter(doc: Doc, id: number, f: Omit<SmartFilter, 'id'>, resolveMap?: MapResolver): Doc {
  return updateSmart(doc, id, (l) => ({ ...l, filters: [...l.filters, { ...f, id: nextFilterId++ }], filtersEnabled: true, filterMask: l.filterMask ?? whiteMask() }), resolveMap);
}

export function updateSmartFilter(doc: Doc, id: number, index: number, patch: Partial<Omit<SmartFilter, 'id'>>, resolveMap?: MapResolver): Doc {
  return updateSmart(doc, id, (l) => (l.filters[index] ? { ...l, filters: l.filters.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : null), resolveMap);
}

export function removeSmartFilter(doc: Doc, id: number, index: number): Doc {
  return updateSmart(doc, id, (l) => {
    if (!l.filters[index]) return null;
    const filters = l.filters.filter((_, i) => i !== index);
    // The last filter takes the Smart Filters row, and its mask, with it.
    return { ...l, filters, filterMask: filters.length ? l.filterMask : undefined };
  });
}

export function moveSmartFilter(doc: Doc, id: number, from: number, to: number): Doc {
  return updateSmart(doc, id, (l) => {
    if (!l.filters[from] || to < 0 || to >= l.filters.length || from === to) return null;
    const filters = [...l.filters];
    const [f] = filters.splice(from, 1);
    filters.splice(to, 0, f!);
    return { ...l, filters };
  });
}

export function setSmartFiltersEnabled(doc: Doc, id: number, enabled: boolean): Doc {
  return updateSmart(doc, id, (l) => (l.filtersEnabled === enabled ? null : { ...l, filtersEnabled: enabled }));
}

export function clearSmartFilters(doc: Doc, id: number): Doc {
  return updateSmart(doc, id, (l) => (l.filters.length ? { ...l, filters: [], filterMask: undefined } : null));
}

export function setFilterMaskEnabled(doc: Doc, id: number, enabled: boolean): Doc {
  return updateSmart(doc, id, (l) => (l.filterMask && l.filterMask.enabled !== enabled ? { ...l, filterMask: { ...l.filterMask, enabled } } : null));
}

export function deleteFilterMask(doc: Doc, id: number): Doc {
  return updateSmart(doc, id, (l) => (l.filterMask ? { ...l, filterMask: undefined } : null));
}

/** Put new contents in every instance of a source, re-rendering each. */
export function replaceSource(doc: Doc, source: SmartSource): Doc {
  let layers = doc.layers;
  for (const { layer } of walkLayers(doc.layers)) {
    if (layer.kind === 'smart' && layer.source.id === source.id) {
      layers = updateLayer(layers, layer.id, (l) => rendered({ ...(l as SmartObjectLayer), source }, doc));
    }
  }
  return layers === doc.layers ? doc : { ...doc, layers };
}

/** How many layers share a source — instances made by Duplicate Layer. */
export function instanceCount(doc: Doc, sourceId: number): number {
  let n = 0;
  for (const { layer } of walkLayers(doc.layers)) if (layer.kind === 'smart' && layer.source.id === sourceId) n++;
  return n;
}

/**
 * Put a source in place without re-rendering: every layer showing it keeps its pixels. For
 * contents that arrive after a document opened (an embedded picture decoded later) — the
 * file's own rendering is what should show until something changes. Nested documents are
 * searched too.
 */
export function swapSource(doc: Doc, source: SmartSource): Doc {
  const visit = (layers: readonly Layer[]): readonly Layer[] => {
    let changed = false;
    const out = layers.map((l) => {
      if (l.kind === 'group') {
        const children = visit(l.children);
        if (children === l.children) return l;
        changed = true;
        return { ...l, children };
      }
      if (l.kind !== 'smart') return l;
      if (l.source.id === source.id) {
        changed = true;
        return { ...l, source };
      }
      const inner = visit(l.source.doc.layers);
      if (inner === l.source.doc.layers) return l;
      changed = true;
      return { ...l, source: { ...l.source, doc: { ...l.source.doc, layers: inner } } };
    });
    return changed ? out : layers;
  };
  const layers = visit(doc.layers);
  return layers === doc.layers ? doc : { ...doc, layers };
}
