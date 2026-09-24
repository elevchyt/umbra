/**
 * Photoshop brush libraries (.abr) — spec 07: read v1, v2 and v6–v10; write v6.2.
 *
 * v6+ is ag-psd's reader ('samp' sampled tips, 'patt' patterns, 'desc' the presets with every
 * dynamic); v1/v2 (Photoshop 5–6) is read here: a flat list of computed and sampled tips, no
 * dynamics. Writing is the exact inverse of ag-psd's reader — sampled tips raw, 8-bit — with
 * the descriptor written by our typed writer, since the brush keys are not in ag-psd's table.
 */
import { readAbr as agReadAbr } from 'ag-psd/dist/abr';
import { createWriter, getWriterBuffer, writePattern } from 'ag-psd/dist/psdWriter';
import type { PatternDef } from '@umbra/kernels/fill';
import {
  DEFAULT_BRUSH,
  NO_DYNAMIC,
  type BrushParams,
  type BrushPreset,
  type ControlSource,
  type DualMode,
  type Dynamic,
  type TextureMode,
  type TipBitmap,
  BRISTLE_SHAPES,
  ERODIBLE_SHAPES,
  type AirbrushTip,
  type BristleTip,
  type ErodibleTip,
} from '@umbra/kernels/brush';
import { ByteWriter, ang, bool, doub, dvFromParsed, en, list, long, obj, pct, px, text, writeDescriptor, type DV } from './descriptor-writer.js';

export interface AbrContents {
  presets: BrushPreset[];
  tips: Map<string, TipBitmap>;
  patterns: PatternDef[];
  /** What could not be read, per brush. */
  lost: string[];
}

// ---- v6+ through ag-psd --------------------------------------------------------------------

type AgDynamics = { control: string; steps: number; jitter: number; minimum: number };
type AgShape = {
  type: string;
  size: number;
  angle: number;
  roundness?: number;
  hardness?: number;
  spacing: number;
  spacingOn: boolean;
  flipX: boolean;
  flipY: boolean;
  name?: string;
  sampledData?: string;
  // Bristle ('dynamic'); ag-psd reads these a hundred times too small (Photoshop stores 0.31 %Prc for 31 %).
  shape?: string;
  density?: number;
  length?: number;
  clumping?: number;
  thickness?: number;
  stiffness?: number;
  // Erodible and airbrush ('tips').
  tipsType?: string;
  tipsHardness?: number;
  tipsAirbrushCutoffAngle?: number;
  tipsAirbrushGranularity?: number;
  tipsAirbrushSplatSize?: number;
  tipsAirbrushSplatCount?: number;
};

/** ag-psd's names for the descriptor's 'Shp ' index (bristle shapes; erodible shapes by index). */
const AG_SHAPES = ['round point', 'round blunt', 'round curve', 'round angle', 'round fan', 'flat point', 'flat blunt', 'flat curve', 'flat angle', 'flat fan'];
/** Six decimals: percentages survive a write and read unchanged. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

const CONTROL_FROM: Record<string, ControlSource> = {
  off: 'off',
  fade: 'fade',
  'pen pressure': 'pressure',
  'pen tilt': 'tilt',
  'stylus wheel': 'wheel',
  'initial direction': 'initialDirection',
  direction: 'direction',
  'initial rotation': 'rotation',
  rotation: 'rotation',
};
const CONTROL_INDEX: Record<ControlSource, number> = { off: 0, fade: 1, pressure: 2, tilt: 3, wheel: 4, initialDirection: 5, direction: 6, rotation: 8 };

const dyn = (d: AgDynamics | undefined): Dynamic =>
  d ? { control: CONTROL_FROM[d.control] ?? 'off', fadeSteps: d.steps || 25, jitter: d.jitter ?? 0, minimum: d.minimum ?? 0 } : NO_DYNAMIC;

/** ag-psd's blend-mode names ('color burn') → ours ('colorBurn'). */
const camel = (m: string) => m.replace(/ (\w)/g, (_, c: string) => c.toUpperCase());
const DUAL_OK: DualMode[] = ['multiply', 'darken', 'overlay', 'colorDodge', 'colorBurn', 'linearBurn', 'hardMix', 'linearHeight'];
const TEXTURE_OK: TextureMode[] = ['multiply', 'subtract', 'darken', 'overlay', 'colorDodge', 'colorBurn', 'linearBurn', 'hardMix', 'linearHeight', 'height'];

