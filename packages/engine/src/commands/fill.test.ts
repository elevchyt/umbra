import { describe, expect, it } from 'vitest';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type PixelLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { fill, stroke, strokeBand, type FillOptions } from './fill.js';

const W = 64;
const H = 48;

function docWithLayer(fillRgba?: [number, number, number, number]): Doc {
  const w = Plane.empty(RGBA8).writer();
  if (fillRgba) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const data = w.mutable(0, 0);
        const o = (y * 256 + x) * 4;
        data[o] = fillRgba[0];
        data[o + 1] = fillRgba[1];
        data[o + 2] = fillRgba[2];
        data[o + 3] = fillRgba[3];
      }
    }
  }
  const layer = makePixelLayer('Layer 1', w.commit());
  return { ...emptyDoc(W, H, 'test'), layers: [layer], activeLayerIds: [layer.id] };
}

function px(doc: Doc, x: number, y: number): [number, number, number, number] {
  const layer = doc.layers[0] as PixelLayer;
  const tile = layer.plane.base.tileAt(0, 0);
  const o = tile.uniform ? 0 : (y * 256 + x) * 4;
  return [tile.data[o]!, tile.data[o + 1]!, tile.data[o + 2]!, tile.data[o + 3]!];
}

const NORMAL: FillOptions = {
  color: [1, 0, 0],
  mode: 'normal',
  opacity: 1,
  preserveTransparency: false,
};

function selectionRect(x0: number, y0: number, x1: number, y1: number) {
  const mask = createMask(W, H);
  rasterizeRect(mask, { width: W, height: H }, { x0, y0, x1, y1 }, false);
  return makeSelection(W, H, mask);
}

describe('fill', () => {
  it('fills the whole layer when nothing is selected', () => {
    const out = fill(docWithLayer(), NORMAL);
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, W - 1, H - 1)).toEqual([255, 0, 0, 255]);
  });

  it('fills only inside the selection', () => {
    const doc = { ...docWithLayer(), selection: selectionRect(10, 10, 20, 20) };
    const out = fill(doc, NORMAL);
    expect(px(out, 15, 15)).toEqual([255, 0, 0, 255]);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(px(out, 25, 15)).toEqual([0, 0, 0, 0]);
  });

  it('honours opacity through the blend', () => {
    const out = fill(docWithLayer([0, 0, 255, 255]), { ...NORMAL, opacity: 0.5 });
    const [r, g, b, a] = px(out, 5, 5);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(136);
    expect(g).toBe(0);
    expect(b).toBeGreaterThan(120);
    expect(b).toBeLessThan(136);
  });

  it('multiply against an existing colour matches the reference blend', () => {
    // 0.5 grey multiplied by pure red leaves red at half and kills green and blue.
    const out = fill(docWithLayer([128, 128, 128, 255]), { ...NORMAL, mode: 'multiply' });
    const [r, g, b] = px(out, 5, 5);
    expect(r).toBe(128);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('preserve transparency leaves empty pixels alone and keeps alpha', () => {
    // One pixel at half alpha; everything else empty.
    const w = Plane.empty(RGBA8).writer();
    w.mutable(0, 0)[(3 * 256 + 3) * 4 + 3] = 128;
    const layer = makePixelLayer('Layer 1', w.commit());
    const seeded: Doc = {
      ...emptyDoc(W, H, 'test'),
      layers: [layer],
      activeLayerIds: [layer.id],
    };

    const out = fill(seeded, { ...NORMAL, preserveTransparency: true });
    expect(px(out, 3, 3)[3]).toBe(128);
    expect(px(out, 3, 3)[0]).toBe(255);
    expect(px(out, 10, 10)).toEqual([0, 0, 0, 0]);
  });

  it('clear erases inside the selection without touching the rest', () => {
    const doc = { ...docWithLayer([9, 9, 9, 255]), selection: selectionRect(10, 10, 20, 20) };
    const out = fill(doc, { ...NORMAL, clear: true });
    expect(px(out, 15, 15)[3]).toBe(0);
    expect(px(out, 5, 5)[3]).toBe(255);
  });

  it('does nothing when the layer pixels are locked', () => {
    const doc = docWithLayer();
    const layer = doc.layers[0] as PixelLayer;
    const locked: Doc = {
      ...doc,
      layers: [{ ...layer, locks: { ...layer.locks, pixels: true } }],
    };
    expect(fill(locked, NORMAL)).toBe(locked);
  });
});

describe('stroke', () => {
  it('inside sits within the selection and centre straddles the edge', () => {
    const sel = selectionRect(16, 12, 40, 36);
    const inside = strokeBand(sel, 4, 'inside');
    const outside = strokeBand(sel, 4, 'outside');

    // One pixel in from the left edge is stroked when inside, not when outside.
    expect(inside[20 * W + 17]).toBeGreaterThan(0);
    expect(outside[20 * W + 17]).toBe(0);
    // One pixel out is the reverse.
    expect(outside[20 * W + 14]).toBeGreaterThan(0);
    expect(inside[20 * W + 14]).toBe(0);
    // Deep inside is untouched either way — a stroke is a band, not a fill.
    expect(inside[24 * W + 28]).toBe(0);
    expect(outside[24 * W + 28]).toBe(0);
  });

  it('paints the band onto the layer', () => {
    const doc = { ...docWithLayer(), selection: selectionRect(16, 12, 40, 36) };
    const out = stroke(doc, { ...NORMAL, width: 3, location: 'inside' });
    expect(px(out, 17, 20)[3]).toBeGreaterThan(0);
    expect(px(out, 28, 24)[3]).toBe(0);
    expect(px(out, 5, 5)[3]).toBe(0);
  });

  it('is a no-op without a selection', () => {
    const doc = docWithLayer();
    expect(stroke(doc, { ...NORMAL, width: 3, location: 'inside' })).toBe(doc);
  });
});
