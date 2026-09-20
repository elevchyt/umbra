import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRUSH,
  beginStroke,
  dabCoverage,
  strokeTo,
  type BrushParams,
  type Dab,
} from './brush.js';

const params = (over: Partial<BrushParams> = {}): BrushParams => ({
  ...DEFAULT_BRUSH,
  smoothing: 0,
  ...over,
});

function run(p: BrushParams, points: [number, number, number?][]): Dab[] {
  const s = beginStroke(p);
  const out: Dab[] = [];
  points.forEach(([x, y, t], i) => {
    out.push(...strokeTo(s, { x, y, pressure: 0.5, time: t ?? i * 16 }));
  });
  return out;
}

describe('stroke spacing', () => {
  it('stamps once at the start', () => {
    const dabs = run(params(), [[0, 0]]);
    expect(dabs).toHaveLength(1);
    expect(dabs[0]!.x).toBe(0);
  });

  it('places dabs one spacing apart along the path', () => {
    // size 100, spacing 0.25 → a dab every 25 px. 0→100 gives four after the initial one.
    const dabs = run(params({ size: 100, spacing: 0.25 }), [
      [0, 0],
      [100, 0],
    ]);
    expect(dabs).toHaveLength(5);
    expect(dabs.map((d) => Math.round(d.x))).toEqual([0, 25, 50, 75, 100]);
  });

  it('carries leftover distance across samples instead of restarting', () => {
    // Ten 10px steps with 25px spacing must give the same dabs as one 100px step would:
    // spacing that restarted per sample would give none at all.
    const p = params({ size: 100, spacing: 0.25 });
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([i * 10, 0]);
    const dabs = run(p, pts);
    expect(dabs.map((d) => Math.round(d.x))).toEqual([0, 25, 50, 75, 100]);
  });

  it('a movement shorter than the spacing produces nothing', () => {
    const dabs = run(params({ size: 100, spacing: 0.25 }), [
      [0, 0],
      [5, 0],
    ]);
    expect(dabs).toHaveLength(1);
  });
});

describe('smoothing', () => {
  it('lags the pointer and never overshoots it', () => {
    const s = beginStroke(params({ size: 10, spacing: 0.1, smoothing: 0.8 }));
    strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 0 });
    strokeTo(s, { x: 100, y: 0, pressure: 0.5, time: 16 });
    expect(s.brush!.x).toBeGreaterThan(0);
    expect(s.brush!.x).toBeLessThan(100);
  });

  it('with smoothing off the brush tracks the pointer exactly', () => {
    const s = beginStroke(params({ smoothing: 0 }));
    strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 0 });
    strokeTo(s, { x: 40, y: 30, pressure: 0.5, time: 16 });
    expect(s.brush).toEqual({ x: 40, y: 30 });
  });
});

describe('pressure', () => {
  it('scales the dab size when mapped to size', () => {
    const s = beginStroke(params({ size: 100, pressureSize: true }));
    const [dab] = strokeTo(s, { x: 0, y: 0, pressure: 0.25, time: 0 });
    expect(dab!.radius).toBeCloseTo(12.5);
  });

  it('leaves size alone when it is not mapped', () => {
    const s = beginStroke(params({ size: 100, pressureSize: false }));
    const [dab] = strokeTo(s, { x: 0, y: 0, pressure: 0.25, time: 0 });
    expect(dab!.radius).toBeCloseTo(50);
  });

  it('scales flow when mapped to opacity', () => {
    const s = beginStroke(params({ flow: 0.8, pressureOpacity: true }));
    const [dab] = strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 0 });
    expect(dab!.flow).toBeCloseTo(0.4);
  });

  it('interpolates pressure along a segment', () => {
    const s = beginStroke(params({ size: 100, spacing: 0.5, pressureSize: true }));
    strokeTo(s, { x: 0, y: 0, pressure: 0, time: 0 });
    const dabs = strokeTo(s, { x: 100, y: 0, pressure: 1, time: 16 });
    // Dabs at 50 and 100 along a 0→1 pressure ramp.
    expect(dabs).toHaveLength(2);
    expect(dabs[0]!.radius).toBeCloseTo(25, 0);
    expect(dabs[1]!.radius).toBeCloseTo(50, 0);
  });
});

describe('airbrush', () => {
  it('keeps depositing while the pointer is still', () => {
    const s = beginStroke(params({ airbrush: true, airbrushRate: 100 }));
    strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 0 });
    const dabs = strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 100 });
    // 100 dabs/second over 100 ms.
    expect(dabs).toHaveLength(10);
  });

  it('deposits nothing while still when it is off', () => {
    const s = beginStroke(params({ airbrush: false }));
    strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 0 });
    expect(strokeTo(s, { x: 0, y: 0, pressure: 0.5, time: 500 })).toHaveLength(0);
  });
});

describe('dab coverage', () => {
  const dab: Dab = {
    x: 0,
    y: 0,
    radius: 10,
    hardness: 0.5,
    angle: 0,
    roundness: 1,
    flow: 1,
  };

  it('is full inside the hard core and zero outside the rim', () => {
    expect(dabCoverage(dab, 0, 0)).toBe(1);
    expect(dabCoverage(dab, 4, 0)).toBe(1);
    expect(dabCoverage(dab, 11, 0)).toBe(0);
  });

  it('falls off between the core and the rim', () => {
    const mid = dabCoverage(dab, 7.5, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('flow scales the whole dab', () => {
    expect(dabCoverage({ ...dab, flow: 0.25 }, 0, 0)).toBeCloseTo(0.25);
  });

  it('roundness flattens the tip across the angle', () => {
    const flat: Dab = { ...dab, roundness: 0.25 };
    // Wide across the angle axis, narrow across the other.
    expect(dabCoverage(flat, 9, 0)).toBeGreaterThan(0);
    expect(dabCoverage(flat, 0, 9)).toBe(0);
  });

  it('angle rotates the flattened tip', () => {
    const flat: Dab = { ...dab, roundness: 0.25, angle: Math.PI / 2 };
    expect(dabCoverage(flat, 0, 9)).toBeGreaterThan(0);
    expect(dabCoverage(flat, 9, 0)).toBe(0);
  });
});
