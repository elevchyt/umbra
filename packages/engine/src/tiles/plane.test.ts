import { describe, expect, it } from 'vitest';
import { TILE_SIZE, tileKey, tileKeyX, tileKeyY } from '@umbra/core/pixels';
import { Plane, Tile, tilesInRect } from './plane.js';
import { downsample, levelForScale, MipPlane, tileSpan } from './mip.js';
import { RGBA8 } from './import.js';

function fill(px: { [i: number]: number; length: number }, r: number, g: number, b: number, a: number) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
}

describe('tile keys', () => {
  it('round-trips signed coordinates', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 2],
      [-1, -1],
      [-5000, 4000],
      [123456, -98765],
    ] as const) {
      const k = tileKey(x, y);
      expect([tileKeyX(k), tileKeyY(k)]).toEqual([x, y]);
    }
  });

  it('is collision-free across a range of coordinates', () => {
    const seen = new Set<number>();
    for (let x = -40; x <= 40; x++) {
      for (let y = -40; y <= 40; y++) {
        const k = tileKey(x, y);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('Plane copy-on-write', () => {
  it('leaves the source plane untouched when a writer commits', () => {
    const base = Plane.empty(RGBA8);
    const w = base.writer();
    const px = w.mutable(0, 0);
    px[0] = 200;
    px[3] = 255;
    const next = w.commit();

    expect(base.tileCount).toBe(0);
    expect(next.tileCount).toBe(1);

    const probe = new Uint8Array(4);
    next.readPixel(0, 0, probe);
    expect([...probe]).toEqual([200, 0, 0, 255]);
    base.readPixel(0, 0, probe);
    expect([...probe]).toEqual([0, 0, 0, 0]);
  });

  it('shares untouched tiles by identity instead of copying them', () => {
    const w = Plane.empty(RGBA8).writer();
    fill(w.mutable(0, 0), 1, 2, 3, 255);
    fill(w.mutable(5, 5), 9, 9, 9, 255);
    const a = w.commit();

    const shared = a.tileAt(0, 0);
    const w2 = a.writer();
    fill(w2.mutable(5, 5), 7, 7, 7, 255);
    const b = w2.commit();

    expect(b.tileAt(0, 0)).toBe(shared);
    expect(b.tileAt(5, 5)).not.toBe(a.tileAt(5, 5));
  });

  it('reuses the same tile object across repeated writes within one transaction', () => {
    const w = Plane.empty(RGBA8).writer();
    const first = w.mutableTile(2, 3);
    const second = w.mutableTile(2, 3);
    expect(second).toBe(first);
  });

  it('collapses a uniformly-painted tile back to a single pixel', () => {
    const w = Plane.empty(RGBA8).writer();
    fill(w.mutable(0, 0), 10, 20, 30, 255);
    const tile = w.commit().tileAt(0, 0);
    expect(tile.uniform).toBe(true);
    expect(tile.data.length).toBe(4);
  });

  it('drops a tile that was erased back to transparency', () => {
    const w = Plane.empty(RGBA8).writer();
    fill(w.mutable(0, 0), 10, 20, 30, 255);
    const painted = w.commit();
    expect(painted.tileCount).toBe(1);

    const w2 = painted.writer();
    fill(w2.mutable(0, 0), 0, 0, 0, 0);
    expect(w2.commit().tileCount).toBe(0);
  });

  it('reports a dirty rect covering exactly the touched tiles', () => {
    const w = Plane.empty(RGBA8).writer();
    w.mutable(1, 1);
    w.mutable(2, 3);
    expect(w.dirtyRect).toEqual({
      x0: TILE_SIZE,
      y0: TILE_SIZE,
      x1: 3 * TILE_SIZE,
      y1: 4 * TILE_SIZE,
    });
  });

  it('expands a uniform tile to a full buffer with every pixel equal', () => {
    const t = Tile.uniform(RGBA8, [4, 5, 6, 7]);
    const full = t.expand();
    expect(full.length).toBe(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < full.length; i += 4) {
      expect([full[i], full[i + 1], full[i + 2], full[i + 3]]).toEqual([4, 5, 6, 7]);
    }
  });
});

describe('mip pyramid', () => {
  it('averages coverage without letting colour bleed from transparent pixels', () => {
    const w = Plane.empty(RGBA8).writer();
    const px = w.mutable(0, 0);
    // Top half opaque red, bottom half fully transparent.
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const o = (y * TILE_SIZE + x) * 4;
        px[o] = 255;
        px[o + 3] = y < TILE_SIZE / 2 ? 255 : 0;
      }
    }
    const half = downsample(w.commit());
    const probe = new Uint8Array(4);
    half.readPixel(0, 0, probe);
    // Colour must stay saturated; only alpha carries the reduced coverage.
    expect(probe[0]).toBe(255);
    expect(probe[3]).toBe(255);
  });

  it('halves alpha across a half-covered 2x2 block', () => {
    const w = Plane.empty(RGBA8).writer();
    const px = w.mutable(0, 0);
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const o = (y * TILE_SIZE + x) * 4;
        px[o] = 255;
        px[o + 3] = x % 2 === 0 ? 255 : 0;
      }
    }
    const probe = new Uint8Array(4);
    downsample(w.commit()).readPixel(0, 0, probe);
    expect(probe[3]).toBeCloseTo(128, -1);
    expect(probe[0]).toBe(255);
  });

  it('keeps an all-transparent plane empty at every level', () => {
    const pyramid = new MipPlane(Plane.empty(RGBA8));
    for (let l = 0; l < 5; l++) expect(pyramid.level(l).tileCount).toBe(0);
  });

  it('picks the level whose resolution still covers the requested scale', () => {
    expect(levelForScale(1, 8)).toBe(0);
    expect(levelForScale(2, 8)).toBe(0);
    expect(levelForScale(0.6, 8)).toBe(0);
    expect(levelForScale(0.5, 8)).toBe(1);
    expect(levelForScale(0.25, 8)).toBe(2);
    expect(levelForScale(0.001, 8)).toBe(8); // clamped to maxLevel
  });

  it('doubles the document span covered by a tile at each level', () => {
    expect(tileSpan(0)).toBe(TILE_SIZE);
    expect(tileSpan(3)).toBe(TILE_SIZE * 8);
  });
});

