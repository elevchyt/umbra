/**
 * Layer styles and blending options in PSD — spec 07 §1: the effects (lfx2) as ag-psd's
 * `LayerEffectsInfo`, and the Blending Options fields (Fill, knockout, clipped-as-group,
 * transparency shapes, excluded channels, Blend If ranges) on the layer record.
 *
 * What the codec does not carry, and so does not round-trip: Outer/Inner Glow gradients and
 * the Precise technique on Outer Glow, Bevel's Contour and Texture sub-effects (their switches
 * survive, not their settings), shape-burst stroke gradients, noise gradients, and the shallow
 * vs deep distinction of knockout (ag-psd has one flag), and contour corner points (they come
 * back smooth). Opening reports what it can see.
 */
import type { LayerEffectsInfo, Layer as AgLayer } from 'ag-psd';
import { PSD_BLEND_MODE } from '@umbra/psd';
import type { BlendMode } from '@umbra/core/blend';
import type { AdvancedBlending, BlendIfRange } from '@umbra/kernels/composite';
import type { Gradient } from '@umbra/kernels/gradient';
import type { PatternDef } from '@umbra/kernels/fill';
import {
  DEFAULTS,
  EMPTY_EFFECTS,
  LINEAR_CONTOUR,
  scaleEffects,
  type Contour,
  type GlowEffect,
  type LayerEffects,
  type ShadowEffect,
  type StrokeFill,
} from '@umbra/kernels/effects/types';
import { colorFromPsd } from './psd-adjust.js';
import { DEFAULT_BLENDING_STATE } from './document.js';

type Obj = Record<string, unknown>;

const TO_PSD_MODE: Record<string, string> = Object.fromEntries(Object.entries(PSD_BLEND_MODE).map(([psd, ours]) => [ours, psd]));
const modeOut = (m: BlendMode) => TO_PSD_MODE[m] ?? 'normal';
const modeIn = (m: unknown): BlendMode => (PSD_BLEND_MODE[String(m ?? 'normal')] ?? 'normal') as BlendMode;
const rgbOut = (c: readonly number[]) => ({ r: Math.round(c[0]! * 255), g: Math.round(c[1]! * 255), b: Math.round(c[2]! * 255) });
const px = (v: number) => ({ units: 'Pixels' as const, value: v });
const num = (u: unknown, fallback = 0): number => (typeof u === 'number' ? u : ((u as { value?: number } | undefined)?.value ?? fallback));

function contourOut(c: Contour) {
  return { name: c.name, curve: c.points.map((p) => ({ x: Math.round(p.x * 255), y: Math.round(p.y * 255) })) };
}
function contourIn(c: unknown): Contour {
  const o = c as { name?: string; curve?: { x: number; y: number }[] } | undefined;
  if (!o?.curve || o.curve.length < 2) return LINEAR_CONTOUR;
  return { name: o.name || 'Custom', points: o.curve.map((p) => ({ x: p.x / 255, y: p.y / 255 })) };
}

function gradientOut(g: Gradient) {
  return {
    name: g.name ?? 'Custom',
    type: 'solid' as const,
    colorStops: g.colorStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, color: rgbOut(s.color) })),
    opacityStops: g.opacityStops.map((s) => ({ location: s.at, midpoint: s.midpoint ?? 0.5, opacity: s.opacity })),
  };
}
/** A midpoint only when it is not the plain halfway one. */
const mid = (m: number | undefined) => (m === undefined || Math.abs(m - 0.5) < 1e-6 ? {} : { midpoint: m });

function gradientIn(raw: unknown, lost: string[], what: string): Gradient | null {
  const g = raw as { name?: string; type?: string; colorStops?: { color: unknown; location: number; midpoint: number }[]; opacityStops?: { opacity: number; location: number; midpoint: number }[] } | undefined;
  if (!g) return null;
  if (g.type === 'noise' || !g.colorStops?.length) {
    lost.push(`${what}: noise gradient`);
    return null;
  }
  return {
    name: g.name,
    colorStops: g.colorStops.map((s) => ({ at: s.location, color: colorFromPsd(s.color), ...mid(s.midpoint) })),
    opacityStops: (g.opacityStops?.length ? g.opacityStops : [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }]).map((s) => ({ at: s.location, opacity: s.opacity, ...mid(s.midpoint) })),
  };
}

const flags = (enabled: boolean) => ({ enabled, present: true, showInDialog: true });

