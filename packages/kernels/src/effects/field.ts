/**
 * The primitives layer effects are built from (spec 06 §9): an exact Euclidean distance
 * transform, blurs, sub-pixel shifts and noise, all on single-channel float planes.
 */
import { gaussianKernel } from '../filters/core.js';

export type Field = Float32Array;

const INF = 1e20;

/**
 * Felzenszwalb & Huttenlocher's 1-D squared distance transform of `f` into `d`; `src[q]` is
 * the index (into `f`) of the sample each `d[q]` came from.
 */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array, src: Int32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
    src[q] = v[k]!;
  }
}

/**
 * Exact Euclidean distance from every pixel to the nearest pixel where `seed` is true, and
 * which pixel that is (-1 when there are no seeds).
 */
export function edtNearest(seed: (i: number) => boolean, w: number, h: number): { dist: Field; nearest: Int32Array } {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const src = new Int32Array(n);
  const grid = new Float64Array(w * h);
  // Per pixel, the row of the nearest seed in its column (after the first pass).
  const row = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = seed(i) ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    dt1(f, h, d, v, z, src);
    for (let y = 0; y < h; y++) {
      grid[y * w + x] = d[y]!;
      row[y * w + x] = src[y]!;
    }
  }
  const dist = new Float32Array(w * h);
  const nearest = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    dt1(f, w, d, v, z, src);
    for (let x = 0; x < w; x++) {
      dist[y * w + x] = Math.sqrt(d[x]!);
      const sx = src[x]!;
      nearest[y * w + x] = d[x]! >= INF ? -1 : row[y * w + sx]! * w + sx;
    }
  }
  return { dist, nearest };
}

/** Exact Euclidean distance from every pixel to the nearest pixel where `seed` is true. */
export function edt(seed: (i: number) => boolean, w: number, h: number): Field {
  return edtNearest(seed, w, h).dist;
}

/**
 * Signed distance to the shape's edge, in pixels: negative inside, positive outside. The
 * edge is where coverage crosses ½. Distances run to the nearest pixel on the other side and
 * are corrected by that pixel's coverage, which says how far through it the edge passes — so
 * a curved anti-aliased edge gives the same field as a straight one, not one biased by the
 * grid. Anti-aliased edge pixels take their distance from their own coverage.
 */
export function signedDistance(shape: Field, w: number, h: number): Field {
  const inside = (i: number) => shape[i]! >= 0.5;
  const toIn = edtNearest(inside, w, h);
  const toOut = edtNearest((i) => !inside(i), w, h);
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = shape[i]!;
    if (a > 0 && a < 1) {
      sd[i] = 0.5 - a;
    } else if (a >= 0.5) {
      const q = toOut.nearest[i]!;
      sd[i] = q < 0 ? -1e6 : -(toOut.dist[i]! - (0.5 - shape[q]!));
    } else {
      const q = toIn.nearest[i]!;
      sd[i] = q < 0 ? 1e6 : toIn.dist[i]! - (shape[q]! - 0.5);
    }
  }
  return sd;
}

/** Box blur along one axis with a fractional radius (the ends of the box are partial taps). */
function boxAxis(src: Field, dst: Field, w: number, h: number, r: number, horizontal: boolean): void {
  const ri = Math.floor(r);
  const frac = r - ri;
  const norm = 1 / (2 * r + 1);
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const at = (line: number, i: number) => {
    const c = i < 0 ? 0 : i >= len ? len - 1 : i;
    return horizontal ? src[line * w + c]! : src[c * w + line]!;
  };
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = -ri; i <= ri; i++) sum += at(line, i);
    for (let i = 0; i < len; i++) {
      const v = (sum + frac * (at(line, i - ri - 1) + at(line, i + ri + 1))) * norm;
      if (horizontal) dst[line * w + i] = v;
      else dst[i * w + line] = v;
      sum += at(line, i + ri + 1) - at(line, i - ri);
    }
  }
}

/**
 * Gaussian-like blur of standard deviation `sigma`: exact convolution when small, three box
 * passes (Wells) when large so that a 250 px glow stays linear-time. Edges replicate.
 */
export function blur(v: Field, w: number, h: number, sigma: number): Field {
  if (sigma < 0.3) return v.slice();
  const tmp = new Float32Array(v.length);
  if (sigma <= 6) {
    const k = gaussianKernel(sigma);
    const r = (k.length - 1) >> 1;
    const out = new Float32Array(v.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += v[y * w + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!;
        tmp[y * w + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!;
        out[y * w + x] = s;
      }
    }
    return out;
  }
  // Three boxes of radius r have variance 3·((2r+1)² − 1)/12 = σ².
  const r = (Math.sqrt(4 * sigma * sigma + 1) - 1) / 2;
  let a = v.slice();
  let b = tmp;
  for (let pass = 0; pass < 3; pass++) {
    boxAxis(a, b, w, h, r, true);
    boxAxis(b, a, w, h, r, false);
  }
  return a;
}

/** `v` moved by (dx, dy) pixels, bilinear, edges replicated. */
export function shift(v: Field, w: number, h: number, dx: number, dy: number): Field {
  if (dx === 0 && dy === 0) return v;
  const out = new Float32Array(v.length);
  const at = (x: number, y: number) => v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
      const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
      out[y * w + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
