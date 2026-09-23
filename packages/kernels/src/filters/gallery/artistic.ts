/**
 * Filter Gallery ▸ Artistic (15) — spec 05 §B.10. [fit] throughout: Photoshop publishes no
 * algorithms for these, so each is built from the shared toolkit to be "recognisably the same
 * effect", with Photoshop's slider names, ranges and defaults.
 */
import { clamp01, gaussianBlur, hash2, type Raster } from '../core.js';
import { lineBlur } from '../blur.js';
import { fromStraight8, medianChannels } from '../noise.js';
import { kuwahara } from '../stylize.js';
import { fbm } from '../render.js';
import { bool, num, str, type GalleryEffect } from '../types.js';
import { blurPad, blurPlane, eachPixel, hatch, keepAlpha, lightAngle, luma, noiseAt, posterize, smoothstep, sobel, textureParams, texturize, shade } from './kit.js';

const gPad = (sigma: number) => (sigma < 0.05 ? 0 : Math.max(1, Math.ceil(sigma * 3)));

/** Brightness lift of the highlights shared by Film Grain and Smudge Stick. */
function highlight(l: number, area: number, intensity: number): number {
  if (area <= 0) return 0;
  return smoothstep(1 - (area / 20) * 0.6, 1, l) * (intensity / 10) * 0.5;
}

export const coloredPencil: GalleryEffect = {
  id: 'gallery.coloredPencil',
  label: 'Colored Pencil',
  category: 'Artistic',
  params: [
    { key: 'width', label: 'Pencil Width', type: 'number', min: 1, max: 24, default: 4 },
    { key: 'pressure', label: 'Stroke Pressure', type: 'number', min: 0, max: 15, default: 8 },
    { key: 'paper', label: 'Paper Brightness', type: 'number', min: 0, max: 50, default: 25 },
  ],
  pad: () => 1,
  model: '[fit] crosshatched strokes of the image colour, denser where darker and along edges, on paper of the background colour.',
  run: (src, p, ctx) => {
    const W = num(p, 'width');
    const P = num(p, 'pressure');
    const paper = 0.5 + num(p, 'paper') / 100;
    const l = luma(src);
    const { mag } = sobel(l, src.width, src.height);
    const k = Math.max(1, W / 4);
    const [b0, b1, b2] = ctx.background;
    return eachPixel(src, (px, i, x, y) => {
      const gx = (x + ctx.originX) / k;
      const gy = (y + ctx.originY) / k;
      const d = 1 - l[i]! + mag[i]! * 2;
      const t = d * (0.35 + P / 25);
      const a = smoothstep(t + 0.08, t - 0.08, hatch(gx, gy, 45, 3, 5));
      const b = smoothstep(t * 0.6 + 0.08, t * 0.6 - 0.08, hatch(gx, gy, -45, 3, 9));
      const cover = Math.max(a, b);
      px[0] = b0 * paper + (px[0]! - b0 * paper) * cover;
      px[1] = b1 * paper + (px[1]! - b1 * paper) * cover;
      px[2] = b2 * paper + (px[2]! - b2 * paper) * cover;
    });
  },
};

