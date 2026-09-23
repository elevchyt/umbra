/** Filter ▸ Noise — spec 05 §B.4. */
import { cloneRaster, gaussianBlur, hash2, lum, makeRaster, type Raster } from './core.js';
import { unsharp } from './sharpen.js';
import { bool, num, str, type FilterDef } from './types.js';

/**
 * Median of each channel over a (2r+1)² square, by Huang's sliding histogram: moving one
 * pixel right swaps one column in and one out, O(r) per pixel, and the median is tracked by
 * walking from where it was — it rarely moves far. Channels are quantised to 8 bits for the
 * histogram, which is what an 8-bit document holds anyway. Returns straight colour 0…255.
 */
export function medianChannels(src: Raster, radius: number): Uint8Array {
  const { width: w, height: h, data: d } = src;
  const r = Math.max(1, Math.round(radius));
  // Straight 8-bit channels (alpha-weighted colour would bias the median toward black).
  const ch = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    for (let c = 0; c < 3; c++) ch[i + c] = a > 0 ? Math.round((d[i + c]! / a) * 255) : 0;
    ch[i + 3] = Math.round(a * 255);
  }
  const out = new Uint8Array(w * h * 4);
  const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
  const hist = new Int32Array(256 * 4);
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    // Prime the window at x = 0.
    for (let dy = -r; dy <= r; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, dx));
        const i = (yy * w + xx) * 4;
        for (let c = 0; c < 4; c++) hist[c * 256 + ch[i + c]!]!++;
      }
    }
    const med = [0, 0, 0, 0];
    const below = [0, 0, 0, 0];
    // Initial medians: count up from 0.
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      let m = 0;
      while (acc + hist[c * 256 + m]! <= half) acc += hist[c * 256 + m++]!;
      med[c] = m;
      below[c] = acc;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = med[c]!;
      if (x === w - 1) break;
      // Slide: remove column x − r, add column x + r + 1.
      const xo = Math.max(0, x - r);
      const xi = Math.min(w - 1, x + r + 1);
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        const io = (yy * w + xo) * 4;
        const ii = (yy * w + xi) * 4;
        for (let c = 0; c < 4; c++) {
          const vo = ch[io + c]!;
          const vi = ch[ii + c]!;
          hist[c * 256 + vo]!--;
          if (vo < med[c]!) below[c]!--;
          hist[c * 256 + vi]!++;
          if (vi < med[c]!) below[c]!++;
        }
      }
      // Re-centre each median.
      for (let c = 0; c < 4; c++) {
        let m = med[c]!;
        let b = below[c]!;
        const base = c * 256;
        while (b > half) {
          m--;
          b -= hist[base + m]!;
        }
        while (b + hist[base + m]! <= half) {
          b += hist[base + m]!;
          m++;
        }
        med[c] = m;
        below[c] = b;
      }
    }
  }
  return out;
}

export function fromStraight8(src: Raster, px: Uint8Array): Raster {
  const out = makeRaster(src.width, src.height);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]! / 255;
    out.data[i] = (px[i]! / 255) * a;
    out.data[i + 1] = (px[i + 1]! / 255) * a;
    out.data[i + 2] = (px[i + 2]! / 255) * a;
    out.data[i + 3] = a;
  }
  return out;
}

export const median: FilterDef = {
  id: 'noise.median',
  label: 'Median',
  category: 'Noise',
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 1, max: 500, default: 1, unit: 'px', scale: 'log' }],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: 'Exact per-channel median over a square window (Photoshop does not document the window shape).',
  run: (src, p) => fromStraight8(src, medianChannels(src, num(p, 'radius'))),
};

export const dustScratches: FilterDef = {
  id: 'noise.dustscratches',
  label: 'Dust & Scratches',
  category: 'Noise',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 1, max: 500, default: 1, unit: 'px', scale: 'log' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 0, unit: 'levels' },
  ],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: 'Exact, per spec 05: |median − v| > t ? median : v, per channel.',
  run: (src, p) => {
    const med = medianChannels(src, num(p, 'radius'));
    const t = num(p, 'threshold');
    const out = cloneRaster(src);
    for (let i = 0; i < med.length; i += 4) {
      const a = src.data[i + 3]!;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = (src.data[i + c]! / a) * 255;
        if (Math.abs(med[i + c]! - v) > t) out.data[i + c] = (med[i + c]! / 255) * a;
      }
    }
    return out;
  },
};

export const despeckle: FilterDef = {
  id: 'noise.despeckle',
  label: 'Despeckle',
  category: 'Noise',
  params: [],
  pad: () => 3,
  model: '[fit] a 3×3 median where local contrast is low, blended out toward edges, which it is documented to preserve.',
  run: (src) => {
    const med = medianChannels(src, 1);
    const { width: w, height: h, data: d } = src;
    const out = cloneRaster(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = d[i + 3]!;
        if (a <= 0) continue;
        // Edge strength: the luminance range in the 3×3 neighbourhood.
        let lo = 1;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
            const aa = d[j + 3]!;
            const l = aa > 0 ? lum(d[j]!, d[j + 1]!, d[j + 2]!) / aa : 0;
            lo = Math.min(lo, l);
            hi = Math.max(hi, l);
          }
        }
        const k = Math.max(0, 1 - (hi - lo) / 0.25);
        for (let c = 0; c < 3; c++) out.data[i + c] = d[i + c]! + ((med[i + c]! / 255) * a - d[i + c]!) * k;
      }
    }
    return out;
  },
};