function shapeParams(shape: AgShape, tipPrefix: string): Partial<BrushParams> & { size: number } {
  const base: Partial<BrushParams> & { size: number } = {
    size: Math.max(1, shape.size),
    angle: shape.angle ?? 0,
    roundness: shape.roundness ?? 1,
    spacing: shape.spacing ?? 0.25,
    flipX: !!shape.flipX,
    flipY: !!shape.flipY,
  };
  if (shape.type === 'sampled' && shape.sampledData) return { ...base, hardness: 1, tip: { kind: 'sampled', id: tipPrefix + shape.sampledData } };
  if (shape.type === 'dynamic') {
    const tip: BristleTip = {
      kind: 'bristle',
      shape: BRISTLE_SHAPES[Math.max(0, AG_SHAPES.indexOf(shape.shape ?? ''))]!,
      bristles: r6((shape.density ?? 0.0035) * 100),
      length: r6((shape.length ?? 0.0125) * 100),
      thickness: r6((shape.thickness ?? 0.0002) * 100),
      stiffness: r6((shape.stiffness ?? 0.0075) * 100),
      clumping: r6((shape.clumping ?? 0.0025) * 100),
    };
    return { ...base, hardness: 1, tip };
  }
  if (shape.type === 'tips') {
    // ag-psd calls the descriptor's tip type 1 'erodible flat'; it is Photoshop's Airbrush.
    if (shape.tipsType === 'erodible flat') {
      const tip: AirbrushTip = {
        kind: 'airbrush',
        hardness: r6(shape.tipsHardness ?? 0.01),
        cutoffAngle: shape.tipsAirbrushCutoffAngle ?? 15,
        granularity: r6(shape.tipsAirbrushGranularity ?? 0),
        spatterSize: r6(shape.tipsAirbrushSplatSize ?? 0.01),
        spatterAmount: shape.tipsAirbrushSplatCount ?? 100,
      };
      return { ...base, hardness: 1, tip };
    }
    const tip: ErodibleTip = { kind: 'erodible', shape: ERODIBLE_SHAPES[Math.max(0, Math.min(4, AG_SHAPES.indexOf(shape.shape ?? '')))]!, hardness: r6(shape.tipsHardness ?? 0.5) };
    return { ...base, hardness: 1, tip };
  }
  return { ...base, hardness: shape.hardness ?? 1, tip: { kind: 'computed' } };
}

/**
 * Adobe's own presets name themselves by localisation key: `$$$/Presets/Brushes/Pencil=Pencil`.
 * The text after `=` is the English name.
 */
export function displayName(name: string): string {
  return name.startsWith('$$$/') && name.includes('=') ? name.slice(name.indexOf('=') + 1) : name;
}

