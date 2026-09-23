/**
 * The retouching tools on the brush engine — spec 04 §4.2. Dabs come from the brush stroke
 * like any other tool's; what a dab does to the pixels differs, and it is computed on the CPU
 * with the same dab coverage (`dabAlpha`) the GPU brush draws.
 *
 * Two families:
 * - STROKE-BUFFER tools deposit per-pixel content into the stroke buffer — Clone Stamp (the
 *   source's pixels), Pattern Stamp, History Brush, Art History, Colour Replacement (the pixel
 *   recoloured), Background Eraser (clear, where the colour matches). The stroke is then
 *   composited at Opacity exactly as a brush stroke is, so Opacity is the ceiling and Flow
 *   builds up, and the live preview is the brush's.
 * - DIRECT tools change a working copy of the layer. Dodge, Burn and Sponge work from the
 *   pixels as they were when the stroke began, through the stroke's accumulated coverage — so
 *   going over a spot again in one stroke does not keep darkening it, as in Photoshop (the
 *   airbrush builds up). Blur, Sharpen, Smudge and the Mixer Brush act on the live pixels,
 *   dab by dab.
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import type { Dab } from '@umbra/kernels/brush';
import type { Plane, PlaneWriter } from './tiles/plane.js';

export type RetouchToolId =
  | 'cloneStamp'
  | 'patternStamp'
  | 'historyBrush'
  | 'artHistoryBrush'
  | 'colorReplacement'
  | 'backgroundEraser'
  | 'dodgeTool'
  | 'burnTool'
  | 'spongeTool'
  | 'blurTool'
  | 'sharpenTool'
  | 'smudgeTool'
  | 'mixerBrush'
  | 'healingBrush';

export const RETOUCH_TOOLS: readonly RetouchToolId[] = ['cloneStamp', 'patternStamp', 'historyBrush', 'artHistoryBrush', 'colorReplacement', 'backgroundEraser', 'dodgeTool', 'burnTool', 'spongeTool', 'blurTool', 'sharpenTool', 'smudgeTool', 'mixerBrush', 'healingBrush'];

export type Sampling = 'continuous' | 'once' | 'backgroundSwatch';
export type Limits = 'discontiguous' | 'contiguous' | 'findEdges';

/** Every tool's options bar, in one bag. */
export interface RetouchOptions {
  // Clone Stamp, Healing Brush, Pattern Stamp
  aligned: boolean;
  sample: 'current' | 'currentBelow' | 'all';
  impressionist: boolean;
  healSource: 'sampled' | 'pattern';
  diffusion: number;
  // Dodge / Burn / Sponge
  range: 'shadows' | 'midtones' | 'highlights';
  /** 0…1 */
  exposure: number;
  protectTones: boolean;
  spongeMode: 'saturate' | 'desaturate';
  vibrance: boolean;
  // Blur / Sharpen / Smudge
  strength: number;
  sampleAll: boolean;
  protectDetail: boolean;
  fingerPainting: boolean;
  // Colour Replacement / Background Eraser
  replaceMode: 'hue' | 'saturation' | 'color' | 'luminosity';
  sampling: Sampling;
  limits: Limits;
  /** 0…1 */
  tolerance: number;
  antiAlias: boolean;
  protectForeground: boolean;
  // Mixer Brush
  wet: number;
  load: number;
  mix: number;
  loadColor: boolean;
  // Art History
  artStyle: 'tightShort' | 'tightMedium' | 'tightLong' | 'looseMedium' | 'looseLong' | 'dab' | 'tightCurl' | 'tightCurlLong' | 'looseCurl' | 'looseCurlLong';
  area: number;
  artTolerance: number;
  /** Pattern Stamp / Healing's pattern source. */
  patternId?: string;
  /** The Clone Source panel's transform of the source (scale %, angle °, flips). */
  clone?: { scaleX: number; scaleY: number; angle: number; flipX: boolean; flipY: boolean };
}

