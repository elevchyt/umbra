import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { about, rotate, scale } from '@umbra/kernels/matrix';
import { FILTER_BY_ID, defaultsOf } from '@umbra/kernels/filters/index';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, findLayer, makePixelLayer, type Doc, type SmartObjectLayer } from './document.js';
import { transformLayers } from './commands/transform.js';
import { imageSize, rotateImage } from './commands/image.js';
import { applyFilter } from './commands/filter.js';
import { duplicateLayer } from './commands/layers.js';
import { bitmapFromPlane } from './psd-save.js';
import {
  addSmartFilter,
  clearSmartFilters,
  convertToLayers,
  convertToSmart,
  instanceCount,
  makeSource,
  moveSmartFilter,
  newSmartViaCopy,
  rasterizeSmart,
  rendered,
  removeSmartFilter,
  replaceSource,
  setSmartFiltersEnabled,
  updateSmartFilter,
} from './smart.js';

const W = 64;
const H = 48;

/** A picture with detail: gradients, a hard-edged square and a diagonal line, over transparency at the edges. */
function picture(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 6; y < 40; y++) {
    for (let x = 8; x < 56; x++) {
      const d = w.mutable(x >> 8, y >> 8);
      const o = ((y & 255) * TILE_SIZE + (x & 255)) * 4;
      const inSquare = x >= 20 && x < 30 && y >= 14 && y < 24;
      d[o] = inSquare ? 250 : (x * 5) & 255;
      d[o + 1] = inSquare ? 20 : (y * 6) & 255;
      d[o + 2] = Math.abs(x - y) < 2 ? 255 : 90;
      d[o + 3] = 255;
    }
  }
  return w.commit();
}

function docWith(plane = picture()): Doc {
  const layer = makePixelLayer('Photo', plane);
  return { ...emptyDoc(W, H), layers: [layer], activeLayerIds: [layer.id] };
}

const pixels = (doc: Doc, id = doc.activeLayerIds[0]!) => {
  const l = findLayer(doc.layers, id)!;
  return bitmapFromPlane((l as SmartObjectLayer).plane.base, { x0: 0, y0: 0, x1: doc.width, y1: doc.height }).data;
};
const worst = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};
const meanDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};
const smart = (doc: Doc) => findLayer(doc.layers, doc.activeLayerIds[0]!) as SmartObjectLayer;
const filter = (id: string, params = {}) => {
  const def = FILTER_BY_ID.get(id)!;
  return { filterId: id, params: { ...defaultsOf(def), ...params }, blendMode: 'normal' as const, opacity: 1, enabled: true, foreground: [0, 0, 0] as [number, number, number], background: [1, 1, 1] as [number, number, number] };
};

describe('Convert to Smart Object', () => {
  it('shows exactly the pixels it was made from, cropped to them and placed back', () => {
    const doc = docWith();
    const s = convertToSmart(doc);
    const layer = smart(s);
    expect(layer.kind).toBe('smart');
    expect([layer.source.doc.width, layer.source.doc.height]).toEqual([48, 34]);
    expect([layer.transform.e, layer.transform.f]).toEqual([8, 6]);
    expect(worst(pixels(s), pixels(doc))).toBe(0);
  });

  it('hands a single layer\'s opacity and blend mode to the smart object', () => {
    const doc = docWith();
    const faded: Doc = { ...doc, layers: [{ ...doc.layers[0]!, opacity: 0.5, blendMode: 'multiply' }] };
    const layer = smart(convertToSmart(faded));
    expect([layer.opacity, layer.blendMode]).toEqual([0.5, 'multiply']);
    const inner = layer.source.doc.layers[0]!;
    expect([inner.opacity, inner.blendMode]).toEqual([1, 'normal']);
  });

  it('puts several layers in one smart object', () => {
    const doc = docWith();
    const top = makePixelLayer('Top', picture());
    const two: Doc = { ...doc, layers: [...doc.layers, top], activeLayerIds: [doc.layers[0]!.id, top.id] };
    const s = convertToSmart(two);
    expect(s.layers.length).toBe(1);
    expect(smart(s).source.doc.layers.map((l) => l.name)).toEqual(['Photo', 'Top']);
    expect(smart(s).name).toBe('Top');
  });
});

describe('transforming a smart object', () => {
  it('scales down and back up without losing detail, where a pixel layer blurs', () => {
    const doc = docWith();
    const s = convertToSmart(doc);
    const pivot = { x: 32, y: 24 };
    const down = about(scale(0.25), pivot);
    const up = about(scale(4), pivot);
    const smartRound = transformLayers(transformLayers(s, down), up);
    const pixelRound = transformLayers(transformLayers(doc, down), up);
    expect(meanDiff(pixels(smartRound), pixels(doc))).toBeLessThan(0.5);
    expect(meanDiff(pixels(pixelRound), pixels(doc))).toBeGreaterThan(5);
  });

  it('accumulates a rotation in its transform and renders it like a pixel layer would', () => {
    const doc = docWith();
    const m = about(rotate(0.3), { x: 32, y: 24 });
    const viaSmart = transformLayers(convertToSmart(doc), m);
    const viaPixels = transformLayers(doc, m);
    expect(meanDiff(pixels(viaSmart), pixels(viaPixels))).toBeLessThan(1);
  });

  it('follows Image Size and Rotate Canvas from its contents', () => {
    const doc = docWith();
    const s = convertToSmart(doc);
    const round = imageSize(imageSize(s, 32, 24), 64, 48);
    expect(meanDiff(pixels(round), pixels(doc))).toBeLessThan(0.5);
    const turned = rotateImage(s, 90);
    expect(worst(pixels(turned), pixels(rotateImage(doc, 90)))).toBeLessThanOrEqual(1);
  });
});