function fromAgBrush(b: Record<string, unknown>, tipPrefix: string, lost: string[]): BrushPreset {
  const br = b as {
    name: string;
    shape: AgShape;
    shapeDynamics?: { sizeDynamics: AgDynamics; minimumDiameter: number; tiltScale: number; angleDynamics: AgDynamics; roundnessDynamics: AgDynamics; minimumRoundness: number; flipX: boolean; flipY: boolean };
    scatter?: { bothAxes: boolean; scatterDynamics: AgDynamics; countDynamics: AgDynamics; count: number };
    texture?: { id: string; invert: boolean; scale: number; brightness: number; contrast: number; blendMode: string; depth: number; depthMinimum: number; depthDynamics: AgDynamics; textureEachTip: boolean };
    dualBrush?: { flip: boolean; shape: AgShape; blendMode: string; spacing: number; count: number; bothAxes: boolean; scatterDynamics: AgDynamics };
    colorDynamics?: { foregroundBackground: AgDynamics; hue: number; saturation: number; brightness: number; purity: number; perTip: boolean };
    transfer?: { flowDynamics: AgDynamics; opacityDynamics: AgDynamics };
    brushPose?: { overrideAngle: boolean; overrideTiltX: boolean; overrideTiltY: boolean; overridePressure: boolean; pressure: number; tiltX: number; tiltY: number; angle: number };
    noise: boolean;
    wetEdges: boolean;
    protectTexture?: boolean;
    toolOptions?: { flow: number; opacity: number; smoothing: boolean; smoothingValue: number; smoothingRadiusMode: boolean; smoothingCatchup: boolean; smoothingCatchupAtEnd: boolean; smoothingZoomCompensation: boolean; usePressureOverridesSize: boolean; usePressureOverridesOpacity: boolean };
  };
  const name = displayName(br.name);
  const p: Partial<BrushParams> & { size: number } = shapeParams(br.shape, tipPrefix);
  const sd = br.shapeDynamics;
  if (sd)
    p.shapeDynamics = {
      enabled: true,
      size: dyn(sd.sizeDynamics),
      minDiameter: sd.minimumDiameter ?? 0,
      tiltScale: sd.tiltScale ?? 0,
      angle: dyn(sd.angleDynamics),
      roundness: dyn(sd.roundnessDynamics),
      minRoundness: sd.minimumRoundness ?? 0.25,
      flipXJitter: !!sd.flipX,
      flipYJitter: !!sd.flipY,
    };
  const sc = br.scatter;
  if (sc) p.scattering = { enabled: true, scatter: dyn(sc.scatterDynamics), bothAxes: !!sc.bothAxes, count: Math.max(1, sc.count ?? 1), countJitter: dyn(sc.countDynamics) };
  const tx = br.texture;
  if (tx) {
    const mode = camel(tx.blendMode ?? 'multiply') as TextureMode;
    p.texture = {
      enabled: true,
      patternId: tx.id,
      invert: !!tx.invert,
      scale: (tx.scale ?? 1) * 100,
      brightness: tx.brightness ?? 0,
      contrast: tx.contrast ?? 0,
      mode: TEXTURE_OK.includes(mode) ? mode : mode === ('subtraction' as TextureMode) ? 'subtract' : 'multiply',
      depth: tx.depth ?? 1,
      minDepth: tx.depthMinimum ?? 0,
      depthJitter: dyn(tx.depthDynamics),
      eachTip: !!tx.textureEachTip,
    };
  }
  const db = br.dualBrush;
  if (db) {
    const s = shapeParams(db.shape, tipPrefix);
    const mode = camel(db.blendMode ?? 'color burn') as DualMode;
    p.dual = {
      enabled: true,
      tip: s.tip!,
      size: s.size,
      hardness: s.hardness ?? 1,
      spacing: db.spacing ?? 0.25,
      scatter: db.scatterDynamics?.jitter ?? 0,
      bothAxes: !!db.bothAxes,
      count: Math.max(1, db.count ?? 1),
      mode: DUAL_OK.includes(mode) ? mode : 'colorBurn',
      flip: !!db.flip,
    };
  }
  const cd = br.colorDynamics;
  if (cd) p.colorDynamics = { enabled: true, eachTip: !!cd.perTip, fgBg: dyn(cd.foregroundBackground), hue: cd.hue ?? 0, saturation: cd.saturation ?? 0, brightness: cd.brightness ?? 0, purity: cd.purity ?? 0 };
  const tr = br.transfer;
  if (tr) p.transfer = { enabled: true, opacity: dyn(tr.opacityDynamics), flow: dyn(tr.flowDynamics) };
  const po = br.brushPose;
  if (po) p.pose = { enabled: true, tiltX: po.tiltX ?? 0, tiltY: po.tiltY ?? 0, rotation: po.angle ?? 0, pressure: po.pressure ?? 1, overrideTilt: !!(po.overrideTiltX || po.overrideTiltY), overrideRotation: !!po.overrideAngle, overridePressure: !!po.overridePressure };
  if (br.noise) p.noise = true;
  if (br.wetEdges) p.wetEdges = true;
  if (br.protectTexture) p.protectTexture = true;
  const to = br.toolOptions;
  if (to) {
    p.opacity = (to.opacity ?? 100) / 100;
    p.flow = (to.flow ?? 100) / 100;
    p.smoothing = to.smoothing ? (to.smoothingValue ?? 0) / 100 : 0;
    p.smoothingOptions = { pulledString: !!to.smoothingRadiusMode, catchUp: !!to.smoothingCatchup, catchUpOnEnd: !!to.smoothingCatchupAtEnd, adjustForZoom: to.smoothingZoomCompensation !== false };
    p.pressureSize = !!to.usePressureOverridesSize;
    p.pressureOpacity = !!to.usePressureOverridesOpacity;
  }
  return { id: `abr:${tipPrefix}${br.name}`, name, params: p };
}

