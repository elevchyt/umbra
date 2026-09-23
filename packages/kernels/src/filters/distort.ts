/**
 * Filter ▸ Distort — spec 05 §B.3. Every one is an inverse mapping: for each output pixel,
 * where in the source to sample (bicubic, premultiplied). The geometric ones are centred and
 * sized on the area acted on (the selection's bounds, or the canvas), as in Photoshop.
 */
import { clamp01, hash2, makeRaster, type Raster } from './core.js';
import type { FilterContext } from './types.js';
import { num, str, type FilterDef } from './types.js';

type Edge = 'repeat' | 'wrap' | 'transparent';

function cubic(t: number): [number, number, number, number] {
  // Catmull-Rom weights.
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

/** Bicubic sample in crop coordinates (pixel centres at +0.5); `edge` decides off-image reads. */
export function sampleBicubic(r: Raster, x: number, y: number, edge: Edge, out: number[]): void {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const wx = cubic(fx - x0);
  const wy = cubic(fy - y0);
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 4; j++) {
    let yy = y0 - 1 + j;
    for (let i = 0; i < 4; i++) {
      let xx = x0 - 1 + i;
      if (edge === 'wrap') {
        xx = ((xx % r.width) + r.width) % r.width;
        yy = ((yy % r.height) + r.height) % r.height;
      } else if (edge === 'transparent' && (xx < 0 || yy < 0 || xx >= r.width || yy >= r.height)) continue;
      const cx = xx < 0 ? 0 : xx >= r.width ? r.width - 1 : xx;
      const cy = yy < 0 ? 0 : yy >= r.height ? r.height - 1 : yy;
      const w = wx[i]! * wy[j]!;
      const o = (cy * r.width + cx) * 4;
      out[0] += r.data[o]! * w;
      out[1] += r.data[o + 1]! * w;
      out[2] += r.data[o + 2]! * w;
      out[3] += r.data[o + 3]! * w;
    }
  }
}

/**
 * Inverse-map a raster: `from(gx, gy)` gives the DOCUMENT position to sample for the output
 * pixel centre at document (gx, gy), or null to keep the pixel as it is.
 */
export function remap(src: Raster, ctx: FilterContext, edge: Edge, from: (gx: number, gy: number) => [number, number] | null): Raster {
  const out = makeRaster(src.width, src.height);
  const s = [0, 0, 0, 0];
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const o = (y * src.width + x) * 4;
      const q = from(x + ctx.originX + 0.5, y + ctx.originY + 0.5);
      if (!q) {
        out.data.set(src.data.subarray(o, o + 4), o);
        continue;
      }
      sampleBicubic(src, q[0] - ctx.originX, q[1] - ctx.originY, edge, s);
      // Bicubic overshoots; hold it inside the premultiplied range.
      const a = clamp01(s[3]!);
      out.data[o] = Math.min(a, Math.max(0, s[0]!));
      out.data[o + 1] = Math.min(a, Math.max(0, s[1]!));
      out.data[o + 2] = Math.min(a, Math.max(0, s[2]!));
      out.data[o + 3] = a;
    }
  }
  return out;
}

/** The ellipse inscribed in the area acted on: centre and radii in document pixels. */
function frame(ctx: FilterContext) {
  const b = ctx.bounds ?? { x0: 0, y0: 0, x1: ctx.docWidth, y1: ctx.docHeight };
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx: Math.max(1, (b.x1 - b.x0) / 2), ry: Math.max(1, (b.y1 - b.y0) / 2) };
}

const EDGE_OPTIONS = [
  { value: 'wrap', label: 'Wrap Around' },
  { value: 'repeat', label: 'Repeat Edge Pixels' },
];

export const pinch: FilterDef = {
  id: 'distort.pinch',
  label: 'Pinch',
  category: 'Distort',
  params: [{ key: 'amount', label: 'Amount', type: 'number', min: -100, max: 100, default: 50, unit: '%' }],
  pad: () => 'full',
  model: '[fit] inside the inscribed ellipse, sample at distance × sin(π/2·r)^(−amount): positive squeezes toward the centre, negative bulges.',
  run: (src, p, ctx) => {
    const a = num(p, 'amount') / 100;
    const f = frame(ctx);
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const u = (gx - f.cx) / f.rx;
      const v = (gy - f.cy) / f.ry;
      const r = Math.hypot(u, v);
      if (r >= 1 || r === 0) return null;
      const k = Math.pow(Math.sin((Math.PI / 2) * r), -a);
      return [f.cx + u * k * f.rx, f.cy + v * k * f.ry];
    });
  },
};

