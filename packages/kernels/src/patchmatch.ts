/**
 * Content-aware fill — spec 05 [doc]: PatchMatch (Barnes et al. 2009) for the nearest-neighbour
 * field, inside Wexler et al.'s (2007) coarse-to-fine EM completion: at each level, every
 * patch overlapping the hole finds its most similar fully-known patch, and each hole pixel
 * becomes the weighted vote of what those patches say it should be; repeated a few times,
 * then carried up to the next finer level as its starting point.
 *
 * Images are straight RGB 0…1, row-major. `hole` marks what to fill (1); `allowed` (optional)
 * marks where source patches may come from (1) — the sampling area. Randomness is seeded.
 */
import { solveMembrane } from './heal.js';

export interface InpaintOptions {
  /** Patch width (odd), default 7. */
  patch?: number;
  /** PatchMatch iterations per EM step, default 4. */
  iterations?: number;
  /** EM steps at the finest level (more at coarser ones), default 2. */
  emSteps?: number;
  seed?: number;
  allowed?: Uint8Array;
}

interface Level {
  w: number;
  h: number;
  img: Float32Array;
  hole: Uint8Array;
  allowed: Uint8Array;
}

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function downsample(l: Level): Level {
  const w = Math.ceil(l.w / 2);
  const h = Math.ceil(l.h / 2);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  const allowed = new Uint8Array(w * h).fill(1);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < l.h; y++)
    for (let x = 0; x < l.w; x++) {
      const i = y * l.w + x;
      const j = (y >> 1) * w + (x >> 1);
      // A coarse pixel is hole if any of its fine ones is; allowed only if all are.
      if (l.hole[i]) hole[j] = 1;
      if (!l.allowed[i]) allowed[j] = 0;
      if (!l.hole[i]) {
        for (let c = 0; c < 3; c++) img[j * 3 + c] = img[j * 3 + c]! + l.img[i * 3 + c]!;
        cnt[j] = cnt[j]! + 1;
      }
    }
  for (let j = 0; j < w * h; j++) if (cnt[j]! > 0) for (let c = 0; c < 3; c++) img[j * 3 + c] = img[j * 3 + c]! / cnt[j]!;
  return { w, h, img, hole, allowed };
}

