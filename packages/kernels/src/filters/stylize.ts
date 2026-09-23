/** Filter ▸ Stylize — spec 05 §B.8. */
import { clamp01, cloneRaster, fetch, hash2, lum, makeRaster, mapStraight, sampleBilinear, straight, type Raster } from './core.js';
import { bool, num, str, type FilterDef } from './types.js';

const lumAt = (r: Raster, x: number, y: number) => {
  const xx = Math.min(r.width - 1, Math.max(0, x));
  const yy = Math.min(r.height - 1, Math.max(0, y));
  const i = (yy * r.width + xx) * 4;
  const a = r.data[i + 3]!;
  return a > 0 ? lum(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!) / a : 0;
};

export const diffuse: FilterDef = {
  id: 'stylize.diffuse',
  label: 'Diffuse',
  category: 'Stylize',
  params: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'normal',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'darken', label: 'Darken Only' },
        { value: 'lighten', label: 'Lighten Only' },
        { value: 'anisotropic', label: 'Anisotropic' },
      ],
    },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 2,
  model: '[fit] each pixel takes a random neighbour within one pixel (Darken/Lighten only if darker/lighter); Anisotropic takes the neighbour most like it, which softens without scattering.',
  run: (src, p, ctx) => {
    const mode = str(p, 'mode');
    const seed = num(p, 'seed');
    const out = cloneRaster(src);
    const px = new Float32Array(4);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const gx = x + ctx.originX;
        const gy = y + ctx.originY;
        let dx: number;
        let dy: number;
        if (mode === 'anisotropic') {
          const l0 = lumAt(src, x, y);
          let best = Infinity;
          dx = 0;
          dy = 0;
          for (let k = 0; k < 8; k++) {
            const ax = [1, 1, 0, -1, -1, -1, 0, 1][k]!;
            const ay = [0, 1, 1, 1, 0, -1, -1, -1][k]!;
            const d = Math.abs(lumAt(src, x + ax, y + ay) - l0) + hash2(gx, gy, seed + k) * 1e-3;
            if (d < best) {
              best = d;
              dx = ax;
              dy = ay;
            }
          }
        } else {
          dx = Math.floor(hash2(gx, gy, seed) * 3) - 1;
          dy = Math.floor(hash2(gx, gy, seed + 1) * 3) - 1;
        }
        fetch(src, x + dx, y + dy, px);
        if (mode === 'darken' || mode === 'lighten') {
          const a = px[3]! || 1;
          const l1 = lum(px[0]!, px[1]!, px[2]!) / a;
          const l0 = lumAt(src, x, y);
          if (mode === 'darken' ? l1 >= l0 : l1 <= l0) continue;
        }
        out.data.set(px, o);
      }
    }
    return out;
  },
};

export const emboss: FilterDef = {
  id: 'stylize.emboss',
  label: 'Emboss',
  category: 'Stylize',
  params: [
    { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, default: 135, unit: '°' },
    { key: 'height', label: 'Height', type: 'number', min: 1, max: 100, default: 3, unit: 'px' },
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, default: 100, unit: '%' },
  ],
  pad: (p) => Math.ceil(num(p, 'height')) + 2,
  model: 'Spec 05: 0.5 + a·(I(p − d) − I(p + d)) on luminance, d = Height along Angle; the result is grey.',
  run: (src, p) => {
    const a = (num(p, 'angle') * Math.PI) / 180;
    const h = num(p, 'height') / 2;
    const dx = Math.cos(a) * h;
    const dy = -Math.sin(a) * h;
    const amount = num(p, 'amount') / 100;
    const out = cloneRaster(src);
    const s1 = [0, 0, 0, 0];
    const s2 = [0, 0, 0, 0];
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const al = src.data[o + 3]!;
        if (al <= 0) continue;
        sampleBilinear(src, x + 0.5 - dx, y + 0.5 - dy, s1);
        sampleBilinear(src, x + 0.5 + dx, y + 0.5 + dy, s2);
        const l1 = s1[3]! > 0 ? lum(s1[0]!, s1[1]!, s1[2]!) / s1[3]! : 0;
        const l2 = s2[3]! > 0 ? lum(s2[0]!, s2[1]!, s2[2]!) / s2[3]! : 0;
        const v = clamp01(0.5 + amount * (l1 - l2));
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v * al;
      }
    }
    return out;
  },
};

