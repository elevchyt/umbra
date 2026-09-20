import { describe, expect, it } from 'vitest';
import {
  FOREGROUND_TO_BACKGROUND,
  FOREGROUND_TO_TRANSPARENT,
  gradientRamp,
  gradientT,
  sampleGradient,
  type Gradient,
} from './gradient.js';

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];
const bw = FOREGROUND_TO_BACKGROUND(BLACK, WHITE);

describe('ramp sampling', () => {
  it('hits the endpoints exactly', () => {
    expect(sampleGradient(bw, 0)).toEqual([0, 0, 0, 1]);
    expect(sampleGradient(bw, 1)).toEqual([1, 1, 1, 1]);
  });

  it('interpolates linearly in between', () => {
    const [r] = sampleGradient(bw, 0.25);
    expect(r).toBeCloseTo(0.25);
  });

  it('clamps outside the ramp', () => {
    expect(sampleGradient(bw, -3)[0]).toBe(0);
    expect(sampleGradient(bw, 4)[0]).toBe(1);
  });

  it('keeps colour and opacity stops independent', () => {
    const g = FOREGROUND_TO_TRANSPARENT([1, 0, 0]);
    const [r, , , a] = sampleGradient(g, 0.5);
    // Colour is constant across the ramp; only alpha moves.
    expect(r).toBe(1);
    expect(a).toBeCloseTo(0.5);
  });

  it('honours a stop midpoint', () => {
    const g: Gradient = {
      colorStops: [
        { at: 0, color: BLACK, midpoint: 0.25 },
        { at: 1, color: WHITE },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    };
    // The blend reaches halfway a quarter of the way along, not half way.
    expect(sampleGradient(g, 0.25)[0]).toBeCloseTo(0.5, 5);
    expect(sampleGradient(g, 0.5)[0]).toBeGreaterThan(0.6);
  });

  it('handles three stops', () => {
    const g: Gradient = {
      colorStops: [
        { at: 0, color: [1, 0, 0] },
        { at: 0.5, color: [0, 1, 0] },
        { at: 1, color: [0, 0, 1] },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    };
    expect(sampleGradient(g, 0.5)).toEqual([0, 1, 0, 1]);
    const [r, gg] = sampleGradient(g, 0.25);
    expect(r).toBeCloseTo(0.5);
    expect(gg).toBeCloseTo(0.5);
  });

  it('builds a lookup table with the right ends', () => {
    const ramp = gradientRamp(bw, 256);
    expect(ramp.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 255]));
    expect(ramp.slice(-4)).toEqual(new Uint8Array([255, 255, 255, 255]));
  });
});

describe('geometry', () => {
  it('linear runs along the drag and is constant across it', () => {
    expect(gradientT('linear', 0, 0, 100, 0, 0, 0)).toBeCloseTo(0);
    expect(gradientT('linear', 0, 0, 100, 0, 50, 0)).toBeCloseTo(0.5);
    expect(gradientT('linear', 0, 0, 100, 0, 50, 999)).toBeCloseTo(0.5);
    expect(gradientT('linear', 0, 0, 100, 0, 150, 0)).toBeCloseTo(1.5);
  });

  it('radial depends only on distance from the start', () => {
    expect(gradientT('radial', 0, 0, 100, 0, 0, 0)).toBeCloseTo(0);
    expect(gradientT('radial', 0, 0, 100, 0, 0, 50)).toBeCloseTo(0.5);
    expect(gradientT('radial', 0, 0, 100, 0, 50, 0)).toBeCloseTo(0.5);
  });

  it('reflected mirrors about the start', () => {
    expect(gradientT('reflected', 0, 0, 100, 0, 50, 0)).toBeCloseTo(0.5);
    expect(gradientT('reflected', 0, 0, 100, 0, -50, 0)).toBeCloseTo(0.5);
  });

  it('angle sweeps a full turn', () => {
    expect(gradientT('angle', 0, 0, 100, 0, 100, 0)).toBeCloseTo(0);
    // A quarter turn round from the drag direction.
    expect(gradientT('angle', 0, 0, 100, 0, 0, 100)).toBeCloseTo(0.25);
    expect(gradientT('angle', 0, 0, 100, 0, -100, 0)).toBeCloseTo(0.5);
  });

  it('diamond uses the rotated L1 distance', () => {
    // On the axes it matches radial; on the diagonal it is further along.
    expect(gradientT('diamond', 0, 0, 100, 0, 50, 0)).toBeCloseTo(0.5);
    expect(gradientT('diamond', 0, 0, 100, 0, 0, 50)).toBeCloseTo(0.5);
    expect(gradientT('diamond', 0, 0, 100, 0, 50, 50)).toBeCloseTo(1);
  });

  it('degenerates safely when the drag has no length', () => {
    for (const style of ['linear', 'radial', 'angle', 'reflected', 'diamond'] as const) {
      expect(Number.isFinite(gradientT(style, 5, 5, 5, 5, 9, 9))).toBe(true);
    }
  });
});
