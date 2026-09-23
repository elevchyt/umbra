/**
 * Fitting Béziers to points — Philip J. Schneider, "An Algorithm for Automatically Fitting
 * Digitized Curves" (Graphics Gems, 1990) [doc]. The Freeform Pen fits the pointer's trail
 * with it; Make Work Path fits a traced selection outline. `tolerance` is Photoshop's "Curve
 * Fit" / "Tolerance" in pixels: the largest distance allowed between points and curve.
 */
import type { Cubic, Knot, Pt, Subpath } from './path.js';

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

function bezier(c: Cubic, t: number): Pt {
  const u = 1 - t;
  return add(add(mul(c[0], u * u * u), mul(c[1], 3 * u * u * t)), add(mul(c[2], 3 * u * t * t), mul(c[3], t * t * t)));
}
function bezierD1(c: Cubic, t: number): Pt {
  const u = 1 - t;
  return add(add(mul(sub(c[1], c[0]), 3 * u * u), mul(sub(c[2], c[1]), 6 * u * t)), mul(sub(c[3], c[2]), 3 * t * t));
}
function bezierD2(c: Cubic, t: number): Pt {
  const u = 1 - t;
  return add(mul(add(sub(c[2], mul(c[1], 2)), c[0]), 6 * u), mul(add(sub(c[3], mul(c[2], 2)), c[1]), 6 * t));
}

function chordParams(pts: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1]! + len(sub(pts[i]!, pts[i - 1]!)));
  const total = u[u.length - 1]! || 1;
  return u.map((v) => v / total);
}

function generate(pts: Pt[], first: number, last: number, u: number[], t1: Pt, t2: Pt): Cubic {
  const p0 = pts[first]!;
  const p3 = pts[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i]!;
    const b = 1 - t;
    const A1 = mul(t1, 3 * b * b * t);
    const A2 = mul(t2, 3 * b * t * t);
    c00 += dot(A1, A1);
    c01 += dot(A1, A2);
    c11 += dot(A2, A2);
    const tmp = sub(pts[first + i]!, add(mul(p0, b * b * b + 3 * b * b * t), mul(p3, 3 * b * t * t + t * t * t)));
    x0 += dot(A1, tmp);
    x1 += dot(A2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let a1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let a2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = len(sub(p3, p0));
  const eps = 1e-6 * seg;
  if (a1 < eps || a2 < eps) a1 = a2 = seg / 3;
  return [p0, add(p0, mul(t1, a1)), add(p3, mul(t2, a2)), p3];
}

function maxError(pts: Pt[], first: number, last: number, c: Cubic, u: number[]): { err: number; at: number } {
  let err = 0;
  let at = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const d = len(sub(bezier(c, u[i - first]!), pts[i]!)) ** 2;
    if (d > err) {
      err = d;
      at = i;
    }
  }
  return { err, at };
}

function reparameterize(pts: Pt[], first: number, u: number[], c: Cubic): number[] {
  return u.map((t, i) => {
    const d = sub(bezier(c, t), pts[first + i]!);
    const d1 = bezierD1(c, t);
    const d2 = bezierD2(c, t);
    const den = dot(d1, d1) + dot(d, d2);
    return den === 0 ? t : t - dot(d, d1) / den;
  });
}

function fitCubic(pts: Pt[], first: number, last: number, t1: Pt, t2: Pt, tol2: number, out: Cubic[]): void {
  if (last - first === 1) {
    const d = len(sub(pts[last]!, pts[first]!)) / 3;
    out.push([pts[first]!, add(pts[first]!, mul(t1, d)), add(pts[last]!, mul(t2, d)), pts[last]!]);
    return;
  }
  let u = chordParams(pts, first, last);
  let c = generate(pts, first, last, u, t1, t2);
  let { err, at } = maxError(pts, first, last, c, u);
  if (err < tol2) {
    out.push(c);
    return;
  }
  if (err < tol2 * 4) {
    for (let k = 0; k < 20; k++) {
      u = reparameterize(pts, first, u, c);
      c = generate(pts, first, last, u, t1, t2);
      ({ err, at } = maxError(pts, first, last, c, u));
      if (err < tol2) {
        out.push(c);
        return;
      }
    }
  }
  const center = unit(sub(pts[at - 1]!, pts[at + 1]!));
  fitCubic(pts, first, at, t1, center, tol2, out);
  fitCubic(pts, at, last, mul(center, -1), t2, tol2, out);
}

/** Fit cubics through a polyline (open, or closed when `closed`). */
export function fitCurve(input: Pt[], tolerance: number, closed = false): Cubic[] {
  // Drop repeated points; they make tangents undefined.
  const pts: Pt[] = [];
  for (const p of input) if (!pts.length || len(sub(p, pts[pts.length - 1]!)) > 1e-6) pts.push(p);
  if (closed && pts.length > 2) pts.push(pts[0]!);
  if (pts.length < 2) return [];
  const out: Cubic[] = [];
  const n = pts.length - 1;
  const t1 = closed ? unit(sub(pts[1]!, pts[n - 1]!)) : unit(sub(pts[1]!, pts[0]!));
  const t2 = closed ? mul(t1, -1) : unit(sub(pts[n - 1]!, pts[n]!));
  fitCubic(pts, 0, n, t1, t2, tolerance * tolerance, out);
  return out;
}

/** Cubics end to end → a sub-path. Knots whose handles line up are marked smooth. */
export function cubicsToSubpath(cubics: Cubic[], closed: boolean): Subpath {
  const knots: Knot[] = [];
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i]!;
    const prev = knots[knots.length - 1];
    if (prev) prev.out = c[1];
    else knots.push({ anchor: c[0], in: c[0], out: c[1], smooth: false });
    knots.push({ anchor: c[3], in: c[2], out: c[3], smooth: false });
  }
  if (closed && knots.length > 1) {
    const last = knots.pop()!;
    knots[0]!.in = last.in;
  }
  for (const k of knots) {
    const a = sub(k.in, k.anchor);
    const b = sub(k.out, k.anchor);
    k.smooth = len(a) > 1e-6 && len(b) > 1e-6 && Math.abs(a.x * b.y - a.y * b.x) / (len(a) * len(b)) < 0.02 && dot(a, b) < 0;
  }
  return { closed, op: 'add', knots };
}