function shadowOut(s: ShadowEffect, drop: boolean) {
  return {
    ...flags(s.enabled),
    blendMode: modeOut(s.blendMode),
    color: rgbOut(s.color),
    opacity: s.opacity,
    useGlobalLight: s.useGlobalLight,
    angle: s.angle,
    distance: px(s.distance),
    choke: px(s.spread),
    size: px(s.size),
    contour: contourOut(s.contour),
    antialiased: s.antiAlias,
    noise: s.noise / 100,
    ...(drop ? { layerConceals: s.knockout } : {}),
  };
}
function shadowIn(o: Obj, drop: boolean): ShadowEffect {
  const d = drop ? DEFAULTS.dropShadow() : DEFAULTS.innerShadow();
  return {
    ...d,
    enabled: o.enabled !== false,
    blendMode: modeIn(o.blendMode ?? d.blendMode),
    color: o.color ? colorFromPsd(o.color) : d.color,
    opacity: typeof o.opacity === 'number' ? o.opacity : d.opacity,
    useGlobalLight: o.useGlobalLight !== false,
    angle: typeof o.angle === 'number' ? o.angle : d.angle,
    distance: num(o.distance, d.distance),
    spread: num(o.choke, 0),
    size: num(o.size, d.size),
    contour: contourIn(o.contour),
    antiAlias: !!o.antialiased,
    noise: typeof o.noise === 'number' ? o.noise * 100 : 0,
    knockout: drop ? o.layerConceals !== false : false,
  };
}

function glowOut(g: GlowEffect, inner: boolean) {
  return {
    ...flags(g.enabled),
    blendMode: modeOut(g.blendMode),
    color: rgbOut(g.fill.type === 'color' ? g.fill.color : [1, 1, 190 / 255]),
    opacity: g.opacity,
    noise: g.noise / 100,
    choke: px(g.spread),
    size: px(g.size),
    contour: contourOut(g.contour),
    antialiased: g.antiAlias,
    range: g.range / 100,
    jitter: g.jitter / 100,
    ...(inner ? { source: g.source, technique: g.technique } : {}),
  };
}
function glowIn(o: Obj, inner: boolean): GlowEffect {
  const d = inner ? DEFAULTS.innerGlow() : DEFAULTS.outerGlow();
  return {
    ...d,
    enabled: o.enabled !== false,
    blendMode: modeIn(o.blendMode ?? d.blendMode),
    fill: { type: 'color', color: o.color ? colorFromPsd(o.color) : (d.fill as { color: [number, number, number] }).color },
    opacity: typeof o.opacity === 'number' ? o.opacity : d.opacity,
    noise: typeof o.noise === 'number' ? o.noise * 100 : 0,
    technique: o.technique === 'precise' ? 'precise' : 'softer',
    spread: num(o.choke, 0),
    size: num(o.size, d.size),
    contour: contourIn(o.contour),
    antiAlias: !!o.antialiased,
    range: typeof o.range === 'number' ? o.range * 100 : 50,
    jitter: typeof o.jitter === 'number' ? o.jitter * 100 : 0,
    source: o.source === 'center' ? 'center' : 'edge',
  };
}

const BEVEL_STYLE: Record<string, string> = { outerBevel: 'outer bevel', innerBevel: 'inner bevel', emboss: 'emboss', pillowEmboss: 'pillow emboss', strokeEmboss: 'stroke emboss' };
const BEVEL_TECH: Record<string, string> = { smooth: 'smooth', chiselHard: 'chisel hard', chiselSoft: 'chisel soft' };
const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));

function strokeFillOut(f: StrokeFill) {
  if (f.type === 'color') return { fillType: 'color', color: rgbOut(f.color) };
  if (f.type === 'pattern') return { fillType: 'pattern', pattern: f.pattern ? { name: f.pattern.name, id: f.pattern.id } : undefined };
  return {
    fillType: 'gradient',
    gradient: { ...gradientOut(f.gradient), style: f.style === 'shapeBurst' ? 'linear' : f.style, scale: f.scale / 100, angle: f.angle, reverse: f.reverse, align: f.align },
  };
}

