/**
 * Filter Gallery ▸ Brush Strokes (8), Distort (3) and Stylize (1) — spec 05 §B.10. [fit]
 * throughout: see artistic.ts.
 */
import { clamp01, gaussianBlur, hash2, makeRaster, type Raster } from '../core.js';
import { lineBlur } from '../blur.js';
import { remap } from '../distort.js';
import { fbm } from '../render.js';
import { bool, num, str, type FilterContext, type GalleryEffect } from '../types.js';
import { blurPad, blurPlane, channels, eachPixel, hatch, keepAlpha, luma, noiseAt, smoothstep, sobel, textureAt } from './kit.js';

const gPad = (sigma: number) => (sigma < 0.05 ? 0 : Math.max(1, Math.ceil(sigma * 3)));
const halfLine = (len: number) => Math.ceil(len / 2) + 2;

/** Straight colour of pixel i of a raster. */
function colourOf(r: Raster, i: number, out: number[]): number[] {
  const a = r.data[i * 4 + 3]!;
  for (let c = 0; c < 3; c++) out[c] = a > 0 ? r.data[i * 4 + c]! / a : 0;
  return out;
}

const DIRECTIONS = [
  { value: 'rightDiagonal', label: 'Right Diagonal', angle: 45 },
  { value: 'horizontal', label: 'Horizontal', angle: 0 },
  { value: 'leftDiagonal', label: 'Left Diagonal', angle: 135 },
  { value: 'vertical', label: 'Vertical', angle: 90 },
];
export const DIRECTION_OPTIONS = DIRECTIONS.map(({ value, label }) => ({ value, label }));
export const directionAngle = (v: string) => DIRECTIONS.find((d) => d.value === v)?.angle ?? 45;

export const accentedEdges: GalleryEffect = {
  id: 'gallery.accentedEdges',
  label: 'Accented Edges',
  category: 'Brush Strokes',
  params: [
    { key: 'width', label: 'Edge Width', type: 'number', min: 1, max: 14, default: 2 },
    { key: 'brightness', label: 'Edge Brightness', type: 'number', min: 0, max: 50, default: 38 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 5 },
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.3) + 1 + blurPad(num(p, 'width') * 0.4),
  model: '[fit] edges of the image smoothed by Smoothness, widened by Edge Width, drawn light (brightness over 25) or dark (under).',
  run: (src, p) => {
    const w = src.width;
    const h = src.height;
    const { mag } = sobel(blurPlane(luma(src), w, h, num(p, 'smoothness') * 0.3), w, h);
    const e = blurPlane(mag, w, h, num(p, 'width') * 0.4);
    const B = (num(p, 'brightness') - 25) / 25;
    return eachPixel(src, (px, i) => {
      const k = clamp01(e[i]! * 6);
      for (let c = 0; c < 3; c++) px[c] = B >= 0 ? px[c]! + (1 - px[c]!) * k * B : px[c]! * (1 + k * B);
    });
  },
};

export const angledStrokes: GalleryEffect = {
  id: 'gallery.angledStrokes',
  label: 'Angled Strokes',
  category: 'Brush Strokes',
  params: [
    { key: 'balance', label: 'Direction Balance', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'length', label: 'Stroke Length', type: 'number', min: 3, max: 50, default: 15 },
    { key: 'sharpness', label: 'Sharpness', type: 'number', min: 0, max: 10, default: 3 },
  ],
  pad: (p) => halfLine(num(p, 'length')),
  model: '[fit] light areas smeared along one diagonal and dark areas along the other, split at Direction Balance; Sharpness mixes the original back.',
  run: (src, p) => {
    const len = num(p, 'length');
    const a = lineBlur(src, 45, len);
    const b = lineBlur(src, -45, len);
    const t = num(p, 'balance') / 100;
    const s = num(p, 'sharpness') / 25;
    const ca = [0, 0, 0];
    const cb = [0, 0, 0];
    return eachPixel(src, (px, i) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const k = smoothstep(t - 0.1, t + 0.1, l);
      colourOf(a, i, ca);
      colourOf(b, i, cb);
      for (let c = 0; c < 3; c++) px[c] = (cb[c]! + (ca[c]! - cb[c]!) * k) * (1 - s) + px[c]! * s;
    });
  },
};

