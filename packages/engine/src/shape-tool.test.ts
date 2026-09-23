import { describe, expect, it } from 'vitest';
import { liveShapePath } from '@umbra/kernels/vector/shapes';
import { transformPath } from '@umbra/kernels/vector/path';
import { DEFAULT_SHAPE_OPTIONS, dragBox, shapeFromDrag } from './shape-tool.js';
import { liveAfterEdit, makeShapeLayer, VectorMaskCache } from './shape-layers.js';
import { makePixelLayer } from './document.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';

const o = DEFAULT_SHAPE_OPTIONS;

describe('shape tool drags', () => {
  it('a box from the corner; Shift squares it; Alt draws from the centre', () => {
    expect(dragBox({ x: 10, y: 10 }, { x: 40, y: 20 }, false, false)).toEqual({ x: 10, y: 10, w: 30, h: 10 });
    expect(dragBox({ x: 10, y: 10 }, { x: 0, y: 5 }, false, false)).toEqual({ x: 0, y: 5, w: 10, h: 5 });
    expect(dragBox({ x: 10, y: 10 }, { x: 40, y: 20 }, true, false)).toEqual({ x: 10, y: 10, w: 30, h: 30 });
    expect(dragBox({ x: 10, y: 10 }, { x: 40, y: 20 }, false, true)).toEqual({ x: -20, y: 0, w: 60, h: 20 });
  });

  it('each tool makes its live shape', () => {
    const a = { x: 10, y: 10 };
    const b = { x: 50, y: 30 };
    expect(shapeFromDrag('rectangle', a, b, false, false, { ...o, radius: 4 })!.live).toMatchObject({ kind: 'rect', x: 10, y: 10, w: 40, h: 20, radii: [4, 4, 4, 4] });
    expect(shapeFromDrag('ellipse', a, b, false, false, o)!.live).toMatchObject({ kind: 'ellipse', cx: 30, cy: 20, rx: 20, ry: 10 });
    expect(shapeFromDrag('triangle', a, b, false, false, o)!.live).toMatchObject({ kind: 'triangle', w: 40, h: 20 });
    const poly = shapeFromDrag('polygon', a, { x: 10, y: 0 }, false, false, { ...o, sides: 6 })!.live!;
    // Dragging straight up points a vertex straight up: no turn.
    expect(poly).toMatchObject({ kind: 'polygon', cx: 10, cy: 10, r: 10, sides: 6 });
    expect((poly as { angle: number }).angle).toBeCloseTo(0, 9);
    const line = shapeFromDrag('line', a, { x: 50, y: 14 }, true, false, { ...o, weight: 2 })!.live!;
    expect(line).toMatchObject({ kind: 'line', x0: 10, y0: 10, y1: 10, weight: 2 });
    const custom = shapeFromDrag('customShape', a, b, false, false, { ...o, customShape: 'star5' })!;
    expect(custom.live).toBeUndefined();
    expect(custom.path.subpaths[0]!.knots).toHaveLength(10);
    // Too small to be a shape.
    expect(shapeFromDrag('rectangle', a, { x: 10.2, y: 30 }, false, false, o)).toBeNull();
  });
});

describe('live shapes under editing', () => {
  const size = { width: 100, height: 100 };
  const live = { kind: 'rect' as const, x: 10, y: 10, w: 20, h: 20, radii: [0, 0, 0, 0] as [number, number, number, number], angle: 0 };
  const layer = makeShapeLayer('R', liveShapePath(live), o.fill, null, size, { live });

  it('moving the whole path keeps it live; moving an anchor does not', () => {
    const moved = transformPath(layer.path, { a: 1, b: 0, c: 0, d: 1, e: 5, f: -2 });
    expect(liveAfterEdit(layer, moved)).toMatchObject({ x: 15, y: 8, w: 20, h: 20 });
    const knots = layer.path.subpaths[0]!.knots.map((k, i) => (i === 0 ? { ...k, anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } } : k));
    expect(liveAfterEdit(layer, { subpaths: [{ ...layer.path.subpaths[0]!, knots }] })).toBeUndefined();
  });

  it('an empty vector mask reveals all unless it is Hide All', () => {
    const px = makePixelLayer('P', Plane.empty(RGBA8));
    const cache = new VectorMaskCache();
    expect(cache.effectiveMask({ ...px, vectorMask: { path: { subpaths: [] }, enabled: true } }, size)).toBeUndefined();
    const hidden = cache.effectiveMask({ ...px, vectorMask: { path: { subpaths: [] }, enabled: true, hideAll: true } }, size);
    expect(hidden).toBeDefined();
    expect(hidden!.plane.base.tileCount).toBe(0);
  });
});