/** Our style → ag-psd's. */
export function effectsToPsd(fx: LayerEffects): LayerEffectsInfo {
  const out: Obj = { disabled: !fx.enabled, scale: 1 };
  if (fx.dropShadow.length) out.dropShadow = fx.dropShadow.map((s) => shadowOut(s, true));
  if (fx.innerShadow.length) out.innerShadow = fx.innerShadow.map((s) => shadowOut(s, false));
  if (fx.outerGlow) out.outerGlow = glowOut(fx.outerGlow, false);
  if (fx.innerGlow) out.innerGlow = glowOut(fx.innerGlow, true);
  const b = fx.bevel;
  if (b) {
    out.bevel = {
      ...flags(b.enabled),
      style: BEVEL_STYLE[b.style],
      technique: BEVEL_TECH[b.technique],
      strength: b.depth / 100,
      direction: b.direction,
      size: px(b.size),
      soften: px(b.soften),
      useGlobalLight: b.useGlobalLight,
      angle: b.angle,
      altitude: b.altitude,
      contour: contourOut(b.gloss),
      antialiasGloss: b.antiAliasGloss,
      highlightBlendMode: modeOut(b.highlightMode),
      highlightColor: rgbOut(b.highlightColor),
      highlightOpacity: b.highlightOpacity,
      shadowBlendMode: modeOut(b.shadowMode),
      shadowColor: rgbOut(b.shadowColor),
      shadowOpacity: b.shadowOpacity,
      useShape: b.contourEnabled,
      useTexture: b.textureEnabled,
    };
  }
  if (fx.satin) {
    const s = fx.satin;
    out.satin = { ...flags(s.enabled), blendMode: modeOut(s.blendMode), color: rgbOut(s.color), opacity: s.opacity, angle: s.angle, distance: px(s.distance), size: px(s.size), contour: contourOut(s.contour), antialiased: s.antiAlias, invert: s.invert };
  }
  if (fx.colorOverlay.length) out.solidFill = fx.colorOverlay.map((c) => ({ ...flags(c.enabled), blendMode: modeOut(c.blendMode), color: rgbOut(c.color), opacity: c.opacity }));
  if (fx.gradientOverlay.length) {
    out.gradientOverlay = fx.gradientOverlay.map((g) => ({
      ...flags(g.enabled),
      blendMode: modeOut(g.blendMode),
      opacity: g.opacity,
      align: g.align,
      scale: g.scale / 100,
      dither: g.dither,
      reverse: g.reverse,
      type: g.style,
      offset: { x: g.offset.x / 100, y: g.offset.y / 100 },
      gradient: gradientOut(g.gradient),
      angle: g.angle,
    }));
  }
  const p = fx.patternOverlay;
  if (p) out.patternOverlay = { ...flags(p.enabled), blendMode: modeOut(p.blendMode), opacity: p.opacity, scale: p.scale / 100, pattern: p.pattern ? { name: p.pattern.name, id: p.pattern.id } : undefined, phase: p.phase, align: p.link };
  if (fx.stroke.length) {
    out.stroke = fx.stroke.map((s) => ({ ...flags(s.enabled), overprint: s.overprint, size: px(s.size), position: s.position, blendMode: modeOut(s.blendMode), opacity: s.opacity, ...strokeFillOut(s.fill) }));
  }
  return out as LayerEffectsInfo;
}

