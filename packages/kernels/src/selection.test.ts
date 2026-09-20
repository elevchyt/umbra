import { describe, expect, it } from 'vitest';
import {
  border,
  combine,
  contract,
  createMask,
  expand,
  feather,
  grow,
  invert,
  isEmpty,
  magicWand,
  maskBounds,
  maxCoverage,
  rasterizeEllipse,
  rasterizeLine,
  rasterizePolygon,
  rasterizeRect,
  smooth,
  traceBoundary,
  type Mask,
  type MaskSize,
} from './selection.js';

const SIZE: MaskSize = { width: 32, height: 32 };
const at = (m: Mask, x: number, y: number) => m[y * SIZE.width + x]!;
const count = (m: Mask) => m.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0);

describe('mask basics', () => {
  it('starts empty', () => {
    const m = createMask(SIZE.width, SIZE.height);
    expect(isEmpty(m)).toBe(true);
    expect(maskBounds(m, SIZE)).toBeNull();
  });

  it('reports bounds of the selected region', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: 4, y0: 6, x1: 10, y1: 12 });
    expect(maskBounds(m, SIZE)).toEqual({ x0: 4, y0: 6, x1: 10, y1: 12 });
  });

  it('inverts', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: 0, y0: 0, x1: 16, y1: 32 });
    invert(m);
    expect(at(m, 0, 0)).toBe(0);
    expect(at(m, 20, 0)).toBe(255);
  });

  it('reports peak coverage, for the "nothing more than 50% selected" warning', () => {
    const m = createMask(SIZE.width, SIZE.height);
    expect(maxCoverage(m)).toBe(0);
    rasterizeRect(m, SIZE, { x0: 2, y0: 2, x1: 8, y1: 8 });
    expect(maxCoverage(m)).toBe(255);
  });
});

describe('combining selections', () => {
  const rectA = () => {
    const m = createMask(SIZE.width, SIZE.height);
    return rasterizeRect(m, SIZE, { x0: 0, y0: 0, x1: 16, y1: 16 });
  };
  const rectB = () => {
    const m = createMask(SIZE.width, SIZE.height);
    return rasterizeRect(m, SIZE, { x0: 8, y0: 8, x1: 24, y1: 24 });
  };

  it('replaces with new', () => {
    const a = rectA();
    combine(a, rectB(), 'new');
    expect(at(a, 2, 2)).toBe(0);
    expect(at(a, 20, 20)).toBe(255);
  });

  it('unions with add', () => {
    const a = rectA();
    combine(a, rectB(), 'add');
    expect(at(a, 2, 2)).toBe(255);
    expect(at(a, 20, 20)).toBe(255);
  });

  it('removes with subtract', () => {
    const a = rectA();
    combine(a, rectB(), 'subtract');
    expect(at(a, 2, 2)).toBe(255);
    expect(at(a, 10, 10)).toBe(0);
  });

  it('keeps only the overlap with intersect', () => {
    const a = rectA();
    combine(a, rectB(), 'intersect');
    expect(at(a, 2, 2)).toBe(0);
    expect(at(a, 10, 10)).toBe(255);
    expect(at(a, 20, 20)).toBe(0);
  });
});

