/**
 * Cut, Copy, Copy Merged and the three Pastes — spec 04 §7.
 *
 * The clipboard holds a plane and the document rectangle it came from, not a bitmap: keeping
 * it in the tile format means Paste in Place is exact, and a copied region with a feathered or
 * anti-aliased selection edge keeps that edge, because the selection's coverage is multiplied
 * into alpha on the way out rather than being rounded to a rectangle.
 */
import { TILE_SIZE, TILE_SHIFT, channelCount, type PlaneFormat } from '@umbra/core/pixels';
import { rectIsEmpty, type Rect } from '@umbra/core/geom';
import { maskBounds } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import { RGBA8 } from '../tiles/import.js';
import {
  findLayer,
  insertLayer,
  makePixelLayer,
  updateLayer,
  type Doc,
  type PixelLayer,
} from '../document.js';
import type { Selection } from '../selection.js';
import { shiftPlane } from './transform.js';

/** Masks are a single coverage channel, matching what the PSD reader produces. */
const MASK8: PlaneFormat = { layout: 'A', sample: 'u8' };

export interface Clipboard {
  plane: Plane;
  /** Where it came from, so Paste in Place can put it back exactly. */
  source: Rect;
  /** The document it was copied from, for the "paste centred" fallback. */
  docWidth: number;
  docHeight: number;
}

function activePixelLayer(doc: Doc): PixelLayer | null {
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

/** Region a copy covers: the selection when there is one, else the whole canvas. */
export function copyRegion(doc: Doc): Rect | null {
  if (doc.selection) {
    const b = maskBounds(doc.selection.mask, { width: doc.width, height: doc.height });
    return b ?? null;
  }
  return { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
}

/**
 * Pull a rectangle of straight-alpha RGBA out of `read`, with the selection's coverage folded
 * into alpha. `read` is what lets Copy and Copy Merged share everything but their source.
 */
function extract(
  region: Rect,
  sel: Selection | null,
  docWidth: number,
  read: (x: number, y: number, out: Uint8Array) => void,
): Plane {
  const writer = Plane.empty(RGBA8).writer();
  const px = new Uint8Array(4);
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      read(x, y, px);
      let a = px[3]!;
      if (sel) a = Math.round((a * sel.mask[y * docWidth + x]!) / 255);
      if (a <= 0) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = (((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))) * 4;
      data[o] = px[0]!;
      data[o + 1] = px[1]!;
      data[o + 2] = px[2]!;
      data[o + 3] = a;
    }
  }
  return writer.commit();
}

function planeSampler(plane: Plane): (x: number, y: number, out: Uint8Array) => void {
  const n = channelCount(plane.format.layout);
  return (x, y, out) => {
    const tile = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const o = tile.uniform ? 0 : (((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))) * n;
    if (n === 1) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = tile.data[o]!;
      return;
    }
    out[0] = tile.data[o]!;
    out[1] = tile.data[o + 1]!;
    out[2] = tile.data[o + 2]!;
    out[3] = tile.data[o + 3]!;
  };
}

/** Edit ▸ Copy: the active layer, through the selection. */
export function copy(doc: Doc): Clipboard | null {
  const layer = activePixelLayer(doc);
  const region = copyRegion(doc);
  if (!layer || !region || rectIsEmpty(region)) return null;
  const plane = extract(region, doc.selection, doc.width, planeSampler(layer.plane.base));
  if (rectIsEmpty(plane.bounds)) return null;
  return { plane, source: region, docWidth: doc.width, docHeight: doc.height };
}

/**
 * Edit ▸ Copy Merged: the composited document through the selection. The caller supplies the
 * composite, because producing it needs the GPU and this module is pure.
 */
