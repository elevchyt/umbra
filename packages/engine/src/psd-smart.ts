/**
 * Smart objects in PSD — spec 07 §1: `placedLayer` (SoLd) on the layer, the contents as a
 * whole embedded file in `linkedFiles` (lnk2), and the smart filters as ag-psd's typed filter
 * descriptors.
 *
 * Filters are mapped both ways for every filter whose settings Photoshop and Umbra share.
 * Photoshop filters Umbra lacks (and Umbra's Filter Gallery stack, which ag-psd cannot express)
 * are not dropped silently: the layer's stored pixels still show them, and opening reports
 * them. What is not read yet: smart-filter masks, and perspective/warp placement beyond the
 * affine part. Settings Photoshop's descriptors have no field for, and so come back at their
 * defaults: Clouds' high contrast (an Alt-click there), Wind's random seed, Maximum/Minimum's
 * Preserve, Radial Blur's centre.
 */
import type { Filter as AgFilter } from 'ag-psd';
import { PSD_BLEND_MODE } from '@umbra/psd';
import type { BlendMode } from '@umbra/core/blend';
import type { Mat } from '@umbra/kernels/matrix';
import { FILTER_BY_ID, defaultsOf, type FilterParams } from '@umbra/kernels/filters/index';
import type { SmartFilter } from './document.js';

type Params = Record<string, unknown>;
interface Mapping {
  ours: string;
  ps: string;
  to?: (p: FilterParams, size: Size) => Params;
  from?: (f: Params, size: Size) => FilterParams;
}
interface Size {
  width: number;
  height: number;
}

const px = (v: number) => ({ units: 'Pixels', value: v });
const val = (u: unknown): number => (typeof u === 'number' ? u : ((u as { value?: number })?.value ?? 0));
const n = (p: FilterParams, k: string) => p[k] as number;
const s = (p: FilterParams, k: string) => p[k] as string;

/** A two-way table between one of our select values and Photoshop's names. */
function names(pairs: [string, string][]) {
  return {
    to: (v: string) => pairs.find((p) => p[0] === v)?.[1] ?? pairs[0]![1],
    from: (v: unknown) => pairs.find((p) => p[1] === v)?.[0] ?? pairs[0]![0],
  };
}
const EDGE = names([
  ['wrap', 'wrap around'],
  ['repeat', 'repeat edge pixels'],
]);
const MEZZO = names(
  ['fineDots', 'mediumDots', 'grainyDots', 'coarseDots', 'shortLines', 'mediumLines', 'longLines', 'shortStrokes', 'mediumStrokes', 'longStrokes'].map((v) => [v, v.replace(/([A-Z])/g, ' $1').toLowerCase()] as [string, string]),
);
const LENS = names([
  ['zoom', '50-300mm zoom'],
  ['prime35', '32mm prime'],
  ['prime105', '105mm prime'],
  ['movie', 'movie prime'],
]);

const plain = (ours: string, ps: string): Mapping => ({ ours, ps });
const radiusOnly = (ours: string, ps: string): Mapping => ({ ours, ps, to: (p) => ({ radius: px(n(p, 'radius')) }), from: (f) => ({ radius: val(f.radius) }) });

