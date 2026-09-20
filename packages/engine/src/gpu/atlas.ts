/**
 * Paged tile atlas with LRU residency.
 *
 * Tiles are packed 8×8 into 2048×2048 *pages*, and the pages form one TEXTURE_2D_ARRAY.
 * Slicing one tile per array layer is the obvious design but does not survive contact with
 * `MAX_ARRAY_TEXTURE_LAYERS`, which is 2048 on mainstream hardware: a 100-layer 4K document
 * needs ~2400 resident tiles when zoomed to fit, so a one-tile-per-layer atlas thrashes and
 * collapses to single-digit fps. Paging raises the ceiling to 64 × pages tiles.
 *
 * Pages are allocated lazily and the array grows by doubling, because `texStorage3D` commits
 * its memory up front — a blank document must not reserve a gigabyte of VRAM. Growth is cheap
 * to recover from: the CPU tile store is authoritative, so the new array starts empty and
 * refills on demand (spec 03 §4.2).
 */
import { TILE_SIZE } from '@umbra/core/pixels';
import type { Tile } from '../tiles/plane.js';
import type { GpuCaps } from './caps.js';

/** Tiles per page edge. 8 × 256 = 2048, within every device's MAX_TEXTURE_SIZE. */
export const PAGE_TILES = 8;
export const PAGE_SIZE = PAGE_TILES * TILE_SIZE;
export const TILES_PER_PAGE = PAGE_TILES * PAGE_TILES;
const PAGE_BYTES = PAGE_SIZE * PAGE_SIZE * 4;

interface Slot {
  slot: number;
  tile: Tile;
  lastUsed: number;
}

export interface AtlasStats {
  capacity: number;
  pages: number;
  resident: number;
  uploads: number;
  evictions: number;
  /** Evictions of tiles still needed later in the same frame — the thrash signal. */
  thrash: number;
  bytes: number;
}

export class TileAtlas {
  private texture: WebGLTexture | null = null;
  private pages = 0;
  private readonly maxPages: number;
  private readonly slots = new Map<Tile, Slot>();
  private free: number[] = [];
  /**
   * Incremented per draw batch (per layer), not per frame: a tile is only sampled by its own
   * layer's draw call, so afterwards its slot may be recycled.
   */
  private epoch = 0;
  private frameStartEpoch = 0;
  private uploads = 0;
  private evictions = 0;
  private thrash = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    caps: GpuCaps,
    /** VRAM ceiling for tile storage, in bytes. */
    budgetBytes = 1024 * 1024 * 1024,
    initialPages = 2,
  ) {
    const hardMax = Math.min(caps.maxArrayLayers, Math.floor(budgetBytes / PAGE_BYTES));
    this.maxPages = Math.max(1, hardMax);
    this.allocate(Math.min(initialPages, this.maxPages));
  }

  private allocate(pages: number): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE_SIZE, PAGE_SIZE, pages);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    // Magnification is NEAREST so zooming in shows hard pixels, as Photoshop does.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = tex;
    this.pages = pages;
    this.slots.clear();
    this.free = [];
    for (let i = pages * TILES_PER_PAGE - 1; i >= 0; i--) this.free.push(i);
  }

  /** Try to double the page count; returns false once the budget is reached. */
  private grow(): boolean {
    if (this.pages >= this.maxPages) return false;
    const next = Math.min(this.pages * 2, this.maxPages);
    // The CPU tile store is the source of truth, so dropping everything is safe.
    this.allocate(next);
    return true;
  }

  get capacity(): number {
    return this.pages * TILES_PER_PAGE;
  }

  /** Called after a context restore: everything on the GPU is gone. */
  reset(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.texture = null;
    this.allocate(this.pages);
  }

  beginFrame(): void {
    this.epoch++;
    this.frameStartEpoch = this.epoch;
  }

  /** Start a new draw batch; slots last touched before this batch become evictable. */
  beginBatch(): void {
    this.epoch++;
  }

  get textureHandle(): WebGLTexture {
    if (!this.texture) throw new Error('TileAtlas: texture unavailable (context lost?)');
    return this.texture;
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }

  /** Slot index holding `tile`, uploading, growing or evicting as needed. */
  acquire(tile: Tile): number {
    const existing = this.slots.get(tile);
    if (existing) {
      existing.lastUsed = this.epoch;
      return existing.slot;
    }

    let slot = this.free.pop();
    if (slot === undefined) {
      // Prefer more VRAM over thrashing, until the budget says stop.
      if (this.canEvictCleanly() || !this.grow()) slot = this.evictLeastRecentlyUsed();
      else slot = this.free.pop()!;
    }

    this.upload(slot, tile);
    this.slots.set(tile, { slot, tile, lastUsed: this.epoch });
    return slot;
  }

  /** True when eviction would not disturb a tile already uploaded this frame. */
  private canEvictCleanly(): boolean {
    for (const s of this.slots.values()) if (s.lastUsed < this.frameStartEpoch) return true;
    return false;
  }

  /** Re-upload a tile whose pixels were changed in place by a live stroke. */
  invalidate(tile: Tile): void {
    const slot = this.slots.get(tile);
    if (slot) this.upload(slot.slot, tile);
  }

  /** Page index and pixel offset of a slot, for both upload and render-into-slot passes. */
  static locate(slot: number): { page: number; x: number; y: number } {
    const page = Math.floor(slot / TILES_PER_PAGE);
    const cell = slot % TILES_PER_PAGE;
    return {
      page,
      x: (cell % PAGE_TILES) * TILE_SIZE,
      y: Math.floor(cell / PAGE_TILES) * TILE_SIZE,
    };
  }

  private upload(slot: number, tile: Tile): void {
    const gl = this.gl;
    const { page, x, y } = TileAtlas.locate(slot);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data = tile.uniform ? tile.expand() : tile.data;
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      x,
      y,
      page,
      TILE_SIZE,
      TILE_SIZE,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data as Uint8Array,
    );
    this.uploads++;
  }

  private evictLeastRecentlyUsed(): number {
    let victim: Slot | null = null;
    for (const s of this.slots.values()) {
      // A tile acquired for the batch being assembled right now has not been drawn yet.
      if (s.lastUsed >= this.epoch) continue;
      if (!victim || s.lastUsed < victim.lastUsed) victim = s;
    }
    if (!victim) {
      throw new Error(
        `TileAtlas: all ${this.capacity} slots are pinned by the current draw batch; ` +
          'a single layer needs more tiles than the atlas can hold at this zoom',
      );
    }
    if (victim.lastUsed >= this.frameStartEpoch) this.thrash++;
    this.slots.delete(victim.tile);
    this.evictions++;
    return victim.slot;
  }

  stats(): AtlasStats {
    return {
      capacity: this.capacity,
      pages: this.pages,
      resident: this.slots.size,
      uploads: this.uploads,
      evictions: this.evictions,
      thrash: this.thrash,
      bytes: this.pages * PAGE_BYTES,
    };
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.slots.clear();
  }
}
