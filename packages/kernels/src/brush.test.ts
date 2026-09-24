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

// ---- Brush Settings (M8) -------------------------------------------------------------------
import {
  DEFAULT_COLOR_DYNAMICS,
  DEFAULT_DUAL,
  DEFAULT_SCATTERING,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_TEXTURE,
  NO_DYNAMIC,
  catchUp,
  dabAlpha,
  finishStroke,
  renderDabs,
  wetEdges,
  symmetryMaps,
  symmetryCurve,
  symmetryMirror,
  symmetryPlacement,
} from './brush.js';

function line(p: BrushParams, n = 20, opts = {}): Dab[] {
  const s = beginStroke(p, opts);
  const out: Dab[] = [];
  for (let i = 0; i <= n; i++) out.push(...strokeTo(s, { x: i * 10, y: 0, pressure: 1 - i / (n * 2), time: i * 16, tiltX: 0, tiltY: 0, twist: i * 5 }));
  return out;
}

describe('dynamics', () => {
  const base = params({ size: 40, spacing: 0.25, pressureSize: false });

  it('is deterministic per seed, and jitter varies with it', () => {
    const p = { ...base, seed: 7, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, jitter: 0.8 } } };
    expect(line(p)).toEqual(line(p));
    expect(line({ ...p, seed: 8 }).map((d) => d.radius)).not.toEqual(line(p).map((d) => d.radius));
    for (const d of line(p)) {
      expect(d.radius).toBeLessThanOrEqual(20 + 1e-9);
      expect(d.radius).toBeGreaterThanOrEqual(20 * 0.2 - 1e-9);
    }
  });

  it('size follows pressure and fades over its steps down to the minimum diameter', () => {
    const press = line({ ...base, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, control: 'pressure' } } });
    expect(press[press.length - 1]!.radius).toBeLessThan(press[1]!.radius);
    const fade = line({ ...base, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, minDiameter: 0.25, size: { ...NO_DYNAMIC, control: 'fade', fadeSteps: 10 } } }, 40);
    expect(fade[0]!.radius).toBeCloseTo(20, 6);
    expect(fade[fade.length - 1]!.radius).toBeCloseTo(5, 6);
  });

  it('the angle can follow the direction of travel', () => {
    const s = beginStroke({ ...base, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, angle: { ...NO_DYNAMIC, control: 'direction' } } });
    strokeTo(s, { x: 0, y: 0, pressure: 1, time: 0 });
    const dabs = strokeTo(s, { x: 0, y: 100, pressure: 1, time: 16 });
    expect(dabs[0]!.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('scattering spreads dabs across the path; count multiplies them', () => {
    const plain = line(base);
    const scattered = line({ ...base, seed: 3, scattering: { ...DEFAULT_SCATTERING, enabled: true, scatter: { ...NO_DYNAMIC, jitter: 1 }, count: 3 } });
    expect(scattered.length).toBe(plain.length * 3);
    const ys = scattered.map((d) => d.y);
    expect(Math.max(...ys.map(Math.abs))).toBeGreaterThan(5);
    for (const y of ys) expect(Math.abs(y)).toBeLessThanOrEqual(40);
  });

  it('colour dynamics mix foreground to background and jitter hue', () => {
    const fg: [number, number, number] = [1, 0, 0];
    const bg: [number, number, number] = [0, 0, 1];
    const full = line({ ...base, colorDynamics: { ...DEFAULT_COLOR_DYNAMICS, enabled: true, fgBg: { ...NO_DYNAMIC, jitter: 1 } } }, 20, { fg, bg });
    const reds = full.map((d) => d.color![0]);
    expect(Math.min(...reds)).toBeLessThan(0.5);
    expect(Math.max(...reds)).toBeGreaterThan(0.5);
    const once = line({ ...base, colorDynamics: { ...DEFAULT_COLOR_DYNAMICS, enabled: true, eachTip: false, hue: 1 } }, 20, { fg, bg });
    expect(new Set(once.map((d) => d.color!.join()))).toHaveProperty('size', 1);
  });

  it('transfer lowers flow down to its minimum', () => {
    const t = line({ ...base, transfer: { enabled: true, opacity: NO_DYNAMIC, flow: { ...NO_DYNAMIC, control: 'pressure', minimum: 0.4 } } });
    expect(t[t.length - 1]!.flow).toBeLessThan(t[0]!.flow);
    for (const d of t) expect(d.flow).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });

  it('symmetry mirrors each dab; radial repeats it round the centre', () => {
    const v = line({ ...base, symmetry: { mode: 'vertical', segments: 2, cx: 100, cy: 50, angle: 0 } }, 2);
    expect(v.length % 2).toBe(0);
    expect(v[1]!.x).toBeCloseTo(200 - v[0]!.x, 6);
    expect(v[1]!.y).toBeCloseTo(v[0]!.y, 6);
    expect(symmetryMaps({ mode: 'radial', segments: 6, cx: 0, cy: 0, angle: 0 })).toHaveLength(6);
    expect(symmetryMaps({ mode: 'mandala', segments: 5, cx: 0, cy: 0, angle: 0 })).toHaveLength(10);
    const r = line({ ...base, symmetry: { mode: 'radial', segments: 4, cx: 0, cy: 0, angle: 0 } }, 0);
    expect(r.map((d) => [Math.round(d.x), Math.round(d.y)])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it('the curved and parallel symmetries mirror across their figure', () => {
    const sym = (over: Partial<import('./brush.js').Symmetry> & { mode: import('./brush.js').SymmetryMode }) => ({ segments: 2, cx: 0, cy: 0, angle: 0, ...over });
    const pairs = (d: Dab[], k = 2) => Array.from({ length: d.length / k }, (_, i) => d.slice(i * k, i * k + k));
    // Parallel Lines 40 apart: y = 0 reflects across y = ±20, to ±40.
    for (const [o, a, b] of pairs(line({ ...base, symmetry: sym({ mode: 'parallelLines', size: 40 }) }), 3) as Dab[][]) {
      expect(a!.x).toBeCloseTo(o!.x, 6);
      expect(a!.y).toBeCloseTo(40, 6);
      expect(b!.y).toBeCloseTo(-40, 6);
    }
    // Circle, Wavy, Spiral and Path: every mirrored dab (the gap fillers too) mirrors back onto
    // the stroke, which runs along y = 0 — and each figure is where it should be.
    const path = [{ points: [{ x: 100, y: -500 }, { x: 100, y: 500 }], closed: false }];
    const cases = [
      // Big enough that the whole stroke is within 2R (past that a mirror crosses the centre).
      sym({ mode: 'circle', size: 120, cx: 100, cy: 100 }),
      sym({ mode: 'wavy', size: 200 }),
      sym({ mode: 'spiral', size: 50, cx: 100, cy: 20 }),
      sym({ mode: 'path', path }),
    ];
    for (const sy of cases) {
      const out = line({ ...base, symmetry: sy });
      // The source dabs are the same stroke's without symmetry, in order; the rest are mirrors.
      const src = line(base);
      let j = 0;
      const mirrors = out.filter((d) => {
        if (j < src.length && d.x === src[j]!.x && d.y === src[j]!.y) return (j++, false);
        return true;
      });
      expect(j, sy.mode).toBe(src.length);
      expect(mirrors.length, sy.mode).toBeGreaterThan(0);
      for (const m of mirrors) {
        const back = symmetryMirror(sy, m.x, m.y)!;
        expect(Math.abs(back.y), `${sy.mode} ${m.x},${m.y}`).toBeLessThan(0.01);
      }
    }
    // Circle: a point r from the centre lands |2R − r| from it, on the same ray.
    const cm = symmetryMirror(cases[0]!, 100, 0)!;
    expect(cm.x).toBeCloseTo(100, 6);
    expect(cm.y).toBeCloseTo(100 - 140, 6);
    // Wavy, 200 px waves 40 high: the crest over x = 50 sends y = 0 up to y = 80.
    expect(symmetryMirror(cases[1]!, 50, 0)!.y).toBeCloseTo(80, 6);
    // A path that is a vertical line through x = 100 is Vertical symmetry.
    expect(symmetryMirror(cases[3]!, 30, 7)).toEqual({ x: 170, y: 7 });
    // Spiral: on the dab's own ray, and the midpoint on the spiral (r = b·θ).
    const sm = symmetryMirror(cases[2]!, 180, 20)!;
    expect(sm.y).toBeCloseTo(20, 6);
    const mid = ((180 - 100) + (sm.x - 100)) / 2;
    expect((mid / (50 / (2 * Math.PI))) % (2 * Math.PI)).toBeCloseTo(0, 6);
  });

  it('a transformed symmetry path mirrors in its own frame', () => {
    const one = (sym: import('./brush.js').Symmetry, x: number, y: number) => {
      const s = beginStroke({ ...base, spacing: 10, symmetry: sym });
      const d = strokeTo(s, { x, y, pressure: 1, time: 0, tiltX: 0, tiltY: 0, twist: 0 });
      return d.slice(1).map((m) => [Math.round(m.x * 1000) / 1000, Math.round(m.y * 1000) / 1000]);
    };
    const at = { segments: 2, cx: 100, cy: 50, angle: 0 };
    // A uniform scale does not move a line: Vertical is Vertical.
    expect(one({ ...at, mode: 'vertical', transform: { scaleX: 2, scaleY: 2, skew: 0 } }, 130, 70)).toEqual([[70, 70]]);
    // A circle of radius 50 stretched to twice the width: across the ellipse's side at x + 100.
    expect(one({ ...at, mode: 'circle', size: 50, transform: { scaleX: 2, scaleY: 1, skew: 0 } }, 250, 50)).toEqual([[150, 50]]);
    // Horizontal, skewed 45°: the axis stays put, the mirror goes along the skew — (x, y)
    // about the centre lands at (x − 2y, −y).
    expect(one({ ...at, mode: 'horizontal', transform: { scaleX: 1, scaleY: 1, skew: 45 } }, 100 + 30, 50 + 10)).toEqual([[100 + 10, 50 - 10]]);
    // The placement maps the figure to the document and back.
    const place = symmetryPlacement({ ...at, mode: 'circle', size: 50, angle: 30, transform: { scaleX: 1.5, scaleY: 0.5, skew: 20 } })!;
    const q = place.toFigure(place.toDoc(7, -3).x, place.toDoc(7, -3).y);
    expect(q.x).toBeCloseTo(7, 9);
    expect(q.y).toBeCloseTo(-3, 9);
  });

  it('pulled string waits inside its leash; catch-up on end finishes the line', () => {
    const p = { ...base, smoothing: 0.5, smoothingOptions: { pulledString: true, catchUp: false, catchUpOnEnd: true, adjustForZoom: false } };
    const s = beginStroke(p);
    strokeTo(s, { x: 0, y: 0, pressure: 1, time: 0 });
    expect(strokeTo(s, { x: 20, y: 0, pressure: 1, time: 16 })).toHaveLength(0);
    const moved = strokeTo(s, { x: 100, y: 0, pressure: 1, time: 32 });
    expect(Math.max(...moved.map((d) => d.x))).toBeLessThanOrEqual(70 + 1e-9);
    const end = finishStroke(s);
    expect(Math.max(...end.map((d) => d.x))).toBeGreaterThan(90);
    const c = beginStroke({ ...base, smoothing: 0.8, smoothingOptions: { pulledString: false, catchUp: true, catchUpOnEnd: false, adjustForZoom: false } });
    strokeTo(c, { x: 0, y: 0, pressure: 1, time: 0 });
    strokeTo(c, { x: 200, y: 0, pressure: 1, time: 16 });
    let caught = 0;
    for (let i = 0; i < 40; i++) caught += catchUp(c).length;
    expect(caught).toBeGreaterThan(5);
    expect(c.brush!.x).toBeGreaterThan(190);
  });

  it('the dual brush stamps over the primary dabs', () => {
    const d = line({ ...base, dual: { ...DEFAULT_DUAL, enabled: true, size: 10, spacing: 0.5, scatter: 0.5 } });
    expect(d.every((x) => x.dual && x.dual.length > 0)).toBe(true);
  });
});

describe('dab coverage', () => {
  const dab = (over: Partial<Dab> = {}): Dab => ({ x: 20, y: 20, radius: 10, hardness: 1, angle: 0, roundness: 1, flow: 1, ...over });

  it('a sampled tip draws its bitmap, flipped and turned', () => {
    // A tip lit only in its left half.
    const data = new Uint8Array(16 * 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) data[y * 16 + x] = 255;
    const tips = () => ({ width: 16, height: 16, data });
    expect(dabAlpha(dab({ tip: 't' }), 14, 20, { tips })).toBeCloseTo(1, 6);
    expect(dabAlpha(dab({ tip: 't' }), 26, 20, { tips })).toBeCloseTo(0, 6);
    expect(dabAlpha(dab({ tip: 't', flipX: true }), 26, 20, { tips })).toBeCloseTo(1, 6);
    expect(dabAlpha(dab({ tip: 't', angle: Math.PI }), 26, 20, { tips })).toBeCloseTo(1, 6);
  });

  it('dual stamps mask the dab; texture cuts into it; wet edges pool at the rim', () => {
    const d = dab({ dual: [{ x: 15, y: 20, radius: 3, angle: 0, roundness: 1, flipX: false, flipY: false }] });
    const ctx = { dual: { hardness: 1, mode: 'multiply' as const } };
    expect(dabAlpha(d, 15, 20, ctx)).toBeCloseTo(1, 6);
    expect(dabAlpha(d, 25, 20, ctx)).toBe(0);
    const lum = new Float32Array([0, 1, 1, 0]);
    const tex = { pattern: { width: 2, height: 2, lum }, scale: 100, invert: false, brightness: 0, contrast: 0, mode: 'multiply' as const };
    expect(dabAlpha(dab({ textureDepth: 1 }), 20.5, 20.5, { texture: tex })).toBe(0);
    expect(dabAlpha(dab({ textureDepth: 0.5 }), 20.5, 20.5, { texture: tex })).toBeCloseTo(0.5, 6);
    expect(wetEdges(1)).toBeCloseTo(0.5, 6);
    expect(wetEdges(0.8)).toBeGreaterThan(0.5);
  });

  it('renders a stroke on the CPU with the stroke buffer rule, never past full', () => {
    const s = beginStroke(params({ size: 20, spacing: 0.1, flow: 0.3, pressureSize: false }));
    const dabs = [...strokeTo(s, { x: 10, y: 20, pressure: 1, time: 0 }), ...strokeTo(s, { x: 90, y: 20, pressure: 1, time: 16 })];
    const cov = renderDabs(dabs, 100, 40);
    expect(Math.max(...cov)).toBeLessThanOrEqual(1);
    expect(cov[20 * 100 + 50]!).toBeGreaterThan(0.9);
    expect(cov[2 * 100 + 50]!).toBe(0);
  });
});
