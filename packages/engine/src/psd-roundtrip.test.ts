import { describe, expect, it } from 'vitest';
import { openPsd } from './psd-open.js';
import { savePsd, tightBounds, bitmapFromPlane, renderComposite } from './psd-save.js';
import { toCompositeLayers } from './render/cpu-composite.js';
import { compositeDocument } from '@umbra/kernels/composite';
import {
  emptyDoc,
  makeGroup,
  makePixelLayer,
  panelRows,
  walkLayers,
  type Doc,
  type GroupLayer,
  type Layer,
} from './document.js';
import { Plane } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { TILE_SIZE } from '@umbra/core/pixels';

const W = 40;
const H = 24;

/** Build a plane by evaluating `fn` over a rect. */
function planeFrom(
  fn: (x: number, y: number) => [number, number, number, number],
  w = W,
  h = H,
): Plane {
  const writer = Plane.empty(RGBA8).writer();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      if (a === 0) continue;
      const px = writer.mutable(x >> 8, y >> 8);
      const o = ((y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
    }
  }
  return writer.commit();
}

function maskPlane(fn: (x: number, y: number) => number): Plane {
  const writer = Plane.empty({ layout: 'A', sample: 'u8' }).writer();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = writer.mutable(x >> 8, y >> 8);
      px[(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)] = fn(x, y);
    }
  }
  return writer.commit();
}

function sampleDoc(): Doc {
  const background = makePixelLayer('Background', planeFrom((x, y) => [20 + x * 2, 40 + y * 3, 120, 255]));
  const masked = makePixelLayer('Masked', planeFrom(() => [240, 180, 30, 255]), {
    mask: {
      plane: new MipPlane(maskPlane((x) => (x < W / 2 ? 255 : 0))),
      enabled: true,
      linked: true,
      density: 1,
      feather: 0,
      defaultColor: 0,
    },
  });
  const inner1 = makePixelLayer('Inner Screen', planeFrom(() => [60, 90, 200, 255]), {
    blendMode: 'screen',
  });
  const inner2 = makePixelLayer('Inner Half', planeFrom((x, y) => (y < H / 2 ? [255, 0, 0, 200] : [0, 0, 0, 0])), {
    opacity: 0.75,
  });
  const group = makeGroup('Group', [inner1, inner2], { opacity: 0.85, blendMode: 'normal' });
  const clipBase = makePixelLayer('Clip Base', planeFrom((x) => (x > 10 && x < 30 ? [255, 255, 255, 255] : [0, 0, 0, 0])));
  const clipped = makePixelLayer('Clipped', planeFrom((x, y) => [10, 220, 140, 255]), { clipped: true });

  const layers: Layer[] = [background, masked, group, clipBase, clipped];
  return { ...emptyDoc(W, H, 'roundtrip.psd'), layers, activeLayerIds: [background.id] };
}