/** A standard normal from two uniforms (Box–Muller). */
function gauss(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
}

export const addNoise: FilterDef = {
  id: 'noise.addnoise',
  label: 'Add Noise',
  category: 'Noise',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0.1, max: 400, default: 12.5, step: 0.1, precision: 1, unit: '%' },
    { key: 'distribution', label: 'Distribution', type: 'select', default: 'uniform', options: [{ value: 'uniform', label: 'Uniform' }, { value: 'gaussian', label: 'Gaussian' }] },
    { key: 'mono', label: 'Monochromatic', type: 'bool', default: false },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 0,
  model: '[fit] Uniform is ±Amount/2 of full range, Gaussian σ = Amount/4; noise is hashed from the document position so a preview crop matches the full run.',
  run: (src, p, ctx) => {
    const amount = num(p, 'amount') / 100;
    const gaussian = str(p, 'distribution') === 'gaussian';
    const mono = bool(p, 'mono');
    const seed = num(p, 'seed');
    const out = cloneRaster(src);
    const { width: w, height: h, data: d } = src;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = d[i + 3]!;
        if (a <= 0) continue;
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        for (let c = 0; c < 3; c++) {
          const k = mono ? 0 : c;
          const u1 = hash2(gx, gy, seed * 7 + k * 2);
          const n = gaussian ? gauss(u1, hash2(gx, gy, seed * 7 + k * 2 + 1)) * (amount / 4) : (u1 - 0.5) * amount;
          out.data[i + c] = Math.min(a, Math.max(0, d[i + c]! + n * a));
        }
      }
    }
    return out;
  },
};

export const reduceNoise: FilterDef = {
  id: 'noise.reducenoise',
  label: 'Reduce Noise',
  category: 'Noise',
  params: [
    { key: 'strength', label: 'Strength', type: 'number', min: 0, max: 10, default: 6 },
    { key: 'details', label: 'Preserve Details', type: 'number', min: 0, max: 100, default: 60, unit: '%' },
    { key: 'color', label: 'Reduce Color Noise', type: 'number', min: 0, max: 100, default: 45, unit: '%' },
    { key: 'sharpen', label: 'Sharpen Details', type: 'number', min: 0, max: 100, default: 25, unit: '%' },
  ],
  pad: () => 12,
  model:
    '[fit] luminance is pulled toward a Gaussian-smoothed version by Strength, except where local detail is high (Preserve Details); chroma (Cb/Cr) is blurred by Reduce Color Noise; then an unsharp mask by Sharpen Details. Remove JPEG Artifact and the per-channel Advanced mode are not modelled.',
  run: (src, p) => {
    const strength = num(p, 'strength') / 10;
    const keep = num(p, 'details') / 100;
    const colorK = num(p, 'color') / 100;
    const sharpK = num(p, 'sharpen') / 100;
    const { width: w, height: h, data: d } = src;
    // Split into Y, Cb, Cr (straight), each as its own one-channel raster.
    const Y = makeRaster(w, h);
    const C = makeRaster(w, h);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      const r = a > 0 ? d[i]! / a : 0;
      const g = a > 0 ? d[i + 1]! / a : 0;
      const b = a > 0 ? d[i + 2]! / a : 0;
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      Y.data[i] = Y.data[i + 1] = Y.data[i + 2] = yv;
      Y.data[i + 3] = 1;
      C.data[i] = b - yv;
      C.data[i + 1] = r - yv;
      C.data[i + 3] = 1;
    }
    const Ys = gaussianBlur(Y, 1.2);
    const Cs = colorK > 0 ? gaussianBlur(C, 3 * colorK) : C;
    const Yd = gaussianBlur(Y, 0.6);
    const out = makeRaster(w, h);
    for (let i = 0; i < d.length; i += 4) {
      const detail = Math.min(1, Math.abs(Y.data[i]! - Yd.data[i]!) * 20);
      const k = strength * (1 - keep * detail);
      out.data[i] = out.data[i + 1] = out.data[i + 2] = Y.data[i]! + (Ys.data[i]! - Y.data[i]!) * k;
      out.data[i + 3] = 1;
    }
    const Yf = sharpK > 0 ? unsharp(out, gaussianBlur(out, 1), sharpK, 0) : out;
    const res = cloneRaster(src);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      if (a <= 0) continue;
      const yv = Yf.data[i]!;
      const cb = Cs.data[i]!;
      const cr = Cs.data[i + 1]!;
      const r = yv + cr;
      const b = yv + cb;
      const g = (yv - 0.299 * r - 0.114 * b) / 0.587;
      res.data[i] = Math.min(1, Math.max(0, r)) * a;
      res.data[i + 1] = Math.min(1, Math.max(0, g)) * a;
      res.data[i + 2] = Math.min(1, Math.max(0, b)) * a;
    }
    return res;
  },
};

export const NOISE_FILTERS: FilterDef[] = [addNoise, despeckle, dustScratches, median, reduceNoise];
