import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { defaultSpatial, type SpatialAdjustment } from '@umbra/kernels/spatial';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type PixelLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { applySpatial } from './spatial.js';

const W = 40;
const H = 20;
function doc(layers = 1): Doc {
  const ls = Array.from({ length: layers }, (_, k) => {
    const w = Plane.empty(RGBA8).writer();
    const d = w.mutable(0, 0);
    // A real image has true blacks and whites; Black/White Clip stretches to them.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = y === 0 ? [0, 0, 0] : y === H - 1 ? [255, 255, 255] : [20 + x * 2, 30 + k * 40, 40];
      d.set([...edge, 255], (y * TILE_SIZE + x) * 4);
    }
    return makePixelLayer(`L${k}`, w.commit(), { opacity: k ? 0.5 : 1 });
  });
  return { ...emptyDoc(W, H, 't'), layers: ls, activeLayerIds: [ls[ls.length - 1]!.id] };
}
const px = (d: Doc, x: number, y: number, i = 0) => {
  const t = (d.layers[i] as PixelLayer).plane.base.tileAt(0, 0);
  const o = (y * TILE_SIZE + x) * 4;
  return [t.data[o]!, t.data[o + 1]!, t.data[o + 2]!, t.data[o + 3]!];
};

describe('spatial adjustments on a layer', () => {
  it('Shadows/Highlights brightens dark pixels, only inside the selection', () => {
    const d = doc();
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 0, y0: 0, x1: 20, y1: H }, false);
    const out = applySpatial({ ...d, selection: makeSelection(W, H, mask) }, d.layers[0]!.id, defaultSpatial('shadowsHighlights'));
    expect(px(out, 2, 5)[0]!).toBeGreaterThan(px(d, 2, 5)[0]!);
    expect(px(out, 30, 5)).toEqual(px(d, 30, 5));
    expect(px(out, 2, 5)[3]).toBe(255);
  });

  it('HDR Toning flattens a layered document first, as Photoshop does', () => {
    const d = doc(3);
    const out = applySpatial(d, d.activeLayerIds[0]!, defaultSpatial('hdrToning') as SpatialAdjustment);
    expect(out.layers.length).toBe(1);
    expect(out.layers[0]!.kind).toBe('pixel');
  });

  it('refuses a locked layer', () => {
    const d = doc();
    const locked: Doc = { ...d, layers: [{ ...d.layers[0]!, locks: { transparency: false, pixels: true, position: false, all: false } }] };
    expect(applySpatial(locked, d.layers[0]!.id, defaultSpatial('replaceColor'))).toBe(locked);
  });
});
