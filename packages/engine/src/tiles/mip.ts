/**
 * Lazy mip pyramid per plane — Photoshop's "cache levels". Zooming out composites from the
 * smallest level whose resolution still meets the target, which is what keeps a 100-layer
 * document at 60 fps when zoomed to fit (spec 03 §4.2).
 *
 * Level L has half the resolution of L-1, so one level-L tile covers a 2×2 block of level-L-1
 * tiles. Downsampling runs on premultiplied alpha and un-premultiplies on the way out, so
 * transparent pixels never bleed their colour into the average.
 */
import { TILE_SIZE, channelCount, maxValue, type PlaneFormat } from '@umbra/core/pixels';
import { Plane, Tile, tilesInRect } from './plane.js';
import type { Rect } from '@umbra/core/geom';

export const MAX_MIP_LEVELS = 12;

/** Document pixels covered by one tile at the given level. */
export function tileSpan(level: number): number {
  return TILE_SIZE * (1 << level);
}

/** Smallest level whose resolution is still at or above `scale` (screen px per doc px). */
export function levelForScale(scale: number, maxLevel: number): number {
  if (scale >= 1) return 0;
  const l = Math.floor(Math.log2(1 / Math.max(scale, 1e-6)));
  return Math.max(0, Math.min(maxLevel, l));
}

export class MipPlane {
  /** levels[0] is full resolution; higher entries are built on demand. */
  private readonly levels: (Plane | null)[] = [];

  constructor(base: Plane, readonly maxLevel = MAX_MIP_LEVELS) {
    this.levels[0] = base;
  }

  get base(): Plane {
    return this.levels[0]!;
  }

  get format(): PlaneFormat {
    return this.base.format;
  }

  /** Replace level 0 and drop cached levels intersecting `dirty` (all of them, for now). */
  withBase(next: Plane, _dirty?: Rect): MipPlane {
    return new MipPlane(next, this.maxLevel);
  }

  level(l: number): Plane {
    const clamped = Math.max(0, Math.min(l, this.maxLevel));
    for (let i = 1; i <= clamped; i++) {
      if (!this.levels[i]) this.levels[i] = downsample(this.levels[i - 1]!);
    }
    return this.levels[clamped]!;
  }

  /** Levels already materialised, for stats. */
  get builtLevels(): number {
    return this.levels.filter(Boolean).length;
  }
}

/**
 * Results are memoised on the identity AND revision of the four source tiles. Downsampling is
 * a pure function of their pixels, and documents repeat tile combinations constantly (flat
 * colour, shared layers, empty regions), so this keeps the pyramid's memory close to the
 * number of DISTINCT 2x2 neighbourhoods rather than the number of tile positions.
 */
const mipCache = new Map<string, Tile>();
const MIP_CACHE_LIMIT = 4096;

/** Box-downsample a plane by 2 in each axis. */
export function downsample(src: Plane): Plane {
  const fmt = src.format;
  const n = channelCount(fmt.layout);
  const out = Plane.empty(fmt, fmt.layout === 'A' ? undefined : undefined).writer();
  const half = TILE_SIZE >> 1;

  // Each destination tile gathers the 2×2 source tiles beneath it.
  const seen = new Set<number>();
  for (const { tx, ty } of tilesInRect(src.bounds)) {
    const dtx = tx >> 1;
    const dty = ty >> 1;
    const key = dtx * 1e6 + dty;
    if (seen.has(key)) continue;
    seen.add(key);

    const quads = [
      src.tileAt(dtx * 2, dty * 2),
      src.tileAt(dtx * 2 + 1, dty * 2),
      src.tileAt(dtx * 2, dty * 2 + 1),
      src.tileAt(dtx * 2 + 1, dty * 2 + 1),
    ];
    if (quads.every((q) => q.uniform && q === quads[0])) {
      // All four identical uniform tiles average to the same uniform tile.
      if (!quads[0]!.isTransparent()) out.put(dtx, dty, quads[0]!);
      continue;
    }

    // `rev` is part of the key: a tile being painted keeps its identity while its pixels
    // change, so identity alone would serve a stale downsample of the pre-stroke tile.
    const cacheKey = quads.map((q) => `${q!.id}.${q!.rev}`).join(',');
    const hit = mipCache.get(cacheKey);
    if (hit) {
      out.put(dtx, dty, hit);
      continue;
    }

    const built = out.mutableTile(dtx, dty);
    for (let q = 0; q < 4; q++) {
      const tile = quads[q]!;
      const ox = (q & 1) * half;
      const oy = (q >> 1) * half;
      reduceTileInto(tile, built.data, ox, oy, fmt, n);
    }
    if (mipCache.size >= MIP_CACHE_LIMIT) mipCache.clear();
    mipCache.set(cacheKey, built);
  }
  return out.commit();
}

function reduceTileInto(
  tile: Tile,
  dst: ArrayLike<number> & { [i: number]: number },
  ox: number,
  oy: number,
  fmt: PlaneFormat,
  n: number,
): void {
  const half = TILE_SIZE >> 1;
  if (tile.uniform) {
    for (let y = 0; y < half; y++) {
      let o = ((oy + y) * TILE_SIZE + ox) * n;
      for (let x = 0; x < half; x++) {
        for (let c = 0; c < n; c++) dst[o + c] = tile.data[c]!;
        o += n;
      }
    }
    return;
  }

  const src = tile.data;
  const hasAlpha = fmt.layout !== 'A';
  const alphaIdx = n - 1;
  const maxV = maxValue(fmt.sample);

  for (let y = 0; y < half; y++) {
    const sy0 = y * 2;
    for (let x = 0; x < half; x++) {
      const sx0 = x * 2;
      const i00 = (sy0 * TILE_SIZE + sx0) * n;
      const i10 = i00 + n;
      const i01 = i00 + TILE_SIZE * n;
      const i11 = i01 + n;
      const d = ((oy + y) * TILE_SIZE + (ox + x)) * n;

      const a0 = src[i00 + alphaIdx]!;
      const a1 = src[i10 + alphaIdx]!;
      const a2 = src[i01 + alphaIdx]!;
      const a3 = src[i11 + alphaIdx]!;
      const aSum = a0 + a1 + a2 + a3;

      if (!hasAlpha) {
        dst[d] = (aSum + 2) / 4;
        continue;
      }
      if (aSum === 0) {
        for (let c = 0; c < n; c++) dst[d + c] = 0;
        continue;
      }
      // Weighted by alpha == averaging premultiplied values, then un-premultiplying.
      for (let c = 0; c < alphaIdx; c++) {
        const s =
          src[i00 + c]! * a0 + src[i10 + c]! * a1 + src[i01 + c]! * a2 + src[i11 + c]! * a3;
        const v = s / aSum;
        dst[d + c] = fmt.sample === 'f32' ? v : Math.round(v);
      }
      const a = aSum / 4;
      dst[d + alphaIdx] = fmt.sample === 'f32' ? a : Math.min(maxV, Math.round(a));
    }
  }
}
