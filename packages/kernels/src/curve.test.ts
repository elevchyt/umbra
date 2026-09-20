import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CURVE,
  composeLuts,
  curveToLut,
  evaluateCurve,
  identityLut,
  isIdentityCurve,
  isIdentityLut,
  levelsLut,
  normaliseCurve,
} from './curve.js';

describe('curve evaluation', () => {
  it('is the identity for the default two points', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evaluateCurve(IDENTITY_CURVE, x)).toBeCloseTo(x, 9);
    }
    expect(isIdentityCurve(IDENTITY_CURVE)).toBe(true);
  });

  it('interpolates two arbitrary points linearly', () => {
    const c = [
      { x: 0, y: 0.2 },
      { x: 1, y: 0.8 },
    ];
    expect(evaluateCurve(c, 0.5)).toBeCloseTo(0.5, 9);
  });

  it('passes exactly through every control point', () => {
    const c = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.5 },
      { x: 0.6, y: 0.4 },
      { x: 1, y: 1 },
    ];
    for (const p of c) expect(evaluateCurve(c, p.x)).toBeCloseTo(p.y, 6);
  });

  it('holds the end values rather than extrapolating', () => {
    const c = [
      { x: 0.25, y: 0.3 },
      { x: 0.75, y: 0.9 },
    ];
    expect(evaluateCurve(c, 0)).toBeCloseTo(0.3, 9);
    expect(evaluateCurve(c, 1)).toBeCloseTo(0.9, 9);
  });

  it('clamps an overshooting spline into range', () => {
    // A hard step makes a natural spline overshoot past 1 between the points.
    const c = [
      { x: 0, y: 0 },
      { x: 0.45, y: 0.05 },
      { x: 0.55, y: 0.95 },
      { x: 1, y: 1 },
    ];
    for (let i = 0; i <= 100; i++) {
      const y = evaluateCurve(c, i / 100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('is monotone for a monotone control set with gentle slopes', () => {
    const c = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.35 },
      { x: 0.7, y: 0.75 },
      { x: 1, y: 1 },
    ];
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = evaluateCurve(c, i / 100);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
});

describe('normaliseCurve', () => {
  it('sorts by input', () => {
    const out = normaliseCurve([
      { x: 0.8, y: 1 },
      { x: 0.1, y: 0 },
    ]);
    expect(out.map((p) => p.x)).toEqual([0.1, 0.8]);
  });

  it('collapses duplicate inputs, keeping the later point', () => {
    const out = normaliseCurve([
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.y).toBe(0.9);
  });

  it('caps at the 16 points Photoshop allows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ x: i / 29, y: i / 29 }));
    expect(normaliseCurve(many)).toHaveLength(16);
  });
});

describe('lookup tables', () => {
  it('bakes the identity curve to the identity table', () => {
    expect(isIdentityLut(curveToLut(IDENTITY_CURVE))).toBe(true);
    expect(isIdentityLut(identityLut())).toBe(true);
  });

  it('agrees with direct evaluation at every entry', () => {
    const c = [
      { x: 0, y: 0.1 },
      { x: 0.3, y: 0.2 },
      { x: 0.7, y: 0.85 },
      { x: 1, y: 0.95 },
    ];
    const lut = curveToLut(c);
    for (let i = 0; i < 256; i += 17) {
      expect(lut[i]).toBe(Math.round(evaluateCurve(c, i / 255) * 255));
    }
  });

  it('composes in application order', () => {
    // a doubles (clipping), b inverts; composeLuts(a, b) must apply a first.
    const a = new Uint8Array(256);
    const b = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      a[i] = Math.min(255, i * 2);
      b[i] = 255 - i;
    }
    const fused = composeLuts(a, b);
    expect(fused[10]).toBe(255 - 20);
    expect(fused[200]).toBe(0);
  });

  it('composing with the identity changes nothing', () => {
    const c = curveToLut([
      { x: 0, y: 0.2 },
      { x: 1, y: 0.9 },
    ]);
    expect([...composeLuts(c, identityLut())]).toEqual([...c]);
    expect([...composeLuts(identityLut(), c)]).toEqual([...c]);
  });
});

describe('levels', () => {
  it('default parameters are the identity', () => {
    expect(isIdentityLut(levelsLut(0, 1, 255))).toBe(true);
  });

  it('clips below the input black point and above the white point', () => {
    const lut = levelsLut(64, 1, 192);
    expect(lut[0]).toBe(0);
    expect(lut[64]).toBe(0);
    expect(lut[192]).toBe(255);
    expect(lut[255]).toBe(255);
  });

  it('stretches the range linearly at gamma 1', () => {
    const lut = levelsLut(64, 1, 192);
    expect(lut[128]).toBe(Math.round(((128 - 64) / 128) * 255));
  });

  it('gamma above 1 lifts the midtones', () => {
    expect(levelsLut(0, 2, 255)[128]!).toBeGreaterThan(128);
  });

  it('gamma below 1 lowers them', () => {
    expect(levelsLut(0, 0.5, 255)[128]!).toBeLessThan(128);
  });

  it('honours the output range', () => {
    const lut = levelsLut(0, 1, 255, 32, 200);
    expect(lut[0]).toBe(32);
    expect(lut[255]).toBe(200);
  });

  it('matches its published definition at every entry', () => {
    // An independent transcription of the formula in spec 05 §A.
    const [iB, gamma, iW, oB, oW] = [32, 1.4, 220, 10, 240];
    const lut = levelsLut(iB, gamma, iW, oB, oW);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - iB) / (iW - iB)));
      expect(lut[v]).toBe(Math.round(oB + (oW - oB) * Math.pow(t, 1 / gamma)));
    }
  });
});