export const crosshatch: GalleryEffect = {
  id: 'gallery.crosshatch',
  label: 'Crosshatch',
  category: 'Brush Strokes',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 3, max: 50, default: 9 },
    { key: 'sharpness', label: 'Sharpness', type: 'number', min: 0, max: 20, default: 6 },
    { key: 'strength', label: 'Strength', type: 'number', min: 1, max: 3, default: 1 },
  ],
  pad: () => 0,
  model: '[fit] pencil hatching over the colour: one diagonal where darker than mid-grey, both where darker still, repeated Strength times; Sharpness hardens the strokes.',
  run: (src, p, ctx) => {
    const len = num(p, 'length');
    const soft = 0.2 / (1 + num(p, 'sharpness') / 4);
    const S = num(p, 'strength');
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const d = 1 - (0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!);
      let k = 1;
      for (let pass = 0; pass < S; pass++) {
        const h1 = hatch(gx, gy, 45, len, 101 + pass * 7);
        const h2 = hatch(gx, gy, -45, len, 103 + pass * 7);
        k *= 1 - 0.25 * smoothstep(d * 0.7 + soft, d * 0.7 - soft, h1);
        k *= 1 - 0.25 * smoothstep(d * 0.4 + soft, d * 0.4 - soft, h2);
        k *= 1 + 0.12 * smoothstep(1 - d * 0.5 - soft, 1 - d * 0.5 + soft, h1);
      }
      for (let c = 0; c < 3; c++) px[c] = px[c]! * k;
    });
  },
};

export const darkStrokes: GalleryEffect = {
  id: 'gallery.darkStrokes',
  label: 'Dark Strokes',
  category: 'Brush Strokes',
  params: [
    { key: 'balance', label: 'Balance', type: 'number', min: 0, max: 10, default: 5 },
    { key: 'black', label: 'Black Intensity', type: 'number', min: 0, max: 10, default: 6 },
    { key: 'white', label: 'White Intensity', type: 'number', min: 0, max: 10, default: 2 },
  ],
  pad: () => halfLine(14),
  model: '[fit] dark areas painted in short strokes pushed toward black, light areas in long strokes pushed toward white, split at Balance.',
  run: (src, p) => {
    const a = lineBlur(src, 45, 14);
    const b = lineBlur(src, -45, 6);
    const t = num(p, 'balance') / 10;
    const K = num(p, 'black') / 10;
    const Wt = num(p, 'white') / 10;
    const ca = [0, 0, 0];
    const cb = [0, 0, 0];
    return eachPixel(src, (px, i) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const k = smoothstep(t - 0.12, t + 0.12, l);
      colourOf(a, i, ca);
      colourOf(b, i, cb);
      for (let c = 0; c < 3; c++) {
        const dark = cb[c]! * (1 - K * 0.8);
        const light = ca[c]! + (1 - ca[c]!) * Wt * 0.8;
        px[c] = dark + (light - dark) * k;
      }
    });
  },
};

export const inkOutlines: GalleryEffect = {
  id: 'gallery.inkOutlines',
  label: 'Ink Outlines',
  category: 'Brush Strokes',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 1, max: 50, default: 4 },
    { key: 'dark', label: 'Dark Intensity', type: 'number', min: 0, max: 50, default: 20 },
    { key: 'light', label: 'Light Intensity', type: 'number', min: 0, max: 50, default: 10 },
  ],
  pad: (p) => halfLine(num(p, 'length')),
  model: '[fit] fine strokes along the diagonal, edges and shadows inked in black (Dark Intensity), lights lifted (Light Intensity).',
  run: (src, p) => {
    const s = keepAlpha(src, lineBlur(src, 45, num(p, 'length')));
    const { mag } = sobel(luma(src), src.width, src.height);
    const D = num(p, 'dark') / 25;
    const L = num(p, 'light') / 50;
    return eachPixel(s, (px, i) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const ink = clamp01(mag[i]! * D * 2 + (0.35 - l) * D);
      for (let c = 0; c < 3; c++) px[c] = (px[c]! + (1 - px[c]!) * L * l) * (1 - ink);
    });
  },
};