export const cutout: GalleryEffect = {
  id: 'gallery.cutout',
  label: 'Cutout',
  category: 'Artistic',
  params: [
    { key: 'levels', label: 'Number of Levels', type: 'number', min: 2, max: 8, default: 4 },
    { key: 'simplicity', label: 'Edge Simplicity', type: 'number', min: 0, max: 10, default: 4 },
    { key: 'fidelity', label: 'Edge Fidelity', type: 'number', min: 1, max: 3, default: 2 },
  ],
  pad: (p) => gPad(num(p, 'simplicity') * 0.6) + (4 - num(p, 'fidelity')) + 1,
  model: '[fit] smooth by Edge Simplicity, median by (4 − Edge Fidelity), then quantise luma to Number of Levels and chroma to coarse steps, so each area is one flat colour near its own hue (a per-channel posterize shifted hues).',
  run: (src, p) => {
    const blurred = gaussianBlur(src, num(p, 'simplicity') * 0.6);
    const m = keepAlpha(src, fromStraight8(src, medianChannels(blurred, 4 - num(p, 'fidelity'))));
    const L = num(p, 'levels');
    // Luma to Number of Levels, the two chroma axes to coarse steps: every area comes out one
    // flat colour of roughly its own hue — pieces of coloured paper.
    const step = 0.09;
    return eachPixel(m, (px) => {
      const y = 0.299 * px[0]! + 0.587 * px[1]! + 0.114 * px[2]!;
      const cb = Math.round((px[2]! - y) / step) * step;
      const cr = Math.round((px[0]! - y) / step) * step;
      const q = Math.round(y * (L - 1)) / (L - 1);
      px[0] = q + cr;
      px[2] = q + cb;
      px[1] = (q - 0.299 * px[0]! - 0.114 * px[2]!) / 0.587;
    });
  },
};

export const dryBrush: GalleryEffect = {
  id: 'gallery.dryBrush',
  label: 'Dry Brush',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Brush Size', type: 'number', min: 0, max: 10, default: 2 },
    { key: 'detail', label: 'Brush Detail', type: 'number', min: 0, max: 10, default: 8 },
    { key: 'texture', label: 'Texture', type: 'number', min: 1, max: 3, default: 1 },
  ],
  pad: (p) => Math.round(2 + num(p, 'size') * 1.5) + 1,
  model: '[fit] Kuwahara of radius 2 + 1.5 × Size, posterized to 3 + Detail levels, with grain from Texture.',
  run: (src, p, ctx) => {
    const k = keepAlpha(src, kuwahara(src, Math.round(2 + num(p, 'size') * 1.5)));
    const L = 3 + num(p, 'detail');
    const T = num(p, 'texture');
    return eachPixel(k, (px, _i, x, y) => {
      const n = noiseAt(x + ctx.originX, y + ctx.originY, 61) * 0.03 * (T - 1);
      for (let c = 0; c < 3; c++) px[c] = posterize(px[c]!, L) + n;
    });
  },
};

export const filmGrain: GalleryEffect = {
  id: 'gallery.filmGrain',
  label: 'Film Grain',
  category: 'Artistic',
  params: [
    { key: 'grain', label: 'Grain', type: 'number', min: 0, max: 20, default: 4 },
    { key: 'highlight', label: 'Highlight Area', type: 'number', min: 0, max: 20, default: 0 },
    { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 10, default: 10 },
  ],
  pad: () => 0,
  model: '[fit] monochrome grain strongest in the shadows and midtones, plus a lift of the highlights (Highlight Area × Intensity).',
  run: (src, p, ctx) => {
    const G = num(p, 'grain') / 20;
    const H = num(p, 'highlight');
    const I = num(p, 'intensity');
    return eachPixel(src, (px, _i, x, y) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const n = noiseAt(x + ctx.originX, y + ctx.originY, 67) * G * 0.35 * (1 - l * 0.6);
      const lift = highlight(l, H, I);
      for (let c = 0; c < 3; c++) px[c] = px[c]! + n + lift;
    });
  },
};

export const fresco: GalleryEffect = {
  id: 'gallery.fresco',
  label: 'Fresco',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Brush Size', type: 'number', min: 0, max: 10, default: 2 },
    { key: 'detail', label: 'Brush Detail', type: 'number', min: 0, max: 10, default: 8 },
    { key: 'texture', label: 'Texture', type: 'number', min: 1, max: 3, default: 1 },
  ],
  pad: (p) => num(p, 'size') + 4,
  model: '[fit] Kuwahara of radius Size + 2, edges darkened (more at low Detail), contrast raised, grain from Texture.',
  run: (src, p, ctx) => {
    const k = keepAlpha(src, kuwahara(src, num(p, 'size') + 2));
    const { mag } = sobel(luma(k), src.width, src.height);
    const D = num(p, 'detail');
    const T = num(p, 'texture');
    return eachPixel(k, (px, i, x, y) => {
      const dark = 1 - clamp01(mag[i]! * (3.5 - D * 0.2));
      const n = noiseAt(x + ctx.originX, y + ctx.originY, 71) * 0.04 * T;
      for (let c = 0; c < 3; c++) px[c] = (0.5 + (px[c]! - 0.5) * 1.35) * dark + n;
    });
  },
};

