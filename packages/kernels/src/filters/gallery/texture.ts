/** Filter Gallery ▸ Texture (6) — spec 05 §B.10. [fit] throughout: see artistic.ts. */
import { clamp01, hash2 } from '../core.js';
import { bool, num, str, type GalleryEffect } from '../types.js';
import { eachPixel, lightAngle, noiseAt, shadeAt, smoothstep, textureParams, texturize, voronoi } from './kit.js';

export const craquelure: GalleryEffect = {
  id: 'gallery.craquelure',
  label: 'Craquelure',
  category: 'Texture',
  params: [
    { key: 'spacing', label: 'Crack Spacing', type: 'number', min: 2, max: 100, default: 15 },
    { key: 'depth', label: 'Crack Depth', type: 'number', min: 0, max: 10, default: 6 },
    { key: 'brightness', label: 'Crack Brightness', type: 'number', min: 0, max: 10, default: 9 },
  ],
  pad: () => 0,
  model: '[fit] a network of cracks along Voronoi cell borders (cells of Crack Spacing), each plate slightly domed and lit; Depth darkens the cracks, Brightness the plates.',
  run: (src, p, ctx) => {
    const S = num(p, 'spacing');
    const D = num(p, 'depth') / 10;
    const B = 0.75 + num(p, 'brightness') / 36;
    const height = (x: number, y: number) => {
      const v = voronoi(x, y, S, 191);
      return smoothstep(0, 2 + S * 0.08, v.f2 - v.f1) * (1 - (v.f1 / S) * 0.3);
    };
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX + 0.5;
      const gy = y + ctx.originY + 0.5;
      const h0 = height(gx, gy);
      const s = shadeAt((height(gx + 1, gy) - height(gx - 1, gy)) / 2, (height(gx, gy + 1) - height(gx, gy - 1)) / 2, 135, 4);
      const m = B * (1 - (1 - h0) * D * 0.8) * (1 + (s - 0.5) * D);
      for (let c = 0; c < 3; c++) px[c] = px[c]! * m;
    });
  },
};

const GRAIN_TYPES = [
  { value: 'regular', label: 'Regular' },
  { value: 'soft', label: 'Soft' },
  { value: 'sprinkles', label: 'Sprinkles' },
  { value: 'clumped', label: 'Clumped' },
  { value: 'contrasty', label: 'Contrasty' },
  { value: 'enlarged', label: 'Enlarged' },
  { value: 'stippled', label: 'Stippled' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'speckle', label: 'Speckle' },
];

export const grain: GalleryEffect = {
  id: 'gallery.grain',
  label: 'Grain',
  category: 'Texture',
  params: [
    { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 100, default: 40 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'type', label: 'Grain Type', type: 'select', default: 'regular', options: GRAIN_TYPES },
  ],
  pad: () => 0,
  model: '[fit] ten grain patterns from position-keyed noise: per-channel (Regular), low-amplitude (Soft), background-colour dots (Sprinkles), clumps, hard (Contrasty), coarse (Enlarged), foreground/background dots (Stippled), streaks (Horizontal, Vertical), sparse dark flecks (Speckle).',
  run: (src, p, ctx) => {
    const I = num(p, 'intensity') / 100;
    const C = 0.5 + num(p, 'contrast') / 100;
    const type = str(p, 'type');
    const fg = ctx.foreground;
    const bg = ctx.background;
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const l = 0.3 * px[0]! + 0.59 * px[1]! + 0.11 * px[2]!;
      switch (type) {
        case 'sprinkles':
          if (hash2(gx, gy, 197) < I * 0.3 * (1 - l * 0.5)) for (let c = 0; c < 3; c++) px[c] = bg[c]!;
          break;
        case 'stippled': {
          const dot = hash2(gx, gy, 199) < l ? bg : fg;
          for (let c = 0; c < 3; c++) px[c] = px[c]! + (dot[c]! - px[c]!) * I;
          break;
        }
        case 'speckle':
          if (hash2(gx, gy, 211) < I * 0.12) for (let c = 0; c < 3; c++) px[c] = px[c]! * 0.2;
          break;
        default: {
          let n: number[];
          if (type === 'regular') n = [noiseAt(gx, gy, 223), noiseAt(gx, gy, 227), noiseAt(gx, gy, 229)];
          else {
            let m: number;
            if (type === 'soft') m = noiseAt(gx, gy, 233) * 0.5;
            else if (type === 'clumped') m = hash2(gx, gy, 239) < 0.5 ? -0.8 : 0.3;
            else if (type === 'contrasty') m = noiseAt(gx, gy, 241) > 0 ? 1 : -1;
            else if (type === 'enlarged') m = noiseAt(Math.floor(gx / 3), Math.floor(gy / 3), 251);
            else if (type === 'horizontal') m = noiseAt(Math.floor(gx / 8), gy, 257);
            else m = noiseAt(gx, Math.floor(gy / 8), 263);
            n = [m, m, m];
          }
          for (let c = 0; c < 3; c++) px[c] = px[c]! + n[c]! * I * 0.4;
        }
      }
      for (let c = 0; c < 3; c++) px[c] = 0.5 + (clamp01(px[c]!) - 0.5) * C;
    });
  },
};

