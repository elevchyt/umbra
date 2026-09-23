/** Filter ▸ Pixelate — spec 05 §B.5. Every grid is anchored to the document, not the crop. */
import { clamp01, cloneRaster, fetch, hash2, makeRaster, straight, type Raster } from './core.js';
import { kuwahara } from './stylize.js';
import { num, str, type FilterDef } from './types.js';

export const mosaic: FilterDef = {
  id: 'pixelate.mosaic',
  label: 'Mosaic',
  category: 'Pixelate',
  params: [{ key: 'cell', label: 'Cell Size', type: 'number', min: 2, max: 200, default: 8, unit: 'square' }],
  pad: (p) => Math.ceil(num(p, 'cell')) + 1,
  model: 'Documented: each cell of a document-anchored grid becomes its average (premultiplied).',
  run: (src, p, ctx) => {
    const size = Math.round(num(p, 'cell'));
    const out = makeRaster(src.width, src.height);
    const gx0 = Math.floor(ctx.originX / size);
    const gy0 = Math.floor(ctx.originY / size);
    const gx1 = Math.ceil((ctx.originX + src.width) / size);
    const gy1 = Math.ceil((ctx.originY + src.height) / size);
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        const x0 = Math.max(0, gx * size - ctx.originX);
        const y0 = Math.max(0, gy * size - ctx.originY);
        const x1 = Math.min(src.width, (gx + 1) * size - ctx.originX);
        const y1 = Math.min(src.height, (gy + 1) * size - ctx.originY);
        const s = [0, 0, 0, 0];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 4; c++) s[c]! += src.data[(y * src.width + x) * 4 + c]!;
        const n = (x1 - x0) * (y1 - y0);
        if (!n) continue;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 4; c++) out.data[(y * src.width + x) * 4 + c] = s[c]! / n;
      }
    }
    return out;
  },
};

/** Nearest jittered-grid seed to a document point: [seedX, seedY] in document pixels. */
export function nearestSeed(x: number, y: number, size: number, seed: number): [number, number] {
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      const sx = (i + hash2(i, j, seed)) * size;
      const sy = (j + hash2(i, j, seed + 1)) * size;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < best) {
        best = d;
        bx = sx;
        by = sy;
      }
    }
  }
  return [bx, by];
}

export const crystallize: FilterDef = {
  id: 'pixelate.crystallize',
  label: 'Crystallize',
  category: 'Pixelate',
  params: [
    { key: 'cell', label: 'Cell Size', type: 'number', min: 3, max: 300, default: 10 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: (p) => Math.ceil(num(p, 'cell') * 2) + 1,
  model: 'Spec 05: a Voronoi diagram of a jittered grid of seeds; each cell takes the colour under its seed.',
  run: (src, p, ctx) => {
    const size = num(p, 'cell');
    const seed = num(p, 'seed');
    const out = makeRaster(src.width, src.height);
    const px = new Float32Array(4);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const [sx, sy] = nearestSeed(x + ctx.originX + 0.5, y + ctx.originY + 0.5, size, seed);
        fetch(src, Math.floor(sx) - ctx.originX, Math.floor(sy) - ctx.originY, px);
        out.data.set(px, (y * src.width + x) * 4);
      }
    }
    return out;
  },
};

export const pointillize: FilterDef = {
  id: 'pixelate.pointillize',
  label: 'Pointillize',
  category: 'Pixelate',
  params: [
    { key: 'cell', label: 'Cell Size', type: 'number', min: 3, max: 300, default: 5 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: (p) => Math.ceil(num(p, 'cell') * 2) + 1,
  model: '[fit] round dots at jittered seeds, each the colour under it with a slight random shift, over the background colour.',
  run: (src, p, ctx) => {
    const size = num(p, 'cell');
    const seed = num(p, 'seed');
    const out = makeRaster(src.width, src.height);
    const bg = ctx.background;
    const px = new Float32Array(4);
    const rad2 = (size * 0.62) ** 2;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const gx = x + ctx.originX + 0.5;
        const gy = y + ctx.originY + 0.5;
        const [sx, sy] = nearestSeed(gx, gy, size, seed);
        const o = (y * src.width + x) * 4;
        if ((sx - gx) ** 2 + (sy - gy) ** 2 > rad2) {
          out.data.set([bg[0], bg[1], bg[2], 1], o);
          continue;
        }
        fetch(src, Math.floor(sx) - ctx.originX, Math.floor(sy) - ctx.originY, px);
        const j = (hash2(Math.floor(sx), Math.floor(sy), seed + 2) - 0.5) * 0.12;
        const a = px[3]!;
        out.data[o] = clamp01(px[0]! + j * a);
        out.data[o + 1] = clamp01(px[1]! + j * a);
        out.data[o + 2] = clamp01(px[2]! + j * a);
        out.data[o + 3] = a;
      }
    }
    return out;
  },
};