describe('tilesInRect', () => {
  it('covers every tile the rect touches', () => {
    const cells = [...tilesInRect({ x0: 0, y0: 0, x1: TILE_SIZE + 1, y1: 1 })];
    expect(cells).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
    ]);
  });

  it('yields nothing for an empty rect', () => {
    expect([...tilesInRect({ x0: 5, y0: 5, x1: 5, y1: 9 })]).toEqual([]);
  });

  it('handles negative coordinates', () => {
    expect([...tilesInRect({ x0: -1, y0: -1, x1: 1, y1: 1 })]).toEqual([
      { tx: -1, ty: -1 },
      { tx: 0, ty: -1 },
      { tx: -1, ty: 0 },
      { tx: 0, ty: 0 },
    ]);
  });
});

describe('copy-on-write aliasing', () => {
  it('does not write through to a tile shared by another cell', () => {
    // Planes share Tile objects freely — the synthetic benchmark document repeats one tile
    // along diagonals, a duplicated layer shares every tile with its original, and the mip
    // cache shares one downsampled tile between identical neighbourhoods. Writing one cell
    // must not reach any of the others.
    const w = Plane.empty(RGBA8).writer();
    const px = w.mutable(0, 0);
    // Non-uniform, or commit() collapses it to a one-pixel tile and expand() would allocate.
    px.fill(200);
    px[0] = 1;
    const plane = w.commit();
    const shared = plane.tileAt(0, 0);
    const withAlias = Plane._commit(
      plane,
      new Map([
        [tileKey(0, 0), shared],
        [tileKey(5, 3), shared],
      ]),
    );

    const w2 = withAlias.writer();
    // A single pixel, so the tile stays full and commit() does not collapse it away.
    w2.mutable(0, 0)[4] = 7;
    const after = w2.commit();

    expect(after.tileAt(0, 0).data[4]).toBe(7);
    expect(after.tileAt(5, 3).data[4]).toBe(200);
    expect(shared.data[4]).toBe(200);
  });

  it('gives each writer its own buffer when two writers start from one plane', () => {
    const w = Plane.empty(RGBA8).writer();
    const p0 = w.mutable(1, 1);
    p0.fill(100);
    p0[0] = 1;
    const base = w.commit();

    const a = base.writer();
    const b = base.writer();
    a.mutable(1, 1)[4] = 1;
    b.mutable(1, 1)[4] = 2;

    expect(a.commit().tileAt(1, 1).data[4]).toBe(1);
    expect(b.commit().tileAt(1, 1).data[4]).toBe(2);
    expect(base.tileAt(1, 1).data[4]).toBe(100);
  });
});
