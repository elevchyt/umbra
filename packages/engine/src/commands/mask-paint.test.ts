import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { compositeDocument } from '@umbra/kernels/composite';
import { Plane } from '../tiles/plane.js';
import { RGBA8 } from '../tiles/import.js';
import { emptyDoc, makePixelLayer, type Doc } from '../document.js';
import { makeSelection } from '../selection.js';
import { toCompositeLayers } from '../render/cpu-composite.js';
import { addAdjustmentLayer } from './adjust.js';
import { compositeStrokeIntoMask, fillMask, gradientMask } from './mask-paint.js';

const W = 64;
const H = 32;
function doc(): Doc {
  const w = Plane.empty(RGBA8).writer();
  const d = w.mutable(0, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set([200, 100, 50, 255], (y * TILE_SIZE + x) * 4);
  const base = makePixelLayer('Background', w.commit());
  // An Invert adjustment layer on top: its mask decides where the image is inverted.
  return addAdjustmentLayer({ ...emptyDoc(W, H, 't'), layers: [base], activeLayerIds: [base.id] }, { kind: 'invert' });
}
const red = (d: Doc, x: number, y: number) => Math.round(compositeDocument(toCompositeLayers(d), x, y).color[0] * 255);
const id = (d: Doc) => d.activeLayerIds[0]!;

describe('painting into a mask', () => {
  it('Fill with black hides the adjustment inside the selection only', () => {
    const d = doc();
    expect(red(d, 5, 5)).toBe(55);
    const m = createMask(W, H);
    rasterizeRect(m, { width: W, height: H }, { x0: 0, y0: 0, x1: 32, y1: H }, false);
    const out = fillMask({ ...d, selection: makeSelection(W, H, m) }, id(d), [0, 0, 0], 1);
    expect(red(out, 5, 5)).toBe(200);
    expect(red(out, 40, 5)).toBe(55);
  });

  it('paints a colour as its luminance, at the given opacity', () => {
    const out = fillMask(doc(), id(doc()), [1, 1, 1], 1);
    const half = fillMask(out, id(out), [0, 0, 0], 0.5);
    // Half-hidden invert: halfway between 200 and 55.
    expect(Math.abs(red(half, 5, 5) - 128)).toBeLessThanOrEqual(1);
  });

  it('a gradient on the mask fades the adjustment across the canvas', () => {
    const d = doc();
    const out = gradientMask(d, id(d), {
      gradient: { colorStops: [{ at: 0, color: [0, 0, 0] }, { at: 1, color: [1, 1, 1] }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 1 }] },
      style: 'linear',
      x0: 0,
      y0: 0,
      x1: W,
      y1: 0,
      reverse: false,
      dither: false,
      mode: 'normal',
      opacity: 1,
      preserveTransparency: false,
    });
    expect(red(out, 0, 5)).toBeGreaterThan(190);
    expect(red(out, W - 1, 5)).toBeLessThan(65);
  });

  it('a brush stroke composites its grey by its coverage', () => {
    const d = doc();
    const w = Plane.empty(RGBA8).writer();
    const s = w.mutable(0, 0);
    for (let x = 0; x < 10; x++) s.set([0, 0, 0, 255], (3 * TILE_SIZE + x) * 4); // a black line on row 3
    const out = compositeStrokeIntoMask(d, id(d), w.commit(), 1);
    expect(red(out, 5, 3)).toBe(200); // hidden where painted
    expect(red(out, 5, 4)).toBe(55); // untouched elsewhere
  });
});
