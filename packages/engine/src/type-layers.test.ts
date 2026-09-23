import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compositeDocument } from '@umbra/kernels/composite';
import { rotate, translate, about } from '@umbra/kernels/matrix';
import { rasterizePath } from '@umbra/kernels/vector/raster';
import { FontRegistry, loadHarfBuzz, loadBundledFonts, DEFAULT_CHAR, DEFAULT_PARA, type TextSpec } from '@umbra/text';
import { emptyDoc, type Doc, type Layer, type TypeLayer } from './document.js';
import { makeTypeLayer, setTextEngine, typeBounds, typePath, typeLayerName } from './type-layers.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { transformLayers } from './commands/transform.js';
import { mergeDown } from './commands/layers.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { makePixelLayer } from './document.js';

beforeAll(async () => {
  const hb = await loadHarfBuzz();
  const reg = new FontRegistry(hb);
  await loadBundledFonts(reg, async (u) => {
    const b = readFileSync(fileURLToPath(u));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  setTextEngine(hb, reg);
});

const W = 200;
const H = 100;
const spec = (text: string): TextSpec => ({ kind: 'point', orientation: 'horizontal', runs: [{ text, style: { ...DEFAULT_CHAR, size: 40, color: [1, 0, 0] } }], paragraphs: [DEFAULT_PARA] });
const docOf = (layers: Layer[]): Doc => ({ ...emptyDoc(W, H), layers, activeLayerIds: [layers[layers.length - 1]!.id] });
const alphaSum = (doc: Doc) => {
  const ls = toCompositeLayers(doc);
  let s = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s += compositeDocument(ls, x, y).alpha;
  return s;
};

describe('type layers', () => {
  it('render at their origin, in their colour', () => {
    const l = makeTypeLayer('T', spec('Hi'), translate(20, 60), 'smooth', { width: W, height: H });
    const b = typeBounds(l);
    // 40 px Noto Sans: cap height ≈ 29 px above the baseline at y = 60.
    expect(b.y0).toBeGreaterThan(28);
    expect(b.y0).toBeLessThan(33);
    expect(b.y1).toBeCloseTo(60, 0);
    expect(b.x0).toBeGreaterThan(20);
    const doc = docOf([l]);
    const p = compositeDocument(toCompositeLayers(doc), 26, 45);
    expect(p.alpha).toBe(1);
    expect(p.color.map((v) => Math.round(v * 255))).toEqual([255, 0, 0]);
  });

  it('transform re-renders from outlines: the ink is kept through a rotation', () => {
    const l = makeTypeLayer('T', spec('Hi'), translate(70, 65), 'smooth', { width: W, height: H });
    const a = alphaSum(docOf([l]));
    const turned = transformLayers(docOf([l]), about(rotate(Math.PI / 6), { x: 100, y: 50 }));
    const t = turned.layers[0] as TypeLayer;
    expect(t.kind).toBe('type');
    expect(t.transform.b).toBeCloseTo(0.5, 6);
    expect(Math.abs(alphaSum(turned) - a) / a).toBeLessThan(0.01);
  });

  it('the outline path fills what the layer draws; Merge Down bakes it', () => {
    const l = makeTypeLayer('T', spec('Ok'), translate(30, 70), 'smooth', { width: W, height: H });
    const cov = rasterizePath(typePath(l)!, { x0: 0, y0: 0, x1: W, y1: H }).reduce((s, v) => s + v, 0);
    const a = alphaSum(docOf([l]));
    expect(Math.abs(cov - a) / a).toBeLessThan(0.01);
    const bottom = makePixelLayer('B', Plane.empty(RGBA8));
    const merged = mergeDown(docOf([bottom, l]), l.id);
    expect(merged.layers[0]!.kind).toBe('pixel');
    expect(Math.abs(alphaSum(merged) - a) / a).toBeLessThan(0.01);
  });

  it('names from the first line', () => {
    expect(typeLayerName('  Hello world\nmore')).toBe('Hello world');
    expect(typeLayerName('')).toBe('Layer');
  });
});
