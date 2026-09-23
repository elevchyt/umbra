import { describe, expect, it } from 'vitest';
import { inpaint } from './patchmatch.js';

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(f(x, y), (y * w + x) * 3);
  return out;
}

describe('content-aware fill', () => {
  it('fills a hole in a flat colour with that colour', () => {
    const w = 60;
    const h = 50;
    const img = image(w, h, () => [0.2, 0.6, 0.4]);
    const hole = new Uint8Array(w * h);
    for (let y = 18; y < 32; y++) for (let x = 22; x < 38; x++) {
      hole[y * w + x] = 1;
      img.set([1, 0, 1], (y * w + x) * 3);
    }
    const out = inpaint(img, w, h, hole);
    const i = (25 * w + 30) * 3;
    expect(out[i]).toBeCloseTo(0.2, 2);
    expect(out[i + 1]).toBeCloseTo(0.6, 2);
  });

  it('continues a stripe texture through the hole', () => {
    const w = 96;
    const h = 64;
    // Vertical stripes, period 8.
    const stripe = (x: number): [number, number, number] => (x % 8 < 4 ? [0.1, 0.1, 0.1] : [0.9, 0.9, 0.9]);
    const img = image(w, h, (x) => stripe(x));
    const truth = Float32Array.from(img);
    const hole = new Uint8Array(w * h);
    for (let y = 24; y < 40; y++) for (let x = 40; x < 56; x++) {
      hole[y * w + x] = 1;
      img.set([0.5, 0.5, 0.5], (y * w + x) * 3);
    }
    const t0 = performance.now();
    const out = inpaint(img, w, h, hole, { seed: 3 });
    const ms = performance.now() - t0;
    let err = 0;
    let n = 0;
    for (let y = 24; y < 40; y++) for (let x = 40; x < 56; x++) {
      err += Math.abs(out[(y * w + x) * 3]! - truth[(y * w + x) * 3]!);
      n++;
    }
    // The stripes come back (the mean error of a grey fill would be 0.4).
    expect(err / n).toBeLessThan(0.08);
    expect(ms).toBeLessThan(3000);
  });

  it('only copies from the allowed area', () => {
    const w = 60;
    const h = 40;
    // Left half red, right half blue; the hole in the blue, sampling only the red.
    const img = image(w, h, (x) => (x < 30 ? [1, 0, 0] : [0, 0, 1]));
    const hole = new Uint8Array(w * h);
    const allowed = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= 40 && x < 52 && y >= 14 && y < 26) hole[y * w + x] = 1;
      if (x < 30) allowed[y * w + x] = 1;
    }
    const out = inpaint(img, w, h, hole, { allowed });
    const i = (20 * w + 46) * 3;
    expect(out[i]).toBeGreaterThan(0.8);
  });
});
