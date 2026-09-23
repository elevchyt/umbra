/**
 * Paths — spec 02 §7. The model is PSD's own path record: sub-paths of knots, each knot an
 * anchor with an incoming and an outgoing Bézier handle, each sub-path combined with the ones
 * before it by an operation (Photoshop's per-component path operations). A straight segment
 * is one whose handles sit on their anchors.
 *
 * Coordinates are document pixels.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Knot {
  anchor: Pt;
  /** Handle towards the previous knot. */
  in: Pt;
  /** Handle towards the next knot. */
  out: Pt;
  /** Smooth point: moving one handle turns the other to stay collinear. */
  smooth: boolean;
}

export type PathOp = 'add' | 'subtract' | 'intersect' | 'exclude';

export interface Subpath {
  closed: boolean;
  op: PathOp;
  knots: Knot[];
}

export interface Path {
  subpaths: Subpath[];
}

export const EMPTY_PATH: Path = { subpaths: [] };

/** A corner knot: both handles on the anchor. */
export const corner = (x: number, y: number): Knot => ({ anchor: { x, y }, in: { x, y }, out: { x, y }, smooth: false });

/** A cubic segment: p0, the two control points, p3. */
export type Cubic = [Pt, Pt, Pt, Pt];

/** The cubic segments of a sub-path, including the closing one when closed. */
export function segments(sp: Subpath): Cubic[] {
  const k = sp.knots;
  const out: Cubic[] = [];
  const n = sp.closed ? k.length : k.length - 1;
  for (let i = 0; i < n; i++) {
    const a = k[i]!;
    const b = k[(i + 1) % k.length]!;
    out.push([a.anchor, a.out, b.in, b.anchor]);
  }
  return out;
}

export const isLine = (c: Cubic) => near(c[0], c[1]) && near(c[2], c[3]);
const near = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

export function cubicAt(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
}

/** Split a cubic at t (de Casteljau). */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (p: Pt, q: Pt): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p01 = lerp(c[0], c[1]);
  const p12 = lerp(c[1], c[2]);
  const p23 = lerp(c[2], c[3]);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const m = lerp(p012, p123);
  return [
    [c[0], p01, p012, m],
    [m, p123, p23, c[3]],
  ];
}

/**
 * Flatten a cubic to a polyline within `tolerance` px, by recursive subdivision on the
 * control polygon's flatness. The first point is not emitted (the caller has it).
 */
export function flattenCubic(c: Cubic, tolerance: number, out: Pt[], depth = 0): void {
  if (isLine(c)) {
    out.push(c[3]);
    return;
  }
  const dx = c[3].x - c[0].x;
  const dy = c[3].y - c[0].y;
  const len = Math.hypot(dx, dy) || 1e-12;
  const dist = (p: Pt) => Math.abs((p.x - c[0].x) * dy - (p.y - c[0].y) * dx) / len;
  const flat = Math.max(dist(c[1]), dist(c[2]));
  // Degenerate chords (a loop back to the start) fall back to the control polygon's size.
  const spread = len < 1e-6 ? Math.max(Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y), Math.hypot(c[2].x - c[0].x, c[2].y - c[0].y)) : flat;
  if (spread <= tolerance || depth > 16) {
    out.push(c[3]);
    return;
  }
  const [a, b] = splitCubic(c, 0.5);
  flattenCubic(a, tolerance, out, depth + 1);
  flattenCubic(b, tolerance, out, depth + 1);
}

/** A sub-path as a polyline (closed ones repeat nothing; the ring is implied). */
export function flattenSubpath(sp: Subpath, tolerance = 0.05): Pt[] {
  if (sp.knots.length === 0) return [];
  const pts: Pt[] = [sp.knots[0]!.anchor];
  for (const c of segments(sp)) flattenCubic(c, tolerance, pts);
  if (sp.closed && pts.length > 1 && near(pts[0]!, pts[pts.length - 1]!)) pts.pop();
  return pts;
}

export function pathBounds(p: Path, tolerance = 0.5): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sp of p.subpaths) {
    for (const q of flattenSubpath(sp, tolerance)) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** Apply an affine map to every anchor and handle — exact for Béziers. */
export function transformPath(p: Path, m: { a: number; b: number; c: number; d: number; e: number; f: number }): Path {
  const tp = (q: Pt): Pt => ({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
  return { subpaths: p.subpaths.map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ ...k, anchor: tp(k.anchor), in: tp(k.in), out: tp(k.out) })) })) };
}

/** Nearest point on a path: which sub-path and segment, the parameter, and the distance. */
export function nearestOnPath(p: Path, q: Pt): { subpath: number; segment: number; t: number; point: Pt; distance: number } | null {
  let best: { subpath: number; segment: number; t: number; point: Pt; distance: number } | null = null;
  p.subpaths.forEach((sp, si) => {
    segments(sp).forEach((c, ci) => {
      // Coarse sampling, then golden refinement around the best sample.
      const N = 32;
      let bt = 0;
      let bd = Infinity;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const pt = cubicAt(c, t);
        const d = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2;
        if (d < bd) {
          bd = d;
          bt = t;
        }
      }
      let lo = Math.max(0, bt - 1 / N);
      let hi = Math.min(1, bt + 1 / N);
      for (let k = 0; k < 30; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const d1 = dist2(cubicAt(c, m1), q);
        const d2 = dist2(cubicAt(c, m2), q);
        if (d1 < d2) hi = m2;
        else lo = m1;
      }
      const t = (lo + hi) / 2;
      const point = cubicAt(c, t);
      const distance = Math.sqrt(dist2(point, q));
      if (!best || distance < best.distance) best = { subpath: si, segment: ci, t, point, distance };
    });
  });
  return best;
}
const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Add Anchor Point: split segment `segment` of sub-path `subpath` at t, keeping the curve's shape. */
export function insertKnot(p: Path, subpath: number, segment: number, t: number): Path {
  const sp = p.subpaths[subpath]!;
  const c = segments(sp)[segment]!;
  const [a, b] = splitCubic(c, t);
  const knots = [...sp.knots];
  const i = segment;
  const j = (segment + 1) % knots.length;
  const straight = isLine(c);
  knots[i] = { ...knots[i]!, out: straight ? knots[i]!.anchor : a[1] };
  knots[j] = { ...knots[j]!, in: straight ? knots[j]!.anchor : b[2] };
  const mid: Knot = { anchor: a[3], in: straight ? a[3] : a[2], out: straight ? a[3] : b[1], smooth: !straight };
  knots.splice(i + 1, 0, mid);
  return { subpaths: p.subpaths.map((s, k) => (k === subpath ? { ...s, knots } : s)) };
}

/** Delete Anchor Point: the neighbours keep their handles, so the curve closes up smoothly. */
export function deleteKnot(p: Path, subpath: number, knot: number): Path {
  const sp = p.subpaths[subpath]!;
  const knots = sp.knots.filter((_, i) => i !== knot);
  const subpaths = knots.length === 0 ? p.subpaths.filter((_, i) => i !== subpath) : p.subpaths.map((s, i) => (i === subpath ? { ...s, knots, closed: s.closed && knots.length > 2 } : s));
  return { subpaths };
}

/** Signed area of a closed polyline (positive = clockwise in y-down coordinates). */
export function polygonArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** A sub-path running the other way (same shape). */
export function reverseSubpath(sp: Subpath): Subpath {
  return { ...sp, knots: [...sp.knots].reverse().map((k) => ({ ...k, in: k.out, out: k.in })) };
}