describe('smart filters', () => {
  it('a smart filter renders what the destructive filter would', () => {
    const doc = docWith();
    const c = convertToSmart(doc);
    const f = addSmartFilter(c, smart(c).id, filter('blur.gaussianblur', { radius: 2 }));
    const def = FILTER_BY_ID.get('blur.gaussianblur')!;
    const destructive = applyFilter(doc, doc.layers[0]!.id, false, { def, params: { ...defaultsOf(def), radius: 2 }, foreground: [0, 0, 0], background: [1, 1, 1] });
    expect(worst(pixels(f), pixels(destructive))).toBeLessThanOrEqual(1);
    expect(smart(f).filters.length).toBe(1);
    // The first filter brings a reveal-all filter mask.
    expect(smart(f).filterMask?.defaultColor).toBe(1);
  });

  it('opacity, the eyes, the mask, order and removal all change what renders', () => {
    const doc = docWith();
    const c = convertToSmart(doc);
    const id = smart(c).id;
    const plain = pixels(c);
    const one = addSmartFilter(c, id, filter('other.offset', { h: 10, v: 0 }));
    const full = pixels(one);
    const half = pixels(updateSmartFilter(one, id, 0, { opacity: 0.5 }));
    // Half opacity lands between the unfiltered and the filtered result.
    expect(meanDiff(full, plain)).toBeGreaterThan(5);
    expect(meanDiff(half, plain)).toBeGreaterThan(1);
    expect(meanDiff(half, full)).toBeGreaterThan(1);
    expect(worst(pixels(setSmartFiltersEnabled(one, id, false)), plain)).toBe(0);
    expect(worst(pixels(updateSmartFilter(one, id, 0, { enabled: false })), plain)).toBe(0);
    // A black filter mask hides the filter entirely.
    const layer = smart(one);
    const black = { ...layer.filterMask!, plane: new MipPlane(Plane.empty({ layout: 'A', sample: 'u8' }, [0])), defaultColor: 0 as const };
    const masked: Doc = { ...one, layers: [rendered({ ...layer, filterMask: black }, one)] };
    expect(worst(pixels(masked), plain)).toBe(0);
    const two = addSmartFilter(one, id, filter('stylize.solarize'));
    const swapped = moveSmartFilter(two, id, 1, 0);
    expect(smart(swapped).filters.map((f) => f.filterId)).toEqual(['stylize.solarize', 'other.offset']);
    const removed = removeSmartFilter(removeSmartFilter(two, id, 1), id, 0);
    expect(smart(removed).filters).toEqual([]);
    expect(smart(removed).filterMask).toBeUndefined();
    expect(worst(pixels(removed), plain)).toBe(0);
    expect(worst(pixels(clearSmartFilters(two, id)), plain)).toBe(0);
  });
});

describe('instances, copies and conversion back', () => {
  it('Duplicate Layer makes an instance: new contents reach both', () => {
    const doc = convertToSmart(docWith());
    const dup = duplicateLayer(doc, doc.activeLayerIds[0]!);
    const a = dup.layers[0] as SmartObjectLayer;
    const b = dup.layers[1] as SmartObjectLayer;
    expect(a.source.id).toBe(b.source.id);
    expect(instanceCount(dup, a.source.id)).toBe(2);
    const blank = makeSource(a.source.name, { ...a.source.doc, layers: [] }, a.source.id);
    const replaced = replaceSource(dup, blank);
    for (const l of replaced.layers) expect(pixels(replaced, l.id).some((v) => v !== 0)).toBe(false);
  });

  it('New Smart Object via Copy makes contents of its own', () => {
    const doc = convertToSmart(docWith());
    const copy = newSmartViaCopy(doc, doc.activeLayerIds[0]!);
    const [a, b] = copy.layers as SmartObjectLayer[];
    expect(a!.source.id).not.toBe(b!.source.id);
    expect(copy.activeLayerIds[0]).toBe(b!.id);
  });

  it('Rasterize keeps the rendered pixels as a pixel layer', () => {
    const doc = docWith();
    const s = transformLayers(convertToSmart(doc), about(rotate(0.2), { x: 32, y: 24 }));
    const r = rasterizeSmart(s, s.activeLayerIds[0]!);
    expect(r.layers[0]!.kind).toBe('pixel');
    expect(worst(pixels(r), pixels(s))).toBe(0);
  });

  it('Convert to Layers places the contents where the smart object showed them', () => {
    const doc = docWith();
    const s = transformLayers(convertToSmart(doc), about(scale(0.5), { x: 32, y: 24 }));
    const g = convertToLayers(s, s.activeLayerIds[0]!);
    const group = g.layers[0]!;
    expect(group.kind).toBe('group');
    const inner = (group as { children: readonly { id: number }[] }).children[0]!;
    expect(worst(pixels(g, inner.id), pixels(s))).toBeLessThanOrEqual(1);
  });
});
