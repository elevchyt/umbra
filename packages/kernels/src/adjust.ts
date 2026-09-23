/**
 * Image adjustments — spec 05 §A.
 *
 * Every adjustment compiles to one of two shapes:
 *
 *  - a **table** (`lut`): three 256-entry channel maps. Table-shaped adjustments stacked on
 *    top of each other fuse into a single table, so ten of them cost one lookup (spec 05,
 *    fusion rule). Levels, Curves, Exposure, Invert, Posterize and legacy Brightness/Contrast
 *    are all of this shape because each output channel depends only on its own input.
 *  - a **pixel** function: everything whose output depends on more than one input channel —
 *    anything touching saturation, luminance or a channel matrix.
 *
 * Accuracy, given there is no Photoshop to compare against (roadmap open question 3, answered
 * "no install"): adjustments with a published formula implement it exactly and are tested
 * against an independent transcription of that formula. The rest are approximations, marked
 * `[fit]`, and each says in its own comment what the approximation is and what evidence would
 * settle it. Nothing here silently guesses.
 */
import { curveToLut, identityLut, isIdentityLut, levelsLut, type CurvePoint } from './curve.js';
import { sampleGradient, type Gradient } from './gradient.js';
import { getLut, sampleLut } from './lut.js';

/**
 * Photoshop's classic luminance weights, used by Grayscale mode, Threshold and Gradient Map.
 * They are the NTSC/Rec. 601 primaries, not Rec. 709 — Photoshop never updated them, and
 * matching it matters more here than being colourimetrically modern.
 */
export const LUM_R = 0.3;
export const LUM_G = 0.59;
export const LUM_B = 0.11;

