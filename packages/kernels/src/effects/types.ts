/**
 * Layer effects (layer styles) — spec 02 §3, spec 06 §9. The ten effects with Photoshop's
 * parameters, names and defaults. Five of them may appear up to ten times on one layer (Drop
 * Shadow, Inner Shadow, Color Overlay, Gradient Overlay, Stroke), so those are lists.
 *
 * Units: sizes and distances in document pixels, angles in degrees (Photoshop's convention:
 * 0° = light from the right, counter-clockwise, 90° = from the top), opacities and colours 0…1.
 */
import type { BlendMode } from '@umbra/core/blend';
import type { Gradient, GradientStyle } from '../gradient.js';
import type { PatternDef } from '../fill.js';

export type Rgb = [number, number, number];

/** A contour: the curve that reshapes an effect's falloff (spec 06 §9). Points 0…1. */
export interface Contour {
  name: string;
  /** `corner` points make a sharp bend; the rest are joined smoothly, as in Photoshop. */
  points: { x: number; y: number; corner?: boolean }[];
}

interface EffectBase {
  enabled: boolean;
  blendMode: BlendMode;
  opacity: number;
}

export interface ShadowEffect extends EffectBase {
  color: Rgb;
  useGlobalLight: boolean;
  angle: number;
  distance: number;
  /** Drop Shadow's Spread / Inner Shadow's Choke, 0…100 %. */
  spread: number;
  size: number;
  contour: Contour;
  antiAlias: boolean;
  /** 0…100 % */
  noise: number;
  /** Drop Shadow only: "Layer Knocks Out Drop Shadow". */
  knockout: boolean;
}

export type GlowFill = { type: 'color'; color: Rgb } | { type: 'gradient'; gradient: Gradient };

export interface GlowEffect extends EffectBase {
  fill: GlowFill;
  noise: number;
  technique: 'softer' | 'precise';
  /** Outer Glow's Spread / Inner Glow's Choke, 0…100 %. */
  spread: number;
  size: number;
  contour: Contour;
  antiAlias: boolean;
  /** 1…100 % */
  range: number;
  /** 0…100 % */
  jitter: number;
  /** Inner Glow only. */
  source: 'center' | 'edge';
}

export type BevelStyle = 'outerBevel' | 'innerBevel' | 'emboss' | 'pillowEmboss' | 'strokeEmboss';

export interface BevelEffect {
  enabled: boolean;
  style: BevelStyle;
  technique: 'smooth' | 'chiselHard' | 'chiselSoft';
  /** 1…1000 % */
  depth: number;
  direction: 'up' | 'down';
  size: number;
  soften: number;
  useGlobalLight: boolean;
  angle: number;
  altitude: number;
  gloss: Contour;
  antiAliasGloss: boolean;
  highlightMode: BlendMode;
  highlightColor: Rgb;
  highlightOpacity: number;
  shadowMode: BlendMode;
  shadowColor: Rgb;
  shadowOpacity: number;
  /** The Contour sub-effect: reshapes the bevel's profile. */
  contourEnabled: boolean;
  contour: Contour;
  contourAntiAlias: boolean;
  /** 0…100 % */
  contourRange: number;
  /** The Texture sub-effect: a pattern pressed into the surface. */
  textureEnabled: boolean;
  texture: PatternDef | null;
  textureScale: number;
  /** −1000…1000 % */
  textureDepth: number;
  textureInvert: boolean;
}

export interface SatinEffect extends EffectBase {
  color: Rgb;
  angle: number;
  distance: number;
  size: number;
  contour: Contour;
  antiAlias: boolean;
  invert: boolean;
}

export interface ColorOverlayEffect extends EffectBase {
  color: Rgb;
}

export interface GradientOverlayEffect extends EffectBase {
  gradient: Gradient;
  style: GradientStyle;
  reverse: boolean;
  dither: boolean;
  /** Align with Layer: the gradient spans the layer's bounds rather than the canvas. */
  align: boolean;
  angle: number;
  /** 10…150 % */
  scale: number;
  /** Percent of the spanned box. */
  offset: { x: number; y: number };
}

export interface PatternOverlayEffect extends EffectBase {
  pattern: PatternDef | null;
  /** 1…1000 % */
  scale: number;
  /** Link with Layer: the pattern moves with the layer's origin. */
  link: boolean;
  phase: { x: number; y: number };
}

export type StrokeFill =
  | { type: 'color'; color: Rgb }
  | { type: 'gradient'; gradient: Gradient; style: GradientStyle | 'shapeBurst'; angle: number; scale: number; reverse: boolean; align: boolean }
  | { type: 'pattern'; pattern: PatternDef | null; scale: number; link: boolean };

export interface StrokeEffect extends EffectBase {
  size: number;
  position: 'outside' | 'inside' | 'center';
  fill: StrokeFill;
  overprint: boolean;
}

export interface LayerEffects {
  /** "Hide All Effects" and the Effects row's eye. */
  enabled: boolean;
  dropShadow: ShadowEffect[];
  innerShadow: ShadowEffect[];
  outerGlow: GlowEffect | null;
  innerGlow: GlowEffect | null;
  bevel: BevelEffect | null;
  satin: SatinEffect | null;
  colorOverlay: ColorOverlayEffect[];
  gradientOverlay: GradientOverlayEffect[];
  patternOverlay: PatternOverlayEffect | null;
  stroke: StrokeEffect[];
}

