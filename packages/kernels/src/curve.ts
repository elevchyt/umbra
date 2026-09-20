/**
 * Interpolating curves and channel lookup tables — spec 05 §A (Curves, Gradient Map, Levels).
 *
 * Curves is a natural cubic spline through up to 16 control points, evaluated into a 256-entry
 * table. Everything downstream is a table lookup, which is what makes a stack of adjustments
 * cheap: consecutive table-shaped adjustments concatenate into one table per channel rather
 * than each costing a pass (spec 05, fusion rule).
 *
 * A natural spline can overshoot between control points; Photoshop clamps the result to the
 * output range rather than choosing a monotone spline, so the overshoot is visible as a slight
 * S near a steep segment. Clamping matches it and keeps the curve interpolating, which a
 * monotone fit would not.
 */

export interface CurvePoint {
  /** 0…1 input. */
  x: number;
  /** 0…1 output. */
  y: number;
}

/** A straight line through (0,0) and (1,1) — the identity curve. */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function isIdentityCurve(points: readonly CurvePoint[]): boolean {
  return (
    points.length === 2 &&
    points[0]!.x === 0 &&
    points[0]!.y === 0 &&
    points[1]!.x === 1 &&
    points[1]!.y === 1
  );
}

/**
 * Second derivatives for a natural cubic spline (zero curvature at both ends), by the standard
 * tridiagonal solve. Points must be sorted by x and strictly increasing.
 */
function secondDerivatives(pts: readonly CurvePoint[]): Float64Array {
  const n = pts.length;
  const y2 = new Float64Array(n);
  if (n < 3) return y2;
  const u = new Float64Array(n);

  for (let i = 1; i < n - 1; i++) {
    const sig = (pts[i]!.x - pts[i - 1]!.x) / (pts[i + 1]!.x - pts[i - 1]!.x);
    const p = sig * y2[i - 1]! + 2;
    y2[i] = (sig - 1) / p;
    u[i] =
      (pts[i + 1]!.y - pts[i]!.y) / (pts[i + 1]!.x - pts[i]!.x) -
      (pts[i]!.y - pts[i - 1]!.y) / (pts[i]!.x - pts[i - 1]!.x);
    u[i] = ((6 * u[i]!) / (pts[i + 1]!.x - pts[i - 1]!.x) - sig * u[i - 1]!) / p;
  }
  for (let i = n - 2; i >= 0; i--) y2[i] = y2[i]! * y2[i + 1]! + u[i]!;
  return y2;
}

/** Sort, drop duplicate x, and keep at most the 16 points Photoshop allows. */
export function normaliseCurve(points: readonly CurvePoint[]): CurvePoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of sorted) {
    if (out.length > 0 && Math.abs(out[out.length - 1]!.x - p.x) < 1e-9) {
      // A later point at the same input wins, which is what dragging one onto another does.
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out.slice(0, 16);
}

/**
 * Evaluate the spline at `x`. Outside the control points the curve is flat, holding the end
 * value — Photoshop does not extrapolate, and extrapolating a cubic would run away fast.
 */
export function evaluateCurve(points: readonly CurvePoint[], x: number): number {
  const pts = points.length >= 2 ? points : IDENTITY_CURVE;
  if (x <= pts[0]!.x) return clamp01(pts[0]!.y);
  const last = pts[pts.length - 1]!;
  if (x >= last.x) return clamp01(last.y);

  if (pts.length === 2) {
    const t = (x - pts[0]!.x) / (pts[1]!.x - pts[0]!.x);
    return clamp01(pts[0]!.y + (pts[1]!.y - pts[0]!.y) * t);
  }

  const y2 = secondDerivatives(pts);
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (pts[mid]!.x > x) hi = mid;
    else lo = mid;
  }
  const h = pts[hi]!.x - pts[lo]!.x;
  const a = (pts[hi]!.x - x) / h;
  const b = (x - pts[lo]!.x) / h;
  const y =
    a * pts[lo]!.y +
    b * pts[hi]!.y +
    (((a * a * a - a) * y2[lo]! + (b * b * b - b) * y2[hi]!) * (h * h)) / 6;
  return clamp01(y);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Bake a curve into a 256-entry 8-bit table. */
export function curveToLut(points: readonly CurvePoint[], size = 256): Uint8Array {
  const pts = normaliseCurve(points);
  const lut = new Uint8Array(size);
  // The spline's second derivatives are computed once for the whole table rather than per
  // entry; evaluateCurve alone would redo that solve 256 times.
  const prepared = pts.length >= 2 ? pts : IDENTITY_CURVE;
  const y2 = prepared.length >= 3 ? secondDerivatives(prepared) : null;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    lut[i] = Math.round(evaluatePrepared(prepared, y2, x) * 255);
  }
  return lut;
}

function evaluatePrepared(pts: readonly CurvePoint[], y2: Float64Array | null, x: number): number {
  if (!y2) return evaluateCurve(pts, x);
  if (x <= pts[0]!.x) return clamp01(pts[0]!.y);
  const last = pts[pts.length - 1]!;
  if (x >= last.x) return clamp01(last.y);
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (pts[mid]!.x > x) hi = mid;
    else lo = mid;
  }
  const h = pts[hi]!.x - pts[lo]!.x;
  const a = (pts[hi]!.x - x) / h;
  const b = (x - pts[lo]!.x) / h;
  return clamp01(
    a * pts[lo]!.y +
      b * pts[hi]!.y +
      (((a * a * a - a) * y2[lo]! + (b * b * b - b) * y2[hi]!) * (h * h)) / 6,
  );
}

/** The table that changes nothing. */
export function identityLut(size = 256): Uint8Array {
  const lut = new Uint8Array(size);
  for (let i = 0; i < size; i++) lut[i] = Math.round((i / (size - 1)) * 255);
  return lut;
}

export function isIdentityLut(lut: Uint8Array): boolean {
  for (let i = 0; i < lut.length; i++) if (lut[i] !== Math.round((i / (lut.length - 1)) * 255)) return false;
  return true;
}

/**
 * `b ∘ a` — the table that applies `a` then `b`.
 *
 * This is the fusion rule from spec 05: a stack of table-shaped adjustments collapses to one
 * table, so ten of them cost one lookup rather than ten. Accuracy is the cost, and it is the
 * reason the compositor fuses only 8-bit-identical adjustments.
 */
export function composeLuts(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = b[a[i]!]!;
  return out;
}

/**
 * Levels, as a table — spec 05 §A.
 *
 * `out = outBlack + (outWhite − outBlack) · clamp((v − inBlack)/(inWhite − inBlack))^(1/γ)`.
 * All inputs are 0…255 except gamma.
 */
export function levelsLut(
  inBlack: number,
  gamma: number,
  inWhite: number,
  outBlack = 0,
  outWhite = 255,
): Uint8Array {
  const lut = new Uint8Array(256);
  const span = Math.max(1e-6, inWhite - inBlack);
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < 256; i++) {
    const t = clamp01((i - inBlack) / span);
    lut[i] = Math.round(outBlack + (outWhite - outBlack) * Math.pow(t, invGamma));
  }
  return lut;
}
