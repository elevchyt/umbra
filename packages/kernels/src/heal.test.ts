import { describe, expect, it } from 'vitest';
import { heal, solveMembrane } from './heal.js';

describe('healing', () => {
  it('the membrane is harmonic: a linear boundary gives the same plane inside', () => {
    const w = 40;
    const h = 30;
    const v = new Float32Array(w * h);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const inside = x > 5 && x < 34 && y > 5 && y < 24;
        m[i] = inside ? 1 : 0;
        v[i] = inside ? 0 : 0.01 * x + 0.02 * y;
      }
    solveMembrane(v, m, w, h, 1, 200);
    expect(v[15 * w + 20]).toBeCloseTo(0.01 * 20 + 0.02 * 15, 3);
  });

  it('a source that differs by a constant heals to the destination exactly', () => {
    const w = 48;
    const h = 40;
    const dest = new Float32Array(w * h * 3);
    const src = new Float32Array(w * h * 3);
    const region = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = [0.2 + 0.005 * x, 0.3 + 0.004 * y, 0.5 + 0.1 * Math.sin(x / 7)];
        dest.set(t, i * 3);
        src.set(t.map((v) => v + 0.25), i * 3);
        region[i] = Math.hypot(x - 24, y - 20) < 12 ? 1 : 0;
      }
    const out = heal(src, dest, region, w, h);
    for (const [x, y] of [[24, 20], [30, 22], [18, 15]]) {
      const i = (y! * w + x!) * 3;
      for (let c = 0; c < 3; c++) expect(Math.abs(out[i + c]! - dest[i + c]!)).toBeLessThan(0.01);
    }
  });
});
