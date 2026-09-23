/**
 * Brush stroke geometry — spec 04 §4.
 *
 * Everything here is pure: pointer samples in, dabs out. The GPU only ever draws the dabs this
 * produces, so spacing, smoothing, dynamics, scattering, symmetry and airbrush build-up can be
 * tested without a graphics context, and the CPU and GPU can never disagree about where a dab
 * went. Randomness comes from a PRNG seeded per stroke, so a stroke replays exactly.
 *
 * The distinction that matters most, and the one a naive brush gets wrong: OPACITY is the
 * ceiling for the whole stroke, FLOW is how much each dab deposits. Overlapping dabs build up
 * toward opacity and stop there. That is why dabs are accumulated in a stroke buffer and
 * composited once at the end rather than painted straight onto the layer — painting each dab
 * directly would let a slow stroke darken without limit.
 */
import {
  DEFAULT_SMOOTHING,
  type BrushPose,
  type ColorDynamics,
  type Dynamic,
  type DualBrush,
  type Scattering,
  type ShapeDynamics,
  type SmoothingOptions,
  type Symmetry,
  type TextureSection,
  type TipRef,
  type Transfer,
} from './brush/model.js';
import { rng } from './brush/rng.js';

export * from './brush/model.js';
export { rng, hash01 } from './brush/rng.js';

export interface BrushParams {
  /** Diameter in document pixels. */
  size: number;
  /** 0…1; the fraction of the radius that is fully opaque before the falloff starts. */
  hardness: number;
  /** Dab interval as a fraction of the diameter. Photoshop's default is 0.25. */
  spacing: number;
  /** Tip rotation in degrees. */
  angle: number;
  /** 0…1; 1 is a circle, lower values flatten the tip across `angle`. */
  roundness: number;
  /** 0…1 ceiling for the whole stroke. */
  opacity: number;
  /** 0…1 deposited per dab. */
  flow: number;
  /** 0…1; how far the brush lags the pointer, Photoshop's Smoothing percentage. */
  smoothing: number;
  /** Keep depositing while the pointer is held still (Build-up). */
  airbrush: boolean;
  /** Dabs per second when airbrushing in place. */
  airbrushRate: number;
  /** The options bar's pressure-for-size button: overrides Shape Dynamics' size control. */
  pressureSize: boolean;
  /** The options bar's pressure-for-opacity button: overrides Transfer. */
  pressureOpacity: boolean;
  // ---- Brush Settings sections (all optional; off when absent) ----
  tip?: TipRef;
  flipX?: boolean;
  flipY?: boolean;
  shapeDynamics?: ShapeDynamics;
  scattering?: Scattering;
  texture?: TextureSection;
  dual?: DualBrush;
  colorDynamics?: ColorDynamics;
  transfer?: Transfer;
  pose?: BrushPose;
  noise?: boolean;
  wetEdges?: boolean;
  protectTexture?: boolean;
  smoothingOptions?: SmoothingOptions;
  symmetry?: Symmetry;
  /** The stroke's random seed (a new one per stroke unless replaying). */
  seed?: number;
}

export const DEFAULT_BRUSH: BrushParams = {
  size: 60,
  hardness: 0.6,
  spacing: 0.25,
  angle: 0,
  roundness: 1,
  opacity: 1,
  flow: 1,
  smoothing: 0.1,
  airbrush: false,
  airbrushRate: 40,
  pressureSize: true,
  pressureOpacity: false,
};

/** A dual-brush stamp that masks a primary dab. */
export interface DualStamp {
  x: number;
  y: number;
  radius: number;
  angle: number;
  roundness: number;
  flipX: boolean;
  flipY: boolean;
}

export interface Dab {
  x: number;
  y: number;
  /** Semi-major axis in document pixels. */
  radius: number;
  /** 0…1 */
  hardness: number;
  /** Tip rotation in radians. */
  angle: number;
  /** 0…1; 1 is a circle. */
  roundness: number;
  /** 0…1 deposited by this dab. */
  flow: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Colour Dynamics: this dab's colour (else the stroke's). */
  color?: [number, number, number];
  /** Sampled tip id (else the computed round tip). */
  tip?: string;
  /** Texture depth for this dab, 0…1, when the brush has a texture. */
  textureDepth?: number;
  /** Dual brush: the secondary stamps over this dab. */
  dual?: DualStamp[];
}