export const findEdges: FilterDef = {
  id: 'stylize.findedges',
  label: 'Find Edges',
  category: 'Stylize',
  params: [],
  pad: () => 2,
  model: 'Spec 05: inverted Sobel magnitude per channel — edges dark on white, in their colours.',
  run: (src) =>
    mapStraightNeighbours(src, (get, out) => {
      for (let c = 0; c < 3; c++) {
        const gx = -get(-1, -1, c) - 2 * get(-1, 0, c) - get(-1, 1, c) + get(1, -1, c) + 2 * get(1, 0, c) + get(1, 1, c);
        const gy = -get(-1, -1, c) - 2 * get(0, -1, c) - get(1, -1, c) + get(-1, 1, c) + 2 * get(0, 1, c) + get(1, 1, c);
        out[c] = 1 - clamp01(Math.sqrt(gx * gx + gy * gy) / 2);
      }
    }),
};

/**
 * Point-plus-neighbourhood filters on straight colour: `get(dx, dy, channel)` reads a
 * neighbour (replicate edges), `out` receives the new straight colour; alpha is kept.
 */
export function mapStraightNeighbours(src: Raster, fn: (get: (dx: number, dy: number, c: number) => number, out: number[], x: number, y: number) => void): Raster {
  const w = src.width;
  const h = src.height;
  const st = new Float32Array(w * h * 3);
  const px = new Float32Array(4);
  for (let i = 0, j = 0; i < src.data.length; i += 4, j += 3) {
    straight(src, i, px);
    st[j] = px[0]!;
    st[j + 1] = px[1]!;
    st[j + 2] = px[2]!;
  }
  const out = cloneRaster(src);
  const res = [0, 0, 0];
  let cx = 0;
  let cy = 0;
  const get = (dx: number, dy: number, c: number) => {
    const xx = Math.min(w - 1, Math.max(0, cx + dx));
    const yy = Math.min(h - 1, Math.max(0, cy + dy));
    return st[(yy * w + xx) * 3 + c]!;
  };
  for (cy = 0; cy < h; cy++) {
    for (cx = 0; cx < w; cx++) {
      const o = (cy * w + cx) * 4;
      const a = src.data[o + 3]!;
      if (a <= 0) continue;
      fn(get, res, cx, cy);
      out.data[o] = clamp01(res[0]!) * a;
      out.data[o + 1] = clamp01(res[1]!) * a;
      out.data[o + 2] = clamp01(res[2]!) * a;
    }
  }
  return out;
}

export const solarize: FilterDef = {
  id: 'stylize.solarize',
  label: 'Solarize',
  category: 'Stylize',
  params: [],
  pad: () => 0,
  model: 'The photographic Sabattier effect as Photoshop does it: channels above 50% are inverted.',
  run: (src) =>
    mapStraight(src, (px) => {
      for (let c = 0; c < 3; c++) if (px[c]! > 0.5) px[c] = 1 - px[c]!;
    }),
};

