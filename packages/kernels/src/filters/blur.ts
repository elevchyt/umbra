/** Filter ▸ Blur — spec 05 §B.2 (Lens Blur is in lensblur.ts). */
import {
  boxBlur,
  clamp01,
  cloneRaster,
  convolve2d,
  gaussianBlur,
  lum,
  makeRaster,
  sampleBilinear,
  type Raster,
} from './core.js';
import { num, pt, str, type FilterDef } from './types.js';

export const average: FilterDef = {
  id: 'blur.average',
  label: 'Average',
  category: 'Blur',
  params: [],
  pad: () => 'full',
  // The mean colour of the selection (or layer), painted over it with each pixel's alpha kept.
  run: (src, _p, ctx) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const d = src.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const w = ctx.coverage ? ctx.coverage[j]! / 255 : 1;
      r += d[i]! * w;
      g += d[i + 1]! * w;
      b += d[i + 2]! * w;
      a += d[i + 3]! * w;
    }
    const out = cloneRaster(src);
    if (a <= 0) return out;
    const cr = r / a;
    const cg = g / a;
    const cb = b / a;
    for (let i = 0; i < d.length; i += 4) {
      const al = d[i + 3]!;
      out.data[i] = cr * al;
      out.data[i + 1] = cg * al;
      out.data[i + 2] = cb * al;
    }
    return out;
  },
};

export const blur: FilterDef = {
  id: 'blur.blur',
  label: 'Blur',
  category: 'Blur',
  params: [],
  pad: () => 1,
  model: '[fit] a 3×3 binomial kernel; Photoshop documents only that it is a light blur.',
  run: (src) => convolve2d(src, [1, 2, 1, 2, 4, 2, 1, 2, 1], 3, 16, 0, true),
};

export const blurMore: FilterDef = {
  id: 'blur.blurmore',
  label: 'Blur More',
  category: 'Blur',
  params: [],
  pad: () => 2,
  model: '[fit] a 5×5 binomial kernel — "three to four times" Blur, as Photoshop describes it.',
  run: (src) => {
    const k1 = [1, 4, 6, 4, 1];
    const k: number[] = [];
    for (const a of k1) for (const b of k1) k.push(a * b);
    return convolve2d(src, k, 5, 256, 0, true);
  },
};

export const boxBlurFilter: FilterDef = {
  id: 'blur.boxblur',
  label: 'Box Blur',
  category: 'Blur',
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 1, max: 2000, default: 10, unit: 'px', scale: 'log' }],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  run: (src, p) => boxBlur(src, num(p, 'radius')),
};

export const gaussian: FilterDef = {
  id: 'blur.gaussianblur',
  label: 'Gaussian Blur',
  category: 'Blur',
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 1000, default: 1, step: 0.1, precision: 1, unit: 'px', scale: 'log' }],
  pad: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
  model: '[fit] Radius is taken as the standard deviation; a step-edge fit against Photoshop would pin the ratio.',
  run: (src, p) => gaussianBlur(src, num(p, 'radius')),
};

/** Average along a line through each pixel: an anti-aliased line kernel, bilinear taps. */
export function lineBlur(src: Raster, angleDeg: number, distance: number): Raster {
  const out = makeRaster(src.width, src.height);
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = -Math.sin(a);
  // One tap per pixel of length, capped: past a few hundred taps the average has converged.
  const taps = Math.max(2, Math.min(256, Math.ceil(distance) + 1));
  const px = [0, 0, 0, 0];
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let t = 0; t < taps; t++) {
        const k = (t / (taps - 1) - 0.5) * distance;
        sampleBilinear(src, x + 0.5 + dx * k, y + 0.5 + dy * k, px);
        s0 += px[0]!;
        s1 += px[1]!;
        s2 += px[2]!;
        s3 += px[3]!;
      }
      const o = (y * src.width + x) * 4;
      out.data[o] = s0 / taps;
      out.data[o + 1] = s1 / taps;
      out.data[o + 2] = s2 / taps;
      out.data[o + 3] = s3 / taps;
    }
  }
  return out;
}

