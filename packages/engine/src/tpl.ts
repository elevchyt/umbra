/**
 * Photoshop tool presets (.tpl) — spec 07. A file is `8BTP`, a version, then `8BIM` sections:
 * `tptp` the presets (a Unicode name and a descriptor classed by its tool), `tppa` the
 * patterns they use, `samp` sampled brush tips, and (version 3) `tpsh`/`tpst` the custom
 * shapes and styles they refer to.
 *
 * Each preset becomes Umbra's tool and whichever of its options Umbra has: a painting tool's
 * brush is read through the .abr path (every dynamic, exactly as in a brush library); the
 * rest map key by key. What has nowhere to go is reported per preset.
 */
import { createReader, readSignature, readUint32, readUnicodeString, readBytes, readPattern } from 'ag-psd/dist/psdReader';
import { readVersionAndDescriptor, parseVectorContent, serializeVectorContent, BlnM } from 'ag-psd/dist/descriptor';
import { createWriter, getWriterBuffer, writePattern } from 'ag-psd/dist/psdWriter';
import type { PatternDef, FillContent } from '@umbra/kernels/fill';
import type { Gradient, GradientStyle } from '@umbra/kernels/gradient';
import type { BrushParams, TipBitmap } from '@umbra/kernels/brush';
import type { RetouchOptions } from './retouch.js';
import type { ShapeOptions } from './shape-tool.js';
import { readAbrBrushDescriptors, displayName, brushPresetItems, section, writeSamples } from './abr.js';
import { fromPsdFill, toPsdFill } from './psd-adjust.js';
import { strokeFromPsd } from './psd-vector.js';
import { ByteWriter, dvFromParsed, writeDescriptor, type DV } from './descriptor-writer.js';

type Desc = Record<string, unknown>;

export interface ToolPresetImport {
  name: string;
  /** The descriptor's class: Photoshop's tool. */
  classID: string;
  /** Umbra's tool id, or null for a tool Umbra does not have. */
  tool: string | null;
  brush?: Partial<BrushParams> & { mode?: string };
  retouch?: Partial<RetouchOptions>;
  select?: Partial<{ feather: number; antialias: boolean; tolerance: number; contiguous: boolean; sampleAllLayers: boolean }>;
  gradient?: { gradient?: Gradient; style?: GradientStyle; mode?: string; opacity?: number; reverse?: boolean; dither?: boolean };
  shape?: Partial<ShapeOptions> & { customShapeName?: string };
  type?: Partial<{ font: string; family: string; fontStyle: string; size: number; align: 'left' | 'center' | 'right' }>;
  /** What the preset sets that Umbra cannot. */
  lost: string[];
}

export interface TplContents {
  presets: ToolPresetImport[];
  tips: Map<string, TipBitmap>;
  patterns: PatternDef[];
}