export const traceContour: FilterDef = {
  id: 'stylize.tracecontour',
  label: 'Trace Contour',
  category: 'Stylize',
  params: [
    { key: 'level', label: 'Level', type: 'number', min: 0, max: 255, default: 128 },
    { key: 'edge', label: 'Edge', type: 'select', default: 'lower', options: [{ value: 'lower', label: 'Lower' }, { value: 'upper', label: 'Upper' }] },
  ],
  pad: () => 1,
  model: 'Per channel: a pixel on the Lower (below Level) or Upper side of a crossing becomes 0, everything else 1 — thin contour lines on white.',
  run: (src, p) => {
    const t = num(p, 'level') / 255;
    const lower = str(p, 'edge') === 'lower';
    return mapStraightNeighbours(src, (get, out) => {
      for (let c = 0; c < 3; c++) {
        const v = get(0, 0, c);
        const mine = lower ? v < t : v >= t;
        let crossing = false;
        if (mine) {
          for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
            if (lower ? get(dx, dy, c) >= t : get(dx, dy, c) < t) crossing = true;
          }
        }
        out[c] = crossing ? 0 : 1;
      }
    });
  },
};

export const wind: FilterDef = {
  id: 'stylize.wind',
  label: 'Wind',
  category: 'Stylize',
  params: [
    { key: 'method', label: 'Method', type: 'select', default: 'wind', options: [{ value: 'wind', label: 'Wind' }, { value: 'blast', label: 'Blast' }, { value: 'stagger', label: 'Stagger' }] },
    { key: 'direction', label: 'Direction', type: 'select', default: 'right', options: [{ value: 'right', label: 'From the Right' }, { value: 'left', label: 'From the Left' }] },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 'full',
  model: '[fit] bright pixels streak downwind: along each row a decaying maximum carries brightness, its length varying per row (Blast: longer; Stagger: rows shifted instead).',
  run: (src, p, ctx) => {
    const method = str(p, 'method');
    const fromRight = str(p, 'direction') === 'right';
    const seed = num(p, 'seed');
    const out = cloneRaster(src);
    const w = src.width;
    for (let y = 0; y < src.height; y++) {
      const gy = y + ctx.originY;
      if (method === 'stagger') {
        const shift = Math.floor(hash2(0, gy, seed) * 12) * (fromRight ? -1 : 1);
        for (let x = 0; x < w; x++) {
          const sx = Math.min(w - 1, Math.max(0, x - shift));
          out.data.set(src.data.subarray((y * w + sx) * 4, (y * w + sx) * 4 + 4), (y * w + x) * 4);
        }
        continue;
      }
      const decay = method === 'blast' ? 0.985 : 0.93 + hash2(1, gy, seed) * 0.05;
      const carry = [0, 0, 0];
      for (let k = 0; k < w; k++) {
        const x = fromRight ? w - 1 - k : k;
        const o = (y * w + x) * 4;
        const a = src.data[o + 3]!;
        for (let c = 0; c < 3; c++) {
          const v = a > 0 ? src.data[o + c]! / a : 0;
          carry[c] = Math.max(v, carry[c]! * decay);
          out.data[o + c] = Math.max(v, carry[c]!) * a;
        }
      }
    }
    return out;
  },
};

export const tiles: FilterDef = {
  id: 'stylize.tiles',
  label: 'Tiles',
  category: 'Stylize',
  params: [
    { key: 'number', label: 'Number Of Tiles', type: 'number', min: 1, max: 99, default: 10 },
    { key: 'offset', label: 'Maximum Offset', type: 'number', min: 1, max: 99, default: 10, unit: '%' },
    {
      key: 'fill',
      label: 'Fill Empty Area With',
      type: 'select',
      default: 'background',
      options: [
        { value: 'background', label: 'Background Color' },
        { value: 'foreground', label: 'Foreground Color' },
        { value: 'inverse', label: 'Inverse Image' },
        { value: 'unaltered', label: 'Unaltered Image' },
      ],
    },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 'full',
  model: 'Squares Number-across on the shorter side, each moved by up to Maximum Offset of its size; the gaps take the Fill choice.',
  run: (src, p, ctx) => {
    const n = num(p, 'number');
    const size = Math.max(2, Math.min(ctx.docWidth, ctx.docHeight) / n);
    const maxOff = (num(p, 'offset') / 100) * size;
    const fill = str(p, 'fill');
    const seed = num(p, 'seed');
    const out = makeRaster(src.width, src.height);
    // Gaps first.
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3]!;
      if (fill === 'unaltered') out.data.set(src.data.subarray(i, i + 4), i);
      else if (fill === 'inverse') {
        out.data[i] = a - src.data[i]!;
        out.data[i + 1] = a - src.data[i + 1]!;
        out.data[i + 2] = a - src.data[i + 2]!;
        out.data[i + 3] = a;
      } else {
        const c = fill === 'foreground' ? ctx.foreground : ctx.background;
        out.data.set([c[0], c[1], c[2], 1], i);
      }
    }
    // Then each tile, drawn at its offset.
    const cols = Math.ceil(ctx.docWidth / size);
    const rows = Math.ceil(ctx.docHeight / size);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const ox = Math.round((hash2(tx, ty, seed) * 2 - 1) * maxOff);
        const oy = Math.round((hash2(tx, ty, seed + 1) * 2 - 1) * maxOff);
        const x0 = Math.round(tx * size) - ctx.originX;
        const y0 = Math.round(ty * size) - ctx.originY;
        const x1 = Math.round((tx + 1) * size) - ctx.originX;
        const y1 = Math.round((ty + 1) * size) - ctx.originY;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (x < 0 || y < 0 || x >= src.width || y >= src.height) continue;
            const dx = x + ox;
            const dy = y + oy;
            if (dx < 0 || dy < 0 || dx >= src.width || dy >= src.height) continue;
            out.data.set(src.data.subarray((y * src.width + x) * 4, (y * src.width + x) * 4 + 4), (dy * src.width + dx) * 4);
          }
        }
      }
    }
    return out;
  },
};

