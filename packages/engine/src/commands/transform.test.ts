import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { about, rotate, scale, translate } from '@umbra/kernels/matrix';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type PixelLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { shiftPlane, transformLayers, transformPlane, transformSelection } from './transform.js';
import { crop } from './image.js';

const CLIP = { x0: -512, y0: -512, x1: 1024, y1: 1024 };

/** A plane with one opaque square of `colour` at (x0,y0)…(x1,y1). */
function square(x0: number, y0: number, x1: number, y1: number, r = 200): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const data = w.mutable(x >> 8, y >> 8);
      const o = ((y & 255) * TILE_SIZE + (x & 255)) * 4;
      data[o] = r;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return w.commit();
}

function at(plane: Plane, x: number, y: number): [number, number, number, number] {
  const tile = plane.tileAt(x >> 8, y >> 8);
  const o = tile.uniform ? 0 : ((y & 255) * TILE_SIZE + (x & 255)) * 4;
  return [tile.data[o]!, tile.data[o + 1]!, tile.data[o + 2]!, tile.data[o + 3]!];
}

describe('shiftPlane', () => {
  it('moves pixels by whole numbers', () => {
    const out = shiftPlane(square(10, 10, 20, 20), 5, 7);
    expect(at(out, 15, 17)[3]).toBe(255);
    expect(at(out, 10, 10)[3]).toBe(0);
  });

  it('copies samples verbatim, never resampling', () => {
    // A hard edge must stay hard: an off-by-a-filter move would put a partial pixel here.
    const out = shiftPlane(square(10, 10, 20, 20), 3, 0);
    expect(at(out, 12, 15)[3]).toBe(0);
    expect(at(out, 13, 15)).toEqual([200, 0, 0, 255]);
  });

  it('takes the tile-aligned fast path without changing the result', () => {
    const src = square(10, 10, 20, 20);
    const aligned = shiftPlane(src, TILE_SIZE, TILE_SIZE);
    expect(at(aligned, 10 + TILE_SIZE, 10 + TILE_SIZE)).toEqual([200, 0, 0, 255]);
    // The tile object is reused, which is the whole point of the fast path.
    expect(aligned.tileAt(1, 1)).toBe(src.tileAt(0, 0));
  });

  it('is a no-op for zero', () => {
    const src = square(1, 1, 3, 3);
    expect(shiftPlane(src, 0, 0)).toBe(src);
  });
});

