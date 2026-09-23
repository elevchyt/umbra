import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { about, rotate, scale, compose } from '@umbra/kernels/matrix';
import { FILTER_BY_ID, defaultsOf } from '@umbra/kernels/filters/index';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, findLayer, makePixelLayer, walkLayers, type Doc, type SmartObjectLayer } from './document.js';
import { transformLayers } from './commands/transform.js';
import { duplicateLayer } from './commands/layers.js';
import { savePsd, bitmapFromPlane } from './psd-save.js';
import { openPsd } from './psd-open.js';
import { addSmartFilter, convertToSmart, makeSmartLayer, makeSource, rendered } from './smart.js';
import { FILTER_MAP, fromPsdFilter, isAffineQuad, matrixToQuad, quadToMatrix, toPsdFilter } from './psd-smart.js';

const W = 64;
const H = 48;

function picture(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 6; y < 40; y++) {
    for (let x = 8; x < 56; x++) {
      const d = w.mutable(x >> 8, y >> 8);
      const o = ((y & 255) * TILE_SIZE + (x & 255)) * 4;
      d[o] = (x * 5) & 255;
      d[o + 1] = (y * 6) & 255;
      d[o + 2] = x > 30 ? 220 : 40;
      d[o + 3] = 255;
    }
  }
  return w.commit();
}

function smartDoc(): Doc {
  const layer = makePixelLayer('Photo', picture());
  return convertToSmart({ ...emptyDoc(W, H, 'test.psd'), layers: [layer], activeLayerIds: [layer.id] });
}

const smartOf = (doc: Doc) => [...walkLayers(doc.layers)].map((w) => w.layer).filter((l): l is SmartObjectLayer => l.kind === 'smart');
const pixels = (doc: Doc, l: SmartObjectLayer) => bitmapFromPlane(l.plane.base, { x0: 0, y0: 0, x1: doc.width, y1: doc.height }).data;
const worst = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};
const filter = (id: string, params = {}, over = {}) => ({
  filterId: id,
  params: { ...defaultsOf(FILTER_BY_ID.get(id)!), ...params },
  blendMode: 'normal' as const,
  opacity: 1,
  enabled: true,
  foreground: [0, 0, 0] as [number, number, number],
  background: [1, 1, 1] as [number, number, number],
  ...over,
});

/** Settings Photoshop's descriptor has no field for (Clouds' high contrast is an Alt-click, not a setting). */
const UNCARRIED = new Set(['render.clouds.contrast', 'render.differenceclouds.contrast', 'stylize.wind.seed', 'other.maximum.preserve', 'other.minimum.preserve']);

describe('smart filter ↔ Photoshop filter descriptors', () => {
  it('every mapped filter survives a write and read through the PSD codec', () => {
    const doc = smartDoc();
    const id = doc.activeLayerIds[0]!;
    let d = doc;
    for (const m of FILTER_MAP) {
      const def = FILTER_BY_ID.get(m.ours)!;
      // Settings off their defaults, so a mapping that ignores one shows up.
      const params = defaultsOf(def);
      for (const s of def.params) {
        if (s.type === 'number') params[s.key] = Math.round(s.min + (s.max - s.min) * 0.3);
        if (s.type === 'select') params[s.key] = s.options[1 % s.options.length]!.value;
        if (s.type === 'bool') params[s.key] = !s.default;
        if (s.type === 'seed') params[s.key] = 1234;
      }
      d = { ...d, layers: d.layers.map((l) => (l.id === id ? { ...(l as SmartObjectLayer), filters: [...(l as SmartObjectLayer).filters, { ...filter(m.ours, params), id: 0 }] } : l)) };
    }
    const before = smartOf(d)[0]!.filters;
    const back = smartOf(openPsd(savePsd(d, { maximizeCompatibility: false })).doc)[0]!;
    expect(back.filters.map((f) => f.filterId)).toEqual(before.map((f) => f.filterId));
    for (let i = 0; i < before.length; i++) {
      const a = before[i]!;
      const b = back.filters[i]!;
      const def = FILTER_BY_ID.get(a.filterId)!;
      // Lens Flare's centre goes through document pixels; allow for the rounding.
      for (const s of def.params) {
        const x = a.params[s.key];
        const y = b.params[s.key];
        if (s.type === 'point') {
          expect(Math.abs((x as { x: number }).x - (y as { x: number }).x), `${a.filterId}.${s.key}`).toBeLessThan(0.02);
        } else if (s.type === 'number' && typeof x === 'number') {
          expect(y as number, `${a.filterId}.${s.key}`).toBeCloseTo(x, 1);
        } else if (def.id !== 'blur.radialblur' && !UNCARRIED.has(`${a.filterId}.${s.key}`)) {
          expect(y, `${a.filterId}.${s.key}`).toEqual(x);
        }
      }
    }
  });

  it('filters with no Photoshop equivalent are left out rather than written wrong', () => {
    expect(toPsdFilter({ ...filter('filter.gallery'), id: 1 }, { width: W, height: H })).toBeNull();
    expect(fromPsdFilter({ type: 'oil paint plugin', name: 'Oil Paint' } as never, { width: W, height: H })).toEqual({ unsupported: 'Oil Paint' });
  });

  it('placement quads and matrices convert both ways', () => {
    const m = compose(scale(0.5, 0.8), compose(rotate(0.3), { a: 1, b: 0, c: 0, d: 1, e: 12, f: 7 }));
    const q = matrixToQuad(m, 100, 60);
    expect(isAffineQuad(q)).toBe(true);
    const back = quadToMatrix(q, 100, 60);
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) expect(back[k]).toBeCloseTo(m[k], 9);
    expect(isAffineQuad([0, 0, 10, 0, 12, 10, 0, 10])).toBe(false);
  });
});

