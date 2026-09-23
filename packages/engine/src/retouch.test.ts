import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import type { Dab } from '@umbra/kernels/brush';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { DEFAULT_RETOUCH, RetouchStroke, dodgeBurn, readPixel, recolor, type RetouchOptions, type RetouchToolId } from './retouch.js';

const W = 64;
const H = 32;
function plane(f: (x: number, y: number) => [number, number, number, number]): Plane {
  const w = Plane.empty(RGBA8).writer();
  const d = w.mutable(0, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y).map((v) => Math.round(v * 255)), (y * TILE_SIZE + x) * 4);
  return w.commit();
}
const px = (p: Plane, x: number, y: number) => Array.from(readPixel(p, x, y, new Float32Array(4))).map((v) => Math.round(v * 255));
const dab = (x: number, y: number, radius = 6): Dab => ({ x, y, radius, hardness: 1, angle: 0, roundness: 1, flow: 1 });
const disc = (d: Dab) => (x: number, y: number) => (Math.hypot(x - d.x, y - d.y) <= d.radius ? d.flow : 0);

function run(tool: RetouchToolId, orig: Plane, dabs: Dab[], over: Partial<RetouchOptions> = {}, extra: Partial<ConstructorParameters<typeof RetouchStroke>[0]> = {}) {
  const stroke = Plane.empty(RGBA8).writer();
  const layer = orig.writer();
  const r = new RetouchStroke({ tool, options: { ...DEFAULT_RETOUCH, ...over }, width: W, height: H, orig, stroke, layer, fg: [1, 0, 0], bg: [1, 1, 1], flow: 1, seed: 1, ...extra });
  for (const d of dabs) r.dab(d, disc(d));
  return { r, stroke: stroke.commit(), layer: layer.commit() };
}