export const DEFAULT_RETOUCH: RetouchOptions = {
  aligned: true,
  sample: 'current',
  impressionist: false,
  healSource: 'sampled',
  diffusion: 5,
  range: 'midtones',
  exposure: 0.5,
  protectTones: true,
  spongeMode: 'desaturate',
  vibrance: true,
  strength: 0.5,
  sampleAll: false,
  protectDetail: true,
  fingerPainting: false,
  replaceMode: 'color',
  sampling: 'continuous',
  limits: 'contiguous',
  tolerance: 0.3,
  antiAlias: true,
  protectForeground: false,
  wet: 0.5,
  load: 0.5,
  mix: 0.5,
  loadColor: true,
  artStyle: 'tightShort',
  area: 50,
  artTolerance: 0,
};

export type Rgba = Float32Array;

/** Straight RGBA 0…1 of a plane at an integer pixel (transparent outside stored tiles' defaults). */
export function readPixel(plane: Plane, x: number, y: number, out: Rgba): Rgba {
  const t = plane.tileAt(x >> TILE_SHIFT, y >> TILE_SHIFT);
  const i = t.uniform ? 0 : ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
  const d = t.data;
  out[0] = d[i]! / 255;
  out[1] = d[i + 1]! / 255;
  out[2] = d[i + 2]! / 255;
  out[3] = d[i + 3]! / 255;
  return out;
}

/** Bilinear straight RGBA from a sampler of integer pixels (premultiplied while mixing). */
export function bilinear(at: (x: number, y: number, out: Rgba) => Rgba, x: number, y: number, out: Rgba): Rgba {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const t = new Float32Array(4);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const add = (xx: number, yy: number, w: number) => {
    if (w <= 0) return;
    at(xx, yy, t);
    r += t[0]! * t[3]! * w;
    g += t[1]! * t[3]! * w;
    b += t[2]! * t[3]! * w;
    a += t[3]! * w;
  };
  add(x0, y0, (1 - ax) * (1 - ay));
  add(x0 + 1, y0, ax * (1 - ay));
  add(x0, y0 + 1, (1 - ax) * ay);
  add(x0 + 1, y0 + 1, ax * ay);
  out[3] = a;
  out[0] = a > 0 ? r / a : 0;
  out[1] = a > 0 ? g / a : 0;
  out[2] = a > 0 ? b / a : 0;
  return out;
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** Dodge and Burn's tone curves (GIMP's, per range), for one channel value. */
export function dodgeBurn(v: number, dodge: boolean, range: RetouchOptions['range'], e: number): number {
  if (dodge) {
    if (range === 'highlights') return clamp01(v * (1 + e / 3));
    if (range === 'midtones') return Math.pow(v, 1 / (1 + e));
    const f = 1 - e / 3;
    return f * v + (1 - f);
  }
  if (range === 'highlights') return v * (1 - e / 3);
  if (range === 'midtones') return Math.pow(v, 1 + e);
  const f = 1 + e / 3;
  return clamp01(f * v - (f - 1));
}

/** Colour Replacement's recolouring of a pixel with the paint colour. */
export function recolor(px: [number, number, number], paint: [number, number, number], mode: RetouchOptions['replaceMode']): [number, number, number] {
  const [h, s, l] = rgbToHsl(...px);
  const [ph, ps, pl] = rgbToHsl(...paint);
  switch (mode) {
    case 'hue':
      return hslToRgb(ph, s, l);
    case 'saturation':
      return hslToRgb(h, ps, l);
    case 'color':
      return hslToRgb(ph, ps, l);
    case 'luminosity':
      return hslToRgb(h, s, pl);
  }
}

/** How close two colours are, 0 (same) … 1 (far): the tolerance test's distance. */
const colorDistance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));

export interface RetouchSetup {
  tool: RetouchToolId;
  options: RetouchOptions;
  width: number;
  height: number;
  /** The target layer's pixels when the stroke began. */
  orig: Plane;
  /** Stroke-buffer tools write here; direct tools into `layer`. */
  stroke?: PlaneWriter;
  layer?: PlaneWriter;
  /** Where the content comes from (clone, history, sample-all): straight RGBA at a document point. */
  source?: (x: number, y: number, out: Rgba) => Rgba;
  /** Clone Stamp and Healing: document point → source point. */
  map?: (x: number, y: number) => { x: number; y: number };
  pattern?: { width: number; height: number; data: Uint8Array };
  fg: [number, number, number];
  bg: [number, number, number];
  /** Flow (Mixer Brush's, Sponge's). */
  flow: number;
  seed: number;
}

