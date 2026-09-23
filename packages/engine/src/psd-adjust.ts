/**
 * Adjustment layers ↔ PSD (spec 07 §1, spec 05 §A "Layer" column).
 *
 * ag-psd decodes each adjustment block into a record; this maps those records to and from the
 * kernel's `Adjustment`. The decoded record is also kept on the layer (`psdExtra.adjustment`)
 * and used as the base when saving, so anything we do not model — Hue/Saturation's colour
 * ranges, preset names — survives a round trip as long as the layer is not a kind we lack.
 */
import type { AdjustmentLayer as AgAdjustment } from 'ag-psd';
import {
  defaultAdjustment,
  DEFAULT_LEVELS,
  SELECTIVE_RANGES,
  HUE_BANDS,
  DEFAULT_HUE_BAND_RANGES,
  defaultHueBands,
  type HueBandName,
  type CmykShift,
  type SelectiveRange,
  type Adjustment,
  type ChannelMixerOutput,
  type LevelsChannel,
} from '@umbra/kernels/adjust';
import type { CurvePoint } from '@umbra/kernels/curve';
import type { FillContent, PatternDef } from '@umbra/kernels/fill';
import type { GradientStyle } from '@umbra/kernels/gradient';

type Rgb = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Undo float32 storage noise: seven significant digits is all a float32 carries anyway. */
const f32 = (v: number) => Number(v.toPrecision(7));

// ---- colours -----------------------------------------------------------------------------

/** CIE Lab (D50, as Photoshop stores it) → sRGB 0…1, through a Bradford adaptation to D65. */
export function labToRgb(L: number, a: number, b: number): Rgb {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (116 * t - 16) / 903.3);
  // D50 white.
  const X = 0.96422 * inv(fx);
  const Y = 1.0 * (L > 8 ? fy ** 3 : L / 903.3);
  const Z = 0.82521 * inv(fz);
  // Bradford D50 → D65, then XYZ → linear sRGB.
  const x = 0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z;
  const y = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z;
  const z = 0.0122982 * X - 0.020483 * Y + 1.3299098 * Z;
  const lin: Rgb = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  return lin.map((c) => clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) as Rgb;
}

/**
 * Any of ag-psd's colour shapes → sRGB 0…1. The binary blocks and the descriptor blocks use
 * different scales for the same space (Lab L as 0…1 vs 0…100, HSB as fractions vs degrees
 * and percent), so the ranges are told apart by magnitude.
 */
export function colorFromPsd(c: unknown): Rgb {
  const o = (c ?? {}) as Record<string, number>;
  if ('fr' in o) return [clamp01(o.fr!), clamp01(o.fg!), clamp01(o.fb!)];
  if ('r' in o) return [clamp01(o.r! / 255), clamp01(o.g! / 255), clamp01(o.b! / 255)];
  if ('l' in o) {
    const binary = o.l! <= 1 && Math.abs(o.a!) <= 1 && Math.abs(o.b!) <= 1;
    return binary ? labToRgb(o.l! * 100, o.a! * 128, o.b! * 128) : labToRgb(o.l!, o.a!, o.b!);
  }
  if ('h' in o) {
    const fractional = o.s! <= 1 && o.b! <= 1 && o.h! <= 1;
    const h = fractional ? o.h! * 360 : o.h!;
    const s = fractional ? o.s! : o.s! / 100;
    const v = fractional ? o.b! : o.b! / 100;
    const f = (n: number) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }
  if ('c' in o) {
    const k = o.k! / 255;
    return [(1 - o.c! / 255) * (1 - k), (1 - o.m! / 255) * (1 - k), (1 - o.y! / 255) * (1 - k)];
  }
  if ('k' in o) {
    const v = 1 - o.k! / 255;
    return [v, v, v];
  }
  return [0, 0, 0];
}

const toPsdRgb = (c: readonly number[]) => ({
  r: Math.round(c[0]! * 255),
  g: Math.round(c[1]! * 255),
  b: Math.round(c[2]! * 255),
});

// ---- read --------------------------------------------------------------------------------