export const FILTER_MAP: Mapping[] = [
  plain('blur.average', 'average'),
  plain('blur.blur', 'blur'),
  plain('blur.blurmore', 'blur more'),
  radiusOnly('blur.boxblur', 'box blur'),
  radiusOnly('blur.gaussianblur', 'gaussian blur'),
  { ours: 'blur.motionblur', ps: 'motion blur', to: (p) => ({ angle: n(p, 'angle'), distance: px(n(p, 'distance')) }), from: (f) => ({ angle: val(f.angle), distance: val(f.distance) }) },
  { ours: 'blur.radialblur', ps: 'radial blur', to: (p) => ({ amount: n(p, 'amount'), method: s(p, 'method'), quality: s(p, 'quality') }), from: (f) => ({ amount: val(f.amount), method: f.method as string, quality: f.quality as string }) },
  {
    ours: 'blur.smartblur',
    ps: 'smart blur',
    to: (p) => ({ radius: n(p, 'radius'), threshold: n(p, 'threshold'), quality: s(p, 'quality'), mode: { normal: 'normal', edge: 'edge only', overlay: 'overlay edge' }[s(p, 'mode')] }),
    from: (f) => ({ radius: val(f.radius), threshold: val(f.threshold), quality: f.quality as string, mode: f.mode === 'edge only' ? 'edge' : f.mode === 'overlay edge' ? 'overlay' : 'normal' }),
  },
  { ours: 'blur.surfaceblur', ps: 'surface blur', to: (p) => ({ radius: px(n(p, 'radius')), threshold: n(p, 'threshold') }), from: (f) => ({ radius: val(f.radius), threshold: val(f.threshold) }) },
  { ours: 'distort.pinch', ps: 'pinch', to: (p) => ({ amount: n(p, 'amount') }), from: (f) => ({ amount: val(f.amount) }) },
  {
    ours: 'distort.polarcoordinates',
    ps: 'polar coordinates',
    to: (p) => ({ conversion: s(p, 'mode') === 'toPolar' ? 'rectangular to polar' : 'polar to rectangular' }),
    from: (f) => ({ mode: f.conversion === 'polar to rectangular' ? 'toRect' : 'toPolar' }),
  },
  { ours: 'distort.ripple', ps: 'ripple', to: (p) => ({ amount: n(p, 'amount'), size: s(p, 'size') }), from: (f) => ({ amount: val(f.amount), size: f.size as string }) },
  {
    ours: 'distort.spherize',
    ps: 'spherize',
    to: (p) => ({ amount: n(p, 'amount'), mode: { normal: 'normal', h: 'horizontal only', v: 'vertical only' }[s(p, 'mode')] }),
    from: (f) => ({ amount: val(f.amount), mode: f.mode === 'horizontal only' ? 'h' : f.mode === 'vertical only' ? 'v' : 'normal' }),
  },
  { ours: 'distort.twirl', ps: 'twirl', to: (p) => ({ angle: n(p, 'angle') }), from: (f) => ({ angle: val(f.angle) }) },
  {
    ours: 'distort.wave',
    ps: 'wave',
    to: (p) => ({
      numberOfGenerators: n(p, 'generators'),
      type: s(p, 'type'),
      wavelength: { min: n(p, 'minWave'), max: n(p, 'maxWave') },
      amplitude: { min: n(p, 'minAmp'), max: n(p, 'maxAmp') },
      scale: { x: n(p, 'scaleH'), y: n(p, 'scaleV') },
      randomSeed: n(p, 'seed'),
      undefinedAreas: EDGE.to(s(p, 'edge')),
    }),
    from: (f) => {
      const w = f.wavelength as { min: number; max: number };
      const a = f.amplitude as { min: number; max: number };
      const sc = f.scale as { x: number; y: number };
      return { generators: val(f.numberOfGenerators), type: f.type as string, minWave: w.min, maxWave: w.max, minAmp: a.min, maxAmp: a.max, scaleH: sc.x, scaleV: sc.y, seed: val(f.randomSeed), edge: EDGE.from(f.undefinedAreas) };
    },
  },
  {
    ours: 'distort.zigzag',
    ps: 'zigzag',
    to: (p) => ({ amount: n(p, 'amount'), ridges: n(p, 'ridges'), style: { around: 'around center', out: 'out from center', pond: 'pond ripples' }[s(p, 'style')] }),
    from: (f) => ({ amount: val(f.amount), ridges: val(f.ridges), style: f.style === 'around center' ? 'around' : f.style === 'out from center' ? 'out' : 'pond' }),
  },
  {
    ours: 'noise.addnoise',
    ps: 'add noise',
    to: (p) => ({ amount: n(p, 'amount'), distribution: s(p, 'distribution'), monochromatic: !!p.mono, randomSeed: n(p, 'seed') }),
    from: (f) => ({ amount: val(f.amount), distribution: f.distribution as string, mono: !!f.monochromatic, seed: val(f.randomSeed) }),
  },
  plain('noise.despeckle', 'despeckle'),
  { ours: 'noise.dustscratches', ps: 'dust and scratches', to: (p) => ({ radius: n(p, 'radius'), threshold: n(p, 'threshold') }), from: (f) => ({ radius: val(f.radius), threshold: val(f.threshold) }) },
  radiusOnly('noise.median', 'median'),
  {
    ours: 'pixelate.colorhalftone',
    ps: 'color halftone',
    to: (p) => ({ radius: n(p, 'radius'), angle1: n(p, 'angle1'), angle2: n(p, 'angle2'), angle3: n(p, 'angle3'), angle4: 45 }),
    from: (f) => ({ radius: val(f.radius), angle1: val(f.angle1), angle2: val(f.angle2), angle3: val(f.angle3) }),
  },
  { ours: 'pixelate.crystallize', ps: 'crystallize', to: (p) => ({ cellSize: n(p, 'cell'), randomSeed: n(p, 'seed') }), from: (f) => ({ cell: val(f.cellSize), seed: val(f.randomSeed) }) },
  plain('pixelate.facet', 'facet'),
  plain('pixelate.fragment', 'fragment'),
  { ours: 'pixelate.mezzotint', ps: 'mezzotint', to: (p) => ({ type: MEZZO.to(s(p, 'type')), randomSeed: n(p, 'seed') }), from: (f) => ({ type: MEZZO.from(f.type), seed: val(f.randomSeed) }) },
  { ours: 'pixelate.mosaic', ps: 'mosaic', to: (p) => ({ cellSize: px(n(p, 'cell')) }), from: (f) => ({ cell: val(f.cellSize) }) },
  { ours: 'pixelate.pointillize', ps: 'pointillize', to: (p) => ({ cellSize: n(p, 'cell'), randomSeed: n(p, 'seed') }), from: (f) => ({ cell: val(f.cellSize), seed: val(f.randomSeed) }) },
  { ours: 'render.clouds', ps: 'clouds', to: (p) => ({ randomSeed: n(p, 'seed') }), from: (f) => ({ seed: val(f.randomSeed) }) },
  { ours: 'render.differenceclouds', ps: 'difference clouds', to: (p) => ({ randomSeed: n(p, 'seed') }), from: (f) => ({ seed: val(f.randomSeed) }) },
  { ours: 'render.fibers', ps: 'fibers', to: (p) => ({ variance: n(p, 'variance'), strength: n(p, 'strength'), randomSeed: n(p, 'seed') }), from: (f) => ({ variance: val(f.variance), strength: val(f.strength), seed: val(f.randomSeed) }) },
  {
    ours: 'render.lensflare',
    ps: 'lens flare',
    // Photoshop stores the centre in document pixels; Umbra as fractions of the canvas.
    to: (p, size) => {
      const c = p.center as { x: number; y: number };
      return { brightness: n(p, 'brightness'), position: { x: c.x * size.width, y: c.y * size.height }, lensType: LENS.to(s(p, 'lens')) };
    },
    from: (f, size) => {
      const pos = f.position as { x: number; y: number };
      return { brightness: val(f.brightness), center: { x: pos.x / Math.max(1, size.width), y: pos.y / Math.max(1, size.height) }, lens: LENS.from(f.lensType) };
    },
  },
  plain('sharpen.sharpen', 'sharpen'),
  plain('sharpen.sharpenedges', 'sharpen edges'),
  plain('sharpen.sharpenmore', 'sharpen more'),
  {
    ours: 'sharpen.unsharpmask',
    ps: 'unsharp mask',
    to: (p) => ({ amount: n(p, 'amount'), radius: px(n(p, 'radius')), threshold: n(p, 'threshold') }),
    from: (f) => ({ amount: val(f.amount), radius: val(f.radius), threshold: val(f.threshold) }),
  },
  {
    ours: 'stylize.diffuse',
    ps: 'diffuse',
    to: (p) => ({ mode: { normal: 'normal', darken: 'darken only', lighten: 'lighten only', anisotropic: 'anisotropic' }[s(p, 'mode')], randomSeed: n(p, 'seed') }),
    from: (f) => ({ mode: f.mode === 'darken only' ? 'darken' : f.mode === 'lighten only' ? 'lighten' : f.mode === 'anisotropic' ? 'anisotropic' : 'normal', seed: val(f.randomSeed) }),
  },
  { ours: 'stylize.emboss', ps: 'emboss', to: (p) => ({ angle: n(p, 'angle'), height: n(p, 'height'), amount: n(p, 'amount') }), from: (f) => ({ angle: val(f.angle), height: val(f.height), amount: val(f.amount) }) },
  {
    ours: 'stylize.extrude',
    ps: 'extrude',
    to: (p) => ({ type: s(p, 'type'), size: n(p, 'size'), depth: n(p, 'depth'), depthMode: s(p, 'depthMode') === 'level' ? 'level-based' : 'random', randomSeed: n(p, 'seed'), solidFrontFaces: !!p.solid, maskIncompleteBlocks: false }),
    from: (f) => ({ type: f.type as string, size: val(f.size), depth: val(f.depth), depthMode: f.depthMode === 'level-based' ? 'level' : 'random', seed: val(f.randomSeed), solid: !!f.solidFrontFaces }),
  },
  plain('stylize.findedges', 'find edges'),
  plain('stylize.solarize', 'solarize'),
  {
    ours: 'stylize.tiles',
    ps: 'tiles',
    to: (p) => ({ numberOfTiles: n(p, 'number'), maximumOffset: n(p, 'offset'), fillEmptyAreaWith: `${s(p, 'fill') === 'inverse' ? 'inverse image' : s(p, 'fill') === 'unaltered' ? 'unaltered image' : `${s(p, 'fill')} color`}`, randomSeed: n(p, 'seed') }),
    from: (f) => ({ number: val(f.numberOfTiles), offset: val(f.maximumOffset), fill: String(f.fillEmptyAreaWith).split(' ')[0]!, seed: val(f.randomSeed) }),
  },
  { ours: 'stylize.tracecontour', ps: 'trace contour', to: (p) => ({ level: n(p, 'level'), edge: s(p, 'edge') }), from: (f) => ({ level: val(f.level), edge: f.edge as string }) },
  { ours: 'stylize.wind', ps: 'wind', to: (p) => ({ method: s(p, 'method'), direction: s(p, 'direction') }), from: (f) => ({ method: f.method as string, direction: f.direction as string }) },
  {
    ours: 'video.deinterlace',
    ps: 'de-interlace',
    to: (p) => ({ eliminate: `${s(p, 'eliminate')} lines`, newFieldsBy: s(p, 'create') }),
    from: (f) => ({ eliminate: f.eliminate === 'even lines' ? 'even' : 'odd', create: f.newFieldsBy as string }),
  },
  plain('video.ntsccolors', 'ntsc colors'),
  { ours: 'other.custom', ps: 'custom', to: (p) => ({ scale: n(p, 'scale'), offset: n(p, 'offset'), matrix: [...(p.kernel as number[])] }), from: (f) => ({ scale: val(f.scale), offset: val(f.offset), kernel: [...(f.matrix as number[])] }) },
  radiusOnly('other.highpass', 'high pass'),
  radiusOnly('other.maximum', 'maximum'),
  radiusOnly('other.minimum', 'minimum'),
  {
    ours: 'other.offset',
    ps: 'offset',
    to: (p) => ({ horizontal: n(p, 'h'), vertical: n(p, 'v'), undefinedAreas: { transparent: 'set to transparent', repeat: 'repeat edge pixels', wrap: 'wrap around' }[s(p, 'undefined')] }),
    from: (f) => ({ h: val(f.horizontal), v: val(f.vertical), undefined: f.undefinedAreas === 'set to transparent' ? 'transparent' : f.undefinedAreas === 'repeat edge pixels' ? 'repeat' : 'wrap' }),
  },
];

