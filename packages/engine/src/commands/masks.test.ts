import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type PixelLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { addMask, applyMask, deleteMask, setMaskEnabled } from './masks.js';

const W = 64;
const H = 64;

function opaque(): Plane {
  const w = Plane.empty(RGBA8).writer();
  const data = w.mutable(0, 0);
  for (let i = 0; i < W * H; i++) {
    const y = Math.floor(i / W);
    const x = i % W;
    data[(y * TILE_SIZE + x) * 4 + 3] = 255;
  }
  return w.commit();
}

function doc(withSelection = false): Doc {
  const layer = makePixelLayer('Layer 1', opaque());
  const d: Doc = { ...emptyDoc(W, H, 't'), layers: [layer], activeLayerIds: [layer.id] };
  if (!withSelection) return d;
  const mask = createMask(W, H);
  rasterizeRect(mask, { width: W, height: H }, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
  return { ...d, selection: makeSelection(W, H, mask) };
}

const layerOf = (d: Doc) => d.layers[0] as PixelLayer;
const maskAt = (d: Doc, x: number, y: number) => {
  const t = layerOf(d).mask!.plane.base.tileAt(x >> 8, y >> 8);
  return t.uniform ? t.data[0]! : t.data[(y & 255) * TILE_SIZE + (x & 255)]!;
};
const alphaAt = (d: Doc, x: number, y: number) => {
  const t = layerOf(d).plane.base.tileAt(x >> 8, y >> 8);
  return t.uniform ? t.data[3]! : t.data[((y & 255) * TILE_SIZE + (x & 255)) * 4 + 3]!;
};

describe('adding a mask', () => {
  it('reveal all stores nothing and reveals everywhere', () => {
    const d = doc();
    const out = addMask(d, layerOf(d).id, 'revealAll');
    expect(layerOf(out).mask!.plane.base.tileCount).toBe(0);
    expect(layerOf(out).mask!.defaultColor).toBe(1);
    expect(maskAt(out, 30, 30)).toBe(255);
  });

  it('hide all stores nothing and hides everywhere', () => {
    const d = doc();
    const out = addMask(d, layerOf(d).id, 'hideAll');
    expect(layerOf(out).mask!.plane.base.tileCount).toBe(0);
    expect(maskAt(out, 30, 30)).toBe(0);
  });

  it('reveal selection shows only the selection and drops it', () => {
    const d = doc(true);
    const out = addMask(d, layerOf(d).id, 'revealSelection');
    expect(maskAt(out, 15, 15)).toBe(255);
    expect(maskAt(out, 40, 40)).toBe(0);
    expect(out.selection).toBeNull();
  });

  it('hide selection is the inverse, stored against a white default', () => {
    const d = doc(true);
    const out = addMask(d, layerOf(d).id, 'hideSelection');
    expect(maskAt(out, 15, 15)).toBe(0);
    expect(maskAt(out, 40, 40)).toBe(255);
    // Mostly white, so storing against a white default keeps it to the one tile it touches.
    expect(layerOf(out).mask!.defaultColor).toBe(1);
  });

  it('falls back to reveal/hide all without a selection', () => {
    const d = doc();
    expect(maskAt(addMask(d, layerOf(d).id, 'revealSelection'), 5, 5)).toBe(255);
    expect(maskAt(addMask(d, layerOf(d).id, 'hideSelection'), 5, 5)).toBe(0);
  });

  it('leaves a layer that already has a mask alone', () => {
    const d = doc();
    const once = addMask(d, layerOf(d).id, 'hideAll');
    expect(addMask(once, layerOf(once).id, 'revealAll')).toBe(once);
  });
});

describe('mask from transparency', () => {
  it('copies the layer alpha into the mask', () => {
    const w = Plane.empty(RGBA8).writer();
    const data = w.mutable(0, 0);
    data[(5 * TILE_SIZE + 5) * 4 + 3] = 200;
    data[(6 * TILE_SIZE + 6) * 4 + 3] = 255;
    const layer = makePixelLayer('L', w.commit());
    const d: Doc = { ...emptyDoc(W, H, 't'), layers: [layer], activeLayerIds: [layer.id] };
    const out = addMask(d, layer.id, 'fromTransparency');
    expect(maskAt(out, 5, 5)).toBe(200);
    expect(maskAt(out, 6, 6)).toBe(255);
    expect(maskAt(out, 30, 30)).toBe(0);
  });
});

describe('mask operations', () => {
  it('delete removes the mask', () => {
    const base = doc();
    const withMask = addMask(base, layerOf(base).id, 'hideAll');
    expect(layerOf(deleteMask(withMask, layerOf(withMask).id)).mask).toBeUndefined();
  });

  it('an unknown layer id changes nothing', () => {
    const base = doc();
    expect(addMask(base, 99999, 'hideAll')).toBe(base);
    expect(deleteMask(base, layerOf(base).id)).toBe(base);
  });

  it('enable/disable flips only the flag', () => {
    const base = doc();
    const d = addMask(base, layerOf(base).id, 'hideAll');
    const off = setMaskEnabled(d, layerOf(d).id, false);
    expect(layerOf(off).mask!.enabled).toBe(false);
    expect(setMaskEnabled(off, layerOf(off).id, false)).toBe(off);
  });

  it('apply bakes a stored mask into alpha', () => {
    const base = doc(true);
    const d = addMask(base, layerOf(base).id, 'revealSelection');
    const out = applyMask(d, layerOf(d).id);
    expect(layerOf(out).mask).toBeUndefined();
    expect(alphaAt(out, 15, 15)).toBe(255);
    expect(alphaAt(out, 40, 40)).toBe(0);
  });

  it('apply honours a mask that stores nothing — hide all erases everything', () => {
    // The trap: iterating only the mask's stored tiles would find none and change nothing.
    const base = doc();
    const d = addMask(base, layerOf(base).id, 'hideAll');
    expect(alphaAt(applyMask(d, layerOf(d).id), 30, 30)).toBe(0);
  });

  it('apply with reveal all is a no-op on the pixels', () => {
    const base = doc();
    const d = addMask(base, layerOf(base).id, 'revealAll');
    expect(alphaAt(applyMask(d, layerOf(d).id), 30, 30)).toBe(255);
  });
});