/** ag-psd's style → ours, with patterns looked up among the file's, and what could not come. */
export function effectsFromPsd(raw: unknown, patterns: readonly PatternDef[]): { effects: LayerEffects; lost: string[] } {
  const r = (raw ?? {}) as Obj;
  const lost: string[] = [];
  const list = (k: string) => ((r[k] as Obj[] | undefined) ?? []).filter((o) => o.present !== false);
  const one = (k: string) => {
    const o = r[k] as Obj | undefined;
    return o && o.present !== false ? o : null;
  };
  const pattern = (ref: unknown, what: string): PatternDef | null => {
    const id = (ref as { id?: string } | undefined)?.id;
    if (!id) return null;
    const found = patterns.find((p) => p.id === id);
    if (!found) lost.push(`${what}: pattern not in the file`);
    return found ?? null;
  };
  let fx: LayerEffects = { ...EMPTY_EFFECTS, enabled: r.disabled !== true };
  fx.dropShadow = list('dropShadow').map((o) => shadowIn(o, true));
  fx.innerShadow = list('innerShadow').map((o) => shadowIn(o, false));
  const og = one('outerGlow');
  if (og) fx.outerGlow = glowIn(og, false);
  const ig = one('innerGlow');
  if (ig) fx.innerGlow = glowIn(ig, true);
  const b = one('bevel');
  if (b) {
    const d = DEFAULTS.bevel();
    fx.bevel = {
      ...d,
      enabled: b.enabled !== false,
      style: (invert(BEVEL_STYLE)[String(b.style)] ?? 'innerBevel') as typeof d.style,
      technique: (invert(BEVEL_TECH)[String(b.technique)] ?? 'smooth') as typeof d.technique,
      depth: typeof b.strength === 'number' ? b.strength * 100 : 100,
      direction: b.direction === 'down' ? 'down' : 'up',
      size: num(b.size, d.size),
      soften: num(b.soften, 0),
      useGlobalLight: b.useGlobalLight !== false,
      angle: typeof b.angle === 'number' ? b.angle : d.angle,
      altitude: typeof b.altitude === 'number' ? b.altitude : d.altitude,
      gloss: contourIn(b.contour),
      antiAliasGloss: !!b.antialiasGloss,
      highlightMode: modeIn(b.highlightBlendMode ?? 'screen'),
      highlightColor: b.highlightColor ? colorFromPsd(b.highlightColor) : d.highlightColor,
      highlightOpacity: typeof b.highlightOpacity === 'number' ? b.highlightOpacity : d.highlightOpacity,
      shadowMode: modeIn(b.shadowBlendMode ?? 'multiply'),
      shadowColor: b.shadowColor ? colorFromPsd(b.shadowColor) : d.shadowColor,
      shadowOpacity: typeof b.shadowOpacity === 'number' ? b.shadowOpacity : d.shadowOpacity,
      contourEnabled: !!b.useShape,
      textureEnabled: false,
    };
    if (b.useShape) lost.push('Bevel & Emboss: Contour settings (a linear contour stands in)');
    if (b.useTexture) lost.push('Bevel & Emboss: Texture');
  }
  const s = one('satin');
  if (s) {
    const d = DEFAULTS.satin();
    fx.satin = { ...d, enabled: s.enabled !== false, blendMode: modeIn(s.blendMode ?? d.blendMode), color: s.color ? colorFromPsd(s.color) : d.color, opacity: typeof s.opacity === 'number' ? s.opacity : d.opacity, angle: typeof s.angle === 'number' ? s.angle : d.angle, distance: num(s.distance, d.distance), size: num(s.size, d.size), contour: contourIn(s.contour), antiAlias: !!s.antialiased, invert: !!s.invert };
  }
  fx.colorOverlay = list('solidFill').map((o) => ({ ...DEFAULTS.colorOverlay(), enabled: o.enabled !== false, blendMode: modeIn(o.blendMode), color: o.color ? colorFromPsd(o.color) : [1, 0, 0], opacity: typeof o.opacity === 'number' ? o.opacity : 1 }));
  fx.gradientOverlay = list('gradientOverlay').flatMap((o) => {
    const g = gradientIn(o.gradient, lost, 'Gradient Overlay');
    if (!g) return [];
    const off = o.offset as { x: number; y: number } | undefined;
    return [{ ...DEFAULTS.gradientOverlay(), enabled: o.enabled !== false, blendMode: modeIn(o.blendMode), opacity: typeof o.opacity === 'number' ? o.opacity : 1, align: o.align !== false, scale: typeof o.scale === 'number' ? o.scale * 100 : 100, dither: !!o.dither, reverse: !!o.reverse, style: (o.type as never) ?? 'linear', offset: { x: (off?.x ?? 0) * 100, y: (off?.y ?? 0) * 100 }, gradient: g, angle: typeof o.angle === 'number' ? o.angle : 90 }];
  });
  const po = one('patternOverlay');
  if (po) fx.patternOverlay = { ...DEFAULTS.patternOverlay(), enabled: po.enabled !== false, blendMode: modeIn(po.blendMode), opacity: typeof po.opacity === 'number' ? po.opacity : 1, scale: typeof po.scale === 'number' ? po.scale * 100 : 100, pattern: pattern(po.pattern, 'Pattern Overlay'), phase: (po.phase as { x: number; y: number }) ?? { x: 0, y: 0 }, link: po.align !== false };
  fx.stroke = list('stroke').map((o) => {
    const d = DEFAULTS.stroke();
    let fill: StrokeFill = { type: 'color', color: o.color ? colorFromPsd(o.color) : [0, 0, 0] };
    if (o.fillType === 'gradient') {
      const gi = o.gradient as Obj | undefined;
      const g = gradientIn(gi, lost, 'Stroke');
      if (g) fill = { type: 'gradient', gradient: g, style: (gi?.style as never) ?? 'linear', angle: typeof gi?.angle === 'number' ? gi.angle : 90, scale: typeof gi?.scale === 'number' ? gi.scale * 100 : 100, reverse: !!gi?.reverse, align: gi?.align !== false };
    } else if (o.fillType === 'pattern') {
      fill = { type: 'pattern', pattern: pattern(o.pattern, 'Stroke'), scale: 100, link: true };
    }
    return { ...d, enabled: o.enabled !== false, overprint: !!o.overprint, size: num(o.size, d.size), position: (o.position as never) ?? 'outside', blendMode: modeIn(o.blendMode), opacity: typeof o.opacity === 'number' ? o.opacity : 1, fill };
  });
  // "Scale Effects" is stored as one factor over the whole style.
  if (typeof r.scale === 'number' && r.scale > 0 && Math.abs(r.scale - 1) > 1e-6) fx = scaleEffects(fx, r.scale);
  return { effects: fx, lost };
}