export const spherize: FilterDef = {
  id: 'distort.spherize',
  label: 'Spherize',
  category: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: -100, max: 100, default: 100, unit: '%' },
    { key: 'mode', label: 'Mode', type: 'select', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'h', label: 'Horizontal only' }, { value: 'v', label: 'Vertical only' }] },
  ],
  pad: () => 'full',
  model: '[fit] positive wraps the area round a sphere (sample at asin(r)·2/π), negative the inverse (sin(r·π/2)), mixed by Amount; the edge of the ellipse stays put.',
  run: (src, p, ctx) => {
    const a = num(p, 'amount') / 100;
    const mode = str(p, 'mode');
    const f = frame(ctx);
    const map = (r: number) => (a >= 0 ? r + (Math.asin(r) * (2 / Math.PI) - r) * a : r + (Math.sin((r * Math.PI) / 2) - r) * -a);
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const u = (gx - f.cx) / f.rx;
      const v = (gy - f.cy) / f.ry;
      if (mode === 'h') {
        if (Math.abs(u) >= 1) return null;
        return [f.cx + Math.sign(u) * map(Math.abs(u)) * f.rx, gy];
      }
      if (mode === 'v') {
        if (Math.abs(v) >= 1) return null;
        return [gx, f.cy + Math.sign(v) * map(Math.abs(v)) * f.ry];
      }
      const r = Math.hypot(u, v);
      if (r >= 1 || r === 0) return null;
      const k = map(r) / r;
      return [f.cx + u * k * f.rx, f.cy + v * k * f.ry];
    });
  },
};

export const twirl: FilterDef = {
  id: 'distort.twirl',
  label: 'Twirl',
  category: 'Distort',
  params: [{ key: 'angle', label: 'Angle', type: 'number', min: -999, max: 999, default: 50, unit: '°' }],
  pad: () => 'full',
  model: 'Spec 05: θ\' = θ + α(1 − r/R)², inside the inscribed ellipse.',
  run: (src, p, ctx) => {
    const alpha = (num(p, 'angle') * Math.PI) / 180;
    const f = frame(ctx);
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const u = (gx - f.cx) / f.rx;
      const v = (gy - f.cy) / f.ry;
      const r = Math.hypot(u, v);
      if (r >= 1) return null;
      const t = -alpha * (1 - r) ** 2;
      const cs = Math.cos(t);
      const sn = Math.sin(t);
      return [f.cx + (u * cs - v * sn) * f.rx, f.cy + (u * sn + v * cs) * f.ry];
    });
  },
};

export const zigzag: FilterDef = {
  id: 'distort.zigzag',
  label: 'ZigZag',
  category: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: -100, max: 100, default: 10 },
    { key: 'ridges', label: 'Ridges', type: 'number', min: 0, max: 20, default: 5 },
    {
      key: 'style',
      label: 'Style',
      type: 'select',
      default: 'pond',
      options: [
        { value: 'around', label: 'Around Center' },
        { value: 'out', label: 'Out From Center' },
        { value: 'pond', label: 'Pond Ripples' },
      ],
    },
  ],
  pad: () => 'full',
  model: '[fit] a sinusoid of Ridges cycles across the radius, displacing angularly (Around Center), radially (Out From Center) or both (Pond Ripples), fading to nothing at the edge.',
  run: (src, p, ctx) => {
    const a = num(p, 'amount') / 100;
    const ridges = num(p, 'ridges');
    const style = str(p, 'style');
    const f = frame(ctx);
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const u = (gx - f.cx) / f.rx;
      const v = (gy - f.cy) / f.ry;
      const r = Math.hypot(u, v);
      if (r >= 1 || r === 0) return null;
      const w = Math.sin(2 * Math.PI * ridges * r) * (1 - r);
      let rr = r;
      let th = Math.atan2(v, u);
      if (style !== 'out') th += a * 0.35 * w;
      if (style !== 'around') rr += a * 0.06 * w;
      return [f.cx + Math.cos(th) * rr * f.rx, f.cy + Math.sin(th) * rr * f.ry];
    });
  },
};