/** Spray: each pixel takes the colour of a pixel up to `radius` away, in a noise-driven direction. */
function spray(src: Raster, ctx: FilterContext, radius: number, smoothness: number, seed: number): Raster {
  if (radius <= 0) return src;
  const out = makeRaster(src.width, src.height);
  const w = src.width;
  const h = src.height;
  const k = Math.min(1, smoothness / 15);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const nx = noiseAt(gx, gy, seed) * (1 - k) + (fbm(gx, gy, 4, seed + 2) - 0.5) * 2 * k;
      const ny = noiseAt(gx, gy, seed + 1) * (1 - k) + (fbm(gx, gy, 4, seed + 3) - 0.5) * 2 * k;
      const sx = Math.min(w - 1, Math.max(0, Math.round(x + nx * radius)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + ny * radius)));
      const o = (y * w + x) * 4;
      out.data.set(src.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), o);
    }
  }
  return keepAlpha(src, out);
}

export const spatter: GalleryEffect = {
  id: 'gallery.spatter',
  label: 'Spatter',
  category: 'Brush Strokes',
  params: [
    { key: 'radius', label: 'Spray Radius', type: 'number', min: 0, max: 25, default: 10 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 5 },
  ],
  pad: (p) => num(p, 'radius') + 2,
  model: '[fit] each pixel takes a neighbour\'s colour up to Spray Radius away; Smoothness turns white-noise scatter into smoother blotches.',
  run: (src, p, ctx) => spray(src, ctx, num(p, 'radius'), num(p, 'smoothness'), 107),
};

export const sprayedStrokes: GalleryEffect = {
  id: 'gallery.sprayedStrokes',
  label: 'Sprayed Strokes',
  category: 'Brush Strokes',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 0, max: 20, default: 12 },
    { key: 'radius', label: 'Spray Radius', type: 'number', min: 0, max: 25, default: 7 },
    { key: 'direction', label: 'Stroke Direction', type: 'select', default: 'rightDiagonal', options: DIRECTION_OPTIONS },
  ],
  pad: (p) => num(p, 'radius') + 2 + halfLine(num(p, 'length')),
  model: '[fit] Spatter (Spray Radius) then a smear of Stroke Length in the chosen direction.',
  run: (src, p, ctx) => {
    const s = spray(src, ctx, num(p, 'radius'), 3, 109);
    const len = num(p, 'length');
    return len > 0 ? keepAlpha(src, lineBlur(s, directionAngle(str(p, 'direction')), len)) : s;
  },
};

export const sumiE: GalleryEffect = {
  id: 'gallery.sumiE',
  label: 'Sumi-e',
  category: 'Brush Strokes',
  params: [
    { key: 'width', label: 'Stroke Width', type: 'number', min: 3, max: 15, default: 10 },
    { key: 'pressure', label: 'Stroke Pressure', type: 'number', min: 0, max: 15, default: 2 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 40, default: 16 },
  ],
  pad: (p) => gPad(num(p, 'width') * 0.25) + 1,
  model: '[fit] soft wet strokes (a blur of Stroke Width) with rich blacks: shadows inked by Stroke Pressure and contrast raised.',
  run: (src, p) => {
    const b = keepAlpha(src, gaussianBlur(src, num(p, 'width') * 0.25));
    const P = num(p, 'pressure') / 15;
    const C = 1 + num(p, 'contrast') / 15;
    const { mag } = sobel(luma(b), src.width, src.height);
    return eachPixel(b, (px, i) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const ink = 1 - (0.5 + P * 0.5) * (1 - l) ** 2 - clamp01(mag[i]! * 3) * 0.3;
      for (let c = 0; c < 3; c++) px[c] = 0.5 + (px[c]! * ink - 0.5) * C;
    });
  },
};

// ---- Distort ------------------------------------------------------------------------------

export const diffuseGlow: GalleryEffect = {
  id: 'gallery.diffuseGlow',
  label: 'Diffuse Glow',
  category: 'Distort',
  params: [
    { key: 'graininess', label: 'Graininess', type: 'number', min: 0, max: 10, default: 6 },
    { key: 'glow', label: 'Glow Amount', type: 'number', min: 0, max: 20, default: 10 },
    { key: 'clear', label: 'Clear Amount', type: 'number', min: 0, max: 20, default: 15 },
  ],
  pad: () => 0,
  model: '[fit] the background colour glows through the highlights (Glow Amount, held off by Clear Amount), carried on grain.',
  run: (src, p, ctx) => {
    const G = num(p, 'glow') / 20;
    const Cl = num(p, 'clear') / 20;
    const N = num(p, 'graininess') / 10;
    const bg = ctx.background;
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const grain = hash2(gx, gy, 113);
      const g = clamp01(smoothstep(Cl * 0.8, 1, l) * G * 1.5 * (1 - N * 0.6 + N * 1.2 * grain));
      const n = (grain - 0.5) * N * 0.08;
      for (let c = 0; c < 3; c++) px[c] = px[c]! + (bg[c]! - px[c]!) * g + n;
    });
  },
};

