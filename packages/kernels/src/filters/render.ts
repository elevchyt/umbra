/** Filter ▸ Render — spec 05 §B.6. Flame, Picture Frame and Tree are post-1.0. */
import { clamp01, cloneRaster, hash2, type Raster } from './core.js';
import { num, pt, str, type FilterDef, type FilterContext } from './types.js';

/**
 * Value noise on a lattice that repeats every 256 cells, smoothstep-interpolated — the
 * "256-period lattice noise" spec 05 names for Clouds.
 */
function lattice(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (i: number, j: number) => hash2(i & 255, j & 255, seed);
  const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

/** Fractal sum of octaves, feature size `scale` px halving each octave down to a pixel. */
export function fbm(x: number, y: number, scale: number, seed: number, sx = 1, sy = 1): number {
  let v = 0;
  let amp = 0.5;
  let total = 0;
  for (let s = scale; s >= 1; s /= 2) {
    v += lattice((x * sx) / s, (y * sy) / s, seed + s) * amp;
    total += amp;
    amp *= 0.5;
  }
  return v / total;
}

function cloudValue(x: number, y: number, seed: number, contrast: boolean): number {
  const v = fbm(x, y, 256, seed);
  // The sum of octaves clusters round ½; stretch it to use the range, as Clouds does.
  return clamp01(0.5 + (v - 0.5) * (contrast ? 4 : 2.2));
}

function paintClouds(src: Raster, ctx: FilterContext, seed: number, contrast: boolean, difference: boolean): Raster {
  const out = cloneRaster(src);
  const [f0, f1, f2] = ctx.foreground;
  const [b0, b1, b2] = ctx.background;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const t = cloudValue(x + ctx.originX, y + ctx.originY, seed, contrast);
      const cr = f0 + (b0 - f0) * t;
      const cg = f1 + (b1 - f1) * t;
      const cb = f2 + (b2 - f2) * t;
      const o = (y * src.width + x) * 4;
      if (!difference) {
        // Clouds replaces the layer, opaque — it renders onto transparent layers too.
        out.data[o] = cr;
        out.data[o + 1] = cg;
        out.data[o + 2] = cb;
        out.data[o + 3] = 1;
        continue;
      }
      const a = src.data[o + 3]!;
      if (a <= 0) continue;
      out.data[o] = Math.abs(src.data[o]! / a - cr) * a;
      out.data[o + 1] = Math.abs(src.data[o + 1]! / a - cg) * a;
      out.data[o + 2] = Math.abs(src.data[o + 2]! / a - cb) * a;
    }
  }
  return out;
}

export const clouds: FilterDef = {
  id: 'render.clouds',
  label: 'Clouds',
  category: 'Render',
  params: [
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
    { key: 'contrast', label: 'High Contrast (Alt)', type: 'bool', default: false },
  ],
  pad: () => 0,
  model: 'Spec 05: foreground→background through multi-octave 256-period lattice noise; statistical match only.',
  run: (src, p, ctx) => paintClouds(src, ctx, num(p, 'seed'), p.contrast === true, false),
};

export const differenceClouds: FilterDef = {
  id: 'render.differenceclouds',
  label: 'Difference Clouds',
  category: 'Render',
  params: [
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
    { key: 'contrast', label: 'High Contrast (Alt)', type: 'bool', default: false },
  ],
  pad: () => 0,
  model: 'Clouds, combined with the layer in Difference mode.',
  run: (src, p, ctx) => paintClouds(src, ctx, num(p, 'seed'), p.contrast === true, true),
};

export const fibers: FilterDef = {
  id: 'render.fibers',
  label: 'Fibers',
  category: 'Render',
  params: [
    { key: 'variance', label: 'Variance', type: 'number', min: 1, max: 64, default: 16 },
    { key: 'strength', label: 'Strength', type: 'number', min: 1, max: 64, default: 4 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 0,
  model: '[fit] lattice noise stretched vertically by Strength into fibres; Variance shortens the fibres and raises their contrast; coloured foreground→background.',
  run: (src, p, ctx) => {
    const variance = num(p, 'variance');
    const strength = num(p, 'strength');
    const seed = num(p, 'seed');
    const out = cloneRaster(src);
    const [f0, f1, f2] = ctx.foreground;
    const [b0, b1, b2] = ctx.background;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        const v = fbm(gx, gy, 32, seed, 4, 1 / (strength * (1 + 16 / variance)));
        const t = clamp01(0.5 + (v - 0.5) * (1.5 + variance / 16));
        const o = (y * src.width + x) * 4;
        out.data.set([f0 + (b0 - f0) * t, f1 + (b1 - f1) * t, f2 + (b2 - f2) * t, 1], o);
      }
    }
    return out;
  },
};

