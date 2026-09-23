/**
 * Filter ▸ Blur ▸ Lens Blur — spec 05 §B.2. A depth-of-field blur through a polygonal iris.
 *
 * [fit] Photoshop scatters each pixel into an iris-shaped bokeh sized by its depth. This
 * gathers instead: the image is blurred with the iris at eight radii, and each pixel
 * interpolates between the two radii either side of its own circle of confusion. Bright
 * pixels are boosted before blurring so they bloom into visible iris shapes (Specular
 * Highlights), and noise is put back afterwards so the blur matches the grain around it.
 * What would settle it: Photoshop output for a depth ramp with one bright point.
 */
import { clamp01, hash2, lum, makeRaster, type Raster } from './core.js';
import { spanBlur, type Spans } from './blur.js';
import { bool, num, str, type FilterDef } from './types.js';

/** Row spans of an iris: a regular polygon of `sides`, rounded towards a circle by `curvature` 0…1. */
export function irisSpans(sides: number, radius: number, rotationDeg: number, curvature: number): Spans {
  const R = Math.max(1, Math.round(radius));
  const rot = (rotationDeg * Math.PI) / 180;
  const seg = (2 * Math.PI) / sides;
  const edge = (phi: number) => {
    let t = (phi - rot - Math.PI / 2) % seg;
    if (t < 0) t += seg;
    const poly = Math.cos(Math.PI / sides) / Math.cos(t - seg / 2);
    return radius * (poly + (1 - poly) * curvature);
  };
  const spans: Spans = [];
  for (let dy = -R; dy <= R; dy++) {
    let a: number | null = null;
    let b = 0;
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > 0 && d > edge(Math.atan2(dy, dx)) + 0.5) continue;
      if (a === null) a = dx;
      b = dx;
    }
    if (a !== null) spans.push([dy, a, b]);
  }
  return spans;
}

const LEVELS = 8;

export const lensBlur: FilterDef = {
  id: 'blur.lensblur',
  label: 'Lens Blur',
  category: 'Blur',
  params: [
    {
      key: 'depth',
      label: 'Depth Map Source',
      type: 'select',
      default: 'none',
      options: [
        { value: 'none', label: 'None' },
        { value: 'transparency', label: 'Transparency' },
        { value: 'layer', label: 'Layer' },
      ],
    },
    { key: 'map', label: 'Depth Layer', type: 'layer', default: -1 },
    { key: 'focal', label: 'Blur Focal Distance', type: 'number', min: 0, max: 255, default: 0 },
    { key: 'invert', label: 'Invert', type: 'bool', default: false },
    {
      key: 'shape',
      label: 'Iris Shape',
      type: 'select',
      default: '6',
      options: [
        { value: '3', label: 'Triangle' },
        { value: '4', label: 'Square' },
        { value: '5', label: 'Pentagon' },
        { value: '6', label: 'Hexagon' },
        { value: '7', label: 'Heptagon' },
        { value: '8', label: 'Octagon' },
      ],
    },
    { key: 'radius', label: 'Radius', type: 'number', min: 0, max: 100, default: 15 },
    { key: 'curvature', label: 'Blade Curvature', type: 'number', min: 0, max: 100, default: 0 },
    { key: 'rotation', label: 'Rotation', type: 'number', min: 0, max: 360, default: 0, unit: '°' },
    { key: 'brightness', label: 'Specular Brightness', type: 'number', min: 0, max: 100, default: 0 },
    { key: 'threshold', label: 'Specular Threshold', type: 'number', min: 0, max: 255, default: 255 },
    { key: 'noise', label: 'Noise Amount', type: 'number', min: 0, max: 100, default: 0 },
    {
      key: 'distribution',
      label: 'Distribution',
      type: 'select',
      default: 'uniform',
      options: [
        { value: 'uniform', label: 'Uniform' },
        { value: 'gaussian', label: 'Gaussian' },
      ],
    },
    { key: 'mono', label: 'Monochromatic', type: 'bool', default: false },
  ],
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  run: (src, p, ctx) => {
    const R = num(p, 'radius');
    const sides = Number(str(p, 'shape'));
    const source = str(p, 'depth');
    const focal = num(p, 'focal') / 255;
    const invert = bool(p, 'invert');
    const w = src.width;
    const h = src.height;
    const n = w * h;

    // Circle of confusion per pixel, 0…1 of Radius.
    const coc = new Float32Array(n).fill(1);
    if (source !== 'none') {
      const map = source === 'layer' ? ctx.map : src;
      if (map) {
        for (let i = 0; i < n; i++) {
          const a = map.data[i * 4 + 3]!;
          let d = source === 'transparency' ? a : a > 0 ? lum(map.data[i * 4]! / a, map.data[i * 4 + 1]! / a, map.data[i * 4 + 2]! / a) : 0;
          if (invert) d = 1 - d;
          coc[i] = Math.abs(d - focal) / Math.max(focal, 1 - focal, 1e-6);
        }
      }
    }

    // Specular highlights: push pixels at or over the threshold up before blurring.
    const boost = (num(p, 'brightness') / 100) * 4;
    const thr = num(p, 'threshold') / 255;
    const lit = makeRaster(w, h);
    lit.data.set(src.data);
    if (boost > 0) {
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const a = src.data[o + 3]!;
        if (a <= 0) continue;
        const l = lum(src.data[o]! / a, src.data[o + 1]! / a, src.data[o + 2]! / a);
        if (l < thr) continue;
        for (let c = 0; c < 3; c++) lit.data[o + c] = src.data[o + c]! * (1 + boost);
      }
    }

    // The iris at LEVELS radii; level 0 is the source itself.
    const levels: Raster[] = [lit];
    const curvature = num(p, 'curvature') / 100;
    const rotation = num(p, 'rotation');
    for (let k = 1; k <= LEVELS; k++) {
      const r = (R * k) / LEVELS;
      levels.push(r < 0.5 ? lit : spanBlur(lit, irisSpans(sides, r, rotation, curvature)));
    }

    const out = makeRaster(w, h);
    const amount = num(p, 'noise') / 100;
    const gaussian = str(p, 'distribution') === 'gaussian';
    const mono = bool(p, 'mono');
    const noise = (gx: number, gy: number, c: number) => {
      if (gaussian) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += hash2(gx, gy, 41 + c * 4 + k);
        return (s - 2) * 0.866;
      }
      return (hash2(gx, gy, 41 + c) - 0.5) * 2;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        const f = Math.min(1, coc[i]!) * LEVELS;
        const k0 = Math.floor(f);
        const k1 = Math.min(LEVELS, k0 + 1);
        const t = f - k0;
        const A = levels[k0]!.data;
        const B = levels[k1]!.data;
        const a = clamp01(A[o + 3]! + (B[o + 3]! - A[o + 3]!) * t);
        out.data[o + 3] = a;
        for (let c = 0; c < 3; c++) out.data[o + c] = Math.min(a, Math.max(0, A[o + c]! + (B[o + c]! - A[o + c]!) * t));
        if (amount > 0 && a > 0) {
          const gx = x + ctx.originX;
          const gy = y + ctx.originY;
          for (let c = 0; c < 3; c++) {
            const v = noise(gx, gy, mono ? 0 : c) * amount * 0.5 * a;
            out.data[o + c] = Math.min(a, Math.max(0, out.data[o + c]! + v));
          }
        }
      }
    }
    return out;
  },
};