/** Photoshop's tool classes → Umbra's tool ids. */
const TOOL_OF: Record<string, string> = {
  PbTl: 'brush',
  PcTl: 'pencil',
  ErTl: 'eraser',
  CnTl: 'cloneStamp',
  PaTl: 'patternStamp',
  HstB: 'historyBrush',
  ABTl: 'artHistoryBrush',
  BlTl: 'blurTool',
  ShTl: 'sharpenTool',
  SmTl: 'smudgeTool',
  DdTl: 'dodgeTool',
  BrTl: 'burnTool',
  SrTl: 'spongeTool',
  MixB: 'mixerBrush',
  colorReplacementBrushTool: 'colorReplacement',
  magicStampTool: 'healingBrush',
  spotHealingBrushTool: 'spotHealing',
  removeTool: 'removeTool',
  patchSelection: 'patch',
  recomposeSelection: 'contentAwareMove',
  redEyeTool: 'redEye',
  SETl: 'backgroundEraser',
  magicEraserTool: 'magicEraser',
  marqueeRectTool: 'marqueeRect',
  marqueeEllipTool: 'marqueeEllipse',
  marqueeSingleRowTool: 'marqueeRow',
  marqueeSingleColumnTool: 'marqueeColumn',
  lassoTool: 'lasso',
  polySelTool: 'lassoPolygon',
  magneticLassoTool: 'lassoMagnetic',
  magicWandTool: 'magicWand',
  quickSelectTool: 'quickSelect',
  cropTool: 'crop',
  perspectiveCropTool: 'cropPerspective',
  GrTl: 'gradient',
  bucketTool: 'paintBucket',
  typeCreateOrEditTool: 'typeHorizontal',
  typeVerticalCreateOrEditTool: 'typeVertical',
  typeCreateMaskTool: 'typeMaskHorizontal',
  typeVerticalCreateMaskTool: 'typeMaskVertical',
  penTool: 'pen',
  freeformPenTool: 'freeformPen',
  curvaturePenTool: 'curvaturePen',
  rectangleTool: 'rectangle',
  roundedRectangleTool: 'rectangle',
  ellipseTool: 'ellipse',
  triangleTool: 'triangle',
  polygonTool: 'polygon',
  lineTool: 'line',
  customShapeTool: 'customShape',
  eyedropperTool: 'eyedropper',
  colorSamplerTool: 'colorSampler',
  moveTool: 'move',
  handTool: 'hand',
  zoomTool: 'zoom',
};

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : v && typeof v === 'object' && 'value' in v ? Number((v as { value: unknown }).value) : fallback);
const enumValue = (v: unknown) => (typeof v === 'string' ? v.slice(v.indexOf('.') + 1) : '');
/** ag-psd's blend-mode names ('color burn') → ours ('colorBurn'). */
const blend = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  try {
    return (BlnM.decode(v) as string).replace(/ (\w)/g, (_: string, c: string) => c.toUpperCase());
  } catch {
    return undefined;
  }
};

/**
 * A tool preset leaves out the dynamics it does not use; the brush reader expects each one
 * a section refers to, so they default to off.
 */
const OFF: Desc = { _classID: 'brVr', bVTy: 0, fStp: 25, jitter: { units: 'Percent', value: 0 } };
const OFF_DYNAMICS: Desc = Object.fromEntries(
  ['szVr', 'angleDynamics', 'roundnessDynamics', 'countDynamics', 'scatterDynamics', 'textureDepthDynamics', 'clVr', 'prVr', 'opVr', 'wtVr', 'mxVr'].map((k) => [k, OFF]),
);