// ---- v1 and v2 ---------------------------------------------------------------------------

function unpackBits(dv: DataView, at: number, end: number, out: Uint8Array, o: number, n: number): number {
  let i = at;
  let k = 0;
  while (k < n && i < end) {
    const c = dv.getInt8(i++);
    if (c >= 0) {
      for (let j = 0; j <= c && k < n; j++) out[o + k++] = dv.getUint8(i++);
    } else if (c !== -128) {
      const v = dv.getUint8(i++);
      for (let j = 0; j < 1 - c && k < n; j++) out[o + k++] = v;
    }
  }
  return i;
}

function readAbrOld(bytes: Uint8Array, name: string): AbrContents {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getInt16(0);
  const count = dv.getInt16(2);
  let o = 4;
  const presets: BrushPreset[] = [];
  const tips = new Map<string, TipBitmap>();
  const lost: string[] = [];
  for (let n = 0; n < count && o + 6 <= bytes.length; n++) {
    const type = dv.getInt16(o);
    const size = dv.getInt32(o + 2);
    const start = o + 6;
    const end = start + size;
    o = end;
    let p = start + 4; // misc
    const spacing = dv.getInt16(p) / 100;
    p += 2;
    if (type === 1) {
      const diameter = dv.getInt16(p);
      const roundness = dv.getInt16(p + 2) / 100;
      const angle = dv.getInt16(p + 4);
      const hardness = dv.getInt16(p + 6) / 100;
      presets.push({ id: `abr:${name}:${n}`, name: `Brush ${n + 1}`, params: { size: Math.max(1, diameter), spacing: Math.max(0.01, spacing), roundness: Math.max(0.01, roundness), angle, hardness, tip: { kind: 'computed' } } });
      continue;
    }
    if (type !== 2) continue;
    let brushName = `Sampled Brush ${n + 1}`;
    if (version === 2) {
      const len = dv.getUint32(p);
      p += 4;
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(p + i * 2));
      p += len * 2;
      brushName = s.replace(/\0+$/, '') || brushName;
    }
    p += 1; // anti-aliasing
    p += 8; // short bounds
    const top = dv.getInt32(p);
    const left = dv.getInt32(p + 4);
    const bottom = dv.getInt32(p + 8);
    const right = dv.getInt32(p + 12);
    p += 16;
    const depth = dv.getInt16(p);
    const compression = dv.getUint8(p + 2);
    p += 3;
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0 || w > 8192 || h > 8192) {
      lost.push(`${brushName}: unreadable bounds`);
      continue;
    }
    const data = new Uint8Array(w * h);
    if (depth === 8 && compression === 0) data.set(bytes.subarray(p, p + w * h));
    else if (depth === 8 && compression === 1) {
      let q = p + h * 2;
      for (let y = 0; y < h; y++) {
        const rowLen = dv.getUint16(p + y * 2);
        unpackBits(dv, q, q + rowLen, data, y * w, w);
        q += rowLen;
      }
    } else if (depth === 16 && compression === 0) for (let i = 0; i < w * h; i++) data[i] = dv.getUint16(p + i * 2) >> 8;
    else {
      lost.push(`${brushName}: ${depth}-bit compressed tip`);
      continue;
    }
    const id = `abr:${name}:${n}`;
    tips.set(id, { width: w, height: h, data });
    presets.push({ id, name: brushName, params: { size: Math.max(w, h), spacing: Math.max(0.01, spacing), hardness: 1, tip: { kind: 'sampled', id } } });
  }
  return { presets, tips, patterns: [], lost };
}

