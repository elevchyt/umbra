import { describe, expect, it } from 'vitest';
import { beginStroke, strokeTo, DEFAULT_BRUSH, type BrushParams } from '../brush.js';
import { DEFAULT_AIRBRUSH, DEFAULT_BRISTLE, DEFAULT_ERODIBLE } from './model.js';
import { PHYSICAL_LEVELS, physicalTip, physicalTipId, type PhysicalTip } from './physical.js';

const cover = (t: PhysicalTip, v: number) => physicalTip(physicalTipId(t, v))!.data.reduce((a, x) => a + x, 0);
const at = (t: PhysicalTip, v: number, u: number, w: number) => physicalTip(physicalTipId(t, v))!.data[Math.round(w) * 256 + Math.round(u)]!;

describe('physical tips', () => {
  it('bristles: pressing harder puts more bristles on the paper; a point starts at its centre', () => {
    const t = { ...DEFAULT_BRISTLE, shape: 'roundPoint' as const };
    expect(cover(t, 3)).toBeGreaterThan(cover(t, 0));
    expect(cover(t, PHYSICAL_LEVELS - 1)).toBeGreaterThan(cover(t, 3));
    const light = physicalTip(physicalTipId(t, 0))!.data;
    let inner = 0;
    let outer = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const r = Math.hypot(x - 128, y - 128) / (256 / 2.9);
        if (r < 0.3) inner += light[y * 256 + x]!;
        else if (r > 0.6) outer += light[y * 256 + x]!;
      }
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBe(0);
    // A blunt brush has (almost) all its bristles down at once.
    const blunt = { ...t, shape: 'roundBlunt' as const };
    expect(cover(blunt, 0)).toBeGreaterThan(cover(t, 0) * 2);
    // More bristles, more paint; a flat brush is wider than thick.
    expect(cover({ ...t, bristles: 0.9 }, 7)).toBeGreaterThan(cover({ ...t, bristles: 0.1 }, 7));
    const flat = physicalTip(physicalTipId({ ...t, shape: 'flatBlunt', bristles: 0.8 }, 7))!.data;
    let x0 = 256, x1 = 0, y0 = 256, y1 = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        if (flat[y * 256 + x]! > 0) [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    const wide = x1 - x0;
    const tall = y1 - y0;
    expect(wide).toBeGreaterThan(tall * 2);
  });

  it('erodible: a point broadens as it wears, and strokes carry the wear', () => {
    const t = { ...DEFAULT_ERODIBLE, shape: 'point' as const, hardness: 0.2 };
    expect(cover(t, PHYSICAL_LEVELS - 1)).toBeGreaterThan(cover(t, 0) * 3);
    // Square and triangle leads have their shape: a corner of the box is covered by one, not the other.
    expect(at({ ...t, shape: 'square' }, 0, 45, 45)).toBeGreaterThan(150);
    expect(at({ ...t, shape: 'triangle' }, 0, 45, 45)).toBe(0);
    const params: BrushParams = { ...DEFAULT_BRUSH, size: 20, spacing: 0.05, smoothing: 0, tip: t };
    const s = beginStroke(params, { wear: 0.1 });
    const dabs = [0, 400].flatMap((x) => strokeTo(s, { x, y: 0, pressure: 1, time: x, tiltX: 0, tiltY: 0, twist: 0 }));
    expect(s.wear).toBeGreaterThan(0.1);
    expect(dabs[0]!.tip).toMatch(/^phys:/);
    expect(dabs.at(-1)!.tip).not.toBe(dabs[0]!.tip);
    // A hard lead does not wear.
    const hard = beginStroke({ ...params, tip: { ...t, hardness: 1 } });
    strokeTo(hard, { x: 0, y: 0, pressure: 1, time: 0, tiltX: 0, tiltY: 0, twist: 0 });
    strokeTo(hard, { x: 400, y: 0, pressure: 1, time: 1, tiltX: 0, tiltY: 0, twist: 0 });
    expect(hard.wear).toBe(0);
  });

  it('airbrush: grain turns density into droplets, variants differ, spatter flies past the edge', () => {
    const smooth = { ...DEFAULT_AIRBRUSH, granularity: 0, spatterAmount: 1, spatterSize: 0 };
    const grainy = { ...smooth, granularity: 1 };
    const mid = (t: PhysicalTip) => physicalTip(physicalTipId(t, 0))!.data.slice(128 * 256 + 100, 128 * 256 + 156);
    const distinct = (a: Uint8Array) => new Set(a).size;
    // Granular: pixels are either paint or none.
    expect([...mid(grainy)].every((v) => v === 0 || v === 255)).toBe(true);
    expect(distinct(mid(smooth))).toBeGreaterThan(5);
    const a = physicalTip(physicalTipId(grainy, 1))!.data;
    const b = physicalTip(physicalTipId(grainy, 2))!.data;
    expect(a.some((v, i) => v !== b[i])).toBe(true);
    // Heavy spatter reaches outside the spray's disc (radius 1 of 1.25).
    const spatter = physicalTip(physicalTipId({ ...smooth, spatterAmount: 200, spatterSize: 0.3 }, 0))!.data;
    let outside = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (Math.hypot(x - 128, y - 128) > 108 && spatter[y * 256 + x]! > 0) outside++;
    expect(outside).toBeGreaterThan(0);
  });
});