export interface PsdAdjustmentRead {
  adjustment: Adjustment;
  /** Parts of the record that do not render, for the post-open report. */
  lost: string[];
}

interface PsdLevels {
  shadowInput: number;
  highlightInput: number;
  shadowOutput: number;
  highlightOutput: number;
  midtoneInput: number;
}

const levelsFrom = (c: PsdLevels | undefined): LevelsChannel =>
  c
    ? {
        inBlack: c.shadowInput,
        inWhite: c.highlightInput,
        gamma: c.midtoneInput || 1,
        outBlack: c.shadowOutput,
        outWhite: c.highlightOutput,
      }
    : DEFAULT_LEVELS;

const curveFrom = (c: { input: number; output: number }[] | undefined): CurvePoint[] =>
  c && c.length >= 2 ? c.map((p) => ({ x: p.input / 255, y: p.output / 255 })) : [{ x: 0, y: 0 }, { x: 1, y: 1 }];

const mixerFrom = (c: { red: number; green: number; blue: number; constant: number } | undefined, fallback: ChannelMixerOutput): ChannelMixerOutput =>
  c ? { r: c.red, g: c.green, b: c.blue, constant: c.constant } : fallback;

/** Map ag-psd's record to an `Adjustment`, or null for a kind Umbra does not implement yet. */
export function fromPsdAdjustment(raw: unknown): PsdAdjustmentRead | null {
  const a = raw as AgAdjustment;
  const lost: string[] = [];
  switch (a.type) {
    case 'brightness/contrast':
      return { adjustment: { kind: 'brightnessContrast', brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, legacy: !!a.useLegacy }, lost };
    case 'levels':
      return { adjustment: { kind: 'levels', master: levelsFrom(a.rgb), r: levelsFrom(a.red), g: levelsFrom(a.green), b: levelsFrom(a.blue) }, lost };
    case 'curves':
      return { adjustment: { kind: 'curves', master: curveFrom(a.rgb), r: curveFrom(a.red), g: curveFrom(a.green), b: curveFrom(a.blue) }, lost };
    case 'exposure':
      // Stored as float32: 0.8 comes back as 0.800000011920929, which the dialog would show.
      return { adjustment: { kind: 'exposure', exposure: f32(a.exposure ?? 0), offset: f32(a.offset ?? 0), gamma: f32(a.gamma || 1) }, lost };
    case 'vibrance':
      return { adjustment: { kind: 'vibrance', vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 }, lost };
    case 'hue/saturation': {
      // ag-psd reads the block's colourise fields as the master "range" a…d: a is the
      // Colorize flag, b/c/d its hue, saturation and lightness.
      const m = a.master;
      const bands = defaultHueBands();
      let touched = false;
      for (const name of HUE_BANDS) {
        const r = a[name];
        if (!r) continue;
        bands[name] = { hue: r.hue ?? 0, saturation: r.saturation ?? 0, lightness: r.lightness ?? 0, range: [r.a, r.b, r.c, r.d] };
        const def = DEFAULT_HUE_BAND_RANGES[name];
        if (r.hue || r.saturation || r.lightness || [r.a, r.b, r.c, r.d].some((v, i) => v !== def[i])) touched = true;
      }
      return {
        adjustment: {
          kind: 'hueSaturation',
          master: { hue: m?.hue ?? 0, saturation: m?.saturation ?? 0, lightness: m?.lightness ?? 0 },
          // Untouched ranges read back as absent, which is what a new layer has.
          ...(touched ? { bands } : {}),
          colorize: !!m?.a,
          colorizeHue: (((m?.b ?? 0) % 360) + 360) % 360,
          colorizeSaturation: m?.a ? (m?.c ?? 25) : 25,
          colorizeLightness: m?.a ? (m?.d ?? 0) : 0,
        },
        lost,
      };
    }
    case 'color balance': {
      const band = (b: { cyanRed?: number; magentaGreen?: number; yellowBlue?: number } | undefined) => ({
        cyanRed: b?.cyanRed ?? 0,
        magentaGreen: b?.magentaGreen ?? 0,
        yellowBlue: b?.yellowBlue ?? 0,
      });
      return {
        adjustment: { kind: 'colorBalance', shadows: band(a.shadows), midtones: band(a.midtones), highlights: band(a.highlights), preserveLuminosity: a.preserveLuminosity ?? true },
        lost,
      };
    }
    case 'black & white':
      return {
        adjustment: {
          kind: 'blackWhite',
          reds: a.reds ?? 40,
          yellows: a.yellows ?? 60,
          greens: a.greens ?? 40,
          cyans: a.cyans ?? 60,
          blues: a.blues ?? 20,
          magentas: a.magentas ?? 80,
          tint: a.useTint ? colorFromPsd(a.tintColor) : null,
        },
        lost,
      };
    case 'photo filter':
      return {
        adjustment: { kind: 'photoFilter', color: colorFromPsd(a.color), density: a.density ?? 25, preserveLuminosity: a.preserveLuminosity ?? true },
        lost,
      };
    case 'channel mixer': {
      const d = defaultAdjustment('channelMixer') as Extract<Adjustment, { kind: 'channelMixer' }>;
      if (a.monochrome) {
        const grey = mixerFrom(a.gray, { r: 40, g: 40, b: 20, constant: 0 });
        return { adjustment: { kind: 'channelMixer', r: grey, g: grey, b: grey, monochrome: true }, lost };
      }
      return {
        adjustment: { kind: 'channelMixer', r: mixerFrom(a.red, d.r), g: mixerFrom(a.green, d.g), b: mixerFrom(a.blue, d.b), monochrome: false },
        lost,
      };
    }
    case 'invert':
      return { adjustment: { kind: 'invert' }, lost };
    case 'posterize':
      return { adjustment: { kind: 'posterize', levels: a.levels ?? 4 }, lost };
    case 'threshold':
      return { adjustment: { kind: 'threshold', level: a.level ?? 128 }, lost };
    case 'selective color': {
      const ranges = Object.fromEntries(
        SELECTIVE_RANGES.map((r) => {
          const v = (a as unknown as Record<string, Partial<CmykShift> | undefined>)[r];
          return [r, { c: v?.c ?? 0, m: v?.m ?? 0, y: v?.y ?? 0, k: v?.k ?? 0 }];
        }),
      ) as Record<SelectiveRange, CmykShift>;
      return { adjustment: { kind: 'selectiveColor', relative: a.mode !== 'absolute', ranges }, lost };
    }
    case 'gradient map': {
      if (a.gradientType === 'noise') return null;
      // A 50% midpoint is the plain linear blend, which is what an absent one means.
      const mid = (m: number | undefined) => (m === undefined || Math.abs(m - 0.5) < 1e-6 ? {} : { midpoint: m });
      const colorStops = (a.colorStops ?? []).map((s) => ({ at: s.location, color: colorFromPsd(s.color), ...mid(s.midpoint) }));
      const opacityStops = (a.opacityStops ?? []).map((s) => ({ at: s.location, opacity: s.opacity, ...mid(s.midpoint) }));
      if (colorStops.length === 0) return null;
      return {
        adjustment: {
          kind: 'gradientMap',
          gradient: {
            colorStops,
            opacityStops: opacityStops.length ? opacityStops : [{ at: 0, opacity: 1 }, { at: 1, opacity: 1 }],
            name: a.name,
          },
          reverse: !!a.reverse,
        },
        lost,
      };
    }
    default:
      return null;
  }
}