export function luminance(r: number, g: number, b: number): number {
  return LUM_R * r + LUM_G * g + LUM_B * b;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- parameter types ------------------------------------------------------------------

export interface LevelsChannel {
  /** 0…255 */
  inBlack: number;
  /** 0.10…9.99 */
  gamma: number;
  /** 0…255 */
  inWhite: number;
  outBlack: number;
  outWhite: number;
}

export const DEFAULT_LEVELS: LevelsChannel = {
  inBlack: 0,
  gamma: 1,
  inWhite: 255,
  outBlack: 0,
  outWhite: 255,
};

export interface HueRange {
  /** −180…180 */
  hue: number;
  /** −100…100 */
  saturation: number;
  /** −100…100 */
  lightness: number;
}

export const NO_HUE_CHANGE: HueRange = { hue: 0, saturation: 0, lightness: 0 };

/** Hue/Saturation's six colour ranges, in Photoshop's Edit-menu (and PSD) order. */
export const HUE_BANDS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
export type HueBandName = (typeof HUE_BANDS)[number];

/**
 * One colour range: its own Hue/Saturation/Lightness, and the four hue angles (degrees) of
 * its range bar — fall-off start, full start, full end, fall-off end. The range may wrap past
 * 360°, as Reds does.
 */
export interface HueBand extends HueRange {
  range: [number, number, number, number];
}

/** Photoshop's default range edges (spec 05 §A). */
export const DEFAULT_HUE_BAND_RANGES: Record<HueBandName, [number, number, number, number]> = {
  reds: [315, 345, 15, 45],
  yellows: [15, 45, 75, 105],
  greens: [75, 105, 135, 165],
  cyans: [135, 165, 195, 225],
  blues: [195, 225, 255, 285],
  magentas: [255, 285, 315, 345],
};

export function defaultHueBands(): Record<HueBandName, HueBand> {
  return Object.fromEntries(
    HUE_BANDS.map((b) => [b, { ...NO_HUE_CHANGE, range: [...DEFAULT_HUE_BAND_RANGES[b]] }]),
  ) as Record<HueBandName, HueBand>;
}

const wrap360 = (v: number) => ((v % 360) + 360) % 360;

/**
 * How much a hue belongs to a range: 0 outside it, a linear ramp across each fall-off, 1 in
 * the middle. Angles are measured from the range's start so a range that wraps past 360°
 * needs no special case.
 */
export function hueBandWeight(h: number, [a, b, c, d]: readonly [number, number, number, number]): number {
  const db = wrap360(b - a);
  const dc = wrap360(c - a);
  const dd = wrap360(d - a);
  const dh = wrap360(h - a);
  if (dh <= db) return db === 0 ? 1 : dh / db;
  if (dh <= dc) return 1;
  if (dh <= dd) return dd === dc ? 1 : (dd - dh) / (dd - dc);
  return 0;
}

export interface ChannelMixerOutput {
  /** Source weights as percentages, −200…200. */
  r: number;
  g: number;
  b: number;
  /** −200…200 % */
  constant: number;
}

export interface ColorBalanceBand {
  /** Cyan…Red, −100…100 */
  cyanRed: number;
  /** Magenta…Green */
  magentaGreen: number;
  /** Yellow…Blue */
  yellowBlue: number;
}

export const NO_BALANCE: ColorBalanceBand = { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };

/** Selective Color's nine colour ranges, in Photoshop's menu (and PSD) order. */
export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
export type SelectiveRange = (typeof SELECTIVE_RANGES)[number];

/** Percentages, −100…100. */
export interface CmykShift {
  c: number;
  m: number;
  y: number;
  k: number;
}
export const NO_CMYK_SHIFT: CmykShift = { c: 0, m: 0, y: 0, k: 0 };

export type Adjustment =
  | { kind: 'brightnessContrast'; brightness: number; contrast: number; legacy: boolean }
  | { kind: 'levels'; master: LevelsChannel; r: LevelsChannel; g: LevelsChannel; b: LevelsChannel }
  | { kind: 'curves'; master: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }
  | { kind: 'exposure'; exposure: number; offset: number; gamma: number }
  | { kind: 'invert' }
  | { kind: 'posterize'; levels: number }
  | { kind: 'threshold'; level: number }
  | { kind: 'desaturate' }
  | { kind: 'channelMixer'; r: ChannelMixerOutput; g: ChannelMixerOutput; b: ChannelMixerOutput; monochrome: boolean }
  | {
      kind: 'hueSaturation';
      master: HueRange;
      /** The six colour ranges; absent means all at zero with the default edges. */
      bands?: Record<HueBandName, HueBand>;
      colorize: boolean;
      colorizeHue: number;
      colorizeSaturation: number;
      colorizeLightness: number;
    }
  | { kind: 'vibrance'; vibrance: number; saturation: number }
  | { kind: 'colorBalance'; shadows: ColorBalanceBand; midtones: ColorBalanceBand; highlights: ColorBalanceBand; preserveLuminosity: boolean }
  | { kind: 'blackWhite'; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: [number, number, number] | null }
  | { kind: 'photoFilter'; color: [number, number, number]; density: number; preserveLuminosity: boolean }
  | { kind: 'gradientMap'; gradient: Gradient; reverse: boolean }
  | { kind: 'selectiveColor'; relative: boolean; ranges: Record<SelectiveRange, CmykShift> }
  /** A 3-D LUT by registry id (`lut.ts`); an id with no table behind it is a no-op. */
  | { kind: 'colorLookup'; lutId: string; name: string };

/** Photoshop's names, as they appear in menus, layer names and history. */
export const ADJUSTMENT_LABEL: Record<Adjustment['kind'], string> = {
  brightnessContrast: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  desaturate: 'Desaturate',
  channelMixer: 'Channel Mixer',
  hueSaturation: 'Hue/Saturation',
  vibrance: 'Vibrance',
  colorBalance: 'Color Balance',
  blackWhite: 'Black & White',
  photoFilter: 'Photo Filter',
  gradientMap: 'Gradient Map',
  selectiveColor: 'Selective Color',
  colorLookup: 'Color Lookup',
};

/** Parameters that leave the image alone, for "is this adjustment doing anything?" checks. */
export function defaultAdjustment(kind: Adjustment['kind']): Adjustment {
  switch (kind) {
    case 'brightnessContrast':
      return { kind, brightness: 0, contrast: 0, legacy: false };
    case 'levels':
      return { kind, master: DEFAULT_LEVELS, r: DEFAULT_LEVELS, g: DEFAULT_LEVELS, b: DEFAULT_LEVELS };
    case 'curves': {
      const line: CurvePoint[] = [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ];
      return { kind, master: line, r: line, g: line, b: line };
    }
    case 'exposure':
      return { kind, exposure: 0, offset: 0, gamma: 1 };
    case 'invert':
      return { kind };
    case 'posterize':
      return { kind, levels: 4 };
    case 'threshold':
      return { kind, level: 128 };
    case 'desaturate':
      return { kind };
    case 'channelMixer':
      return {
        kind,
        r: { r: 100, g: 0, b: 0, constant: 0 },
        g: { r: 0, g: 100, b: 0, constant: 0 },
        b: { r: 0, g: 0, b: 100, constant: 0 },
        monochrome: false,
      };
    case 'hueSaturation':
      return {
        kind,
        master: NO_HUE_CHANGE,
        colorize: false,
        colorizeHue: 0,
        colorizeSaturation: 25,
        colorizeLightness: 0,
      };
    case 'vibrance':
      return { kind, vibrance: 0, saturation: 0 };
    case 'colorBalance':
      return {
        kind,
        shadows: NO_BALANCE,
        midtones: NO_BALANCE,
        highlights: NO_BALANCE,
        preserveLuminosity: true,
      };
    case 'blackWhite':
      // Photoshop's defaults.
      return { kind, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null };
    case 'photoFilter':
      // Warming Filter (85), Photoshop's default, at its default density.
      return { kind, color: [236 / 255, 138 / 255, 0], density: 25, preserveLuminosity: true };
    case 'colorLookup':
      return { kind, lutId: 'umbra:identity', name: 'Identity' };
    case 'selectiveColor':
      return {
        kind,
        relative: true,
        ranges: Object.fromEntries(SELECTIVE_RANGES.map((r) => [r, NO_CMYK_SHIFT])) as Record<SelectiveRange, CmykShift>,
      };
    case 'gradientMap':
      return {
        kind,
        gradient: {
          colorStops: [
            { at: 0, color: [0, 0, 0] },
            { at: 1, color: [1, 1, 1] },
          ],
          opacityStops: [
            { at: 0, opacity: 1 },
            { at: 1, opacity: 1 },
          ],
        },
        reverse: false,
      };
  }
}

// ---- compiled form --------------------------------------------------------------------

export interface LutApplier {
  shape: 'lut';
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

export interface PixelApplier {
  shape: 'pixel';
  /** In-place on a 3-element 0…1 RGB triple. */
  apply: (rgb: Float32Array) => void;
}

export type Applier = LutApplier | PixelApplier;

export function isNoOp(a: Applier): boolean {
  return a.shape === 'lut' && isIdentityLut(a.r) && isIdentityLut(a.g) && isIdentityLut(a.b);
}

/** Turn an adjustment's parameters into something that can be run over pixels. */
export function compile(adj: Adjustment): Applier {
  switch (adj.kind) {
    case 'brightnessContrast':
      return sameLut(brightnessContrastLut(adj.brightness, adj.contrast, adj.legacy));
    case 'levels': {
      // Photoshop applies the per-channel levels first, then the master. The order is
      // observable wherever both clip, and is tagged [fit] in spec 05 §A.
      const master = levelsLut(adj.master.inBlack, adj.master.gamma, adj.master.inWhite, adj.master.outBlack, adj.master.outWhite);
      const per = (c: LevelsChannel) => levelsLut(c.inBlack, c.gamma, c.inWhite, c.outBlack, c.outWhite);
      return {
        shape: 'lut',
        r: through(per(adj.r), master),
        g: through(per(adj.g), master),
        b: through(per(adj.b), master),
      };
    }
    case 'curves': {
      const master = curveToLut(adj.master);
      return {
        shape: 'lut',
        r: through(curveToLut(adj.r), master),
        g: through(curveToLut(adj.g), master),
        b: through(curveToLut(adj.b), master),
      };
    }
    case 'exposure':
      return sameLut(exposureLut(adj.exposure, adj.offset, adj.gamma));
    case 'invert': {
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) lut[i] = 255 - i;
      return sameLut(lut);
    }
    case 'posterize':
      return sameLut(posterizeLut(adj.levels));
    case 'threshold': {
      const t = adj.level;
      return {
        shape: 'pixel',
        apply: (rgb) => {
          // The epsilon makes the comparison robust to float error: on 8-bit input the
          // luminance is often EXACTLY an integer, and the GPU's float32 must agree with this.
          const v = luminance(rgb[0]!, rgb[1]!, rgb[2]!) * 255 + 1e-3 >= t ? 1 : 0;
          rgb[0] = v;
          rgb[1] = v;
          rgb[2] = v;
        },
      };
    }
    case 'desaturate':
      return {
        shape: 'pixel',
        apply: (rgb) => {
          // Photoshop's Desaturate is the HSL lightness, (max+min)/2 — NOT the luminance.
          const v = (Math.max(rgb[0]!, rgb[1]!, rgb[2]!) + Math.min(rgb[0]!, rgb[1]!, rgb[2]!)) / 2;
          rgb[0] = v;
          rgb[1] = v;
          rgb[2] = v;
        },
      };
    case 'channelMixer':
      return channelMixer(adj);
    case 'hueSaturation':
      return hueSaturation(adj);
    case 'vibrance':
      return vibrance(adj.vibrance, adj.saturation);
    case 'colorBalance':
      return colorBalance(adj);
    case 'blackWhite':
      return blackWhite(adj);
    case 'photoFilter':
      return photoFilter(adj.color, adj.density, adj.preserveLuminosity);
    case 'gradientMap':
      return gradientMap(adj.gradient, adj.reverse);
    case 'selectiveColor':
      return selectiveColor(adj);
    case 'colorLookup': {
      const lut = getLut(adj.lutId);
      if (!lut) return sameLut(identityLut());
      return { shape: 'pixel', apply: (rgb) => sampleLut(lut, rgb) };
    }
  }
}

function sameLut(lut: Uint8Array): LutApplier {
  return { shape: 'lut', r: lut, g: lut, b: lut };
}

/** `first` then `second`, as a single table. */
function through(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (isIdentityLut(second)) return first;
  if (isIdentityLut(first)) return second;
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = second[first[i]!]!;
  return out;
}

// ---- table-shaped adjustments ----------------------------------------------------------

/**
 * Brightness/Contrast.
 *
 * Legacy is **exact**, straight from spec 05 §A: add the brightness, then scale about 127.5.
 *
 * The modern version is `[fit]`. What defines it is that it does NOT clip: Photoshop's legacy
 * mode drives everything to 0 or 255 at ±100, and the modern one compresses instead. The
 * approximation here keeps that property exactly — brightness is a gamma curve, which lifts
 * shadows while pinning black and white, and contrast blends toward a smoothstep S, which
 * steepens the midtones without ever leaving the range. Both are monotone. The shape of
 * Photoshop's actual curve is unpublished; a HALD image put through it would settle this in
 * one pass.
 */
export function brightnessContrastLut(brightness: number, contrast: number, legacy: boolean): Uint8Array {
  const lut = new Uint8Array(256);
  if (legacy) {
    const k = contrast > 0 ? 100 / (100 - contrast) : (100 + contrast) / 100;
    for (let i = 0; i < 256; i++) {
      const v = i + brightness;
      lut[i] = clampByte(127.5 + (v - 127.5) * k);
    }
    return lut;
  }

  // Brightness as a gamma: 0 stays 0, 1 stays 1, and everything between lifts or drops.
  const invGamma = 1 / Math.pow(2, brightness / 150);
  // Contrast's two directions have different ranges in Photoshop (−50…100), so they are
  // normalised separately: +100 reaches a full smoothstep, −50 reaches half contrast.
  const up = contrast > 0 ? contrast / 100 : 0;
  const down = contrast < 0 ? -contrast / 50 : 0;

  for (let i = 0; i < 256; i++) {
    let v = Math.pow(i / 255, invGamma);
    if (up > 0) v += (v * v * (3 - 2 * v) - v) * up;
    if (down > 0) v += (0.5 + (v - 0.5) * 0.5 - v) * down;
    lut[i] = clampByte(v * 255);
  }
  return lut;
}

/**
 * Exposure — spec 05 §A, exact for 8- and 16-bit:
 * `lin = v^2.2; lin = max(0, lin·2^E + O); out = (lin^(1/2.2))^(1/G)`.
 */
export function exposureLut(exposure: number, offset: number, gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  const gain = Math.pow(2, exposure);
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < 256; i++) {
    const lin = Math.max(0, Math.pow(i / 255, 2.2) * gain + offset);
    lut[i] = clampByte(Math.pow(Math.pow(lin, 1 / 2.2), invGamma) * 255);
  }
  return lut;
}

