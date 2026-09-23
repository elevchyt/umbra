/**
 * Fill layers — Layer ▸ New Fill Layer ▸ Solid Color / Gradient / Pattern (spec 02 §3,
 * spec 06 §8).
 *
 * A fill layer is an infinite source: every document pixel has a colour, and its coverage is
 * the mask × fill × opacity like any pixel layer's. Nothing is stored per pixel, so a fill
 * layer costs nothing to keep and can be re-parameterised forever.
 *
 * This module is the CPU definition. The GPU draws the same three sources in
 * `engine/render/fill.glsl.ts`, and the parity suite compares the two.
 */
import { gradientRamp, gradientT, type Gradient, type GradientStyle } from './gradient.js';

export interface PatternDef {
  /** Stable id; PSD fill layers refer to their pattern by it. */
  id: string;
  name: string;
  width: number;
  height: number;
  /** Straight-alpha RGBA8, row-major. */
  data: Uint8Array;
}

export type FillContent =
  | { type: 'solid'; color: [number, number, number] }
  | {
      type: 'gradient';
      gradient: Gradient;
      style: GradientStyle;
      /** Degrees, counter-clockwise, 0 = left to right — Photoshop's convention. */
      angle: number;
      /** Percent, 10…150. */
      scale: number;
      reverse: boolean;
      /** Centre offset as a percentage of the canvas size. */
      offset: { x: number; y: number };
    }
  | {
      type: 'pattern';
      pattern: PatternDef;
      /** Percent, 1…1000. */
      scale: number;
      /** Pattern origin in document pixels ("Snap to Origin" resets it to 0,0). */
      phase: { x: number; y: number };
    };

export type FillType = FillContent['type'];

export const FILL_LABEL: Record<FillType, string> = {
  solid: 'Color Fill',
  gradient: 'Gradient Fill',
  pattern: 'Pattern Fill',
};

/**
 * A gradient fill's drag, in document coordinates, for a canvas of `width`×`height`.
 *
 * `[fit]`: Photoshop spans a linear gradient fill across the canvas's extent along the angle,
 * so 0° runs edge to edge horizontally and 45° corner to corner; the radial styles use half
 * that extent as the radius. Scale multiplies the length and Offset moves the centre.
 */
export function gradientFillGeometry(
  fill: Extract<FillContent, { type: 'gradient' }>,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const a = (fill.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = -Math.sin(a);
  const extent = (Math.abs(width * dx) + Math.abs(height * dy)) * (fill.scale / 100);
  const cx = width / 2 + (fill.offset.x / 100) * width;
  const cy = height / 2 + (fill.offset.y / 100) * height;
  if (fill.style === 'linear') {
    return { x0: cx - (dx * extent) / 2, y0: cy - (dy * extent) / 2, x1: cx + (dx * extent) / 2, y1: cy + (dy * extent) / 2 };
  }
  return { x0: cx, y0: cy, x1: cx + (dx * extent) / 2, y1: cy + (dy * extent) / 2 };
}

/** Pattern texel for a document pixel, honouring scale (nearest) and phase. */
export function patternTexel(p: PatternDef, scale: number, phase: { x: number; y: number }, x: number, y: number): number {
  const s = scale / 100;
  const px = Math.floor((x + 0.5 - phase.x) / s);
  const py = Math.floor((y + 0.5 - phase.y) / s);
  const tx = ((px % p.width) + p.width) % p.width;
  const ty = ((py % p.height) + p.height) % p.height;
  return (ty * p.width + tx) * 4;
}

/**
 * A sampler for the CPU reference: straight RGBA 0…1 at a document pixel. The gradient goes
 * through the same 256-entry, 8-bit ramp the GPU uploads, so the two agree by construction.
 */
export function fillSampler(
  fill: FillContent,
  width: number,
  height: number,
): (x: number, y: number) => { color: [number, number, number]; alpha: number } {
  switch (fill.type) {
    case 'solid': {
      const color = fill.color;
      return () => ({ color: [color[0], color[1], color[2]], alpha: 1 });
    }
    case 'gradient': {
      const ramp = gradientRamp(fill.gradient);
      const { x0, y0, x1, y1 } = gradientFillGeometry(fill, width, height);
      return (x, y) => {
        let t = gradientT(fill.style, x0, y0, x1, y1, x + 0.5, y + 0.5);
        t = Math.min(1, Math.max(0, t));
        if (fill.reverse) t = 1 - t;
        const i = Math.round(t * 255) * 4;
        return { color: [ramp[i]! / 255, ramp[i + 1]! / 255, ramp[i + 2]! / 255], alpha: ramp[i + 3]! / 255 };
      };
    }
    case 'pattern': {
      const p = fill.pattern;
      return (x, y) => {
        const o = patternTexel(p, fill.scale, fill.phase, x, y);
        return { color: [p.data[o]! / 255, p.data[o + 1]! / 255, p.data[o + 2]! / 255], alpha: p.data[o + 3]! / 255 };
      };
    }
  }
}

// ---- built-in patterns ------------------------------------------------------------------------

/**
 * A small starter set, drawn procedurally here (original, not Photoshop's). Edit ▸ Define
 * Pattern adds to it, and patterns found in opened PSDs join it too.
 */
export function builtinPatterns(): PatternDef[] {
  const make = (id: string, name: string, w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): PatternDef => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
    }
    return { id, name, width: w, height: h, data };
  };
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) / 65536;
  return [
    make('umbra-checker', 'Checkerboard', 16, 16, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [204, 204, 204, 255] : [255, 255, 255, 255]),
    make('umbra-stripes', 'Diagonal Stripes', 12, 12, (x, y) => ((x + y) % 12 < 4 ? [60, 60, 60, 255] : [230, 230, 230, 255])),
    make('umbra-dots', 'Dots', 12, 12, (x, y) => (Math.hypot(x - 5.5, y - 5.5) < 3 ? [40, 40, 40, 255] : [245, 245, 245, 255])),
    make('umbra-grid', 'Grid', 16, 16, (x, y) => (x === 0 || y === 0 ? [120, 140, 170, 255] : [250, 250, 250, 255])),
    make('umbra-bricks', 'Bricks', 32, 16, (x, y) => {
      const row = y >> 3;
      const bx = (x + (row % 2 ? 8 : 0)) % 16;
      return y % 8 === 7 || bx === 15 ? [200, 196, 190, 255] : [158, 74, 52, 255];
    }),
    make('umbra-noise', 'Grain', 32, 32, () => {
      const v = Math.round(110 + rnd() * 70);
      return [v, v, v, 255];
    }),
  ];
}