const BY_OURS = new Map(FILTER_MAP.map((m) => [m.ours, m]));
const BY_PS = new Map(FILTER_MAP.map((m) => [m.ps, m]));

const TO_PSD_MODE: Record<string, string> = Object.fromEntries(Object.entries(PSD_BLEND_MODE).map(([psd, ours]) => [ours, psd]));
const rgb255 = (c: readonly number[]) => ({ r: Math.round(c[0]! * 255), g: Math.round(c[1]! * 255), b: Math.round(c[2]! * 255) });
const rgb01 = (c: unknown): [number, number, number] => {
  const o = c as { r?: number; g?: number; b?: number } | undefined;
  return o && typeof o.r === 'number' ? [o.r / 255, (o.g ?? 0) / 255, (o.b ?? 0) / 255] : [0, 0, 0];
};

/** One of our smart filters as an ag-psd filter, or null when Photoshop has no equivalent. */
export function toPsdFilter(f: SmartFilter, size: Size): AgFilter | null {
  const m = BY_OURS.get(f.filterId);
  const def = FILTER_BY_ID.get(f.filterId);
  if (!m || !def) return null;
  const params = { ...defaultsOf(def), ...f.params };
  return {
    type: m.ps,
    ...(m.to ? { filter: m.to(params, size) } : {}),
    name: def.label,
    opacity: f.opacity,
    blendMode: TO_PSD_MODE[f.blendMode] ?? 'normal',
    enabled: f.enabled,
    hasOptions: !!m.to,
    foregroundColor: rgb255(f.foreground),
    backgroundColor: rgb255(f.background),
  } as unknown as AgFilter;
}