export const GLASS_TEXTURES = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'frosted', label: 'Frosted' },
  { value: 'tinyLens', label: 'Tiny Lens' },
];

export const glass: GalleryEffect = {
  id: 'gallery.glass',
  label: 'Glass',
  category: 'Distort',
  params: [
    { key: 'distortion', label: 'Distortion', type: 'number', min: 0, max: 20, default: 5 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 3 },
    { key: 'texture', label: 'Texture', type: 'select', default: 'frosted', options: GLASS_TEXTURES },
    { key: 'scaling', label: 'Scaling', type: 'number', min: 50, max: 200, default: 100, unit: '%' },
    { key: 'invert', label: 'Invert', type: 'bool', default: false },
  ],
  pad: (p) => Math.ceil(num(p, 'distortion') * 2) + 3,
  model: '[fit] displacement by the slope of the texture (differenced over Smoothness px), up to 2 × Distortion px.',
  run: (src, p, ctx) => {
    const D = num(p, 'distortion') * (bool(p, 'invert') ? -1 : 1);
    const kind = str(p, 'texture');
    const sc = num(p, 'scaling') / 100;
    const s = num(p, 'smoothness') * 0.5 + 0.5;
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const dx = (textureAt(kind, gx + s, gy, sc) - textureAt(kind, gx - s, gy, sc)) * D;
      const dy = (textureAt(kind, gx, gy + s, sc) - textureAt(kind, gx, gy - s, sc)) * D;
      return [gx + dx, gy + dy];
    });
  },
};

export const oceanRipple: GalleryEffect = {
  id: 'gallery.oceanRipple',
  label: 'Ocean Ripple',
  category: 'Distort',
  params: [
    { key: 'size', label: 'Ripple Size', type: 'number', min: 1, max: 15, default: 9 },
    { key: 'magnitude', label: 'Ripple Magnitude', type: 'number', min: 0, max: 20, default: 9 },
  ],
  pad: (p) => Math.ceil(num(p, 'magnitude') * 0.6) + 3,
  model: '[fit] displacement by two smooth noise fields folded through a sine, feature size from Ripple Size, up to 0.6 × Magnitude px.',
  run: (src, p, ctx) => {
    const size = num(p, 'size') + 2;
    const M = num(p, 'magnitude') * 0.6;
    return remap(src, ctx, 'repeat', (gx, gy) => [
      gx + Math.sin(fbm(gx, gy, size, 127) * Math.PI * 4) * M,
      gy + Math.sin(fbm(gx, gy, size, 131) * Math.PI * 4) * M,
    ]);
  },
};

// ---- Stylize ------------------------------------------------------------------------------

export const glowingEdges: GalleryEffect = {
  id: 'gallery.glowingEdges',
  label: 'Glowing Edges',
  category: 'Stylize',
  params: [
    { key: 'width', label: 'Edge Width', type: 'number', min: 1, max: 14, default: 2 },
    { key: 'brightness', label: 'Edge Brightness', type: 'number', min: 0, max: 20, default: 6 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 5 },
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.3) + 1 + blurPad(num(p, 'width') * 0.35),
  model: '[fit] per-channel edge magnitude of the smoothed image, widened by Edge Width and scaled by Brightness, on black — a coloured Find Edges, inverted.',
  run: (src, p) => {
    const w = src.width;
    const h = src.height;
    const sm = num(p, 'smoothness') * 0.3;
    const wd = num(p, 'width') * 0.35;
    const B = num(p, 'brightness') / 2 + 1;
    const planes = channels(src).map((c) => blurPlane(sobel(blurPlane(c, w, h, sm), w, h).mag, w, h, wd));
    return eachPixel(src, (px, i) => {
      for (let c = 0; c < 3; c++) px[c] = clamp01(planes[c]![i]! * B * 2.5);
    });
  },
};

export const BRUSH_STROKES: GalleryEffect[] = [accentedEdges, angledStrokes, crosshatch, darkStrokes, inkOutlines, spatter, sprayedStrokes, sumiE];
export const GALLERY_DISTORT: GalleryEffect[] = [diffuseGlow, glass, oceanRipple];
export const GALLERY_STYLIZE: GalleryEffect[] = [glowingEdges];
