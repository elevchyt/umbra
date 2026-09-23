/**
 * The shape tools — spec 04 §6: Rectangle, Ellipse, Triangle, Polygon, Line and Custom
 * Shape. A drag gives a box (Shift: square, or a 45° line; Alt: from the centre); the box
 * becomes a live shape, and the engine makes a shape layer, adds to a path, or fills pixels,
 * as the tool mode says.
 */
import type { FillContent } from '@umbra/kernels/fill';
import { BUILTIN_SHAPES, fitShape, type CustomShape } from '@umbra/kernels/vector/custom';
import type { Path, PathOp, Pt } from '@umbra/kernels/vector/path';
import { liveShapePath, type LiveShape } from '@umbra/kernels/vector/shapes';
import { DEFAULT_STROKE } from '@umbra/kernels/vector/stroke';
import type { VectorStroke } from './document.js';

export type ShapeToolId = 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'customShape';
export const SHAPE_TOOLS: readonly ShapeToolId[] = ['rectangle', 'ellipse', 'triangle', 'polygon', 'line', 'customShape'];

export interface ShapeOptions {
  /** Shape: a shape layer; Path: sub-paths of the target path; Pixels: fill the active layer. */
  mode: 'shape' | 'path' | 'pixels';
  /** 'new': a new shape layer; otherwise combine into the active shape layer (or path). */
  op: 'new' | PathOp;
  fill: FillContent | null;
  stroke: VectorStroke;
  /** Corner radius (Rectangle, Triangle, Polygon). */
  radius: number;
  sides: number;
  /** Star Ratio as an indent, %: 0 = a plain polygon. */
  star: number;
  smoothCorners: boolean;
  smoothIndents: boolean;
  /** Line weight, px. */
  weight: number;
  arrowStart: boolean;
  arrowEnd: boolean;
  /** Arrowhead width and length, % of the weight and of the width. */
  arrowWidth: number;
  arrowLength: number;
  customShape: string;
  /** Pixels mode. */
  antiAlias: boolean;
}

export const DEFAULT_SHAPE_OPTIONS: ShapeOptions = {
  mode: 'shape',
  op: 'new',
  fill: { type: 'solid', color: [0, 0, 0] },
  stroke: { enabled: false, style: { ...DEFAULT_STROKE, width: 3 }, content: { type: 'solid', color: [0, 0, 0] }, opacity: 1, blendMode: 'normal' },
  radius: 0,
  sides: 5,
  star: 0,
  smoothCorners: false,
  smoothIndents: false,
  weight: 1,
  arrowStart: false,
  arrowEnd: false,
  arrowWidth: 500,
  arrowLength: 100,
  customShape: 'heart',
  antiAlias: true,
};

export const SHAPE_NAMES: Record<ShapeToolId, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  polygon: 'Polygon',
  line: 'Line',
  customShape: 'Shape',
};

/**
 * The box a drag describes. Shift makes it square (the longer side wins); Alt centres it on
 * the press point.
 */
export function dragBox(a: Pt, b: Pt, shift: boolean, alt: boolean): { x: number; y: number; w: number; h: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  if (alt) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/**
 * The shape a drag draws: a live shape (with its path), or for a custom shape just a path.
 * Null while the drag is too small to be a shape.
 */
export function shapeFromDrag(
  tool: ShapeToolId,
  a: Pt,
  b: Pt,
  shift: boolean,
  alt: boolean,
  o: ShapeOptions,
  custom: readonly CustomShape[] = BUILTIN_SHAPES,
): { live?: LiveShape; path: Path } | null {
  if (tool === 'line') {
    let e = b;
    if (shift) {
      const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      e = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    if (Math.hypot(e.x - a.x, e.y - a.y) < 0.5) return null;
    const s = alt ? { x: 2 * a.x - e.x, y: 2 * a.y - e.y } : a;
    const live: LiveShape = {
      kind: 'line',
      x0: s.x,
      y0: s.y,
      x1: e.x,
      y1: e.y,
      weight: Math.max(0.01, o.weight),
      arrowStart: o.arrowStart,
      arrowEnd: o.arrowEnd,
      arrowWidth: o.arrowWidth,
      arrowLength: o.arrowLength,
    };
    return { live, path: liveShapePath(live) };
  }
  if (tool === 'polygon') {
    // Drawn from the centre, as Photoshop's Polygon always was: the drag sets the radius and
    // turns a vertex toward the pointer; Shift snaps the turn to 15° steps.
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    if (r < 0.5) return null;
    let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90;
    if (shift) deg = Math.round(deg / 15) * 15;
    const live: LiveShape = { kind: 'polygon', cx: a.x, cy: a.y, r, sides: Math.max(3, Math.round(o.sides)), star: o.star, smoothCorners: o.smoothCorners, smoothIndents: o.smoothIndents, radius: o.radius, angle: deg };
    return { live, path: liveShapePath(live) };
  }
  const box = dragBox(a, b, shift, alt);
  if (box.w < 0.5 || box.h < 0.5) return null;
  let live: LiveShape;
  switch (tool) {
    case 'rectangle':
      live = { kind: 'rect', ...box, radii: [o.radius, o.radius, o.radius, o.radius], angle: 0 };
      break;
    case 'ellipse':
      live = { kind: 'ellipse', cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, angle: 0 };
      break;
    case 'triangle':
      live = { kind: 'triangle', ...box, radius: o.radius, angle: 0 };
      break;
    case 'customShape': {
      const shape = custom.find((c) => c.id === o.customShape) ?? custom[0];
      return shape ? { path: fitShape(shape.path, box) } : null;
    }
  }
  return { live, path: liveShapePath(live) };
}

/** How the Paths panel names a layer's own path. */
export function layerPathName(layerName: string, kind: 'shape' | 'mask'): string {
  return `${layerName} ${kind === 'shape' ? 'Shape Path' : 'Vector Mask'}`;
}