export const motionBlur: FilterDef = {
  id: 'blur.motionblur',
  label: 'Motion Blur',
  category: 'Blur',
  params: [
    { key: 'angle', label: 'Angle', type: 'number', min: -90, max: 90, default: 0, unit: '°' },
    { key: 'distance', label: 'Distance', type: 'number', min: 1, max: 2000, default: 10, unit: 'px', scale: 'log' },
  ],
  pad: (p) => Math.ceil(num(p, 'distance') / 2) + 2,
  run: (src, p) => lineBlur(src, num(p, 'angle'), num(p, 'distance')),
};

export const radialBlur: FilterDef = {
  id: 'blur.radialblur',
  label: 'Radial Blur',
  category: 'Blur',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 100, default: 10 },
    { key: 'method', label: 'Blur Method', type: 'select', default: 'spin', options: [{ value: 'spin', label: 'Spin' }, { value: 'zoom', label: 'Zoom' }] },
    { key: 'quality', label: 'Quality', type: 'select', default: 'good', options: [{ value: 'draft', label: 'Draft' }, { value: 'good', label: 'Good' }, { value: 'best', label: 'Best' }] },
    { key: 'center', label: 'Blur Center', type: 'point', default: { x: 0.5, y: 0.5 } },
  ],
  pad: () => 'full',
  model: '[fit] Spin sweeps ±Amount/2 degrees; Zoom scales by 1 ± Amount/200 about the centre.',
  run: (src, p, ctx) => {
    const out = makeRaster(src.width, src.height);
    const c = pt(p, 'center');
    const cx = c.x * ctx.docWidth - ctx.originX;
    const cy = c.y * ctx.docHeight - ctx.originY;
    const amount = num(p, 'amount');
    const zoom = str(p, 'method') === 'zoom';
    const taps = { draft: 8, good: 24, best: 48 }[str(p, 'quality') as 'draft'] ?? 24;
    const px = [0, 0, 0, 0];
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const rx = x + 0.5 - cx;
        const ry = y + 0.5 - cy;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        for (let t = 0; t < taps; t++) {
          const k = t / (taps - 1) - 0.5;
          let sx: number;
          let sy: number;
          if (zoom) {
            const f = 1 + (k * amount) / 100;
            sx = cx + rx * f;
            sy = cy + ry * f;
          } else {
            const ang = (k * amount * Math.PI) / 180;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            sx = cx + rx * cs - ry * sn;
            sy = cy + rx * sn + ry * cs;
          }
          sampleBilinear(src, sx, sy, px);
          s0 += px[0]!;
          s1 += px[1]!;
          s2 += px[2]!;
          s3 += px[3]!;
        }
        const o = (y * src.width + x) * 4;
        out.data[o] = s0 / taps;
        out.data[o + 1] = s1 / taps;
        out.data[o + 2] = s2 / taps;
        out.data[o + 3] = s3 / taps;
      }
    }
    return out;
  },
};

/** A shape as horizontal spans per row: [dy, x0, x1] with inclusive ends, relative to centre. */
export type Spans = [number, number, number][];

export function shapeSpans(shape: string, radius: number): Spans {
  const r = Math.max(1, Math.round(radius));
  const spans: Spans = [];
  for (let dy = -r; dy <= r; dy++) {
    const v = dy / r;
    let half: number | null = null;
    let x0: number | null = null;
    let x1: number | null = null;
    switch (shape) {
      case 'square':
        half = r;
        break;
      case 'diamond':
        half = Math.round(r * (1 - Math.abs(v)));
        break;
      case 'ring': {
        // A ring of thickness r/4: two spans on middle rows, one at the top and bottom.
        const outer = Math.sqrt(Math.max(0, 1 - v * v)) * r;
        const innerR = r * 0.75;
        const inner = Math.abs(dy) < innerR ? Math.sqrt(innerR * innerR - dy * dy) : -1;
        if (inner < 0) half = Math.round(outer);
        else {
          spans.push([dy, -Math.round(outer), -Math.ceil(inner)]);
          spans.push([dy, Math.ceil(inner), Math.round(outer)]);
        }
        break;
      }
      case 'star': {
        // A four-point star: the diamond pinched.
        const k = 1 - Math.abs(v);
        half = Math.round(r * k * k);
        break;
      }
      case 'triangle':
        x0 = -Math.round(r * (v + 1) / 2);
        x1 = -x0;
        break;
      default: {
        half = Math.round(Math.sqrt(Math.max(0, 1 - v * v)) * r);
      }
    }
    if (half !== null) spans.push([dy, -half, half]);
    else if (x0 !== null && x1 !== null) spans.push([dy, x0, x1]);
  }
  return spans;
}

