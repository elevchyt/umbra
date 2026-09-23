import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { compositeDocument } from '@umbra/kernels/composite';
import { about, rotate, scale, translate } from '@umbra/kernels/matrix';
import { liveShapePath, type LiveShape } from '@umbra/kernels/vector/shapes';
import { DEFAULT_STROKE } from '@umbra/kernels/vector/stroke';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type Layer, type ShapeLayer } from './document.js';
import { makeShapeLayer } from './shape-layers.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { transformLayers } from './commands/transform.js';
import { mergeDown } from './commands/layers.js';
import { bitmapFromPlane } from './psd-save.js';

const W = 80;
const H = 60;
const docOf = (layers: Layer[]): Doc => ({ ...emptyDoc(W, H), layers, activeLayerIds: [layers[layers.length - 1]!.id] });
const px = (doc: Doc, x: number, y: number) => {
  const p = compositeDocument(toCompositeLayers(doc), x, y);
  return [...p.color.map((c) => Math.round(c * 255)), Math.round(p.alpha * 255)];
};
const rect = (x: number, y: number, w: number, h: number): LiveShape => ({ kind: 'rect', x, y, w, h, radii: [0, 0, 0, 0], angle: 0 });
const red = { type: 'solid' as const, color: [1, 0, 0] as [number, number, number] };
const blackStroke = (width: number, align: 'center' | 'inside' | 'outside' = 'center') => ({ enabled: true, style: { ...DEFAULT_STROKE, width, align }, content: { type: 'solid' as const, color: [0, 0, 0] as [number, number, number] }, opacity: 1, blendMode: 'normal' as const });

describe('shape layers', () => {
  it('fill inside the path, stroke over it', () => {
    const live = rect(20, 20, 30, 20);
    const s = makeShapeLayer('Rectangle 1', liveShapePath(live), red, blackStroke(4), { width: W, height: H }, { live });
    const doc = docOf([s]);
    expect(px(doc, 35, 30)).toEqual([255, 0, 0, 255]);
    // The centred 4 px stroke straddles the edge at x = 20: 18…22 is black.
    expect(px(doc, 19, 30)).toEqual([0, 0, 0, 255]);
    expect(px(doc, 21, 30)).toEqual([0, 0, 0, 255]);
    expect(px(doc, 17, 30)[3]).toBe(0);
  });

  it('an inside stroke stays inside; no fill leaves only the stroke', () => {
    const live = rect(20, 20, 30, 20);
    const inside = docOf([makeShapeLayer('S', liveShapePath(live), red, blackStroke(3, 'inside'), { width: W, height: H })]);
    expect(px(inside, 19, 30)[3]).toBe(0);
    expect(px(inside, 21, 30)).toEqual([0, 0, 0, 255]);
    const outline = docOf([makeShapeLayer('S', liveShapePath(live), null, blackStroke(2), { width: W, height: H })]);
    expect(px(outline, 35, 30)[3]).toBe(0);
    expect(px(outline, 20, 30)).toEqual([0, 0, 0, 255]);
  });

  it('moving and scaling keep a live rectangle live; rotating makes it a path', () => {
    const live = rect(20, 20, 20, 10);
    const s = makeShapeLayer('S', liveShapePath(live), red, null, { width: W, height: H }, { live });
    const moved = transformLayers(docOf([s]), translate(5.5, 3)).layers[0] as ShapeLayer;
    expect(moved.live).toEqual({ ...live, x: 25.5, y: 23 });
    const scaled = transformLayers(docOf([s]), about(scale(2, 1), { x: 20, y: 20 })).layers[0] as ShapeLayer;
    expect(scaled.live).toMatchObject({ x: 20, w: 40, h: 10 });
    const turned = transformLayers(docOf([s]), about(rotate(0.3), { x: 30, y: 25 })).layers[0] as ShapeLayer;
    expect(turned.live).toBeUndefined();
    // A transformed shape is re-rendered from its path, not resampled: edges stay hard.
    expect(px(docOf([moved]), 26, 25)).toEqual([255, 0, 0, 255]);
  });
});

describe('vector masks', () => {
  const solid = (): Plane => {
    const w = Plane.empty(RGBA8).writer();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) w.mutable(x >> 8, y >> 8).set([0, 0, 255, 255], ((y & 255) * TILE_SIZE + (x & 255)) * 4);
    return w.commit();
  };

  it('a vector mask shows the layer only inside its path, and moves with it', () => {
    const layer = makePixelLayer('Blue', solid(), { vectorMask: { path: liveShapePath(rect(10, 10, 20, 20)), enabled: true } });
    const doc = docOf([layer]);
    expect(px(doc, 15, 15)).toEqual([0, 0, 255, 255]);
    expect(px(doc, 35, 15)[3]).toBe(0);
    const moved = transformLayers(doc, translate(20, 0));
    expect(px(moved, 35, 15)[3]).toBe(255);
    const off = docOf([{ ...layer, vectorMask: { ...layer.vectorMask!, enabled: false } }]);
    expect(px(off, 35, 15)[3]).toBe(255);
  });

  it('Merge Down bakes shapes and vector masks into pixels', () => {
    const s = makeShapeLayer('S', liveShapePath(rect(10, 10, 20, 20)), red, null, { width: W, height: H });
    const bottom = makePixelLayer('Bottom', Plane.empty(RGBA8));
    const merged = mergeDown(docOf([bottom, s]), s.id).layers[0]!;
    expect(merged.kind).toBe('pixel');
    const at = bitmapFromPlane((merged as { plane: { base: Plane } }).plane.base, { x0: 15, y0: 15, x1: 16, y1: 16 }).data;
    expect(Array.from(at)).toEqual([255, 0, 0, 255]);
  });

  it('a vector mask multiplies a raster mask, its default outside stored tiles included', () => {
    const w = Plane.empty({ layout: 'A', sample: 'u8' }, [255]).writer();
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) w.mutable(0, 0)[y * TILE_SIZE + x] = 0;
    const mask = { plane: new MipPlane(w.commit()), enabled: true, linked: true, density: 1, feather: 0, defaultColor: 1 as const };
    const hole = { ...liveShapePath(rect(35, 20, 10, 10)).subpaths[0]!, op: 'subtract' as const };
    const layer = makePixelLayer('L', solid(), { mask, vectorMask: { enabled: true, path: { subpaths: [...liveShapePath(rect(10, 10, 60, 40)).subpaths, hole] } } });
    const doc = docOf([layer]);
    expect(px(doc, 15, 30)[3]).toBe(0); // raster mask hides
    expect(px(doc, 30, 30)[3]).toBe(255); // both reveal
    expect(px(doc, 40, 25)[3]).toBe(0); // the subtracted component
    expect(px(doc, 75, 30)[3]).toBe(0); // outside the path
  });
});
