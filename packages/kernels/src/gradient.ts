/**
 * Gradients — spec 04 §6.
 *
 * A gradient is colour stops plus opacity stops plus a geometry. Photoshop keeps the two stop
 * lists independent (they sit on opposite sides of the editor's ramp and need not line up), so
 * they are separate here too rather than being merged into RGBA stops — merging them would
 * force a stop on one side wherever the other has one and change the interpolation.
 *
 * The geometry functions all reduce to "t at this point", so adding a style is one function.
 */

export interface ColorStop {
  /** 0…1 along the ramp. */
  at: number;
  /** Straight RGB, 0…1. */
  color: [number, number, number];
  /**
   * 0…1; where the blend between this stop and the next is at its halfway point. Photoshop
   * shows it as the small diamond between two stops, and 0.5 is a plain linear blend.
   */
  midpoint?: number;
}

export interface OpacityStop {
  at: number;
  /** 0…1 */
  opacity: number;
  midpoint?: number;
}

export interface Gradient {
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  /** Photoshop's "Smoothness" is not modelled; these are classic linear-interpolated stops. */
  name?: string;
}

export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export const FOREGROUND_TO_BACKGROUND = (
  fg: [number, number, number],
  bg: [number, number, number],
): Gradient => ({
  colorStops: [
    { at: 0, color: fg },
    { at: 1, color: bg },
  ],
  opacityStops: [
    { at: 0, opacity: 1 },
    { at: 1, opacity: 1 },
  ],
  name: 'Foreground to Background',
});

export const FOREGROUND_TO_TRANSPARENT = (fg: [number, number, number]): Gradient => ({
  colorStops: [
    { at: 0, color: fg },
    { at: 1, color: fg },
  ],
  opacityStops: [
    { at: 0, opacity: 1 },
    { at: 1, opacity: 0 },
  ],
  name: 'Foreground to Transparent',
});

/**
 * Apply a stop's midpoint to the raw 0…1 position between it and the next.
 *
 * The midpoint says where the blend reaches 50%, so the curve is a power that maps `m` to 0.5:
 * `t^(ln 0.5 / ln m)`. At m = 0.5 the exponent is 1 and nothing happens, which is why the
 * default costs nothing.
 */
function applyMidpoint(t: number, midpoint: number | undefined): number {
  if (midpoint === undefined || midpoint === 0.5) return t;
  const m = Math.min(0.999, Math.max(0.001, midpoint));
  return Math.pow(t, Math.log(0.5) / Math.log(m));
}

function span<T extends { at: number; midpoint?: number }>(
  stops: readonly T[],
  t: number,
): { a: T; b: T; f: number } {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (t <= first.at) return { a: first, b: first, f: 0 };
  if (t >= last.at) return { a: last, b: last, f: 0 };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t <= b.at) {
      const width = b.at - a.at;
      const raw = width <= 0 ? 0 : (t - a.at) / width;
      return { a, b, f: applyMidpoint(raw, a.midpoint) };
    }
  }
  return { a: last, b: last, f: 0 };
}

/** Sample the ramp. Returns straight RGB plus alpha, both 0…1. */
export function sampleGradient(g: Gradient, t: number): [number, number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const c = span(g.colorStops, clamped);
  const o = span(g.opacityStops, clamped);
  return [
    c.a.color[0] + (c.b.color[0] - c.a.color[0]) * c.f,
    c.a.color[1] + (c.b.color[1] - c.a.color[1]) * c.f,
    c.a.color[2] + (c.b.color[2] - c.a.color[2]) * c.f,
    o.a.opacity + (o.b.opacity - o.a.opacity) * o.f,
  ];
}

/** Build a lookup table, so a full-canvas fill samples the stops `steps` times, not per pixel. */
export function gradientRamp(g: Gradient, steps = 256): Uint8Array {
  const out = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    const [r, gg, b, a] = sampleGradient(g, i / (steps - 1));
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(gg * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/**
 * Position along the gradient for a point, given the drag from (x0,y0) to (x1,y1).
 *
 * Every style is a different way of turning the drag into a scalar field; the ramp lookup is
 * identical afterwards. Values outside 0…1 are returned as-is so the caller can decide between
 * clamping (Photoshop's default) and the Reverse/Repeat options.
 */
export function gradientT(
  style: GradientStyle,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x: number,
  y: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;

  switch (style) {
    case 'linear': {
      if (len2 === 0) return 0;
      return ((x - x0) * dx + (y - y0) * dy) / len2;
    }
    case 'radial': {
      const r = Math.sqrt(len2);
      if (r === 0) return 1;
      return Math.hypot(x - x0, y - y0) / r;
    }
    case 'angle': {
      // A full turn around the start point, measured from the drag direction.
      const a = Math.atan2(y - y0, x - x0) - Math.atan2(dy, dx);
      const turn = a / (Math.PI * 2);
      return turn - Math.floor(turn);
    }
    case 'reflected': {
      if (len2 === 0) return 0;
      return Math.abs(((x - x0) * dx + (y - y0) * dy) / len2);
    }
    case 'diamond': {
      const r = Math.sqrt(len2);
      if (r === 0) return 1;
      // Rotate into the drag's frame, then use the L1 distance — that is what makes it a
      // diamond rather than a circle.
      const ux = dx / r;
      const uy = dy / r;
      const px = x - x0;
      const py = y - y0;
      const along = px * ux + py * uy;
      const across = -px * uy + py * ux;
      return (Math.abs(along) + Math.abs(across)) / r;
    }
  }
}