// ---- write -------------------------------------------------------------------------------

const levelsTo = (c: LevelsChannel): PsdLevels => ({
  shadowInput: Math.round(c.inBlack),
  highlightInput: Math.round(c.inWhite),
  shadowOutput: Math.round(c.outBlack),
  highlightOutput: Math.round(c.outWhite),
  midtoneInput: c.gamma,
});

const curveTo = (c: CurvePoint[]) => c.map((p) => ({ input: Math.round(p.x * 255), output: Math.round(p.y * 255) }));

const mixerTo = (c: ChannelMixerOutput) => ({ red: c.r, green: c.g, blue: c.b, constant: c.constant });

/**
 * `Adjustment` → ag-psd record. `source` is the record the layer was opened from, if any: it
 * is the base, so fields we do not model are written back as they were read.
 */
export function toPsdAdjustment(adj: Adjustment, source?: unknown): AgAdjustment {
  const base = (source ?? {}) as Record<string, unknown>;
  switch (adj.kind) {
    case 'brightnessContrast':
      return { ...base, type: 'brightness/contrast', brightness: adj.brightness, contrast: adj.contrast, useLegacy: adj.legacy } as AgAdjustment;
    case 'levels':
      return { ...base, type: 'levels', rgb: levelsTo(adj.master), red: levelsTo(adj.r), green: levelsTo(adj.g), blue: levelsTo(adj.b) } as AgAdjustment;
    case 'curves':
      return { ...base, type: 'curves', rgb: curveTo(adj.master), red: curveTo(adj.r), green: curveTo(adj.g), blue: curveTo(adj.b) } as AgAdjustment;
    case 'exposure':
      return { ...base, type: 'exposure', exposure: adj.exposure, offset: adj.offset, gamma: adj.gamma } as AgAdjustment;
    case 'vibrance':
      return { ...base, type: 'vibrance', vibrance: adj.vibrance, saturation: adj.saturation } as AgAdjustment;
    case 'hueSaturation': {
      const range = (name: HueBandName) => {
        const band = adj.bands?.[name];
        const [a, b, c, d] = band?.range ?? DEFAULT_HUE_BAND_RANGES[name];
        return {
          a: Math.round(a),
          b: Math.round(b),
          c: Math.round(c),
          d: Math.round(d),
          hue: Math.round(band?.hue ?? 0),
          saturation: Math.round(band?.saturation ?? 0),
          lightness: Math.round(band?.lightness ?? 0),
        };
      };
      return {
        ...base,
        type: 'hue/saturation',
        master: {
          a: adj.colorize ? 256 : 0,
          b: Math.round(adj.colorizeHue),
          c: Math.round(adj.colorizeSaturation),
          d: Math.round(adj.colorizeLightness),
          hue: Math.round(adj.master.hue),
          saturation: Math.round(adj.master.saturation),
          lightness: Math.round(adj.master.lightness),
        },
        reds: range('reds'),
        yellows: range('yellows'),
        greens: range('greens'),
        cyans: range('cyans'),
        blues: range('blues'),
        magentas: range('magentas'),
      } as unknown as AgAdjustment;
    }
    case 'colorBalance':
      return { ...base, type: 'color balance', shadows: adj.shadows, midtones: adj.midtones, highlights: adj.highlights, preserveLuminosity: adj.preserveLuminosity } as AgAdjustment;
    case 'blackWhite':
      return {
        ...base,
        type: 'black & white',
        reds: adj.reds,
        yellows: adj.yellows,
        greens: adj.greens,
        cyans: adj.cyans,
        blues: adj.blues,
        magentas: adj.magentas,
        useTint: !!adj.tint,
        tintColor: toPsdRgb(adj.tint ?? [225 / 255, 211 / 255, 179 / 255]),
      } as AgAdjustment;
    case 'photoFilter':
      return { ...base, type: 'photo filter', color: toPsdRgb(adj.color), density: adj.density, preserveLuminosity: adj.preserveLuminosity } as AgAdjustment;
    case 'channelMixer':
      return adj.monochrome
        ? ({ ...base, type: 'channel mixer', monochrome: true, gray: mixerTo(adj.r), red: mixerTo(adj.r), green: mixerTo(adj.r), blue: mixerTo(adj.r) } as AgAdjustment)
        : ({ ...base, type: 'channel mixer', monochrome: false, red: mixerTo(adj.r), green: mixerTo(adj.g), blue: mixerTo(adj.b), gray: { red: 40, green: 40, blue: 20, constant: 0 } } as AgAdjustment);
    case 'invert':
      return { ...base, type: 'invert' } as AgAdjustment;
    case 'posterize':
      return { ...base, type: 'posterize', levels: adj.levels } as AgAdjustment;
    case 'threshold':
      return { ...base, type: 'threshold', level: adj.level } as AgAdjustment;
    case 'gradientMap':
      return {
        ...base,
        type: 'gradient map',
        gradientType: 'solid',
        name: adj.gradient.name ?? 'Custom',
        reverse: adj.reverse,
        dither: false,
        smoothness: 1,
        colorStops: adj.gradient.colorStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, color: toPsdRgb(s.color) })),
        opacityStops: adj.gradient.opacityStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, opacity: s.opacity })),
      } as AgAdjustment;
    case 'selectiveColor':
      return {
        ...base,
        type: 'selective color',
        mode: adj.relative ? 'relative' : 'absolute',
        ...Object.fromEntries(SELECTIVE_RANGES.map((r) => [r, { ...adj.ranges[r] }])),
      } as AgAdjustment;
    case 'desaturate':
      // Not a layer kind in Photoshop; the closest layer is a Hue/Saturation at −100.
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: -100, lightness: 0 } } as AgAdjustment;
  }
}