/** A retouching stroke in progress. */
export class RetouchStroke {
  readonly family: 'stroke' | 'direct';
  /** Coverage accumulated by direct tools per pixel (S ← S + a·(1 − S)), by tile. */
  private cover = new Map<number, Float32Array>();
  private sampled: Rgba | null = null;
  private first: { x: number; y: number } | null = null;
  /** Smudge's carried patch and the Mixer's reservoir: premultiplied RGBA around the dab. */
  private carry: { r: number; data: Float32Array } | null = null;
  private rand: () => number;
  /** The Mixer Brush's load left, draining as the brush travels. */
  private loadLeft: number | null = null;
  /** Tile cells written since the last `takeTouched`: the engine refreshes them on the GPU. */
  private touched = new Set<number>();
  private readonly tmp = new Float32Array(4);
  private readonly tmp2 = new Float32Array(4);

  constructor(readonly s: RetouchSetup) {
    const direct: RetouchToolId[] = ['dodgeTool', 'burnTool', 'spongeTool', 'blurTool', 'sharpenTool', 'smudgeTool', 'mixerBrush'];
    this.family = direct.includes(s.tool) ? 'direct' : 'stroke';
    let a = s.seed >>> 0 || 1;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The paint mode the stroke buffer composites with (stroke-buffer tools). */
  get mode(): 'normal' | 'clear' {
    return this.s.tool === 'backgroundEraser' ? 'clear' : 'normal';
  }

  /** Pixel at the layer as it is NOW (the working copy for direct tools). */
  private current(x: number, y: number, out: Rgba): Rgba {
    const w = this.s.layer;
    if (!w) return readPixel(this.s.orig, x, y, out);
    const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const i = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
    out[0] = d[i]! / 255;
    out[1] = d[i + 1]! / 255;
    out[2] = d[i + 2]! / 255;
    out[3] = d[i + 3]! / 255;
    return out;
  }

  /** The tile cells written since last asked, as [tx, ty]. */
  takeTouched(): [number, number][] {
    const out = [...this.touched].map((k) => [k & 0xffff, k >>> 16] as [number, number]);
    this.touched.clear();
    return out;
  }

  private touch(x: number, y: number): void {
    this.touched.add(((y >> TILE_SHIFT) << 16) | (x >> TILE_SHIFT));
  }

  private writeLayer(x: number, y: number, px: ArrayLike<number>): void {
    this.touch(x, y);
    const d = this.s.layer!.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const i = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
    d[i] = Math.round(clamp01(px[0]!) * 255);
    d[i + 1] = Math.round(clamp01(px[1]!) * 255);
    d[i + 2] = Math.round(clamp01(px[2]!) * 255);
    d[i + 3] = Math.round(clamp01(px[3]!) * 255);
  }

  /** Deposit content `c` (straight) at coverage `a` into the stroke buffer ("over"). */
  private deposit(x: number, y: number, c: ArrayLike<number>, a: number): void {
    if (a <= 0) return;
    this.touch(x, y);
    const d = this.s.stroke!.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
    const i = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
    const sa = d[i + 3]! / 255;
    const oa = a + sa * (1 - a);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(clamp01((c[k]! * a + (d[i + k]! / 255) * sa * (1 - a)) / oa) * 255);
    d[i + 3] = Math.round(clamp01(oa) * 255);
  }

  /** Direct tools' accumulated coverage at a pixel, raised by `a`; returns the new value. */
  private accumulate(x: number, y: number, a: number): number {
    const key = ((y >> TILE_SHIFT) << 16) ^ (x >> TILE_SHIFT);
    let t = this.cover.get(key);
    if (!t) {
      t = new Float32Array(TILE_SIZE * TILE_SIZE);
      this.cover.set(key, t);
    }
    const i = (y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1));
    t[i] = t[i]! + a * (1 - t[i]!);
    return t[i]!;
  }

