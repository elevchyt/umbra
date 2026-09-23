import { describe, expect, it } from 'vitest';
import { corner, cubicAt, deleteKnot, flattenSubpath, insertKnot, nearestOnPath, pathBounds, segments, type Path, type Subpath } from './path.js';
import { rasterizePath, rasterizeShapes } from './raster.js';
import { DEFAULT_STROKE, strokeShapes } from './stroke.js';
import { liveShapePath } from './shapes.js';
import { cubicsToSubpath, fitCurve } from './fit.js';
import { coverageToPath } from './trace.js';

const R = { x0: 0, y0: 0, x1: 64, y1: 64 };
const sum = (v: Float32Array) => v.reduce((a, b) => a + b, 0);
const box = (x0: number, y0: number, x1: number, y1: number, op: Subpath['op'] = 'add'): Subpath => ({ closed: true, op, knots: [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)] });
const at = (v: Float32Array, x: number, y: number) => v[y * 64 + x]!;

describe('rasterising paths', () => {
  it('a pixel-aligned square covers exactly its pixels', () => {
    const v = rasterizePath({ subpaths: [box(10, 10, 30, 20)] }, R);
    expect(sum(v)).toBeCloseTo(200, 3);
    expect(at(v, 10, 10)).toBe(1);
    expect(at(v, 9, 10)).toBe(0);
    expect(at(v, 29, 19)).toBe(1);
    expect(at(v, 30, 19)).toBe(0);
  });

  it('a half-pixel edge is half covered, and area is exact', () => {
    const v = rasterizePath({ subpaths: [box(10.5, 10, 20.5, 20)] }, R);
    expect(at(v, 10, 15)).toBeCloseTo(0.5, 5);
    expect(at(v, 20, 15)).toBeCloseTo(0.5, 5);
    expect(sum(v)).toBeCloseTo(100, 3);
  });

  it('a circle has area πr² and the winding direction does not matter', () => {
    const c = liveShapePath({ kind: 'ellipse', cx: 32, cy: 32, rx: 20, ry: 20, angle: 0 });
    expect(Math.abs(sum(rasterizePath(c, R)) / (Math.PI * 400) - 1)).toBeLessThan(0.003);
    const reversed: Path = { subpaths: [{ ...c.subpaths[0]!, knots: [...c.subpaths[0]!.knots].reverse().map((k) => ({ ...k, in: k.out, out: k.in })) }] };
    expect(sum(rasterizePath(reversed, R))).toBeCloseTo(sum(rasterizePath(c, R)), 2);
  });

  it('two abutting shapes join without a seam', () => {
    const v = rasterizePath({ subpaths: [box(10.3, 10, 20.3, 20), box(20.3, 10, 30.7, 20)] }, R);
    expect(at(v, 20, 15)).toBeCloseTo(1, 5);
  });

  it('subtract, intersect and exclude act on the shapes before them', () => {
    const a = box(10, 10, 40, 40);
    const b = box(20, 20, 50, 50);
    expect(sum(rasterizePath({ subpaths: [a, { ...b, op: 'subtract' }] }, R))).toBeCloseTo(900 - 400, 2);
    expect(sum(rasterizePath({ subpaths: [a, { ...b, op: 'intersect' }] }, R))).toBeCloseTo(400, 2);
    expect(sum(rasterizePath({ subpaths: [a, { ...b, op: 'exclude' }] }, R))).toBeCloseTo(900 + 900 - 800, 2);
    // A shape that starts by subtracting shows everything but itself.
    expect(sum(rasterizePath({ subpaths: [{ ...a, op: 'subtract' }] }, R))).toBeCloseTo(64 * 64 - 900, 2);
  });

  it('even-odd leaves the middle of a self-overlapping outline empty', () => {
    const outer = [corner(10, 10), corner(50, 10), corner(50, 50), corner(10, 50)];
    const inner = [corner(20, 20), corner(40, 20), corner(40, 40), corner(20, 40)];
    const p = { polys: [outer.map((k) => k.anchor), inner.map((k) => k.anchor)], op: 'add' as const };
    expect(sum(rasterizeShapes([{ ...p, rule: 'nonzero' }], R))).toBeCloseTo(1600, 2);
    expect(sum(rasterizeShapes([{ ...p, rule: 'evenodd' }], R))).toBeCloseTo(1600 - 400, 2);
  });
});

