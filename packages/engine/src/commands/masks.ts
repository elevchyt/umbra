/**
 * Layer masks — Layer ▸ Layer Mask and the Layers panel's Add Mask button (spec 02 §3).
 *
 * A mask is a single-channel plane plus a DEFAULT value for everywhere it stores nothing.
 * That default is what makes the common cases free: Reveal All is no tiles at all with a white
 * default, and a mask painted in one corner of a 4K canvas costs one tile. It is also what
 * Photoshop writes into a PSD, so masks read from a file and masks made here are the same thing.
 */
import { TILE_SIZE, TILE_SHIFT, channelCount, type PlaneFormat } from '@umbra/core/pixels';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import { findLayer, updateLayer, type Doc, type Layer, type RasterMask } from '../document.js';

const MASK8: PlaneFormat = { layout: 'A', sample: 'u8' };

export type AddMaskMode =
  | 'revealAll'
  | 'hideAll'
  | 'revealSelection'
  | 'hideSelection'
  | 'fromTransparency';

/**
 * Coverage mask → plane with a chosen default, storing only the pixels that DIFFER from it.
 * Hide Selection is mostly white; storing it against a white default keeps it as small as the
 * selection is, rather than as big as the canvas.
 */
function planeFrom(coverage: Uint8Array, width: number, height: number, def: 0 | 255, invert: boolean): Plane {
  const writer = Plane.empty(MASK8, [def]).writer();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const raw = coverage[y * width + x]!;
      const v = invert ? 255 - raw : raw;
      if (v === def) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      data[((y & (TILE_SIZE - 1)) * TILE_SIZE) + (x & (TILE_SIZE - 1))] = v;
    }
  }
  return writer.commit();
}

/** The selection as a mask plane, or null when there is none — for previews and new layers. */
export function selectionPlane(doc: Doc): Plane | null {
  const sel = doc.selection;
  return sel ? planeFrom(sel.mask, doc.width, doc.height, 0, false) : null;
}

function maskOf(plane: Plane, defaultColor: 0 | 1): RasterMask {
  return {
    plane: new MipPlane(plane),
    enabled: true,
    linked: true,
    density: 1,
    feather: 0,
    defaultColor,
  };
}

/**
 * Add a mask. With a selection, the Add Mask button makes Reveal Selection and Alt makes Hide
 * Selection; without one, Reveal All and Hide All. A layer that already has a mask is left
 * alone — Photoshop's second click would add a VECTOR mask, which does not exist yet.
 */
export function addMask(doc: Doc, id: number, mode: AddMaskMode): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer || layer.mask) return doc;
  const sel = doc.selection;

  let mask: RasterMask;
  switch (mode) {
    case 'revealAll':
      mask = maskOf(Plane.empty(MASK8, [255]), 1);
      break;
    case 'hideAll':
      mask = maskOf(Plane.empty(MASK8, [0]), 0);
      break;
    case 'revealSelection':
      if (!sel) return addMask(doc, id, 'revealAll');
      mask = maskOf(planeFrom(sel.mask, doc.width, doc.height, 0, false), 0);
      break;
    case 'hideSelection':
      if (!sel) return addMask(doc, id, 'hideAll');
      mask = maskOf(planeFrom(sel.mask, doc.width, doc.height, 255, true), 1);
      break;
    case 'fromTransparency': {
      // The layer's own alpha becomes the mask, tile for tile — only where the layer stores
      // something, against a hide default, so a sparse layer gives a sparse mask.
      if (layer.kind !== 'pixel') return doc;
      const src = layer.plane.base;
      const writer = Plane.empty(MASK8, [0]).writer();
      for (const { tx, ty } of src.tileCells()) {
        const t = src.tileAt(tx, ty);
        if (t.isTransparent()) continue;
        const data = writer.mutable(tx, ty);
        for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
          data[i] = t.uniform ? t.data[3]! : t.data[i * 4 + 3]!;
        }
      }
      mask = maskOf(writer.commit(), 0);
      break;
    }
  }
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => ({ ...l, mask })),
    // The selection has become the mask; keeping it would invite applying it twice.
    selection: mode === 'revealSelection' || mode === 'hideSelection' ? null : doc.selection,
  };
}

export function deleteMask(doc: Doc, id: number): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer?.mask) return doc;
  return { ...doc, layers: updateLayer(doc.layers, id, (l) => ({ ...l, mask: undefined })) };
}

/** Layer ▸ Layer Mask ▸ Disable/Enable — Shift-click on the thumbnail in Photoshop. */
export function setMaskEnabled(doc: Doc, id: number, enabled: boolean): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer?.mask || layer.mask.enabled === enabled) return doc;
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => (l.mask ? { ...l, mask: { ...l.mask, enabled } } : l)),
  };
}

/**
 * Layer ▸ Layer Mask ▸ Apply: bake the mask into the layer's alpha and drop it.
 *
 * Every tile the LAYER has is visited, not just those the mask stores — an unstored mask area
 * still has a value (its default), and a Hide All mask stores nothing yet must erase everything.
 */
export function applyMask(doc: Doc, id: number): Doc {
  const layer = findLayer(doc.layers, id);
  if (!layer?.mask || layer.kind !== 'pixel') return doc;
  const mask = layer.mask;
  const plane = layer.plane.base;
  if (channelCount(plane.format.layout) !== 4) return doc;

  const writer = plane.writer();
  const maskPlane = mask.plane.base;
  const density = mask.density;
  for (const { tx, ty } of plane.tileCells()) {
    const mt = maskPlane.tileAt(tx, ty);
    // A fully revealing mask tile changes nothing, so do not even copy the layer tile.
    if (mt.uniform && mt.data[0] === 255) continue;
    const data = writer.mutable(tx, ty);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const m = mt.uniform ? mt.data[0]! : mt.data[i]!;
      // Density scales how far the mask pulls away from "reveal", as the Properties slider does.
      const k = 1 - density * (1 - m / 255);
      data[i * 4 + 3] = Math.round(data[i * 4 + 3]! * k);
    }
  }
  const baked = writer.commit();
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l): Layer =>
      l.kind === 'pixel' ? { ...l, plane: new MipPlane(baked), mask: undefined } : l,
    ),
  };
}
