/**
 * Path rasterisation to coverage — spec 03 §7.
 *
 * Scanline with 16 sub-scanlines per pixel row and exact horizontal coverage. Each shape (a
 * sub-path, or a stroke's polygon set) yields, per sub-scanline, the x-intervals inside it by
 * its fill rule; the shapes' operations (add, subtract, intersect, exclude) are then applied
 * to those intervals exactly, in 1-D, before any coverage is accumulated. So combining shapes
 * is exact at sub-pixel precision — two shapes that abut leave no anti-aliasing seam, which
 * multiplying coverages would.
 *
 * Deterministic and dependency-free, so the worker and the tests produce the same pixels.
 */
import type { Path, PathOp, Pt } from './path.js';
import { flattenSubpath } from './path.js';

export type FillRule = 'nonzero' | 'evenodd';

export interface Shape {
  polys: Pt[][];
  op: PathOp;
  rule?: FillRule;
}

export interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const SUB = 16;

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: 1 | -1;
}

function edgesOf(polys: Pt[][]): Edge[] {
  const out: Edge[] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (a.y === b.y) continue;
      out.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 } : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 });
    }
  }
  return out.sort((a, b) => a.y0 - b.y0);
}

/** Inside intervals [a0,b0,a1,b1,…] of one shape on the horizontal line y. */
function intervals(edges: Edge[], active: Edge[], y: number, rule: FillRule, xs: { x: number; d: number }[]): number[] {
  xs.length = 0;
  for (const e of active) {
    if (y < e.y0 || y >= e.y1) continue;
    xs.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), d: e.dir });
  }
  xs.sort((a, b) => a.x - b.x);
  const out: number[] = [];
  let w = 0;
  let start = 0;
  for (const c of xs) {
    const was = rule === 'nonzero' ? w !== 0 : (w & 1) === 1;
    w += c.d;
    const now = rule === 'nonzero' ? w !== 0 : (w & 1) === 1;
    if (!was && now) start = c.x;
    else if (was && !now) out.push(start, c.x);
  }
  void edges;
  return out;
}

/** Boolean of two sorted interval lists. */
function combine(a: number[], b: number[], op: PathOp): number[] {
  const ev: { x: number; which: 0 | 1 }[] = [];
  for (const x of a) ev.push({ x, which: 0 });
  for (const x of b) ev.push({ x, which: 1 });
  ev.sort((p, q) => p.x - q.x);
  const out: number[] = [];
  let inA = false;
  let inB = false;
  const f = () => (op === 'add' ? inA || inB : op === 'subtract' ? inA && !inB : op === 'intersect' ? inA && inB : inA !== inB);
  let was = false;
  for (const e of ev) {
    if (e.which === 0) inA = !inA;
    else inB = !inB;
    const now = f();
    if (now !== was) {
      out.push(e.x);
      was = now;
    }
  }
  return out;
}

const FULL = [-1e9, 1e9];

/**
 * Rasterise shapes over an integer rectangle; coverage 0…1, row-major. The first shape's
 * operation applies against nothing, so a leading Subtract shows everything but the shape —
 * Photoshop's behaviour for a shape whose first component subtracts.
 */
export function rasterizeShapes(shapes: readonly Shape[], rect: IRect): Float32Array {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const out = new Float32Array(Math.max(0, w * h));
  if (w <= 0 || h <= 0 || shapes.length === 0) return out;
  const prepared = shapes.map((s) => ({ edges: edgesOf(s.polys), next: 0, active: [] as Edge[], op: s.op, rule: s.rule ?? 'nonzero' }));
  const xs: { x: number; d: number }[] = [];
  const row = new Float32Array(w + 2);
  const run = new Float32Array(w + 2);
  const weight = 1 / SUB;
  for (let py = 0; py < h; py++) {
    row.fill(0);
    run.fill(0);
    for (let k = 0; k < SUB; k++) {
      const y = rect.y0 + py + (k + 0.5) / SUB;
      let acc: number[] | null = null;
      for (let si = 0; si < prepared.length; si++) {
        const p = prepared[si]!;
        while (p.next < p.edges.length && p.edges[p.next]!.y0 <= y) p.active.push(p.edges[p.next++]!);
        if (p.active.length > 64) p.active = p.active.filter((e) => e.y1 > y);
        const iv = intervals(p.edges, p.active, y, p.rule, xs);
        if (acc === null) acc = p.op === 'subtract' ? combine(FULL, iv, 'subtract') : p.op === 'intersect' ? iv : iv;
        else acc = combine(acc, iv, p.op);
      }
      if (!acc) continue;
      for (let i = 0; i < acc.length; i += 2) {
        const xa = Math.max(0, acc[i]! - rect.x0);
        const xb = Math.min(w, acc[i + 1]! - rect.x0);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        if (ia === ib) {
          row[ia] = row[ia]! + (xb - xa) * weight;
          continue;
        }
        row[ia] = row[ia]! + (ia + 1 - xa) * weight;
        // Whole pixels in between go through a difference array, so long spans cost O(1).
        run[ia + 1] = run[ia + 1]! + weight;
        run[ib] = run[ib]! - weight;
        if (ib < w) row[ib] = row[ib]! + (xb - ib) * weight;
      }
    }
    let r = 0;
    const o = py * w;
    for (let x = 0; x < w; x++) {
      r += run[x]!;
      out[o + x] = Math.min(1, row[x]! + r);
    }
    for (const p of prepared) if (p.active.length > 0) p.active = p.active.filter((e) => e.y1 > rect.y0 + py + 1);
  }
  return out;
}

/** A path's fill: each sub-path a shape with its own operation. */
export function rasterizePath(path: Path, rect: IRect, rule: FillRule = 'nonzero', tolerance = 0.05): Float32Array {
  const shapes: Shape[] = path.subpaths
    .filter((sp) => sp.knots.length > 1)
    .map((sp) => ({ polys: [flattenSubpath(sp, tolerance)], op: sp.op, rule }));
  return rasterizeShapes(shapes, rect);
}
