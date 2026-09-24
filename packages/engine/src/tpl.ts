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
import { readVersionAndDescriptor, parseVectorContent, BlnM } from 'ag-psd/dist/descriptor';
import type { PatternDef, FillContent } from '@umbra/kernels/fill';
import type { Gradient, GradientStyle } from '@umbra/kernels/gradient';
import type { BrushParams, TipBitmap } from '@umbra/kernels/brush';
import type { RetouchOptions } from './retouch.js';
import type { ShapeOptions } from './shape-tool.js';
import { readAbrBrushDescriptors, displayName } from './abr.js';
import { fromPsdFill } from './psd-adjust.js';
import { strokeFromPsd } from './psd-vector.js';

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