export const polar: FilterDef = {
  id: 'distort.polarcoordinates',
  label: 'Polar Coordinates',
  category: 'Distort',
  params: [{ key: 'mode', label: 'Mode', type: 'select', default: 'toPolar', options: [{ value: 'toPolar', label: 'Rectangular to Polar' }, { value: 'toRect', label: 'Polar to Rectangular' }] }],
  pad: () => 'full',
  model: 'Documented behaviour: Rectangular to Polar wraps the image\'s width round the centre with its top at the centre; Polar to Rectangular is the inverse.',
  run: (src, p, ctx) => {
    const f = frame(ctx);
    const b = ctx.bounds ?? { x0: 0, y0: 0, x1: ctx.docWidth, y1: ctx.docHeight };
    const W = b.x1 - b.x0;
    const H = b.y1 - b.y0;
    const toPolar = str(p, 'mode') === 'toPolar';
    return remap(src, ctx, 'repeat', (gx, gy) => {
      if (toPolar) {
        const u = (gx - f.cx) / f.rx;
        const v = (gy - f.cy) / f.ry;
        const r = Math.hypot(u, v);
        // Angle from twelve o'clock, clockwise, 0…1.
        let th = Math.atan2(u, -v) / (2 * Math.PI);
        if (th < 0) th += 1;
        return [b.x0 + th * W, b.y0 + Math.min(1, r) * H];
      }
      const th = ((gx - b.x0) / W) * 2 * Math.PI;
      const r = (gy - b.y0) / H;
      return [f.cx + Math.sin(th) * r * f.rx, f.cy - Math.cos(th) * r * f.ry];
    });
  },
};

export const ripple: FilterDef = {
  id: 'distort.ripple',
  label: 'Ripple',
  category: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: -999, max: 999, default: 100, unit: '%' },
    { key: 'size', label: 'Size', type: 'select', default: 'medium', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] },
  ],
  pad: (p) => Math.ceil(Math.abs(num(p, 'amount')) / 100 * 8) + 4,
  model: '[fit] two crossed sinusoids of wavelength 8/16/32 px, amplitude Amount/100 × 2…8 px, with a little irregularity so it reads as water rather than a pattern.',
  run: (src, p, ctx) => {
    const L = { small: 8, medium: 16, large: 32 }[str(p, 'size') as 'small'] ?? 16;
    const A = (num(p, 'amount') / 100) * (L / 4);
    return remap(src, ctx, 'repeat', (gx, gy) => {
      const jx = (hash2(Math.floor(gy / L), 0, 5) - 0.5) * 0.6;
      const jy = (hash2(Math.floor(gx / L), 1, 5) - 0.5) * 0.6;
      return [gx + A * Math.sin((2 * Math.PI * gy) / L + jx), gy + A * Math.sin((2 * Math.PI * gx) / L + jy)];
    });
  },
};

const WAVE_TYPES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
];