export const mosaicTiles: GalleryEffect = {
  id: 'gallery.mosaicTiles',
  label: 'Mosaic Tiles',
  category: 'Texture',
  params: [
    { key: 'size', label: 'Tile Size', type: 'number', min: 2, max: 100, default: 12 },
    { key: 'grout', label: 'Grout Width', type: 'number', min: 1, max: 15, default: 3 },
    { key: 'lighten', label: 'Lighten Grout', type: 'number', min: 0, max: 10, default: 9 },
  ],
  pad: () => 0,
  model: '[fit] small irregular tiles (rows of Tile Size with jittered joints) separated by grout of Grout Width, lightened by Lighten Grout, each tile slightly bevelled.',
  run: (src, p, ctx) => {
    const S = num(p, 'size');
    const G = num(p, 'grout') / 2;
    const L = num(p, 'lighten') / 10;
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX + 0.5;
      const gy = y + ctx.originY + 0.5;
      const row = Math.floor(gy / S);
      const shift = hash2(row, 0, 269) * S;
      const col = Math.floor((gx + shift) / S);
      const w = S * (0.85 + 0.3 * hash2(col, row, 271));
      const fx = gx + shift - col * S;
      const fy = gy - row * S;
      const edge = Math.min(fx, w - fx, fy, S - fy);
      const joint = smoothstep(G - 0.5, G + 0.5, edge);
      const bevel = 1 + (smoothstep(G, G + 3, edge) - 1) * 0.15 * (fx < fy ? 1 : -1);
      for (let c = 0; c < 3; c++) {
        const tile = px[c]! * bevel;
        const grout = px[c]! * (1 - L) + L * (0.55 + px[c]! * 0.4);
        px[c] = grout + (tile - grout) * joint;
      }
    });
  },
};

export const patchwork: GalleryEffect = {
  id: 'gallery.patchwork',
  label: 'Patchwork',
  category: 'Texture',
  params: [
    { key: 'size', label: 'Square Size', type: 'number', min: 0, max: 10, default: 4 },
    { key: 'relief', label: 'Relief', type: 'number', min: 0, max: 25, default: 8 },
  ],
  pad: (p) => Math.ceil((num(p, 'size') + 3) / 2) + 1,
  model: '[fit] squares of Square Size + 3 px filled with the colour at their centre, each raised to a random height and bevelled by Relief.',
  run: (src, p, ctx) => {
    const S = num(p, 'size') + 3;
    const R = num(p, 'relief') / 25;
    const w = src.width;
    const h = src.height;
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX;
      const gy = y + ctx.originY;
      const cx = Math.floor(gx / S);
      const cy = Math.floor(gy / S);
      const sx = Math.min(w - 1, Math.max(0, Math.floor((cx + 0.5) * S) - ctx.originX));
      const sy = Math.min(h - 1, Math.max(0, Math.floor((cy + 0.5) * S) - ctx.originY));
      const o = (sy * w + sx) * 4;
      const a = src.data[o + 3]!;
      const fx = gx + 0.5 - cx * S;
      const fy = gy + 0.5 - cy * S;
      const lit = fx < 1.2 || fy < 1.2 ? 1 : fx > S - 1.2 || fy > S - 1.2 ? -1 : 0;
      const m = (1 + lit * 0.35 * R) * (1 + (hash2(cx, cy, 277) - 0.5) * 0.4 * R);
      for (let c = 0; c < 3; c++) px[c] = (a > 0 ? src.data[o + c]! / a : px[c]!) * m;
    });
  },
};

export const stainedGlass: GalleryEffect = {
  id: 'gallery.stainedGlass',
  label: 'Stained Glass',
  category: 'Texture',
  params: [
    { key: 'cell', label: 'Cell Size', type: 'number', min: 2, max: 50, default: 10 },
    { key: 'border', label: 'Border Thickness', type: 'number', min: 1, max: 20, default: 4 },
    { key: 'light', label: 'Light Intensity', type: 'number', min: 0, max: 10, default: 3 },
  ],
  pad: (p) => Math.ceil(num(p, 'cell') * 2) + 1,
  model: '[fit] Voronoi cells of Cell Size filled with the colour at their seed, leaded in the foreground colour (Border Thickness), lit from the canvas centre (Light Intensity).',
  run: (src, p, ctx) => {
    const S = num(p, 'cell');
    const Bd = num(p, 'border') / 4;
    const Li = num(p, 'light') / 10;
    const w = src.width;
    const h = src.height;
    const fg = ctx.foreground;
    const cx = ctx.docWidth / 2;
    const cy = ctx.docHeight / 2;
    const reach = Math.hypot(cx, cy) || 1;
    return eachPixel(src, (px, _i, x, y) => {
      const gx = x + ctx.originX + 0.5;
      const gy = y + ctx.originY + 0.5;
      const v = voronoi(gx, gy, S, 281);
      const sx = Math.min(w - 1, Math.max(0, Math.floor(v.sx) - ctx.originX));
      const sy = Math.min(h - 1, Math.max(0, Math.floor(v.sy) - ctx.originY));
      const o = (sy * w + sx) * 4;
      const a = src.data[o + 3]!;
      const lead = 1 - smoothstep(Bd - 0.5, Bd + 0.5, (v.f2 - v.f1) / 2);
      const glow = Li * 0.5 * (1 - Math.min(1, Math.hypot(gx - cx, gy - cy) / reach));
      for (let c = 0; c < 3; c++) {
        const glass = (a > 0 ? src.data[o + c]! / a : px[c]!) + glow;
        px[c] = glass + (fg[c]! - glass) * lead;
      }
    });
  },
};

export const texturizer: GalleryEffect = {
  id: 'gallery.texturizer',
  label: 'Texturizer',
  category: 'Texture',
  params: textureParams(4),
  pad: () => 0,
  model: '[fit] the image lit as if printed on Brick, Burlap, Canvas or Sandstone (procedural, keyed to the canvas), Relief as the bump strength.',
  run: (src, p, ctx) => texturize(src, ctx, str(p, 'texture'), num(p, 'scaling'), num(p, 'relief'), lightAngle(str(p, 'light')), bool(p, 'invert')),
};

export const TEXTURE: GalleryEffect[] = [craquelure, grain, mosaicTiles, patchwork, stainedGlass, texturizer];