/** Read an .abr file. `name` keeps its tips' ids apart from other files'. */
export function readAbrFile(bytes: Uint8Array, name: string): AbrContents {
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(0);
  if (version === 1 || version === 2) return readAbrOld(bytes, name);
  const abr = agReadAbr(bytes) as unknown as {
    brushes: Record<string, unknown>[];
    samples: { id: string; bounds: { w: number; h: number }; alpha: Uint8Array }[];
    patterns: { id: string; name: string; bounds: { w: number; h: number }; data: Uint8Array }[];
  };
  const prefix = `${name}:`;
  const tips = new Map<string, TipBitmap>();
  for (const s of abr.samples) tips.set(prefix + s.id, { width: s.bounds.w, height: s.bounds.h, data: s.alpha });
  const lost: string[] = [];
  const presets = abr.brushes.map((b) => fromAgBrush(b, prefix, lost));
  const patterns = abr.patterns.map((p) => ({ id: p.id, name: p.name, width: p.bounds.w, height: p.bounds.h, data: p.data }));
  return { presets, tips, patterns, lost };
}

// ---- writing v6.2 --------------------------------------------------------------------------

const MODE_CODE: Record<string, string> = {
  multiply: 'Mltp',
  darken: 'Drkn',
  overlay: 'Ovrl',
  colorDodge: 'CDdg',
  colorBurn: 'CBrn',
  linearBurn: 'linearBurn',
  hardMix: 'hardMix',
  linearHeight: 'linearHeight',
  height: 'Hght',
  subtract: 'Sbtr',
};

const dynDV = (d: Dynamic): DV => obj('brVr', [
  ['bVTy', long(CONTROL_INDEX[d.control])],
  ['fStp', long(Math.round(d.fadeSteps))],
  ['jitter', pct(d.jitter * 100)],
  ['Mnm ', pct(d.minimum * 100)],
]);

function shapeDV(p: { size: number; angle?: number; roundness?: number; hardness?: number; spacing?: number; flipX?: boolean; flipY?: boolean; tip?: BrushParams['tip'] }, tipName: (id: string) => string): DV {
  const common: [string, DV][] = [
    ['Dmtr', px(p.size)],
    ['Angl', ang(p.angle ?? 0)],
    ['Rndn', pct((p.roundness ?? 1) * 100)],
    ['Spcn', pct((p.spacing ?? 0.25) * 100)],
    ['Intr', bool(true)],
    ['flipX', bool(!!p.flipX)],
    ['flipY', bool(!!p.flipY)],
  ];
  if (p.tip?.kind === 'sampled') return obj('sampledBrush', [...common, ['Nm  ', text(tipName(p.tip.id))], ['sampledData', text(p.tip.id)]]);
  if (p.tip?.kind === 'bristle') {
    const t = p.tip;
    return obj('dBrush', [
      ...common,
      ['Shp ', long(BRISTLE_SHAPES.indexOf(t.shape))],
      // Photoshop's own scale: the fraction, tagged as a percentage.
      ['Dnst', pct(t.bristles)],
      ['Lngt', pct(t.length)],
      ['clumping', pct(t.clumping)],
      ['thickness', pct(t.thickness)],
      ['stiffness', pct(t.stiffness)],
      ['physics', bool(true)],
    ]);
  }
  if (p.tip?.kind === 'erodible' || p.tip?.kind === 'airbrush') {
    const t = p.tip;
    const air = t.kind === 'airbrush' ? t : null;
    return obj('dTips', [
      ...common,
      ['Shp ', long(t.kind === 'erodible' ? ERODIBLE_SHAPES.indexOf(t.shape) : 5)],
      ['physics', bool(true)],
      ['dtipsType', long(air ? 1 : 0)],
      ['dtipsLengthRatio', pct(100)],
      ['dtipsHardness', pct(t.hardness * 100)],
      ['dtipsAirbrushCutoffAngle', doub(air?.cutoffAngle ?? 15)],
      ['dtipsAirbrushGranularity', pct((air?.granularity ?? 0) * 100)],
      ['dtipsAirbrushStreakiness', pct(1)],
      ['dtipsAirbrushSplatSize', pct((air?.spatterSize ?? 0.01) * 100)],
      ['dtipsAirbrushSplatCount', long(air?.spatterAmount ?? 100)],
    ]);
  }
  return obj('computedBrush', [...common, ['Hrdn', pct((p.hardness ?? 1) * 100)]]);
}