export interface StrokeSample {
  x: number;
  y: number;
  /** 0…1 */
  pressure: number;
  /** Milliseconds, monotonic. */
  time: number;
  /** Pen tilt, degrees −90…90, and barrel rotation, degrees 0…359. */
  tiltX?: number;
  tiltY?: number;
  twist?: number;
}

export interface StrokeOptions {
  /** Foreground and background, for Colour Dynamics. */
  fg?: [number, number, number];
  bg?: [number, number, number];
  /** The view's zoom, for Adjust for Zoom and the Pulled String leash. */
  zoom?: number;
}

export interface StrokeState {
  params: BrushParams;
  /** Where the brush actually is, which lags the pointer when smoothing is on. */
  brush: { x: number; y: number } | null;
  /** The pointer, for catch-up. */
  pointer: { x: number; y: number } | null;
  /** Distance travelled since the last dab, so spacing is measured along the whole path. */
  carry: number;
  lastTime: number;
  lastPressure: number;
  lastTilt: [number, number];
  lastTwist: number;
  /** Dabs stamped so far (steps, for Fade). */
  steps: number;
  /** Direction of travel, radians; the first one is kept for Initial Direction. */
  direction: number;
  initialDirection: number | null;
  rand: () => number;
  opts: StrokeOptions;
  /** Colour Dynamics computed once per stroke (not per tip). */
  strokeColor: [number, number, number] | null;
  dualCarry: number;
  dualRecent: DualStamp[];
}

export function beginStroke(params: BrushParams, opts: StrokeOptions = {}): StrokeState {
  const s: StrokeState = {
    params,
    brush: null,
    pointer: null,
    carry: 0,
    lastTime: 0,
    lastPressure: 0.5,
    lastTilt: [0, 0],
    lastTwist: 0,
    steps: 0,
    direction: 0,
    initialDirection: null,
    rand: rng(params.seed ?? 1),
    opts,
    strokeColor: null,
    dualCarry: 0,
    dualRecent: [],
  };
  const cd = params.colorDynamics;
  if (cd?.enabled && !cd.eachTip) s.strokeColor = dynamicColor(s, 1);
  return s;
}

// ---- dynamics ----------------------------------------------------------------------------

interface PenState {
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
}

function pen(state: StrokeState, pressure: number, tiltX: number, tiltY: number, twist: number): PenState {
  const pose = state.params.pose;
  if (!pose?.enabled) return { pressure, tiltX, tiltY, twist };
  return {
    pressure: pose.overridePressure ? pose.pressure : pressure,
    tiltX: pose.overrideTilt ? pose.tiltX : tiltX,
    tiltY: pose.overrideTilt ? pose.tiltY : tiltY,
    twist: pose.overrideRotation ? pose.rotation : twist,
  };
}

/** A control's value, 0…1 (1 when it does not apply). */
function controlOf(d: Dynamic, state: StrokeState, p: PenState): number {
  switch (d.control) {
    case 'off':
    case 'direction':
    case 'initialDirection':
      return 1;
    case 'fade':
      return Math.max(0, 1 - state.steps / Math.max(1, d.fadeSteps));
    case 'pressure':
      return p.pressure;
    case 'tilt':
      // Upright is full; laid flat is none.
      return Math.max(0, 1 - Math.min(90, Math.hypot(p.tiltX, p.tiltY)) / 90);
    case 'wheel':
      return 1;
    case 'rotation':
      return ((p.twist % 360) + 360) % 360 / 360;
  }
}

/**
 * A dynamic's factor, 0…1: the control scales from `minimum` to 1, then jitter takes a
 * random share off, never below `minimum`.
 */
function factor(d: Dynamic, state: StrokeState, p: PenState): number {
  const c = controlOf(d, state, p);
  const v = d.control === 'off' ? 1 : d.minimum + (1 - d.minimum) * c;
  return Math.max(d.minimum, v * (1 - d.jitter * state.rand()));
}