// ---- fill layers ---------------------------------------------------------------------------

/**
 * ag-psd's `vectorFill` → `FillContent`. Patterns are resolved against the file's own pattern
 * table; a pattern the file refers to but does not contain comes back as null (with a note).
 * Noise gradients are not modelled.
 */
export function fromPsdFill(
  raw: unknown,
  patterns: readonly PatternDef[],
): { content: FillContent; lost: string[] } | null {
  const v = raw as Record<string, unknown> & { type: string };
  const lost: string[] = [];
  if (v.type === 'color') return { content: { type: 'solid', color: colorFromPsd(v.color) }, lost };
  if (v.type === 'solid') {
    const g = v as unknown as {
      name?: string;
      colorStops: { color: unknown; location: number; midpoint: number }[];
      opacityStops: { opacity: number; location: number; midpoint: number }[];
      style?: GradientStyle;
      angle?: number;
      scale?: number;
      reverse?: boolean;
      offset?: { x: number; y: number };
    };
    const mid = (m: number | undefined) => (m === undefined || Math.abs(m - 0.5) < 1e-6 ? {} : { midpoint: m });
    return {
      content: {
        type: 'gradient',
        gradient: {
          name: g.name,
          colorStops: g.colorStops.map((s) => ({ at: s.location, color: colorFromPsd(s.color), ...mid(s.midpoint) })),
          opacityStops: g.opacityStops.map((s) => ({ at: s.location, opacity: s.opacity, ...mid(s.midpoint) })),
        },
        style: g.style ?? 'linear',
        angle: g.angle ?? 90,
        scale: Math.round((g.scale ?? 1) * 100),
        reverse: !!g.reverse,
        offset: { x: Math.round((g.offset?.x ?? 0) * 100), y: Math.round((g.offset?.y ?? 0) * 100) },
      },
      lost,
    };
  }
  if (v.type === 'pattern') {
    const pattern = patterns.find((p) => p.id === v.id);
    if (!pattern) return null;
    const phase = (v.phase as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    return { content: { type: 'pattern', pattern, scale: 100, phase }, lost };
  }
  return null;
}

/** `FillContent` → ag-psd `vectorFill`, over the record the layer was opened from, if any. */
export function toPsdFill(content: FillContent, source?: unknown): Record<string, unknown> {
  const base = (source ?? {}) as Record<string, unknown>;
  switch (content.type) {
    case 'solid':
      return { type: 'color', color: toPsdRgb(content.color) };
    case 'gradient':
      return {
        ...(base.type === 'solid' ? base : {}),
        type: 'solid',
        name: content.gradient.name ?? 'Custom',
        colorStops: content.gradient.colorStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, color: toPsdRgb(s.color) })),
        opacityStops: content.gradient.opacityStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, opacity: s.opacity })),
        style: content.style,
        angle: content.angle,
        scale: content.scale / 100,
        reverse: content.reverse,
        align: true,
        offset: { x: content.offset.x / 100, y: content.offset.y / 100 },
      };
    case 'pattern':
      return {
        ...(base.type === 'pattern' ? base : {}),
        type: 'pattern',
        name: content.pattern.name,
        id: content.pattern.id,
        phase: content.phase,
      };
  }
}