export const colorHalftone: FilterDef = {
  id: 'pixelate.colorhalftone',
  label: 'Color Halftone',
  category: 'Pixelate',
  params: [
    { key: 'radius', label: 'Max. Radius', type: 'number', min: 4, max: 127, default: 8, unit: 'px' },
    { key: 'angle1', label: 'Channel 1', type: 'number', min: -360, max: 360, default: 108, unit: '°' },
    { key: 'angle2', label: 'Channel 2', type: 'number', min: -360, max: 360, default: 162, unit: '°' },
    { key: 'angle3', label: 'Channel 3', type: 'number', min: -360, max: 360, default: 90, unit: '°' },
  ],
  pad: (p) => Math.ceil(num(p, 'radius') * 2) + 2,
  model: 'Per channel: a screen at its angle, cells twice Max. Radius across; each dot\'s area is proportional to the channel\'s value at the cell centre.',
  run: (src, p, ctx) => {
    const R = num(p, 'radius');
    const cell = 2 * R;
    const angles = [num(p, 'angle1'), num(p, 'angle2'), num(p, 'angle3')].map((a) => (a * Math.PI) / 180);
    const out = cloneRaster(src);
    const px = new Float32Array(4);
    for (let c = 0; c < 3; c++) {
      const cs = Math.cos(angles[c]!);
      const sn = Math.sin(angles[c]!);
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          const o = (y * src.width + x) * 4;
          const a = src.data[o + 3]!;
          if (a <= 0) continue;
          const gx = x + ctx.originX + 0.5;
          const gy = y + ctx.originY + 0.5;
          // Into screen space, find the cell centre, back to document space to sample.
          const u = gx * cs + gy * sn;
          const v = -gx * sn + gy * cs;
          const cu = (Math.floor(u / cell) + 0.5) * cell;
          const cv = (Math.floor(v / cell) + 0.5) * cell;
          const sx = cu * cs - cv * sn;
          const sy = cu * sn + cv * cs;
          fetch(src, Math.floor(sx) - ctx.originX, Math.floor(sy) - ctx.originY, px);
          const val = px[3]! > 0 ? px[c]! / px[3]! : 0;
          // Dot radius so the dot covers `val` of the cell: π r² = val · cell².
          const r = Math.sqrt((val * cell * cell) / Math.PI);
          const inside = (u - cu) ** 2 + (v - cv) ** 2 <= r * r;
          out.data[o + c] = inside ? a : 0;
        }
      }
    }
    return out;
  },
};

export const facet: FilterDef = {
  id: 'pixelate.facet',
  label: 'Facet',
  category: 'Pixelate',
  params: [],
  pad: () => 4,
  model: '[fit] a radius-2 Kuwahara: similar colours clump into flat blocks, which is the filter\'s documented effect.',
  run: (src) => kuwahara(src, 2),
};

export const fragment: FilterDef = {
  id: 'pixelate.fragment',
  label: 'Fragment',
  category: 'Pixelate',
  params: [],
  pad: () => 5,
  model: 'Four copies of the image, offset by four pixels, averaged — Photoshop\'s own description.',
  run: (src) => {
    const out = makeRaster(src.width, src.height);
    const px = new Float32Array(4);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        for (const [dx, dy] of [[-4, 0], [4, 0], [0, -4], [0, 4]] as const) {
          fetch(src, x + dx, y + dy, px);
          for (let c = 0; c < 4; c++) out.data[o + c]! += px[c]! / 4;
        }
      }
    }
    return out;
  },
};

const MEZZO = [
  { value: 'fineDots', label: 'Fine Dots' },
  { value: 'mediumDots', label: 'Medium Dots' },
  { value: 'grainyDots', label: 'Grainy Dots' },
  { value: 'coarseDots', label: 'Coarse Dots' },
  { value: 'shortLines', label: 'Short Lines' },
  { value: 'mediumLines', label: 'Medium Lines' },
  { value: 'longLines', label: 'Long Lines' },
  { value: 'shortStrokes', label: 'Short Strokes' },
  { value: 'mediumStrokes', label: 'Medium Strokes' },
  { value: 'longStrokes', label: 'Long Strokes' },
];

export const mezzotint: FilterDef = {
  id: 'pixelate.mezzotint',
  label: 'Mezzotint',
  category: 'Pixelate',
  params: [
    { key: 'type', label: 'Type', type: 'select', default: 'fineDots', options: MEZZO },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 0,
  model: '[fit] each channel is thresholded against random noise (so it is fully saturated); the noise is per pixel or per block for dots, per horizontal run for lines, per diagonal run for strokes.',
  run: (src, p, ctx) => {
    const type = str(p, 'type');
    const seed = num(p, 'seed');
    const block = { fineDots: 1, mediumDots: 2, grainyDots: 1, coarseDots: 3 }[type as 'fineDots'] ?? 1;
    const run = { shortLines: 4, mediumLines: 10, longLines: 24, shortStrokes: 4, mediumStrokes: 10, longStrokes: 24 }[type as 'shortLines'] ?? 0;
    const strokes = type.endsWith('Strokes');
    const px = new Float32Array(4);
    const out = cloneRaster(src);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const a = src.data[o + 3]!;
        if (a <= 0) continue;
        straight(src, o, px);
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        for (let c = 0; c < 3; c++) {
          let t: number;
          if (run) {
            const along = strokes ? gx + gy : gx;
            const key = Math.floor(along / run);
            t = hash2(key, strokes ? gx - gy : gy, seed + c * 3);
          } else if (type === 'grainyDots') {
            t = 0.5 * hash2(gx, gy, seed + c) + 0.5 * hash2(gx >> 1, gy >> 1, seed + c + 9);
          } else t = hash2(Math.floor(gx / block), Math.floor(gy / block), seed + c);
          out.data[o + c] = px[c]! > t ? a : 0;
        }
      }
    }
    return out;
  },
};

export const PIXELATE_FILTERS: FilterDef[] = [colorHalftone, crystallize, facet, fragment, mezzotint, mosaic, pointillize];

export type { Raster };