const LENSES = [
  { value: 'zoom', label: '50-300mm Zoom' },
  { value: 'prime35', label: '35mm Prime' },
  { value: 'prime105', label: '105mm Prime' },
  { value: 'movie', label: 'Movie Prime' },
];

export const lensFlare: FilterDef = {
  id: 'render.lensflare',
  label: 'Lens Flare',
  category: 'Render',
  params: [
    { key: 'center', label: 'Flare Center', type: 'point', default: { x: 0.3, y: 0.3 } },
    { key: 'brightness', label: 'Brightness', type: 'number', min: 10, max: 300, default: 100, unit: '%' },
    { key: 'lens', label: 'Lens Type', type: 'select', default: 'zoom', options: LENSES },
  ],
  pad: () => 'full',
  model:
    '[fit] screen-blended light: a hot core and glow at the centre, a halo ring, and secondary reflections along the line through the image centre, their count and tints varying by lens; the Movie Prime adds a horizontal streak.',
  run: (src, p, ctx) => {
    const c = pt(p, 'center');
    const cx = c.x * ctx.docWidth;
    const cy = c.y * ctx.docHeight;
    const k = num(p, 'brightness') / 100;
    const lens = str(p, 'lens');
    const D = Math.hypot(ctx.docWidth, ctx.docHeight);
    const mx = ctx.docWidth / 2;
    const my = ctx.docHeight / 2;
    // Reflections: [position along centre→mirror, radius as a fraction of D, rgb].
    const ghosts: [number, number, [number, number, number]][] =
      lens === 'prime35'
        ? [[0.35, 0.02, [0.3, 0.6, 0.3]], [0.7, 0.05, [0.2, 0.3, 0.6]], [1.3, 0.03, [0.6, 0.3, 0.2]]]
        : lens === 'prime105'
          ? [[0.5, 0.015, [0.5, 0.4, 0.2]], [0.9, 0.035, [0.2, 0.5, 0.6]]]
          : lens === 'movie'
            ? [[0.6, 0.01, [0.4, 0.5, 0.8]], [1.2, 0.02, [0.3, 0.4, 0.9]]]
            : [[0.25, 0.012, [0.5, 0.3, 0.6]], [0.5, 0.03, [0.3, 0.5, 0.3]], [0.8, 0.02, [0.6, 0.4, 0.2]], [1.1, 0.05, [0.2, 0.3, 0.6]], [1.5, 0.025, [0.5, 0.2, 0.4]]];
    const out = cloneRaster(src);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const a = src.data[o + 3]!;
        if (a <= 0) continue;
        const gx = x + ctx.originX + 0.5;
        const gy = y + ctx.originY + 0.5;
        const d = Math.hypot(gx - cx, gy - cy) / D;
        let r = 0;
        let g = 0;
        let b = 0;
        const core = Math.exp(-d / 0.006) * 1.5 + Math.exp(-d / 0.05) * 0.5;
        r += core;
        g += core * 0.95;
        b += core * 0.85;
        const halo = Math.exp(-(((d - 0.12) / 0.012) ** 2)) * 0.25;
        r += halo * 0.9;
        g += halo * 0.5;
        b += halo * 0.4;
        if (lens === 'movie') {
          const streak = Math.exp(-Math.abs(gy - cy) / (D * 0.002)) * Math.exp(-Math.abs(gx - cx) / (D * 0.4)) * 0.8;
          r += streak * 0.6;
          g += streak * 0.7;
          b += streak;
        }
        for (const [t, rad, col] of ghosts) {
          const qx = cx + (mx - cx) * 2 * t;
          const qy = cy + (my - cy) * 2 * t;
          const dd = Math.hypot(gx - qx, gy - qy) / D;
          const w = clamp01(1 - dd / rad) ** 0.7 * 0.45;
          r += w * col[0];
          g += w * col[1];
          b += w * col[2];
        }
        const L = [r * k, g * k, b * k];
        for (let ch = 0; ch < 3; ch++) {
          const v = src.data[o + ch]! / a;
          out.data[o + ch] = (1 - (1 - v) * (1 - clamp01(L[ch]!))) * a;
        }
      }
    }
    return out;
  },
};

export const RENDER_FILTERS: FilterDef[] = [clouds, differenceClouds, fibers, lensFlare];