/** An ag-psd filter as one of ours, or null (with its name, for the open report) when unsupported. */
export function fromPsdFilter(f: AgFilter, size: Size): Omit<SmartFilter, 'id'> | { unsupported: string } {
  const raw = f as unknown as { type: string; filter?: Params; name?: string; opacity?: number; blendMode?: string; enabled?: boolean; foregroundColor?: unknown; backgroundColor?: unknown };
  const m = BY_PS.get(raw.type);
  const def = m ? FILTER_BY_ID.get(m.ours) : undefined;
  if (!m || !def) return { unsupported: raw.name ?? raw.type };
  let params: FilterParams = defaultsOf(def);
  try {
    if (m.from && raw.filter) params = { ...params, ...m.from(raw.filter, size) };
  } catch {
    return { unsupported: raw.name ?? raw.type };
  }
  return {
    filterId: m.ours,
    params,
    blendMode: (PSD_BLEND_MODE[raw.blendMode ?? 'normal'] ?? 'normal') as BlendMode,
    opacity: raw.opacity ?? 1,
    enabled: raw.enabled !== false,
    foreground: rgb01(raw.foregroundColor),
    background: rgb01(raw.backgroundColor ?? { r: 255, g: 255, b: 255 }),
  };
}

/** Photoshop's placement quad (x,y of the top-left, top-right, bottom-right, bottom-left corners) → our matrix. */
export function quadToMatrix(q: readonly number[], width: number, height: number): Mat {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return { a: (q[2]! - q[0]!) / w, b: (q[3]! - q[1]!) / w, c: (q[6]! - q[0]!) / h, d: (q[7]! - q[1]!) / h, e: q[0]!, f: q[1]! };
}

