/**
 * 2×3 affine matrices — spec 04 §5 (Free Transform), and the view transform's algebra.
 *
 * Stored as the six values of
 *
 *     | a c e |
 *     | b d f |
 *     | 0 0 1 |
 *
 * which is the order `DOMMatrix`, `CanvasRenderingContext2D.transform` and PSD's own
 * transform records all use, so nothing has to be transposed on the way in or out.
 */

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translate(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scale(sx: number, sy = sx): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotate(radians: number): Mat {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/** Skew angles in radians, as the Free Transform options bar's H and V fields. */
export function skew(hx: number, vy: number): Mat {
  return { a: 1, b: Math.tan(vy), c: Math.tan(hx), d: 1, e: 0, f: 0 };
}

/** `m` then `n` — i.e. `n · m`, so `apply(compose(m, n), p) === apply(n, apply(m, p))`. */
export function compose(m: Mat, n: Mat): Mat {
  return {
    a: n.a * m.a + n.c * m.b,
    b: n.b * m.a + n.d * m.b,
    c: n.a * m.c + n.c * m.d,
    d: n.b * m.c + n.d * m.d,
    e: n.a * m.e + n.c * m.f + n.e,
    f: n.b * m.e + n.d * m.f + n.f,
  };
}

export function composeAll(...ms: Mat[]): Mat {
  return ms.reduce(compose, IDENTITY);
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function determinant(m: Mat): number {
  return m.a * m.d - m.b * m.c;
}

/** Null when the matrix is singular — a transform collapsed to a line has no inverse. */
export function invert(m: Mat): Mat | null {
  const det = determinant(m);
  if (det === 0 || !Number.isFinite(det)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** Apply a transform about a pivot rather than about the origin. */
export function about(m: Mat, pivot: Pt): Mat {
  return composeAll(translate(-pivot.x, -pivot.y), m, translate(pivot.x, pivot.y));
}

export function isIdentity(m: Mat, epsilon = 1e-9): boolean {
  return (
    Math.abs(m.a - 1) < epsilon &&
    Math.abs(m.b) < epsilon &&
    Math.abs(m.c) < epsilon &&
    Math.abs(m.d - 1) < epsilon &&
    Math.abs(m.e) < epsilon &&
    Math.abs(m.f) < epsilon
  );
}

/** True when the matrix only moves pixels by whole numbers, so no resampling is needed. */
export function isIntegerTranslation(m: Mat, epsilon = 1e-6): boolean {
  return (
    Math.abs(m.a - 1) < epsilon &&
    Math.abs(m.b) < epsilon &&
    Math.abs(m.c) < epsilon &&
    Math.abs(m.d - 1) < epsilon &&
    Math.abs(m.e - Math.round(m.e)) < epsilon &&
    Math.abs(m.f - Math.round(m.f)) < epsilon
  );
}

/** Axis-aligned bounds of a rectangle's four transformed corners. */
export function transformedBounds(
  m: Mat,
  r: { x0: number; y0: number; x1: number; y1: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const pts = [
    apply(m, { x: r.x0, y: r.y0 }),
    apply(m, { x: r.x1, y: r.y0 }),
    apply(m, { x: r.x0, y: r.y1 }),
    apply(m, { x: r.x1, y: r.y1 }),
  ];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

/**
 * The transform that maps a rectangle onto an arbitrary quad.
 *
 * Free Transform's handles describe a quad, but an affine map has six degrees of freedom and a
 * quad has eight, so only three corners can be honoured exactly; the fourth follows. That is
 * exactly Photoshop's behaviour outside Distort/Perspective, which need a projective transform
 * and arrive with the warp engine.
 */
export function fromRectToQuad(
  r: { x0: number; y0: number; x1: number; y1: number },
  topLeft: Pt,
  topRight: Pt,
  bottomLeft: Pt,
): Mat {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w === 0 || h === 0) return IDENTITY;
  const a = (topRight.x - topLeft.x) / w;
  const b = (topRight.y - topLeft.y) / w;
  const c = (bottomLeft.x - topLeft.x) / h;
  const d = (bottomLeft.y - topLeft.y) / h;
  return {
    a,
    b,
    c,
    d,
    e: topLeft.x - a * r.x0 - c * r.y0,
    f: topLeft.y - b * r.x0 - d * r.y0,
  };
}

/**
 * Decompose into the numbers the Free Transform options bar shows.
 *
 * The order matches how the fields are applied: scale, then skew, then rotate. A negative
 * determinant means the transform flips, which shows up as a negative X scale.
 */
export function decompose(m: Mat): {
  scaleX: number;
  scaleY: number;
  rotation: number;
  skewX: number;
} {
  const scaleX = Math.hypot(m.a, m.b) * (determinant(m) < 0 ? -1 : 1);
  const rotation = Math.atan2(m.b, m.a);
  // Remove the rotation, then what is left of the off-diagonal is the skew.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const c2 = m.c * cos + m.d * sin;
  const d2 = -m.c * sin + m.d * cos;
  return { scaleX, scaleY: d2, rotation, skewX: d2 === 0 ? 0 : Math.atan2(c2, d2) };
}