function presetDV(pr: BrushPreset, tipName: (id: string) => string): DV {
  return obj('brushPreset', brushPresetItems(pr, tipName));
}

/** A brush preset's descriptor items (its name, tip, every section and its tool options). */
export function brushPresetItems(pr: BrushPreset, tipName: (id: string) => string): [string, DV][] {
  const p = { ...DEFAULT_BRUSH, ...pr.params };
  const items: [string, DV][] = [
    ['Nm  ', text(pr.name)],
    ['Brsh', shapeDV(p, tipName)],
    ['useTipDynamics', bool(!!p.shapeDynamics?.enabled)],
    ['flipX', bool(!!p.shapeDynamics?.flipXJitter)],
    ['flipY', bool(!!p.shapeDynamics?.flipYJitter)],
    ['brushProjection', bool(false)],
    ['minimumDiameter', pct((p.shapeDynamics?.minDiameter ?? 0) * 100)],
    ['minimumRoundness', pct((p.shapeDynamics?.minRoundness ?? 0.25) * 100)],
    ['tiltScale', pct((p.shapeDynamics?.tiltScale ?? 0) * 100)],
    ['szVr', dynDV(p.shapeDynamics?.size ?? NO_DYNAMIC)],
    ['angleDynamics', dynDV(p.shapeDynamics?.angle ?? NO_DYNAMIC)],
    ['roundnessDynamics', dynDV(p.shapeDynamics?.roundness ?? NO_DYNAMIC)],
    ['useScatter', bool(!!p.scattering?.enabled)],
    ['Spcn', pct(p.spacing * 100)],
    ['Cnt ', long(p.scattering?.count ?? 1)],
    ['bothAxes', bool(!!p.scattering?.bothAxes)],
    ['countDynamics', dynDV(p.scattering?.countJitter ?? NO_DYNAMIC)],
    ['scatterDynamics', dynDV(p.scattering?.scatter ?? NO_DYNAMIC)],
    ['useColorDynamics', bool(!!p.colorDynamics?.enabled)],
    ['clVr', dynDV(p.colorDynamics?.fgBg ?? NO_DYNAMIC)],
    ['H   ', pct((p.colorDynamics?.hue ?? 0) * 100)],
    ['Strt', pct((p.colorDynamics?.saturation ?? 0) * 100)],
    ['Brgh', pct((p.colorDynamics?.brightness ?? 0) * 100)],
    ['purity', pct((p.colorDynamics?.purity ?? 0) * 100)],
    ['colorDynamicsPerTip', bool(p.colorDynamics?.eachTip ?? true)],
    ['Wtdg', bool(!!p.wetEdges)],
    ['Nose', bool(!!p.noise)],
    ['Rpt ', bool(false)],
    ['useBrushSize', bool(true)],
    ['protectTexture', bool(!!p.protectTexture)],
    ['usePaintDynamics', bool(!!p.transfer?.enabled)],
    ['prVr', dynDV(p.transfer?.flow ?? NO_DYNAMIC)],
    ['opVr', dynDV(p.transfer?.opacity ?? NO_DYNAMIC)],
    ['wtVr', dynDV(NO_DYNAMIC)],
    ['mxVr', dynDV(NO_DYNAMIC)],
    ['useBrushPose', bool(!!p.pose?.enabled)],
    ['overridePoseAngle', bool(!!p.pose?.overrideRotation)],
    ['overridePoseTiltX', bool(!!p.pose?.overrideTilt)],
    ['overridePoseTiltY', bool(!!p.pose?.overrideTilt)],
    ['overridePosePressure', bool(!!p.pose?.overridePressure)],
    ['brushPosePressure', pct((p.pose?.pressure ?? 1) * 100)],
    ['brushPoseTiltX', doub(p.pose?.tiltX ?? 0)],
    ['brushPoseTiltY', doub(p.pose?.tiltY ?? 0)],
    ['brushPoseAngle', doub(p.pose?.rotation ?? 0)],
  ];
  const t = p.texture;
  items.push(['useTexture', bool(!!t?.enabled)]);
  if (t?.enabled) {
    items.push(
      ['Txtr', obj('Ptrn', [['Nm  ', text(t.patternId)], ['Idnt', text(t.patternId)]])],
      ['textureBlendMode', en('BlnM', MODE_CODE[t.mode] ?? 'Mltp')],
      ['textureDepth', pct(t.depth * 100)],
      ['minimumDepth', pct(t.minDepth * 100)],
      ['textureDepthDynamics', dynDV(t.depthJitter)],
      ['textureScale', pct(t.scale)],
      ['InvT', bool(t.invert)],
      ['textureBrightness', long(Math.round(t.brightness))],
      ['textureContrast', long(Math.round(t.contrast))],
      ['TxtC', bool(t.eachTip)],
    );
  }
  const d = p.dual;
  if (d?.enabled) {
    items.push([
      'dualBrush',
      obj('dualBrush', [
        ['useDualBrush', bool(true)],
        ['Flip', bool(d.flip)],
        ['Brsh', shapeDV({ size: d.size, hardness: d.hardness, spacing: d.spacing, tip: d.tip }, tipName)],
        ['BlnM', en('BlnM', MODE_CODE[d.mode] ?? 'CBrn')],
        ['useScatter', bool(d.scatter > 0)],
        ['Spcn', pct(d.spacing * 100)],
        ['Cnt ', long(d.count)],
        ['bothAxes', bool(d.bothAxes)],
        ['countDynamics', dynDV(NO_DYNAMIC)],
        ['scatterDynamics', dynDV({ ...NO_DYNAMIC, jitter: d.scatter })],
      ]),
    ]);
  }
  // Tool options only when the preset has them: a tip-only preset leaves the tool's own.
  const hasToolOptions = ['flow', 'opacity', 'smoothing', 'smoothingOptions', 'pressureSize', 'pressureOpacity'].some((k) => k in pr.params);
  if (hasToolOptions)
    items.push([
      'toolOptions',
    obj('PbTl', [
      ['brushPreset', bool(true)],
      ['flow', long(Math.round(p.flow * 100))],
      ['Smoo', long(0)],
      ['Md  ', en('BlnM', 'Nrml')],
      ['Opct', long(Math.round(p.opacity * 100))],
      ['smoothing', bool(p.smoothing > 0)],
      ['smoothingValue', long(Math.round(p.smoothing * 100))],
      ['smoothingRadiusMode', bool(!!p.smoothingOptions?.pulledString)],
      ['smoothingCatchup', bool(!!p.smoothingOptions?.catchUp)],
      ['smoothingCatchupAtEnd', bool(!!p.smoothingOptions?.catchUpOnEnd)],
      ['smoothingZoomCompensation', bool(p.smoothingOptions?.adjustForZoom ?? true)],
      ['pressureSmoothing', bool(false)],
      ['usePressureOverridesSize', bool(p.pressureSize)],
      ['usePressureOverridesOpacity', bool(p.pressureOpacity)],
      ['useLegacy', bool(false)],
    ]),
  ]);
  return items;
}