/** Posterize — spec 05 §A, exact: `floor(v8·n/256)·255/(n−1)`. */
export function posterizeLut(levels: number): Uint8Array {
  const n = Math.max(2, Math.min(255, Math.round(levels)));
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = clampByte((Math.floor((i * n) / 256) * 255) / (n - 1));
  return lut;
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ---- pixel-shaped adjustments ----------------------------------------------------------

/** Channel Mixer — spec 05 §A, exact: a matrix of percentages plus a constant. */
function channelMixer(adj: Extract<Adjustment, { kind: 'channelMixer' }>): PixelApplier {
  // Monochrome drives every output from the red row, which is what the checkbox does: the
  // dialog swaps to a single set of sliders and writes them into all three outputs.
  const rows = adj.monochrome ? [adj.r, adj.r, adj.r] : [adj.r, adj.g, adj.b];
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const r = rgb[0]!;
      const g = rgb[1]!;
      const b = rgb[2]!;
      for (let i = 0; i < 3; i++) {
        const row = rows[i]!;
        rgb[i] = clamp01((row.r * r + row.g * g + row.b * b + row.constant) / 100);
      }
    },
  };
}

/** RGB → HSL with lightness as `(max+min)/2`, the space Photoshop's Hue/Saturation works in. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(hk + 1 / 3), channel(hk), channel(hk - 1 / 3)];
}

/**
 * Hue/Saturation — `[fit]`.
 *
 * Photoshop's own space is a variant of HSL whose exact response is not published. The model:
 *
 *  - every slider value is the master's plus each colour range's, weighted by how much the
 *    pixel's hue belongs to that range (its range bar: ramps across the fall-offs, 1 inside);
 *  - hue rotates; saturation SCALES (`s·(1 + v)`), so a grey stays grey at any setting and
 *    −100 is a neutral; lightness lerps toward white or black, last;
 *  - an achromatic pixel has no hue, so the colour ranges do not touch it.
 *
 * The multiplicative saturation replaces an earlier `s + (1 − s)·v`, which tinted greys red —
 * their hue reads as 0° — and pushed every faintly coloured pixel to full saturation at +100.
 */