function rgbToHsb(c: [number, number, number]): [number, number, number] {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Colour Dynamics: foreground towards background, then hue, saturation, brightness, purity. */
function dynamicColor(state: StrokeState, pressure: number): [number, number, number] {
  const cd = state.params.colorDynamics!;
  const fg = state.opts.fg ?? [0, 0, 0];
  const bg = state.opts.bg ?? [1, 1, 1];
  const p: PenState = { pressure, tiltX: state.lastTilt[0], tiltY: state.lastTilt[1], twist: state.lastTwist };
  const ctl = cd.fgBg.control === 'off' ? 1 : controlOf(cd.fgBg, state, p);
  const t = clamp01(1 - ctl + cd.fgBg.jitter * state.rand());
  const base: [number, number, number] = [fg[0] + (bg[0] - fg[0]) * t, fg[1] + (bg[1] - fg[1]) * t, fg[2] + (bg[2] - fg[2]) * t];
  let [h, s, v] = rgbToHsb(base);
  h = (((h + (state.rand() * 2 - 1) * cd.hue * 0.5) % 1) + 1) % 1;
  s = clamp01(s + (state.rand() * 2 - 1) * cd.saturation);
  v = clamp01(v + (state.rand() * 2 - 1) * cd.brightness);
  s = cd.purity < 0 ? s * (1 + cd.purity) : s + (1 - s) * cd.purity;
  return hsbToRgb(h, clamp01(s), v);
}

/** The dabs of one spacing step at (x, y): Shape Dynamics, Scattering and Count, Transfer, Colour. */
function stepDabs(state: StrokeState, x: number, y: number, p: PenState): Dab[] {
  const b = state.params;
  const sd = b.shapeDynamics?.enabled ? b.shapeDynamics : null;
  const sc = b.scattering?.enabled ? b.scattering : null;
  const tr = b.transfer?.enabled ? b.transfer : null;
  const tx = b.texture?.enabled ? b.texture : null;
  const cd = b.colorDynamics?.enabled ? b.colorDynamics : null;
  const count = sc ? Math.max(1, Math.round(sc.count * factor(sc.countJitter, state, p))) : 1;
  const out: Dab[] = [];
  for (let n = 0; n < count; n++) {
    // Size: the options bar's pressure button wins over Shape Dynamics.
    let size = b.size;
    if (b.pressureSize) size *= Math.max(0.02, p.pressure);
    else if (sd) {
      const f = factor({ ...sd.size, minimum: Math.max(sd.size.minimum, sd.minDiameter) }, state, p);
      size *= Math.max(0.02, Math.max(sd.minDiameter, f));
    }
    // Angle: the tip's own, turned by the control, jittered by up to ±180°.
    let angle = b.angle;
    let roundness = b.roundness;
    let flipX = !!b.flipX;
    let flipY = !!b.flipY;
    if (sd) {
      const ac = sd.angle.control;
      const deg = (r: number) => (r * 180) / Math.PI;
      if (ac === 'direction') angle += deg(state.direction);
      else if (ac === 'initialDirection') angle += deg(state.initialDirection ?? state.direction);
      else if (ac === 'rotation') angle += p.twist;
      else if (ac === 'tilt') angle += deg(Math.atan2(p.tiltY, p.tiltX));
      else if (ac === 'fade') angle += 360 * (1 - controlOf(sd.angle, state, p));
      angle += sd.angle.jitter * 360 * (state.rand() - 0.5);
      const rf = sd.roundness.control === 'off' && sd.roundness.jitter === 0 ? 1 : factor({ ...sd.roundness, minimum: Math.max(sd.roundness.minimum, sd.minRoundness) }, state, p);
      roundness *= Math.max(sd.minRoundness, rf);
      if (sd.flipXJitter && state.rand() < 0.5) flipX = !flipX;
      if (sd.flipYJitter && state.rand() < 0.5) flipY = !flipY;
    }
    // Scatter: across the direction of travel (and along it with Both Axes), in diameters.
    let dx = 0;
    let dy = 0;
    if (sc) {
      const amount = sc.scatter.jitter * (sc.scatter.control === 'off' ? 1 : controlOf(sc.scatter, state, p));
      const cos = Math.cos(state.direction);
      const sin = Math.sin(state.direction);
      const across = (state.rand() * 2 - 1) * amount * size;
      const along = sc.bothAxes ? (state.rand() * 2 - 1) * amount * size : 0;
      dx = -sin * across + cos * along;
      dy = cos * across + sin * along;
    }
    let flow = b.flow;
    if (b.pressureOpacity) flow *= Math.max(0, p.pressure);
    else if (tr) flow *= factor(tr.opacity, state, p);
    if (tr) flow *= factor(tr.flow, state, p);
    const dab: Dab = {
      x: x + dx,
      y: y + dy,
      radius: size / 2,
      hardness: b.hardness,
      angle: (angle * Math.PI) / 180,
      roundness: Math.max(0.01, roundness),
      flow,
    };
    if (flipX) dab.flipX = true;
    if (flipY) dab.flipY = true;
    if (b.tip?.kind === 'sampled') dab.tip = b.tip.id;
    if (tx) dab.textureDepth = Math.max(tx.minDepth, tx.depth * factor(tx.depthJitter, state, p));
    if (cd) dab.color = cd.eachTip ? dynamicColor(state, p.pressure) : (state.strokeColor ?? dynamicColor(state, p.pressure));
    out.push(dab);
  }
  state.steps++;
  return out;
}

// ---- the dual brush ----------------------------------------------------------------------

/** Advance the dual brush's own dab stream along a segment. */
function dualAlong(state: StrokeState, fx: number, fy: number, tx: number, ty: number): void {
  const d = state.params.dual;
  if (!d?.enabled) return;
  const dist = Math.hypot(tx - fx, ty - fy);
  const spacing = Math.max(0.5, d.size * Math.max(0.01, d.spacing));
  const dir = Math.atan2(ty - fy, tx - fx);
  const emit = (x: number, y: number) => {
    for (let n = 0; n < Math.max(1, d.count); n++) {
      const across = (state.rand() * 2 - 1) * d.scatter * d.size;
      const along = d.bothAxes ? (state.rand() * 2 - 1) * d.scatter * d.size : 0;
      state.dualRecent.push({
        x: x - Math.sin(dir) * across + Math.cos(dir) * along,
        y: y + Math.cos(dir) * across + Math.sin(dir) * along,
        radius: d.size / 2,
        angle: d.flip ? state.rand() * Math.PI * 2 : 0,
        roundness: 1,
        flipX: d.flip && state.rand() < 0.5,
        flipY: d.flip && state.rand() < 0.5,
      });
    }
    if (state.dualRecent.length > 96) state.dualRecent.splice(0, state.dualRecent.length - 96);
  };
  if (state.dualRecent.length === 0) emit(fx, fy);
  if (dist <= 0) return;
  let toNext = spacing - state.dualCarry;
  let lastAt = -1;
  while (toNext <= dist) {
    const t = toNext / dist;
    emit(fx + (tx - fx) * t, fy + (ty - fy) * t);
    lastAt = toNext;
    toNext += spacing;
  }
  state.dualCarry = lastAt >= 0 ? dist - lastAt : state.dualCarry + dist;
}

/** The dual stamps that overlap a dab (the nearest eight). */
function attachDual(state: StrokeState, dab: Dab): void {
  if (!state.params.dual?.enabled) return;
  const near = state.dualRecent
    .map((s) => ({ s, d: Math.hypot(s.x - dab.x, s.y - dab.y) }))
    .filter((e) => e.d < dab.radius + e.s.radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map((e) => e.s);
  dab.dual = near;
}

// ---- symmetry ----------------------------------------------------------------------------

type Mirror = { a: number; b: number; c: number; d: number; flip: boolean };

/** The maps of a symmetry: rotations and reflections about its centre. */
export function symmetryMaps(s: Symmetry | undefined): Mirror[] {
  const id: Mirror = { a: 1, b: 0, c: 0, d: 1, flip: false };
  if (!s || s.mode === 'off') return [id];
  const rot = (t: number): Mirror => ({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t), flip: false });
  // A reflection across a line through the centre at angle t.
  const ref = (t: number): Mirror => ({ a: Math.cos(2 * t), b: Math.sin(2 * t), c: Math.sin(2 * t), d: -Math.cos(2 * t), flip: true });
  const th = (s.angle * Math.PI) / 180;
  const n = Math.max(2, Math.min(12, Math.round(s.segments)));
  switch (s.mode) {
    case 'vertical':
      return [id, ref(th + Math.PI / 2)];
    case 'horizontal':
      return [id, ref(th)];
    case 'dualAxis':
      return [id, ref(th), ref(th + Math.PI / 2), rot(Math.PI)];
    case 'diagonal':
      return [id, ref(th + Math.PI / 4)];
    case 'radial':
      return Array.from({ length: n }, (_, k) => (k === 0 ? id : rot((2 * Math.PI * k) / n)));
    case 'mandala':
      return Array.from({ length: n }, (_, k) => [rot((2 * Math.PI * k) / n), ref(th + (Math.PI * k) / n)]).flat().map((m, k) => (k === 0 ? id : m));
  }
}

function mirrored(dab: Dab, m: Mirror, cx: number, cy: number): Dab {
  const X = dab.x - cx;
  const Y = dab.y - cy;
  // Direction of the tip's axis, through the map; a reflection also mirrors the tip.
  const ux = Math.cos(dab.angle);
  const uy = Math.sin(dab.angle);
  const angle = Math.atan2(m.b * ux + m.d * uy, m.a * ux + m.c * uy);
  const out: Dab = { ...dab, x: cx + m.a * X + m.c * Y, y: cy + m.b * X + m.d * Y, angle };
  if (m.flip) out.flipY = !dab.flipY;
  if (dab.dual) out.dual = dab.dual.map((s) => ({ ...s, x: cx + m.a * (s.x - cx) + m.c * (s.y - cy), y: cy + m.b * (s.x - cx) + m.d * (s.y - cy) }));
  return out;
}

function withSymmetry(state: StrokeState, dabs: Dab[]): Dab[] {
  const s = state.params.symmetry;
  if (!s || s.mode === 'off') return dabs;
  const maps = symmetryMaps(s);
  return dabs.flatMap((d) => maps.map((m, i) => (i === 0 ? d : mirrored(d, m, s.cx, s.cy))));
}

// ---- the stroke --------------------------------------------------------------------------

/** Move the brush along a straight run, stamping at spacing; returns the dabs. */
function travel(state: StrokeState, tx: number, ty: number, p0: PenState, p1: PenState): Dab[] {
  const p = state.params;
  const dabs: Dab[] = [];
  const from = state.brush!;
  const dx = tx - from.x;
  const dy = ty - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) return dabs;
  state.direction = Math.atan2(dy, dx);
  if (state.initialDirection === null) state.initialDirection = state.direction;
  dualAlong(state, from.x, from.y, tx, ty);
  const spacing = Math.max(0.5, p.size * Math.max(0.01, p.spacing));
  // `carry` is how far the brush has already travelled toward the next dab. Without it,
  // spacing would restart at every sample: a fine event stream would emit no dabs at all
  // (every step shorter than the spacing) and a coarse one would clump them at each event.
  let toNext = spacing - state.carry;
  let lastAt = -1;
  while (toNext <= dist) {
    const t = toNext / dist;
    const pp: PenState = {
      pressure: p0.pressure + (p1.pressure - p0.pressure) * t,
      tiltX: p0.tiltX + (p1.tiltX - p0.tiltX) * t,
      tiltY: p0.tiltY + (p1.tiltY - p0.tiltY) * t,
      twist: p0.twist + (p1.twist - p0.twist) * t,
    };
    for (const d of stepDabs(state, from.x + dx * t, from.y + dy * t, pp)) {
      attachDual(state, d);
      dabs.push(d);
    }
    lastAt = toNext;
    toNext += spacing;
  }
  state.carry = lastAt >= 0 ? dist - lastAt : state.carry + dist;
  state.brush = { x: tx, y: ty };
  return dabs;
}

