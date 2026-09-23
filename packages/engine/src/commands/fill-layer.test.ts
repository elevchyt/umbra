import { describe, expect, it } from 'vitest';
import { createMask, rasterizeRect } from '@umbra/kernels/selection';
import { compositeDocument } from '@umbra/kernels/composite';
import { builtinPatterns, type FillContent } from '@umbra/kernels/fill';
import { emptyDoc, type Doc, type FillLayer } from '../document.js';
import { makeSelection } from '../selection.js';
import { toCompositeLayers } from '../render/cpu-composite.js';
import { savePsd } from '../psd-save.js';
import { openPsd } from '../psd-open.js';
import { addFillLayer, setFillContent } from './adjust.js';
import { mergeVisible } from './layers.js';

const W = 64;
const H = 40;
const px = (d: Doc, x: number, y: number) => {
  const c = compositeDocument(toCompositeLayers(d), x, y);
  return [...c.color.map((v) => Math.round(v * 255)), Math.round(c.alpha * 255)];
};
const blank = (): Doc => ({ ...emptyDoc(W, H, 't') });

const BLACK_WHITE = {
  colorStops: [
    { at: 0, color: [0, 0, 0] as [number, number, number] },
    { at: 1, color: [1, 1, 1] as [number, number, number] },
  ],
  opacityStops: [
    { at: 0, opacity: 1 },
    { at: 1, opacity: 1 },
  ],
};
const gradient = (angle: number, extra: Partial<Extract<FillContent, { type: 'gradient' }>> = {}): FillContent => ({
  type: 'gradient',
  gradient: BLACK_WHITE,
  style: 'linear',
  angle,
  scale: 100,
  reverse: false,
  offset: { x: 0, y: 0 },
  ...extra,
});

describe('fill layers', () => {
  it('a solid fill covers the whole canvas, named and masked like Photoshop', () => {
    const d = addFillLayer(blank(), { type: 'solid', color: [1, 0.5, 0] });
    const l = d.layers[0] as FillLayer;
    expect(l.name).toBe('Color Fill 1');
    expect(l.mask?.defaultColor).toBe(1);
    expect(px(d, 0, 0)).toEqual([255, 128, 0, 255]);
    expect(px(d, W - 1, H - 1)).toEqual([255, 128, 0, 255]);
  });

  it('takes the selection as its mask', () => {
    const mask = createMask(W, H);
    rasterizeRect(mask, { width: W, height: H }, { x0: 0, y0: 0, x1: 10, y1: H }, false);
    const d = addFillLayer({ ...blank(), selection: makeSelection(W, H, mask) }, { type: 'solid', color: [0, 0, 1] });
    expect(px(d, 5, 5)[3]).toBe(255);
    expect(px(d, 30, 5)[3]).toBe(0);
  });

  it('a 0° linear gradient runs left to right across the canvas; 90° runs bottom to top', () => {
    const d = addFillLayer(blank(), gradient(0));
    expect(px(d, 0, 20)[0]).toBeLessThan(8);
    expect(px(d, W - 1, 20)[0]).toBeGreaterThan(247);
    expect(Math.abs(px(d, 31, 5)[0]! - 125)).toBeLessThan(6);
    const up = addFillLayer(blank(), gradient(90));
    expect(px(up, 30, 0)[0]).toBeGreaterThan(245);
    expect(px(up, 30, H - 1)[0]).toBeLessThan(10);
    const reversed = addFillLayer(blank(), gradient(0, { reverse: true }));
    expect(px(reversed, 0, 20)[0]).toBeGreaterThan(247);
  });

  it('a pattern fill tiles its pattern from the phase', () => {
    const p = builtinPatterns().find((q) => q.id === 'umbra-checker')!;
    const d = addFillLayer(blank(), { type: 'pattern', pattern: p, scale: 100, phase: { x: 0, y: 0 } });
    for (const [x, y] of [[0, 0], [8, 0], [17, 9], [40, 33]] as const) {
      const o = ((y % p.height) * p.width + (x % p.width)) * 4;
      expect(px(d, x, y).slice(0, 3)).toEqual([p.data[o], p.data[o + 1], p.data[o + 2]]);
    }
  });

  it('can be re-parameterised, and merges to pixels', () => {
    const d = addFillLayer(blank(), { type: 'solid', color: [1, 0, 0] });
    const e = setFillContent(d, d.layers[0]!.id, { type: 'solid', color: [0, 1, 0] });
    expect(px(e, 3, 3)).toEqual([0, 255, 0, 255]);
    const merged = mergeVisible(e);
    expect(merged.layers[0]!.kind).toBe('pixel');
    expect(px(merged, 3, 3)).toEqual([0, 255, 0, 255]);
  });

  it('round-trip through PSD, patterns included', () => {
    const p = builtinPatterns().find((q) => q.id === 'umbra-bricks')!;
    const contents: FillContent[] = [
      { type: 'solid', color: [0.2, 0.4, 0.6] },
      gradient(30, { style: 'radial', scale: 80, reverse: true, offset: { x: 10, y: -5 } }),
      { type: 'pattern', pattern: p, scale: 100, phase: { x: 3, y: 7 } },
    ];
    for (const content of contents) {
      const d = addFillLayer(blank(), content);
      const back = openPsd(savePsd(d));
      const l = back.doc.layers[0] as FillLayer;
      expect(l.kind).toBe('fill');
      if (content.type === 'pattern') {
        expect(l.content.type).toBe('pattern');
        const c = l.content as Extract<FillContent, { type: 'pattern' }>;
        expect([c.pattern.id, c.pattern.width, c.pattern.height, c.phase]).toEqual([p.id, p.width, p.height, content.phase]);
        expect(Array.from(c.pattern.data)).toEqual(Array.from(p.data));
        expect(back.patterns.map((q) => q.id)).toEqual([p.id]);
      } else if (content.type === 'solid') {
        expect(l.content).toEqual({ type: 'solid', color: [51 / 255, 102 / 255, 153 / 255] });
      } else {
        const c = l.content as Extract<FillContent, { type: 'gradient' }>;
        expect([c.style, c.angle, c.scale, c.reverse, c.offset]).toEqual(['radial', 30, 80, true, { x: 10, y: -5 }]);
      }
      // What it looks like survives too.
      expect(px(back.doc, 20, 20)).toEqual(px(d, 20, 20));
    }
  });
});