describe('strokes', () => {
  const line: Path = { subpaths: [{ closed: false, op: 'add', knots: [corner(10, 32), corner(50, 32)] }] };
  const area = (p: Path, s = {}) => sum(rasterizeShapes(strokeShapes(p, { ...DEFAULT_STROKE, width: 4, ...s }), R));

  it('caps: butt adds nothing, square half a width each end, round a half disc', () => {
    expect(area(line)).toBeCloseTo(160, 1);
    expect(area(line, { cap: 'square' })).toBeCloseTo(160 + 16, 1);
    expect(Math.abs(area(line, { cap: 'round' }) - (160 + Math.PI * 4)) / 160).toBeLessThan(0.01);
  });

  it('a closed square: centre straddles the edge, inside and outside keep to their side', () => {
    const sq: Path = { subpaths: [box(16, 16, 48, 48)] };
    expect(area(sq)).toBeCloseTo(36 * 36 - 28 * 28, 0);
    expect(area(sq, { align: 'inside' })).toBeCloseTo(32 * 32 - 24 * 24, 0);
    // Outside: miter corners are square, so the outer boundary is a 40² square.
    expect(area(sq, { align: 'outside' })).toBeCloseTo(40 * 40 - 32 * 32, 0);
  });

  it('dashes alternate along the line in multiples of the width', () => {
    const v = rasterizeShapes(strokeShapes(line, { ...DEFAULT_STROKE, width: 2, dashes: [2, 2] }), R);
    // Dash 4 px, gap 4 px from x = 10.
    expect(at(v, 11, 32)).toBeCloseTo(1, 3);
    expect(at(v, 15, 32)).toBeCloseTo(0, 3);
    expect(at(v, 19, 32)).toBeCloseTo(1, 3);
  });
});

describe('editing paths', () => {
  const circle = liveShapePath({ kind: 'ellipse', cx: 32, cy: 32, rx: 20, ry: 12, angle: 0 });

  it('inserting a knot keeps the curve exactly', () => {
    const before = flattenSubpath(circle.subpaths[0]!, 0.05);
    const split = insertKnot(circle, 0, 1, 0.3);
    expect(split.subpaths[0]!.knots.length).toBe(5);
    const c = segments(split.subpaths[0]!)[1]!;
    const onCurve = cubicAt(c, 1);
    expect(nearestOnPath(circle, onCurve)!.distance).toBeLessThan(1e-6);
    // Only flattening differs (the split segments flatten at their own points).
    expect(Math.abs(sum(rasterizePath(split, R)) - sum(rasterizePath(circle, R)))).toBeLessThan(0.5);
    void before;
  });

  it('deleting a knot leaves the others', () => {
    const d = deleteKnot(circle, 0, 2);
    expect(d.subpaths[0]!.knots.length).toBe(3);
  });

  it('nearest point finds the distance to a curve', () => {
    const r = nearestOnPath(circle, { x: 32, y: 10 })!;
    expect(r.distance).toBeCloseTo(10, 2);
  });

  it('bounds follow the curve, not the handles', () => {
    const b = pathBounds(circle, 0.05)!;
    expect(b.x0).toBeCloseTo(12, 1);
    expect(b.y1).toBeCloseTo(44, 1);
  });

  it('a rounded rectangle loses (4 − π)·r² to its corners', () => {
    const p = liveShapePath({ kind: 'rect', x: 10, y: 10, w: 40, h: 30, radii: [8, 8, 8, 8], angle: 0 });
    expect(Math.abs(sum(rasterizePath(p, R)) - (1200 - (4 - Math.PI) * 64))).toBeLessThan(1);
  });
});

describe('fitting and tracing', () => {
  it('fitted curves stay within the tolerance of the points', () => {
    const pts = Array.from({ length: 80 }, (_, i) => ({ x: 32 + 20 * Math.cos((i / 80) * Math.PI * 2), y: 32 + 20 * Math.sin((i / 80) * Math.PI * 2) }));
    const cubics = fitCurve(pts, 0.5, true);
    expect(cubics.length).toBeLessThan(10);
    const sp = cubicsToSubpath(cubics, true);
    for (const p of pts) expect(nearestOnPath({ subpaths: [sp] }, p)!.distance).toBeLessThan(0.6);
  });

  it('a traced disc comes back as a path that fills to the same disc', () => {
    const disc = rasterizePath(liveShapePath({ kind: 'ellipse', cx: 32, cy: 32, rx: 18, ry: 18, angle: 0 }), R);
    const path = coverageToPath(disc, 64, 64, 0.5);
    expect(path.subpaths.length).toBe(1);
    const again = rasterizePath(path, R);
    expect(Math.abs(sum(again) - sum(disc)) / sum(disc)).toBeLessThan(0.01);
  });
});

describe('traced paths keep their holes', () => {
  it('a ring selection traces to a ring path', () => {
    const W = 60;
    const cov = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 30, y + 0.5 - 30);
      cov[y * W + x] = d < 25 && d > 12 ? 1 : 0;
    }
    const path = coverageToPath(cov, W, W, 0.5);
    const back = rasterizePath(path, { x0: 0, y0: 0, x1: W, y1: W });
    expect(back[30 * W + 30]).toBe(0);
    expect(back[30 * W + 10]).toBeGreaterThan(0.9);
    const a = cov.reduce((s, v) => s + v, 0);
    const b = back.reduce((s, v) => s + v, 0);
    expect(Math.abs(a - b) / a).toBeLessThan(0.03);
  });
});
