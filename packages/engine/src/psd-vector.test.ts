import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { liveShapePath } from '@umbra/kernels/vector/shapes';
import { DEFAULT_STROKE } from '@umbra/kernels/vector/stroke';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc, type ShapeLayer } from './document.js';
import { makeShapeLayer } from './shape-layers.js';
import { savePsd } from './psd-save.js';
import { openPsd } from './psd-open.js';

function solid(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) w.mutable(0, 0).set([20, 90, 200, 255], (y * TILE_SIZE + x) * 4);
  return w.commit();
}

describe('PSD shape layers and vector masks', () => {
  it('round-trip: path, live rectangle, fill, stroke; a vector mask with its components', () => {
    const size = { width: 80, height: 60 };
    const live = { kind: 'rect' as const, x: 10, y: 12, w: 40, h: 24, radii: [4, 4, 4, 4] as [number, number, number, number], angle: 0 };
    const stroke = { enabled: true, style: { ...DEFAULT_STROKE, width: 2.5, align: 'outside' as const, join: 'round' as const, dashes: [3, 1] }, content: { type: 'solid' as const, color: [0, 0.5, 0] as [number, number, number] }, opacity: 0.8, blendMode: 'multiply' as const };
    const shape = makeShapeLayer('Rectangle 1', liveShapePath(live), { type: 'solid', color: [1, 0, 0] }, stroke, size, { live });
    const outline = makeShapeLayer('Outline', liveShapePath({ kind: 'ellipse', cx: 40, cy: 30, rx: 10, ry: 8, angle: 0 }), null, stroke, size);
    const holed = liveShapePath({ kind: 'ellipse', cx: 30, cy: 30, rx: 20, ry: 20, angle: 0 });
    const inner = liveShapePath({ kind: 'rect', x: 25, y: 25, w: 10, h: 10, radii: [0, 0, 0, 0], angle: 0 }).subpaths[0]!;
    const masked = makePixelLayer('Masked', solid(), { vectorMask: { path: { subpaths: [...holed.subpaths, { ...inner, op: 'subtract' }] }, enabled: false } });
    const revealed = makePixelLayer('Hidden', solid(), { vectorMask: { path: { subpaths: [] }, enabled: true, hideAll: true } });
    const doc: Doc = { ...emptyDoc(80, 60), layers: [masked, revealed, shape, outline], activeLayerIds: [shape.id] };

    const back = openPsd(savePsd(doc));
    expect(back.warnings).toEqual([]);
    const [m, h, s, o] = back.doc.layers as [typeof masked, typeof revealed, ShapeLayer, ShapeLayer];
    expect(s.kind).toBe('shape');
    expect(s.live).toEqual(live);
    expect(s.fillContent).toEqual({ type: 'solid', color: [1, 0, 0] });
    expect(s.stroke!.style).toMatchObject({ width: 2.5, align: 'outside', join: 'round', dashes: [3, 1] });
    expect(s.stroke!.opacity).toBeCloseTo(0.8, 2);
    expect(s.stroke!.blendMode).toBe('multiply');
    const k0 = s.path.subpaths[0]!.knots[0]!;
    const k1 = shape.path.subpaths[0]!.knots[0]!;
    // Path records are 8.24 fixed point of the canvas size: exact to about 1e-5 px here.
    expect(k0.anchor.x).toBeCloseTo(k1.anchor.x, 3);
    expect(k0.out.y).toBeCloseTo(k1.out.y, 3);
    expect(o.fillContent).toBeNull();
    expect(o.live).toBeUndefined();
    expect(o.stroke!.enabled).toBe(true);
    expect(m.vectorMask!.enabled).toBe(false);
    expect(m.vectorMask!.path.subpaths.map((p) => p.op)).toEqual(['add', 'subtract']);
    expect(h.vectorMask).toMatchObject({ enabled: true, hideAll: true });
  });
});