describe('shape rasterising', () => {
  it('fills a whole-pixel rectangle exactly', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: 4, y0: 4, x1: 8, y1: 8 });
    expect(count(m)).toBe(16);
    expect(at(m, 4, 4)).toBe(255);
    expect(at(m, 7, 7)).toBe(255);
    expect(at(m, 8, 8)).toBe(0);
  });

  it('gives fractional edges partial coverage', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: 4.5, y0: 4, x1: 8, y1: 8 });
    // The half-covered column reads as half selected.
    expect(at(m, 4, 5)).toBeGreaterThan(100);
    expect(at(m, 4, 5)).toBeLessThan(155);
  });

  it('normalises a rectangle dragged backwards', () => {
    const a = createMask(SIZE.width, SIZE.height);
    const b = createMask(SIZE.width, SIZE.height);
    rasterizeRect(a, SIZE, { x0: 4, y0: 4, x1: 12, y1: 12 });
    rasterizeRect(b, SIZE, { x0: 12, y0: 12, x1: 4, y1: 4 });
    expect([...b]).toEqual([...a]);
  });

  it('rasterises an ellipse inside its box with soft edges', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeEllipse(m, SIZE, { x0: 8, y0: 8, x1: 24, y1: 24 });
    // Centre is solid, corners of the bounding box are outside the ellipse.
    expect(at(m, 16, 16)).toBe(255);
    expect(at(m, 8, 8)).toBe(0);
    expect(at(m, 23, 23)).toBe(0);
    // Somewhere on the rim there is partial coverage.
    let partial = 0;
    for (let i = 0; i < m.length; i++) if (m[i]! > 0 && m[i]! < 255) partial++;
    expect(partial).toBeGreaterThan(0);
  });

  it('fills a polygon', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizePolygon(m, SIZE, [
      { x: 4, y: 4 },
      { x: 20, y: 4 },
      { x: 20, y: 20 },
      { x: 4, y: 20 },
    ]);
    expect(at(m, 10, 10)).toBe(255);
    expect(at(m, 2, 2)).toBe(0);
    expect(count(m)).toBeCloseTo(16 * 16, -1);
  });

  it('fills a triangle without leaking', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizePolygon(m, SIZE, [
      { x: 16, y: 4 },
      { x: 28, y: 28 },
      { x: 4, y: 28 },
    ]);
    expect(at(m, 16, 20)).toBe(255);
    // Outside the sloped edges.
    expect(at(m, 5, 6)).toBe(0);
    expect(at(m, 27, 6)).toBe(0);
  });

  it('ignores degenerate polygons', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizePolygon(m, SIZE, [{ x: 1, y: 1 }, { x: 5, y: 5 }]);
    expect(isEmpty(m)).toBe(true);
  });

  it('selects a single row or column', () => {
    const row = createMask(SIZE.width, SIZE.height);
    rasterizeLine(row, SIZE, 7, false);
    expect(count(row)).toBe(SIZE.width);
    expect(at(row, 0, 7)).toBe(255);

    const col = createMask(SIZE.width, SIZE.height);
    rasterizeLine(col, SIZE, 9, true);
    expect(count(col)).toBe(SIZE.height);
    expect(at(col, 9, 0)).toBe(255);
  });

  it('clips shapes to the document', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: -10, y0: -10, x1: 5, y1: 5 });
    expect(at(m, 0, 0)).toBe(255);
    expect(count(m)).toBe(25);
  });
});

describe('Select ▸ Modify', () => {
  const square = () => {
    const m = createMask(SIZE.width, SIZE.height);
    return rasterizeRect(m, SIZE, { x0: 10, y0: 10, x1: 22, y1: 22 });
  };

  it('feathers the edge without moving the centre', () => {
    const m = square();
    feather(m, SIZE, 3);
    expect(at(m, 16, 16)).toBe(255);
    // Just outside the original edge now has partial coverage.
    expect(at(m, 9, 16)).toBeGreaterThan(0);
    expect(at(m, 9, 16)).toBeLessThan(255);
  });

  it('leaves the mask alone at feather 0', () => {
    const m = square();
    const before = [...m];
    feather(m, SIZE, 0);
    expect([...m]).toEqual(before);
  });

  it('expands by a euclidean distance', () => {
    const m = square();
    expand(m, SIZE, 3);
    expect(maskBounds(m, SIZE)).toEqual({ x0: 7, y0: 7, x1: 25, y1: 25 });
  });

  it('contracts by a euclidean distance', () => {
    const m = square();
    contract(m, SIZE, 3);
    expect(maskBounds(m, SIZE)).toEqual({ x0: 13, y0: 13, x1: 19, y1: 19 });
  });

  it('rounds corners when expanding, rather than squaring them', () => {
    const m = square();
    expand(m, SIZE, 4);
    // The exact corner of the square bounding box is further than 4px from the original.
    expect(at(m, 7, 7)).toBe(0);
    // Straight out from an edge is within range.
    expect(at(m, 6, 16)).toBe(255);
  });

  it('keeps only a band with border', () => {
    const m = square();
    border(m, SIZE, 4);
    // The middle is no longer selected, the rim is.
    expect(at(m, 16, 16)).toBe(0);
    expect(at(m, 10, 16)).toBe(255);
  });

  it('rounds off a single stray pixel with smooth', () => {
    const m = square();
    // A lone spike sticking out of the square.
    m[10 * SIZE.width + 25] = 255;
    smooth(m, SIZE, 2);
    expect(at(m, 25, 10)).toBe(0);
    expect(at(m, 16, 16)).toBe(255);
  });

  it('contracting more than the selection empties it', () => {
    const m = square();
    contract(m, SIZE, 50);
    expect(isEmpty(m)).toBe(true);
  });
});

