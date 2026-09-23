/**
 * Shape layers and vector masks in PSD files — spec 07 §1: `vmsk`/`vsms` (the path),
 * `vscg`/`SoCo` (the fill), `vstk` (the stroke) and `vogk` (the live-shape origination),
 * through ag-psd's decoded records.
 */
import type { FillContent, PatternDef } from '@umbra/kernels/fill';
import type { Knot, Path, PathOp } from '@umbra/kernels/vector/path';
import { DEFAULT_STROKE, type StrokeStyle } from '@umbra/kernels/vector/stroke';
import { liveShapePath, type LiveShape } from '@umbra/kernels/vector/shapes';
import type { BlendMode } from '@umbra/core/blend';
import type { VectorMask, VectorStroke } from './document.js';
import { fromPsdFill, toPsdFill } from './psd-adjust.js';
import { PSD_BLEND_MODE } from '@umbra/psd';

interface AgKnot {
  linked: boolean;
  points: number[];
}
interface AgPath {
  open: boolean;
  operation?: 'exclude' | 'combine' | 'subtract' | 'intersect';
  knots: AgKnot[];
  fillRule?: 'even-odd' | 'non-zero';
}
interface AgVectorMask {
  invert?: boolean;
  disable?: boolean;
  fillStartsWithAllPixels?: boolean;
  paths: AgPath[];
}
interface Units {
  units: string;
  value: number;
}