  /** The dab's pixel rectangle, clipped to the canvas. */
  private rect(dab: Dab): { x0: number; y0: number; x1: number; y1: number } {
    const reach = (dab.radius / Math.max(0.01, Math.min(1, dab.roundness))) * (dab.tip ? Math.SQRT2 : 1) + 1;
    return {
      x0: Math.max(0, Math.floor(dab.x - reach)),
      y0: Math.max(0, Math.floor(dab.y - reach)),
      x1: Math.min(this.s.width, Math.ceil(dab.x + reach)),
      y1: Math.min(this.s.height, Math.ceil(dab.y + reach)),
    };
  }

  /** The colour the tolerance tests sample, per the Sampling option. */
  private sampleColor(dab: Dab): Rgba {
    const o = this.s.options;
    if (o.sampling === 'backgroundSwatch') return Float32Array.of(...this.s.bg, 1);
    if (o.sampling === 'once' && this.sampled) return this.sampled;
    const c = readPixel(this.s.orig, Math.min(this.s.width - 1, Math.max(0, Math.floor(dab.x))), Math.min(this.s.height - 1, Math.max(0, Math.floor(dab.y))), new Float32Array(4));
    this.sampled = c;
    return c;
  }

  /** Which pixels of the dab the tolerance admits (0…1), for the Limits option. */
  private matchMask(dab: Dab, r: { x0: number; y0: number; x1: number; y1: number }, sample: Rgba): Float32Array {
    const o = this.s.options;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const m = new Float32Array(w * h);
    const px = this.tmp;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        readPixel(this.s.orig, r.x0 + x, r.y0 + y, px);
        const d = colorDistance(px, sample);
        let v = d <= o.tolerance ? 1 : 0;
        // Anti-aliasing softens the tolerance edge over a small band.
        if (o.antiAlias && !v) v = clamp01(1 - (d - o.tolerance) / 0.04);
        if (o.protectForeground && colorDistance(px, this.s.fg) <= o.tolerance) v = 0;
        m[y * w + x] = v;
      }
    }
    if (o.limits === 'discontiguous') return m;
    // Contiguous (and Find Edges): only what connects to the pixel under the centre.
    const reach = new Uint8Array(w * h);
    const cx = Math.min(w - 1, Math.max(0, Math.floor(dab.x) - r.x0));
    const cy = Math.min(h - 1, Math.max(0, Math.floor(dab.y) - r.y0));
    if (m[cy * w + cx]! <= 0) return new Float32Array(w * h);
    const stack = [cy * w + cx];
    reach[cy * w + cx] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (reach[j] || m[j]! <= 0) continue;
        reach[j] = 1;
        if (m[j]! >= 1) stack.push(j);
      }
    }
    for (let i = 0; i < m.length; i++) if (!reach[i]) m[i] = 0;
    return m;
  }

  /**
   * One dab. `cov` is the dab's coverage at a pixel centre (tip, dynamics, selection).
   * Returns the tiles it wrote.
   */
  dab(dab: Dab, cov: (x: number, y: number) => number): void {
    const s = this.s;
    const o = s.options;
    const r = this.rect(dab);
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    if (!this.first) this.first = { x: dab.x, y: dab.y };
    const px = this.tmp;
    const c = this.tmp2;
    switch (s.tool) {
      case 'cloneStamp':
      case 'healingBrush':
      case 'historyBrush': {
        if (!s.source) return;
        if (s.tool === 'healingBrush' && o.healSource === 'pattern') return this.patternDab(dab, r, cov);
        for (let y = r.y0; y < r.y1; y++) {
          for (let x = r.x0; x < r.x1; x++) {
            const a = cov(x + 0.5, y + 0.5);
            if (a <= 0) continue;
            const p = s.map ? s.map(x + 0.5, y + 0.5) : { x: x + 0.5, y: y + 0.5 };
            if (s.map) bilinear(s.source, p.x, p.y, c);
            else s.source(x, y, c);
            this.deposit(x, y, c, a * c[3]!);
          }
        }
        return;
      }
      case 'patternStamp':
        return this.patternDab(dab, r, cov);
      case 'artHistoryBrush':
        return this.artDab(dab);
      case 'colorReplacement':
      case 'backgroundEraser': {
        const sample = this.sampleColor(dab);
        const m = this.matchMask(dab, r, sample);
        const w = r.x1 - r.x0;
        for (let y = r.y0; y < r.y1; y++) {
          for (let x = r.x0; x < r.x1; x++) {
            const a = cov(x + 0.5, y + 0.5) * m[(y - r.y0) * w + (x - r.x0)]!;
            if (a <= 0) continue;
            readPixel(s.orig, x, y, px);
            if (s.tool === 'backgroundEraser') this.deposit(x, y, px, a);
            else {
              const rc = recolor([px[0]!, px[1]!, px[2]!], s.fg, o.replaceMode);
              this.deposit(x, y, [rc[0], rc[1], rc[2], 1], a);
            }
          }
        }
        return;
      }
      case 'dodgeTool':
      case 'burnTool':
      case 'spongeTool': {
        for (let y = r.y0; y < r.y1; y++) {
          for (let x = r.x0; x < r.x1; x++) {
            const a = cov(x + 0.5, y + 0.5);
            if (a <= 0) continue;
            const S = this.accumulate(x, y, a);
            readPixel(s.orig, x, y, px);
            if (px[3]! <= 0) continue;
            const out = this.tone(px);
            for (let k = 0; k < 3; k++) c[k] = px[k]! + (out[k]! - px[k]!) * S;
            c[3] = px[3]!;
            this.writeLayer(x, y, c);
          }
        }
        return;
      }
      case 'blurTool':
      case 'sharpenTool':
        return this.focusDab(r, cov);
      case 'smudgeTool':
        return this.smudgeDab(dab, r, cov);
      case 'mixerBrush':
        return this.mixerDab(dab, r, cov);
    }
  }

  /** Dodge, Burn or Sponge applied fully to one pixel (the stroke's coverage blends it). */
  private tone(px: Rgba): [number, number, number] {
    const o = this.s.options;
    const e = this.s.tool === 'spongeTool' ? this.s.flow : o.exposure;
    if (this.s.tool === 'spongeTool') {
      const l = lum(px[0]!, px[1]!, px[2]!);
      const sat = Math.max(px[0]!, px[1]!, px[2]!) - Math.min(px[0]!, px[1]!, px[2]!);
      // Vibrance goes easy on what is already saturated (saturating) or grey (desaturating).
      const k = o.vibrance ? (o.spongeMode === 'saturate' ? 1 - sat : sat) : 1;
      const f = o.spongeMode === 'saturate' ? 1 + e * k : 1 - e * k;
      return [clamp01(l + (px[0]! - l) * f), clamp01(l + (px[1]! - l) * f), clamp01(l + (px[2]! - l) * f)];
    }
    const dodge = this.s.tool === 'dodgeTool';
    const out: [number, number, number] = [dodgeBurn(px[0]!, dodge, o.range, e), dodgeBurn(px[1]!, dodge, o.range, e), dodgeBurn(px[2]!, dodge, o.range, e)];
    if (!o.protectTones) return out;
    // Protect Tones [fit]: the luminance change, applied to the pixel's own colour — so hues
    // do not shift and saturation does not blow out.
    const l0 = lum(px[0]!, px[1]!, px[2]!);
    const l1 = lum(out[0], out[1], out[2]);
    if (l0 <= 1e-6) return [l1, l1, l1];
    const k = l1 / l0;
    const r: [number, number, number] = [px[0]! * k, px[1]! * k, px[2]! * k];
    const m = Math.max(...r);
    // Out of gamut: pull towards the grey of the same luminance instead of clipping a channel.
    if (m > 1) {
      const t = (1 - l1) / (m - l1);
      return [l1 + (r[0] - l1) * t, l1 + (r[1] - l1) * t, l1 + (r[2] - l1) * t];
    }
    return r;
  }

  private patternDab(dab: Dab, r: { x0: number; y0: number; x1: number; y1: number }, cov: (x: number, y: number) => number): void {
    const p = this.s.pattern;
    if (!p) return;
    const o = this.s.options;
    // Aligned: the pattern is fixed to the document; unaligned, it starts at each stroke.
    const ox = o.aligned ? 0 : Math.floor(this.first!.x);
    const oy = o.aligned ? 0 : Math.floor(this.first!.y);
    const c = this.tmp2;
    const at = (x: number, y: number) => {
      const px = (((x - ox) % p.width) + p.width) % p.width;
      const py = (((y - oy) % p.height) + p.height) % p.height;
      const i = (py * p.width + px) * 4;
      c[0] = p.data[i]! / 255;
      c[1] = p.data[i + 1]! / 255;
      c[2] = p.data[i + 2]! / 255;
      c[3] = p.data[i + 3]! / 255;
    };
    // Impressionist [fit]: the whole dab takes the pattern's colour under its centre.
    if (o.impressionist) at(Math.floor(dab.x), Math.floor(dab.y));
    const fixed = o.impressionist ? Float32Array.from(c) : null;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const a = cov(x + 0.5, y + 0.5);
        if (a <= 0) continue;
        if (!fixed) at(x, y);
        const col = fixed ?? c;
        this.deposit(x, y, col, a * col[3]!);
      }
    }
  }

  /**
   * Art History Brush [fit]: each dab throws a handful of short strokes around it within the
   * Area, each coloured from the history source at its start and running along the source's
   * isophote (across its gradient), longer or curlier by style.
   */
  private artDab(dab: Dab): void {
    const s = this.s;
    if (!s.source) return;
    const o = s.options;
    const style = o.artStyle;
    const len = style.includes('Long') ? 3 : style.includes('Medium') ? 2 : style === 'dab' ? 0.2 : 1;
    const loose = style.startsWith('loose');
    const curl = style.includes('Curl') ? (loose ? 0.25 : 0.15) : 0;
    const n = Math.max(1, Math.round(o.area / 12));
    const area = o.area;
    const rad = Math.max(1, dab.radius * 0.35);
    const c = new Float32Array(4);
    const g = new Float32Array(4);
    for (let k = 0; k < n; k++) {
      let x = dab.x + (this.rand() * 2 - 1) * area;
      let y = dab.y + (this.rand() * 2 - 1) * area;
      if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
      s.source(Math.floor(x), Math.floor(y), c);
      if (c[3]! <= 0) continue;
      const color = Float32Array.from(c);
      const steps = Math.max(1, Math.round((len * dab.radius * 2) / rad));
      let heading = this.rand() * Math.PI * 2;
      for (let st = 0; st < steps; st++) {
        // Along the isophote: perpendicular to the luminance gradient.
        const lumAt = (qx: number, qy: number) => {
          s.source!(Math.floor(qx), Math.floor(qy), g);
          return lum(g[0]!, g[1]!, g[2]!);
        };
        const lx = lumAt(x + 1, y) - lumAt(x - 1, y);
        const ly = lumAt(x, y + 1) - lumAt(x, y - 1);
        if (Math.hypot(lx, ly) > 1e-3) heading = Math.atan2(lx, -ly) + (loose ? (this.rand() - 0.5) * 0.6 : 0);
        heading += curl;
        const x0 = Math.max(0, Math.floor(x - rad));
        const y0 = Math.max(0, Math.floor(y - rad));
        const x1 = Math.min(s.width, Math.ceil(x + rad));
        const y1 = Math.min(s.height, Math.ceil(y + rad));
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
            if (d >= rad) continue;
            this.deposit(px, py, color, (1 - (d / rad) ** 2) * dab.flow);
          }
        }
        x += Math.cos(heading) * rad * 0.8;
        y += Math.sin(heading) * rad * 0.8;
        if (x < 0 || y < 0 || x >= s.width || y >= s.height) break;
      }
    }
  }

  /** Blur and Sharpen: a 3×3 neighbourhood of the live pixels, blended in by coverage × Strength. */
  private focusDab(r: { x0: number; y0: number; x1: number; y1: number }, cov: (x: number, y: number) => number): void {
    const s = this.s;
    const o = s.options;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    // Read the neighbourhood first (one pixel of margin), premultiplied, then write.
    const W = w + 2;
    const H = h + 2;
    const src = new Float32Array(W * H * 4);
    const read = o.sampleAll && s.source ? (x: number, y: number, out: Rgba) => s.source!(x, y, out) : (x: number, y: number, out: Rgba) => this.current(x, y, out);
    const px = this.tmp;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = Math.min(s.width - 1, Math.max(0, r.x0 + x - 1));
        const dy = Math.min(s.height - 1, Math.max(0, r.y0 + y - 1));
        read(dx, dy, px);
        const i = (y * W + x) * 4;
        src[i] = px[0]! * px[3]!;
        src[i + 1] = px[1]! * px[3]!;
        src[i + 2] = px[2]! * px[3]!;
        src[i + 3] = px[3]!;
      }
    }
    const out = new Float32Array(4);
    const blurAt = (x: number, y: number, k: number) => {
      let sum = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += src[((y + 1 + j) * W + (x + 1 + i)) * 4 + k]! * (i === 0 && j === 0 ? 4 : i === 0 || j === 0 ? 2 : 1);
      return sum / 16;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = cov(r.x0 + x + 0.5, r.y0 + y + 0.5) * o.strength;
        if (a <= 0) continue;
        const i = ((y + 1) * W + (x + 1)) * 4;
        for (let k = 0; k < 4; k++) {
          const v = src[i + k]!;
          const b = blurAt(x, y, k);
          if (s.tool === 'blurTool') out[k] = v + (b - v) * a;
          else {
            let sharp = v + (v - b) * a * 1.5;
            // Protect Detail [fit]: never past the neighbourhood's own range (no halos).
            if (o.protectDetail) {
              let lo = Infinity;
              let hi = -Infinity;
              for (let j = -1; j <= 1; j++)
                for (let q = -1; q <= 1; q++) {
                  const n = src[((y + 1 + j) * W + (x + 1 + q)) * 4 + k]!;
                  lo = Math.min(lo, n);
                  hi = Math.max(hi, n);
                }
              sharp = Math.min(hi, Math.max(lo, sharp));
            }
            out[k] = sharp;
          }
        }
        const al = clamp01(out[3]!);
        this.writeLayer(r.x0 + x, r.y0 + y, al > 0 ? [out[0]! / al, out[1]! / al, out[2]! / al, al] : [0, 0, 0, 0]);
      }
    }
  }

  /**
   * Smudge — spec 04's carried patch: the patch picked up at the stroke's start is laid down
   * at each dab by coverage × Strength, and picks up what it passes over
   * (`buffer ← lerp(canvas, buffer, strength)`). Finger Painting starts it with the foreground.
   */
  private smudgeDab(dab: Dab, r: { x0: number; y0: number; x1: number; y1: number }, cov: (x: number, y: number) => number): void {
    const s = this.s;
    const o = s.options;
    const R = Math.ceil(dab.radius / Math.max(0.01, dab.roundness)) + 1;
    const D = R * 2 + 1;
    const px = this.tmp;
    const read = o.sampleAll && s.source ? (x: number, y: number, out: Rgba) => s.source!(x, y, out) : (x: number, y: number, out: Rgba) => this.current(x, y, out);
    const grab = (into: Float32Array) => {
      for (let j = 0; j < D; j++)
        for (let i = 0; i < D; i++) {
          const x = Math.min(s.width - 1, Math.max(0, Math.round(dab.x) - R + i));
          const y = Math.min(s.height - 1, Math.max(0, Math.round(dab.y) - R + j));
          read(x, y, px);
          const k = (j * D + i) * 4;
          into[k] = px[0]! * px[3]!;
          into[k + 1] = px[1]! * px[3]!;
          into[k + 2] = px[2]! * px[3]!;
          into[k + 3] = px[3]!;
        }
    };
    if (!this.carry || this.carry.r !== R) {
      const data = new Float32Array(D * D * 4);
      if (o.fingerPainting) for (let k = 0; k < D * D; k++) data.set([s.fg[0], s.fg[1], s.fg[2], 1], k * 4);
      else grab(data);
      this.carry = { r: R, data };
      if (!o.fingerPainting) return;
    }
    const buf = this.carry.data;
    const canvas = new Float32Array(D * D * 4);
    grab(canvas);
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const a = cov(x + 0.5, y + 0.5) * o.strength;
        if (a <= 0) continue;
        const i = x - (Math.round(dab.x) - R);
        const j = y - (Math.round(dab.y) - R);
        if (i < 0 || j < 0 || i >= D || j >= D) continue;
        const k = (j * D + i) * 4;
        const out = [0, 0, 0, 0];
        for (let q = 0; q < 4; q++) out[q] = canvas[k + q]! + (buf[k + q]! - canvas[k + q]!) * a;
        const al = clamp01(out[3]!);
        this.writeLayer(x, y, al > 0 ? [out[0]! / al, out[1]! / al, out[2]! / al, al] : [0, 0, 0, 0]);
      }
    }
    // The patch picks up what it passed over.
    for (let k = 0; k < buf.length; k++) buf[k] = canvas[k]! + (buf[k]! - canvas[k]!) * o.strength;
  }

  /**
   * Mixer Brush [fit], spec 04's reservoir model: the brush's reservoir mixes with the canvas
   * it touches by Wet, lays down by Flow × coverage, and the load (paint loaded, per Load)
   * drains with distance; Mix weighs the reservoir against the loaded colour.
   */
  private mixerDab(dab: Dab, r: { x0: number; y0: number; x1: number; y1: number }, cov: (x: number, y: number) => number): void {
    const s = this.s;
    const o = s.options;
    const R = Math.ceil(dab.radius / Math.max(0.01, dab.roundness)) + 1;
    const D = R * 2 + 1;
    const px = this.tmp;
    if (!this.carry || this.carry.r !== R) {
      const data = new Float32Array(D * D * 4);
      for (let k = 0; k < D * D; k++) data.set(o.loadColor ? [s.fg[0], s.fg[1], s.fg[2], 1] : [0, 0, 0, 0], k * 4);
      this.carry = { r: R, data };
    }
    const res = this.carry.data;
    const load = this.loadLeft ?? o.load;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const a = cov(x + 0.5, y + 0.5);
        if (a <= 0) continue;
        const i = x - (Math.round(dab.x) - R);
        const j = y - (Math.round(dab.y) - R);
        if (i < 0 || j < 0 || i >= D || j >= D) continue;
        const k = (j * D + i) * 4;
        this.current(x, y, px);
        const cpm = [px[0]! * px[3]!, px[1]! * px[3]!, px[2]! * px[3]!, px[3]!];
        // res ← lerp(res, canvas, wet): the reservoir takes up paint from the canvas.
        for (let q = 0; q < 4; q++) res[k + q] = res[k + q]! + (cpm[q]! - res[k + q]!) * o.wet * a;
        // What the brush lays down: the reservoir, mixed with the loaded colour while there is load.
        const loaded = o.loadColor ? [s.fg[0], s.fg[1], s.fg[2], 1] : cpm;
        const paint = [0, 0, 0, 0];
        for (let q = 0; q < 4; q++) paint[q] = res[k + q]! * o.mix + loaded[q]! * (1 - o.mix) * load + res[k + q]! * (1 - o.mix) * (1 - load);
        const f = s.flow * a;
        const out = [0, 0, 0, 0];
        for (let q = 0; q < 4; q++) out[q] = cpm[q]! + (paint[q]! - cpm[q]!) * f;
        const al = clamp01(out[3]!);
        this.writeLayer(x, y, al > 0 ? [out[0]! / al, out[1]! / al, out[2]! / al, al] : [0, 0, 0, 0]);
      }
    }
    // The load drains as the brush travels.
    this.loadLeft = Math.max(0, load - 0.02);
  }
}