describe('transformPlane', () => {
  it('routes a whole-pixel translation through the lossless path', () => {
    const out = transformPlane(square(10, 10, 20, 20), translate(4, 4), CLIP);
    expect(at(out, 14, 14)).toEqual([200, 0, 0, 255]);
    expect(at(out, 13, 13)[3]).toBe(0);
  });

  it('scales up', () => {
    const out = transformPlane(square(10, 10, 20, 20), scale(2), CLIP, 'nearest');
    // The 10×10 square becomes 20×20 starting at 20,20.
    expect(at(out, 25, 25)[3]).toBe(255);
    expect(at(out, 19, 19)[3]).toBe(0);
    expect(at(out, 41, 41)[3]).toBe(0);
  });

  it('rotates about a pivot', () => {
    const src = square(40, 10, 60, 30);
    const m = about(rotate(Math.PI / 2), { x: 50, y: 50 });
    const out = transformPlane(src, m, CLIP, 'nearest');
    // (40..60, 10..30) turned a quarter turn about (50,50) lands at (70..90, 40..60).
    expect(at(out, 80, 50)[3]).toBeGreaterThan(0);
    expect(at(out, 50, 20)[3]).toBe(0);
  });

  it('keeps colour clean where a rotation covers a pixel fully', () => {
    // Premultiplied resampling: an interior pixel must not pick up colour from transparency.
    const out = transformPlane(square(20, 20, 60, 60), about(rotate(0.4), { x: 40, y: 40 }), CLIP);
    const [r, g, b, a] = at(out, 40, 40);
    expect(a).toBe(255);
    expect(r).toBe(200);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('is a no-op for identity', () => {
    const src = square(1, 1, 3, 3);
    expect(transformPlane(src, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, CLIP)).toBe(src);
  });
});

describe('transformLayers', () => {
  function doc(): Doc {
    const layer = makePixelLayer('Layer 1', square(10, 10, 20, 20));
    return { ...emptyDoc(64, 64, 't'), layers: [layer], activeLayerIds: [layer.id] };
  }

  it('moves the active layer', () => {
    const out = transformLayers(doc(), translate(6, 0));
    const plane = (out.layers[0] as PixelLayer).plane.base;
    expect(at(plane, 16, 15)[3]).toBe(255);
  });

  it('skips a layer whose position is locked', () => {
    const d = doc();
    const layer = d.layers[0] as PixelLayer;
    const locked: Doc = { ...d, layers: [{ ...layer, locks: { ...layer.locks, position: true } }] };
    expect(transformLayers(locked, translate(6, 0))).toBe(locked);
  });

  it('transforms a layer mask along with its pixels', () => {
    const d = doc();
    const layer = d.layers[0] as PixelLayer;
    const maskPlane = square(10, 10, 20, 20);
    const withMask: Doc = {
      ...d,
      layers: [
        {
          ...layer,
          mask: {
            plane: new (layer.plane.constructor as new (p: Plane) => typeof layer.plane)(maskPlane),
            enabled: true,
            linked: true,
            density: 1,
            feather: 0,
            defaultColor: 0,
          },
        },
      ],
    };
    const out = transformLayers(withMask, translate(6, 0));
    const moved = (out.layers[0] as PixelLayer).mask!.plane.base;
    expect(at(moved, 16, 15)[3]).toBe(255);
  });
});

describe('transformSelection', () => {
  it('moves the mask without touching pixels', () => {
    const size = { width: 64, height: 64 };
    const mask = createMask(size.width, size.height);
    rasterizeRect(mask, size, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    const out = transformSelection(makeSelection(64, 64, mask), translate(8, 0));
    expect(out.mask[15 * 64 + 18]).toBe(255);
    expect(out.mask[15 * 64 + 12]).toBe(0);
  });

  it('keeps a soft edge soft through a rotation', () => {
    const size = { width: 64, height: 64 };
    const mask = createMask(size.width, size.height);
    rasterizeRect(mask, size, { x0: 20, y0: 20, x1: 44, y1: 44 }, false);
    const out = transformSelection(makeSelection(64, 64, mask), about(rotate(0.3), { x: 32, y: 32 }));
    let partial = 0;
    for (let i = 0; i < out.mask.length; i++) if (out.mask[i]! > 0 && out.mask[i]! < 255) partial++;
    expect(partial).toBeGreaterThan(0);
    expect(out.mask[32 * 64 + 32]).toBe(255);
  });
});

describe('crop', () => {
  function doc(): Doc {
    const layer = makePixelLayer('Layer 1', square(10, 10, 50, 50));
    return { ...emptyDoc(64, 64, 't'), layers: [layer], activeLayerIds: [layer.id] };
  }

  it('moves the canvas and the layers with it', () => {
    const out = crop(doc(), { x0: 20, y0: 20, x1: 40, y1: 40 }, false);
    expect(out.width).toBe(20);
    expect(out.height).toBe(20);
    const plane = (out.layers[0] as PixelLayer).plane.base;
    // What was at 25,25 is now at 5,5.
    expect(at(plane, 5, 5)[3]).toBe(255);
  });

  it('keeps the outside pixels unless told to delete them', () => {
    const kept = crop(doc(), { x0: 20, y0: 20, x1: 40, y1: 40 }, false);
    const keptPlane = (kept.layers[0] as PixelLayer).plane.base;
    // 45,45 in the original is 25,25 now — outside the new canvas but still there.
    expect(at(keptPlane, 25, 25)[3]).toBe(255);

    const deleted = crop(doc(), { x0: 20, y0: 20, x1: 40, y1: 40 }, true);
    const cut = (deleted.layers[0] as PixelLayer).plane.base;
    expect(at(cut, 25, 25)[3]).toBe(0);
    expect(at(cut, 5, 5)[3]).toBe(255);
  });

  it('drops the selection, which was defined on the old canvas', () => {
    const mask = createMask(64, 64);
    rasterizeRect(mask, { width: 64, height: 64 }, { x0: 0, y0: 0, x1: 10, y1: 10 }, false);
    const withSel: Doc = { ...doc(), selection: makeSelection(64, 64, mask) };
    expect(crop(withSel, { x0: 20, y0: 20, x1: 40, y1: 40 }, false).selection).toBeNull();
  });
});