function hueSaturation(adj: Extract<Adjustment, { kind: 'hueSaturation' }>): PixelApplier {
  const { master, colorize } = adj;
  const bands = adj.bands
    ? HUE_BANDS.map((n) => adj.bands![n]).filter((b) => b.hue !== 0 || b.saturation !== 0 || b.lightness !== 0)
    : [];
  return {
    shape: 'pixel',
    apply: (rgb) => {
      if (colorize) {
        // Colorize throws away the original hue and saturation, keeping only lightness.
        const l = rgbToHsl(rgb[0]!, rgb[1]!, rgb[2]!)[2];
        const lifted = applyLightness(l, adj.colorizeLightness);
        const [r, g, b] = hslToRgb(adj.colorizeHue, clamp01(adj.colorizeSaturation / 100), lifted);
        rgb[0] = r;
        rgb[1] = g;
        rgb[2] = b;
        return;
      }

      const [h, s, l] = rgbToHsl(rgb[0]!, rgb[1]!, rgb[2]!);
      let hue = master.hue;
      let sat = master.saturation;
      let light = master.lightness;
      if (s > 0) {
        for (const band of bands) {
          const w = hueBandWeight(h, band.range);
          if (w <= 0) continue;
          hue += w * band.hue;
          sat += w * band.saturation;
          light += w * band.lightness;
        }
      }
      const s2 = clamp01(s * (1 + Math.min(100, Math.max(-100, sat)) / 100));
      const l2 = applyLightness(l, Math.min(100, Math.max(-100, light)));
      const [r, g, b] = hslToRgb(h + hue, s2, l2);
      rgb[0] = r;
      rgb[1] = g;
      rgb[2] = b;
    },
  };
}

