import { describe, expect, it } from 'vitest';
import { applyImage, calculations, DEFAULT_APPLY_IMAGE, DEFAULT_CALCULATIONS } from './applyimage.js';

const px = (...v: number[]) => new Uint8ClampedArray(v);

describe('Apply Image', () => {
  it('Multiply by itself squares each channel', () => {
    const t = px(128, 64, 255, 255);
    applyImage(t, px(128, 64, 255, 255), DEFAULT_APPLY_IMAGE);
    expect([...t]).toEqual([64, 16, 255, 255]);
  });

  it('a single channel is applied to all three, and Invert flips it', () => {
    const t = px(200, 200, 200, 255);
    applyImage(t, px(255, 0, 0, 255), { ...DEFAULT_APPLY_IMAGE, channel: 'g', invert: true, blend: 'normal' });
    expect([...t]).toEqual([255, 255, 255, 255]);
  });

  it('Add and Subtract follow (a ± b) / scale + offset', () => {
    const t = px(100, 100, 100, 255);
    applyImage(t, px(60, 60, 60, 255), { ...DEFAULT_APPLY_IMAGE, blend: 'add', scale: 2, offset: 10 });
    expect(t[0]).toBe(90);
    const u = px(100, 100, 100, 255);
    applyImage(u, px(60, 60, 60, 255), { ...DEFAULT_APPLY_IMAGE, blend: 'subtract', scale: 1, offset: 128 });
    expect(u[0]).toBe(168);
  });

  it('opacity and coverage mix toward the original; transparent pixels are untouched', () => {
    const t = px(200, 200, 200, 255, 9, 9, 9, 0);
    applyImage(t, px(0, 0, 0, 255, 0, 0, 0, 255), { ...DEFAULT_APPLY_IMAGE, blend: 'normal', opacity: 0.5 });
    expect([...t]).toEqual([100, 100, 100, 255, 9, 9, 9, 0]);
  });
});

describe('Calculations', () => {
  it('blends two channels into one grey channel', () => {
    const a = px(255, 0, 0, 255);
    const b = px(0, 128, 0, 255);
    expect([...calculations(a, b, { ...DEFAULT_CALCULATIONS, source1: { layerId: null, channel: 'r', invert: false }, source2: { layerId: null, channel: 'g', invert: false }, blend: 'screen' })]).toEqual([255]);
    expect([...calculations(a, b, { ...DEFAULT_CALCULATIONS, source1: { layerId: null, channel: 'r', invert: false }, source2: { layerId: null, channel: 'g', invert: false }, blend: 'multiply' })]).toEqual([128]);
  });
});