/** Fill the hole of `img` (straight RGB, w × h); returns a new image. */
export function inpaint(img: Float32Array, w: number, h: number, hole: Uint8Array, opts: InpaintOptions = {}): Float32Array {
  const P = Math.max(3, (opts.patch ?? 7) | 1);
  const R = P >> 1;
  const rand = rng(opts.seed ?? 1);
  // The pyramid: down until the hole is about a patch across at the coarsest level.
  let hx0 = w;
  let hy0 = h;
  let hx1 = -1;
  let hy1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (hole[y * w + x]) {
        hx0 = Math.min(hx0, x);
        hy0 = Math.min(hy0, y);
        hx1 = Math.max(hx1, x);
        hy1 = Math.max(hy1, y);
      }
  if (hx1 < 0) return Float32Array.from(img);
  const holeSize = Math.max(hx1 - hx0 + 1, hy1 - hy0 + 1);
  const levels: Level[] = [{ w, h, img: Float32Array.from(img), hole, allowed: opts.allowed ?? new Uint8Array(w * h).fill(1) }];
  while (levels.length < 8) {
    const top = levels[levels.length - 1]!;
    const scale = 1 << levels.length;
    if (holeSize / scale < P || Math.min(top.w, top.h) / 2 < P * 3) break;
    levels.push(downsample(top));
  }

  // Coarsest: start the hole from the membrane over its boundary.
  const coarsest = levels[levels.length - 1]!;
  solveMembrane(coarsest.img, coarsest.hole, coarsest.w, coarsest.h, 3, 60);

  let nnf: Int32Array | null = null;
  let prevW = 0;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li]!;
    const { w: W, h: H, img: I } = L;
    // Where source patches may sit: fully inside, nothing of the hole in them, all allowed.
    const holeSum = new Int32Array((W + 1) * (H + 1));
    const badSum = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const k = (y + 1) * (W + 1) + (x + 1);
        holeSum[k] = holeSum[k - 1]! + holeSum[k - (W + 1)]! - holeSum[k - (W + 1) - 1]! + (L.hole[i] ? 1 : 0);
        badSum[k] = badSum[k - 1]! + badSum[k - (W + 1)]! - badSum[k - (W + 1) - 1]! + (L.hole[i] || !L.allowed[i] ? 1 : 0);
      }
    const boxSum = (s: Int32Array, x0: number, y0: number, x1: number, y1: number) => s[y1 * (W + 1) + x1]! - s[y0 * (W + 1) + x1]! - s[y1 * (W + 1) + x0]! + s[y0 * (W + 1) + x0]!;
    const valid = (x: number, y: number) => x >= R && y >= R && x < W - R && y < H - R && boxSum(badSum, x - R, y - R, x + R + 1, y + R + 1) === 0;
    const sources: number[] = [];
    for (let y = R; y < H - R; y++) for (let x = R; x < W - R; x++) if (valid(x, y)) sources.push(y * W + x);
    if (!sources.length) {
      // Nothing to copy from: the membrane (or the coarser level) is the best we have.
      if (li > 0) upsampleInto(levels[li - 1]!, L);
      continue;
    }
    // Targets: every centre whose patch touches the hole.
    const targets: number[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - R);
        const y0 = Math.max(0, y - R);
        const x1 = Math.min(W, x + R + 1);
        const y1 = Math.min(H, y + R + 1);
        if (boxSum(holeSum, x0, y0, x1, y1) > 0) targets.push(y * W + x);
      }
    const T = targets.length;
    const tx = new Int32Array(T);
    const ty = new Int32Array(T);
    const index = new Int32Array(W * H).fill(-1);
    targets.forEach((p, k) => {
      tx[k] = p % W;
      ty[k] = (p - tx[k]!) / W;
      index[p] = k;
    });
    const sx = new Int32Array(T);
    const sy = new Int32Array(T);
    const dist = new Float32Array(T);
    // Patch distance: sum of squared differences over the in-bounds part of the target patch.
    const D = (k: number, x: number, y: number, limit: number) => {
      let sum = 0;
      let n = 0;
      const cx = tx[k]!;
      const cy = ty[k]!;
      for (let dy = -R; dy <= R; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= W) continue;
          const a = (py * W + px) * 3;
          const b = ((y + dy) * W + (x + dx)) * 3;
          const d0 = I[a]! - I[b]!;
          const d1 = I[a + 1]! - I[b + 1]!;
          const d2 = I[a + 2]! - I[b + 2]!;
          sum += d0 * d0 + d1 * d1 + d2 * d2;
          n++;
        }
        if (sum > limit * n) return Infinity;
      }
      return n ? sum / n : Infinity;
    };
    // Initial field: carried up from the coarser level where it still lands on a valid source,
    // random elsewhere.
    for (let k = 0; k < T; k++) {
      let x = -1;
      let y = -1;
      if (nnf && prevW) {
        const cx = tx[k]! >> 1;
        const cy = ty[k]! >> 1;
        const j = nnf[(cy * prevW + cx) * 2]!;
        if (j >= 0) {
          x = Math.min(W - R - 1, nnf[(cy * prevW + cx) * 2]! * 2 + (tx[k]! & 1));
          y = Math.min(H - R - 1, nnf[(cy * prevW + cx) * 2 + 1]! * 2 + (ty[k]! & 1));
        }
      }
      if (x < 0 || !valid(x, y)) {
        const p = sources[Math.floor(rand() * sources.length)]!;
        x = p % W;
        y = (p - x) / W;
      }
      sx[k] = x;
      sy[k] = y;
      dist[k] = D(k, x, y, Infinity);
    }
    const iters = opts.iterations ?? 4;
    const em = (opts.emSteps ?? 2) + (li > 0 ? 1 : 0);
    for (let step = 0; step < em; step++) {
      for (let it = 0; it < iters; it++) {
        const forward = it % 2 === 0;
        for (let q = 0; q < T; q++) {
          const k = forward ? q : T - 1 - q;
          const cx = tx[k]!;
          const cy = ty[k]!;
          // Propagation: a neighbour's match, shifted by one, is often this patch's match.
          const d = forward ? -1 : 1;
          for (const [nx, ny] of [[cx + d, cy], [cx, cy + d]] as const) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const n = index[ny * W + nx]!;
            if (n < 0) continue;
            const x = sx[n]! - (nx - cx);
            const y = sy[n]! - (ny - cy);
            if ((x === sx[k] && y === sy[k]) || !valid(x, y)) continue;
            const dd = D(k, x, y, dist[k]!);
            if (dd < dist[k]!) {
              dist[k] = dd;
              sx[k] = x;
              sy[k] = y;
            }
          }
          // Random search around the current best, halving the window.
          for (let rad = Math.max(W, H); rad >= 1; rad >>= 1) {
            const x = Math.round(sx[k]! + (rand() * 2 - 1) * rad);
            const y = Math.round(sy[k]! + (rand() * 2 - 1) * rad);
            if (!valid(x, y)) continue;
            const dd = D(k, x, y, dist[k]!);
            if (dd < dist[k]!) {
              dist[k] = dd;
              sx[k] = x;
              sy[k] = y;
            }
          }
        }
      }
      // Voting: each hole pixel from every patch over it, weighted by how well that patch matched.
      const sorted = Float32Array.from(dist).filter((v) => Number.isFinite(v)).sort();
      const sigma2 = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.75)] ?? 1e-2);
      const acc = new Float32Array(W * H * 4);
      for (let k = 0; k < T; k++) {
        const wgt = Math.exp(-dist[k]! / (2 * sigma2));
        const cx = tx[k]!;
        const cy = ty[k]!;
        for (let dy = -R; dy <= R; dy++) {
          const py = cy + dy;
          if (py < 0 || py >= H) continue;
          for (let dx = -R; dx <= R; dx++) {
            const px = cx + dx;
            if (px < 0 || px >= W) continue;
            const p = py * W + px;
            if (!L.hole[p]) continue;
            const b = ((sy[k]! + dy) * W + (sx[k]! + dx)) * 3;
            acc[p * 4] = acc[p * 4]! + I[b]! * wgt;
            acc[p * 4 + 1] = acc[p * 4 + 1]! + I[b + 1]! * wgt;
            acc[p * 4 + 2] = acc[p * 4 + 2]! + I[b + 2]! * wgt;
            acc[p * 4 + 3] = acc[p * 4 + 3]! + wgt;
          }
        }
      }
      for (let p = 0; p < W * H; p++) {
        if (!L.hole[p] || acc[p * 4 + 3]! <= 0) continue;
        for (let c = 0; c < 3; c++) I[p * 3 + c] = acc[p * 4 + c]! / acc[p * 4 + 3]!;
      }
      for (let k = 0; k < T; k++) dist[k] = D(k, sx[k]!, sy[k]!, Infinity);
    }
    // Carry the field and the filled hole up to the next finer level.
    const field = new Int32Array(W * H * 2).fill(-1);
    for (let k = 0; k < T; k++) {
      const p = ty[k]! * W + tx[k]!;
      field[p * 2] = sx[k]!;
      field[p * 2 + 1] = sy[k]!;
    }
    nnf = field;
    prevW = W;
    if (li > 0) upsampleInto(levels[li - 1]!, L);
  }
  return levels[0]!.img;
}

/** Fill the finer level's hole from the coarser level's result (bilinear). */
function upsampleInto(fine: Level, coarse: Level): void {
  for (let y = 0; y < fine.h; y++)
    for (let x = 0; x < fine.w; x++) {
      const i = y * fine.w + x;
      if (!fine.hole[i]) continue;
      const fx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const fy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(coarse.w - 1, x0 + 1);
      const y1 = Math.min(coarse.h - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const v = (a: number, b: number) => coarse.img[(b * coarse.w + a) * 3 + c]!;
        fine.img[i * 3 + c] = (v(x0, y0) * (1 - ax) + v(x1, y0) * ax) * (1 - ay) + (v(x0, y1) * (1 - ax) + v(x1, y1) * ax) * ay;
      }
    }
}