const NEON = [
  { value: 'blue', label: 'Blue', rgb: [0.1, 0.4, 1] },
  { value: 'cyan', label: 'Cyan', rgb: [0, 1, 1] },
  { value: 'green', label: 'Green', rgb: [0.2, 1, 0.2] },
  { value: 'magenta', label: 'Magenta', rgb: [1, 0.2, 1] },
  { value: 'red', label: 'Red', rgb: [1, 0.15, 0.1] },
  { value: 'yellow', label: 'Yellow', rgb: [1, 1, 0.2] },
  { value: 'white', label: 'White', rgb: [1, 1, 1] },
];

export const neonGlow: GalleryEffect = {
  id: 'gallery.neonGlow',
  label: 'Neon Glow',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Glow Size', type: 'number', min: -24, max: 24, default: 5 },
    { key: 'brightness', label: 'Glow Brightness', type: 'number', min: 0, max: 50, default: 15 },
    { key: 'colour', label: 'Glow Color', type: 'select', default: 'blue', options: NEON.map(({ value, label }) => ({ value, label })) },
  ],
  pad: (p) => blurPad(Math.abs(num(p, 'size')) / 2 + 1) + 1,
  model: '[fit] the image in darkened grey, with edges blurred by |Glow Size| and screened on in the glow colour; a negative size glows into the darks instead. Photoshop\'s colour swatch is a list of presets here.',
  run: (src, p) => {
    const size = num(p, 'size');
    const B = num(p, 'brightness') / 10;
    const rgb = NEON.find((n) => n.value === str(p, 'colour'))?.rgb ?? NEON[0]!.rgb;
    const l = luma(src);
    const edges = blurPlane(sobel(l, src.width, src.height).mag, src.width, src.height, Math.abs(size) / 2 + 1);
    return eachPixel(src, (px, i) => {
      const g = size >= 0 ? clamp01(edges[i]! * B * 2) : clamp01((1 - l[i]!) * B * 0.2 + edges[i]! * B);
      const base = l[i]! * 0.55;
      for (let c = 0; c < 3; c++) px[c] = 1 - (1 - base) * (1 - rgb[c]! * g);
    });
  },
};

const DAUBS = [
  { value: 'simple', label: 'Simple' },
  { value: 'lightRough', label: 'Light Rough' },
  { value: 'darkRough', label: 'Dark Rough' },
  { value: 'wideSharp', label: 'Wide Sharp' },
  { value: 'wideBlurry', label: 'Wide Blurry' },
  { value: 'sparkle', label: 'Sparkle' },
];