export function copyMerged(
  doc: Doc,
  composite: { pixels: Uint8Array; width: number; height: number },
): Clipboard | null {
  const region = copyRegion(doc);
  if (!region || rectIsEmpty(region)) return null;
  const read = (x: number, y: number, out: Uint8Array) => {
    if (x < 0 || y < 0 || x >= composite.width || y >= composite.height) {
      out.fill(0);
      return;
    }
    const o = (y * composite.width + x) * 4;
    out[0] = composite.pixels[o]!;
    out[1] = composite.pixels[o + 1]!;
    out[2] = composite.pixels[o + 2]!;
    out[3] = composite.pixels[o + 3]!;
  };
  const plane = extract(region, doc.selection, doc.width, read);
  if (rectIsEmpty(plane.bounds)) return null;
  return { plane, source: region, docWidth: doc.width, docHeight: doc.height };
}

/** Erase the selection from the active layer — the second half of Cut. */
export function clearSelection(doc: Doc): Doc {
  const layer = activePixelLayer(doc);
  if (!layer || layer.locks.pixels || layer.locks.all) return doc;
  const region = copyRegion(doc);
  if (!region || rectIsEmpty(region)) return doc;

  const writer = layer.plane.base.writer();
  const sel = doc.selection;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const coverage = sel ? sel.mask[y * doc.width + x]! : 255;
      if (coverage === 0) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = (((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))) * 4;
      data[o + 3] = Math.round((data[o + 3]! * (255 - coverage)) / 255);
    }
  }
  return {
    ...doc,
    layers: updateLayer(doc.layers, layer.id, (l) =>
      l.kind === 'pixel' ? { ...l, plane: new MipPlane(writer.commit()) } : l,
    ),
  };
}

export type PasteMode = 'normal' | 'inPlace' | 'into' | 'outside';

/**
 * The three Pastes.
 *
 * Plain Paste centres the content in the CURRENT view, which is what Photoshop does and why
 * pasting into a scrolled document lands where you are looking rather than where the pixels
 * came from. Paste in Place keeps the original coordinates. Paste Into adds a layer mask from
 * the selection — Paste Outside is the same mask inverted — so the pasted pixels stay
 * editable inside their frame instead of being cropped.
 */
export function paste(
  doc: Doc,
  clip: Clipboard,
  mode: PasteMode,
  viewCentre: { x: number; y: number },
): Doc {
  let plane = clip.plane;

  if (mode !== 'inPlace') {
    const w = clip.source.x1 - clip.source.x0;
    const h = clip.source.y1 - clip.source.y0;
    const target =
      mode === 'into' || mode === 'outside'
        ? centreOfSelection(doc) ?? viewCentre
        : viewCentre;
    const dx = Math.round(target.x - w / 2) - clip.source.x0;
    const dy = Math.round(target.y - h / 2) - clip.source.y0;
    plane = shiftPlane(plane, dx, dy);
  }

  const layer = makePixelLayer('Layer 1', plane);
  let next: PixelLayer = layer;

  if ((mode === 'into' || mode === 'outside') && doc.selection) {
    next = { ...layer, mask: selectionAsMask(doc, mode === 'outside') };
  }

  const above = doc.activeLayerIds[0];
  return {
    ...doc,
    layers: insertLayer(doc.layers, next, above),
    activeLayerIds: [next.id],
    // Photoshop drops the selection after Paste Into: the frame is the mask now.
    selection: mode === 'into' || mode === 'outside' ? null : doc.selection,
  };
}

function centreOfSelection(doc: Doc): { x: number; y: number } | null {
  if (!doc.selection) return null;
  const b = maskBounds(doc.selection.mask, { width: doc.width, height: doc.height });
  return b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : null;
}

/** Turn the active selection into a layer mask, for Paste Into. */
function selectionAsMask(doc: Doc, invert: boolean) {
  const sel = doc.selection!;
  const writer = Plane.empty(MASK8, [0]).writer();
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const v = sel.mask[y * doc.width + x]!;
      const value = invert ? 255 - v : v;
      if (value === 0) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      data[((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))] = value;
    }
  }
  return {
    plane: new MipPlane(writer.commit()),
    enabled: true,
    linked: true,
    density: 1,
    feather: 0,
    defaultColor: 0 as const,
  };
}