/** Generalised Kuwahara: each pixel takes the mean of whichever quadrant around it varies least. */
export function kuwahara(src: Raster, radius: number): Raster {
  const w = src.width;
  const h = src.height;
  const r = Math.max(1, Math.round(radius));
  // Summed-area tables of straight colour and of its square, for O(1) quadrant statistics.
  const n = (w + 1) * (h + 1);
  const S = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const Q = new Float64Array(n);
  const px = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      straight(src, (y * w + x) * 4, px);
      const k = (y + 1) * (w + 1) + (x + 1);
      let q = 0;
      for (let c = 0; c < 3; c++) {
        S[c]![k] = px[c]! + S[c]![k - 1]! + S[c]![k - (w + 1)]! - S[c]![k - (w + 1) - 1]!;
        q += px[c]! * px[c]!;
      }
      Q[k] = q + Q[k - 1]! + Q[k - (w + 1)]! - Q[k - (w + 1) - 1]!;
    }
  }
  const box = (T: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    T[y1 * (w + 1) + x1]! - T[y0 * (w + 1) + x1]! - T[y1 * (w + 1) + x0]! + T[y0 * (w + 1) + x0]!;
  const out = cloneRaster(src);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = src.data[o + 3]!;
      if (a <= 0) continue;
      let best = Infinity;
      let mean = [0, 0, 0];
      for (const [qx, qy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const x0 = Math.max(0, qx < 0 ? x - r : x);
        const x1 = Math.min(w, qx < 0 ? x + 1 : x + r + 1);
        const y0 = Math.max(0, qy < 0 ? y - r : y);
        const y1 = Math.min(h, qy < 0 ? y + 1 : y + r + 1);
        const cnt = (x1 - x0) * (y1 - y0);
        const m = [0, 1, 2].map((c) => box(S[c]!, x0, y0, x1, y1) / cnt);
        const v = box(Q, x0, y0, x1, y1) / cnt - (m[0]! ** 2 + m[1]! ** 2 + m[2]! ** 2);
        if (v < best) {
          best = v;
          mean = m;
        }
      }
      out.data[o] = clamp01(mean[0]!) * a;
      out.data[o + 1] = clamp01(mean[1]!) * a;
      out.data[o + 2] = clamp01(mean[2]!) * a;
    }
  }
  return out;
}