/** Lightness slider: a lerp toward black or white, so ±100 reaches them exactly. */
function applyLightness(l: number, amount: number): number {
  if (amount === 0) return l;
  return amount > 0 ? l + (1 - l) * (amount / 100) : l * (1 + amount / 100);
}

/**
 * Vibrance — `[fit]`.
 *
 * Photoshop's version boosts low-saturation pixels more than saturated ones and protects
 * skin hues; neither curve is published. This uses the model spec 05 §A records as the
 * starting point, `S' = S·(1 + k(1−S)^p)`, with the skin protection expressed as a reduced
 * weight across the orange hues. A HALD image through Photoshop would replace both the
 * exponent and the protection band with measured values.
 */
function vibrance(vibranceAmount: number, saturationAmount: number): PixelApplier {
  const k = vibranceAmount / 100;
  const sat = saturationAmount / 100;
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const [h, s, l] = rgbToHsl(rgb[0]!, rgb[1]!, rgb[2]!);
      // Skin sits roughly 20°…50°; the protection tapers rather than switching.
      const skin = Math.max(0, 1 - Math.abs(h - 35) / 35);
      const weight = (1 - s) * (1 - 0.5 * skin);
      let s2 = s * (1 + k * weight);
      // The plain Saturation slider on the same dialog scales, as Hue/Saturation's does, so
      // a grey stays grey.
      s2 = s2 * (1 + sat);
      const [r, g, b] = hslToRgb(h, clamp01(s2), l);
      rgb[0] = r;
      rgb[1] = g;
      rgb[2] = b;
    },
  };
}

