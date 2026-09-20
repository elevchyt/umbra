import { describe, expect, it, beforeAll } from 'vitest';
import { writePsdBuffer, initializeCanvas } from 'ag-psd';
import { openPsd } from './psd-open.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { compositeDocument } from '@umbra/kernels/composite';
import { countLayers, panelRows, walkLayers, type GroupLayer } from './document.js';

/**
 * A PSD fixture built in-process, exercising the structural features M2 promises: nested
 * groups, blend modes, opacity and fill, a raster mask, and a clipping mask. Building it here
 * rather than checking in a binary keeps the corpus readable and diffable — real-world files
 * are the separate corpus the roadmap calls for.
 */
const W = 8;
const H = 8;

function rgba(r: number, g: number, b: number, a = 255) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width: W, height: H };
}

/** Left half opaque, right half transparent. */
function halfAlpha(r: number, g: number, b: number) {
  const img = rgba(r, g, b, 255);
  for (let y = 0; y < H; y++) {
    for (let x = W / 2; x < W; x++) img.data[(y * W + x) * 4 + 3] = 0;
  }
  return img;
}

/** Top half white (reveal), bottom half black (hide). */
function halfMask() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = y < H / 2 ? 255 : 0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

let buffer: Buffer;

beforeAll(() => {
  initializeCanvas(
    () => {
      throw new Error('no canvas needed');
    },
    (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as ImageData,
  );

  const bounds = { left: 0, top: 0, right: W, bottom: H };
  buffer = writePsdBuffer(
    {
      width: W,
      height: H,
      children: [
        { name: 'Background', ...bounds, imageData: rgba(64, 64, 64) },
        { name: 'Masked Red', ...bounds, imageData: rgba(255, 0, 0), mask: { ...bounds, imageData: halfMask() } },
        {
          name: 'Group A',
          opened: true,
          blendMode: 'normal',
          opacity: 0.5,
          children: [
            { name: 'Inside Blue', ...bounds, imageData: rgba(0, 0, 255) },
            { name: 'Inside Multiply', ...bounds, imageData: rgba(128, 128, 128), blendMode: 'multiply' },
          ],
        },
        { name: 'Clip Base', ...bounds, imageData: halfAlpha(0, 255, 0) },
        { name: 'Clipped White', ...bounds, imageData: rgba(255, 255, 255), clipping: true },
      ],
    } as never,
    { generateThumbnail: false },
  );
});

describe('opening a PSD', () => {
  it('reads the document size and layer count', () => {
    const { doc } = openPsd(buffer, 'fixture.psd');
    expect(doc.width).toBe(W);
    expect(doc.height).toBe(H);
    // 5 top-level entries plus the 2 layers inside the group. A clipped layer is a SIBLING
    // carrying a flag, not a child of its base, so "Clipped White" stays at the top level.
    expect(countLayers(doc.layers)).toBe(7);
    expect(doc.layers).toHaveLength(5);
  });

  it('preserves the layer order bottom-most first', () => {
    const { doc } = openPsd(buffer);
    expect(doc.layers.map((l) => l.name)).toEqual([
      'Background',
      'Masked Red',
      'Group A',
      'Clip Base',
      'Clipped White',
    ]);
  });

  it('nests group children', () => {
    const { doc } = openPsd(buffer);
    const group = doc.layers.find((l) => l.name === 'Group A') as GroupLayer;
    expect(group.kind).toBe('group');
    expect(group.children.map((c) => c.name)).toEqual(['Inside Blue', 'Inside Multiply']);
  });

  it('carries blend modes, opacity and clipping across', () => {
    const { doc } = openPsd(buffer);
    const group = doc.layers.find((l) => l.name === 'Group A') as GroupLayer;
    expect(group.opacity).toBeCloseTo(0.5, 2);
    expect(group.children[1]!.blendMode).toBe('multiply');

    const all = [...walkLayers(doc.layers)].map((w) => w.layer);
    expect(all.find((l) => l.name === 'Clipped White')?.clipped).toBe(true);
    expect(all.find((l) => l.name === 'Clip Base')?.clipped).toBe(false);
  });

  it('reads a raster mask into a single-channel plane', () => {
    const { doc } = openPsd(buffer);
    const masked = doc.layers.find((l) => l.name === 'Masked Red')!;
    expect(masked.mask).toBeDefined();
    expect(masked.mask!.enabled).toBe(true);
    expect(masked.mask!.plane.base.tileCount).toBeGreaterThan(0);
  });

  it('gives every layer a distinct id', () => {
    const { doc } = openPsd(buffer);
    const ids = [...walkLayers(doc.layers)].map((w) => w.layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists panel rows top-most first with groups above their children', () => {
    const { doc } = openPsd(buffer);
    const rows = panelRows(doc.layers).map((r) => `${'  '.repeat(r.depth)}${r.layer.name}`);
    expect(rows).toEqual([
      'Clipped White',
      'Clip Base',
      'Group A',
      '  Inside Multiply',
      '  Inside Blue',
      'Masked Red',
      'Background',
    ]);
  });
});

describe('rendering an opened PSD', () => {
  const at = (x: number, y: number) => {
    const { doc } = openPsd(buffer);
    return compositeDocument(toCompositeLayers(doc), x, y);
  };

  it('shows the clipped white only where the base layer is opaque', () => {
    // Left half: Clip Base is opaque, so the clipped white shows through.
    expect(at(1, 1).color[0]).toBeCloseTo(1, 1);
    // Right half: the base is transparent, so the clipped layer is hidden and we see what is
    // underneath instead.
    expect(at(6, 1).color[0]).toBeLessThan(0.9);
  });

  it('applies the layer mask', () => {
    // Column 6 is outside Clip Base, so the masked red is visible there.
    const top = at(6, 1); // mask white → red shows
    const bottom = at(6, 6); // mask black → red hidden
    expect(top.color[0]).toBeGreaterThan(bottom.color[0]);
  });

  it('isolates a Normal group so Multiply inside does not see the backdrop', () => {
    const { doc } = openPsd(buffer);
    const layers = toCompositeLayers(doc);
    // Hide everything above the group so only Background + Masked Red + Group A contribute.
    const trimmed = layers.filter((l) => l.name !== 'Clip Base' && l.name !== 'Clipped White');
    const px = compositeDocument(trimmed, 6, 6);
    // Group A is isolated at 50%: its internal result is blue multiplied by grey, mixed half-and-half
    // with the backdrop. The blue channel must dominate red.
    expect(px.color[2]).toBeGreaterThan(px.color[0]);
  });

  it('is fully opaque everywhere, because the bottom layer is opaque', () => {
    for (const [x, y] of [[0, 0], [7, 7], [3, 4]] as const) {
      expect(at(x, y).alpha).toBeCloseTo(1, 6);
    }
  });
});
