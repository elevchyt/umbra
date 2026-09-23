import { describe, expect, it } from 'vitest';
import { BUILTIN_SHAPES, fitShape, readCsh, readPathRecords, svgPath, writeCsh, writePathRecords } from './custom.js';
import { pathBounds } from './path.js';
import { rasterizePath } from './raster.js';

const area = (p: Parameters<typeof rasterizePath>[0], w: number, h: number) => rasterizePath(p, { x0: 0, y0: 0, x1: w, y1: h }).reduce((a, b) => a + b, 0);

describe('custom shapes', () => {
  it('reads SVG path data: lines, curves and closing', () => {
    const p = svgPath('M0 0 L10 0 L10 10 L0 10 Z');
    expect(p.subpaths).toHaveLength(1);
    expect(p.subpaths[0]!.closed).toBe(true);
    expect(p.subpaths[0]!.knots).toHaveLength(4);
    expect(area(p, 20, 20)).toBeCloseTo(100, 3);
    // Relative commands and a curve.
    const q = svgPath('m5 5 h10 v10 c0 0 -10 0 -10 0 z');
    expect(pathBounds(q, 0.05)).toEqual({ x0: 5, y0: 5, x1: 15, y1: 15 });
  });

  it('every built-in shape has area; a ring has its hole', () => {
    for (const s of BUILTIN_SHAPES) {
      const fitted = fitShape(s.path, { x: 0, y: 0, w: 50, h: 50 });
      const b = pathBounds(fitted, 0.05)!;
      expect(b.x1 - b.x0).toBeCloseTo(50, 1);
      expect(b.y1 - b.y0).toBeCloseTo(50, 1);
      expect(area(fitted, 50, 50)).toBeGreaterThan(200);
    }
    const ring = fitShape(BUILTIN_SHAPES.find((s) => s.id === 'ring')!.path, { x: 0, y: 0, w: 100, h: 100 });
    const cov = rasterizePath(ring, { x0: 0, y0: 0, x1: 100, y1: 100 });
    expect(cov[50 * 100 + 50]).toBe(0);
    expect(cov[50 * 100 + 10]).toBe(1);
    // π(50² − 25²) ≈ 5890.
    expect(area(ring, 100, 100)).toBeCloseTo(Math.PI * (2500 - 625), -1);
  });

  it('path records round-trip, operations included', () => {
    const p = BUILTIN_SHAPES.find((s) => s.id === 'ring')!.path;
    const norm = fitShape(p, { x: 0, y: 0, w: 1, h: 1 });
    const bytes = writePathRecords(norm);
    const back = readPathRecords(new DataView(bytes.buffer), 0, bytes.length / 26);
    expect(back.subpaths.map((s) => s.op)).toEqual(['add', 'exclude']);
    expect(back.subpaths[0]!.knots[0]!.anchor.x).toBeCloseTo(norm.subpaths[0]!.knots[0]!.anchor.x, 6);
    expect(back.subpaths[1]!.knots[2]!.out.y).toBeCloseTo(norm.subpaths[1]!.knots[2]!.out.y, 6);
  });

  it('a .csh file round-trips through the reader', () => {
    const shapes = BUILTIN_SHAPES.slice(0, 3).map((s) => ({ ...s, path: fitShape(s.path, { x: 0, y: 0, w: 1, h: 1 }) }));
    const buf = writeCsh(shapes);
    const back = readCsh(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    expect(back.map((s) => s.name)).toEqual(shapes.map((s) => s.name));
    expect(back.map((s) => s.id)).toEqual(shapes.map((s) => s.id));
    expect(back[1]!.path.subpaths[0]!.knots).toHaveLength(shapes[1]!.path.subpaths[0]!.knots.length);
    expect(() => readCsh(new ArrayBuffer(16))).toThrow();
  });
});
