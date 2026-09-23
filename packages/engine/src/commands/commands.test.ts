import { describe, expect, it } from 'vitest';
import {
  addLayer,
  deleteLayer,
  duplicateLayer,
  flatten,
  groupLayers,
  mergeDown,
  mergeVisible,
  reorderLayer,
  stampVisible,
  ungroup,
  rasterize,
} from './layers.js';
import {
  anchorOffset,
  canvasSize,
  flipImage,
  imageSize,
  resamplePlane,
  revealAll,
  rotateImage,
  trim,
} from './image.js';
import {
  emptyDoc,
  makeGroup,
  makePixelLayer,
  panelRows,
  walkLayers,
  type Doc,
  type GroupLayer,
  type PixelLayer,
} from '../document.js';
import { Plane } from '../tiles/plane.js';
import { MipPlane } from '../tiles/mip.js';
import { RGBA8 } from '../tiles/import.js';
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { tightBounds } from '../psd-save.js';

/** Solid rect of colour in an otherwise empty plane. */
function rectPlane(x0: number, y0: number, x1: number, y1: number, rgba: [number, number, number, number]): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
      const o = ((y - ((y >> TILE_SHIFT) << TILE_SHIFT)) * TILE_SIZE + (x - ((x >> TILE_SHIFT) << TILE_SHIFT))) * 4;
      d[o] = rgba[0];
      d[o + 1] = rgba[1];
      d[o + 2] = rgba[2];
      d[o + 3] = rgba[3];
    }
  }
  return w.commit();
}

function readPixel(plane: Plane, x: number, y: number): number[] {
  const out = new Uint8Array(4);
  plane.readPixel(x, y, out);
  return [...out];
}

function docWith(...names: string[]): Doc {
  const layers = names.map((n) => makePixelLayer(n, rectPlane(0, 0, 8, 8, [255, 0, 0, 255])));
  return { ...emptyDoc(32, 32), layers, activeLayerIds: [layers.at(-1)!.id] };
}

