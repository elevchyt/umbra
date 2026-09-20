/**
 * Active selection state — spec 02 §5.
 *
 * The selection is part of the document, so undo restores it along with the pixels. Masks are
 * treated as immutable values: an edit allocates a new buffer and the old one stays with the
 * old history state. Selections change far less often than pixels, so this costs little.
 */
import {
  border,
  combine,
  contract,
  createMask,
  expand,
  feather,
  invert,
  isEmpty,
  grow,
  magicWand,
  maskBounds,
  rasterizeEllipse,
  rasterizeLine,
  rasterizePolygon,
  rasterizeRect,
  similar,
  smooth,
  traceBoundary,
  type CombineOp,
  type Mask,
  type Point,
} from '@umbra/kernels/selection';

export interface Selection {
  readonly mask: Mask;
  readonly width: number;
  readonly height: number;
}

export function makeSelection(width: number, height: number, mask?: Mask): Selection {
  return { mask: mask ?? createMask(width, height), width, height };
}

function derive(sel: Selection, fn: (m: Mask) => void): Selection {
  const mask = Uint8Array.from(sel.mask);
  fn(mask);
  return { ...sel, mask };
}

export function selectAll(width: number, height: number): Selection {
  return makeSelection(width, height, createMask(width, height, 255));
}

export function selectionBounds(sel: Selection | null) {
  return sel ? maskBounds(sel.mask, sel) : null;
}

export function selectionIsEmpty(sel: Selection | null): boolean {
  return !sel || isEmpty(sel.mask);
}

/** Coverage at a document pixel; 1 everywhere when there is no selection. */
export function selectionAt(sel: Selection | null, x: number, y: number): number {
  if (!sel) return 1;
  if (x < 0 || y < 0 || x >= sel.width || y >= sel.height) return 0;
  return sel.mask[y * sel.width + x]! / 255;
}

export function invertSelection(sel: Selection): Selection {
  return derive(sel, (m) => invert(m));
}

export function featherSelection(sel: Selection, radius: number): Selection {
  return derive(sel, (m) => feather(m, sel, radius));
}
export function expandSelection(sel: Selection, px: number): Selection {
  return derive(sel, (m) => expand(m, sel, px));
}
export function contractSelection(sel: Selection, px: number): Selection {
  return derive(sel, (m) => contract(m, sel, px));
}
export function borderSelection(sel: Selection, px: number): Selection {
  return derive(sel, (m) => border(m, sel, px));
}
export function smoothSelection(sel: Selection, radius: number): Selection {
  return derive(sel, (m) => smooth(m, sel, radius));
}

// ---- building a selection from a tool gesture ---------------------------------------------

export type SelectShape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'ellipse'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'polygon'; points: readonly Point[] }
  | { kind: 'row'; index: number }
  | { kind: 'column'; index: number }
  | { kind: 'mask'; mask: Mask };

export interface SelectOptions {
  op: CombineOp;
  feather: number;
  antialias: boolean;
}

/**
 * Apply a tool's shape to the current selection. The shape is rasterised on its own first so
 * that feathering softens the NEW shape's edge, not the accumulated result — otherwise adding
 * to a feathered selection would blur it again each time.
 */
export function applyShape(
  current: Selection | null,
  width: number,
  height: number,
  shape: SelectShape,
  opts: SelectOptions,
): Selection {
  const shapeMask = createMask(width, height);
  const size = { width, height };

  switch (shape.kind) {
    case 'rect':
      rasterizeRect(shapeMask, size, shape, opts.antialias);
      break;
    case 'ellipse':
      rasterizeEllipse(shapeMask, size, shape, opts.antialias);
      break;
    case 'polygon':
      rasterizePolygon(shapeMask, size, shape.points, opts.antialias);
      break;
    case 'row':
      rasterizeLine(shapeMask, size, shape.index, false);
      break;
    case 'column':
      rasterizeLine(shapeMask, size, shape.index, true);
      break;
    case 'mask':
      shapeMask.set(shape.mask);
      break;
  }

  if (opts.feather > 0) feather(shapeMask, size, opts.feather);

  const base =
    opts.op === 'new' || !current ? createMask(width, height) : Uint8Array.from(current.mask);
  combine(base, shapeMask, opts.op === 'new' ? 'new' : opts.op);
  return { mask: base, width, height };
}

/**
 * Select ▸ Grow and Select ▸ Similar. Both read the composited document, because Photoshop
 * judges similarity on what is on screen rather than on the active layer alone.
 */
export function growSelection(
  sel: Selection,
  pixels: Uint8Array,
  tolerance: number,
  everywhere: boolean,
): Selection {
  return derive(sel, (m) =>
    everywhere ? similar(m, pixels, sel, tolerance) : grow(m, pixels, sel, tolerance),
  );
}

export interface WandRequest {
  x: number;
  y: number;
  tolerance: number;
  contiguous: boolean;
  antialias: boolean;
  op: CombineOp;
}

export function applyWand(
  current: Selection | null,
  pixels: Uint8Array,
  width: number,
  height: number,
  req: WandRequest,
): Selection {
  const mask = magicWand(pixels, { width, height }, Math.floor(req.x), Math.floor(req.y), {
    tolerance: req.tolerance,
    contiguous: req.contiguous,
    antialias: req.antialias,
  });
  return applyShape(current, width, height, { kind: 'mask', mask }, {
    op: req.op,
    feather: 0,
    antialias: req.antialias,
  });
}

/**
 * Boundary segments for the marching ants, in document coordinates.
 *
 * Recomputed only when the selection changes: for a complex selection this is the most
 * expensive part of showing one, and the result is stable until the mask changes.
 */
export function selectionOutline(sel: Selection | null): Float32Array {
  if (!sel) return new Float32Array(0);
  const segs = traceBoundary(sel.mask, sel);
  // x0,y0,dist0, x1,y1,dist1 per segment — the running distance drives the dash pattern.
  const out = new Float32Array(segs.length * 6);
  let dist = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const o = i * 6;
    out[o] = s.x0;
    out[o + 1] = s.y0;
    out[o + 2] = dist;
    out[o + 3] = s.x1;
    out[o + 4] = s.y1;
    out[o + 5] = dist + len;
    // Each unit edge is independent, so the dash phase is reset per segment to keep the
    // pattern uniform regardless of tracing order.
    dist += len;
  }
  return out;
}

export type { CombineOp, Mask, Point };