export interface GlobalLight {
  angle: number;
  altitude: number;
}

export const DEFAULT_GLOBAL_LIGHT: GlobalLight = { angle: 90, altitude: 30 };

export const LINEAR_CONTOUR: Contour = {
  name: 'Linear',
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
};

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];
const GLOW: Rgb = [1, 1, 190 / 255];

export const EMPTY_EFFECTS: LayerEffects = {
  enabled: true,
  dropShadow: [],
  innerShadow: [],
  outerGlow: null,
  innerGlow: null,
  bevel: null,
  satin: null,
  colorOverlay: [],
  gradientOverlay: [],
  patternOverlay: null,
  stroke: [],
};

/** Photoshop's defaults for each effect, as a fresh one appears in the dialog. */
export const DEFAULTS = {
  dropShadow: (): ShadowEffect => ({ enabled: true, blendMode: 'multiply', opacity: 0.35, color: BLACK, useGlobalLight: true, angle: 90, distance: 5, spread: 0, size: 5, contour: LINEAR_CONTOUR, antiAlias: false, noise: 0, knockout: true }),
  innerShadow: (): ShadowEffect => ({ enabled: true, blendMode: 'multiply', opacity: 0.35, color: BLACK, useGlobalLight: true, angle: 90, distance: 5, spread: 0, size: 5, contour: LINEAR_CONTOUR, antiAlias: false, noise: 0, knockout: false }),
  outerGlow: (): GlowEffect => ({ enabled: true, blendMode: 'screen', opacity: 0.35, fill: { type: 'color', color: GLOW }, noise: 0, technique: 'softer', spread: 0, size: 5, contour: LINEAR_CONTOUR, antiAlias: false, range: 50, jitter: 0, source: 'edge' }),
  innerGlow: (): GlowEffect => ({ enabled: true, blendMode: 'screen', opacity: 0.35, fill: { type: 'color', color: GLOW }, noise: 0, technique: 'softer', spread: 0, size: 5, contour: LINEAR_CONTOUR, antiAlias: false, range: 50, jitter: 0, source: 'edge' }),
  bevel: (): BevelEffect => ({
    enabled: true,
    style: 'innerBevel',
    technique: 'smooth',
    depth: 100,
    direction: 'up',
    size: 5,
    soften: 0,
    useGlobalLight: true,
    angle: 90,
    altitude: 30,
    gloss: LINEAR_CONTOUR,
    antiAliasGloss: false,
    highlightMode: 'screen',
    highlightColor: WHITE,
    highlightOpacity: 0.75,
    shadowMode: 'multiply',
    shadowColor: BLACK,
    shadowOpacity: 0.75,
    contourEnabled: false,
    contour: LINEAR_CONTOUR,
    contourAntiAlias: false,
    contourRange: 50,
    textureEnabled: false,
    texture: null,
    textureScale: 100,
    textureDepth: 100,
    textureInvert: false,
  }),
  satin: (): SatinEffect => ({ enabled: true, blendMode: 'multiply', opacity: 0.5, color: BLACK, angle: 19, distance: 11, size: 14, contour: LINEAR_CONTOUR, antiAlias: true, invert: true }),
  colorOverlay: (): ColorOverlayEffect => ({ enabled: true, blendMode: 'normal', opacity: 1, color: [1, 0, 0] }),
  gradientOverlay: (fg: Rgb = BLACK, bg: Rgb = WHITE): GradientOverlayEffect => ({
    enabled: true,
    blendMode: 'normal',
    opacity: 1,
    gradient: { colorStops: [{ at: 0, color: fg }, { at: 1, color: bg }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 1 }], name: 'Foreground to Background' },
    style: 'linear',
    reverse: false,
    dither: false,
    align: true,
    angle: 90,
    scale: 100,
    offset: { x: 0, y: 0 },
  }),
  patternOverlay: (pattern: PatternDef | null = null): PatternOverlayEffect => ({ enabled: true, blendMode: 'normal', opacity: 1, pattern, scale: 100, link: true, phase: { x: 0, y: 0 } }),
  stroke: (): StrokeEffect => ({ enabled: true, blendMode: 'normal', opacity: 1, size: 3, position: 'outside', fill: { type: 'color', color: BLACK }, overprint: false }),
};

/** Whether a layer's effects draw anything. */
export function hasVisibleEffects(fx: LayerEffects | undefined): fx is LayerEffects {
  if (!fx || !fx.enabled) return false;
  const any = (l: { enabled: boolean }[]) => l.some((e) => e.enabled);
  return (
    any(fx.dropShadow) ||
    any(fx.innerShadow) ||
    !!fx.outerGlow?.enabled ||
    !!fx.innerGlow?.enabled ||
    !!fx.bevel?.enabled ||
    !!fx.satin?.enabled ||
    any(fx.colorOverlay) ||
    any(fx.gradientOverlay) ||
    !!fx.patternOverlay?.enabled ||
    any(fx.stroke)
  );
}
