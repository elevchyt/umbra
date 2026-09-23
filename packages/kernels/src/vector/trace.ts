/**
 * Coverage → outlines, for Make Work Path from a selection (spec 02 §7): marching squares at
 * the 50 % level, with edge crossings interpolated from coverage so an anti-aliased edge gives
 * a smooth contour, then fitted with Béziers at the dialog's tolerance.
 */
import type { Path, Pt } from './path.js';
import { cubicsToSubpath, fitCurve } from './fit.js';

/** Closed contours of `v > 0.5` over a w×h grid (pixel centres at +0.5). */
export function traceContours(v: ArrayLike<number>, w: number, h: number, level = 0.5): Pt[][] {
  // Pad with a border of zeros so every contour closes.
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : v[y * w + x]!);
  // Segments per cell, keyed by edge id, joined afterwards.
  const segs = new Map<string, string>();
  const pos = new Map<string, Pt>();
  const edgePoint = (x0: number, y0: number, x1: number, y1: number): string => {
    const key = x0 < x1 || (x0 === x1 && y0 < y1) ? `${x0},${y0},${x1},${y1}` : `${x1},${y1},${x0},${y0}`;
    if (!pos.has(key)) {
      const a = at(x0, y0);
      const b = at(x1, y1);
      const t = a === b ? 0.5 : (level - a) / (b - a);
      pos.set(key, { x: x0 + 0.5 + (x1 - x0) * t, y: y0 + 0.5 + (y1 - y0) * t });
    }
    return key;
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y) > level ? 1 : 0;
      const tr = at(x + 1, y) > level ? 1 : 0;
      const br = at(x + 1, y + 1) > level ? 1 : 0;
      const bl = at(x, y + 1) > level ? 1 : 0;
      const code = tl * 8 + tr * 4 + br * 2 + bl;
      if (code === 0 || code === 15) continue;
      const T = () => edgePoint(x, y, x + 1, y);
      const R = () => edgePoint(x + 1, y, x + 1, y + 1);
      const B = () => edgePoint(x, y + 1, x + 1, y + 1);
      const L = () => edgePoint(x, y, x, y + 1);
      // Directed so the inside is on the right (clockwise outer contours in y-down space).
      const link = (a: string, b: string) => segs.set(a, b);
      switch (code) {
        case 1: link(B(), L()); break;
        case 2: link(R(), B()); break;
        case 3: link(R(), L()); break;
        case 4: link(T(), R()); break;
        case 5: link(T(), L()); link(B(), R()); break;
        case 6: link(T(), B()); break;
        case 7: link(T(), L()); break;
        case 8: link(L(), T()); break;
        case 9: link(B(), T()); break;
        case 10: link(L(), B()); link(R(), T()); break;
        case 11: link(R(), T()); break;
        case 12: link(L(), R()); break;
        case 13: link(B(), R()); break;
        case 14: link(L(), B()); break;
      }
    }
  }
  const contours: Pt[][] = [];
  const used = new Set<string>();
  for (const start of segs.keys()) {
    if (used.has(start)) continue;
    const ring: Pt[] = [];
    let k: string | undefined = start;
    while (k && !used.has(k)) {
      used.add(k);
      ring.push(pos.get(k)!);
      k = segs.get(k);
    }
    if (ring.length > 2) contours.push(ring);
  }
  return contours;
}

/** A selection's outline as a path, fitted at `tolerance` px (Make Work Path's setting). */
export function coverageToPath(v: ArrayLike<number>, w: number, h: number, tolerance = 2, originX = 0, originY = 0): Path {
  return {
    subpaths: traceContours(v, w, h)
      .map((ring) => ring.map((p) => ({ x: p.x + originX, y: p.y + originY })))
      .map((ring) => cubicsToSubpath(fitCurve(ring, tolerance, true), true))
      .filter((sp) => sp.knots.length > 1)
      // Traced contours never cross, so XOR-ing them all is the even-odd fill: holes stay holes
      // and islands inside holes stay filled, whatever order the rings came in.
      .map((sp, i) => (i === 0 ? sp : { ...sp, op: 'exclude' as const })),
  };
}