export function readTplFile(bytes: Uint8Array, fileName: string): TplContents {
  const name = fileName.replace(/\.tpl$/i, '');
  const r = createReader(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  if (readSignature(r) !== '8BTP') throw new Error('Not a tool presets file');
  readUint32(r); // version (2 or 3)
  readUint32(r);
  let raw: { name: string; d: Desc }[] = [];
  let samp: Uint8Array | null = null;
  const patterns: PatternDef[] = [];
  while (r.offset + 12 <= bytes.byteLength) {
    const sig = readSignature(r);
    const key = readSignature(r);
    const size = readUint32(r);
    const end = r.offset + size;
    if (sig !== '8BIM') break;
    if (key === 'tptp') {
      const n = readUint32(r);
      raw = [];
      for (let i = 0; i < n; i++) {
        const presetName = displayName(readUnicodeString(r));
        raw.push({ name: presetName, d: readVersionAndDescriptor(r, true) as Desc });
      }
    } else if (key === 'tppa') {
      while (r.offset < end - 4) {
        const p = readPattern(r) as unknown as { id: string; name: string; bounds: { w: number; h: number }; data: Uint8Array };
        patterns.push({ id: p.id, name: displayName(p.name), width: p.bounds.w, height: p.bounds.h, data: p.data });
      }
    } else if (key === 'samp') {
      samp = readBytes(r, size);
    }
    r.offset = end;
    while (r.offset % 4 && r.offset < bytes.byteLength) r.offset++;
  }
  const tips = new Map<string, TipBitmap>();
  const presets = raw.map(({ name: presetName, d }, i) => {
    const out = preset(presetName, d, patterns);
    // A painting tool's brush: through the .abr reader, with the file's sampled tips.
    if ('Brsh' in d) {
      try {
        const abr = readAbrBrushDescriptors([{ ...OFF_DYNAMICS, ...d, _classID: 'brushPreset', 'Nm  ': presetName, toolOptions: d }], JSON.stringify(d).includes('sampledData') ? samp : null, `${name}:${i}`);
        const b = abr.presets[0];
        if (b) out.brush = { ...b.params, ...out.brush };
        for (const [id, t] of abr.tips) tips.set(id, t);
        out.lost.push(...abr.lost);
      } catch (e) {
        out.lost.push(`brush (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return out;
  });
  return { presets, tips, patterns };
}

function preset(name: string, d: Desc, patterns: readonly PatternDef[]): ToolPresetImport {
  const classID = String(d._classID ?? '');
  const tool = TOOL_OF[classID] ?? null;
  const out: ToolPresetImport = { name, classID, tool, lost: [] };
  if (!tool) out.lost.push(`tool '${classID}'`);
  const mode = blend(d['Md  ']);
  if ('Opct' in d || mode) out.brush = { ...(typeof d.Opct === 'number' ? { opacity: d.Opct / 100 } : {}), ...(mode ? { mode } : {}) };
  const patternId = (d.Ptrn as Desc | undefined)?.Idnt as string | undefined;

  switch (tool) {
    case 'healingBrush':
    case 'cloneStamp':
    case 'patternStamp':
      out.retouch = {
        ...(typeof d.StmA === 'boolean' ? { aligned: d.StmA } : {}),
        ...(typeof d.Imps === 'boolean' ? { impressionist: d.Imps } : {}),
        ...(tool === 'healingBrush' && typeof d.StmS === 'boolean' ? { healSource: d.StmS ? 'pattern' : 'sampled' } : {}),
        ...(patternId ? { patternId } : {}),
      };
      break;
    case 'backgroundEraser':
      out.retouch = {
        ...(typeof d.Tlrn === 'number' ? { tolerance: d.Tlrn / 100 } : {}),
        ...(typeof d.BECn === 'number' ? { limits: (['discontiguous', 'contiguous', 'findEdges'] as const)[d.BECn] ?? 'contiguous' } : {}),
        ...(typeof d.BESm === 'number' ? { sampling: (['continuous', 'once', 'backgroundSwatch'] as const)[d.BESm] ?? 'continuous' } : {}),
        ...(typeof d.BEPr === 'boolean' ? { protectForeground: d.BEPr } : {}),
      };
      break;
    case 'paintBucket':
      out.select = {
        ...(typeof d.BckT === 'number' ? { tolerance: d.BckT } : {}),
        ...(typeof d.BckA === 'boolean' ? { antialias: d.BckA } : {}),
        ...(typeof d.Cntg === 'boolean' ? { contiguous: d.Cntg } : {}),
        ...(typeof d.BckS === 'boolean' ? { sampleAllLayers: d.BckS } : {}),
      };
      if (d.BckF === true) out.lost.push('pattern fill (the Paint Bucket fills with the foreground)');
      break;
    case 'marqueeRect':
    case 'marqueeEllipse':
    case 'marqueeRow':
    case 'marqueeColumn':
    case 'lasso':
    case 'lassoPolygon':
    case 'lassoMagnetic':
    case 'magicWand':
    case 'quickSelect':
      out.select = {
        ...('Fthr' in d ? { feather: num(d.Fthr) } : {}),
        ...(typeof d.AntA === 'boolean' ? { antialias: d.AntA } : typeof d.MrqA === 'boolean' ? { antialias: d.MrqA } : {}),
        ...(typeof d.Tlrn === 'number' ? { tolerance: d.Tlrn } : {}),
        ...(typeof d.Cntg === 'boolean' ? { contiguous: d.Cntg } : {}),
        ...(typeof d.Mrgd === 'boolean' ? { sampleAllLayers: d.Mrgd } : {}),
      };
      if ((d.MrqI as Desc | undefined)?.MrqM) out.lost.push('marquee style (fixed ratio or size)');
      if (tool === 'lassoMagnetic') out.lost.push('Magnetic Lasso options (the tool is not built)');
      break;
    case 'crop':
      if (d.CrpO) out.lost.push('crop size and resolution');
      break;
    case 'gradient': {
      const g = gradientOf(d.Grad, patterns);
      out.gradient = {
        ...(g ? { gradient: g } : {}),
        ...(typeof d.GrdT === 'number' ? { style: (['linear', 'radial', 'angle', 'reflected', 'diamond'] as const)[d.GrdT] ?? 'linear' } : {}),
        ...(mode ? { mode } : {}),
        ...(typeof d.Opct === 'number' ? { opacity: d.Opct / 100 } : {}),
        ...(typeof d.GrdR === 'number' || typeof d.GrdR === 'boolean' ? { reverse: !!d.GrdR } : {}),
        ...(typeof d.GrdD === 'number' || typeof d.GrdD === 'boolean' ? { dither: !!d.GrdD } : {}),
      };
      delete out.brush;
      break;
    }
    case 'typeHorizontal':
    case 'typeVertical':
    case 'typeMaskHorizontal':
    case 'typeMaskVertical': {
      const para = ((d.textToolParagraphOptions as Desc | undefined)?.paragraphStyle ?? {}) as Desc;
      const chr = d.textToolCharacterOptions as Desc | undefined;
      const style = ((chr?.TxtS as Desc | undefined) ?? (chr?.textStyle as Desc | undefined) ?? (para.defaultStyle as Desc | undefined) ?? {}) as Desc;
      const align = enumValue(para.Algn);
      out.type = {
        ...(typeof style.fontPostScriptName === 'string' ? { font: style.fontPostScriptName } : {}),
        ...(typeof style.FntN === 'string' ? { family: style.FntN } : {}),
        ...(typeof style.FntS === 'string' ? { fontStyle: style.FntS } : {}),
        ...('Sz  ' in style ? { size: num(style['Sz  ']) } : {}),
        ...(align === 'Left' ? { align: 'left' } : align === 'Cntr' ? { align: 'center' } : align === 'Rght' ? { align: 'right' } : {}),
      };
      break;
    }
    case 'pen':
    case 'freeformPen':
    case 'curvaturePen':
    case 'rectangle':
    case 'ellipse':
    case 'triangle':
    case 'polygon':
    case 'line':
    case 'customShape':
      out.shape = shapeOf(d, patterns, out.lost);
      delete out.brush;
      break;
  }
  if (d.stylePreset && displayName(String((d.stylePreset as Desc)['Nm  '] ?? '')) !== 'Default Style (None)') out.lost.push('layer style');
  return out;
}

/** A gradient descriptor (`Grdn`) → our gradient, through the gradient-fill path. */
function gradientOf(grad: unknown, patterns: readonly PatternDef[]): Gradient | null {
  if (!grad) return null;
  try {
    const content = parseVectorContent({ _classID: 'gradientLayer', Grad: grad, Type: 'GrdT.Lnr ', Angl: { units: 'Angle', value: 90 } } as never);
    const fill = fromPsdFill(content, patterns);
    return fill?.content.type === 'gradient' ? fill.content.gradient : null;
  } catch {
    return null;
  }
}

function shapeOf(d: Desc, patterns: readonly PatternDef[], lost: string[]): Partial<ShapeOptions> & { customShapeName?: string } {
  const out: Partial<ShapeOptions> & { customShapeName?: string } = {};
  const m = enumValue(d.geometryToolMode).trim();
  if (m === 'Shp') out.mode = 'shape';
  else if (m === 'Path') out.mode = 'path';
  else if (m === 'Pxl') out.mode = 'pixels';
  const style = d.shapeStyle as Desc | undefined;
  // Fill: the style's fill content, or a plain colour.
  let fill: FillContent | null | undefined;
  if (style?.FlCn) {
    try {
      fill = fromPsdFill(parseVectorContent(style.FlCn as never), patterns)?.content ?? null;
    } catch {
      fill = null;
    }
  } else if (d['Clr ']) {
    const c = d['Clr '] as Desc;
    if (c._classID === 'RGBC') fill = { type: 'solid', color: [num(c['Rd  ']) / 255, num(c['Grn ']) / 255, num(c['Bl  ']) / 255] };
  }
  const ss = style?.strokeStyle as Desc | undefined;
  if (ss) {
    const cap = enumValue(ss.strokeStyleLineCapType);
    const join = enumValue(ss.strokeStyleLineJoinType);
    const align = enumValue(ss.strokeStyleLineAlignment);
    let content: unknown;
    try {
      content = ss.strokeStyleContent ? parseVectorContent(ss.strokeStyleContent as never) : undefined;
    } catch {
      content = undefined;
    }
    let agBlend = 'normal';
    try {
      agBlend = BlnM.decode(String(ss.strokeStyleBlendMode ?? 'BlnM.Nrml')) as string;
    } catch {
      // Keep normal.
    }
    const s = strokeFromPsd(
      {
        strokeEnabled: ss.strokeEnabled !== false,
        fillEnabled: ss.fillEnabled !== false,
        lineWidth: ss.strokeStyleLineWidth,
        lineDashOffset: ss.strokeStyleLineDashOffset,
        miterLimit: typeof ss.strokeStyleMiterLimit === 'number' ? ss.strokeStyleMiterLimit : undefined,
        lineCapType: cap.includes('Round') ? 'round' : cap.includes('Square') ? 'square' : 'butt',
        lineJoinType: join.includes('Round') ? 'round' : join.includes('Bevel') ? 'bevel' : 'miter',
        lineAlignment: align.includes('Inside') ? 'inside' : align.includes('Outside') ? 'outside' : 'center',
        lineDashSet: Array.isArray(ss.strokeStyleLineDashSet) ? ss.strokeStyleLineDashSet : [],
        blendMode: agBlend,
        opacity: num(ss.strokeStyleOpacity, 100) / 100,
        content,
      },
      patterns,
    );
    lost.push(...s.lost);
    if (s.stroke) out.stroke = s.stroke;
    if (!s.fillEnabled) fill = null;
  }
  if (fill !== undefined) out.fill = fill;
  if (typeof d.sides === 'number') out.sides = d.sides;
  if (d.doIndent === true) out.star = num(d.indent);
  if (typeof d.LnWd === 'number') out.weight = d.LnWd;
  if (d.customShape) out.customShapeName = displayName(String((d.customShape as Desc)['Nm  '] ?? ''));
  return out;
}

// ---- writing ------------------------------------------------------------------------------

/** A tool preset to save: Umbra's tool and the options it keeps. */
export type ToolPresetExport = Omit<ToolPresetImport, 'classID' | 'lost'>;

/** Umbra's tool ids → Photoshop's tool classes (the first class for each tool). */
const CLASS_OF: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_OF)
    .reverse()
    .map(([cls, tool]) => [tool, cls]),
);

/** Our blend-mode names ('colorBurn') → the descriptor's ('BlnM.CBrn'); Normal where it has none. */
function blendEnum(mode: string | undefined): string {
  try {
    return BlnM.encode((mode ?? 'normal').replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`) as never) as string;
  } catch {
    return 'BlnM.Nrml';
  }
}

const CONTENT_CLASS: Record<string, string> = { SoCo: 'solidColorLayer', GdFl: 'gradientLayer', PtFl: 'patternLayer' };

/** A fill as a descriptor object (classed), for a shape's style or a stroke's content. */
function contentDesc(content: FillContent): Desc {
  const { key, descriptor } = serializeVectorContent(toPsdFill(content) as never) as unknown as { key: string; descriptor: Desc };
  return { _classID: CONTENT_CLASS[key] ?? 'solidColorLayer', ...descriptor };
}

/**
 * Save tool presets as Photoshop's .tpl (version 2): the presets' descriptors, with the
 * sampled tips their brushes use and the patterns they refer to. The exact inverse of the
 * reader above, so every option it maps survives the round trip.
 */
export function writeTplFile(presets: readonly ToolPresetExport[], tips: ReadonlyMap<string, TipBitmap>, patterns: readonly PatternDef[]): Uint8Array {
  const usedTips = new Set<string>();
  const usedPatterns = new Set<string>();
  const descs = presets.map((p) => {
    const d = presetDesc(p, patterns);
    const b = p.brush;
    if (b?.tip?.kind === 'sampled') usedTips.add(b.tip.id);
    if (b?.dual?.enabled && b.dual.tip.kind === 'sampled') usedTips.add(b.dual.tip.id);
    if (b?.texture?.enabled) usedPatterns.add(b.texture.patternId);
    if (p.retouch?.patternId) usedPatterns.add(p.retouch.patternId);
    for (const c of [p.shape?.fill, p.shape?.stroke?.content]) if (c?.type === 'pattern') usedPatterns.add(c.pattern.id);
    return { name: p.name, ...d };
  });
  const w = new ByteWriter();
  w.sig('8BTP');
  w.u32(2);
  w.u32(1);
  const pad = (s: ByteWriter) => s.pad(4);
  if (usedTips.size) section(w, 'samp', (s) => writeSamples(s, usedTips, tips));
  const pats = patterns.filter((p) => usedPatterns.has(p.id));
  if (pats.length) {
    const pw = createWriter();
    for (const p of pats) writePattern(pw, { name: p.name, id: p.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: p.data } as never);
    const bytes = new Uint8Array(getWriterBuffer(pw));
    section(w, 'tppa', (s) => {
      s.bytes(bytes);
      pad(s);
    });
  }
  section(w, 'tptp', (s) => {
    s.u32(descs.length);
    for (const d of descs) {
      s.u32(d.name.length + 1);
      for (const c of d.name) s.u16(c.charCodeAt(0));
      s.u16(0);
      writeDescriptor(s, d.cls, d.items);
    }
    pad(s);
  });
  return w.result();
}

function presetDesc(p: ToolPresetExport, patterns: readonly PatternDef[]): { cls: string; items: [string, DV][] } {
  const cls = CLASS_OF[p.tool ?? ''] ?? 'PbTl';
  const o: Desc = {};
  const b = p.brush;
  const brushTool = b && (b.size !== undefined || b.tip !== undefined);
  if (b?.opacity !== undefined) o.Opct = Math.round(b.opacity * 100);
  if (b?.mode !== undefined) o['Md  '] = blendEnum(b.mode);
  const patternRef = (id: string) => {
    const pat = patterns.find((q) => q.id === id);
    return { _classID: 'Ptrn', 'Nm  ': pat?.name ?? id, Idnt: id };
  };
  const r = p.retouch;
  if (r) {
    if (r.aligned !== undefined) o.StmA = r.aligned;
    if (r.impressionist !== undefined) o.Imps = r.impressionist;
    if (r.healSource !== undefined) o.StmS = r.healSource === 'pattern';
    if (r.patternId) o.Ptrn = patternRef(r.patternId);
    if (r.tolerance !== undefined) o.Tlrn = Math.round(r.tolerance * 100);
    if (r.limits !== undefined) o.BECn = ['discontiguous', 'contiguous', 'findEdges'].indexOf(r.limits);
    if (r.sampling !== undefined) o.BESm = ['continuous', 'once', 'backgroundSwatch'].indexOf(r.sampling);
    if (r.protectForeground !== undefined) o.BEPr = r.protectForeground;
  }
  const sel = p.select;
  if (sel) {
    if (p.tool === 'paintBucket') {
      if (sel.tolerance !== undefined) o.BckT = Math.round(sel.tolerance);
      if (sel.antialias !== undefined) o.BckA = sel.antialias;
      if (sel.contiguous !== undefined) o.Cntg = sel.contiguous;
      if (sel.sampleAllLayers !== undefined) o.BckS = sel.sampleAllLayers;
    } else {
      if (sel.feather !== undefined) o.Fthr = { units: 'Pixels', value: sel.feather };
      if (sel.antialias !== undefined) o.AntA = sel.antialias;
      if (sel.tolerance !== undefined) o.Tlrn = Math.round(sel.tolerance);
      if (sel.contiguous !== undefined) o.Cntg = sel.contiguous;
      if (sel.sampleAllLayers !== undefined) o.Mrgd = sel.sampleAllLayers;
    }
  }
  const g = p.gradient;
  if (g) {
    if (g.gradient) {
      const c = contentDesc({ type: 'gradient', gradient: g.gradient, style: 'linear', angle: 90, scale: 100, reverse: false, offset: { x: 0, y: 0 } });
      o.Grad = c.Grad;
    }
    if (g.style) o.GrdT = ['linear', 'radial', 'angle', 'reflected', 'diamond'].indexOf(g.style);
    if (g.mode) o['Md  '] = blendEnum(g.mode);
    if (g.opacity !== undefined) o.Opct = Math.round(g.opacity * 100);
    if (g.reverse !== undefined) o.GrdR = g.reverse ? 1 : 0;
    if (g.dither !== undefined) o.GrdD = g.dither ? 1 : 0;
  }
  const t = p.type;
  if (t) {
    const style: Desc = { _classID: 'TxtS' };
    if (t.font) style.fontPostScriptName = t.font;
    if (t.family) style.FntN = t.family;
    if (t.fontStyle) style.FntS = t.fontStyle;
    if (t.size !== undefined) style['Sz  '] = { units: 'Points', value: t.size };
    o.textToolCharacterOptions = { _classID: 'textToolCharacterOptions', TxtS: style };
    if (t.align) o.textToolParagraphOptions = { _classID: 'textToolParagraphOptions', paragraphStyle: { _classID: 'paragraphStyle', Algn: `Alg .${{ left: 'Left', center: 'Cntr', right: 'Rght' }[t.align]}` } };
  }
  const sh = p.shape;
  if (sh) {
    if (sh.mode) o.geometryToolMode = `geometryToolMode.${{ shape: 'Shp ', path: 'Path', pixels: 'Pxl ' }[sh.mode]}`;
    const style: Desc = { _classID: 'shapeStyle' };
    if (sh.fill) style.FlCn = contentDesc(sh.fill);
    if (sh.stroke || sh.fill === null) {
      const st = sh.stroke;
      style.strokeStyle = {
        _classID: 'strokeStyle',
        strokeStyleVersion: 2,
        strokeEnabled: !!st?.enabled,
        fillEnabled: sh.fill !== null,
        ...(st
          ? {
              strokeStyleLineWidth: { units: 'Pixels', value: st.style.width },
              strokeStyleLineDashOffset: { units: 'Pixels', value: st.style.dashOffset },
              strokeStyleMiterLimit: st.style.miterLimit + 0.0,
              strokeStyleLineCapType: `strokeStyleLineCapType.${{ butt: 'strokeStyleButtCap', round: 'strokeStyleRoundCap', square: 'strokeStyleSquareCap' }[st.style.cap]}`,
              strokeStyleLineJoinType: `strokeStyleLineJoinType.${{ miter: 'strokeStyleMiterJoin', round: 'strokeStyleRoundJoin', bevel: 'strokeStyleBevelJoin' }[st.style.join]}`,
              strokeStyleLineAlignment: `strokeStyleLineAlignment.${{ inside: 'strokeStyleAlignInside', center: 'strokeStyleAlignCenter', outside: 'strokeStyleAlignOutside' }[st.style.align]}`,
              strokeStyleLineDashSet: st.style.dashes.map((d) => ({ units: 'None', value: d })),
              strokeStyleBlendMode: blendEnum(st.blendMode),
              strokeStyleOpacity: { units: 'Percent', value: st.opacity * 100 },
              strokeStyleContent: contentDesc(st.content),
            }
          : {}),
      };
    }
    if (style.FlCn || style.strokeStyle) o.shapeStyle = style;
    if (sh.sides !== undefined) o.sides = sh.sides;
    if (sh.star !== undefined && sh.star > 0) {
      o.indent = { units: 'Percent', value: sh.star };
      o.doIndent = true;
    }
    if (sh.weight !== undefined) o.LnWd = sh.weight + 0.0;
    if (sh.customShapeName) o.customShape = { _classID: 'customShape', 'Nm  ': sh.customShapeName };
  }
  const items: [string, DV][] = Object.entries(o).map(([k, v]) => [k, dvFromParsed(v, k)]);
  // A painting tool's brush: the same items an .abr brush preset has, at the top level.
  if (brushTool) {
    const own = new Set(items.map(([k]) => k));
    const brushItems = brushPresetItems({ id: '', name: '', params: { size: 25, ...b! } }, (id) => id.replace(/^.*:/, ''));
    for (const [k, v] of brushItems) {
      if (k === 'Nm  ' || own.has(k)) continue;
      // Its tool options (flow, smoothing, pressure) go to the top level too.
      if (k === 'toolOptions' && v.t === 'obj') {
        for (const [tk, tv] of v.items) if (!own.has(tk) && tk !== 'Md  ' && tk !== 'Opct') items.push([tk, tv]);
        continue;
      }
      items.push([k, v]);
    }
  }
  return { cls, items };
}
