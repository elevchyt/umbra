/** Filter ▸ Other — spec 05 §B.8. */
import { clamp01, cloneRaster, convolve2d, gaussianBlur, makeRaster, mapStraight, type Raster } from './core.js';
import { shapeSpans } from './blur.js';
import { num, str, type FilterDef } from './types.js';

export const custom: FilterDef = {
  id: 'other.custom',
  label: 'Custom',
  category: 'Other',
  params: [
    { key: 'kernel', label: 'Kernel', type: 'kernel', size: 5, default: [0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, -1, 5, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0] },
    { key: 'scale', label: 'Scale', type: 'number', min: 1, max: 9999, default: 1 },
    { key: 'offset', label: 'Offset', type: 'number', min: -9999, max: 9999, default: 0 },
  ],
  pad: () => 2,
  model: 'Documented: Σ kernel·v / Scale + Offset, per channel, alpha kept.',
  run: (src, p) => convolve2d(src, p.kernel as number[], 5, num(p, 'scale'), num(p, 'offset') / 255),
};

export const highPass: FilterDef = {
  id: 'other.highpass',
  label: 'High Pass',
  category: 'Other',
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 1000, default: 10, step: 0.1, precision: 1, unit: 'px', scale: 'log' }],
  pad: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
  model: 'Documented: v − G_r(v) + ½, in straight colour.',
  run: (src, p) => {
    const blurred = gaussianBlur(src, num(p, 'radius'));
    const out = cloneRaster(src);
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3]!;
      if (a <= 0) continue;
      const ba = blurred.data[i + 3]! || 1;
      for (let c = 0; c < 3; c++) {
        const v = src.data[i + c]! / a - blurred.data[i + c]! / ba + 0.5;
        out.data[i + c] = clamp01(v) * a;
      }
    }
    return out;
  },
};

// ---- HSB/HSL ------------------------------------------------------------------------------

function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h / 6, max > 0 ? d / max : 0, max];
}
function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [rgbToHsb(r, g, b)[0], s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - (c / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1)) * 1;
  };
  return [f(0), f(8), f(4)];
}

export const hsbHsl: FilterDef = {
  id: 'other.hsbhsl',
  label: 'HSB/HSL',
  category: 'Other',
  params: [
    { key: 'input', label: 'Input Mode', type: 'select', default: 'rgb', options: [{ value: 'rgb', label: 'RGB' }, { value: 'hsb', label: 'HSB' }, { value: 'hsl', label: 'HSL' }] },
    { key: 'rows', label: 'Row Order', type: 'select', default: 'hsb', options: [{ value: 'rgb', label: 'RGB' }, { value: 'hsb', label: 'HSB' }, { value: 'hsl', label: 'HSL' }] },
  ],
  pad: () => 0,
  model: 'Documented: reinterpret the three channels — e.g. RGB in, HSB rows out puts hue in red, saturation in green, brightness in blue.',
  run: (src, p) => {
    const input = str(p, 'input');
    const rows = str(p, 'rows');
    return mapStraight(src, (px) => {
      let rgb: [number, number, number] = [px[0]!, px[1]!, px[2]!];
      if (input === 'hsb') rgb = hsbToRgb(rgb[0], rgb[1], rgb[2]);
      else if (input === 'hsl') rgb = hslToRgb(rgb[0], rgb[1], rgb[2]);
      const outV = rows === 'hsb' ? rgbToHsb(...rgb) : rows === 'hsl' ? rgbToHsl(...rgb) : rgb;
      px[0] = outV[0];
      px[1] = outV[1];
      px[2] = outV[2];
    });
  },
};

// ---- Maximum / Minimum --------------------------------------------------------------------

/** Sliding max (or min) along one axis with a monotonic deque: O(n) whatever the radius. */
function slideExtreme(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean, max: boolean): void {
  const len = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 4 : width * 4;
  const idx = new Int32Array(len + 2 * radius + 1);
  const better = max ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let head = 0;
      let tail = 0;
      const at = (k: number) => src[base + (k < 0 ? 0 : k >= len ? len - 1 : k) * step + c]!;
      for (let k = -radius; k < len + radius; k++) {
        const v = at(k);
        while (tail > head && better(v, at(idx[tail - 1]!))) tail--;
        idx[tail++] = k;
        const centre = k - radius;
        if (idx[head]! < centre - radius) head++;
        if (centre >= 0) dst[base + centre * step + c] = at(idx[head]!);
      }
    }
  }
}