/** The effective smoothing: Adjust for Zoom lowers it zoomed in. */
function smoothingOf(state: StrokeState): number {
  const p = state.params;
  const o = p.smoothingOptions ?? DEFAULT_SMOOTHING;
  const z = state.opts.zoom ?? 1;
  const s = Math.min(0.95, Math.max(0, p.smoothing));
  return o.adjustForZoom && z > 1 ? s / z : s;
}

/** Where the brush heads for a pointer position. */
function target(state: StrokeState, x: number, y: number): { x: number; y: number } {
  const b = state.brush!;
  const o = state.params.smoothingOptions ?? DEFAULT_SMOOTHING;
  const s = smoothingOf(state);
  if (o.pulledString) {
    // The brush waits on a leash; past it, it is dragged along to the leash's length.
    const leash = (s * 60) / Math.max(1e-6, state.opts.zoom ?? 1);
    const d = Math.hypot(x - b.x, y - b.y);
    if (d <= leash) return b;
    return { x: x - ((x - b.x) / d) * leash, y: y - ((y - b.y) / d) * leash };
  }
  const pull = 1 - s;
  return { x: b.x + (x - b.x) * pull, y: b.y + (y - b.y) * pull };
}

/**
 * Consume one pointer sample and return the dabs it produced.
 *
 * Smoothing moves the brush a fraction of the way to the pointer rather than snapping to it,
 * which is what turns a shaky hand or a coarse event stream into a clean line. The fraction is
 * per sample, so a higher event rate smooths more — the same thing a real pen does.
 */
