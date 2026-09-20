/**
 * Sparse, immutable, tiled raster storage.
 *
 * A `Plane` is a persistent value: writing produces a NEW Plane that shares every untouched
 * tile with the old one. That is what makes undo O(changed tiles) and layer duplication free
 * (spec 03 §4.1, §6).
 *
 * Tiles are immutable objects, so sharing is safe and needs no reference counting — the JS
 * GC owns tile lifetime. To mutate, open a `PlaneWriter`: it clones each touched tile once,
 * lets the caller scribble on it freely for the duration of an interactive operation (a brush
 * stroke, a filter pass), then commits a new Plane. That matches Photoshop's model where one
 * stroke is one history state.
 */
import {
  TILE_SIZE,
  TILE_SHIFT,
  TILE_PIXELS,
  allocTile,
  bytesPerPixel,
  channelCount,
  tileKey,
  tileKeyX,
  tileKeyY,
  tileIndex,
  viewOf,
  type PlaneFormat,
  type TypedPixels,
} from '@umbra/core/pixels';
import { EMPTY_RECT, rectUnion, type Rect } from '@umbra/core/geom';

let nextTileId = 1;

/** Live tile bytes, for the memory budget. Decremented when a tile is collected. */
class MemoryAccountant {
  liveBytes = 0;
  allocatedTiles = 0;
  private readonly reg = new FinalizationRegistry<number>((bytes) => {
    this.liveBytes -= bytes;
  });
  track(tile: Tile, bytes: number): void {
    this.liveBytes += bytes;
    this.allocatedTiles++;
    this.reg.register(tile, bytes);
  }
}

export const tileMemory = new MemoryAccountant();

/**
 * One 256×256 block. `uniform` tiles store a single pixel and expand on demand, which is how
 * a blank 8000×8000 layer costs a few hundred bytes rather than 256 MB.
 */
export class Tile {
  readonly id = nextTileId++;
  constructor(
    readonly format: PlaneFormat,
    readonly data: TypedPixels,
    readonly uniform: boolean,
  ) {
    tileMemory.track(this, data.byteLength);
  }

  static uniform(format: PlaneFormat, pixel: ArrayLike<number>): Tile {
    const px = viewOf(format, new ArrayBuffer(bytesPerPixel(format)));
    px.set(pixel as never);
    return new Tile(format, px, true);
  }

  static transparent(format: PlaneFormat): Tile {
    return Tile.uniform(format, new Array(channelCount(format.layout)).fill(0));
  }

  /** Materialise a full 256×256 buffer, expanding a uniform tile if needed. */
  expand(): TypedPixels {
    if (!this.uniform) return this.data;
    const n = channelCount(this.format.layout);
    const out = allocTile(this.format);
    // Fill the first pixel, then double the written run until the tile is full.
    for (let c = 0; c < n; c++) out[c] = this.data[c]!;
    let filled = 1;
    while (filled < TILE_PIXELS) {
      const take = Math.min(filled, TILE_PIXELS - filled);
      out.copyWithin(filled * n, 0, take * n);
      filled += take;
    }
    return out;
  }

  isTransparent(): boolean {
    if (!this.uniform) return false;
    const n = channelCount(this.format.layout);
    return this.data[n - 1] === 0;
  }
}

export interface PlaneStats {
  tiles: number;
  uniformTiles: number;
  bytes: number;
}

export class Plane {
  /** Tile-granular bounds in document pixels; empty when the plane has no tiles. */
  readonly bounds: Rect;

  private constructor(
    readonly format: PlaneFormat,
    /** Sparse map: packed tile key → tile. Absent means "default value everywhere". */
    readonly tiles: ReadonlyMap<number, Tile>,
    /** Value returned for absent tiles — transparent for layers, a constant for masks. */
    readonly defaultTile: Tile,
    bounds?: Rect,
  ) {
    this.bounds = bounds ?? Plane.computeBounds(tiles);
  }

  static empty(format: PlaneFormat, defaultPixel?: ArrayLike<number>): Plane {
    const def = defaultPixel ? Tile.uniform(format, defaultPixel) : Tile.transparent(format);
    return new Plane(format, new Map(), def);
  }

