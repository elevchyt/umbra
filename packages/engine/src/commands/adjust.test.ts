import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { compositeDocument } from '@umbra/kernels/composite';
import { defaultAdjustment, type Adjustment } from '@umbra/kernels/adjust';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import {
  emptyDoc,
  makeAdjustmentLayer,
  makePixelLayer,
  type AdjustmentLayer,
  type Doc,
  type PixelLayer,
} from '../document.js';
import { makeSelection } from '../selection.js';
import { toCompositeLayers } from '../render/cpu-composite.js';
import { savePsd } from '../psd-save.js';
import { openPsd } from '../psd-open.js';
import { addAdjustmentLayer, applyAdjustment, setAdjustment } from './adjust.js';
import { ADJUSTMENT_SAMPLES as SAMPLES } from '../adjust-samples.js';

const W = 48;
const H = 32;

/** A colourful layer: every pixel different, a transparent column and a half-alpha column. */
function colourful(): Plane {
  const w = Plane.empty(RGBA8).writer();
  const data = w.mutable(0, 0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * TILE_SIZE + x) * 4;
      data[o] = (x * 37 + y * 11) & 255;
      data[o + 1] = (x * 5 + y * 71) & 255;
      data[o + 2] = (x * 97 + y * 13 + 40) & 255;
      data[o + 3] = x === 0 ? 0 : x === 1 ? 128 : 255;
    }
  }
  return w.commit();
}

function doc(): Doc {
  const layer = makePixelLayer('Layer 1', colourful());
  return { ...emptyDoc(W, H, 't'), layers: [layer], activeLayerIds: [layer.id] };
}

const px = (d: Doc, x: number, y: number, i = 0) => {
  const t = (d.layers[i] as PixelLayer).plane.base.tileAt(0, 0);
  const o = (y * TILE_SIZE + x) * 4;
  return [t.data[o]!, t.data[o + 1]!, t.data[o + 2]!, t.data[o + 3]!];
};

const composite = (d: Doc, x: number, y: number) => {
  const c = compositeDocument(toCompositeLayers(d), x, y);
  return [...c.color.map((v) => Math.round(v * 255)), Math.round(c.alpha * 255)];
};



describe('destructive adjustments', () => {
  it('invert inverts colour, keeps alpha, and leaves transparent pixels alone', () => {
    const before = doc();
    const after = applyAdjustment(before, before.layers[0]!.id, { kind: 'invert' });
    const [r, g, b, a] = px(before, 5, 7);
    expect(px(after, 5, 7)).toEqual([255 - r!, 255 - g!, 255 - b!, a]);
    expect(px(after, 0, 3)).toEqual(px(before, 0, 3));
    expect(px(after, 1, 3)[3]).toBe(128);
  });

  it('is confined to the selection', () => {
    const before = doc();
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 10, y0: 10, x1: 20, y1: 20 }, false);
    const sel = { ...before, selection: makeSelection(W, H, mask) };
    const after = applyAdjustment(sel, before.layers[0]!.id, { kind: 'invert' });
    expect(px(after, 30, 5)).toEqual(px(before, 30, 5));
    expect(px(after, 15, 15)[0]).toBe(255 - px(before, 15, 15)[0]!);
  });

  it('refuses a layer with locked pixels, and a no-op leaves the document identical', () => {
    const d = doc();
    const locked: Doc = { ...d, layers: [{ ...d.layers[0]!, locks: { transparency: false, pixels: true, position: false, all: false } }] };
    expect(applyAdjustment(locked, d.layers[0]!.id, { kind: 'invert' })).toBe(locked);
    expect(applyAdjustment(d, d.layers[0]!.id, defaultAdjustment('levels'))).toBe(d);
  });
});