const OP_FROM: Record<string, PathOp> = { combine: 'add', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' };
const OP_TO: Record<PathOp, AgPath['operation']> = { add: 'combine', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude' };

/** ag-psd paths (pixel units) → a Path. A component without an operation combines. */
export function pathFromPsd(paths: readonly AgPath[]): Path {
  return {
    subpaths: paths
      .filter((p) => p.knots.length)
      .map((p) => ({
        closed: !p.open,
        op: OP_FROM[p.operation ?? 'combine'] ?? 'add',
        knots: p.knots.map((k): Knot => {
          const [ix, iy, ax, ay, ox, oy] = k.points as [number, number, number, number, number, number];
          return { in: { x: ix, y: iy }, anchor: { x: ax, y: ay }, out: { x: ox, y: oy }, smooth: k.linked };
        }),
      })),
  };
}

export function pathToPsd(path: Path): AgPath[] {
  return path.subpaths.map((sp) => ({
    open: !sp.closed,
    operation: OP_TO[sp.op],
    fillRule: 'non-zero',
    knots: sp.knots.map((k) => ({ linked: k.smooth, points: [k.in.x, k.in.y, k.anchor.x, k.anchor.y, k.out.x, k.out.y] })),
  }));
}

/** A length in pixels. Points equal pixels at the 72 ppi the engine assumes (no resolution yet). */
const px = (u: Units | undefined, fallback: number) => (u ? u.value : fallback);

export function vectorMaskFromPsd(raw: unknown): { mask: VectorMask; lost: string[] } {
  const vm = raw as AgVectorMask;
  const path = pathFromPsd(vm.paths ?? []);
  const lost = vm.invert ? ['inverted vector mask (drawn uninverted)'] : [];
  return { mask: { path, enabled: !vm.disable, ...(path.subpaths.length === 0 && vm.fillStartsWithAllPixels === false ? { hideAll: true } : {}) }, lost };
}

export function vectorMaskToPsd(vm: VectorMask): AgVectorMask {
  return { paths: pathToPsd(vm.path), disable: !vm.enabled, fillStartsWithAllPixels: vm.path.subpaths.length === 0 ? !vm.hideAll : false };
}

export function strokeFromPsd(raw: unknown, patterns: readonly PatternDef[]): { stroke: VectorStroke | null; fillEnabled: boolean; lost: string[] } {
  const s = raw as {
    strokeEnabled?: boolean;
    fillEnabled?: boolean;
    lineWidth?: Units;
    lineDashOffset?: Units;
    miterLimit?: number;
    lineCapType?: StrokeStyle['cap'];
    lineJoinType?: StrokeStyle['join'];
    lineAlignment?: StrokeStyle['align'];
    lineDashSet?: Units[];
    blendMode?: string;
    opacity?: number;
    content?: unknown;
  };
  const lost: string[] = [];
  const content = s.content ? fromPsdFill(s.content, patterns) : null;
  if (s.content && !content) lost.push('shape stroke content (noise gradient or missing pattern)');
  const width = px(s.lineWidth, DEFAULT_STROKE.width);
  const style: StrokeStyle = {
    width,
    align: s.lineAlignment ?? 'center',
    cap: s.lineCapType ?? 'butt',
    join: s.lineJoinType ?? 'miter',
    miterLimit: s.miterLimit ?? 4,
    dashes: (s.lineDashSet ?? []).map((d) => d.value),
    dashOffset: px(s.lineDashOffset, 0),
  };
  const stroke: VectorStroke = {
    enabled: s.strokeEnabled !== false,
    style,
    content: content?.content ?? { type: 'solid', color: [0, 0, 0] },
    opacity: s.opacity ?? 1,
    blendMode: (PSD_BLEND_MODE[s.blendMode ?? 'normal'] ?? 'normal') as BlendMode,
  };
  return { stroke: stroke.enabled ? stroke : null, fillEnabled: s.fillEnabled !== false, lost };
}

export function strokeToPsd(stroke: VectorStroke | null, fillEnabled: boolean, source?: unknown): Record<string, unknown> {
  const s = stroke ?? { enabled: false, style: DEFAULT_STROKE, content: { type: 'solid', color: [0, 0, 0] } as FillContent, opacity: 1, blendMode: 'normal' as BlendMode };
  return {
    strokeEnabled: !!stroke?.enabled,
    fillEnabled,
    lineWidth: { units: 'Pixels', value: s.style.width },
    lineDashOffset: { units: 'Pixels', value: s.style.dashOffset },
    miterLimit: s.style.miterLimit,
    lineCapType: s.style.cap,
    lineJoinType: s.style.join,
    lineAlignment: s.style.align,
    scaleLock: false,
    strokeAdjust: false,
    lineDashSet: s.style.dashes.map((d) => ({ units: 'None', value: d })),
    blendMode: BLEND_TO_PSD[s.blendMode] ?? 'normal',
    opacity: s.opacity,
    content: toPsdFill(s.content, (source as { content?: unknown } | undefined)?.content),
    resolution: 72,
  };
}

/**
 * The live shape a `vogk` record describes, when it matches the path: rectangles (with their
 * corner radii) and ellipses. Origin types, from Photoshop's files: 1 rectangle, 2 rounded
 * rectangle, 4 line, 5 ellipse; the others stay plain paths.
 */
export function liveFromPsd(raw: unknown, path: Path): LiveShape | undefined {
  const item = (raw as { keyDescriptorList?: Record<string, unknown>[] } | undefined)?.keyDescriptorList?.[0] as
    | { keyOriginType?: number; keyOriginShapeBoundingBox?: Record<'top' | 'left' | 'bottom' | 'right', Units>; keyOriginRRectRadii?: Record<'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft', Units>; transform?: number[] }
    | undefined;
  const bb = item?.keyOriginShapeBoundingBox;
  if (!item || !bb || path.subpaths.length !== 1) return undefined;
  const t = item.transform;
  if (t && !(t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1)) return undefined;
  const x = bb.left.value;
  const y = bb.top.value;
  const w = bb.right.value - x;
  const h = bb.bottom.value - y;
  let live: LiveShape | undefined;
  if (item.keyOriginType === 1 || item.keyOriginType === 2) {
    const r = item.keyOriginRRectRadii;
    const radii: [number, number, number, number] = r ? [r.topLeft.value, r.topRight.value, r.bottomRight.value, r.bottomLeft.value] : [0, 0, 0, 0];
    live = { kind: 'rect', x, y, w, h, radii, angle: 0 };
  } else if (item.keyOriginType === 5) {
    live = { kind: 'ellipse', cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, angle: 0 };
  }
  if (!live) return undefined;
  // Only keep it if it reproduces the stored path (the file is the authority on the outline).
  const a = liveShapePath(live).subpaths[0]!.knots;
  const b = path.subpaths[0]!.knots;
  if (a.length !== b.length) return undefined;
  const near = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) < 0.51 && Math.abs(p.y - q.y) < 0.51;
  return a.every((k) => b.some((q) => near(k.anchor, q.anchor))) ? live : undefined;
}

export function liveToPsd(live: LiveShape | undefined): Record<string, unknown> | undefined {
  if (!live || (live.kind !== 'rect' && live.kind !== 'ellipse') || live.angle) return undefined;
  const u = (value: number) => ({ units: 'Pixels', value });
  const box = live.kind === 'rect' ? { x: live.x, y: live.y, w: live.w, h: live.h } : { x: live.cx - live.rx, y: live.cy - live.ry, w: live.rx * 2, h: live.ry * 2 };
  const round = live.kind === 'rect' && live.radii.some((r) => r > 0);
  return {
    keyDescriptorList: [
      {
        keyOriginType: live.kind === 'ellipse' ? 5 : round ? 2 : 1,
        keyOriginResolution: 72,
        ...(live.kind === 'rect'
          ? { keyOriginRRectRadii: { topLeft: u(live.radii[0]), topRight: u(live.radii[1]), bottomRight: u(live.radii[2]), bottomLeft: u(live.radii[3]) } }
          : {}),
        keyOriginShapeBoundingBox: { top: u(box.y), left: u(box.x), bottom: u(box.y + box.h), right: u(box.x + box.w) },
        keyOriginBoxCorners: [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x + box.w, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ],
        transform: [1, 0, 0, 1, 0, 0],
      },
    ],
  };
}

const BLEND_TO_PSD: Record<string, string> = Object.fromEntries(Object.entries(PSD_BLEND_MODE).map(([k, v]) => [v, k]));