/** An `8BIM` section: its type, its length, then what `write` writes. */
export function section(w: ByteWriter, type: string, write: (w: ByteWriter) => void): void {
  w.sig('8BIM');
  w.sig(type);
  const at = w.length;
  w.u32(0);
  const start = w.length;
  write(w);
  w.patch32(at, w.length - start);
}

/** Write presets (with the sampled tips and texture patterns they use) as ABR v6.2. */
export function writeAbrFile(presets: readonly BrushPreset[], tips: ReadonlyMap<string, TipBitmap>, patterns: readonly PatternDef[]): Uint8Array {
  const used = new Set<string>();
  for (const pr of presets) {
    if (pr.params.tip?.kind === 'sampled') used.add(pr.params.tip.id);
    if (pr.params.dual?.enabled && pr.params.dual.tip.kind === 'sampled') used.add(pr.params.dual.tip.id);
  }
  const w = new ByteWriter();
  w.i16(6);
  w.i16(2);
  section(w, 'samp', (s) => writeSamples(s, used, tips));
  const usedPatterns = patterns.filter((p) => presets.some((pr) => pr.params.texture?.enabled && pr.params.texture.patternId === p.id));
  if (usedPatterns.length) {
    const pw = createWriter();
    for (const p of usedPatterns) writePattern(pw, { name: p.name, id: p.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: p.data } as never);
    const bytes = getWriterBuffer(pw);
    section(w, 'patt', (s) => s.bytes(new Uint8Array(bytes)));
  }
  const tipName = (id: string) => id.replace(/^.*:/, '');
  section(w, 'desc', (s) => writeDescriptor(s, 'null', [['Brsh', list(presets.map((p) => presetDV(p, tipName)))]]));
  return w.result();
}