/**
 * Convolve with a flat shape given as spans, in O(rows of the shape) per pixel: each span's
 * sum is two lookups in per-row prefix sums. What Shape Blur and Lens Blur's iris use.
 */
export function spanBlur(src: Raster, spans: Spans): Raster {
  const { width: w, height: h } = src;
  // Prefix sums per row, width+1 entries per channel.
  const pre = new Float64Array(h * (w + 1) * 4);
  for (let y = 0; y < h; y++) {
    const rb = y * (w + 1) * 4;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) pre[rb + (x + 1) * 4 + c] = pre[rb + x * 4 + c]! + src.data[i + c]!;
    }
  }
  let area = 0;
  for (const [, a, b] of spans) area += b - a + 1;
  const out = makeRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (const [dy, a, b] of spans) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        const rb = yy * (w + 1) * 4;
        // Replicate edges: clamp the span; the part hanging off repeats the edge pixel.
        let x0 = x + a;
        let x1 = x + b;
        let extraL = 0;
        let extraR = 0;
        if (x0 < 0) {
          extraL = -x0;
          x0 = 0;
        }
        if (x1 > w - 1) {
          extraR = x1 - (w - 1);
          x1 = w - 1;
        }
        if (x1 >= x0) {
          s0 += pre[rb + (x1 + 1) * 4]! - pre[rb + x0 * 4]!;
          s1 += pre[rb + (x1 + 1) * 4 + 1]! - pre[rb + x0 * 4 + 1]!;
          s2 += pre[rb + (x1 + 1) * 4 + 2]! - pre[rb + x0 * 4 + 2]!;
          s3 += pre[rb + (x1 + 1) * 4 + 3]! - pre[rb + x0 * 4 + 3]!;
        }
        if (extraL) {
          const i = (yy * w) * 4;
          s0 += src.data[i]! * extraL;
          s1 += src.data[i + 1]! * extraL;
          s2 += src.data[i + 2]! * extraL;
          s3 += src.data[i + 3]! * extraL;
        }
        if (extraR) {
          const i = (yy * w + w - 1) * 4;
          s0 += src.data[i]! * extraR;
          s1 += src.data[i + 1]! * extraR;
          s2 += src.data[i + 2]! * extraR;
          s3 += src.data[i + 3]! * extraR;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = s0 / area;
      out.data[o + 1] = s1 / area;
      out.data[o + 2] = s2 / area;
      out.data[o + 3] = s3 / area;
    }
  }
  return out;
}

export const SHAPES = [
  { value: 'disc', label: 'Circle' },
  { value: 'square', label: 'Square' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'star', label: 'Star' },
  { value: 'ring', label: 'Ring' },
];

export const shapeBlur: FilterDef = {
  id: 'blur.shapeblur',
  label: 'Shape Blur',
  category: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 5, max: 1000, default: 10, unit: 'px', scale: 'log' },
    { key: 'shape', label: 'Shape', type: 'select', default: 'disc', options: SHAPES },
  ],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: 'Exact for the shape given; the shapes are a small built-in set until custom shapes (M7).',
  run: (src, p) => spanBlur(src, shapeSpans(str(p, 'shape'), num(p, 'radius'))),
};

