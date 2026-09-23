/**
 * The Filter Gallery's shared toolkit — spec 05 §B.10: "no exact public algorithms → built
 * from a shared toolkit (Kuwahara variants, posterize + edge darkening, directional smears,
 * halftone screens, emboss/bump lighting, procedural paper textures) and tuned by eye".
 *
 * Most of it works on planes: one float per pixel, 0…1. Everything that invents structure
 * (noise, textures, hatching) is keyed to document coordinates so a preview crop shows the
 * same pixels as the full run.
 */
import { clamp01, gaussianKernel, hash2, makeRaster, straight, type Raster } from '../core.js';
import { fbm } from '../render.js';
import type { FilterContext, ParamSpec } from '../types.js';

export type Plane = Float32Array;

/** Straight-colour luminance of every pixel (0 where transparent). */
export function luma(src: Raster): Plane {
  const n = src.width * src.height;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = src.data[i * 4 + 3]!;
    if (a > 0) v[i] = (0.3 * src.data[i * 4]! + 0.59 * src.data[i * 4 + 1]! + 0.11 * src.data[i * 4 + 2]!) / a;
  }
  return v;
}

/** Separable Gaussian on a plane, edges replicated. Exact for any σ (the kernel is 6σ wide). */
export function blurPlane(v: Plane, w: number, h: number, sigma: number): Plane {
  if (sigma < 0.2) return v.slice();
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += v[row + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!;
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!;
      out[y * w + x] = s;
    }
  }
  return out;
}

/** The pad a blurPlane of σ needs. */
export const blurPad = (sigma: number) => (sigma < 0.2 ? 0 : Math.max(1, Math.ceil(sigma * 3)));

/** Sobel gradient of a plane: x and y derivatives and their magnitude (0…~4 for 0…1 input). */
export function sobel(v: Plane, w: number, h: number): { gx: Plane; gy: Plane; mag: Plane } {
  const gx = new Float32Array(v.length);
  const gy = new Float32Array(v.length);
  const mag = new Float32Array(v.length);
  const at = (x: number, y: number) => v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, y - 1);
      const b = at(x, y - 1);
      const c = at(x + 1, y - 1);
      const d = at(x - 1, y);
      const f = at(x + 1, y);
      const g = at(x - 1, y + 1);
      const hh = at(x, y + 1);
      const k = at(x + 1, y + 1);
      const i = y * w + x;
      gx[i] = (c + 2 * f + k - a - 2 * d - g) / 4;
      gy[i] = (g + 2 * hh + k - a - 2 * b - c) / 4;
      mag[i] = Math.hypot(gx[i]!, gy[i]!);
    }
  }
  return { gx, gy, mag };
}

/** Light directions, as Photoshop's Light menus list them; angles in degrees, 0 = from the right. */
export const LIGHTS = [
  { value: 'bottom', label: 'Bottom', angle: -90 },
  { value: 'bottomLeft', label: 'Bottom Left', angle: -135 },
  { value: 'left', label: 'Left', angle: 180 },
  { value: 'topLeft', label: 'Top Left', angle: 135 },
  { value: 'top', label: 'Top', angle: 90 },
  { value: 'topRight', label: 'Top Right', angle: 45 },
  { value: 'right', label: 'Right', angle: 0 },
  { value: 'bottomRight', label: 'Bottom Right', angle: -45 },
];
export const lightAngle = (v: string) => LIGHTS.find((l) => l.value === v)?.angle ?? 135;
export const lightParam = (def = 'topLeft'): ParamSpec => ({ key: 'light', label: 'Light', type: 'select', default: def, options: LIGHTS.map(({ value, label }) => ({ value, label })) });

/**
 * Lambert shading of a height field lit from `angleDeg` at 45° elevation: 0.5 where flat,
 * brighter on slopes facing the light. `gx`, `gy` are the height's derivatives.
 */
export function shadeAt(gx: number, gy: number, angleDeg: number, strength: number): number {
  const a = (angleDeg * Math.PI) / 180;
  const lx = Math.cos(a) * Math.SQRT1_2;
  const ly = -Math.sin(a) * Math.SQRT1_2;
  const lz = Math.SQRT1_2;
  const nx = -gx * strength;
  const ny = -gy * strength;
  const d = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
  return clamp01((d / lz) * 0.5);
}

export function shade(height: Plane, w: number, h: number, angleDeg: number, strength: number): Plane {
  const { gx, gy } = sobel(height, w, h);
  const out = new Float32Array(height.length);
  for (let i = 0; i < out.length; i++) out[i] = shadeAt(gx[i]!, gy[i]!, angleDeg, strength);
  return out;
}

