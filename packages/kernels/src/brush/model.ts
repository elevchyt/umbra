/**
 * The brush model — spec 01 §5 (Brush Settings) and spec 04 §4: Photoshop's brush, section by
 * section, shaped after the ABR descriptor (as ag-psd reads it) so presets import directly.
 *
 * Every section is optional and off by default, so a plain `BrushParams` — size, hardness,
 * spacing, opacity, flow — is still a complete brush.
 */

/** What drives a dynamic: Photoshop's Control menu. */
export type ControlSource = 'off' | 'fade' | 'pressure' | 'tilt' | 'wheel' | 'rotation' | 'initialDirection' | 'direction';

/**
 * One dynamic setting: a control, the fade length when it fades, the jitter (0…1 of the
 * range) and the floor the value may not go below (0…1).
 */
export interface Dynamic {
  control: ControlSource;
  fadeSteps: number;
  jitter: number;
  minimum: number;
}

export const NO_DYNAMIC: Dynamic = { control: 'off', fadeSteps: 25, jitter: 0, minimum: 0 };

/**
 * A brush tip: computed (round, hardness), a sampled bitmap from the tip library, or one of
 * Photoshop's physical tips — bristle, erodible or airbrush — generated from its settings
 * (`brush/physical.ts`).
 */
export type TipRef = { kind: 'computed' } | { kind: 'sampled'; id: string } | BristleTip | ErodibleTip | AirbrushTip;

/** Bristle tip shapes, in Photoshop's (and the ABR descriptor's) order. */
export const BRISTLE_SHAPES = ['roundPoint', 'roundBlunt', 'roundCurve', 'roundAngle', 'roundFan', 'flatPoint', 'flatBlunt', 'flatCurve', 'flatAngle', 'flatFan'] as const;
export type BristleShape = (typeof BRISTLE_SHAPES)[number];

/** Bristle Qualities: all 0…1 fractions of Photoshop's percentages (Length and Thickness go past 1). */
export interface BristleTip {
  kind: 'bristle';
  shape: BristleShape;
  /** Bristles (density), 0.01…1. */
  bristles: number;
  /** Length, 0.25…5. */
  length: number;
  /** Thickness, 0.01…2. */
  thickness: number;
  /** Stiffness, 0.01…1. */
  stiffness: number;
  /** Clumping (not in Photoshop's panel, kept from ABR files), 0…1. */
  clumping: number;
}

/** Erodible tip shapes, in the ABR descriptor's order. */
export const ERODIBLE_SHAPES = ['point', 'flat', 'round', 'square', 'triangle'] as const;
export type ErodibleShape = (typeof ERODIBLE_SHAPES)[number];

/** An erodible tip (pencils, pastels, charcoal): it wears as it paints until sharpened. */
export interface ErodibleTip {
  kind: 'erodible';
  shape: ErodibleShape;
  /** 0…1, the descriptor's tip hardness; Photoshop's Softness is 1 − this. */
  hardness: number;
}

/** An airbrush tip: a spray of grain and spatter. */
export interface AirbrushTip {
  kind: 'airbrush';
  /** 0…1 */
  hardness: number;
  /** The descriptor's cutoff angle, degrees (1…90); Photoshop's Distortion slider. */
  cutoffAngle: number;
  /** 0…1 */
  granularity: number;
  /** 0…1 */
  spatterSize: number;
  /** Spatter Amount, 1…200 droplets. */
  spatterAmount: number;
}

export const DEFAULT_BRISTLE: BristleTip = { kind: 'bristle', shape: 'roundPoint', bristles: 0.35, length: 1.25, thickness: 0.02, stiffness: 0.75, clumping: 0.25 };
export const DEFAULT_ERODIBLE: ErodibleTip = { kind: 'erodible', shape: 'point', hardness: 0.5 };
export const DEFAULT_AIRBRUSH: AirbrushTip = { kind: 'airbrush', hardness: 0.01, cutoffAngle: 15, granularity: 0.5, spatterSize: 0.1, spatterAmount: 25 };

export interface ShapeDynamics {
  enabled: boolean;
  size: Dynamic;
  /** 0…1: the smallest a controlled size may get. */
  minDiameter: number;
  /** 0…1: how much tilt enlarges the tip's height (the Tilt control). */
  tiltScale: number;
  angle: Dynamic;
  roundness: Dynamic;
  minRoundness: number;
  flipXJitter: boolean;
  flipYJitter: boolean;
}

export interface Scattering {
  enabled: boolean;
  /** Scatter amount as a Dynamic: jitter is the spread, 0…10 diameters (1000 %). */
  scatter: Dynamic;
  bothAxes: boolean;
  /** Dabs per spacing step, 1…16. */
  count: number;
  countJitter: Dynamic;
}

export type TextureMode = 'multiply' | 'subtract' | 'darken' | 'overlay' | 'colorDodge' | 'colorBurn' | 'linearBurn' | 'hardMix' | 'linearHeight' | 'height';

export interface TextureSection {
  enabled: boolean;
  patternId: string;
  invert: boolean;
  /** %, 1…1000. */
  scale: number;
  /** −150…150 and −50…100, as Photoshop's sliders. */
  brightness: number;
  contrast: number;
  mode: TextureMode;
  /** 0…1. */
  depth: number;
  minDepth: number;
  depthJitter: Dynamic;
  eachTip: boolean;
}

