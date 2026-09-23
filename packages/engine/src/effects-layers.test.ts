import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { compositeDocument } from '@umbra/kernels/composite';
import { DEFAULTS, EMPTY_EFFECTS, type LayerEffects } from '@umbra/kernels/effects/index';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, makeGroup, makePixelLayer, type Doc, type Layer } from './document.js';
import { EffectsCache, expandEffects } from './effects-layers.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { mergeDown } from './commands/layers.js';
import { bitmapFromPlane } from './psd-save.js';

const W = 64;
const H = 48;

function square(x0: number, y0: number, x1: number, y1: number, rgb = [40, 90, 220]): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = w.mutable(x >> 8, y >> 8);
      const o = ((y & 255) * TILE_SIZE + (x & 255)) * 4;
      d.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], o);
    }
  }
  return w.commit();
}

const fx = (over: Partial<LayerEffects>): LayerEffects => ({ ...EMPTY_EFFECTS, ...over });
const docOf = (layers: Layer[]): Doc => ({ ...emptyDoc(W, H), layers, activeLayerIds: [layers[layers.length - 1]!.id] });
const pixel = (doc: Doc, x: number, y: number) => {
  const p = compositeDocument(toCompositeLayers(doc), x, y);
  return [...p.color.map((c) => Math.round(c * 255)), Math.round(p.alpha * 255)];
};

describe('layer effects in the render tree', () => {
  it('a layer without effects passes through untouched', () => {
    const layers = [makePixelLayer('A', square(10, 10, 30, 30))];
    expect(expandEffects(layers, { width: W, height: H })).toBe(layers);
  });

  it('a drop shadow shows below and beside the layer in the composite', () => {
    const shadow = { ...DEFAULTS.dropShadow(), opacity: 1, distance: 6, size: 0, blendMode: 'normal' as const };
    const doc = docOf([makePixelLayer('A', square(10, 10, 30, 30), { effects: fx({ dropShadow: [shadow] }) })]);
    // Below the square (light from the top): black shadow; the square itself is untouched.
    expect(pixel(doc, 20, 33)).toEqual([0, 0, 0, 255]);
    expect(pixel(doc, 20, 20)).toEqual([40, 90, 220, 255]);
    expect(pixel(doc, 20, 40)[3]).toBe(0);
  });

  it('opacity and visibility of the layer carry to its effects', () => {
    const e = fx({ colorOverlay: [{ ...DEFAULTS.colorOverlay(), color: [1, 1, 1] }] });
    const faded = docOf([makePixelLayer('A', square(10, 10, 30, 30), { effects: e, opacity: 0.5 })]);
    expect(pixel(faded, 20, 20)[3]).toBe(128);
    const hidden = docOf([makePixelLayer('A', square(10, 10, 30, 30), { effects: e, visible: false })]);
    expect(pixel(hidden, 20, 20)[3]).toBe(0);
    const off = docOf([makePixelLayer('A', square(10, 10, 30, 30), { effects: { ...e, enabled: false } })]);
    expect(pixel(off, 20, 20)).toEqual([40, 90, 220, 255]);
  });

  it("a base layer's upper effects go after the layers clipped to it", () => {
    const base = makePixelLayer('Base', square(10, 10, 30, 30), { effects: fx({ stroke: [DEFAULTS.stroke()], dropShadow: [DEFAULTS.dropShadow()] }) });
    const clipped = makePixelLayer('Clipped', square(0, 0, 64, 48, [255, 0, 0]), { clipped: true });
    const out = expandEffects([base, clipped], { width: W, height: H }) as Layer[];
    expect(out.map((l) => l.name)).toEqual(['Base ▸ Drop Shadow', 'Base', 'Clipped', 'Base ▸ Stroke']);
    // The clipped layer still clips to the base's content: the stroke outside is not red.
    const doc = docOf([base, clipped]);
    expect(pixel(doc, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(doc, 31, 20)).toEqual([0, 0, 0, 255]);
  });

  it('renders once and reuses the result until something it depends on changes', () => {
    const cache = new EffectsCache();
    const layer = makePixelLayer('A', square(10, 10, 30, 30), { effects: fx({ stroke: [DEFAULTS.stroke()] }) });
    const a = cache.get(layer, { width: W, height: H });
    expect(cache.get({ ...layer, opacity: 0.3 }, { width: W, height: H })).toBe(a);
    expect(cache.get({ ...layer, plane: makePixelLayer('B', square(12, 10, 30, 30)).plane }, { width: W, height: H })).not.toBe(a);
  });

  it('Merge Down keeps what the effects look like', () => {
    const top = makePixelLayer('Top', square(10, 10, 30, 30), { effects: fx({ stroke: [{ ...DEFAULTS.stroke(), size: 2 }] }) });
    const bottom = makePixelLayer('Bottom', Plane.empty(RGBA8));
    const merged = mergeDown(docOf([bottom, top]), top.id);
    const l = merged.layers[0]!;
    expect(l.effects).toBeUndefined();
    const px = bitmapFromPlane((l as { plane: { base: Plane } }).plane.base, { x0: 31, y0: 20, x1: 32, y1: 21 }).data;
    expect(Array.from(px)).toEqual([0, 0, 0, 255]);
  });

  it("a group's effects follow the shape of its children together", () => {
    const a = makePixelLayer('A', square(10, 10, 20, 20));
    const b = makePixelLayer('B', square(30, 10, 40, 20));
    const group = makeGroup('G', [a, b], { effects: fx({ stroke: [{ ...DEFAULTS.stroke(), size: 2 }] }) });
    const doc = docOf([group]);
    // Outside each child: stroke; in the gap between them, beyond the stroke's reach: nothing.
    expect(pixel(doc, 21, 15)).toEqual([0, 0, 0, 255]);
    expect(pixel(doc, 29, 15)).toEqual([0, 0, 0, 255]);
    expect(pixel(doc, 25, 15)[3]).toBe(0);
    expect(pixel(doc, 15, 15)).toEqual([40, 90, 220, 255]);
  });
});