describe('smart objects through PSD', () => {
  it('reopen as smart objects with contents, transform, filters and the stored rendering', () => {
    let doc = smartDoc();
    const id = doc.activeLayerIds[0]!;
    doc = transformLayers(doc, about(compose(scale(0.7), rotate(0.25)), { x: 32, y: 24 }));
    doc = addSmartFilter(doc, id, filter('blur.gaussianblur', { radius: 1.5 }));
    doc = addSmartFilter(doc, id, filter('stylize.solarize', {}, { opacity: 0.6, blendMode: 'multiply' }));
    const saved = smartOf(doc)[0]!;
    const reopened = openPsd(savePsd(doc));
    expect(reopened.warnings, JSON.stringify(reopened.warnings)).toEqual([]);
    const back = smartOf(reopened.doc)[0]!;
    expect(back.name).toBe(saved.name);
    expect([back.source.doc.width, back.source.doc.height]).toEqual([saved.source.doc.width, saved.source.doc.height]);
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) expect(back.transform[k]).toBeCloseTo(saved.transform[k], 3);
    expect(back.filters.map((f) => [f.filterId, f.blendMode, Math.round(f.opacity * 100)])).toEqual([
      ['blur.gaussianblur', 'normal', 100],
      ['stylize.solarize', 'multiply', 60],
    ]);
    // It shows what was saved, and rendering it afresh from the contents agrees.
    expect(worst(pixels(reopened.doc, back), pixels(doc, saved))).toBe(0);
    expect(worst(pixels(reopened.doc, rendered(back, reopened.doc)), pixels(doc, saved))).toBeLessThanOrEqual(2);
  });

  it('instances share one embedded file and one source', () => {
    const doc = smartDoc();
    const dup = duplicateLayer(doc, doc.activeLayerIds[0]!);
    const back = smartOf(openPsd(savePsd(dup, { maximizeCompatibility: false })).doc);
    expect(back.length).toBe(2);
    expect(back[0]!.source).toBe(back[1]!.source);
  });

  it('smart objects nest', () => {
    const inner = smartDoc();
    const outer = convertToSmart(inner);
    const back = openPsd(savePsd(outer, { maximizeCompatibility: false })).doc;
    const top = smartOf(back)[0]!;
    expect(top.source.doc.layers[0]!.kind).toBe('smart');
  });

  it('a placed picture is embedded as its original file and comes back to be decoded', () => {
    const doc = emptyDoc(W, H, 'p.psd');
    const contents = { ...emptyDoc(20, 10, 'dot.png'), layers: [makePixelLayer('dot', picture())] };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const source = makeSource('dot.png', contents, undefined, { bytes, type: 'image/png' });
    const layer = makeSmartLayer('dot', source, { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 }, doc);
    const withIt = { ...doc, layers: [layer], activeLayerIds: [layer.id] };
    const reopened = openPsd(savePsd(withIt, { maximizeCompatibility: false }));
    expect(reopened.pendingSources.length).toBe(1);
    expect(Array.from(reopened.pendingSources[0]!.bytes)).toEqual(Array.from(bytes));
    expect(reopened.pendingSources[0]!.type).toBe('image/png');
    const back = smartOf(reopened.doc)[0]!;
    expect([back.source.doc.width, back.source.doc.height, back.transform.e]).toEqual([20, 10, 5]);
    expect(findLayer(reopened.doc.layers, back.id)).toBeDefined();
  });
});