/**
 * Color Balance — `[fit]`.
 *
 * The tonal weighting is the widely-reproduced model spec 05 §A points at: a shadow weight
 * and a highlight weight that are shifted Gaussians in the value, a midtone weight that is
 * what is left, and a 0.7 scale on the slider. Preserve Luminosity restores the original
 * luminance afterwards, which is the part that is certainly right — it is the same SetLum the
 * blend modes use.
 */
function colorBalance(adj: Extract<Adjustment, { kind: 'colorBalance' }>): PixelApplier {
  const a = 0.25;
  const b = 0.333;
  const scale = 0.7;

  const shift = (v: number, band: 'shadows' | 'midtones' | 'highlights'): number => {
    switch (band) {
      case 'shadows':
        return clamp01((v - b) / -a + 0.5);
      case 'highlights':
        return clamp01((v - (1 - b)) / a + 0.5);
      default:
        return clamp01((v - b) / a + 0.5) * clamp01((v + b - 1) / -a + 0.5);
    }
  };

  return {
    shape: 'pixel',
    apply: (rgb) => {
      const lumBefore = luminance(rgb[0]!, rgb[1]!, rgb[2]!);
      for (let i = 0; i < 3; i++) {
        const v = rgb[i]!;
        const slider = (band: ColorBalanceBand): number =>
          (i === 0 ? band.cyanRed : i === 1 ? band.magentaGreen : band.yellowBlue) / 100;
        const delta =
          shift(v, 'shadows') * slider(adj.shadows) +
          shift(v, 'midtones') * slider(adj.midtones) +
          shift(v, 'highlights') * slider(adj.highlights);
        rgb[i] = clamp01(v + delta * scale);
      }
      if (adj.preserveLuminosity) setLuminance(rgb, lumBefore);
    },
  };
}

/**
 * Restore a pixel's luminance after a colour shift, clipping back into gamut the same way the
 * non-separable blend modes do (spec 06 §4). Shared by Color Balance and Photo Filter.
 */
export function setLuminance(rgb: Float32Array, target: number): void {
  const d = target - luminance(rgb[0]!, rgb[1]!, rgb[2]!);
  rgb[0] = rgb[0]! + d;
  rgb[1] = rgb[1]! + d;
  rgb[2] = rgb[2]! + d;

  const lum = luminance(rgb[0]!, rgb[1]!, rgb[2]!);
  const min = Math.min(rgb[0]!, rgb[1]!, rgb[2]!);
  const max = Math.max(rgb[0]!, rgb[1]!, rgb[2]!);
  if (min < 0) {
    for (let i = 0; i < 3; i++) rgb[i] = lum + ((rgb[i]! - lum) * lum) / (lum - min);
  }
  if (max > 1) {
    for (let i = 0; i < 3; i++) rgb[i] = lum + ((rgb[i]! - lum) * (1 - lum)) / (max - lum);
  }
}

/**
 * Black & White — `[fit]` on the mixing rule, exact on the tint.
 *
 * Spec 05 §A records the rule as `grey = min + (mid−min)·w_secondary + (max−mid)·w_primary`,
 * where primary/secondary are decided by which channels are the max and mid. That reproduces
 * the defining property — the six sliders each control one hue family and 40/60/40/60/20/80
 * leaves a neutral image unchanged — but the exact blend between two adjacent families is not
 * published.
 */
