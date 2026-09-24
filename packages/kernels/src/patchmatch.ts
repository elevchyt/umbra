/**
 * Content-aware fill — spec 05 [doc]: PatchMatch (Barnes et al. 2009) for the nearest-neighbour
 * field, inside Wexler et al.'s (2007) coarse-to-fine EM completion: at each level, every
 * patch overlapping the hole finds its most similar fully-known patch, and each hole pixel
 * becomes the weighted vote of what those patches say it should be; repeated a few times,
 * then carried up to the next finer level as its starting point.
 *
 * Images are straight RGB 0…1, row-major. `hole` marks what to fill (1); `allowed` (optional)
 * marks where source patches may come from (1) — the sampling area. Randomness is seeded.
 *
 * With `rotation`, `scale` or `mirror` it is Generalized PatchMatch (Barnes et al. 2010): a
 * match also carries an angle, a scale and a reflection, the source patch is sampled
 * (bilinearly) through them, and propagation and random search explore them too — so a
 * curve can continue along its own bend, or a pattern at another size. Content-Aware Fill's
 * Rotation Adaptation, Scale and Mirror.
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
  /** Largest rotation a source patch may have, radians (0: none). */
  rotation?: number;
  /** Source patches may be scaled (0.7…1.4). */
  scale?: boolean;
  /** Source patches may be mirrored. */
  mirror?: boolean;
}

