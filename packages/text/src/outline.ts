/**
 * Glyph outlines placed on the page — as paths (Convert to Shape / Work Path, type on path)
 * and as pixels (the type layer's plane). Each glyph fills by the nonzero rule over all its
 * contours; faux bold grows the outline by stroking it; the anti-alias modes reshape the
 * coverage ([fit]: Photoshop's are hinting-era renderers — None thresholds, Sharp and
 * Crisp steepen the edge, Strong thickens it, Smooth is the plain analytic coverage).
 */
import type { Knot, Path, Pt, Subpath } from '@umbra/kernels/vector/path';
import { flattenSubpath } from '@umbra/kernels/vector/path';
import { rasterizeShapes, type Shape } from '@umbra/kernels/vector/raster';
import { DEFAULT_STROKE, strokeShapes } from '@umbra/kernels/vector/stroke';
import type { AntiAlias, Rgb } from './style.js';
import type { PlacedGlyph, TextLayout } from './layout.js';
import { splitCubic } from '@umbra/kernels/vector/path';
import { warpMap, type WarpSpec } from './warp.js';

/** An affine map (x' = a·x + c·y + e, y' = b·x + d·y + f) from layout space to the page. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const apply = (m: Affine | undefined, p: Pt): Pt => (m ? { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f } : p);

/** A glyph's contours as sub-paths in document px (through `m` when given). */
export function glyphSubpaths(g: PlacedGlyph, m?: Affine): Subpath[] {
  return glyphSubpathsIn(g, (p) => apply(m, p));
}

/** The point map a layout draws through: its warp (if any), then `m`. */
function pointMap(layout: TextLayout, m?: Affine): ((p: Pt) => Pt) | null {
  const w = layout.warp;
  if (!w) return m ? (p) => apply(m, p) : null;
  const f = warpMap(w, layout.bounds);
  return (p) => apply(m, f(p));
}

function glyphSubpathsIn(g: PlacedGlyph, post: (p: Pt) => Pt): Subpath[] {
  const o = g.face.outline(g.gid);
  const k = g.scale;
  const map = (fx: number, fy: number): Pt => {
    // Font units (y up) → local px (y down), scaled, slanted.
    const lx = fx * k * g.sx + g.skew * fy * k * g.sy;
    const ly = -fy * k * g.sy;
    const X = g.rotate ? g.x - ly : g.x + lx;
    const Y = g.rotate ? g.y + lx : g.y + ly;
    const a = g.along;
    if (!a) return post({ x: X, y: Y });
    // Type on a path: the glyph turns with the path about its centre on the baseline.
    const d = X - a.c;
    return post({ x: a.x + d * a.cos - Y * a.sin, y: a.y + d * a.sin + Y * a.cos });
  };
  return o.contours.map((c) => {
    const knots: Knot[] = [];
    const first = map(c[0]!, c[1]!);
    knots.push({ anchor: first, in: first, out: first, smooth: false });
    for (let i = 2; i + 5 < c.length; i += 6) {
      const c1 = map(c[i]!, c[i + 1]!);
      const c2 = map(c[i + 2]!, c[i + 3]!);
      const p = map(c[i + 4]!, c[i + 5]!);
      knots[knots.length - 1]!.out = c1;
      knots.push({ anchor: p, in: c2, out: p, smooth: false });
    }
    // The closing segment returns to the first point: fold it into the first knot.
    const last = knots[knots.length - 1]!;
    if (knots.length > 1 && Math.hypot(last.anchor.x - first.x, last.anchor.y - first.y) < 1e-6) {
      knots[0]!.in = last.in;
      knots.pop();
    }
    return { closed: true, op: 'add' as const, knots };
  });
}

/**
 * The whole layout as one path, for Convert to Shape and Create Work Path. Within each glyph
 * the later contours exclude — even-odd, which is what nonzero gives for the non-overlapping
 * contours real glyphs have — and each glyph adds to what came before.
 */
export function layoutToPath(layout: TextLayout, m?: Affine): Path {
  const map = pointMap(layout, m) ?? ((p: Pt) => p);
  const warped = !!layout.warp;
  const subpaths: Subpath[] = [];
  for (const g of layout.glyphs) {
    // A warp bends each segment, so segments are split first to follow it closely.
    const sps = glyphSubpathsIn(g, (p) => p).map((sp) => (warped ? subdivide(sp, 4) : sp));
    sps.forEach((sp, i) => {
      const mapped: Subpath = { ...sp, knots: sp.knots.map((k) => ({ ...k, anchor: map(k.anchor), in: map(k.in), out: map(k.out) })) };
      subpaths.push(i === 0 ? mapped : { ...mapped, op: 'exclude' });
    });
  }
  for (const d of layout.decorations) {
    const c = (x: number, y: number): Knot => {
      const p = map({ x, y });
      return { anchor: p, in: p, out: p, smooth: false };
    };
    subpaths.push({ closed: true, op: 'add', knots: [c(d.x0, d.y0), c(d.x1, d.y0), c(d.x1, d.y1), c(d.x0, d.y1)] });
  }
  return { subpaths };
}

