import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type PixelLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { clearSelection, copy, copyMerged, paste } from './clipboard.js';

const W = 64;
const H = 64;

function filled(r: number, g: number, b: number): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const data = w.mutable(0, 0);
      const o = (y * TILE_SIZE + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
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

function doc(): Doc {
  const layer = makePixelLayer('Layer 1', filled(200, 50, 50));
  return { ...emptyDoc(W, H, 'test'), layers: [layer], activeLayerIds: [layer.id] };
}

function withRect(x0: number, y0: number, x1: number, y1: number): Doc {
  const mask = createMask(W, H);
  rasterizeRect(mask, { width: W, height: H }, { x0, y0, x1, y1 }, false);
  return { ...doc(), selection: makeSelection(W, H, mask) };
}

describe('copy', () => {
  it('takes the selection and records where it came from', () => {
    const clip = copy(withRect(10, 10, 20, 20))!;
    expect(clip.source).toEqual({ x0: 10, y0: 10, x1: 20, y1: 20 });
    expect(at(clip.plane, 15, 15)).toEqual([200, 50, 50, 255]);
    expect(at(clip.plane, 5, 5)[3]).toBe(0);
  });

  it('takes the whole canvas when nothing is selected', () => {
    const clip = copy(doc())!;
    expect(clip.source).toEqual({ x0: 0, y0: 0, x1: W, y1: H });
  });

  it('folds a soft selection edge into alpha instead of squaring it off', () => {
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    // Half coverage down one column.
    for (let y = 10; y < 20; y++) mask[y * W + 10] = 128;
    const clip = copy({ ...doc(), selection: makeSelection(W, H, mask) })!;
    expect(at(clip.plane, 10, 15)[3]).toBe(128);
    expect(at(clip.plane, 11, 15)[3]).toBe(255);
  });

  it('returns null when the selection covers nothing', () => {
    const empty = { ...doc(), selection: makeSelection(W, H) };
    expect(copy(empty)).toBeNull();
  });

  it('copy merged reads the composite it is given, not the layer', () => {
    const pixels = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      pixels[i * 4 + 2] = 255;
      pixels[i * 4 + 3] = 255;
    }
    const clip = copyMerged(withRect(10, 10, 20, 20), { pixels, width: W, height: H })!;
    expect(at(clip.plane, 15, 15)).toEqual([0, 0, 255, 255]);
  });
});

describe('cut', () => {
  it('erases through the selection and leaves the rest', () => {
    const out = clearSelection(withRect(10, 10, 20, 20));
    const plane = (out.layers[0] as PixelLayer).plane.base;
    expect(at(plane, 15, 15)[3]).toBe(0);
    expect(at(plane, 5, 5)[3]).toBe(255);
  });

  it('erases partially where the selection is partial', () => {
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    mask[15 * W + 10] = 128;
    const out = clearSelection({ ...doc(), selection: makeSelection(W, H, mask) });
    const plane = (out.layers[0] as PixelLayer).plane.base;
    expect(at(plane, 10, 15)[3]).toBe(127);
  });

  it('refuses a locked layer', () => {
    const d = withRect(10, 10, 20, 20);
    const layer = d.layers[0] as PixelLayer;
    const locked: Doc = { ...d, layers: [{ ...layer, locks: { ...layer.locks, pixels: true } }] };
    expect(clearSelection(locked)).toBe(locked);
  });
});

describe('paste', () => {
  const centre = { x: W / 2, y: H / 2 };

  it('in place puts the pixels back exactly where they were', () => {
    const source = withRect(10, 10, 20, 20);
    const clip = copy(source)!;
    const out = paste({ ...doc(), selection: null }, clip, 'inPlace', centre);
    const pasted = (out.layers[1] as PixelLayer).plane.base;
    expect(at(pasted, 15, 15)[3]).toBe(255);
    expect(at(pasted, 25, 25)[3]).toBe(0);
  });

  it('plain paste centres on the view', () => {
    const clip = copy(withRect(0, 0, 10, 10))!;
    const out = paste({ ...doc(), selection: null }, clip, 'normal', { x: 40, y: 40 });
    const pasted = (out.layers[1] as PixelLayer).plane.base;
    expect(at(pasted, 40, 40)[3]).toBe(255);
    expect(at(pasted, 5, 5)[3]).toBe(0);
  });

  it('adds a new layer above the active one and selects it', () => {
    const clip = copy(doc())!;
    const out = paste(doc(), clip, 'inPlace', centre);
    expect(out.layers).toHaveLength(2);
    expect(out.activeLayerIds).toEqual([out.layers[1]!.id]);
  });

  it('paste into masks with the selection and drops it', () => {
    const clip = copy(doc())!;
    const target = withRect(20, 20, 40, 40);
    const out = paste(target, clip, 'into', centre);
    const layer = out.layers[1] as PixelLayer;
    expect(layer.mask).toBeDefined();
    expect(out.selection).toBeNull();
    const mask = layer.mask!.plane.base;
    const inside = mask.tileAt(0, 0);
    expect(inside.data[30 * TILE_SIZE + 30]).toBe(255);
    expect(inside.data[5 * TILE_SIZE + 5]).toBe(0);
  });

  it('paste outside inverts that mask', () => {
    const clip = copy(doc())!;
    const out = paste(withRect(20, 20, 40, 40), clip, 'outside', centre);
    const mask = (out.layers[1] as PixelLayer).mask!.plane.base.tileAt(0, 0);
    expect(mask.data[30 * TILE_SIZE + 30]).toBe(0);
    expect(mask.data[5 * TILE_SIZE + 5]).toBe(255);
  });
});