export const paintDaubs: GalleryEffect = {
  id: 'gallery.paintDaubs',
  label: 'Paint Daubs',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Brush Size', type: 'number', min: 1, max: 50, default: 8 },
    { key: 'sharpness', label: 'Sharpness', type: 'number', min: 0, max: 40, default: 7 },
    { key: 'type', label: 'Brush Type', type: 'select', default: 'simple', options: DAUBS },
  ],
  pad: (p) => Math.max(1, Math.round(num(p, 'size') / (str(p, 'type').startsWith('wide') ? 2.5 : 4))) + 4,
  model: '[fit] median of radius Size/4 (Size/2.5 for the wide brushes), then unsharp masking by Sharpness; the rough and sparkle brushes add grain.',
  run: (src, p, ctx) => {
    const type = str(p, 'type');
    const r = Math.max(1, Math.round(num(p, 'size') / (type.startsWith('wide') ? 2.5 : 4)));
    let m = keepAlpha(src, fromStraight8(src, medianChannels(src, r)));
    if (type === 'wideBlurry') m = keepAlpha(src, gaussianBlur(m, 1));
    const blurred = gaussianBlur(m, 1);
    const amt = (num(p, 'sharpness') / 10) * (type === 'wideSharp' ? 1.6 : 1);
    return eachPixel(m, (px, i, x, y) => {
      const a = blurred.data[i * 4 + 3]!;
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      let n = 0;
      if (type === 'lightRough') n = Math.max(0, noiseAt(gx, gy, 73)) * 0.12;
      else if (type === 'darkRough') n = Math.min(0, noiseAt(gx, gy, 73)) * 0.12;
      else if (type === 'sparkle') n = hash2(gx, gy, 79) > 0.985 ? 0.6 : 0;
      for (let c = 0; c < 3; c++) {
        const b = a > 0 ? blurred.data[i * 4 + c]! / a : px[c]!;
        px[c] = px[c]! + (px[c]! - b) * amt + n;
      }
    });
  },
};

export const paletteKnife: GalleryEffect = {
  id: 'gallery.paletteKnife',
  label: 'Palette Knife',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Stroke Size', type: 'number', min: 1, max: 50, default: 25 },
    { key: 'detail', label: 'Stroke Detail', type: 'number', min: 1, max: 3, default: 3 },
    { key: 'softness', label: 'Softness', type: 'number', min: 0, max: 10, default: 0 },
  ],
  pad: (p) => Math.round(num(p, 'size') / 6) + 2 + gPad(num(p, 'softness') * 0.4),
  model: '[fit] Kuwahara of radius Size/6 + 1, posterized to 4 + 3 × Detail levels, softened by a blur.',
  run: (src, p) => {
    const k = keepAlpha(src, kuwahara(src, Math.round(num(p, 'size') / 6) + 1));
    const L = 4 + 3 * num(p, 'detail');
    const post = eachPixel(k, (px) => {
      for (let c = 0; c < 3; c++) px[c] = posterize(px[c]!, L);
    });
    return keepAlpha(src, gaussianBlur(post, num(p, 'softness') * 0.4));
  },
};

export const plasticWrap: GalleryEffect = {
  id: 'gallery.plasticWrap',
  label: 'Plastic Wrap',
  category: 'Artistic',
  params: [
    { key: 'strength', label: 'Highlight Strength', type: 'number', min: 0, max: 20, default: 15 },
    { key: 'detail', label: 'Detail', type: 'number', min: 1, max: 15, default: 9 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 7 },
  ],
  pad: (p) => blurPad(num(p, 'smoothness') * 0.6 + (15 - num(p, 'detail')) * 0.2) + 1,
  model: '[fit] the smoothed luminance as a height field, lit from the top left: bright specular sheen where it faces the light, a little shadow where it does not.',
  run: (src, p) => {
    const S = num(p, 'strength') / 20;
    const h = blurPlane(luma(src), src.width, src.height, num(p, 'smoothness') * 0.6 + (15 - num(p, 'detail')) * 0.2);
    const s = shade(h, src.width, src.height, 135, 25);
    return eachPixel(src, (px, i) => {
      const hi = smoothstep(0.55, 0.85, s[i]!) * S;
      const lo = smoothstep(0.5, 0.2, s[i]!) * 0.3 * S;
      for (let c = 0; c < 3; c++) px[c] = px[c]! * (1 - lo) + hi;
    });
  },
};