  private static computeBounds(tiles: ReadonlyMap<number, Tile>): Rect {
    let r: Rect = EMPTY_RECT;
    for (const key of tiles.keys()) {
      const tx = tileKeyX(key);
      const ty = tileKeyY(key);
      r = rectUnion(r, {
        x0: tx << TILE_SHIFT,
        y0: ty << TILE_SHIFT,
        x1: (tx + 1) << TILE_SHIFT,
        y1: (ty + 1) << TILE_SHIFT,
      });
    }
    return r;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** The tile covering tile-grid cell (tx,ty), or the plane default. */
  tileAt(tx: number, ty: number): Tile {
    return this.tiles.get(tileKey(tx, ty)) ?? this.defaultTile;
  }

  hasTile(tx: number, ty: number): boolean {
    return this.tiles.has(tileKey(tx, ty));
  }

  /** Read one pixel into `out` (length = channel count). Coordinates are document pixels. */
  readPixel(x: number, y: number, out: TypedPixels): void {
    const tile = this.tileAt(tileIndex(x), tileIndex(y));
    const n = channelCount(this.format.layout);
    if (tile.uniform) {
      for (let c = 0; c < n; c++) out[c] = tile.data[c]!;
      return;
    }
    const lx = x - (tileIndex(x) << TILE_SHIFT);
    const ly = y - (tileIndex(y) << TILE_SHIFT);
    const off = (ly * TILE_SIZE + lx) * n;
    for (let c = 0; c < n; c++) out[c] = tile.data[off + c]!;
  }

  writer(): PlaneWriter {
    return new PlaneWriter(this);
  }

  /** Replace the tile map wholesale (used by importers that build a plane in one pass). */
  static fromTiles(
    format: PlaneFormat,
    entries: Iterable<readonly [number, Tile]>,
    defaultPixel?: ArrayLike<number>,
  ): Plane {
    const def = defaultPixel ? Tile.uniform(format, defaultPixel) : Tile.transparent(format);
    return new Plane(format, new Map(entries), def);
  }

  /** Internal: construct a plane from a finished writer. */
  static _commit(base: Plane, tiles: Map<number, Tile>): Plane {
    return new Plane(base.format, tiles, base.defaultTile);
  }

  stats(): PlaneStats {
    let uniform = 0;
    let bytes = 0;
    for (const t of this.tiles.values()) {
      if (t.uniform) uniform++;
      bytes += t.data.byteLength;
    }
    return { tiles: this.tiles.size, uniformTiles: uniform, bytes };
  }
}

/**
 * A mutable transaction over a Plane. Tiles handed out by `mutable()` are exclusively owned
 * by this writer, so callers may write them in place until `commit()`.
 */
export class PlaneWriter {
  private readonly next: Map<number, Tile>;
  /** Tiles cloned by this writer, safe to mutate again without re-cloning. */
  private readonly owned = new Set<number>();
  private dirty: Rect = EMPTY_RECT;

  constructor(private readonly base: Plane) {
    this.next = new Map(base.tiles);
  }

  get dirtyRect(): Rect {
    return this.dirty;
  }

  /** Full 256×256 writable pixels for a tile cell, cloned on first touch. */
  mutable(tx: number, ty: number): TypedPixels {
    const key = tileKey(tx, ty);
    let tile = this.next.get(key);
    if (tile && this.owned.has(key) && !tile.uniform) {
      this.markDirty(tx, ty);
      return tile.data;
    }
    const source = tile ?? this.base.defaultTile;
    const data = source.expand();
    tile = new Tile(this.base.format, data, false);
    this.next.set(key, tile);
    this.owned.add(key);
    this.markDirty(tx, ty);
    return data;
  }

  /**
   * Like `mutable()`, but returns the Tile object itself. Used by passes that address tiles
   * by identity — the GPU atlas keys its slices on the Tile, and a live brush stroke needs a
   * stable, exclusively-owned tile to paint into for the whole stroke.
   */
  mutableTile(tx: number, ty: number): Tile {
    this.mutable(tx, ty);
    return this.next.get(tileKey(tx, ty))!;
  }

  /** Replace a whole tile cell without copying (the caller must not retain `tile`'s buffer). */
  put(tx: number, ty: number, tile: Tile): void {
    const key = tileKey(tx, ty);
    this.next.set(key, tile);
    this.owned.delete(key);
    this.markDirty(tx, ty);
  }

  remove(tx: number, ty: number): void {
    const key = tileKey(tx, ty);
    if (this.next.delete(key)) {
      this.owned.delete(key);
      this.markDirty(tx, ty);
    }
  }

  private markDirty(tx: number, ty: number): void {
    this.dirty = rectUnion(this.dirty, {
      x0: tx << TILE_SHIFT,
      y0: ty << TILE_SHIFT,
      x1: (tx + 1) << TILE_SHIFT,
      y1: (ty + 1) << TILE_SHIFT,
    });
  }

  /**
   * Finish the transaction. Fully-uniform tiles are collapsed back to one pixel so that
   * erasing a region reclaims its memory.
   */
  commit(): Plane {
    for (const key of this.owned) {
      const tile = this.next.get(key);
      if (!tile || tile.uniform) continue;
      const collapsed = collapseUniform(tile);
      if (collapsed) {
        if (collapsed.isTransparent() && this.base.defaultTile.isTransparent()) {
          this.next.delete(key);
        } else {
          this.next.set(key, collapsed);
        }
      }
    }
    return Plane._commit(this.base, this.next);
  }
}

/** Return a uniform tile if every pixel is identical, else null. */
function collapseUniform(tile: Tile): Tile | null {
  const n = channelCount(tile.format.layout);
  const d = tile.data;
  for (let c = 0; c < n; c++) {
    const v = d[c]!;
    for (let i = c; i < TILE_PIXELS * n; i += n) {
      if (d[i] !== v) return null;
    }
  }
  return Tile.uniform(tile.format, d.subarray(0, n));
}

/** Iterate the tile cells covering a document-space rect. */
export function* tilesInRect(r: Rect): Generator<{ tx: number; ty: number }> {
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
  const tx0 = tileIndex(Math.floor(r.x0));
  const ty0 = tileIndex(Math.floor(r.y0));
  const tx1 = tileIndex(Math.ceil(r.x1) - 1);
  const ty1 = tileIndex(Math.ceil(r.y1) - 1);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) yield { tx, ty };
  }
}