describe('retouching', () => {
  it('Clone Stamp deposits the source through the map', () => {
    const orig = plane((x) => (x < 32 ? [0, 0, 1, 1] : [1, 1, 0, 1]));
    const src = (x: number, y: number, out: Float32Array) => readPixel(orig, Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y)), out);
    // Paint at x = 48 with the source 40 px to the left (the blue half).
    const { r, stroke } = run('cloneStamp', orig, [dab(48, 16)], {}, { source: src, map: (x, y) => ({ x: x - 40, y }) });
    expect(r.family).toBe('stroke');
    expect(px(stroke, 48, 16)).toEqual([0, 0, 255, 255]);
    expect(px(stroke, 48, 2)[3]).toBe(0);
  });

  it('Dodge brightens midtones from the stroke-start pixels, and does not keep building in one stroke', () => {
    const orig = plane(() => [0.4, 0.4, 0.4, 1]);
    const once = run('dodgeTool', orig, [dab(20, 16)], { exposure: 0.5, protectTones: false }).layer;
    const twice = run('dodgeTool', orig, [dab(20, 16), dab(20, 16)], { exposure: 0.5, protectTones: false }).layer;
    const v = Math.round(Math.pow(0.4, 1 / 1.5) * 255);
    expect(px(once, 20, 16)[0]).toBe(v);
    expect(px(twice, 20, 16)[0]).toBe(v);
    expect(px(once, 50, 16)[0]).toBe(102);
    expect(dodgeBurn(0.5, false, 'midtones', 1)).toBeCloseTo(0.25, 6);
  });

  it('Sponge desaturates; Protect Tones keeps the hue while dodging', () => {
    const orig = plane(() => [0.8, 0.2, 0.2, 1]);
    const d = run('spongeTool', orig, [dab(20, 16)], { spongeMode: 'desaturate', vibrance: false }).layer;
    const p = px(d, 20, 16);
    expect(p[0]! - p[1]!).toBeLessThan(255 * 0.6 - 10);
    const dark = plane(() => [0.4, 0.1, 0.1, 1]);
    const dodged = run('dodgeTool', dark, [dab(20, 16)], { exposure: 0.5, protectTones: true, range: 'midtones' }).layer;
    const q = px(dodged, 20, 16);
    expect(q[1]).toBe(q[2]);
    expect(q[0]! / q[1]!).toBeCloseTo(4, 0);
  });

  it('Blur softens an edge; Sharpen steepens it without overshooting (Protect Detail)', () => {
    const orig = plane((x) => (x < 32 ? [0, 0, 0, 1] : [1, 1, 1, 1]));
    const b = run('blurTool', orig, [dab(32, 16, 8)], { strength: 1 }).layer;
    const v = px(b, 32, 16)[0]!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(255);
    const soft = plane((x) => [Math.min(1, Math.max(0, (x - 28) / 8)), 0, 0, 1]);
    const s = run('sharpenTool', soft, [dab(32, 16, 8)], { strength: 1, protectDetail: true }).layer;
    for (let x = 25; x < 40; x++) {
      expect(px(s, x, 16)[0]).toBeGreaterThanOrEqual(0);
      expect(px(s, x, 16)[0]).toBeLessThanOrEqual(255);
    }
    expect(px(s, 30, 16)[0]).toBeLessThanOrEqual(px(soft, 30, 16)[0]!);
    expect(px(s, 34, 16)[0]).toBeGreaterThanOrEqual(px(soft, 34, 16)[0]!);
  });

  it('Colour Replacement recolours only the contiguous matching colour; Background Eraser clears it', () => {
    // Blue on the left, a green stripe, and blue again past it.
    const orig = plane((x) => (x >= 20 && x < 24 ? [0, 1, 0, 1] : [0.2, 0.3, 0.9, 1]));
    const { r, stroke } = run('colorReplacement', orig, [dab(14, 16, 16)], { limits: 'contiguous', tolerance: 0.1, antiAlias: false, replaceMode: 'color' });
    expect(r.mode).toBe('normal');
    const hit = px(stroke, 10, 16);
    expect(hit[3]).toBe(255);
    expect(hit[0]).toBeGreaterThan(hit[2]!);
    expect(px(stroke, 21, 16)[3]).toBe(0);
    expect(px(stroke, 26, 16)[3]).toBe(0);
    const any = run('colorReplacement', orig, [dab(14, 16, 16)], { limits: 'discontiguous', tolerance: 0.1, antiAlias: false }).stroke;
    expect(px(any, 26, 16)[3]).toBe(255);
    const e = run('backgroundEraser', orig, [dab(14, 16, 16)], { limits: 'contiguous', tolerance: 0.1, antiAlias: false });
    expect(e.r.mode).toBe('clear');
    expect(px(e.stroke, 10, 16)[3]).toBe(255);
    expect(recolor([0.5, 0.5, 0.5], [1, 0, 0], 'hue')).toEqual([0.5, 0.5, 0.5]);
  });

  it('Smudge drags colour along the stroke', () => {
    const orig = plane((x) => (x < 20 ? [1, 0, 0, 1] : [1, 1, 1, 1]));
    const dabs = [10, 14, 18, 22, 26, 30].map((x) => dab(x, 16, 5));
    const { layer } = run('smudgeTool', orig, dabs, { strength: 0.9 });
    expect(px(layer, 26, 16)[1]).toBeLessThan(200);
    expect(px(layer, 40, 16)[1]).toBe(255);
  });

  it('Pattern Stamp tiles the pattern from the document origin when aligned', () => {
    const data = new Uint8Array(2 * 2 * 4);
    data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const orig = plane(() => [0, 0, 0, 0]);
    const { stroke } = run('patternStamp', orig, [dab(20, 16)], { aligned: true }, { pattern: { width: 2, height: 2, data } });
    expect(px(stroke, 20, 16)).toEqual([255, 0, 0, 255]);
    expect(px(stroke, 21, 16)).toEqual([0, 255, 0, 255]);
    expect(px(stroke, 20, 17)).toEqual([0, 0, 255, 255]);
  });
});