/** Our matrix → the placement quad. */
export function matrixToQuad(m: Mat, width: number, height: number): number[] {
  const at = (x: number, y: number) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  return [...at(0, 0), ...at(width, 0), ...at(width, height), ...at(0, height)];
}

/** Whether a quad is a parallelogram — anything else is perspective, which only its affine part survives. */
export function isAffineQuad(q: readonly number[]): boolean {
  const tol = 0.5;
  return Math.abs(q[4]! - (q[2]! + q[6]! - q[0]!)) < tol && Math.abs(q[5]! - (q[3]! + q[7]! - q[1]!)) < tol;
}

/**
 * Whether a placement warp does nothing. Photoshop (and ag-psd) write a "custom" warp whose
 * mesh is the regular grid over the bounds for every smart object, warped or not.
 */
export function isIdentityWarp(warp: unknown): boolean {
  const w = warp as { style?: string; value?: number; bounds?: Record<'top' | 'left' | 'bottom' | 'right', unknown>; uOrder?: number; vOrder?: number; customEnvelopeWarp?: { meshPoints?: { x: number; y: number }[] } } | undefined;
  if (!w || !w.style || w.style === 'none') return true;
  if (w.style !== 'custom') return !w.value;
  const pts = w.customEnvelopeWarp?.meshPoints;
  const u = w.uOrder ?? 4;
  const v = w.vOrder ?? 4;
  if (!pts || !w.bounds || pts.length !== u * v) return !pts;
  const left = val(w.bounds.left);
  const right = val(w.bounds.right);
  const top = val(w.bounds.top);
  const bottom = val(w.bounds.bottom);
  const tol = Math.max(right - left, bottom - top) * 1e-3 + 1e-6;
  return pts.every((p, k) => Math.abs(p.x - (left + ((right - left) * (k % u)) / (u - 1))) < tol && Math.abs(p.y - (top + ((bottom - top) * Math.floor(k / u)) / (v - 1))) < tol);
}
