/**
 * Layer tree commands — spec 02 §2 ("Layer operations").
 *
 * Every function is pure: it takes a `Doc` and returns a new one, sharing every untouched
 * subtree and tile. That is what lets history keep 50 states cheaply and what makes these
 * trivially testable (spec 03 §6).
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { compositeDocument } from '@umbra/kernels/composite';
import { rectIsEmpty, type Rect } from '@umbra/core/geom';
import {
  makeGroup,
  makePixelLayer,
  nextLayerId,
  walkLayers,
  type Doc,
  type GroupLayer,
  type Layer,
  type PixelLayer,
} from '../document.js';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import { RGBA8 } from '../tiles/import.js';
import { toCompositeLayer } from '../render/cpu-composite.js';

/** Parent list containing `id`, plus its index there. */
interface Located {
  parent: readonly Layer[];
  index: number;
  parentGroupId: number | null;
}

function locate(layers: readonly Layer[], id: number, parentGroupId: number | null = null): Located | null {
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    if (l.id === id) return { parent: layers, index: i, parentGroupId };
    if (l.kind === 'group') {
      const found = locate(l.children, id, l.id);
      if (found) return found;
    }
  }
  return null;
}

/** Rebuild the tree with `fn` applied to the sibling list that contains `id`. */
function mapSiblings(
  layers: readonly Layer[],
  id: number,
  fn: (siblings: Layer[], index: number) => Layer[],
): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  if (i >= 0) return fn([...layers], i);
  return layers.map((l) =>
    l.kind === 'group' ? { ...l, children: mapSiblings(l.children, id, fn) } : l,
  );
}

export function addLayer(doc: Doc, name = 'Layer'): Doc {
  const layer = makePixelLayer(nameFor(doc, name), Plane.empty(RGBA8));
  const active = doc.activeLayerIds[0];
  const layers =
    active === undefined
      ? [...doc.layers, layer]
      : mapSiblings(doc.layers, active, (sib, i) => {
          sib.splice(i + 1, 0, layer);
          return sib;
        });
  return { ...doc, layers, activeLayerIds: [layer.id] };
}

