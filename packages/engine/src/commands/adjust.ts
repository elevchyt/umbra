/**
 * Image ▸ Adjustments and Layer ▸ New Adjustment Layer — spec 05 §A.
 *
 * One kernel serves both: the destructive command runs `compile(adj)` over the layer's tiles
 * through the selection, and an adjustment layer hands the same `Adjustment` value to the
 * compositor, which runs its GPU mirror or the CPU reference over whatever lies beneath.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { ADJUSTMENT_LABEL, applyToRgba8, compile, isNoOp, type Adjustment, type Applier } from '@umbra/kernels/adjust';
import {
  findLayer,
  insertLayer,
  makeAdjustmentLayer,
  updateLayer,
  type Doc,
} from '../document.js';
import { MipPlane } from '../tiles/mip.js';
import { numberedName } from './layers.js';
import { addMask } from './masks.js';

/**
 * Apply an adjustment to a pixel layer's pixels, confined to the selection with partial
 * coverage where it is feathered. Only stored tiles are visited: the unstored remainder is
 * transparent, and adjustments never touch transparent pixels.
 */
export function applyAdjustment(doc: Doc, layerId: number, adj: Adjustment): Doc {
  return applyApplier(doc, layerId, compile(adj));
}

/** Equalize and anything else that arrives as a bare table rather than an `Adjustment`. */
export function applyLut(doc: Doc, layerId: number, lut: Uint8Array): Doc {
  return applyApplier(doc, layerId, { shape: 'lut', r: lut, g: lut, b: lut });
}

function applyApplier(doc: Doc, layerId: number, applier: Applier): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer || layer.kind !== 'pixel' || layer.locks.pixels || layer.locks.all) return doc;
  if (isNoOp(applier)) return doc;

  const sel = doc.selection;
  const src = layer.plane.base;
  const writer = src.writer();
  const coverage = sel ? new Uint8Array(TILE_SIZE * TILE_SIZE) : undefined;
  let changed = false;

  for (const { tx, ty } of src.tileCells()) {
    if (!src.hasTile(tx, ty) || src.tileAt(tx, ty).isTransparent()) continue;
    if (sel && coverage) {
      // The selection is canvas-sized; tiles hanging off the canvas get zero coverage there.
      coverage.fill(0);
      let any = false;
      const x0 = tx << TILE_SHIFT;
      const y0 = ty << TILE_SHIFT;
      for (let y = 0; y < TILE_SIZE; y++) {
        const dy = y0 + y;
        if (dy < 0 || dy >= sel.height) continue;
        for (let x = 0; x < TILE_SIZE; x++) {
          const dx = x0 + x;
          if (dx < 0 || dx >= sel.width) continue;
          const v = sel.mask[dy * sel.width + dx]!;
          coverage[y * TILE_SIZE + x] = v;
          if (v) any = true;
        }
      }
      if (!any) continue;
    }
    applyToRgba8(applier, writer.mutable(tx, ty) as Uint8Array, coverage);
    changed = true;
  }
  if (!changed) return doc;

  const plane = new MipPlane(writer.commit());
  return { ...doc, layers: updateLayer(doc.layers, layerId, (l) => ({ ...l, plane }) as typeof l) };
}

/**
 * Layer ▸ New Adjustment Layer. It goes directly above the active layer, and gets a mask the
 * way Photoshop does: the selection when there is one, otherwise an empty reveal-all mask
 * ready to paint into.
 */
export function addAdjustmentLayer(doc: Doc, adj: Adjustment): Doc {
  const layer = makeAdjustmentLayer(numberedName(doc, ADJUSTMENT_LABEL[adj.kind]), adj);
  const active = doc.activeLayerIds[0];
  const next: Doc = {
    ...doc,
    layers: insertLayer(doc.layers, layer, active),
    activeLayerIds: [layer.id],
  };
  return addMask(next, layer.id, doc.selection ? 'revealSelection' : 'revealAll');
}

/** Change an adjustment layer's parameters. The kind may change too (Properties' presets). */
export function setAdjustment(doc: Doc, layerId: number, adj: Adjustment): Doc {
  const layer = findLayer(doc.layers, layerId);
  if (!layer || layer.kind !== 'adjustment') return doc;
  return { ...doc, layers: updateLayer(doc.layers, layerId, (l) => ({ ...l, adjustment: adj }) as typeof l) };
}
