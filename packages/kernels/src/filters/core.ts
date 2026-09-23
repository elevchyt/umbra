/**
 * The filter toolkit — spec 05 §B conventions, spec 03 §8.
 *
 * Filters run on a `Raster`: PREMULTIPLIED float RGBA, 0…1. Premultiplied because every
 * spatial filter averages neighbours, and averaging straight colour lets the invisible colour
 * under transparent pixels bleed into the result (the classic dark fringe). Float because a
 * chain of filters should not quantise between steps. Edges replicate unless a filter says
 * otherwise, as Photoshop's do.
 */

export interface Raster {
  width: number;
  height: number;
  /** Premultiplied RGBA, 0…1, row-major. */
  data: Float32Array;
}

export function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Float32Array(width * height * 4) };
}

export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Float32Array(r.data) };
}

/** Straight RGBA8 → premultiplied float. */
export function fromRgba8(px: ArrayLike<number>, width: number, height: number): Raster {
  const r = makeRaster(width, height);
  const d = r.data;
  for (let i = 0; i < width * height * 4; i += 4) {
    const a = px[i + 3]! / 255;
    d[i] = (px[i]! / 255) * a;
    d[i + 1] = (px[i + 1]! / 255) * a;
    d[i + 2] = (px[i + 2]! / 255) * a;
    d[i + 3] = a;
  }
  return r;
}

/** Premultiplied float → straight RGBA8. */
export function toRgba8(r: Raster, out = new Uint8ClampedArray(r.width * r.height * 4)): Uint8ClampedArray {
  const d = r.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a <= 1 / 510) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    // Uint8ClampedArray rounds on assignment; adding ½ here would round twice.
    const k = 255 / a;
    out[i] = d[i]! * k;
    out[i + 1] = d[i + 1]! * k;
    out[i + 2] = d[i + 2]! * k;
    out[i + 3] = a * 255;
  }
  return out;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Replicate-edge pixel fetch into `out` (4 floats). */
export function fetch(r: Raster, x: number, y: number, out: Float32Array | number[], o = 0): void {
  const xx = x < 0 ? 0 : x >= r.width ? r.width - 1 : x;
  const yy = y < 0 ? 0 : y >= r.height ? r.height - 1 : y;
  const i = (yy * r.width + xx) * 4;
  out[o] = r.data[i]!;
  out[o + 1] = r.data[i + 1]!;
  out[o + 2] = r.data[i + 2]!;
  out[o + 3] = r.data[i + 3]!;
}

/** Bilinear sample at a continuous position (pixel centres at +0.5), replicate edges. */
export function sampleBilinear(r: Raster, x: number, y: number, out: Float32Array | number[], o = 0): void {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const w = r.width;
  const h = r.height;
  const cx0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1;
  const cy0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= h ? h - 1 : y0 + 1;
  const d = r.data;
  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + cx1) * 4;
  const i01 = (cy1 * w + cx0) * 4;
  const i11 = (cy1 * w + cx1) * 4;
  for (let c = 0; c < 4; c++) {
    const a = d[i00 + c]! + (d[i10 + c]! - d[i00 + c]!) * tx;
    const b = d[i01 + c]! + (d[i11 + c]! - d[i01 + c]!) * tx;
    out[o + c] = a + (b - a) * ty;
  }
}

/**
 * Sliding-window box blur along one axis, all four channels, replicate edges. O(n) whatever
 * the radius — the building block for Box Blur, and three of them for a Gaussian.
 */
export function boxBlurAxis(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const len = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 4 : width * 4;
  const norm = 1 / (2 * r + 1);
  const acc = [0, 0, 0, 0];
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let k = -r; k <= r; k++) {
      const p = base + (k < 0 ? 0 : k >= len ? len - 1 : k) * step;
      for (let c = 0; c < 4; c++) acc[c]! += src[p + c]!;
    }
    for (let i = 0; i < len; i++) {
      const o = base + i * step;
      for (let c = 0; c < 4; c++) dst[o + c] = acc[c]! * norm;
      const out = base + Math.max(0, i - r) * step;
      const inn = base + Math.min(len - 1, i + r + 1) * step;
      for (let c = 0; c < 4; c++) acc[c]! += src[inn + c]! - src[out + c]!;
    }
  }
}

/** Box blur, both axes. Photoshop's Box Blur is exactly this. */
export function boxBlur(r: Raster, radius: number): Raster {
  const tmp = new Float32Array(r.data.length);
  const out = makeRaster(r.width, r.height);
  boxBlurAxis(r.data, tmp, r.width, r.height, radius, true);
  boxBlurAxis(tmp, out.data, r.width, r.height, radius, false);
  return out;
}