function blackWhite(adj: Extract<Adjustment, { kind: 'blackWhite' }>): PixelApplier {
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const r = rgb[0]!;
      const g = rgb[1]!;
      const b = rgb[2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const mid = r + g + b - max - min;

      // Which hue family this pixel belongs to follows from which channel is the max and
      // which is the min: the primary is the max channel, the secondary the pair above min.
      let primary: number;
      let secondary: number;
      if (max === r) {
        primary = adj.reds / 100;
        secondary = min === b ? adj.yellows / 100 : adj.magentas / 100;
      } else if (max === g) {
        primary = adj.greens / 100;
        secondary = min === b ? adj.yellows / 100 : adj.cyans / 100;
      } else {
        primary = adj.blues / 100;
        secondary = min === r ? adj.cyans / 100 : adj.magentas / 100;
      }

      const grey = clamp01(min + (mid - min) * secondary + (max - mid) * primary);
      if (!adj.tint) {
        rgb[0] = grey;
        rgb[1] = grey;
        rgb[2] = grey;
        return;
      }
      // Tint is a colorize: the tint colour's hue and saturation at the grey's lightness.
      const [h, s] = rgbToHsl(adj.tint[0], adj.tint[1], adj.tint[2]);
      const [tr, tg, tb] = hslToRgb(h, s, grey);
      rgb[0] = tr;
      rgb[1] = tg;
      rgb[2] = tb;
    },
  };
}

/** Photo Filter — spec 05 §A: `mix(v, v·colour, density)`, then restore luminance. */
function photoFilter(
  color: [number, number, number],
  density: number,
  preserveLuminosity: boolean,
): PixelApplier {
  const d = clamp01(density / 100);
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const lumBefore = luminance(rgb[0]!, rgb[1]!, rgb[2]!);
      for (let i = 0; i < 3; i++) rgb[i] = rgb[i]! + (rgb[i]! * color[i]! - rgb[i]!) * d;
      if (preserveLuminosity) setLuminance(rgb, lumBefore);
      for (let i = 0; i < 3; i++) rgb[i] = clamp01(rgb[i]!);
    },
  };
}

/**
 * Selective Color — spec 05 §A, exact algorithm.
 *
 * This is the published reverse-engineering (pkh.me, and the FFmpeg `selectivecolor` filter
 * by the same author). A pixel belongs to a range by which channel is its max or min (Reds:
 * red is the max; Yellows: blue is the min, …) or by its brightness (Whites, Neutrals,
 * Blacks), and each range acts in proportion to a scale Ω of how strongly it belongs —
 * max−mid for the primaries, mid−min for the secondaries. Within a range the C, M and Y
 * sliders act on R, G and B respectively, with K acting on all three:
 *
 *   φ = clamp(((−1 − adj)·K − adj) · m, −v, 1 − v),   m = 1 (Absolute) or 1 − v (Relative)
 *
 * and the pixel moves by Σ φ·Ω. The one liberty taken: FFmpeg rounds each range's
 * contribution to an integer; here the sum is kept in float and rounded once, at the end.
 */
function selectiveColor(adj: Extract<Adjustment, { kind: 'selectiveColor' }>): PixelApplier {
  const rows = SELECTIVE_RANGES.map((r) => {
    const s = adj.ranges[r];
    return [s.c / 100, s.m / 100, s.y / 100, s.k / 100] as const;
  });
  const active = rows.map((r) => r.some((v) => v !== 0));
  const relative = adj.relative;
  const out = new Float32Array(3);
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const r = Math.round(clamp01(rgb[0]!) * 255);
      const g = Math.round(clamp01(rgb[1]!) * 255);
      const b = Math.round(clamp01(rgb[2]!) * 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const mid = r + g + b - max - min;
      const white = r > 128 && g > 128 && b > 128;
      const black = r < 128 && g < 128 && b < 128;
      const neutral = max > 0 && min < 255;
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      for (let i = 0; i < 9; i++) {
        if (!active[i]) continue;
        let member: boolean;
        let scale: number;
        switch (i) {
          case 0: member = r === max; scale = max - mid; break; // reds
          case 1: member = b === min; scale = mid - min; break; // yellows
          case 2: member = g === max; scale = max - mid; break; // greens
          case 3: member = r === min; scale = mid - min; break; // cyans
          case 4: member = b === max; scale = max - mid; break; // blues
          case 5: member = g === min; scale = mid - min; break; // magentas
          case 6: member = white; scale = 2 * min - 255; break;
          case 7: member = neutral; scale = (510 - (Math.abs(2 * max - 255) + Math.abs(2 * min - 255))) / 2; break;
          default: member = black; scale = 255 - 2 * max;
        }
        if (!member || scale <= 0) continue;
        const [c, m, y, k] = rows[i]!;
        for (let ch = 0; ch < 3; ch++) {
          const v = (ch === 0 ? r : ch === 1 ? g : b) / 255;
          const a = ch === 0 ? c : ch === 1 ? m : y;
          let res = (-1 - a) * k - a;
          if (relative) res *= 1 - v;
          out[ch] = out[ch]! + Math.min(1 - v, Math.max(-v, res)) * scale;
        }
      }
      rgb[0] = clamp01((r + out[0]!) / 255);
      rgb[1] = clamp01((g + out[1]!) / 255);
      rgb[2] = clamp01((b + out[2]!) / 255);
    },
  };
}