export const smartBlur: FilterDef = {
  id: 'blur.smartblur',
  label: 'Smart Blur',
  category: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 100, default: 3, step: 0.1, precision: 1 },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0.1, max: 100, default: 25, step: 0.1, precision: 1 },
    { key: 'quality', label: 'Quality', type: 'select', default: 'low', options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
    { key: 'mode', label: 'Mode', type: 'select', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'edge', label: 'Edge Only' }, { value: 'overlay', label: 'Overlay Edge' }] },
  ],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: '[fit] averages the neighbours within Radius whose luminance is within Threshold (0…100 → 0…255/2.55); edges are where a neighbour exceeds it.',
  run: (src, p) => {
    const rad = Math.max(1, Math.round(num(p, 'radius')));
    const t = (num(p, 'threshold') * 2.55) / 255;
    const stride = { low: Math.max(1, Math.floor(rad / 4)), medium: Math.max(1, Math.floor(rad / 8)), high: 1 }[str(p, 'quality') as 'low'] ?? 1;
    const mode = str(p, 'mode');
    const { width: w, height: h, data: d } = src;
    const out = makeRaster(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const a = d[o + 3]!;
        const l0 = a > 0 ? lum(d[o]!, d[o + 1]!, d[o + 2]!) / a : 0;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        let n = 0;
        let edge = false;
        for (let dy = -rad; dy <= rad; dy += stride) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -rad; dx <= rad; dx += stride) {
            if (dx * dx + dy * dy > rad * rad) continue;
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const i = (yy * w + xx) * 4;
            const aa = d[i + 3]!;
            const l = aa > 0 ? lum(d[i]!, d[i + 1]!, d[i + 2]!) / aa : 0;
            if (Math.abs(l - l0) > t) {
              edge = true;
              continue;
            }
            s0 += d[i]!;
            s1 += d[i + 1]!;
            s2 += d[i + 2]!;
            s3 += d[i + 3]!;
            n++;
          }
        }
        if (mode === 'edge') {
          const v = edge ? 1 : 0;
          out.data[o] = v * a;
          out.data[o + 1] = v * a;
          out.data[o + 2] = v * a;
          out.data[o + 3] = a;
        } else if (mode === 'overlay' && edge) {
          out.data[o] = a;
          out.data[o + 1] = a;
          out.data[o + 2] = a;
          out.data[o + 3] = a;
        } else {
          out.data[o] = s0 / n;
          out.data[o + 1] = s1 / n;
          out.data[o + 2] = s2 / n;
          out.data[o + 3] = s3 / n;
        }
      }
    }
    return out;
  },
};

export const surfaceBlur: FilterDef = {
  id: 'blur.surfaceblur',
  label: 'Surface Blur',
  category: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 1, max: 100, default: 5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 2, max: 255, default: 15, unit: 'levels' },
  ],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: '[fit] per-channel triangular range weight w = max(0, 1 − |I − Ic| / (2.5·T)) over a square window, as spec 05 records.',
  run: (src, p) => {
    const rad = Math.round(num(p, 'radius'));
    const t = (2.5 * num(p, 'threshold')) / 255;
    const { width: w, height: h, data: d } = src;
    const out = cloneRaster(src);
    // Straight colour for the range test; premultiplied sums keep edges of transparency clean.
    const st = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
      const a = d[i + 3]!;
      st[j] = a > 0 ? d[i]! / a : 0;
      st[j + 1] = a > 0 ? d[i + 1]! / a : 0;
      st[j + 2] = a > 0 ? d[i + 2]! / a : 0;
    }
    // Large windows are sampled on a grid; the triangular weight makes the result insensitive.
    const stride = rad > 24 ? Math.ceil(rad / 24) : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const a0 = d[o + 3]!;
        if (a0 <= 0) continue;
        const j0 = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const ic = st[j0 + c]!;
          let sum = 0;
          let wsum = 0;
          for (let dy = -rad; dy <= rad; dy += stride) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let dx = -rad; dx <= rad; dx += stride) {
              const xx = Math.min(w - 1, Math.max(0, x + dx));
              const j = (yy * w + xx) * 3;
              const wt = Math.max(0, 1 - Math.abs(st[j + c]! - ic) / t) * d[(yy * w + xx) * 4 + 3]!;
              sum += st[j + c]! * wt;
              wsum += wt;
            }
          }
          out.data[o + c] = clamp01(wsum > 0 ? sum / wsum : ic) * a0;
        }
      }
    }
    return out;
  },
};

export const BLUR_FILTERS: FilterDef[] = [average, blur, blurMore, boxBlurFilter, gaussian, motionBlur, radialBlur, shapeBlur, smartBlur, surfaceBlur];