/** 1-D Gaussian kernel of standard deviation `sigma`, normalised, radius ⌈3σ⌉. */
export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/** Convolve with a symmetric 1-D kernel along one axis, replicate edges. */
export function convolveAxis(src: Float32Array, dst: Float32Array, width: number, height: number, kernel: Float32Array, horizontal: boolean): void {
  const r = (kernel.length - 1) >> 1;
  const len = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 4 : width * 4;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    for (let i = 0; i < len; i++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        const p = base + (j < 0 ? 0 : j >= len ? len - 1 : j) * step;
        const w = kernel[k + r]!;
        s0 += src[p]! * w;
        s1 += src[p + 1]! * w;
        s2 += src[p + 2]! * w;
        s3 += src[p + 3]! * w;
      }
      const o = base + i * step;
      dst[o] = s0;
      dst[o + 1] = s1;
      dst[o + 2] = s2;
      dst[o + 3] = s3;
    }
  }
}

/**
 * Gaussian blur of standard deviation `sigma`. Exact separable convolution up to σ = 12;
 * beyond that three box passes (within about 3% of a Gaussian) keep it O(n) at any radius.
 */
export function gaussianBlur(r: Raster, sigma: number): Raster {
  const out = makeRaster(r.width, r.height);
  if (sigma < 0.05) {
    out.data.set(r.data);
    return out;
  }
  const tmp = new Float32Array(r.data.length);
  if (sigma <= 12) {
    const k = gaussianKernel(sigma);
    convolveAxis(r.data, tmp, r.width, r.height, k, true);
    convolveAxis(tmp, out.data, r.width, r.height, k, false);
    return out;
  }
  // Three boxes of width w have variance 3·(w²−1)/12.
  const w = Math.sqrt(4 * sigma * sigma + 1);
  const rad = Math.max(1, Math.round((w - 1) / 2));
  const a = new Float32Array(r.data);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurAxis(a, tmp, r.width, r.height, rad, true);
    boxBlurAxis(tmp, a, r.width, r.height, rad, false);
  }
  out.data.set(a);
  return out;
}

/** Convolve with a small square kernel (odd size), replicate edges; `bias` added after. */
export function convolve2d(r: Raster, kernel: readonly number[], size: number, scale = 1, bias = 0, alsoAlpha = false): Raster {
  const out = makeRaster(r.width, r.height);
  const h = (size - 1) >> 1;
  const px = new Float32Array(4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let ky = -h; ky <= h; ky++) {
        for (let kx = -h; kx <= h; kx++) {
          const w = kernel[(ky + h) * size + (kx + h)]!;
          if (w === 0) continue;
          fetch(r, x + kx, y + ky, px);
          s0 += px[0]! * w;
          s1 += px[1]! * w;
          s2 += px[2]! * w;
          s3 += px[3]! * w;
        }
      }
      const o = (y * r.width + x) * 4;
      const a = alsoAlpha ? clamp01(s3 / scale + bias) : r.data[o + 3]!;
      // Colour is convolved premultiplied, then limited to what the alpha allows.
      out.data[o] = Math.min(a, Math.max(0, s0 / scale + bias * a));
      out.data[o + 1] = Math.min(a, Math.max(0, s1 / scale + bias * a));
      out.data[o + 2] = Math.min(a, Math.max(0, s2 / scale + bias * a));
      out.data[o + 3] = a;
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32), so a seeded filter is repeatable — and testable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position-stable hash noise in [0,1): the same pixel gets the same value in any crop. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Unpremultiplied colour of a pixel into `out[0..2]`, alpha into `out[3]`. */
export function straight(r: Raster, i: number, out: Float32Array | number[]): void {
  const a = r.data[i + 3]!;
  out[3] = a;
  if (a <= 0) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  out[0] = r.data[i]! / a;
  out[1] = r.data[i + 1]! / a;
  out[2] = r.data[i + 2]! / a;
}

/** Write straight colour back premultiplied, keeping the pixel's alpha. */
export function putStraight(r: Raster, i: number, cr: number, cg: number, cb: number): void {
  const a = r.data[i + 3]!;
  r.data[i] = clamp01(cr) * a;
  r.data[i + 1] = clamp01(cg) * a;
  r.data[i + 2] = clamp01(cb) * a;
}

/**
 * Map every pixel's straight colour through `fn` (point filters: Solarize, HSB/HSL, …).
 * Transparent pixels are left alone.
 */
export function mapStraight(r: Raster, fn: (rgb: Float32Array, x: number, y: number) => void): Raster {
  const out = cloneRaster(r);
  const px = new Float32Array(4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4;
      if (r.data[i + 3]! <= 0) continue;
      straight(r, i, px);
      fn(px, x, y);
      putStraight(out, i, px[0]!, px[1]!, px[2]!);
    }
  }
  return out;
}