/** Gradient Map — spec 05 §A: the gradient sampled at the pixel's luminance. */
function gradientMap(gradient: Gradient, reverse: boolean): PixelApplier {
  // A 256-entry ramp: the gradient is sampled once per level rather than once per pixel.
  const ramp = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = reverse ? 1 - i / 255 : i / 255;
    const [r, g, b] = sampleGradient(gradient, t);
    ramp[i * 3] = r;
    ramp[i * 3 + 1] = g;
    ramp[i * 3 + 2] = b;
  }
  return {
    shape: 'pixel',
    apply: (rgb) => {
      const i = Math.round(clamp01(luminance(rgb[0]!, rgb[1]!, rgb[2]!)) * 255) * 3;
      rgb[0] = ramp[i]!;
      rgb[1] = ramp[i + 1]!;
      rgb[2] = ramp[i + 2]!;
    },
  };
}

// ---- running an adjustment over pixels ---------------------------------------------------

/**
 * Apply in place to straight-alpha RGBA8. Fully transparent pixels are skipped: their colour
 * is meaningless, and adjusting it would make the result depend on what happened to be left
 * behind in the erased area.
 */
export function applyToRgba8(applier: Applier, data: Uint8Array, mask?: Uint8Array, maskOffset = 0): void {
  const px = new Float32Array(3);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] === 0) continue;
    const coverage = mask ? mask[maskOffset + p]! / 255 : 1;
    if (coverage <= 0) continue;

    if (applier.shape === 'lut') {
      const r = applier.r[data[i]!]!;
      const g = applier.g[data[i + 1]!]!;
      const b = applier.b[data[i + 2]!]!;
      if (coverage >= 1) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      } else {
        data[i] = Math.round(data[i]! + (r - data[i]!) * coverage);
        data[i + 1] = Math.round(data[i + 1]! + (g - data[i + 1]!) * coverage);
        data[i + 2] = Math.round(data[i + 2]! + (b - data[i + 2]!) * coverage);
      }
      continue;
    }

    px[0] = data[i]! / 255;
    px[1] = data[i + 1]! / 255;
    px[2] = data[i + 2]! / 255;
    applier.apply(px);
    for (let c = 0; c < 3; c++) {
      const next = clamp01(px[c]!) * 255;
      data[i + c] = Math.round(coverage >= 1 ? next : data[i + c]! + (next - data[i + c]!) * coverage);
    }
  }
}

/**
 * An applier as a function on 0…1 colour, for the CPU reference compositor.
 *
 * The input is quantised to 8 bits first. Adjustments are defined on 8-bit values (the LUT
 * ones literally so), the GPU quantises the same way, and without it a backdrop that is
 * 127.9996/255 after blending would land either side of a Threshold or Posterize step
 * depending on which side of the diff it was computed.
 */
export function applierToRgbFn(applier: Applier): (c: readonly [number, number, number]) => [number, number, number] {
  const q = (v: number) => Math.round(clamp01(v) * 255);
  if (applier.shape === 'lut') {
    const { r, g, b } = applier;
    return (c) => [r[q(c[0])]! / 255, g[q(c[1])]! / 255, b[q(c[2])]! / 255];
  }
  const px = new Float32Array(3);
  return (c) => {
    px[0] = q(c[0]) / 255;
    px[1] = q(c[1]) / 255;
    px[2] = q(c[2]) / 255;
    applier.apply(px);
    return [clamp01(px[0]!), clamp01(px[1]!), clamp01(px[2]!)];
  };
}

/** Convenience for tests and previews: adjust one 0…255 RGB triple. */
export function applyToRgb(adj: Adjustment, r: number, g: number, b: number): [number, number, number] {
  const data = new Uint8Array([r, g, b, 255]);
  applyToRgba8(compile(adj), data);
  return [data[0]!, data[1]!, data[2]!];
}

export { identityLut };
