import { describe, expect, it } from 'vitest';
import {
  docPointAtScreen,
  fitToScreen,
  initialView,
  nextZoomStop,
  panBy,
  visibleDocRect,
  zoomAt,
  MAX_ZOOM,
  MIN_ZOOM,
} from './view.js';
import { matApply, matInvert, matMul, IDENTITY } from '@umbra/core/geom';

const view = () => ({ ...initialView(800, 600, 1), zoom: 1, centre: { x: 400, y: 300 } });

describe('view transform', () => {
  it('maps the view centre to the middle of the viewport', () => {
    const v = view();
    const p = docPointAtScreen(v, 400, 300);
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(300);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    let v = view();
    const before = docPointAtScreen(v, 123, 456);
    v = zoomAt(v, 3.7, 123, 456);
    const after = docPointAtScreen(v, 123, 456);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('keeps the cursor anchored through a zoom round trip', () => {
    let v = view();
    v = zoomAt(v, 4, 700, 100);
    v = zoomAt(v, 0.25, 700, 100);
    expect(v.zoom).toBeCloseTo(1, 6);
    expect(v.centre.x).toBeCloseTo(400, 6);
    expect(v.centre.y).toBeCloseTo(300, 6);
  });

  it('clamps zoom to the supported range', () => {
    expect(zoomAt(view(), 1e9, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(view(), 1e-9, 0, 0).zoom).toBe(MIN_ZOOM);
  });

  it('moves the image with the pointer when panning', () => {
    const v = view();
    const moved = panBy(v, 100, 0);
    // Dragging right shows content further left, so the centre moves left.
    expect(moved.centre.x).toBeCloseTo(300);
  });

  it('pans along the drag direction even when the canvas is rotated', () => {
    const v = { ...view(), rotation: Math.PI / 2 };
    const moved = panBy(v, 100, 0);
    // With a quarter turn, a horizontal drag moves the document vertically.
    expect(moved.centre.x).toBeCloseTo(400, 6);
    expect(Math.abs(moved.centre.y - 300)).toBeCloseTo(100, 6);
  });

  it('fits the whole document inside the viewport', () => {
    const v = fitToScreen(view(), 4000, 2000, 0);
    expect(v.zoom).toBeCloseTo(Math.min(800 / 4000, 600 / 2000));
    expect(v.centre).toEqual({ x: 2000, y: 1000 });
    const vis = visibleDocRect(v);
    expect(vis.x0).toBeLessThanOrEqual(0);
    expect(vis.x1).toBeGreaterThanOrEqual(4000);
  });

  it('steps through the zoom stops in both directions', () => {
    expect(nextZoomStop(1, 1)).toBe(2);
    expect(nextZoomStop(1, -1)).toBeCloseTo(0.6667);
    expect(nextZoomStop(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it('reports a visible rect that contains the viewport corners', () => {
    const v = { ...view(), zoom: 0.5, rotation: 0.3 };
    const r = visibleDocRect(v);
    for (const [sx, sy] of [
      [0, 0],
      [800, 0],
      [0, 600],
      [800, 600],
    ] as const) {
      const p = docPointAtScreen(v, sx, sy);
      expect(p.x).toBeGreaterThanOrEqual(r.x0 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(r.x1 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(r.y0 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(r.y1 + 1e-6);
    }
  });
});

describe('matrix helpers', () => {
  it('inverts to the identity', () => {
    const m = { a: 2, b: 0.5, c: -0.25, d: 3, e: 17, f: -9 };
    const id = matMul(m, matInvert(m));
    expect(id.a).toBeCloseTo(1, 9);
    expect(id.d).toBeCloseTo(1, 9);
    expect(id.b).toBeCloseTo(0, 9);
    expect(id.c).toBeCloseTo(0, 9);
    expect(id.e).toBeCloseTo(0, 9);
    expect(id.f).toBeCloseTo(0, 9);
  });

  it('composes right-to-left', () => {
    const t = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 };
    const s = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    // matMul(s, t) must scale AFTER translating.
    expect(matApply(matMul(s, t), 0, 0).x).toBe(20);
    expect(matApply(matMul(t, s), 0, 0).x).toBe(10);
  });

  it('leaves points unchanged under the identity', () => {
    expect(matApply(IDENTITY, 3, 4)).toEqual({ x: 3, y: 4 });
  });
});
