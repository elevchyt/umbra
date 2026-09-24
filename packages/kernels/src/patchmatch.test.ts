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

  it('Mirror and Rotation Adaptation find sources a plain shift cannot', () => {
    // Around the hole a sawtooth rises left to right, tooth by tooth; the only place to sample
    // from holds the teeth falling (a mirror image), or rising top to bottom (a quarter turn).
    // Neither a smooth fill nor a shifted copy can make rising teeth from those.
    const W = 200;
    const H = 120;
    const tooth = (t: number) => 0.2 + 0.6 * ((((t / 16) % 1) + 1) % 1);
    const rising = (x: number) => tooth(x);
    const run = (source: (x: number, y: number) => number, opts: Parameters<typeof inpaint>[4]) => {
      const img = new Float32Array(W * H * 3);
      const hole = new Uint8Array(W * H);
      const allowed = new Uint8Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const v = x < 80 ? source(x, y) : rising(x);
          img.fill(v, i * 3, i * 3 + 3);
          if (x >= 110 && x < 140 && y >= 44 && y < 76) hole[i] = 1;
          if (x < 76) allowed[i] = 1;
        }
      const out = inpaint(img, W, H, hole, { seed: 3, allowed, ...opts });
      let err = 0;
      let n = 0;
      for (let y = 44; y < 76; y++)
        for (let x = 110; x < 140; x++) {
          err += Math.abs(out[(y * W + x) * 3]! - rising(x));
          n++;
        }
      return err / n;
    };
    const mirrored = (x: number) => tooth(-x);
    expect(run(mirrored, { mirror: true })).toBeLessThan(run(mirrored, {}) * 0.5);
    const turned = (_x: number, y: number) => tooth(y);
    expect(run(turned, { rotation: Math.PI })).toBeLessThan(run(turned, {}) * 0.5);
  });
});