export const posterEdges: GalleryEffect = {
  id: 'gallery.posterEdges',
  label: 'Poster Edges',
  category: 'Artistic',
  params: [
    { key: 'thickness', label: 'Edge Thickness', type: 'number', min: 0, max: 10, default: 2 },
    { key: 'intensity', label: 'Edge Intensity', type: 'number', min: 0, max: 10, default: 1 },
    { key: 'posterization', label: 'Posterization', type: 'number', min: 0, max: 6, default: 2 },
  ],
  pad: (p) => blurPad(num(p, 'thickness') * 0.35) + 1,
  model: '[fit] posterize to Posterization + 2 levels, and draw black along edges found in the image smoothed by Edge Thickness.',
  run: (src, p) => {
    const L = num(p, 'posterization') + 2;
    const I = num(p, 'intensity');
    const { mag } = sobel(blurPlane(luma(src), src.width, src.height, num(p, 'thickness') * 0.35), src.width, src.height);
    return eachPixel(src, (px, i) => {
      const dark = clamp01(mag[i]! * (1 + I) * 3 - 0.1);
      for (let c = 0; c < 3; c++) px[c] = posterize(px[c]!, L) * (1 - dark);
    });
  },
};

export const roughPastels: GalleryEffect = {
  id: 'gallery.roughPastels',
  label: 'Rough Pastels',
  category: 'Artistic',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 0, max: 40, default: 6 },
    { key: 'detail', label: 'Stroke Detail', type: 'number', min: 1, max: 20, default: 4 },
    ...textureParams(20),
  ],
  pad: (p) => Math.ceil(num(p, 'length') / 2) + 2,
  model: '[fit] smeared along the diagonal by Stroke Length (less where Detail is high), then texturized.',
  run: (src, p, ctx) => {
    const len = num(p, 'length');
    const smear = len > 0 ? keepAlpha(src, lineBlur(src, 45, len)) : src;
    const d = num(p, 'detail') / 40;
    const mixed = eachPixel(smear, (px, i) => {
      const a = src.data[i * 4 + 3]!;
      for (let c = 0; c < 3; c++) px[c] = px[c]! + (src.data[i * 4 + c]! / a - px[c]!) * d;
    });
    return texturize(mixed, ctx, str(p, 'texture'), num(p, 'scaling'), num(p, 'relief'), lightAngle(str(p, 'light')), bool(p, 'invert'));
  },
};

export const smudgeStick: GalleryEffect = {
  id: 'gallery.smudgeStick',
  label: 'Smudge Stick',
  category: 'Artistic',
  params: [
    { key: 'length', label: 'Stroke Length', type: 'number', min: 0, max: 10, default: 2 },
    { key: 'highlight', label: 'Highlight Area', type: 'number', min: 0, max: 20, default: 0 },
    { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 10, default: 10 },
  ],
  pad: (p) => Math.ceil(num(p, 'length') * 1.5) + 2,
  model: '[fit] darker areas smeared diagonally by 3 × Stroke Length, highlights lifted by Highlight Area × Intensity.',
  run: (src, p) => {
    const len = num(p, 'length') * 3;
    const smear = len > 0 ? keepAlpha(src, lineBlur(src, 45, len)) : src;
    const H = num(p, 'highlight');
    const I = num(p, 'intensity');
    return eachPixel(smear, (px, i) => {
      const a = src.data[i * 4 + 3]!;
      const o = [src.data[i * 4]! / a, src.data[i * 4 + 1]! / a, src.data[i * 4 + 2]! / a];
      const l = 0.3 * o[0]! + 0.59 * o[1]! + 0.11 * o[2]!;
      const lift = highlight(l, H, I);
      for (let c = 0; c < 3; c++) px[c] = o[c]! + (Math.min(px[c]!, o[c]!) - o[c]!) * (1 - l) + lift;
    });
  },
};