export const oilPaint: FilterDef = {
  id: 'stylize.oilpaint',
  label: 'Oil Paint',
  category: 'Stylize',
  params: [
    { key: 'stylization', label: 'Stylization', type: 'number', min: 0.1, max: 10, default: 5, step: 0.1, precision: 1 },
    { key: 'cleanliness', label: 'Cleanliness', type: 'number', min: 0, max: 10, default: 5, step: 0.1, precision: 1 },
    { key: 'scale', label: 'Scale', type: 'number', min: 0.1, max: 10, default: 1, step: 0.1, precision: 1 },
    { key: 'bristle', label: 'Bristle Detail', type: 'number', min: 0, max: 10, default: 5, step: 0.1, precision: 1 },
    { key: 'lighting', label: 'Lighting', type: 'bool', default: true },
    { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, default: -60, unit: '°' },
    { key: 'shine', label: 'Shine', type: 'number', min: 0, max: 10, default: 1, step: 0.1, precision: 1 },
  ],
  pad: (p) => Math.ceil(num(p, 'stylization') * 1.5 + num(p, 'scale') * 2 + num(p, 'cleanliness')) + 4,
  model:
    '[fit] a Kuwahara filter (radius from Stylization and Scale) gives the flat strokes, repeated by Cleanliness; Bristle Detail adds back fine luminance texture; Lighting shades the result as a bump map at Angle, Shine setting its strength.',
  run: (src, p) => {
    const radius = num(p, 'stylization') * 1.5 + num(p, 'scale') * 2;
    let r = kuwahara(src, radius);
    const passes = Math.round(num(p, 'cleanliness') / 4);
    for (let k = 0; k < passes; k++) r = kuwahara(r, Math.max(1, radius / 2));
    const bristle = num(p, 'bristle') / 10;
    const shine = num(p, 'shine') / 10;
    const a = (num(p, 'angle') * Math.PI) / 180;
    const lx = Math.cos(a);
    const ly = -Math.sin(a);
    const out = cloneRaster(r);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const al = r.data[o + 3]!;
        if (al <= 0) continue;
        const detail = (lumAt(src, x, y) - lumAt(r, x, y)) * bristle * 0.5;
        let shade = 0;
        if (bool(p, 'lighting')) {
          const gx = lumAt(r, x + 1, y) - lumAt(r, x - 1, y);
          const gy = lumAt(r, x, y + 1) - lumAt(r, x, y - 1);
          shade = -(gx * lx + gy * ly) * shine * 2;
        }
        for (let c = 0; c < 3; c++) out.data[o + c] = clamp01(r.data[o + c]! / al + detail + shade) * al;
      }
    }
    return out;
  },
};