export function strokeTo(state: StrokeState, sample: StrokeSample): Dab[] {
  const p = state.params;
  const cur = pen(state, sample.pressure, sample.tiltX ?? 0, sample.tiltY ?? 0, sample.twist ?? 0);
  state.pointer = { x: sample.x, y: sample.y };

  if (!state.brush) {
    state.brush = { x: sample.x, y: sample.y };
    state.lastTime = sample.time;
    state.lastPressure = cur.pressure;
    state.lastTilt = [cur.tiltX, cur.tiltY];
    state.lastTwist = cur.twist;
    state.carry = 0;
    dualAlong(state, sample.x, sample.y, sample.x, sample.y);
    const first = stepDabs(state, sample.x, sample.y, cur);
    for (const d of first) attachDual(state, d);
    return withSymmetry(state, first);
  }

  const prev: PenState = { pressure: state.lastPressure, tiltX: state.lastTilt[0], tiltY: state.lastTilt[1], twist: state.lastTwist };
  const t = target(state, sample.x, sample.y);
  let dabs: Dab[] = [];
  const moved = Math.hypot(t.x - state.brush.x, t.y - state.brush.y) > 0;
  if (moved) dabs = travel(state, t.x, t.y, prev, cur);
  else if (p.airbrush) {
    // Held still with the airbrush on: deposit on a clock instead of on distance.
    const interval = 1000 / Math.max(1, p.airbrushRate);
    let tm = state.lastTime + interval;
    while (tm <= sample.time) {
      for (const d of stepDabs(state, state.brush.x, state.brush.y, cur)) {
        attachDual(state, d);
        dabs.push(d);
      }
      tm += interval;
    }
  }

  if (moved || p.airbrush) state.lastTime = sample.time;
  state.lastPressure = cur.pressure;
  state.lastTilt = [cur.tiltX, cur.tiltY];
  state.lastTwist = cur.twist;
  return withSymmetry(state, dabs);
}

