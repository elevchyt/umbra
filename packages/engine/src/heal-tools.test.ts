import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { readPixel } from './retouch.js';
import { patchArea, redEye, spotHeal, writeRect } from './heal-tools.js';

const W = 96;
const H = 64;
function plane(f: (x: number, y: number) => [number, number, number, number]): Plane {
  const w = Plane.empty(RGBA8).writer();
  const d = w.mutable(0, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y).map((v) => Math.round(v * 255)), (y * TILE_SIZE + x) * 4);
  return w.commit();
}
const px = (p: Plane, x: number, y: number) => Array.from(readPixel(p, x, y, new Float32Array(4))).map((v) => Math.round(v * 255));
const all = { x0: 0, y0: 0, x1: W, y1: H };
function discCover(cx: number, cy: number, r: number): Float32Array {
  const c = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - cx, y - cy) <= r) c[y * W + x] = 1;
  return c;
}

describe('heal tools', () => {
  it('Spot Healing removes a blemish from a flat gradient (all three types)', () => {
    // A horizontal ramp with a black dot at (48, 32).
    const orig = plane((x, y) => (Math.hypot(x - 48, y - 32) <= 4 ? [0, 0, 0, 1] : [x / W, 0.5, 0.5, 1]));
    for (const type of ['contentAware', 'createTexture', 'proximityMatch'] as const) {
      const { rgb, weight } = spotHeal(orig, all, discCover(48, 32, 5), type);
      const out = writeRect(orig, all, rgb, weight);
      const [r, g] = px(out, 48, 32);
      // The dot is gone: close to the ramp's value there, not black.
      expect(Math.abs(r! - 128)).toBeLessThan(40);
      expect(Math.abs(g! - 128)).toBeLessThan(25);
      // Far away, nothing changed.
      expect(px(out, 5, 5)).toEqual(px(orig, 5, 5));
    }
  });

  it('Patch (Normal) heals texture from the source into the selection', () => {
    // Left half: stripes; right half: flat grey with a red square to patch out.
    const orig = plane((x, y) => (x >= 60 && x < 70 && y >= 28 && y < 38 ? [1, 0, 0, 1] : x < 48 ? (y % 4 < 2 ? [0.3, 0.3, 0.3, 1] : [0.7, 0.7, 0.7, 1]) : [0.5, 0.5, 0.5, 1]));
    const mask = new Float32Array(W * H);
    for (let y = 26; y < 40; y++) for (let x = 58; x < 72; x++) mask[y * W + x] = 1;
    // Source mode: the selection takes the pixels 40 px to the left (the stripes).
    const { rgb, weight } = patchArea(orig, all, mask, { dx: -40, dy: 0 }, false);
    const out = writeRect(orig, all, rgb, weight);
    const a = px(out, 65, 32);
    const b = px(out, 65, 34);
    // The red is gone and the stripes' texture arrived (adjacent rows differ).
    expect(a[0]! - a[1]!).toBeLessThan(20);
    expect(Math.abs(a[0]! - b[0]!)).toBeGreaterThan(40);
  });

  it('Patch adapts the source to the destination tone (not a plain copy)', () => {
    // Dark on the left, light on the right; patch a left area from the right.
    const orig = plane((x) => (x < 48 ? [0.2, 0.2, 0.2, 1] : [0.8, 0.8, 0.8, 1]));
    const mask = new Float32Array(W * H);
    for (let y = 20; y < 44; y++) for (let x = 12; x < 36; x++) mask[y * W + x] = 1;
    const { rgb, weight } = patchArea(orig, all, mask, { dx: 48, dy: 0 }, false);
    const out = writeRect(orig, all, rgb, weight);
    expect(Math.abs(px(out, 24, 32)[0]! - 51)).toBeLessThan(6);
  });

  it('Red Eye darkens and desaturates only the pupil', () => {
    const orig = plane((x, y) => (Math.hypot(x - 30, y - 30) <= 5 ? [0.9, 0.1, 0.1, 1] : [0.8, 0.7, 0.6, 1]));
    const out = redEye(orig, 30, 30, W, H, 0.5, 0.5)!;
    expect(out).not.toBeNull();
    const [r, g, b] = px(out, 30, 30);
    expect(r).toBeLessThan(40);
    expect(Math.abs(r! - g!)).toBeLessThan(10);
    expect(b).toBeLessThan(40);
    expect(px(out, 45, 30)).toEqual(px(orig, 45, 30));
    // No red under the click: nothing to do.
    expect(redEye(orig, 70, 50, W, H, 0.5, 0.5)).toBeNull();
  });
});