describe('layer tree commands', () => {
  it('adds a layer above the active one', () => {
    const doc = docWith('A', 'B');
    const next = addLayer(doc, 'New');
    expect(next.layers.map((l) => l.name)).toEqual(['A', 'B', 'New']);
    expect(next.activeLayerIds).toHaveLength(1);
    // The original is untouched.
    expect(doc.layers).toHaveLength(2);
  });

  it('numbers a default new layer one past the highest in use', () => {
    expect(addLayer(docWith('Layer 1', 'Layer 2', 'Layer 3')).layers.at(-1)!.name).toBe('Layer 4');
    expect(addLayer(docWith('Background')).layers.at(-1)!.name).toBe('Layer 1');
  });

  it('does not refill a gap in the numbering, as Photoshop does not', () => {
    expect(addLayer(docWith('Layer 1', 'Layer 3')).layers.at(-1)!.name).toBe('Layer 4');
  });

  it('ignores names that merely start with the base', () => {
    expect(addLayer(docWith('Layer 9 copy', 'Layers 50')).layers.at(-1)!.name).toBe('Layer 1');
  });

  it('selects the group it just made, not an older one', () => {
    let doc = docWith('A', 'B', 'C', 'D');
    const [a, b, c, d] = doc.layers.map((l) => l.id);
    doc = groupLayers(doc, [a!, b!]);
    const first = doc.activeLayerIds[0];
    doc = groupLayers(doc, [c!, d!]);
    const second = doc.activeLayerIds[0];
    expect(second).not.toBe(first);
    const names = doc.layers.map((l) => l.name);
    expect(names).toContain('Group 1');
    expect(names).toContain('Group 2');
    expect(doc.layers.find((l) => l.id === second)!.name).toBe('Group 2');
  });

  it('avoids duplicate names', () => {
    let doc = docWith('Layer');
    doc = addLayer(doc, 'Layer');
    expect(doc.layers.map((l) => l.name)).toEqual(['Layer', 'Layer 1']);
  });

  it('deletes a layer and clears it from the selection', () => {
    const doc = docWith('A', 'B', 'C');
    const id = doc.layers[1]!.id;
    const next = deleteLayer({ ...doc, activeLayerIds: [id] }, id);
    expect(next.layers.map((l) => l.name)).toEqual(['A', 'C']);
    expect(next.activeLayerIds).not.toContain(id);
  });

  it('duplicates a layer with a fresh id and shared tiles', () => {
    const doc = docWith('A');
    const next = duplicateLayer(doc, doc.layers[0]!.id);
    expect(next.layers.map((l) => l.name)).toEqual(['A', 'A copy']);
    expect(next.layers[1]!.id).not.toBe(next.layers[0]!.id);
    // Copy-on-write means the copy shares the original's tiles rather than cloning pixels.
    const a = next.layers[0] as PixelLayer;
    const b = next.layers[1] as PixelLayer;
    expect(b.plane.base.tileAt(0, 0)).toBe(a.plane.base.tileAt(0, 0));
  });

  it('reorders within the sibling list and clamps at the ends', () => {
    const doc = docWith('A', 'B', 'C');
    expect(reorderLayer(doc, doc.layers[0]!.id, 1).layers.map((l) => l.name)).toEqual(['B', 'A', 'C']);
    expect(reorderLayer(doc, doc.layers[0]!.id, -1).layers.map((l) => l.name)).toEqual(['A', 'B', 'C']);
    expect(reorderLayer(doc, doc.layers[2]!.id, 5).layers.map((l) => l.name)).toEqual(['A', 'B', 'C']);
  });

  it('groups sibling layers', () => {
    const doc = docWith('A', 'B', 'C');
    const next = groupLayers(doc, [doc.layers[0]!.id, doc.layers[1]!.id]);
    const group = next.layers.find((l) => l.kind === 'group') as GroupLayer;
    expect(group).toBeDefined();
    expect(group.children.map((c) => c.name)).toEqual(['A', 'B']);
    expect(next.layers.map((l) => l.name)).toContain('C');
  });

  it('refuses to group layers with different parents', () => {
    const inner = makePixelLayer('Inner', Plane.empty(RGBA8));
    const group = makeGroup('G', [inner]);
    const outer = makePixelLayer('Outer', Plane.empty(RGBA8));
    const doc: Doc = { ...emptyDoc(16, 16), layers: [group, outer] };
    // Photoshop also refuses this; silently re-parenting would lose the user's structure.
    expect(groupLayers(doc, [inner.id, outer.id])).toBe(doc);
  });

  it('ungroups back into the parent list', () => {
    const doc = docWith('A', 'B', 'C');
    const grouped = groupLayers(doc, [doc.layers[0]!.id, doc.layers[1]!.id]);
    const group = grouped.layers.find((l) => l.kind === 'group')!;
    const next = ungroup(grouped, group.id);
    expect(next.layers.map((l) => l.name).sort()).toEqual(['A', 'B', 'C']);
    expect(next.layers.some((l) => l.kind === 'group')).toBe(false);
  });

  it('keeps group nesting visible in panel order', () => {
    const doc = docWith('A', 'B', 'C');
    const grouped = groupLayers(doc, [doc.layers[0]!.id, doc.layers[1]!.id]);
    const rows = panelRows(grouped.layers).map((r) => `${r.depth}:${r.layer.name}`);
    expect(rows.filter((r) => r.startsWith('1:'))).toHaveLength(2);
  });
});