export const extrude: FilterDef = {
  id: 'stylize.extrude',
  label: 'Extrude',
  category: 'Stylize',
  params: [
    { key: 'type', label: 'Type', type: 'select', default: 'blocks', options: [{ value: 'blocks', label: 'Blocks' }, { value: 'pyramids', label: 'Pyramids' }] },
    { key: 'size', label: 'Size', type: 'number', min: 2, max: 255, default: 30, unit: 'px' },
    { key: 'depth', label: 'Depth', type: 'number', min: 1, max: 255, default: 30 },
    { key: 'depthMode', label: 'Depth From', type: 'select', default: 'random', options: [{ value: 'random', label: 'Random' }, { value: 'level', label: 'Level-based' }] },
    { key: 'solid', label: 'Solid Front Faces', type: 'bool', default: false },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 'full',
  model:
    '[fit] cells of Size are drawn nearest-last as pyramids (four shaded triangles) or blocks (the face pushed toward the viewer from the canvas centre by Depth, with shaded sides). "Mask Incomplete Blocks" is not modelled.',
  run: (src, p, ctx) => {
    const size = Math.max(2, Math.round(num(p, 'size')));
    const depthMax = num(p, 'depth') / 255;
    const pyr = str(p, 'type') === 'pyramids';
    const levelBased = str(p, 'depthMode') === 'level';
    const solid = bool(p, 'solid');
    const seed = num(p, 'seed');
    const out = cloneRaster(src);
    const cols = Math.ceil(ctx.docWidth / size);
    const rows = Math.ceil(ctx.docHeight / size);
    type Cell = { x0: number; y0: number; d: number; col: [number, number, number, number] };
    const cells: Cell[] = [];
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x0 = tx * size - ctx.originX;
        const y0 = ty * size - ctx.originY;
        let s = [0, 0, 0, 0];
        let n = 0;
        for (let y = Math.max(0, y0); y < Math.min(src.height, y0 + size); y++) {
          for (let x = Math.max(0, x0); x < Math.min(src.width, x0 + size); x++) {
            const i = (y * src.width + x) * 4;
            s = s.map((v, c) => v + src.data[i + c]!);
            n++;
          }
        }
        if (!n) continue;
        const col = s.map((v) => v / n) as [number, number, number, number];
        const l = col[3] > 0 ? lum(col[0], col[1], col[2]) / col[3] : 0;
        cells.push({ x0, y0, d: (levelBased ? l : hash2(tx, ty, seed)) * depthMax, col });
      }
    }
    cells.sort((a, b) => a.d - b.d);
    const cx = ctx.docWidth / 2 - ctx.originX;
    const cy = ctx.docHeight / 2 - ctx.originY;
    const put = (x: number, y: number, c: readonly number[], k: number) => {
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) return;
      const i = (y * src.width + x) * 4;
      out.data[i] = clamp01(c[0]! * k);
      out.data[i + 1] = clamp01(c[1]! * k);
      out.data[i + 2] = clamp01(c[2]! * k);
      out.data[i + 3] = c[3]!;
    };
    for (const cell of cells) {
      if (pyr) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const u = x / size - 0.5;
            const v = y / size - 0.5;
            // Which face: top, right, bottom, left — lit from the top left.
            const k = Math.abs(u) > Math.abs(v) ? (u > 0 ? 0.7 : 1.15) : v > 0 ? 0.55 : 1.3;
            put(cell.x0 + x, cell.y0 + y, cell.col, 1 + (k - 1) * Math.min(1, cell.d * 3));
          }
        }
        continue;
      }
      // Sides: a darker band between the base square and the face.
      const steps = Math.ceil(cell.d * 40);
      for (let s = steps - 1; s >= 0; s--) {
        const g = 1 + (cell.d * s) / steps;
        const bx = Math.round(cx + (cell.x0 - cx) * g);
        const by = Math.round(cy + (cell.y0 - cy) * g);
        const bs = Math.round(size * g);
        for (let k = 0; k < bs; k++) {
          put(bx + k, by, cell.col, 0.8);
          put(bx + k, by + bs - 1, cell.col, 0.6);
          put(bx, by + k, cell.col, 0.7);
          put(bx + bs - 1, by + k, cell.col, 0.65);
        }
      }
      // Block: the face grows toward the viewer, away from the centre, by its depth.
      const grow = 1 + cell.d;
      const fx = cx + (cell.x0 - cx) * grow;
      const fy = cy + (cell.y0 - cy) * grow;
      const fs = size * grow;
      for (let y = 0; y < Math.ceil(fs); y++) {
        for (let x = 0; x < Math.ceil(fs); x++) {
          const sx = cell.x0 + Math.floor(x / grow);
          const sy = cell.y0 + Math.floor(y / grow);
          if (solid || sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) put(Math.round(fx) + x, Math.round(fy) + y, cell.col, 1);
          else {
            const i = (sy * src.width + sx) * 4;
            put(Math.round(fx) + x, Math.round(fy) + y, [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!, src.data[i + 3]!], 1);
          }
        }
      }
    }
    return out;
  },
};

export const STYLIZE_FILTERS: FilterDef[] = [diffuse, emboss, extrude, findEdges, oilPaint, solarize, tiles, traceContour, wind];