function morphology(src: Raster, radius: number, roundness: boolean, max: boolean): Raster {
  const r = Math.max(1, Math.round(radius));
  const { width: w, height: h } = src;
  const out = makeRaster(w, h);
  if (!roundness) {
    const tmp = new Float32Array(src.data.length);
    slideExtreme(src.data, tmp, w, h, r, true, max);
    slideExtreme(tmp, out.data, w, h, r, false, max);
    return out;
  }
  // A disc: for each row offset the horizontal extreme over that row's half-width, then the
  // extreme of those. Horizontal passes are shared between rows of equal half-width.
  const spans = shapeSpans('disc', r);
  const byHalf = new Map<number, Float32Array>();
  for (const [, a] of spans) {
    const half = -a;
    if (byHalf.has(half)) continue;
    const t = new Float32Array(src.data.length);
    if (half === 0) t.set(src.data);
    else slideExtreme(src.data, t, w, h, half, true, max);
    byHalf.set(half, t);
  }
  out.data.fill(max ? -Infinity : Infinity);
  for (const [dy, a] of spans) {
    const t = byHalf.get(-a)!;
    for (let y = 0; y < h; y++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      const so = yy * w * 4;
      const oo = y * w * 4;
      for (let i = 0; i < w * 4; i++) {
        const v = t[so + i]!;
        const cur = out.data[oo + i]!;
        out.data[oo + i] = max ? (v > cur ? v : cur) : v < cur ? v : cur;
      }
    }
  }
  return out;
}

const morphParams = [
  { key: 'radius', label: 'Radius', type: 'number' as const, min: 0.2, max: 500, default: 1, step: 0.1, precision: 1, unit: 'px', scale: 'log' as const },
  { key: 'preserve', label: 'Preserve', type: 'select' as const, default: 'squareness', options: [{ value: 'squareness', label: 'Squareness' }, { value: 'roundness', label: 'Roundness' }] },
];

export const maximum: FilterDef = {
  id: 'other.maximum',
  label: 'Maximum',
  category: 'Other',
  params: morphParams,
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: 'Documented: each channel\'s maximum over a square (Squareness) or disc (Roundness) — light areas spread.',
  run: (src, p) => morphology(src, num(p, 'radius'), str(p, 'preserve') === 'roundness', true),
};

export const minimum: FilterDef = {
  id: 'other.minimum',
  label: 'Minimum',
  category: 'Other',
  params: morphParams,
  pad: (p) => Math.ceil(num(p, 'radius')) + 1,
  model: 'Documented: each channel\'s minimum — dark areas spread.',
  run: (src, p) => morphology(src, num(p, 'radius'), str(p, 'preserve') === 'roundness', false),
};

export const offset: FilterDef = {
  id: 'other.offset',
  label: 'Offset',
  category: 'Other',
  params: [
    { key: 'h', label: 'Horizontal', type: 'number', min: -30000, max: 30000, default: 0, unit: 'px right' },
    { key: 'v', label: 'Vertical', type: 'number', min: -30000, max: 30000, default: 0, unit: 'px down' },
    {
      key: 'undefined',
      label: 'Undefined Areas',
      type: 'select',
      default: 'wrap',
      options: [
        { value: 'transparent', label: 'Set to Transparent' },
        { value: 'repeat', label: 'Repeat Edge Pixels' },
        { value: 'wrap', label: 'Wrap Around' },
      ],
    },
  ],
  pad: () => 'full',
  model: 'Documented. Wrap Around wraps within the layer\'s canvas area.',
  run: (src, p) => {
    const { width: w, height: h } = src;
    const dx = Math.round(num(p, 'h'));
    const dy = Math.round(num(p, 'v'));
    const mode = str(p, 'undefined');
    const out = makeRaster(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sx = x - dx;
        let sy = y - dy;
        if (mode === 'wrap') {
          sx = ((sx % w) + w) % w;
          sy = ((sy % h) + h) % h;
        } else if (mode === 'repeat') {
          sx = Math.min(w - 1, Math.max(0, sx));
          sy = Math.min(h - 1, Math.max(0, sy));
        } else if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const i = (sy * w + sx) * 4;
        const o = (y * w + x) * 4;
        out.data[o] = src.data[i]!;
        out.data[o + 1] = src.data[i + 1]!;
        out.data[o + 2] = src.data[i + 2]!;
        out.data[o + 3] = src.data[i + 3]!;
      }
    }
    return out;
  },
};

export const OTHER_FILTERS: FilterDef[] = [custom, highPass, hsbHsl, maximum, minimum, offset];