describe('adjustment layers', () => {
  it('are created above the active layer, numbered, with a reveal-all mask', () => {
    const d = addAdjustmentLayer(doc(), defaultAdjustment('levels'));
    const l = d.layers[1] as AdjustmentLayer;
    expect(l.kind).toBe('adjustment');
    expect(l.name).toBe('Levels 1');
    expect(l.mask?.defaultColor).toBe(1);
    expect(d.activeLayerIds).toEqual([l.id]);
    expect((addAdjustmentLayer(d, defaultAdjustment('levels')).layers[2] as AdjustmentLayer).name).toBe('Levels 2');
  });

  it('take the selection as their mask', () => {
    const d = doc();
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 0, y0: 0, x1: 24, y1: H }, false);
    const withLayer = addAdjustmentLayer({ ...d, selection: makeSelection(W, H, mask) }, { kind: 'invert' });
    const [r] = px(d, 30, 5);
    expect(composite(withLayer, 30, 5)[0]).toBe(r); // outside: untouched
    expect(composite(withLayer, 10, 5)[0]).toBe(255 - px(d, 10, 5)[0]!);
  });

  it('agree with the destructive command for every kind — the M4 exit criterion', () => {
    for (const adj of SAMPLES) {
      const base = doc();
      const destructive = applyAdjustment(base, base.layers[0]!.id, adj);
      const layered = addAdjustmentLayer(base, adj);
      let worst = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 1; x < W; x++) {
          const a = composite(destructive, x, y);
          const b = composite(layered, x, y);
          for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(a[c]! - b[c]!));
        }
      }
      expect(`${adj.kind}: ${worst <= 1 ? 'ok' : worst}`).toBe(`${adj.kind}: ok`);
    }
  });

  it('add no coverage: over transparency they stay transparent', () => {
    const d = addAdjustmentLayer(doc(), { kind: 'invert' });
    expect(composite(d, 0, 0)[3]).toBe(0);
    expect(composite(d, 1, 0)[3]).toBe(128);
  });

  it('when clipped, adjust only their base', () => {
    const bottom = makePixelLayer('bottom', colourful());
    const top = makePixelLayer('top', (() => {
      const w = Plane.empty(RGBA8).writer();
      const data = w.mutable(0, 0);
      for (let y = 0; y < H; y++) for (let x = 20; x < W; x++) data.set([200, 100, 50, 255], (y * TILE_SIZE + x) * 4);
      return w.commit();
    })());
    const inv = makeAdjustmentLayer('Invert 1', { kind: 'invert' }, { clipped: true });
    const d: Doc = { ...emptyDoc(W, H, 't'), layers: [bottom, top, inv], activeLayerIds: [inv.id] };
    expect(composite(d, 30, 5)).toEqual([55, 155, 205, 255]);
    // Left of the top layer, the bottom layer shows through un-inverted.
    const t = bottom.plane.base.tileAt(0, 0);
    const o = (5 * TILE_SIZE + 10) * 4;
    expect(composite(d, 10, 5).slice(0, 3)).toEqual([t.data[o], t.data[o + 1], t.data[o + 2]]);
  });

  it('respect opacity as a mix toward the unadjusted backdrop', () => {
    const base = doc();
    const d = addAdjustmentLayer(base, { kind: 'invert' });
    const half: Doc = { ...d, layers: [d.layers[0]!, { ...d.layers[1]!, opacity: 0.5 }] };
    const [r] = px(base, 10, 10);
    expect(Math.abs(composite(half, 10, 10)[0]! - (r! + (255 - r!)) / 2)).toBeLessThanOrEqual(1);
  });

  it('can have their parameters changed', () => {
    const d = addAdjustmentLayer(doc(), defaultAdjustment('posterize'));
    const id = d.activeLayerIds[0]!;
    const e = setAdjustment(d, id, { kind: 'posterize', levels: 2 });
    expect((e.layers[1] as AdjustmentLayer).adjustment).toEqual({ kind: 'posterize', levels: 2 });
  });
});

describe('adjustment layers in PSD', () => {
  it('round-trip every kind with its parameters and mask', () => {
    for (const adj of SAMPLES) {
      const d = addAdjustmentLayer(doc(), adj);
      const back = openPsd(savePsd(d)).doc;
      const l = back.layers[1] as AdjustmentLayer;
      expect(l.kind).toBe('adjustment');
      const got = l.adjustment;
      if (adj.kind === 'blackWhite' || adj.kind === 'photoFilter' || adj.kind === 'gradientMap') {
        // Colours are stored as 8-bit (tint, filter) or 16-bit (stops): compare to 1/255.
        const flat = (a: unknown): number[] => JSON.stringify(a).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
        const want = flat(adj);
        const have = flat(got);
        expect(have.length).toBe(want.length);
        have.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(1 / 255 + 1e-9));
      } else {
        expect(got).toEqual(adj);
      }
      expect(back.layers[1]!.mask?.defaultColor).toBe(1);
    }
  });

  it('keep what they do not model — a preset name survives a round trip', () => {
    // Levels carries its preset name in a block we do not interpret.
    const d = addAdjustmentLayer(doc(), SAMPLES.find((a) => a.kind === 'levels')!);
    const once = openPsd(savePsd(d)).doc;
    const layer = once.layers[1] as AdjustmentLayer;
    (layer.psdExtra as { adjustment: Record<string, unknown> }).adjustment.presetFileName = 'Mine';
    const again = openPsd(savePsd(once)).doc.layers[1] as AdjustmentLayer;
    expect((again.psdExtra as { adjustment: Record<string, unknown> }).adjustment.presetFileName).toBe('Mine');
  });

});