/**
 * Stroke Catch-up: while the pointer is held still the brush keeps closing on it (called on
 * the frame clock). Only when the option is on and the brush lags.
 */
export function catchUp(state: StrokeState): Dab[] {
  const o = state.params.smoothingOptions ?? DEFAULT_SMOOTHING;
  if (!o.catchUp || !state.brush || !state.pointer || o.pulledString) return [];
  const t = target(state, state.pointer.x, state.pointer.y);
  if (Math.hypot(t.x - state.brush.x, t.y - state.brush.y) < 0.25) return [];
  const p: PenState = { pressure: state.lastPressure, tiltX: state.lastTilt[0], tiltY: state.lastTilt[1], twist: state.lastTwist };
  return withSymmetry(state, travel(state, t.x, t.y, p, p));
}

/** Catch-up on Stroke End: the brush runs the rest of the way to where the pointer let go. */
export function finishStroke(state: StrokeState): Dab[] {
  const o = state.params.smoothingOptions ?? DEFAULT_SMOOTHING;
  if (!o.catchUpOnEnd || !state.brush || !state.pointer) return [];
  const p: PenState = { pressure: state.lastPressure, tiltX: state.lastTilt[0], tiltY: state.lastTilt[1], twist: state.lastTwist };
  return withSymmetry(state, travel(state, state.pointer.x, state.pointer.y, p, p));
}

/**
 * Coverage of one computed round dab at a point, for the CPU reference and for tests. Mirrors
 * the GLSL in `dab.ts`: a hard core out to `hardness × radius`, then a smoothstep to the rim,
 * with the ellipse applied by rotating into tip space.
 */
export function dabCoverage(dab: Dab, x: number, y: number): number {
  const dx = x - dab.x;
  const dy = y - dab.y;
  const c = Math.cos(-dab.angle);
  const s = Math.sin(-dab.angle);
  const rx = dx * c - dy * s;
  const ry = (dx * s + dy * c) / dab.roundness;
  const d = Math.hypot(rx, ry);
  const inner = dab.radius * dab.hardness;
  const outer = Math.max(dab.radius, inner + 0.5);
  if (d >= outer) return 0;
  if (d <= inner) return dab.flow;
  const t = (d - inner) / (outer - inner);
  return dab.flow * (1 - t * t * (3 - 2 * t));
}
export * from './brush/coverage.js';
