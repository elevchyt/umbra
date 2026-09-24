import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc } from './document.js';
import { History } from './history.js';
import { planeThumb, thumbSize } from './layer-thumbs.js';
import { openPsd } from './psd-open.js';
import { savePsd } from './psd-save.js';

const W = 64;
const H = 32;

function square(x0: number, y0: number, x1: number, y1: number): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = w.mutable(x >> 8, y >> 8);
      d.set([200, 40, 10, 255], ((y & 255) * TILE_SIZE + (x & 255)) * 4);
    }
  }
  return w.commit();
}

describe('layer thumbnails', () => {
  it('keep the document aspect', () => {
    expect(thumbSize(W, H, 60)).toEqual({ width: 60, height: 30 });
    expect(thumbSize(H, W, 60)).toEqual({ width: 30, height: 60 });
  });

  it('show the layer where its pixels are, transparent elsewhere', () => {
    // Left half painted.
    const t = planeThumb(square(0, 0, W / 2, H), W, H, 16);
    expect(t).toMatchObject({ width: 16, height: 8 });
    const at = (x: number, y: number) => [...t.pixels.subarray((y * t.width + x) * 4, (y * t.width + x) * 4 + 4)];
    expect(at(2, 4)).toEqual([200, 40, 10, 255]);
    expect(at(13, 4)[3]).toBe(0);
  });

  it('are memoised on the plane', () => {
    const p = square(0, 0, 8, 8);
    expect(planeThumb(p, W, H, 16)).toBe(planeThumb(p, W, H, 16));
    expect(planeThumb(p, W, H, 32)).not.toBe(planeThumb(p, W, H, 16));
  });
});

describe('unsaved changes', () => {
  const doc = (): Doc => ({ ...emptyDoc(W, H), layers: [makePixelLayer('A', square(0, 0, 4, 4))] });

  it('a new or opened document is clean; an edit dirties it and undoing back cleans it', () => {
    const d0 = doc();
    const h = new History(d0, 'Open');
    expect(h.dirty).toBe(false);
    h.push('Paint', { ...d0, name: 'x' });
    expect(h.dirty).toBe(true);
    h.undo();
    expect(h.dirty).toBe(false);
  });

  it('saving makes the current state the clean one', () => {
    const d0 = doc();
    const h = new History(d0, 'Open');
    const d1 = { ...d0, name: 'x' };
    h.push('Paint', d1);
    h.saved = h.current;
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
  });
});

describe('colour labels', () => {
  it('round-trip through PSD', () => {
    const d = { ...emptyDoc(W, H), layers: [makePixelLayer('A', square(0, 0, 4, 4), { color: 'violet' })] };
    const back = openPsd(savePsd(d), 'labels.psd').doc;
    expect(back.layers[0]!.color).toBe('violet');
  });
});
