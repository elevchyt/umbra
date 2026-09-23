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
import { savePsd } from './psd-save.js';
import { openPsd } from './psd-open.js';

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

  it('round-trips through a PSD: text, runs, paragraphs, box, transform', () => {
    const bold = { ...DEFAULT_CHAR, size: 30, fauxBold: true, tracking: 50, color: [0, 0.5, 1] as [number, number, number], font: 'NotoSans-Bold', fontStyle: 'Bold' };
    const t: TextSpec = {
      kind: 'paragraph',
      orientation: 'horizontal',
      box: { width: 150, height: 80 },
      runs: [
        { text: 'Big ', style: bold },
        { text: 'small\nnext\u2028line', style: { ...DEFAULT_CHAR, size: 12, underline: true, kerning: -20, allCaps: true } },
      ],
      paragraphs: [{ ...DEFAULT_PARA, align: 'center', spaceAfter: 6 }, { ...DEFAULT_PARA, align: 'justifyAll', indentLeft: 4 }],
      warp: { style: 'flag', bend: 40, hDistort: -20, vDistort: 5, orientation: 'vertical' },
    };
    const l = makeTypeLayer('Text', t, rotate(0.1), 'crisp', { width: W, height: H });
    const back = openPsd(savePsd(docOf([l])));
    const r = back.doc.layers[0] as TypeLayer;
    expect(r.kind).toBe('type');
    expect(back.warnings).toEqual([]);
    expect(r.antiAlias).toBe('crisp');
    expect(r.text.kind).toBe('paragraph');
    expect(r.text.box).toEqual({ width: 150, height: 80 });
    expect(r.text.runs.map((x) => x.text)).toEqual(['Big ', 'small\nnext\u2028line']);
    expect(r.text.runs[0]!.style).toMatchObject({ font: 'NotoSans-Bold', family: 'Noto Sans', fontStyle: 'Bold', size: 30, fauxBold: true, tracking: 50 });
    expect(r.text.runs[0]!.style.color.map((v) => Math.round(v * 255))).toEqual([0, 128, 255]);
    expect(r.text.runs[1]!.style).toMatchObject({ size: 12, underline: true, kerning: -20, allCaps: true });
    expect(r.text.paragraphs.map((p) => p.align)).toEqual(['center', 'justifyAll']);
    expect(r.text.paragraphs[1]!.indentLeft).toBe(4);
    expect(r.transform.b).toBeCloseTo(Math.sin(0.1), 5);
    expect(r.text.warp).toEqual({ style: 'flag', bend: 40, hDistort: -20, vDistort: 5, orientation: 'vertical' });
  });
});