describe('magic wand', () => {
  const W = 16;
  const H = 16;
  /** Left half red, right half blue, with a red island inside the blue. */
  function pixels(): Uint8Array {
    const p = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const island = x >= 12 && x < 15 && y >= 12 && y < 15;
        const red = x < 8 || island;
        p[o] = red ? 255 : 0;
        p[o + 1] = 0;
        p[o + 2] = red ? 0 : 255;
        p[o + 3] = 255;
      }
    }
    return p;
  }
  const size = { width: W, height: H };

  it('selects a contiguous region only', () => {
    const m = magicWand(pixels(), size, 2, 2, { tolerance: 10, contiguous: true, antialias: false });
    expect(m[2 * W + 2]).toBe(255);
    expect(m[2 * W + 10]).toBe(0);
    // The island is the same colour but not connected.
    expect(m[13 * W + 13]).toBe(0);
  });

  it('selects every matching pixel when not contiguous', () => {
    const m = magicWand(pixels(), size, 2, 2, { tolerance: 10, contiguous: false, antialias: false });
    expect(m[2 * W + 2]).toBe(255);
    expect(m[13 * W + 13]).toBe(255);
    expect(m[2 * W + 10]).toBe(0);
  });

  it('selects everything at maximum tolerance', () => {
    const m = magicWand(pixels(), size, 0, 0, { tolerance: 255, contiguous: true, antialias: false });
    expect(m.every((v) => v === 255)).toBe(true);
  });

  it('selects only the exact colour at zero tolerance', () => {
    const p = pixels();
    p[(5 * W + 5) * 4 + 1] = 40; // nudge one pixel's green
    const m = magicWand(p, size, 2, 2, { tolerance: 0, contiguous: true, antialias: false });
    expect(m[5 * W + 5]).toBe(0);
    expect(m[2 * W + 2]).toBe(255);
  });

  it('ignores a seed outside the document', () => {
    expect(isEmpty(magicWand(pixels(), size, -1, 0, { tolerance: 10, contiguous: true, antialias: false }))).toBe(true);
  });

  it('softens the edge of the tolerance band when anti-aliasing', () => {
    // A gradient means pixels sit at every distance from the seed colour.
    const p = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        p[o] = x * 16;
        p[o + 3] = 255;
      }
    }
    const m = magicWand(p, size, 0, 0, { tolerance: 100, contiguous: true, antialias: true });
    let partial = 0;
    for (let i = 0; i < m.length; i++) if (m[i]! > 0 && m[i]! < 255) partial++;
    expect(partial).toBeGreaterThan(0);
  });

  it('grows into neighbouring similar pixels', () => {
    const p = pixels();
    const m = createMask(W, H);
    m[2 * W + 2] = 255;
    grow(m, p, size, 10);
    expect(m[2 * W + 3]).toBe(255);
    expect(m[2 * W + 1]).toBe(255);
  });
});

describe('boundary tracing', () => {
  it('traces the perimeter of a rectangle', () => {
    const m = createMask(SIZE.width, SIZE.height);
    rasterizeRect(m, SIZE, { x0: 4, y0: 4, x1: 8, y1: 8 });
    const segs = traceBoundary(m, SIZE);
    // A 4x4 square has 16 unit edges around it.
    expect(segs).toHaveLength(16);
  });

  it('traces nothing for an empty selection', () => {
    expect(traceBoundary(createMask(8, 8), { width: 8, height: 8 })).toHaveLength(0);
  });

  it('traces the outer edge when everything is selected', () => {
    const m = createMask(4, 4, 255);
    expect(traceBoundary(m, { width: 4, height: 4 })).toHaveLength(16);
  });
});
