/**
 * Brush stroke geometry — spec 04 §2.
 *
 * Everything here is pure: pointer samples in, dabs out. The GPU only ever draws the dabs this
 * produces, so spacing, smoothing, pressure response and airbrush build-up can be tested
 * without a graphics context, and the CPU and GPU can never disagree about where a dab went.
 *
 * The distinction that matters most, and the one a naive brush gets wrong: OPACITY is the
 * ceiling for the whole stroke, FLOW is how much each dab deposits. Overlapping dabs build up
 * toward opacity and stop there. That is why dabs are accumulated in a stroke buffer and
 * composited once at the end rather than painted straight onto the layer — painting each dab
 * directly would let a slow stroke darken without limit.
 */

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
  /** Keep depositing while the pointer is held still. */
  airbrush: boolean;
  /** Dabs per second when airbrushing in place. */
  airbrushRate: number;
  /** Pen pressure scales the dab diameter. */
  pressureSize: boolean;
  /** Pen pressure scales the dab's flow. */
  pressureOpacity: boolean;
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
}

export interface StrokeSample {
  x: number;
  y: number;
  /** 0…1 */
  pressure: number;
  /** Milliseconds, monotonic. */
  time: number;
}

export interface StrokeState {
  params: BrushParams;
  /** Where the brush actually is, which lags the pointer when smoothing is on. */
  brush: { x: number; y: number } | null;
  /** Distance travelled since the last dab, so spacing is measured along the whole path. */
  carry: number;
  lastTime: number;
  lastPressure: number;
}

export function beginStroke(params: BrushParams): StrokeState {
  return {
    params,
    brush: null,
    carry: 0,
    lastTime: 0,
    lastPressure: 0.5,
  };
}

/** Dab diameter and flow for a pressure, given what pressure is mapped to. */
function dabFor(p: BrushParams, x: number, y: number, pressure: number): Dab {
  const scale = p.pressureSize ? Math.max(0.02, pressure) : 1;
  return {
    x,
    y,
    radius: (p.size * scale) / 2,
    hardness: p.hardness,
    angle: (p.angle * Math.PI) / 180,
    roundness: Math.max(0.01, p.roundness),
    flow: p.flow * (p.pressureOpacity ? Math.max(0, pressure) : 1),
  };
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
  const dabs: Dab[] = [];

  if (!state.brush) {
    state.brush = { x: sample.x, y: sample.y };
    state.lastTime = sample.time;
    state.lastPressure = sample.pressure;
    state.carry = 0;
    dabs.push(dabFor(p, sample.x, sample.y, sample.pressure));
    return dabs;
  }

  const pull = 1 - Math.min(0.95, Math.max(0, p.smoothing));
  const tx = state.brush.x + (sample.x - state.brush.x) * pull;
  const ty = state.brush.y + (sample.y - state.brush.y) * pull;

  const from = state.brush;
  const dx = tx - from.x;
  const dy = ty - from.y;
  const dist = Math.hypot(dx, dy);
  const spacing = Math.max(0.5, p.size * Math.max(0.01, p.spacing));

  if (dist > 0) {
    // `carry` is how far the brush has already travelled toward the next dab. Without it,
    // spacing would restart at every sample: a fine event stream would emit no dabs at all
    // (every step shorter than the spacing) and a coarse one would clump them at each event.
    let toNext = spacing - state.carry;
    let lastAt = -1;
    while (toNext <= dist) {
      const t = toNext / dist;
      const pressure = state.lastPressure + (sample.pressure - state.lastPressure) * t;
      dabs.push(dabFor(p, from.x + dx * t, from.y + dy * t, pressure));
      lastAt = toNext;
      toNext += spacing;
    }
    state.carry = lastAt >= 0 ? dist - lastAt : state.carry + dist;
    state.brush = { x: tx, y: ty };
  } else if (p.airbrush) {
    // Held still with the airbrush on: deposit on a clock instead of on distance.
    const interval = 1000 / Math.max(1, p.airbrushRate);
    let t = state.lastTime + interval;
    while (t <= sample.time) {
      dabs.push(dabFor(p, tx, ty, sample.pressure));
      t += interval;
    }
  }

  if (dist > 0 || p.airbrush) state.lastTime = sample.time;
  state.lastPressure = sample.pressure;
  return dabs;
}

/**
 * Coverage of one dab at a point, for the CPU reference and for tests. Mirrors the GLSL in
 * `dab.ts`: a hard core out to `hardness × radius`, then a smoothstep to the rim, with the
 * ellipse applied by rotating into tip space.
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