describe('rasterising commands', () => {
  const base = makePixelLayer('Base', rectPlane(0, 0, 16, 16, [0, 0, 255, 255]));
  const top = makePixelLayer('Top', rectPlane(0, 0, 8, 16, [255, 0, 0, 255]));
  const doc: Doc = { ...emptyDoc(16, 16), layers: [base, top], activeLayerIds: [top.id] };

  it('composites a pair when merging down', () => {
    const next = mergeDown(doc, top.id);
    expect(next.layers).toHaveLength(1);
    const plane = (next.layers[0] as PixelLayer).plane.base;
    // Left half is the red top layer, right half the blue base.
    expect(readPixel(plane, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(readPixel(plane, 12, 2)).toEqual([0, 0, 255, 255]);
  });

  it('keeps the lower layer name when merging down', () => {
    expect(mergeDown(doc, top.id).layers[0]!.name).toBe('Base');
  });

  it('does nothing when merging the bottom layer down', () => {
    expect(mergeDown(doc, base.id)).toBe(doc);
  });

  it('honours blend mode when merging', () => {
    const multiplied = { ...top, blendMode: 'multiply' as const };
    const d: Doc = { ...doc, layers: [base, multiplied] };
    const plane = (mergeDown(d, multiplied.id).layers[0] as PixelLayer).plane.base;
    // red x blue = black
    expect(readPixel(plane, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('merges only visible layers', () => {
    const hidden = { ...top, visible: false };
    const d: Doc = { ...doc, layers: [base, hidden] };
    const next = mergeVisible(d);
    expect(next.layers.map((l) => l.name)).toEqual(['Base', 'Top']);
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it('flattens to a single layer', () => {
    const next = flatten(doc);
    expect(next.layers).toHaveLength(1);
    expect(next.hasBackground).toBe(true);
  });

  it('stamps a merged copy on top without removing the originals', () => {
    const next = stampVisible(doc);
    expect(next.layers).toHaveLength(3);
    expect(next.layers.at(-1)!.name).toBe('Merged');
    expect(readPixel((next.layers.at(-1) as PixelLayer).plane.base, 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it('leaves no tiles where everything is transparent', () => {
    const plane = rasterize([], { x0: 0, y0: 0, x1: 16, y1: 16 });
    expect(plane.tileCount).toBe(0);
  });
});

describe('canvas commands', () => {
  const doc: Doc = {
    ...emptyDoc(16, 16),
    layers: [makePixelLayer('L', rectPlane(0, 0, 4, 4, [255, 0, 0, 255]))],
  };

  it('computes anchor offsets', () => {
    expect(anchorOffset('topLeft', 10, 10)).toEqual({ dx: 0, dy: 0 });
    expect(anchorOffset('center', 10, 10)).toEqual({ dx: 5, dy: 5 });
    expect(anchorOffset('bottomRight', 10, 10)).toEqual({ dx: 10, dy: 10 });
  });

  it('grows the canvas and moves pixels by the anchor', () => {
    const next = canvasSize(doc, 32, 32, 'center');
    expect(next.width).toBe(32);
    const plane = (next.layers[0] as PixelLayer).plane.base;
    // The 4x4 block started at (0,0) and the canvas grew 16 in each axis, centred.
    expect(readPixel(plane, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(readPixel(plane, 0, 0)[3]).toBe(0);
  });

  it('anchors to the top-left without moving anything', () => {
    const next = canvasSize(doc, 32, 32, 'topLeft');
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('trims to the used bounds', () => {
    const offset: Doc = {
      ...emptyDoc(32, 32),
      layers: [makePixelLayer('L', rectPlane(5, 6, 9, 10, [1, 2, 3, 255]))],
    };
    const next = trim(offset);
    expect([next.width, next.height]).toEqual([4, 4]);
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('reveals pixels that sit outside the canvas', () => {
    const outside: Doc = {
      ...emptyDoc(8, 8),
      layers: [makePixelLayer('L', rectPlane(10, 10, 14, 14, [9, 9, 9, 255]))],
    };
    const next = revealAll(outside);
    expect(next.width).toBeGreaterThanOrEqual(14);
    expect(next.height).toBeGreaterThanOrEqual(14);
  });

  it('rotates the canvas and swaps its dimensions', () => {
    const wide: Doc = {
      ...emptyDoc(8, 4),
      layers: [makePixelLayer('L', rectPlane(0, 0, 2, 1, [255, 255, 0, 255]))],
    };
    const next = rotateImage(wide, 90);
    expect([next.width, next.height]).toEqual([4, 8]);
    // The top-left pixel rotates to the top-right.
    const plane = (next.layers[0] as PixelLayer).plane.base;
    expect(readPixel(plane, 3, 0)).toEqual([255, 255, 0, 255]);
  });

  it('rotates 180 degrees without swapping dimensions', () => {
    const next = rotateImage(doc, 180);
    expect([next.width, next.height]).toEqual([16, 16]);
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 15, 15)).toEqual([255, 0, 0, 255]);
  });

  it('flips horizontally', () => {
    const next = flipImage(doc, true);
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 15, 0)).toEqual([255, 0, 0, 255]);
  });
});

describe('resampling', () => {
  const plane = rectPlane(0, 0, 8, 8, [200, 100, 50, 255]);

  it('doubles a plane with nearest neighbour', () => {
    const out = resamplePlane(plane, 2, 2, 'nearest', { x0: 0, y0: 0, x1: 8, y1: 8 });
    expect(tightBounds(out)).toEqual({ x0: 0, y0: 0, x1: 16, y1: 16 });
    expect(readPixel(out, 5, 5)).toEqual([200, 100, 50, 255]);
  });

  it('keeps a flat colour flat under every method', () => {
    for (const method of ['bilinear', 'bicubic', 'bicubicSmoother', 'bicubicSharper'] as const) {
      const out = resamplePlane(plane, 2, 2, method, { x0: 0, y0: 0, x1: 8, y1: 8 });
      const px = readPixel(out, 8, 8);
      expect(px.slice(0, 3), method).toEqual([200, 100, 50]);
      expect(px[3], method).toBe(255);
    }
  });

  it('never lets cubic overshoot push colour above alpha', () => {
    // A hard edge is where ringing shows up; colour must stay within the premultiplied range.
    const edge = rectPlane(0, 0, 4, 8, [255, 255, 255, 255]);
    const out = resamplePlane(edge, 3, 3, 'bicubicSharper', { x0: 0, y0: 0, x1: 8, y1: 8 });
    for (let x = 0; x < 24; x++) {
      const px = readPixel(out, x, 12);
      expect(px[0]).toBeLessThanOrEqual(255);
      expect(px[3]).toBeLessThanOrEqual(255);
    }
  });

  it('resizes the document and every layer together', () => {
    const doc: Doc = { ...emptyDoc(8, 8), layers: [makePixelLayer('L', plane)] };
    const next = imageSize(doc, 16, 16, 'bilinear');
    expect([next.width, next.height]).toEqual([16, 16]);
    expect(readPixel((next.layers[0] as PixelLayer).plane.base, 8, 8)[3]).toBe(255);
  });

  it('returns the same document when the size is unchanged', () => {
    const doc: Doc = { ...emptyDoc(8, 8), layers: [makePixelLayer('L', plane)] };
    expect(imageSize(doc, 8, 8)).toBe(doc);
  });

  it('resizes masks alongside their layers', () => {
    const doc: Doc = {
      ...emptyDoc(8, 8),
      layers: [
        makePixelLayer('L', plane, {
          mask: {
            plane: new MipPlane(rectPlane(0, 0, 8, 8, [255, 255, 255, 255])),
            enabled: true,
            linked: true,
            density: 1,
            feather: 0,
            defaultColor: 0,
          },
        }),
      ],
    };
    const next = imageSize(doc, 16, 16, 'nearest');
    expect(next.layers[0]!.mask).toBeDefined();
    expect([...walkLayers(next.layers)]).toHaveLength(1);
  });
});

describe('masks survive image commands', () => {
  /**
   * Every canvas command is applied to a layer's mask as well as its pixels. A mask is a
   * single-channel plane, so code that assumes RGBA reads four bytes per pixel out of a
   * one-byte-per-pixel tile and silently destroys it.
   */
  function maskedDoc(): Doc {
    const w = Plane.empty({ layout: 'A', sample: 'u8' }).writer();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const d = w.mutable(0, 0);
        d[y * TILE_SIZE + x] = x < 4 ? 255 : 0;
      }
    }
    return {
      ...emptyDoc(8, 8),
      layers: [
        makePixelLayer('L', rectPlane(0, 0, 8, 8, [10, 20, 30, 255]), {
          mask: {
            plane: new MipPlane(w.commit()),
            enabled: true,
            linked: true,
            density: 1,
            feather: 0,
            defaultColor: 0,
          },
        }),
      ],
    };
  }

  function maskAt(doc: Doc, x: number, y: number): number {
    const out = new Uint8Array(1);
    doc.layers[0]!.mask!.plane.base.readPixel(x, y, out);
    return out[0]!;
  }

  it('keeps the mask single-channel through a flip', () => {
    const next = flipImage(maskedDoc(), true);
    expect(next.layers[0]!.mask!.plane.base.format.layout).toBe('A');
    // The revealed half moves to the other side.
    expect(maskAt(next, 7, 0)).toBe(255);
    expect(maskAt(next, 0, 0)).toBe(0);
  });

  it('keeps the mask intact through a rotation', () => {
    const next = rotateImage(maskedDoc(), 90);
    expect(next.layers[0]!.mask!.plane.base.format.layout).toBe('A');
    // The left-hand reveal becomes the top after a clockwise turn.
    expect(maskAt(next, 0, 0)).toBe(255);
    expect(maskAt(next, 0, 7)).toBe(0);
  });

  it('keeps the mask intact through a canvas resize', () => {
    const next = canvasSize(maskedDoc(), 16, 16, 'topLeft');
    expect(maskAt(next, 0, 0)).toBe(255);
    expect(maskAt(next, 5, 0)).toBe(0);
  });

  it('keeps the mask intact through a resample', () => {
    const next = imageSize(maskedDoc(), 16, 16, 'nearest');
    expect(next.layers[0]!.mask!.plane.base.format.layout).toBe('A');
    expect(maskAt(next, 1, 1)).toBe(255);
    expect(maskAt(next, 14, 1)).toBe(0);
  });
});