export const wave: FilterDef = {
  id: 'distort.wave',
  label: 'Wave',
  category: 'Distort',
  params: [
    { key: 'generators', label: 'Number of Generators', type: 'number', min: 1, max: 999, default: 5 },
    { key: 'minWave', label: 'Wavelength Min.', type: 'number', min: 1, max: 998, default: 10 },
    { key: 'maxWave', label: 'Wavelength Max.', type: 'number', min: 2, max: 999, default: 120 },
    { key: 'minAmp', label: 'Amplitude Min.', type: 'number', min: 1, max: 998, default: 5 },
    { key: 'maxAmp', label: 'Amplitude Max.', type: 'number', min: 2, max: 999, default: 35 },
    { key: 'scaleH', label: 'Scale Horiz.', type: 'number', min: 1, max: 100, default: 100, unit: '%' },
    { key: 'scaleV', label: 'Scale Vert.', type: 'number', min: 1, max: 100, default: 100, unit: '%' },
    { key: 'type', label: 'Type', type: 'select', default: 'sine', options: WAVE_TYPES },
    { key: 'edge', label: 'Undefined Areas', type: 'select', default: 'repeat', options: EDGE_OPTIONS },
    { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
  ],
  pad: () => 'full',
  model: '[fit] the average of Generators waves, each with a random wavelength, amplitude and phase in the given ranges, displacing horizontally by y and vertically by x. Generators past 64 are not simulated.',
  run: (src, p, ctx) => {
    const n = Math.min(64, Math.round(num(p, 'generators')));
    const seed = num(p, 'seed');
    const lo = num(p, 'minWave');
    const hi = Math.max(lo + 1, num(p, 'maxWave'));
    const alo = num(p, 'minAmp');
    const ahi = Math.max(alo, num(p, 'maxAmp'));
    const sh = num(p, 'scaleH') / 100;
    const sv = num(p, 'scaleV') / 100;
    const type = str(p, 'type');
    const shape = (t: number) => {
      const f = t - Math.floor(t);
      if (type === 'triangle') return 4 * Math.abs(f - 0.5) - 1;
      if (type === 'square') return f < 0.5 ? 1 : -1;
      return Math.sin(2 * Math.PI * f);
    };
    const gens = Array.from({ length: n }, (_, k) => ({
      L: lo + (hi - lo) * hash2(k, 0, seed),
      A: alo + (ahi - alo) * hash2(k, 1, seed),
      ph: hash2(k, 2, seed),
      ph2: hash2(k, 3, seed),
    }));
    const edge = str(p, 'edge') === 'wrap' ? 'wrap' : 'repeat';
    return remap(src, ctx, edge, (gx, gy) => {
      let dx = 0;
      let dy = 0;
      for (const g of gens) {
        dx += g.A * shape(gy / g.L + g.ph);
        dy += g.A * shape(gx / g.L + g.ph2);
      }
      return [gx + (dx / n) * sh, gy + (dy / n) * sv];
    });
  },
};

export const shear: FilterDef = {
  id: 'distort.shear',
  label: 'Shear',
  category: 'Distort',
  params: [
    { key: 'top', label: 'Top', type: 'number', min: -100, max: 100, default: 0, unit: '%' },
    { key: 'middle', label: 'Middle', type: 'number', min: -100, max: 100, default: 25, unit: '%' },
    { key: 'bottom', label: 'Bottom', type: 'number', min: -100, max: 100, default: 0, unit: '%' },
    { key: 'edge', label: 'Undefined Areas', type: 'select', default: 'wrap', options: EDGE_OPTIONS },
  ],
  pad: () => 'full',
  model: 'Photoshop\'s shear curve as three control points (top, middle, bottom), each a horizontal offset in percent of the width, joined by a smooth quadratic. The free-form curve editor is not built.',
  run: (src, p, ctx) => {
    const b = ctx.bounds ?? { x0: 0, y0: 0, x1: ctx.docWidth, y1: ctx.docHeight };
    const W = b.x1 - b.x0;
    const H = b.y1 - b.y0;
    const t0 = num(p, 'top') / 100;
    const t1 = num(p, 'middle') / 100;
    const t2 = num(p, 'bottom') / 100;
    const edge = str(p, 'edge') === 'wrap' ? 'wrap' : 'repeat';
    return remap(src, ctx, edge, (gx, gy) => {
      const t = Math.min(1, Math.max(0, (gy - b.y0) / H));
      // Quadratic through (0,t0), (½,t1), (1,t2).
      const off = t0 * (1 - t) * (1 - 2 * t) + 4 * t1 * t * (1 - t) + t2 * t * (2 * t - 1);
      return [gx - off * W, gy];
    });
  },
};

export const displace: FilterDef = {
  id: 'distort.displace',
  label: 'Displace',
  category: 'Distort',
  params: [
    { key: 'map', label: 'Displacement Map', type: 'layer', default: -1 },
    { key: 'h', label: 'Horizontal Scale', type: 'number', min: -999, max: 999, default: 10, unit: '%' },
    { key: 'v', label: 'Vertical Scale', type: 'number', min: -999, max: 999, default: 10, unit: '%' },
    { key: 'edge', label: 'Undefined Areas', type: 'select', default: 'repeat', options: EDGE_OPTIONS },
  ],
  pad: (p) => Math.ceil((Math.max(Math.abs(num(p, 'h')), Math.abs(num(p, 'v'))) / 100) * 128) + 4,
  model:
    'Spec 05: d = (map − 128)/128 · scale, with scale 100% = 128 px; red drives horizontal, green vertical (a grey map moves both equally). The map is a layer of this document; a separate PSD file needs multi-document support.',
  run: (src, p, ctx) => {
    const map = ctx.map;
    if (!map) return src;
    const h = (num(p, 'h') / 100) * 128;
    const v = (num(p, 'v') / 100) * 128;
    const edge = str(p, 'edge') === 'wrap' ? 'wrap' : 'repeat';
    return remap(src, ctx, edge, (gx, gy) => {
      const x = Math.floor(gx - ctx.originX);
      const y = Math.floor(gy - ctx.originY);
      const o = (Math.min(map.height - 1, Math.max(0, y)) * map.width + Math.min(map.width - 1, Math.max(0, x))) * 4;
      const a = map.data[o + 3]! || 1;
      return [gx + (map.data[o]! / a - 0.5) * 2 * h, gy + (map.data[o + 1]! / a - 0.5) * 2 * v];
    });
  },
};

export const DISTORT_FILTERS: FilterDef[] = [displace, pinch, polar, ripple, shear, spherize, twirl, wave, zigzag];