export const sponge: GalleryEffect = {
  id: 'gallery.sponge',
  label: 'Sponge',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Brush Size', type: 'number', min: 0, max: 10, default: 2 },
    { key: 'definition', label: 'Definition', type: 'number', min: 0, max: 25, default: 12 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, default: 5 },
  ],
  pad: (p) => gPad(num(p, 'size') * 0.5 + 0.5),
  model: '[fit] a soft blur dabbed with a sponge texture: procedural pores (feature size from Brush Size, edge softness from Smoothness) darkened by Definition.',
  run: (src, p, ctx) => {
    const b = keepAlpha(src, gaussianBlur(src, num(p, 'size') * 0.5 + 0.5));
    const size = 3 + num(p, 'size');
    const soft = num(p, 'smoothness') / 60;
    const D = num(p, 'definition') / 25;
    return eachPixel(b, (px, _i, x, y) => {
      const t = fbm(x + ctx.originX, y + ctx.originY, size, 83);
      const pore = 1 - smoothstep(0.45 - soft, 0.45 + soft, t);
      for (let c = 0; c < 3; c++) px[c] = px[c]! * (1 - pore * D * 0.55);
    });
  },
};

export const underpainting: GalleryEffect = {
  id: 'gallery.underpainting',
  label: 'Underpainting',
  category: 'Artistic',
  params: [
    { key: 'size', label: 'Brush Size', type: 'number', min: 0, max: 40, default: 6 },
    { key: 'coverage', label: 'Texture Coverage', type: 'number', min: 0, max: 40, default: 16 },
    ...textureParams(4),
  ],
  pad: (p) => gPad(num(p, 'size') * 0.3),
  model: '[fit] a blurred underlayer (Brush Size) with a third of the original over it, then texturized with relief scaled by Texture Coverage.',
  run: (src, p, ctx) => {
    const b = keepAlpha(src, gaussianBlur(src, num(p, 'size') * 0.3));
    const mixed = eachPixel(b, (px, i) => {
      const a = src.data[i * 4 + 3]!;
      for (let c = 0; c < 3; c++) px[c] = 0.5 + (px[c]! * 0.7 + (src.data[i * 4 + c]! / a) * 0.3 - 0.5) * 1.1;
    });
    const relief = num(p, 'relief') * (0.5 + num(p, 'coverage') / 40);
    return texturize(mixed, ctx, str(p, 'texture'), num(p, 'scaling'), relief, lightAngle(str(p, 'light')), bool(p, 'invert'));
  },
};

export const watercolor: GalleryEffect = {
  id: 'gallery.watercolor',
  label: 'Watercolor',
  category: 'Artistic',
  params: [
    { key: 'detail', label: 'Brush Detail', type: 'number', min: 1, max: 14, default: 9 },
    { key: 'shadow', label: 'Shadow Intensity', type: 'number', min: 0, max: 10, default: 1 },
    { key: 'texture', label: 'Texture', type: 'number', min: 1, max: 3, default: 1 },
  ],
  pad: (p) => Math.max(1, Math.round((15 - num(p, 'detail')) / 3)) + 2,
  model: '[fit] median of radius (15 − Detail)/3, pigment pooling as darkened edges, shadows deepened by Shadow Intensity, saturation raised, paper grain from Texture.',
  run: (src, p, ctx) => {
    const r = Math.max(1, Math.round((15 - num(p, 'detail')) / 3));
    const m = keepAlpha(src, fromStraight8(src, medianChannels(src, r)));
    const { mag } = sobel(luma(m), src.width, src.height);
    const S = num(p, 'shadow') / 10;
    const T = num(p, 'texture');
    return eachPixel(m, (px, i, x, y) => {
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      const pool = 1 - clamp01(mag[i]! * 2) * 0.45;
      const sh = 1 - S * 0.6 * (1 - l) ** 2;
      const n = noiseAt(x + ctx.originX, y + ctx.originY, 89) * 0.02 * T;
      for (let c = 0; c < 3; c++) px[c] = (l + (px[c]! - l) * 1.25) * pool * sh + n;
    });
  },
};

export const ARTISTIC: GalleryEffect[] = [
  coloredPencil,
  cutout,
  dryBrush,
  filmGrain,
  fresco,
  neonGlow,
  paintDaubs,
  paletteKnife,
  plasticWrap,
  posterEdges,
  roughPastels,
  smudgeStick,
  sponge,
  underpainting,
  watercolor,
];
