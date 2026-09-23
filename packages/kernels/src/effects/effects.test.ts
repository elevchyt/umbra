import { describe, expect, it } from 'vitest';
import { blur, edt, signedDistance } from './field.js';
import { CONTOUR_PRESETS, applyContour, contourLut } from './contour.js';
import { DEFAULTS, EMPTY_EFFECTS, effectsReach, hasVisibleEffects, renderEffects, type EffectsInput, type LayerEffects } from './index.js';

const W = 64;
const H = 64;

/** A filled disc of radius r at the centre, anti-aliased. */
function disc(r = 16): Float32Array {
  const s = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) s[y * W + x] = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2)));
  }
  return s;
}

const input = (shape = disc()): EffectsInput => ({ shape, width: W, height: H, originX: 0, originY: 0, docWidth: W, docHeight: H, bounds: { x0: 16, y0: 16, x1: 48, y1: 48 }, light: { angle: 90, altitude: 30 } });
const fx = (over: Partial<LayerEffects>): LayerEffects => ({ ...EMPTY_EFFECTS, ...over });
const alpha = (d: Uint8ClampedArray, x: number, y: number) => d[(y * W + x) * 4 + 3]! / 255;

function centroid(d: Uint8ClampedArray): { x: number; y: number; mass: number } {
  let m = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = alpha(d, x, y);
      m += a;
      sx += a * x;
      sy += a * y;
    }
  }
  return { x: sx / m, y: sy / m, mass: m };
}

describe('field primitives', () => {
  it('the distance transform is exact', () => {
    const seeds = new Set([5, 77, 300, 1111, 2047, 4000]);
    const d = edt((i) => seeds.has(i), W, H);
    for (const i of [0, 64, 999, 2500, 4095]) {
      let best = Infinity;
      for (const s of seeds) best = Math.min(best, Math.hypot((i % W) - (s % W), Math.floor(i / W) - Math.floor(s / W)));
      expect(d[i]).toBeCloseTo(best, 5);
    }
  });

  it('signed distance is the distance to the edge of a disc, negative inside', () => {
    const sd = signedDistance(disc(16), W, H);
    const at = (x: number, y: number) => sd[y * W + x]!;
    // Pixel (32,32)'s centre is 0.71 px from the disc's centre, a pixel corner.
    expect(at(32, 32)).toBeCloseTo(-15.3, 0);
    expect(at(32 + 24, 32)).toBeCloseTo(8.5, 0);
    expect(Math.abs(at(32 + 16, 32))).toBeLessThan(1);
  });

  it('blurs keep the total and spread by about σ', () => {
    const v = new Float32Array(W * H);
    v[32 * W + 32] = 1;
    for (const sigma of [2, 10]) {
      const b = blur(v, W, H, sigma);
      let total = 0;
      let second = 0;
      for (let x = 0; x < W; x++) {
        total += b.subarray(x * W, x * W + W).reduce((s, c) => s + c, 0);
        second += b[32 * W + x]! * (x - 32) ** 2;
      }
      expect(total).toBeCloseTo(1, 3);
      const row = b.subarray(32 * W, 33 * W).reduce((s, c) => s + c, 0);
      expect(Math.sqrt(second / row)).toBeCloseTo(sigma, 0);
    }
  });

  it('contours: Linear is the identity, Cone peaks in the middle', () => {
    const lin = contourLut(CONTOUR_PRESETS[0]!);
    for (const v of [0, 0.25, 0.7, 1]) expect(applyContour(lin, v)).toBeCloseTo(v, 2);
    const cone = contourLut(CONTOUR_PRESETS[1]!);
    expect(applyContour(cone, 0.5)).toBeCloseTo(1, 1);
    expect(applyContour(cone, 0)).toBeCloseTo(0, 2);
    expect(applyContour(cone, 1)).toBeCloseTo(0, 2);
  });
});

