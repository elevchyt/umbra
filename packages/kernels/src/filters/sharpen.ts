/** Filter ▸ Sharpen — spec 05 §B.7. */
import { clamp01, cloneRaster, convolve2d, gaussianBlur, lum, makeRaster, type Raster } from './core.js';
import { lineBlur, shapeSpans, spanBlur } from './blur.js';
import { bool, num, str, type FilterDef } from './types.js';

/**
 * Unsharp mask on premultiplied data: v + amount·(v − blurred) where the difference exceeds
 * the threshold, alpha kept and colour held inside it.
 */
export function unsharp(src: Raster, blurred: Raster, amount: number, threshold: number): Raster {
  const out = cloneRaster(src);
  const d = src.data;
  const b = blurred.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c]! - b[i + c]!;
      if (Math.abs(diff) / a < threshold) continue;
      out.data[i + c] = Math.min(a, Math.max(0, d[i + c]! + amount * diff));
    }
  }
  return out;
}

export const sharpen: FilterDef = {
  id: 'sharpen.sharpen',
  label: 'Sharpen',
  category: 'Sharpen',
  params: [],
  pad: () => 1,
  model: '[fit] the 3×3 kernel with centre 3, neighbours −¼ — a light, local sharpen.',
  run: (src) => convolve2d(src, [-1, -1, -1, -1, 12, -1, -1, -1, -1], 3, 4),
};

export const sharpenMore: FilterDef = {
  id: 'sharpen.sharpenmore',
  label: 'Sharpen More',
  category: 'Sharpen',
  params: [],
  pad: () => 1,
  model: '[fit] the classic 3×3 kernel with centre 9, neighbours −1.',
  run: (src) => convolve2d(src, [-1, -1, -1, -1, 9, -1, -1, -1, -1], 3, 1),
};

export const sharpenEdges: FilterDef = {
  id: 'sharpen.sharpenedges',
  label: 'Sharpen Edges',
  category: 'Sharpen',
  params: [],
  pad: () => 4,
  model: '[fit] Unsharp Mask 100%, radius 1, threshold 8 levels: it sharpens edges and leaves smooth areas alone, which is the filter\'s documented purpose.',
  run: (src) => unsharp(src, gaussianBlur(src, 1), 1, 8 / 255),
};

export const unsharpMask: FilterDef = {
  id: 'sharpen.unsharpmask',
  label: 'Unsharp Mask',
  category: 'Sharpen',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, default: 50, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 1000, default: 1, step: 0.1, precision: 1, unit: 'px', scale: 'log' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, default: 0, unit: 'levels' },
  ],
  pad: (p) => Math.ceil(num(p, 'radius') * 3) + 2,
  model: 'Documented: v + a·(v − G_r(v)) where |v − G| ≥ t. The radius → σ relation is Gaussian Blur\'s [fit].',
  run: (src, p) => unsharp(src, gaussianBlur(src, num(p, 'radius')), num(p, 'amount') / 100, num(p, 'threshold') / 255),
};

/**
 * Richardson–Lucy deconvolution, a few iterations: the estimate is multiplied by the blurred
 * ratio of the image to the re-blurred estimate. `blur` is the point-spread function (it is
 * symmetric for the disc and the line, so it is its own adjoint).
 */
export function richardsonLucy(src: Raster, blur: (r: Raster) => Raster, iterations: number): Raster {
  let est = cloneRaster(src);
  const n = src.data.length;
  for (let it = 0; it < iterations; it++) {
    const reblur = blur(est);
    const ratio = makeRaster(src.width, src.height);
    for (let i = 0; i < n; i++) {
      if ((i & 3) === 3) {
        ratio.data[i] = 1;
        continue;
      }
      ratio.data[i] = src.data[i]! / Math.max(1e-4, reblur.data[i]!);
    }
    const corr = blur(ratio);
    const next = cloneRaster(est);
    for (let i = 0; i < n; i += 4) {
      const a = src.data[i + 3]!;
      for (let c = 0; c < 3; c++) next.data[i + c] = Math.min(a, Math.max(0, est.data[i + c]! * corr.data[i + c]!));
      next.data[i + 3] = a;
    }
    est = next;
  }
  return est;
}

export const smartSharpen: FilterDef = {
  id: 'sharpen.smartsharpen',
  label: 'Smart Sharpen',
  category: 'Sharpen',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, default: 200, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 64, default: 1, step: 0.1, precision: 1, unit: 'px' },
    { key: 'noise', label: 'Reduce Noise', type: 'number', min: 0, max: 100, default: 10, unit: '%' },
    {
      key: 'remove',
      label: 'Remove',
      type: 'select',
      default: 'lens',
      options: [
        { value: 'gaussian', label: 'Gaussian Blur' },
        { value: 'lens', label: 'Lens Blur' },
        { value: 'motion', label: 'Motion Blur' },
      ],
    },
    { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, default: 0, unit: '°' },
    { key: 'legacy', label: 'Use Legacy', type: 'bool', default: false },
  ],
  pad: (p) => Math.ceil(num(p, 'radius') * 8) + 4,
  model:
    '[fit] Gaussian (and Legacy) is Unsharp Mask; Lens and Motion are four Richardson–Lucy iterations with a disc or line PSF, blended in by Amount; Reduce Noise pre-smooths the sharpening detail. The Shadows/Highlights fade is not modelled.',
  run: (src, p) => {
    const amount = num(p, 'amount') / 100;
    const radius = num(p, 'radius');
    const noise = num(p, 'noise') / 100;
    const remove = bool(p, 'legacy') ? 'gaussian' : str(p, 'remove');
    // Smooth the input's fine noise first, in proportion to Reduce Noise.
    const base = noise > 0 ? gaussianBlur(src, 0.6 * noise) : src;
    if (remove === 'gaussian') return unsharp(src, gaussianBlur(base, radius), amount, 0);
    const psf =
      remove === 'motion'
        ? (r: Raster) => lineBlur(r, num(p, 'angle'), Math.max(1, radius * 2))
        : (r: Raster) => spanBlur(r, shapeSpans('disc', Math.max(1, radius)));
    const sharp = richardsonLucy(base, psf, 4);
    const out = cloneRaster(src);
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3]!;
      for (let c = 0; c < 3; c++) {
        const v = src.data[i + c]! + (sharp.data[i + c]! - base.data[i + c]!) * amount;
        out.data[i + c] = Math.min(a, Math.max(0, v));
      }
    }
    return out;
  },
};

export const SHARPEN_FILTERS: FilterDef[] = [sharpen, sharpenEdges, sharpenMore, smartSharpen, unsharpMask];

export { clamp01, lum };
