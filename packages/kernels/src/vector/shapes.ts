/**
 * Live shapes — spec 04 §6: the parametric shapes the shape tools draw and the Properties
 * panel keeps editing (Rectangle with four corner radii, Ellipse, Triangle, Polygon and
 * star, Line with arrowheads). Each generates a Path; the parameters stay on the layer so
 * they can be changed later, as Photoshop's live shapes can.
 */
import type { Knot, Path, Pt, Subpath } from './path.js';
import { corner } from './path.js';

/** The circle-by-cubics constant: a quarter arc's handle length over its radius. */
export const KAPPA = 0.5522847498;

export type LiveShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; radii: [number, number, number, number]; angle: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; angle: number }
  | { kind: 'triangle'; x: number; y: number; w: number; h: number; radius: number; angle: number }
  | { kind: 'polygon'; cx: number; cy: number; r: number; sides: number; star: number; smoothCorners: boolean; smoothIndents: boolean; radius: number; angle: number }
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number; weight: number; arrowStart: boolean; arrowEnd: boolean; arrowWidth: number; arrowLength: number };

const closedPath = (knots: Knot[]): Path => ({ subpaths: [{ closed: true, op: 'add', knots }] });

function rotateAbout(p: Path, c: Pt, deg: number): Path {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const r = (q: Pt): Pt => ({ x: c.x + (q.x - c.x) * cs - (q.y - c.y) * sn, y: c.y + (q.x - c.x) * sn + (q.y - c.y) * cs });
  return { subpaths: p.subpaths.map((sp) => ({ ...sp, knots: sp.knots.map((k) => ({ ...k, anchor: r(k.anchor), in: r(k.in), out: r(k.out) })) })) };
}

/**
 * A polygon with rounded corners: each corner becomes two knots joined by a circular arc of
 * `radius`, clamped so neighbouring arcs never overlap.
 */
function roundedPolygon(pts: Pt[], radii: number[]): Knot[] {
  const n = pts.length;
  const knots: Knot[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const r = radii[i] ?? 0;
    if (r <= 0) {
      knots.push(corner(p.x, p.y));
      continue;
    }
    const d0 = { x: prev.x - p.x, y: prev.y - p.y };
    const d1 = { x: next.x - p.x, y: next.y - p.y };
    const l0 = Math.hypot(d0.x, d0.y);
    const l1 = Math.hypot(d1.x, d1.y);
    const u0 = { x: d0.x / l0, y: d0.y / l0 };
    const u1 = { x: d1.x / l1, y: d1.y / l1 };
    const angle = Math.acos(Math.max(-1, Math.min(1, u0.x * u1.x + u0.y * u1.y)));
    // Distance from the corner to where the arc meets each side.
    let t = r / Math.tan(angle / 2);
    t = Math.min(t, l0 / 2, l1 / 2);
    const rr = t * Math.tan(angle / 2);
    const a = { x: p.x + u0.x * t, y: p.y + u0.y * t };
    const b = { x: p.x + u1.x * t, y: p.y + u1.y * t };
    // Handle length for an arc spanning (π − angle).
    const sweep = Math.PI - angle;
    const h = (4 / 3) * Math.tan(sweep / 4) * rr;
    knots.push({ anchor: a, in: a, out: { x: a.x - u0.x * h, y: a.y - u0.y * h }, smooth: false });
    knots.push({ anchor: b, in: { x: b.x - u1.x * h, y: b.y - u1.y * h }, out: b, smooth: false });
  }
  return knots;
}

export function liveShapePath(s: LiveShape): Path {
  switch (s.kind) {
    case 'rect': {
      const x1 = s.x + s.w;
      const y1 = s.y + s.h;
      const pts = [
        { x: s.x, y: s.y },
        { x: x1, y: s.y },
        { x: x1, y: y1 },
        { x: s.x, y: y1 },
      ];
      return rotateAbout(closedPath(roundedPolygon(pts, s.radii)), { x: s.x + s.w / 2, y: s.y + s.h / 2 }, s.angle);
    }
    case 'ellipse': {
      const { cx, cy, rx, ry } = s;
      const kx = rx * KAPPA;
      const ky = ry * KAPPA;
      const knots: Knot[] = [
        { anchor: { x: cx, y: cy - ry }, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry }, smooth: true },
        { anchor: { x: cx + rx, y: cy }, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky }, smooth: true },
        { anchor: { x: cx, y: cy + ry }, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry }, smooth: true },
        { anchor: { x: cx - rx, y: cy }, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky }, smooth: true },
      ];
      return rotateAbout(closedPath(knots), { x: cx, y: cy }, s.angle);
    }
    case 'triangle': {
      const pts = [
        { x: s.x + s.w / 2, y: s.y },
        { x: s.x + s.w, y: s.y + s.h },
        { x: s.x, y: s.y + s.h },
      ];
      return rotateAbout(closedPath(roundedPolygon(pts, [s.radius, s.radius, s.radius])), { x: s.x + s.w / 2, y: s.y + s.h / 2 }, s.angle);
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(s.sides));
      const inner = s.star > 0 && s.star < 100 ? s.r * (1 - s.star / 100) : 0;
      const pts: Pt[] = [];
      const radii: number[] = [];
      const count = inner > 0 ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const outer = inner === 0 || i % 2 === 0;
        const rr = outer ? s.r : inner;
        const a = -Math.PI / 2 + (i / count) * Math.PI * 2;
        pts.push({ x: s.cx + Math.cos(a) * rr, y: s.cy + Math.sin(a) * rr });
        radii.push(outer ? (s.smoothCorners ? s.r * 0.3 : s.radius) : s.smoothIndents ? inner * 0.3 : 0);
      }
      return rotateAbout(closedPath(roundedPolygon(pts, radii)), { x: s.cx, y: s.cy }, s.angle);
    }
    case 'line': {
      // A line is a thin closed rectangle along the segment, with optional arrowheads.
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy * (s.weight / 2);
      const ny = ux * (s.weight / 2);
      const subpaths: Subpath[] = [
        { closed: true, op: 'add', knots: [corner(s.x0 + nx, s.y0 + ny), corner(s.x1 + nx, s.y1 + ny), corner(s.x1 - nx, s.y1 - ny), corner(s.x0 - nx, s.y0 - ny)] },
      ];
      const head = (tip: Pt, dir: number) => {
        const w = (s.weight * s.arrowWidth) / 100 / 2;
        const l = (s.weight * s.arrowWidth * s.arrowLength) / 10000;
        const bx = tip.x - ux * l * dir;
        const by = tip.y - uy * l * dir;
        subpaths.push({ closed: true, op: 'add', knots: [corner(tip.x, tip.y), corner(bx - uy * w, by + ux * w), corner(bx + uy * w, by - ux * w)] });
      };
      if (s.arrowEnd) head({ x: s.x1, y: s.y1 }, 1);
      if (s.arrowStart) head({ x: s.x0, y: s.y0 }, -1);
      return { subpaths };
    }
  }
}

/** The box a live shape is drawn from, for the Properties panel's W/H/X/Y. */
export function liveShapeBox(s: LiveShape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case 'rect':
    case 'triangle':
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case 'ellipse':
      return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 };
    case 'polygon':
      return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 };
    case 'line':
      return { x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1), w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) };
  }
}