/**
 * Brush presets given as parsed descriptors (a tool preset's brush, from a .tpl) read through
 * the same path as an .abr: written into a small v6.2 file with the source's sampled tips,
 * then read by ag-psd, so every dynamic is understood exactly as in a brush library.
 */
export function readAbrBrushDescriptors(brushes: readonly Record<string, unknown>[], samp: Uint8Array | null, name: string): AbrContents {
  const w = new ByteWriter();
  w.i16(6);
  w.i16(2);
  if (samp) section(w, 'samp', (s) => s.bytes(samp));
  section(w, 'desc', (s) => writeDescriptor(s, 'null', [['Brsh', list(brushes.map((b) => dvFromParsed(b)))]]));
  return readAbrFile(w.result(), name);
}

/** Sampled tips as an ABR 'samp' section's body (v6.2): raw 8-bit, each padded to 4 bytes. */
export function writeSamples(s: ByteWriter, ids: Iterable<string>, tips: ReadonlyMap<string, TipBitmap>): void {
  for (const id of ids) {
    const t = tips.get(id);
    if (!t) continue;
    const lenAt = s.length;
    s.u32(0);
    const start = s.length;
    // Pascal string id, then 264 bytes Photoshop does not document (v6.2).
    const idBytes = [...id].slice(0, 255).map((c) => c.charCodeAt(0) & 0xff);
    s.u8(idBytes.length);
    for (const b of idBytes) s.u8(b);
    for (let i = 0; i < 264; i++) s.u8(0);
    s.i32(0);
    s.i32(0);
    s.i32(t.height);
    s.i32(t.width);
    s.i16(8);
    s.u8(0);
    s.bytes(t.data);
    s.patch32(lenAt, s.length - start);
    s.pad(4);
  }
}