export type DualMode = 'multiply' | 'darken' | 'overlay' | 'colorDodge' | 'colorBurn' | 'linearBurn' | 'hardMix' | 'linearHeight';

export interface DualBrush {
  enabled: boolean;
  tip: TipRef;
  /** Diameter px, hardness (computed tips) and spacing as a fraction of the diameter. */
  size: number;
  hardness: number;
  spacing: number;
  /** 0…10 diameters. */
  scatter: number;
  bothAxes: boolean;
  count: number;
  mode: DualMode;
  flip: boolean;
}

export interface ColorDynamics {
  enabled: boolean;
  eachTip: boolean;
  /** Foreground → background: jitter mixes towards the background; a control moves along it. */
  fgBg: Dynamic;
  /** 0…1 of the full range each way. */
  hue: number;
  saturation: number;
  brightness: number;
  /** −1…1: saturation pushed down or up. */
  purity: number;
}

export interface Transfer {
  enabled: boolean;
  opacity: Dynamic;
  flow: Dynamic;
}

export interface BrushPose {
  enabled: boolean;
  /** Degrees −90…90, rotation −180…180, pressure 0…1, used where the override is on. */
  tiltX: number;
  tiltY: number;
  rotation: number;
  pressure: number;
  overrideTilt: boolean;
  overrideRotation: boolean;
  overridePressure: boolean;
}

export interface SmoothingOptions {
  /** Pulled String: the brush waits inside a leash of `smoothing` × 60 px, then follows. */
  pulledString: boolean;
  /** Stroke Catch-up: the brush keeps catching the pointer while it is held still. */
  catchUp: boolean;
  /** Catch-up on Stroke End: the brush runs to where the pointer let go. */
  catchUpOnEnd: boolean;
  /** Adjust for Zoom: less smoothing zoomed in, more zoomed out. */
  adjustForZoom: boolean;
}

/** Photoshop's Paint Symmetry types, in its menu's order; `path` is a path made into one. */
export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'dualAxis' | 'diagonal' | 'wavy' | 'circle' | 'spiral' | 'parallelLines' | 'radial' | 'mandala' | 'path';

export interface Symmetry {
  mode: SymmetryMode;
  /** Radial and Mandala: segments, 2…12. */
  segments: number;
  /** The axes' centre and angle (degrees), document px. */
  cx: number;
  cy: number;
  angle: number;
  /**
   * Wavy, Circle, Spiral and Parallel Lines: the figure's size, document px — the waves'
   * length, the circle's radius, the spiral's gap between turns, the lines' distance apart.
   */
  size?: number;
  /** Path symmetry: the axis, flattened (document px). */
  path?: { points: { x: number; y: number }[]; closed: boolean }[];
  /**
   * The symmetry path's transform beyond its centre and angle (its transform box): width and
   * height scale, and horizontal skew in degrees. The figure is laid out about the origin,
   * skewed, scaled, turned by `angle` and moved to the centre; strokes mirror in that frame.
   */
  transform?: SymmetryTransform;
}

export interface SymmetryTransform {
  /** 1 = 100 %; negative flips. */
  scaleX: number;
  scaleY: number;
  /** Horizontal skew, degrees, −89…89. */
  skew: number;
  /** Vertical skew, degrees, −89…89. */
  skewY?: number;
}

export const IDENTITY_SYMMETRY_TRANSFORM: SymmetryTransform = { scaleX: 1, scaleY: 1, skew: 0, skewY: 0 };

export const DEFAULT_SHAPE_DYNAMICS: ShapeDynamics = {
  enabled: false,
  size: { ...NO_DYNAMIC, control: 'pressure' },
  minDiameter: 0,
  tiltScale: 0,
  angle: NO_DYNAMIC,
  roundness: NO_DYNAMIC,
  minRoundness: 0.25,
  flipXJitter: false,
  flipYJitter: false,
};

export const DEFAULT_SCATTERING: Scattering = { enabled: false, scatter: { ...NO_DYNAMIC, jitter: 1 }, bothAxes: false, count: 1, countJitter: NO_DYNAMIC };

export const DEFAULT_TEXTURE: TextureSection = {
  enabled: false,
  patternId: '',
  invert: false,
  scale: 100,
  brightness: 0,
  contrast: 0,
  mode: 'multiply',
  depth: 1,
  minDepth: 0,
  depthJitter: NO_DYNAMIC,
  eachTip: true,
};

export const DEFAULT_DUAL: DualBrush = { enabled: false, tip: { kind: 'computed' }, size: 25, hardness: 1, spacing: 0.25, scatter: 0, bothAxes: false, count: 1, mode: 'colorBurn', flip: false };

export const DEFAULT_COLOR_DYNAMICS: ColorDynamics = { enabled: false, eachTip: true, fgBg: NO_DYNAMIC, hue: 0, saturation: 0, brightness: 0, purity: 0 };

export const DEFAULT_TRANSFER: Transfer = { enabled: false, opacity: NO_DYNAMIC, flow: NO_DYNAMIC };

export const DEFAULT_POSE: BrushPose = { enabled: false, tiltX: 0, tiltY: 0, rotation: 0, pressure: 1, overrideTilt: false, overrideRotation: false, overridePressure: false };

export const DEFAULT_SMOOTHING: SmoothingOptions = { pulledString: false, catchUp: false, catchUpOnEnd: false, adjustForZoom: true };

export const DEFAULT_SYMMETRY: Symmetry = { mode: 'off', segments: 6, cx: 0, cy: 0, angle: 0 };
