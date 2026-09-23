/**
 * Strokes — spec 04 §6: width, alignment (centre, inside, outside), caps (butt, round,
 * square), joins (miter with a limit, round, bevel) and dashes, as Photoshop's shape stroke
 * options set them.
 *
 * A stroke becomes polygons — one per segment, join and cap, every one wound the same way —
 * filled nonzero, so where pieces overlap they simply union with no seam. Inside and outside
 * alignment use the shape's own fill: a stroke of twice the width, intersected with the fill
 * (inside) or with the fill taken away (outside). Dash lengths are in multiples of the width.
 */
import type { Path, Pt } from './path.js';
import { flattenSubpath, polygonArea } from './path.js';
import type { Shape } from './raster.js';

export interface StrokeStyle {
  width: number;
  align: 'center' | 'inside' | 'outside';
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  /** Dash and gap lengths in stroke widths; empty for a solid line. */
  dashes: number[];
  dashOffset: number;
}

export const DEFAULT_STROKE: StrokeStyle = { width: 3, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dashes: [], dashOffset: 0 };

const positive = (poly: Pt[]) => (polygonArea(poly) < 0 ? poly.reverse() : poly);

function circle(c: Pt, r: number): Pt[] {
  const n = Math.max(12, Math.min(64, Math.ceil(r * 2)));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return positive(out);
}

/** Cut a polyline into dashes (lengths in px). */
function dash(pts: Pt[], closed: boolean, pattern: number[], offset: number): Pt[][] {
  const ring = closed ? [...pts, pts[0]!] : pts;
  const total = pattern.reduce((a, b) => a + b, 0);
  if (total <= 0) return [ring];
  const out: Pt[][] = [];
  let k = 0;
  let left = pattern[0]!;
  // Start `offset` into the pattern.
  let skip = ((offset % total) + total) % total;
  while (skip > 0) {
    if (skip >= left) {
      skip -= left;
      k = (k + 1) % pattern.length;
      left = pattern[k]!;
    } else {
      left -= skip;
      skip = 0;
    }
  }
  let on = k % 2 === 0;
  let cur: Pt[] = on ? [ring[0]!] : [];
  for (let i = 0; i + 1 < ring.length; i++) {
    let a = ring[i]!;
    const b = ring[i + 1]!;
    let seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (seg > 0) {
      if (seg < left) {
        left -= seg;
        if (on) cur.push(b);
        seg = 0;
      } else {
        const t = left / seg;
        const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (on) {
          cur.push(m);
          out.push(cur);
          cur = [];
        } else cur = [m];
        on = !on;
        seg -= left;
        a = m;
        k = (k + 1) % pattern.length;
        left = pattern[k]!;
      }
    }
  }
  if (on && cur.length > 1) out.push(cur);
  return out;
}

/** Polygons covering a stroke of a polyline. */
function strokePolyline(pts: Pt[], closed: boolean, s: StrokeStyle, hw: number, polys: Pt[][]): void {
  const n = pts.length;
  if (n === 0) return;
  if (n === 1 || (n === 2 && pts[0]!.x === pts[1]!.x && pts[0]!.y === pts[1]!.y)) {
    if (s.cap === 'round') polys.push(circle(pts[0]!, hw));
    else if (s.cap === 'square') polys.push(positive([{ x: pts[0]!.x - hw, y: pts[0]!.y - hw }, { x: pts[0]!.x + hw, y: pts[0]!.y - hw }, { x: pts[0]!.x + hw, y: pts[0]!.y + hw }, { x: pts[0]!.x - hw, y: pts[0]!.y + hw }]));
    return;
  }
  const segs = closed ? n : n - 1;
  const dirOf = (i: number) => {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l, l };
  };
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = dirOf(i);
    if (d.l < 1e-9) continue;
    let ax = a.x;
    let ay = a.y;
    let bx = b.x;
    let by = b.y;
    // Square caps lengthen the first and last segments by half the width.
    if (!closed && s.cap === 'square') {
      if (i === 0) {
        ax -= d.x * hw;
        ay -= d.y * hw;
      }
      if (i === segs - 1) {
        bx += d.x * hw;
        by += d.y * hw;
      }
    }
    const nx = -d.y * hw;
    const ny = d.x * hw;
    polys.push(positive([{ x: ax + nx, y: ay + ny }, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }, { x: ax - nx, y: ay - ny }]));
  }
  // Joins at interior vertices (and all vertices of a closed ring).
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) {
    const v = pts[i]!;
    const d0 = dirOf((i - 1 + n) % n);
    const d1 = dirOf(i);
    const cross = d0.x * d1.y - d0.y * d1.x;
    const dot = d0.x * d1.x + d0.y * d1.y;
    if (Math.abs(cross) < 1e-9 && dot > 0) continue;
    // The outer side of the turn.
    const side = cross > 0 ? -1 : 1;
    const p0 = { x: v.x - d0.y * hw * side, y: v.y + d0.x * hw * side };
    const p1 = { x: v.x - d1.y * hw * side, y: v.y + d1.x * hw * side };
    const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
    // Flattened curves turn a little at every vertex: a bevel is invisible there and cheap.
    const join = turn < (5 * Math.PI) / 180 ? 'bevel' : s.join;
    if (join === 'round') polys.push(circle(v, hw));
    else if (join === 'miter') {
      const len = 1 / Math.cos((Math.PI - turn) / 2);
      if (len <= s.miterLimit) {
        const bis = { x: p0.x + p1.x - 2 * v.x, y: p0.y + p1.y - 2 * v.y };
        const bl = Math.hypot(bis.x, bis.y) || 1;
        const m = { x: v.x + (bis.x / bl) * hw * len, y: v.y + (bis.y / bl) * hw * len };
        polys.push(positive([v, p0, m, p1]));
      } else polys.push(positive([v, p0, p1]));
    } else polys.push(positive([v, p0, p1]));
  }
  if (!closed && s.cap === 'round') {
    polys.push(circle(pts[0]!, hw), circle(pts[n - 1]!, hw));
  }
}

/** The shapes to rasterise for a path's stroke. */
export function strokeShapes(path: Path, s: StrokeStyle, tolerance = 0.05): Shape[] {
  if (s.width <= 0) return [];
  const aligned = s.align !== 'center';
  const hw = aligned ? s.width : s.width / 2;
  const polys: Pt[][] = [];
  const fill: Pt[][] = [];
  for (const sp of path.subpaths) {
    if (sp.knots.length === 0) continue;
    const pts = flattenSubpath(sp, tolerance);
    const closed = sp.closed && pts.length > 2;
    if (closed) fill.push(pts);
    const pieces = s.dashes.length ? dash(pts, closed, s.dashes.map((v) => v * s.width), s.dashOffset * s.width) : [pts];
    for (const piece of pieces) strokePolyline(piece, s.dashes.length ? false : closed, s, hw, polys);
  }
  if (!aligned || fill.length === 0) return [{ polys, op: 'add', rule: 'nonzero' }];
  return [
    { polys, op: 'add', rule: 'nonzero' },
    { polys: fill, op: s.align === 'inside' ? 'intersect' : 'subtract', rule: 'nonzero' },
  ];
}