describe('effects', () => {
  it('nothing enabled draws nothing', () => {
    expect(hasVisibleEffects(EMPTY_EFFECTS)).toBe(false);
    expect(hasVisibleEffects(fx({ dropShadow: [{ ...DEFAULTS.dropShadow(), enabled: false }] }))).toBe(false);
    const r = renderEffects(EMPTY_EFFECTS, input());
    expect([r.below.length, r.above.length]).toEqual([0, 0]);
  });

  it('a drop shadow falls away from the light, knocked out under the layer', () => {
    const e = { ...DEFAULTS.dropShadow(), distance: 10, size: 4, knockout: false };
    const r = renderEffects(fx({ dropShadow: [e] }), input());
    const c = centroid(r.below[0]!.data);
    // Light from the top (90°) casts it straight down.
    // The disc's centre is the pixel corner (32, 32), so pixel-index centroids sit at 31.5.
    expect(c.x).toBeCloseTo(31.5, 0);
    expect(c.y).toBeCloseTo(41.5, 0);
    const knocked = renderEffects(fx({ dropShadow: [{ ...e, knockout: true }] }), input());
    expect(alpha(knocked.below[0]!.data, 32, 32)).toBe(0);
    // Light from the left (180°) casts it to the right.
    const side = renderEffects(fx({ dropShadow: [{ ...e, useGlobalLight: false, angle: 180 }] }), input());
    expect(centroid(side.below[0]!.data).x).toBeCloseTo(41.5, 0);
  });

  it('spread hardens the shadow edge; size softens it', () => {
    const soft = renderEffects(fx({ dropShadow: [{ ...DEFAULTS.dropShadow(), distance: 0, size: 10, spread: 0, knockout: false }] }), input());
    const hard = renderEffects(fx({ dropShadow: [{ ...DEFAULTS.dropShadow(), distance: 0, size: 10, spread: 100, knockout: false }] }), input());
    // 4 px outside the disc: the soft shadow has faded, the fully spread one is still solid.
    expect(alpha(soft.below[0]!.data, 32 + 20, 32)).toBeLessThan(0.5);
    expect(alpha(hard.below[0]!.data, 32 + 20, 32)).toBe(1);
  });

  it('an inner shadow stays inside, on the side the light comes from', () => {
    const r = renderEffects(fx({ innerShadow: [{ ...DEFAULTS.innerShadow(), distance: 6, size: 3 }] }), input());
    const d = r.above[0]!.data;
    expect(alpha(d, 32, 32 + 22)).toBe(0);
    // Light from the top: the shadow is along the top inner edge.
    expect(alpha(d, 32, 32 - 14)).toBeGreaterThan(alpha(d, 32, 32 + 14) + 0.3);
  });

  it('an outside stroke is a ring of its width, outside the shape', () => {
    const r = renderEffects(fx({ stroke: [{ ...DEFAULTS.stroke(), size: 4, position: 'outside' }] }), input());
    const d = r.above[0]!.data;
    expect(alpha(d, 32, 32)).toBe(0);
    expect(alpha(d, 32 + 18, 32)).toBeCloseTo(1, 1);
    expect(alpha(d, 32 + 22, 32)).toBe(0);
    let area = 0;
    for (let i = 3; i < d.length; i += 4) area += d[i]! / 255;
    // Annulus between r = 16 and r = 20, to within the anti-aliased pixels.
    expect(Math.abs(area / (Math.PI * (20 * 20 - 16 * 16)) - 1)).toBeLessThan(0.025);
  });

  it('inside and centre strokes sit where they say', () => {
    const inside = renderEffects(fx({ stroke: [{ ...DEFAULTS.stroke(), size: 4, position: 'inside' }] }), input()).above[0]!.data;
    expect(alpha(inside, 32 + 14, 32)).toBeCloseTo(1, 1);
    expect(alpha(inside, 32 + 18, 32)).toBe(0);
    const centre = renderEffects(fx({ stroke: [{ ...DEFAULTS.stroke(), size: 4, position: 'center' }] }), input()).above[0]!.data;
    expect(alpha(centre, 32 + 15, 32)).toBeCloseTo(1, 1);
    expect(alpha(centre, 32 + 17, 32)).toBeCloseTo(1, 1);
    expect(alpha(centre, 32 + 20, 32)).toBe(0);
  });

  it('a color overlay covers exactly the shape', () => {
    const s = disc();
    const r = renderEffects(fx({ colorOverlay: [DEFAULTS.colorOverlay()] }), input(s));
    const d = r.above[0]!.data;
    for (let i = 0; i < s.length; i += 97) expect(Math.abs(d[i * 4 + 3]! / 255 - s[i]!)).toBeLessThan(0.01);
    expect([d[(32 * W + 32) * 4], d[(32 * W + 32) * 4 + 1]]).toEqual([255, 0]);
  });

  it('an inner bevel lit from the top is light on the top edge and dark on the bottom', () => {
    const r = renderEffects(fx({ bevel: { ...DEFAULTS.bevel(), size: 6, technique: 'chiselHard' } }), input());
    const [shadow, highlight] = r.above;
    expect(alpha(highlight!.data, 32, 32 - 13)).toBeGreaterThan(0.2);
    expect(alpha(shadow!.data, 32, 32 + 13)).toBeGreaterThan(0.2);
    expect(alpha(highlight!.data, 32, 32 + 13)).toBe(0);
    // Flat in the middle and outside.
    expect(alpha(highlight!.data, 32, 32)).toBe(0);
    expect(alpha(shadow!.data, 32, 32)).toBe(0);
    expect(alpha(highlight!.data, 2, 2)).toBe(0);
  });

  it('glows: outer outside, inner inside, centre source from the middle', () => {
    const outer = renderEffects(fx({ outerGlow: { ...DEFAULTS.outerGlow(), size: 8 } }), input()).below[0]!.data;
    expect(alpha(outer, 32 + 19, 32)).toBeGreaterThan(0.1);
    const inner = renderEffects(fx({ innerGlow: { ...DEFAULTS.innerGlow(), size: 6 } }), input()).above[0]!.data;
    expect(alpha(inner, 32 + 15, 32)).toBeGreaterThan(alpha(inner, 32, 32) + 0.3);
    const centre = renderEffects(fx({ innerGlow: { ...DEFAULTS.innerGlow(), size: 6, source: 'center' } }), input()).above[0]!.data;
    expect(alpha(centre, 32, 32)).toBeGreaterThan(alpha(centre, 32 + 15, 32) + 0.3);
  });

  it('every effect renders, in Photoshop order, and the reach covers the outermost', () => {
    const all = fx({
      dropShadow: [DEFAULTS.dropShadow()],
      innerShadow: [DEFAULTS.innerShadow()],
      outerGlow: DEFAULTS.outerGlow(),
      innerGlow: DEFAULTS.innerGlow(),
      bevel: DEFAULTS.bevel(),
      satin: DEFAULTS.satin(),
      colorOverlay: [DEFAULTS.colorOverlay()],
      gradientOverlay: [DEFAULTS.gradientOverlay()],
      stroke: [DEFAULTS.stroke()],
    });
    const r = renderEffects(all, input());
    expect(r.below.map((e) => e.name)).toEqual(['Drop Shadow', 'Outer Glow']);
    expect(r.above.map((e) => e.name)).toEqual(['Gradient Overlay', 'Color Overlay', 'Satin', 'Inner Glow', 'Inner Shadow', 'Stroke', 'Bevel Shadow', 'Bevel Highlight']);
    expect(effectsReach(all)).toBeGreaterThanOrEqual(10);
  });
});
