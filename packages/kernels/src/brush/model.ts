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

/** A brush tip: computed (round, hardness) or a sampled bitmap from the tip library. */
export type TipRef = { kind: 'computed' } | { kind: 'sampled'; id: string };

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

export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'dualAxis' | 'diagonal' | 'radial' | 'mandala';

export interface Symmetry {
  mode: SymmetryMode;
  /** Radial and Mandala: segments, 2…12. */
  segments: number;
  /** The axes' centre and angle (degrees), document px. */
  cx: number;
  cy: number;
  angle: number;
}

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