/** Split every segment of a closed sub-path into `n` (de Casteljau), for warping. */
function subdivide(sp: Subpath, n: number): Subpath {
  const ks = sp.knots;
  const pieces: [Pt, Pt, Pt, Pt][] = [];
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i]!;
    const b = ks[(i + 1) % ks.length]!;
    let seg: [Pt, Pt, Pt, Pt] = [a.anchor, a.out, b.in, b.anchor];
    for (let k = n; k > 1; k--) {
      const [l, r] = splitCubic(seg, 1 / k);
      pieces.push(l);
      seg = r;
    }
    pieces.push(seg);
  }
  // Knot j starts piece j; its in-handle ends the piece before it (cyclically).
  const knots: Knot[] = pieces.map((c, j) => ({ anchor: c[0], out: c[1], in: pieces[(j - 1 + pieces.length) % pieces.length]![2], smooth: false }));
  return { ...sp, knots };
}

function glyphShapes(g: PlacedGlyph, map: ((p: Pt) => Pt) | null): Shape[] {
  const sps = glyphSubpathsIn(g, (p) => p);
  const fill: Shape = { polys: sps.map((sp) => flattenSubpath(sp, 0.05)), op: 'add', rule: 'nonzero' };
  const shapes: Shape[] = [fill];
  // Faux bold: the outline stroked, centred, twice the growth wide, united with the fill.
  if (g.bold) shapes.push(...strokeShapes({ subpaths: sps }, { ...DEFAULT_STROKE, width: g.bold * 2, join: 'round' }).map((s) => ({ ...s, op: 'add' as const })));
  return map ? shapes.map((s) => ({ ...s, polys: s.polys.map((poly) => poly.map(map)) })) : shapes;
}

function glyphBox(shapes: Shape[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) for (const p of s.polys) for (const q of p) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Coverage reshaped by the anti-alias mode. */
export function antiAliasCurve(mode: AntiAlias): (c: number) => number {
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  switch (mode) {
    case 'none':
      return (c) => (c >= 0.5 ? 1 : 0);
    case 'sharp':
      return (c) => clamp((c - 0.5) * 1.35 + 0.5);
    case 'crisp':
      return (c) => clamp((c - 0.5) * 1.15 + 0.5);
    case 'strong':
      return (c) => clamp(Math.pow(c, 0.7));
    case 'smooth':
      return (c) => c;
  }
}

export interface TextBitmap {
  /** Straight (unpremultiplied) RGBA, 8-bit. */
  data: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Draw a layout into an RGBA bitmap covering `rect` (document px, integers). Glyphs are
 * composited in order, source-over, each rasterised over its own box only.
 */
export function renderLayout(layout: TextLayout, rect: { x0: number; y0: number; x1: number; y1: number }, antiAlias: AntiAlias = 'sharp', m?: Affine): TextBitmap {
  const w = Math.max(0, rect.x1 - rect.x0);
  const h = Math.max(0, rect.y1 - rect.y0);
  const acc = new Float32Array(w * h * 4); // premultiplied
  const curve = antiAliasCurve(antiAlias);
  const paint = (shapes: Shape[], color: Rgb) => {
    const b = glyphBox(shapes);
    if (!b) return;
    const r = { x0: Math.max(rect.x0, Math.floor(b.x0) - 1), y0: Math.max(rect.y0, Math.floor(b.y0) - 1), x1: Math.min(rect.x1, Math.ceil(b.x1) + 1), y1: Math.min(rect.y1, Math.ceil(b.y1) + 1) };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    const cov = rasterizeShapes(shapes, r);
    const rw = r.x1 - r.x0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const c = curve(cov[(y - r.y0) * rw + (x - r.x0)]!);
        if (c <= 0) continue;
        const o = ((y - rect.y0) * w + (x - rect.x0)) * 4;
        const keep = 1 - c;
        acc[o] = color[0] * c + acc[o]! * keep;
        acc[o + 1] = color[1] * c + acc[o + 1]! * keep;
        acc[o + 2] = color[2] * c + acc[o + 2]! * keep;
        acc[o + 3] = c + acc[o + 3]! * keep;
      }
    }
  };
  const map = pointMap(layout, m);
  for (const g of layout.glyphs) paint(glyphShapes(g, map), g.color);
  for (const d of layout.decorations) paint([{ polys: [decorationPoly(d, map)], op: 'add' }], d.color);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = acc[i * 4 + 3]!;
    if (a <= 0) continue;
    data[i * 4] = Math.round((acc[i * 4]! / a) * 255);
    data[i * 4 + 1] = Math.round((acc[i * 4 + 1]! / a) * 255);
    data[i * 4 + 2] = Math.round((acc[i * 4 + 2]! / a) * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return { data, width: w, height: h, left: rect.x0, top: rect.y0 };
}

function decorationPoly(d: { x0: number; y0: number; x1: number; y1: number }, map: ((p: Pt) => Pt) | null): Pt[] {
  // Under a warp the bar bends too: its edges are sampled along their length.
  const n = map ? 16 : 1;
  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = d.x0 + ((d.x1 - d.x0) * i) / n;
    top.push({ x, y: d.y0 });
    bottom.push({ x, y: d.y1 });
  }
  const poly = [...top, ...bottom.reverse()];
  return map ? poly.map(map) : poly;
}

/** The ink bounds of a layout (glyph outlines and decorations), document px. */
export function inkBounds(layout: TextLayout, m?: Affine): { x0: number; y0: number; x1: number; y1: number } | null {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const grow = (b: { x0: number; y0: number; x1: number; y1: number } | null) => {
    if (!b) return;
    box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  };
  const map = pointMap(layout, m);
  for (const g of layout.glyphs) grow(glyphBox(glyphShapes(g, map)));
  for (const d of layout.decorations) grow(glyphBox([{ polys: [decorationPoly(d, map)], op: 'add' }]));
  return box;
}