/** Colour from a plane between the foreground (v = 0) and background (v = 1), keeping alpha — Sketch's rule. */
export function duotone(src: Raster, v: Plane, ctx: FilterContext): Raster {
  const out = makeRaster(src.width, src.height);
  const [f0, f1, f2] = ctx.foreground;
  const [b0, b1, b2] = ctx.background;
  for (let i = 0; i < v.length; i++) {
    const a = src.data[i * 4 + 3]!;
    const t = clamp01(v[i]!);
    out.data[i * 4] = (f0 + (b0 - f0) * t) * a;
    out.data[i * 4 + 1] = (f1 + (b1 - f1) * t) * a;
    out.data[i * 4 + 2] = (f2 + (b2 - f2) * t) * a;
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/** Grey from a plane, keeping alpha. */
export function grey(src: Raster, v: Plane): Raster {
  const out = makeRaster(src.width, src.height);
  for (let i = 0; i < v.length; i++) {
    const a = src.data[i * 4 + 3]!;
    const t = clamp01(v[i]!) * a;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = t;
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/** Map straight colour with the pixel index; transparent pixels are left alone. */
export function eachPixel(src: Raster, fn: (rgb: number[], i: number, x: number, y: number) => void): Raster {
  const out = makeRaster(src.width, src.height);
  out.data.set(src.data);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = y * src.width + x;
      const a = src.data[i * 4 + 3]!;
      if (a <= 0) continue;
      straight(src, i * 4, px);
      fn(px, i, x, y);
      out.data[i * 4] = clamp01(px[0]!) * a;
      out.data[i * 4 + 1] = clamp01(px[1]!) * a;
      out.data[i * 4 + 2] = clamp01(px[2]!) * a;
    }
  }
  return out;
}

/** Straight-colour posterize to `levels` steps per channel. */
export const posterize = (v: number, levels: number) => Math.round(clamp01(v) * (levels - 1)) / (levels - 1);

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Signed white noise −1…1 at a document pixel. */
export const noiseAt = (gx: number, gy: number, seed: number) => hash2(gx, gy, seed) * 2 - 1;

/**
 * Hatching: streaks of noise smeared along `angleDeg` over `length` px, 0…1 with mean ½.
 * Computed directly from document coordinates — reads no image pixels, so it needs no pad.
 */
export function hatch(gx: number, gy: number, angleDeg: number, length: number, seed: number): number {
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = -Math.sin(a);
  // Coordinates along and across the stroke: strokes are cells `length` long and a pixel wide.
  const along = gx * ux + gy * uy;
  const across = -gx * uy + gy * ux;
  const row = Math.floor(across);
  const cell = Math.floor(along / Math.max(1, length) + hash2(row, 0, seed));
  return hash2(row, cell, seed + 1);
}

// ---- procedural textures (Texturizer, Rough Pastels, Underpainting, Conté Crayon, Glass) ----

export const TEXTURES = [
  { value: 'brick', label: 'Brick' },
  { value: 'burlap', label: 'Burlap' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'sandstone', label: 'Sandstone' },
];

/** Height 0…1 of a texture at a document point, `scale` 0.5…2. */
export function textureAt(kind: string, gx: number, gy: number, scale: number): number {
  const x = gx / scale;
  const y = gy / scale;
  switch (kind) {
    case 'brick': {
      const bh = 16;
      const bw = 36;
      const row = Math.floor(y / bh);
      const xo = x + (row & 1 ? bw / 2 : 0);
      const fx = xo - Math.floor(xo / bw) * bw;
      const fy = y - row * bh;
      const mortar = Math.min(fx, bw - fx, fy, bh - fy);
      return smoothstep(0, 2.5, mortar) * (0.75 + 0.25 * fbm(gx, gy, 4 * scale, 17));
    }
    case 'burlap': {
      const p = 7;
      const wx = 0.5 + 0.5 * Math.sin((2 * Math.PI * x) / p);
      const wy = 0.5 + 0.5 * Math.sin((2 * Math.PI * y) / p);
      const over = Math.floor(x / p) + Math.floor(y / p);
      return 0.35 + 0.5 * (over & 1 ? wx : wy) * (0.7 + 0.3 * hash2(Math.floor(x / p), Math.floor(y / p), 23)) + 0.15 * fbm(gx, gy, 2 * scale, 29);
    }
    case 'canvas': {
      const p = 3.5;
      const wx = 0.5 + 0.5 * Math.sin((2 * Math.PI * x) / p);
      const wy = 0.5 + 0.5 * Math.sin((2 * Math.PI * y) / p);
      const over = Math.floor(x / p) + Math.floor(y / p);
      return 0.4 + 0.45 * (over & 1 ? wx : wy) + 0.15 * fbm(gx, gy, 2 * scale, 31);
    }
    case 'blocks': {
      const p = 12;
      const fx = x - Math.floor(x / p) * p;
      const fy = y - Math.floor(y / p) * p;
      return smoothstep(0, 3, Math.min(fx, p - fx, fy, p - fy));
    }
    case 'frosted':
      return fbm(gx, gy, 2 * scale, 37);
    case 'tinyLens': {
      const p = 10;
      const fx = x / p - Math.floor(x / p) - 0.5;
      const fy = y / p - Math.floor(y / p) - 0.5;
      return Math.sqrt(Math.max(0, 0.25 - fx * fx - fy * fy)) * 2;
    }
    default:
      // Sandstone.
      return fbm(gx, gy, 8 * scale, 41) * 0.7 + hash2(Math.floor(gx), Math.floor(gy), 43) * 0.3;
  }
}

/** Texture shading at a document point: 0.5 flat, lit from `angleDeg`. */
export function textureShade(kind: string, gx: number, gy: number, scale: number, angleDeg: number, relief: number, invert: boolean): number {
  const s = invert ? -1 : 1;
  const dx = (textureAt(kind, gx + 1, gy, scale) - textureAt(kind, gx - 1, gy, scale)) * 0.5 * s;
  const dy = (textureAt(kind, gx, gy + 1, scale) - textureAt(kind, gx, gy - 1, scale)) * 0.5 * s;
  return shadeAt(dx, dy, angleDeg, relief);
}

/**
 * Texturizer: light the image as if printed on the texture. `relief` 0…50 is Photoshop's
 * slider; shading multiplies around 1 so flat texture leaves colour alone.
 */
export function texturize(src: Raster, ctx: FilterContext, kind: string, scalePct: number, relief: number, lightDeg: number, invert: boolean): Raster {
  if (relief <= 0) return src;
  const scale = scalePct / 100;
  const k = relief / 5;
  return eachPixel(src, (px, _i, x, y) => {
    const s = textureShade(kind, x + ctx.originX + 0.5, y + ctx.originY + 0.5, scale, lightDeg, k, invert);
    const m = 1 + (s - 0.5) * 1.4;
    px[0] = px[0]! * m;
    px[1] = px[1]! * m;
    px[2] = px[2]! * m;
  });
}

/** Common texture parameters, named as in Photoshop. */
export const textureParams = (relief: number, def = 'canvas'): ParamSpec[] => [
  { key: 'texture', label: 'Texture', type: 'select', default: def, options: TEXTURES },
  { key: 'scaling', label: 'Scaling', type: 'number', min: 50, max: 200, default: 100, unit: '%' },
  { key: 'relief', label: 'Relief', type: 'number', min: 0, max: 50, default: relief },
  lightParam('top'),
  { key: 'invert', label: 'Invert', type: 'bool', default: false },
];

/** A plane from a raster channel-wise operation: copies straight colour into three planes. */
export function channels(src: Raster): [Plane, Plane, Plane] {
  const n = src.width * src.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = src.data[i * 4 + 3]!;
    if (a <= 0) continue;
    r[i] = src.data[i * 4]! / a;
    g[i] = src.data[i * 4 + 1]! / a;
    b[i] = src.data[i * 4 + 2]! / a;
  }
  return [r, g, b];
}

/** Rebuild a raster from three straight planes and the source alpha. */
export function fromChannels(src: Raster, r: Plane, g: Plane, b: Plane): Raster {
  const out = makeRaster(src.width, src.height);
  for (let i = 0; i < r.length; i++) {
    const a = src.data[i * 4 + 3]!;
    out.data[i * 4] = clamp01(r[i]!) * a;
    out.data[i * 4 + 1] = clamp01(g[i]!) * a;
    out.data[i * 4 + 2] = clamp01(b[i]!) * a;
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/**
 * Keep the colour of `colour` but swap in alpha from `src` — for effects built on a blur whose
 * alpha we do not want (Photoshop's gallery works on the flattened 8-bit layer; transparency
 * rides along unchanged).
 */
export function keepAlpha(src: Raster, colour: Raster): Raster {
  const out = makeRaster(src.width, src.height);
  for (let i = 0; i < src.width * src.height; i++) {
    const a = src.data[i * 4 + 3]!;
    const ca = colour.data[i * 4 + 3]!;
    const k = ca > 0 ? a / ca : 0;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.min(a, colour.data[i * 4 + c]! * k);
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/**
 * The two nearest jittered-grid seeds to a document point (cells of `size` px): the nearest
 * seed's position and the distances to it and to the second nearest. F2 − F1 is the distance
 * to the cell border, which is what cracks, leading and grout are drawn from.
 */
export function voronoi(x: number, y: number, size: number, seed: number): { sx: number; sy: number; f1: number; f2: number; id: number } {
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  let f1 = Infinity;
  let f2 = Infinity;
  let sx = 0;
  let sy = 0;
  let id = 0;
  for (let j = cy - 2; j <= cy + 2; j++) {
    for (let i = cx - 2; i <= cx + 2; i++) {
      const px = (i + 0.15 + 0.7 * hash2(i, j, seed)) * size;
      const py = (j + 0.15 + 0.7 * hash2(i, j, seed + 1)) * size;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        sx = px;
        sy = py;
        id = hash2(i, j, seed + 2);
      } else if (d < f2) f2 = d;
    }
  }
  return { sx, sy, f1, f2, id };
}