const range255 = (v: readonly number[]) => v.map((x) => Math.round(x * 255));
const range01 = (v: readonly number[] | undefined): [number, number, number, number] => (v && v.length >= 4 ? [v[0]! / 255, v[1]! / 255, v[2]! / 255, v[3]! / 255] : [0, 0, 1, 1]);
const isFull = (v: readonly number[]) => v[0] === 0 && v[1] === 0 && v[2] === 1 && v[3] === 1;

/** The Blending Options fields for an ag-psd layer record. */
export function blendingToPsd(b: AdvancedBlending): Partial<AgLayer> {
  const excluded = [b.channels.r, b.channels.g, b.channels.b].map((on, i) => (on ? -1 : i)).filter((i) => i >= 0);
  const out: Record<string, unknown> = {
    blendClippendElements: b.blendClippedLayersAsGroup,
    transparencyShapesLayer: b.transparencyShapesLayer,
    knockout: b.knockout !== 'none',
  };
  if (excluded.length) out.channelBlendingRestrictions = excluded;
  if (b.blendIf.length) {
    const gray = b.blendIf.find((r) => r.channel === 'gray');
    const ch = (c: 'r' | 'g' | 'b') => b.blendIf.find((r) => r.channel === c);
    const full = [0, 0, 255, 255];
    out.blendingRanges = {
      compositeGrayBlendSource: gray ? range255(gray.thisLayer) : full,
      compositeGraphBlendDestinationRange: gray ? range255(gray.underlying) : full,
      ranges: (['r', 'g', 'b'] as const).map((c) => {
        const r = ch(c);
        return { sourceRange: r ? range255(r.thisLayer) : full, destRange: r ? range255(r.underlying) : full };
      }),
    };
  }
  return out as Partial<AgLayer>;
}

/** A layer record's Blending Options → ours. */
export function blendingFromPsd(raw: Record<string, unknown>): AdvancedBlending {
  const restrict = (raw.channelBlendingRestrictions as number[] | undefined) ?? [];
  const blendIf: BlendIfRange[] = [];
  const br = raw.blendingRanges as { compositeGrayBlendSource?: number[]; compositeGraphBlendDestinationRange?: number[]; ranges?: { sourceRange: number[]; destRange: number[] }[] } | undefined;
  if (br) {
    const gray = { channel: 'gray' as const, thisLayer: range01(br.compositeGrayBlendSource), underlying: range01(br.compositeGraphBlendDestinationRange) };
    if (!isFull(gray.thisLayer) || !isFull(gray.underlying)) blendIf.push(gray);
    (br.ranges ?? []).slice(0, 3).forEach((r, i) => {
      const range = { channel: (['r', 'g', 'b'] as const)[i]!, thisLayer: range01(r.sourceRange), underlying: range01(r.destRange) };
      if (!isFull(range.thisLayer) || !isFull(range.underlying)) blendIf.push(range);
    });
  }
  return {
    ...DEFAULT_BLENDING_STATE,
    channels: { r: !restrict.includes(0), g: !restrict.includes(1), b: !restrict.includes(2) },
    knockout: raw.knockout ? 'shallow' : 'none',
    blendClippedLayersAsGroup: raw.blendClippendElements !== false,
    transparencyShapesLayer: raw.transparencyShapesLayer !== false,
    blendIf,
  };
}