/** "Layer 1", "Layer 2", … avoiding names already in the document. */
function nameFor(doc: Doc, base: string): string {
  const used = new Set([...walkLayers(doc.layers)].map((w) => w.layer.name));
  if (!used.has(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function deleteLayer(doc: Doc, id: number): Doc {
  const layers = mapSiblings(doc.layers, id, (sib, i) => {
    sib.splice(i, 1);
    return sib;
  });
  return { ...doc, layers, activeLayerIds: doc.activeLayerIds.filter((a) => a !== id) };
}

/** Deep copy with fresh ids, so the copy is independent in the tree but shares its tiles. */
function cloneLayer(layer: Layer, rename = false): Layer {
  const name = rename ? `${layer.name} copy` : layer.name;
  if (layer.kind === 'group') {
    return { ...layer, id: nextLayerId(), name, children: layer.children.map((c) => cloneLayer(c)) };
  }
  return { ...layer, id: nextLayerId(), name };
}

export function duplicateLayer(doc: Doc, id: number): Doc {
  const found = locate(doc.layers, id);
  if (!found) return doc;
  const copy = cloneLayer(found.parent[found.index]!, true);
  const layers = mapSiblings(doc.layers, id, (sib, i) => {
    sib.splice(i + 1, 0, copy);
    return sib;
  });
  return { ...doc, layers, activeLayerIds: [copy.id] };
}

/** Move a layer up or down within its own sibling list. */
export function reorderLayer(doc: Doc, id: number, delta: number): Doc {
  const layers = mapSiblings(doc.layers, id, (sib, i) => {
    const target = Math.max(0, Math.min(sib.length - 1, i + delta));
    if (target === i) return sib;
    const [moved] = sib.splice(i, 1);
    sib.splice(target, 0, moved!);
    return sib;
  });
  return { ...doc, layers };
}

/**
 * Group the given layers. They must be siblings — Photoshop also refuses to group across
 * different parents — and the group takes the position of the topmost one.
 */
export function groupLayers(doc: Doc, ids: readonly number[], name = 'Group'): Doc {
  if (ids.length === 0) return doc;
  const first = locate(doc.layers, ids[0]!);
  if (!first) return doc;
  for (const id of ids) {
    const l = locate(doc.layers, id);
    if (!l || l.parentGroupId !== first.parentGroupId) return doc;
  }

  const idSet = new Set(ids);
  const rebuild = (siblings: readonly Layer[]): Layer[] => {
    const contains = siblings.some((l) => idSet.has(l.id));
    if (!contains) {
      return siblings.map((l) =>
        l.kind === 'group' ? { ...l, children: rebuild(l.children) } : l,
      );
    }
    const picked = siblings.filter((l) => idSet.has(l.id));
    const rest = siblings.filter((l) => !idSet.has(l.id));
    const topIndex = siblings.reduce((acc, l, i) => (idSet.has(l.id) ? i : acc), 0);
    const insertAt = rest.findIndex((l) => siblings.indexOf(l) > topIndex);
    const group = makeGroup(nameFor(doc, name), picked);
    const out = [...rest];
    out.splice(insertAt < 0 ? out.length : insertAt, 0, group);
    return out;
  };

  const layers = rebuild(doc.layers);
  const group = [...walkLayers(layers)].find((w) => w.layer.kind === 'group' && w.layer.name.startsWith(name));
  return { ...doc, layers, activeLayerIds: group ? [group.layer.id] : doc.activeLayerIds };
}

export function ungroup(doc: Doc, id: number): Doc {
  const found = locate(doc.layers, id);
  if (!found) return doc;
  const group = found.parent[found.index];
  if (!group || group.kind !== 'group') return doc;
  const layers = mapSiblings(doc.layers, id, (sib, i) => {
    sib.splice(i, 1, ...group.children);
    return sib;
  });
  return { ...doc, layers, activeLayerIds: group.children.map((c) => c.id) };
}

// ---- rasterising ------------------------------------------------------------------------

/**
 * Composite a set of layers into a new pixel plane, using the CPU reference.
 *
 * This is correct but walks the tree per pixel, so it is fine for merge/flatten on a document
 * of ordinary size and wrong for anything interactive. The tiled fast path belongs with the
 * export work (spec 03 §5.3).
 */
export function rasterize(layers: readonly Layer[], rect: Rect): Plane {
  const writer = Plane.empty(RGBA8).writer();
  if (rectIsEmpty(rect)) return writer.commit();
  const composite = layers.map(toCompositeLayer);

  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const px = compositeDocument(composite, x, y);
      if (px.alpha <= 0) continue;
      const data = writer.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = ((y - ((y >> TILE_SHIFT) << TILE_SHIFT)) * TILE_SIZE + (x - ((x >> TILE_SHIFT) << TILE_SHIFT))) * 4;
      data[o] = Math.round(px.color[0] * 255);
      data[o + 1] = Math.round(px.color[1] * 255);
      data[o + 2] = Math.round(px.color[2] * 255);
      data[o + 3] = Math.round(px.alpha * 255);
    }
  }
  return writer.commit();
}

const canvasRect = (doc: Doc): Rect => ({ x0: 0, y0: 0, x1: doc.width, y1: doc.height });

/** Merge a layer into the one below it, as Ctrl+E does. */
export function mergeDown(doc: Doc, id: number): Doc {
  const found = locate(doc.layers, id);
  if (!found || found.index === 0) return doc;
  const upper = found.parent[found.index]!;
  const lower = found.parent[found.index - 1]!;

  // The pair is composited on its own, so the result is independent of what is beneath them.
  const merged = makePixelLayer(lower.name, rasterize([lower, upper], canvasRect(doc)));
  const layers = mapSiblings(doc.layers, id, (sib, i) => {
    sib.splice(i - 1, 2, merged);
    return sib;
  });
  return { ...doc, layers, activeLayerIds: [merged.id] };
}

export function mergeVisible(doc: Doc): Doc {
  const visible = doc.layers.filter((l) => l.visible);
  if (visible.length === 0) return doc;
  const merged = makePixelLayer(visible[0]!.name, rasterize(visible, canvasRect(doc)));
  const hidden = doc.layers.filter((l) => !l.visible);
  return { ...doc, layers: [merged, ...hidden], activeLayerIds: [merged.id] };
}

export function flatten(doc: Doc, name = 'Background'): Doc {
  const merged = makePixelLayer(name, rasterize(doc.layers.filter((l) => l.visible), canvasRect(doc)));
  return { ...doc, layers: [merged], activeLayerIds: [merged.id], hasBackground: true };
}

/** Ctrl+Shift+Alt+E: a merged copy of everything visible, on a NEW layer above. */
export function stampVisible(doc: Doc): Doc {
  const visible = doc.layers.filter((l) => l.visible);
  if (visible.length === 0) return doc;
  const stamp = makePixelLayer(nameFor(doc, 'Merged'), rasterize(visible, canvasRect(doc)));
  return { ...doc, layers: [...doc.layers, stamp], activeLayerIds: [stamp.id] };
}

export type { PixelLayer, GroupLayer, MipPlane };
