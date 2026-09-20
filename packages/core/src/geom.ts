/** Geometry primitives. Document space is pixels, y-down, origin at canvas top-left. */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

/** Integer-ish rectangle, `x1`/`y1` exclusive. An empty rect has x1<=x0 || y1<=y0. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const EMPTY_RECT: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x0, y0, x1, y1 };
}
export function rectFromSize(w: number, h: number): Rect {
  return { x0: 0, y0: 0, x1: w, y1: h };
}
export function rectW(r: Rect): number {
  return Math.max(0, r.x1 - r.x0);
}
export function rectH(r: Rect): number {
  return Math.max(0, r.y1 - r.y0);
}
export function rectIsEmpty(r: Rect): boolean {
  return r.x1 <= r.x0 || r.y1 <= r.y0;
}
export function rectArea(r: Rect): number {
  return rectW(r) * rectH(r);
}
export function rectEq(a: Rect, b: Rect): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  if (rectIsEmpty(inner)) return true;
  return (
    inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1
  );
}

export function rectIntersect(a: Rect, b: Rect): Rect {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return rectIsEmpty(r) ? EMPTY_RECT : r;
}

export function rectUnion(a: Rect, b: Rect): Rect {
  if (rectIsEmpty(a)) return b;
  if (rectIsEmpty(b)) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function rectInflate(r: Rect, n: number): Rect {
  if (rectIsEmpty(r)) return r;
  return { x0: r.x0 - n, y0: r.y0 - n, x1: r.x1 + n, y1: r.y1 + n };
}

export function rectTranslate(r: Rect, dx: number, dy: number): Rect {
  if (rectIsEmpty(r)) return r;
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** Round outward to integer bounds. */
export function rectOuter(r: Rect): Rect {
  if (rectIsEmpty(r)) return EMPTY_RECT;
  return {
    x0: Math.floor(r.x0),
    y0: Math.floor(r.y0),
    x1: Math.ceil(r.x1),
    y1: Math.ceil(r.y1),
  };
}

/**
 * 2D affine transform, column-major like CSS/canvas:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export interface Mat2d {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat2d = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function matMul(m: Mat2d, n: Mat2d): Mat2d {
  // Returns m∘n — applies n first, then m.
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function matTranslate(tx: number, ty: number): Mat2d {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}
export function matScale(sx: number, sy = sx): Mat2d {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}
export function matRotate(rad: number): Mat2d {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

export function matApply(m: Mat2d, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function matDet(m: Mat2d): number {
  return m.a * m.d - m.b * m.c;
}

export function matInvert(m: Mat2d): Mat2d {
  const det = matDet(m);
  if (det === 0) throw new Error('matInvert: singular matrix');
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

/** Axis-aligned bounds of a rect after transforming its four corners. */
export function matMapRect(m: Mat2d, r: Rect): Rect {
  const p = [
    matApply(m, r.x0, r.y0),
    matApply(m, r.x1, r.y0),
    matApply(m, r.x0, r.y1),
    matApply(m, r.x1, r.y1),
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of p) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

/** Column-major mat3 for WebGL uniforms. */
export function matToMat3(m: Mat2d): Float32Array {
  return new Float32Array([m.a, m.b, 0, m.c, m.d, 0, m.e, m.f, 1]);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