const SCALE_MIN = 0.7;
const SCALE_MAX = 1.4;

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

  // The field carried between levels: source x, y, angle, scale, flip per pixel.
  const NNF = 5;
  let nnf: Float64Array | null = null;
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
    const sx = new Float64Array(T);
    const sy = new Float64Array(T);
    const ta = new Float64Array(T);
    const tsc = new Float64Array(T).fill(1);
    const tfl = new Uint8Array(T);
    const dist = new Float32Array(T);
    const maxRot = Math.max(0, opts.rotation ?? 0);
    const generic = maxRot > 0 || !!opts.scale || !!opts.mirror;
    // A transformed patch reaches further than R: it must fit inside, and clear of the hole.
    const validT = (x: number, y: number, sc: number) => {
      if (!generic) return valid(x, y);
      const r = Math.ceil(R * sc * 1.42);
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= r + 1 && yi >= r + 1 && xi < W - r - 1 && yi < H - r - 1 && boxSum(badSum, xi - r, yi - r, xi + r + 1, yi + r + 1) === 0;
    };
    /** Bilinear RGB of the level's image at (x, y), into `out`. */
    const px3 = new Float32Array(3);
    const sample = (x: number, y: number) => {
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
      const fx = x - x0;
      const fy = y - y0;
      const a = (y0 * W + x0) * 3;
      const b = a + 3;
      const c = a + W * 3;
      const d = c + 3;
      for (let ch = 0; ch < 3; ch++) px3[ch] = (I[a + ch]! * (1 - fx) + I[b + ch]! * fx) * (1 - fy) + (I[c + ch]! * (1 - fx) + I[d + ch]! * fx) * fy;
      return px3;
    };
    /** Where offset (dx, dy) of target k's patch lands in its source, under k's transform. */
    const mapOffset = (angle: number, sc: number, flip: number, dx: number, dy: number): [number, number] => {
      const fx = flip ? -dx : dx;
      const c = Math.cos(angle) * sc;
      const s = Math.sin(angle) * sc;
      return [c * fx - s * dy, s * fx + c * dy];
    };
    // Generalized patch distance: the source sampled through the transform.
    const DT = (k: number, x: number, y: number, angle: number, sc: number, flip: number, limit: number) => {
      let sum = 0;
      let n = 0;
      const cx = tx[k]!;
      const cy = ty[k]!;
      const c = Math.cos(angle) * sc;
      const s = Math.sin(angle) * sc;
      for (let dy = -R; dy <= R; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= W) continue;
          const fdx = flip ? -dx : dx;
          const v = sample(x + c * fdx - s * dy, y + s * fdx + c * dy);
          const a = (py * W + px) * 3;
          const d0 = I[a]! - v[0]!;
          const d1 = I[a + 1]! - v[1]!;
          const d2 = I[a + 2]! - v[2]!;
          sum += d0 * d0 + d1 * d1 + d2 * d2;
          n++;
        }
        if (sum > limit * n) return Infinity;
      }
      return n ? sum / n : Infinity;
    };
    // Patch distance: sum of squared differences over the in-bounds part of the target patch.
    const D0 = (k: number, x: number, y: number, limit: number) => {
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
    const D = (k: number, x: number, y: number, limit: number, angle = 0, sc = 1, flip = 0) =>
      generic ? DT(k, x, y, angle, sc, flip, limit) : D0(k, x, y, limit);
    // Initial field: carried up from the coarser level where it still lands on a valid source,
    // random elsewhere.
    for (let k = 0; k < T; k++) {
      let x = -1;
      let y = -1;
      let angle = 0;
      let sc = 1;
      let flip = 0;
      if (nnf && prevW) {
        const cx = tx[k]! >> 1;
        const cy = ty[k]! >> 1;
        const o = (cy * prevW + cx) * NNF;
        if (nnf[o]! >= 0) {
          angle = nnf[o + 2]!;
          sc = nnf[o + 3]!;
          flip = nnf[o + 4]!;
          // The coarse match, doubled, plus this pixel's place within its coarse cell.
          const [ox, oy] = mapOffset(angle, sc, flip, tx[k]! & 1, ty[k]! & 1);
          x = nnf[o]! * 2 + ox;
          y = nnf[o + 1]! * 2 + oy;
          if (!generic) {
            x = Math.min(W - R - 1, Math.round(x));
            y = Math.min(H - R - 1, Math.round(y));
          }
        }
      }
      if (x < 0 || !validT(x, y, sc)) {
        angle = 0;
        sc = 1;
        flip = 0;
        // A random source; with transforms, one far enough in for a turned patch.
        for (let tries = 0; tries < 32; tries++) {
          const p = sources[Math.floor(rand() * sources.length)]!;
          x = p % W;
          y = (p - x) / W;
          if (validT(x, y, 1)) break;
        }
      }
      sx[k] = x;
      sy[k] = y;
      ta[k] = angle;
      tsc[k] = sc;
      tfl[k] = flip;
      dist[k] = D(k, x, y, Infinity, angle, sc, flip);
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
            // The neighbour's source, stepped back through the neighbour's own transform.
            const [ox, oy] = mapOffset(ta[n]!, tsc[n]!, tfl[n]!, cx - nx, cy - ny);
            const x = sx[n]! + ox;
            const y = sy[n]! + oy;
            if ((x === sx[k] && y === sy[k] && ta[n] === ta[k] && tsc[n] === tsc[k] && tfl[n] === tfl[k]) || !validT(x, y, tsc[n]!)) continue;
            const dd = D(k, x, y, dist[k]!, ta[n]!, tsc[n]!, tfl[n]!);
            if (dd < dist[k]!) {
              dist[k] = dd;
              sx[k] = x;
              sy[k] = y;
              ta[k] = ta[n]!;
              tsc[k] = tsc[n]!;
              tfl[k] = tfl[n]!;
            }
          }
          // Random search around the current best, halving the window.
          const full = Math.max(W, H);
          for (let rad = full; rad >= 1; rad >>= 1) {
            const x = Math.round(sx[k]! + (rand() * 2 - 1) * rad);
            const y = Math.round(sy[k]! + (rand() * 2 - 1) * rad);
            // The transform is searched in the same shrinking window.
            const shrink = rad / full;
            const angle = maxRot > 0 ? Math.max(-maxRot, Math.min(maxRot, ta[k]! + (rand() * 2 - 1) * maxRot * shrink)) : 0;
            const sc = opts.scale ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, tsc[k]! * Math.exp((rand() * 2 - 1) * 0.35 * shrink))) : 1;
            const flip = opts.mirror && rand() < 0.5 * shrink ? 1 - tfl[k]! : tfl[k]!;
            if (!validT(x, y, sc)) continue;
            const dd = D(k, x, y, dist[k]!, angle, sc, flip);
            if (dd < dist[k]!) {
              dist[k] = dd;
              sx[k] = x;
              sy[k] = y;
              ta[k] = angle;
              tsc[k] = sc;
              tfl[k] = flip;
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
            let r: number;
            let g: number;
            let bl: number;
            if (generic) {
              const [ox, oy] = mapOffset(ta[k]!, tsc[k]!, tfl[k]!, dx, dy);
              const v = sample(sx[k]! + ox, sy[k]! + oy);
              r = v[0]!;
              g = v[1]!;
              bl = v[2]!;
            } else {
              const b = ((sy[k]! + dy) * W + (sx[k]! + dx)) * 3;
              r = I[b]!;
              g = I[b + 1]!;
              bl = I[b + 2]!;
            }
            acc[p * 4] = acc[p * 4]! + r * wgt;
            acc[p * 4 + 1] = acc[p * 4 + 1]! + g * wgt;
            acc[p * 4 + 2] = acc[p * 4 + 2]! + bl * wgt;
            acc[p * 4 + 3] = acc[p * 4 + 3]! + wgt;
          }
        }
      }
      for (let p = 0; p < W * H; p++) {
        if (!L.hole[p] || acc[p * 4 + 3]! <= 0) continue;
        for (let c = 0; c < 3; c++) I[p * 3 + c] = acc[p * 4 + c]! / acc[p * 4 + 3]!;
      }
      for (let k = 0; k < T; k++) dist[k] = D(k, sx[k]!, sy[k]!, Infinity, ta[k]!, tsc[k]!, tfl[k]!);
    }
    // Carry the field and the filled hole up to the next finer level.
    const field = new Float64Array(W * H * NNF).fill(-1);
    for (let k = 0; k < T; k++) {
      const p = (ty[k]! * W + tx[k]!) * NNF;
      field[p] = sx[k]!;
      field[p + 1] = sy[k]!;
      field[p + 2] = ta[k]!;
      field[p + 3] = tsc[k]!;
      field[p + 4] = tfl[k]!;
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