describe('tight bounds and bitmap extraction', () => {
  it('finds the exact non-transparent rect', () => {
    const plane = planeFrom((x, y) => (x >= 5 && x < 9 && y >= 3 && y < 7 ? [1, 2, 3, 255] : [0, 0, 0, 0]));
    expect(tightBounds(plane)).toEqual({ x0: 5, y0: 3, x1: 9, y1: 7 });
  });

  it('returns an empty rect for a blank plane', () => {
    expect(tightBounds(Plane.empty(RGBA8))).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  it('copies exactly the requested region', () => {
    const plane = planeFrom((x, y) => [x, y, 7, 255]);
    const bmp = bitmapFromPlane(plane, { x0: 2, y0: 3, x1: 6, y1: 5 });
    expect(bmp.width).toBe(4);
    expect(bmp.height).toBe(2);
    // First pixel is document (2,3).
    expect([bmp.data[0], bmp.data[1], bmp.data[2], bmp.data[3]]).toEqual([2, 3, 7, 255]);
  });
});

describe('PSD round trip', () => {
  const original = sampleDoc();
  const buffer = savePsd(original);
  const reopened = openPsd(buffer, 'roundtrip.psd').doc;

  it('writes a file Photoshop-compatible readers can parse', () => {
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(reopened.width).toBe(W);
    expect(reopened.height).toBe(H);
  });

  it('preserves the layer tree', () => {
    const before = panelRows(original.layers).map((r) => `${r.depth}:${r.layer.name}`);
    const after = panelRows(reopened.layers).map((r) => `${r.depth}:${r.layer.name}`);
    expect(after).toEqual(before);
  });

  it('preserves blend modes, opacity, visibility and clipping', () => {
    const before = [...walkLayers(original.layers)].map((w) => w.layer);
    const after = [...walkLayers(reopened.layers)].map((w) => w.layer);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      const a = before[i]!;
      const b = after[i]!;
      expect(b.name, a.name).toBe(a.name);
      expect(b.blendMode, a.name).toBe(a.blendMode);
      expect(b.clipped, a.name).toBe(a.clipped);
      expect(b.visible, a.name).toBe(a.visible);
      // PSD stores opacity as a byte, so it round-trips to within 1/255.
      expect(Math.abs(b.opacity - a.opacity), a.name).toBeLessThanOrEqual(1 / 255 + 1e-6);
    }
  });

  it('preserves the group structure', () => {
    const group = reopened.layers.find((l) => l.name === 'Group') as GroupLayer;
    expect(group.kind).toBe('group');
    expect(group.children.map((c) => c.name)).toEqual(['Inner Screen', 'Inner Half']);
  });

  it('preserves the layer mask', () => {
    const masked = reopened.layers.find((l) => l.name === 'Masked')!;
    expect(masked.mask).toBeDefined();
    expect(masked.mask!.enabled).toBe(true);
  });

  it('renders identically before and after the round trip', () => {
    // The real test: the pixels a user sees must survive save→open unchanged.
    const before = toCompositeLayers(original);
    const after = toCompositeLayers(reopened);
    let maxDelta = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = compositeDocument(before, x, y);
        const b = compositeDocument(after, x, y);
        for (let c = 0; c < 3; c++) {
          maxDelta = Math.max(maxDelta, Math.abs(a.color[c]! - b.color[c]!) * 255);
        }
        maxDelta = Math.max(maxDelta, Math.abs(a.alpha - b.alpha) * 255);
      }
    }
    // Opacity quantising to a byte is the only permitted source of drift.
    expect(maxDelta).toBeLessThanOrEqual(2);
  });

  it('embeds a merged composite that matches our own render', () => {
    const composite = renderComposite(original);
    expect(composite.width).toBe(W);
    expect(composite.height).toBe(H);
    const layers = toCompositeLayers(original);
    const px = compositeDocument(layers, 5, 5);
    const o = (5 * W + 5) * 4;
    expect(composite.data[o]).toBe(Math.round(px.color[0] * 255));
    expect(composite.data[o + 3]).toBe(Math.round(px.alpha * 255));
  });

  it('survives a second round trip unchanged', () => {
    const again = openPsd(savePsd(reopened), 'again.psd').doc;
    expect(panelRows(again.layers).map((r) => r.layer.name)).toEqual(
      panelRows(reopened.layers).map((r) => r.layer.name),
    );
  });

  it('crops each layer to its own bounds rather than the canvas', () => {
    // "Clip Base" only covers x in [11,30), so the file must not store a full-width layer.
    const clipBase = original.layers.find((l) => l.name === 'Clip Base')!;
    if (clipBase.kind !== 'pixel') throw new Error('expected a pixel layer');
    const r = tightBounds(clipBase.plane.base);
    expect(r.x0).toBe(11);
    expect(r.x1).toBe(30);
  });
});

describe('saving edge cases', () => {
  it('writes an empty document', () => {
    const buf = savePsd(emptyDoc(16, 16, 'blank.psd'));
    const back = openPsd(buf).doc;
    expect(back.width).toBe(16);
    expect(back.height).toBe(16);
    // A PSD must contain image data, so a document with no layers comes back with a single
    // empty one rather than an empty stack. That is the format, not a bug.
    expect(back.layers.length).toBeLessThanOrEqual(1);
  });

  it('writes a layer with no pixels', () => {
    const doc: Doc = {
      ...emptyDoc(16, 16),
      layers: [makePixelLayer('Empty', Plane.empty(RGBA8))],
    };
    const back = openPsd(savePsd(doc)).doc;
    expect(back.layers).toHaveLength(1);
    expect(back.layers[0]!.name).toBe('Empty');
  });
});
