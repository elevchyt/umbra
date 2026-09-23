/**
 * The vector tools — spec 04 §6: Pen, Freeform Pen, Curvature Pen, Add/Delete Anchor,
 * Convert Point, Path Selection and Direct Selection, as one state machine over a target
 * path.
 *
 * Input arrives in document coordinates with the view scale, so hit tests are in screen
 * pixels (a handle is as easy to grab at 1600 % as at 12 %). Each gesture edits a working
 * copy of the path; the engine commits it to history when the gesture ends, with the name
 * Photoshop's History panel gives it.
 */
import {
  corner,
  deleteKnot,
  flattenSubpath,
  insertKnot,
  nearestOnPath,
  cubicsToSubpath,
  fitCurve,
  type Knot,
  type Path,
  type PathOp,
  type Pt,
  type Subpath,
} from '@umbra/kernels/vector/index';
import { rasterizePath } from '@umbra/kernels/vector/raster';

export type VectorToolId = 'pen' | 'freeformPen' | 'curvaturePen' | 'addAnchor' | 'deleteAnchor' | 'convertPoint' | 'pathSelect' | 'directSelect';

export interface VectorPointer {
  phase: 'down' | 'move' | 'up';
  /** Document coordinates. */
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Click count, for double-clicks. */
  clicks: number;
}

export interface VectorOptions {
  autoAddDelete: boolean;
  /** Freeform Pen's Curve Fit, px. */
  curveFit: number;
  /** The operation new sub-paths are drawn with. */
  op: PathOp;
}

export const DEFAULT_VECTOR_OPTIONS: VectorOptions = { autoAddDelete: true, curveFit: 2, op: 'add' };

/** A knot reference: sub-path and knot index. */
export interface KnotRef {
  s: number;
  k: number;
}

type Drag =
  | { kind: 'newKnot'; s: number; k: number; alt: boolean; closing: boolean }
  | { kind: 'knots'; start: Pt; orig: Path }
  | { kind: 'handle'; s: number; k: number; which: 'in' | 'out'; alt: boolean }
  | { kind: 'subpaths'; start: Pt; orig: Path; duplicate: boolean }
  | { kind: 'marquee'; start: Pt; now: Pt }
  | { kind: 'freeform'; pts: Pt[] }
  | { kind: 'convert'; s: number; k: number };

export interface GestureResult {
  /** The path after the gesture step (null = unchanged). */
  path: Path | null;
  /** History name when the gesture completes a step; null while it is still going. */
  commit: string | null;
}

const clonePath = (p: Path): Path => ({ subpaths: p.subpaths.map((s) => ({ ...s, knots: s.knots.map((k) => ({ ...k })) })) });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const addp = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shift constrains to 45° steps around `from`. */
function snap45(from: Pt, to: Pt): Pt {
  const d = sub(to, from);
  const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
  const l = Math.hypot(d.x, d.y);
  return { x: from.x + Math.cos(a) * l, y: from.y + Math.sin(a) * l };
}

export class VectorTool {
  tool: VectorToolId = 'pen';
  options: VectorOptions = { ...DEFAULT_VECTOR_OPTIONS };
  /** The open sub-path the Pen is extending, if any. */
  drawing: number | null = null;
  /** Direct Selection's selected anchors; Path Selection's selected sub-paths. */
  selected: KnotRef[] = [];
  selectedSubpaths: number[] = [];
  /** Where the pointer is, for the Pen's rubber band. */
  hover: Pt | null = null;
  /** Curvature Pen: the points clicked so far, and which are corners. */
  private curvature: { s: number; pts: Pt[]; corners: boolean[] } | null = null;
  private drag: Drag | null = null;
  private work: Path | null = null;

  /** Hit radius in document pixels at the current zoom. */
  constructor(private readonly hitPx: () => number) {}

  get marquee(): { x0: number; y0: number; x1: number; y1: number } | null {
    const d = this.drag;
    return d?.kind === 'marquee' ? { x0: Math.min(d.start.x, d.now.x), y0: Math.min(d.start.y, d.now.y), x1: Math.max(d.start.x, d.now.x), y1: Math.max(d.start.y, d.now.y) } : null;
  }

  /** The freeform trail being drawn, for the overlay. */
  get trail(): Pt[] | null {
    return this.drag?.kind === 'freeform' ? this.drag.pts : null;
  }

  get busy(): boolean {
    return this.drag !== null;
  }

  /** Forget gesture state (another path became the target, or the tool changed). */
  reset(): void {
    this.drawing = null;
    this.curvature = null;
    this.drag = null;
    this.selected = [];
    this.selectedSubpaths = [];
  }

  private hitKnot(p: Path, q: Pt): KnotRef | null {
    const r = this.hitPx();
    for (let s = p.subpaths.length - 1; s >= 0; s--) {
      const knots = p.subpaths[s]!.knots;
      for (let k = knots.length - 1; k >= 0; k--) if (dist(knots[k]!.anchor, q) <= r) return { s, k };
    }
    return null;
  }

  private hitHandle(p: Path, q: Pt): { s: number; k: number; which: 'in' | 'out' } | null {
    const r = this.hitPx();
    // Only handles that are showing: those of selected knots and their neighbours.
    for (const { s, k } of this.visibleHandleKnots(p)) {
      const kn = p.subpaths[s]?.knots[k];
      if (!kn) continue;
      if (dist(kn.out, kn.anchor) > 0.01 && dist(kn.out, q) <= r) return { s, k, which: 'out' };
      if (dist(kn.in, kn.anchor) > 0.01 && dist(kn.in, q) <= r) return { s, k, which: 'in' };
    }
    return null;
  }

  /** Knots whose handles the overlay draws. */
  visibleHandleKnots(p: Path): KnotRef[] {
    const out: KnotRef[] = [];
    const add = (s: number, k: number) => {
      const n = p.subpaths[s]?.knots.length ?? 0;
      if (n === 0) return;
      const kk = ((k % n) + n) % n;
      if (!out.some((r) => r.s === s && r.k === kk)) out.push({ s, k: kk });
    };
    for (const r of this.selected) {
      add(r.s, r.k);
      add(r.s, r.k - 1);
      add(r.s, r.k + 1);
    }
    if (this.drawing !== null) {
      const n = p.subpaths[this.drawing]?.knots.length ?? 0;
      if (n) add(this.drawing, n - 1);
    }
    return out;
  }

  private hitSubpath(p: Path, q: Pt): number | null {
    // Inside a closed sub-path's fill, or near any sub-path's outline.
    const near = nearestOnPath(p, q);
    if (near && near.distance <= this.hitPx()) return near.subpath;
    for (let s = p.subpaths.length - 1; s >= 0; s--) {
      const sp = p.subpaths[s]!;
      if (!sp.closed) continue;
      const x = Math.floor(q.x);
      const y = Math.floor(q.y);
      const cov = rasterizePath({ subpaths: [{ ...sp, op: 'add' }] }, { x0: x, y0: y, x1: x + 1, y1: y + 1 });
      if (cov[0]! > 0.5) return s;
    }
    return null;
  }

  /**
   * One pointer event. `target` is the path being edited (null: none yet — the Pen then starts
   * a Work Path). Returns the path after this step, and a history name when a step completes.
   */
  pointer(target: Path | null, e: VectorPointer): GestureResult {
    const q: Pt = { x: e.x, y: e.y };
    if (e.phase === 'move' && !this.drag) {
      this.hover = q;
      return { path: null, commit: null };
    }
    // Ctrl turns any pen into Direct Selection for the gesture, as in Photoshop.
    const tool: VectorToolId = e.ctrl && e.phase === 'down' && this.tool !== 'pathSelect' ? 'directSelect' : this.tool;
    if (e.phase === 'down') return this.down(tool, target, q, e);
    if (e.phase === 'move') return this.move(q, e);
    return this.up(q, e);
  }

  private down(tool: VectorToolId, target: Path | null, q: Pt, e: VectorPointer): GestureResult {
    const p = target ? clonePath(target) : { subpaths: [] };
    this.work = p;
    switch (tool) {
      case 'pen':
        return this.penDown(p, q, e);
      case 'freeformPen':
        this.drag = { kind: 'freeform', pts: [q] };
        return { path: null, commit: null };
      case 'curvaturePen':
        return this.curvatureDown(p, q, e);
      case 'addAnchor': {
        const near = nearestOnPath(p, q);
        if (!near || near.distance > this.hitPx()) return { path: null, commit: null };
        const next = insertKnot(p, near.subpath, near.segment, near.t);
        this.selected = [{ s: near.subpath, k: near.segment + 1 }];
        this.work = next;
        return { path: next, commit: 'Add Anchor Point' };
      }
      case 'deleteAnchor': {
        const hit = this.hitKnot(p, q);
        if (!hit) return { path: null, commit: null };
        this.selected = [];
        return { path: deleteKnot(p, hit.s, hit.k), commit: 'Delete Anchor Point' };
      }
      case 'convertPoint': {
        const h = this.hitHandle(p, q);
        if (h) {
          this.drag = { kind: 'handle', s: h.s, k: h.k, which: h.which, alt: true };
          return { path: null, commit: null };
        }
        const hit = this.hitKnot(p, q);
        if (!hit) return { path: null, commit: null };
        const kn = p.subpaths[hit.s]!.knots[hit.k]!;
        this.selected = [hit];
        const hasHandles = dist(kn.in, kn.anchor) > 0.01 || dist(kn.out, kn.anchor) > 0.01;
        if (hasHandles) {
          // A click retracts the handles into a corner; a drag pulls new smooth ones out.
          p.subpaths[hit.s]!.knots[hit.k] = corner(kn.anchor.x, kn.anchor.y);
        }
        this.drag = { kind: 'convert', s: hit.s, k: hit.k };
        return { path: p, commit: null };
      }
      case 'pathSelect': {
        const s = this.hitSubpath(p, q);
        if (s === null) {
          this.selectedSubpaths = [];
          this.drag = { kind: 'marquee', start: q, now: q };
          return { path: null, commit: null };
        }
        if (e.shift) this.selectedSubpaths = this.selectedSubpaths.includes(s) ? this.selectedSubpaths.filter((x) => x !== s) : [...this.selectedSubpaths, s];
        else if (!this.selectedSubpaths.includes(s)) this.selectedSubpaths = [s];
        // Alt-drag duplicates the selection and moves the copy.
        if (e.alt) {
          const copies = this.selectedSubpaths.map((i) => ({ ...p.subpaths[i]!, knots: p.subpaths[i]!.knots.map((k) => ({ ...k })) }));
          const base = p.subpaths.length;
          p.subpaths.push(...copies);
          this.selectedSubpaths = copies.map((_, i) => base + i);
        }
        this.drag = { kind: 'subpaths', start: q, orig: clonePath(p), duplicate: e.alt };
        return { path: e.alt ? p : null, commit: null };
      }
      case 'directSelect': {
        const h = this.hitHandle(p, q);
        if (h) {
          this.drag = { kind: 'handle', s: h.s, k: h.k, which: h.which, alt: e.alt };
          return { path: null, commit: null };
        }
        const hit = this.hitKnot(p, q);
        if (hit) {
          const has = this.selected.some((r) => r.s === hit.s && r.k === hit.k);
          if (e.shift) this.selected = has ? this.selected.filter((r) => !(r.s === hit.s && r.k === hit.k)) : [...this.selected, hit];
          else if (!has) this.selected = [hit];
          this.drag = { kind: 'knots', start: q, orig: clonePath(p) };
          return { path: null, commit: null };
        }
        const near = nearestOnPath(p, q);
        if (near && near.distance <= this.hitPx()) {
          // Grabbing a segment moves the two anchors it joins.
          const n = p.subpaths[near.subpath]!.knots.length;
          this.selected = [
            { s: near.subpath, k: near.segment },
            { s: near.subpath, k: (near.segment + 1) % n },
          ];
          this.drag = { kind: 'knots', start: q, orig: clonePath(p) };
          return { path: null, commit: null };
        }
        if (!e.shift) this.selected = [];
        this.drag = { kind: 'marquee', start: q, now: q };
        return { path: null, commit: null };
      }
    }
  }

  private penDown(p: Path, q: Pt, e: VectorPointer): GestureResult {
    if (this.drawing !== null && !p.subpaths[this.drawing]) this.drawing = null;
    if (this.drawing === null) {
      // Not drawing: Auto Add/Delete edits the path under the pointer; handles can be dragged.
      const h = this.hitHandle(p, q);
      if (h) {
        this.drag = { kind: 'handle', s: h.s, k: h.k, which: h.which, alt: e.alt };
        return { path: null, commit: null };
      }
      const hit = this.hitKnot(p, q);
      if (hit && this.options.autoAddDelete) {
        const sp = p.subpaths[hit.s]!;
        // Clicking an END of an open sub-path continues it from there.
        if (!sp.closed && (hit.k === sp.knots.length - 1 || hit.k === 0)) {
          if (hit.k === 0) p.subpaths[hit.s] = { ...sp, knots: [...sp.knots].reverse().map((k) => ({ ...k, in: k.out, out: k.in })) };
          this.drawing = hit.s;
          this.selected = [{ s: hit.s, k: sp.knots.length - 1 }];
          return { path: p, commit: null };
        }
        this.selected = [];
        return { path: deleteKnot(p, hit.s, hit.k), commit: 'Delete Anchor Point' };
      }
      const near = nearestOnPath(p, q);
      if (near && near.distance <= this.hitPx() && this.options.autoAddDelete) {
        this.selected = [{ s: near.subpath, k: near.segment + 1 }];
        return { path: insertKnot(p, near.subpath, near.segment, near.t), commit: 'Add Anchor Point' };
      }
      // A new sub-path.
      p.subpaths.push({ closed: false, op: this.options.op, knots: [corner(q.x, q.y)] });
      this.drawing = p.subpaths.length - 1;
      this.selected = [{ s: this.drawing, k: 0 }];
      this.drag = { kind: 'newKnot', s: this.drawing, k: 0, alt: e.alt, closing: false };
      return { path: p, commit: null };
    }
    const s = this.drawing;
    const sp = p.subpaths[s]!;
    const first = sp.knots[0]!;
    // Clicking the first anchor closes the sub-path; a drag then shapes its handles.
    if (sp.knots.length > 1 && dist(first.anchor, q) <= this.hitPx()) {
      p.subpaths[s] = { ...sp, closed: true };
      this.drag = { kind: 'newKnot', s, k: 0, alt: e.alt, closing: true };
      return { path: p, commit: null };
    }
    const last = sp.knots[sp.knots.length - 1]!;
    const at = e.shift ? snap45(last.anchor, q) : q;
    sp.knots.push(corner(at.x, at.y));
    this.selected = [{ s, k: sp.knots.length - 1 }];
    this.drag = { kind: 'newKnot', s, k: sp.knots.length - 1, alt: e.alt, closing: false };
    return { path: p, commit: null };
  }

  /** Curvature Pen: points are smoothed through automatically; a double-click makes a corner. */
  private curvatureDown(p: Path, q: Pt, e: VectorPointer): GestureResult {
    let c = this.curvature;
    if (!c || !p.subpaths[c.s]) {
      p.subpaths.push({ closed: false, op: this.options.op, knots: [] });
      c = this.curvature = { s: p.subpaths.length - 1, pts: [], corners: [] };
    }
    if (c.pts.length > 1 && dist(c.pts[0]!, q) <= this.hitPx()) {
      p.subpaths[c.s] = { ...curvatureSubpath(c.pts, c.corners, true), op: p.subpaths[c.s]!.op };
      this.curvature = null;
      return { path: p, commit: 'Close Path' };
    }
    if (e.clicks >= 2 && c.pts.length) c.corners[c.corners.length - 1] = true;
    else {
      c.pts.push(q);
      c.corners.push(false);
    }
    p.subpaths[c.s] = { ...curvatureSubpath(c.pts, c.corners, false), op: p.subpaths[c.s]!.op };
    return { path: p, commit: c.pts.length === 1 ? 'New Work Path' : 'Curvature Pen' };
  }

  private move(q: Pt, e: VectorPointer): GestureResult {
    const d = this.drag;
    const p = this.work;
    if (!d || !p) return { path: null, commit: null };
    switch (d.kind) {
      case 'newKnot': {
        // Dragging from a new anchor pulls out symmetric handles (a smooth point). Alt keeps
        // them independent: only the outgoing handle for a new point, only the incoming one
        // for the point that closes the sub-path.
        const kn = p.subpaths[d.s]!.knots[d.k]!;
        const to = e.shift ? snap45(kn.anchor, q) : q;
        if (dist(to, kn.anchor) < 0.5) return { path: null, commit: null };
        const mirror = sub(kn.anchor, sub(to, kn.anchor));
        let next: Knot;
        if (d.alt) next = d.closing ? { ...kn, in: mirror, smooth: false } : { ...kn, out: to, smooth: false };
        else next = { ...kn, out: to, in: mirror, smooth: true };
        p.subpaths[d.s]!.knots[d.k] = next;
        return { path: p, commit: null };
      }
      case 'knots': {
        const dx = q.x - d.start.x;
        const dy = q.y - d.start.y;
        const off = e.shift ? (Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy }) : { x: dx, y: dy };
        const next = clonePath(d.orig);
        for (const r of this.selected) {
          const kn = next.subpaths[r.s]?.knots[r.k];
          if (!kn) continue;
          next.subpaths[r.s]!.knots[r.k] = { ...kn, anchor: addp(kn.anchor, off), in: addp(kn.in, off), out: addp(kn.out, off) };
        }
        this.work = next;
        return { path: next, commit: null };
      }
      case 'handle': {
        const kn = p.subpaths[d.s]!.knots[d.k]!;
        const to = e.shift ? snap45(kn.anchor, q) : q;
        const other = d.which === 'in' ? 'out' : 'in';
        let next: Knot = { ...kn, [d.which]: to };
        // A smooth point keeps its handles in line: the other turns, keeping its length.
        if (kn.smooth && !d.alt && !e.alt) {
          const ol = dist(kn[other], kn.anchor);
          const dir = sub(kn.anchor, to);
          const l = Math.hypot(dir.x, dir.y) || 1;
          next = { ...next, [other]: { x: kn.anchor.x + (dir.x / l) * ol, y: kn.anchor.y + (dir.y / l) * ol } };
        } else if (d.alt || e.alt) next = { ...next, smooth: false };
        p.subpaths[d.s]!.knots[d.k] = next;
        return { path: p, commit: null };
      }
      case 'convert': {
        const kn = p.subpaths[d.s]!.knots[d.k]!;
        if (dist(q, kn.anchor) < 0.5) return { path: null, commit: null };
        p.subpaths[d.s]!.knots[d.k] = { ...kn, out: q, in: sub(kn.anchor, sub(q, kn.anchor)), smooth: true };
        return { path: p, commit: null };
      }
      case 'subpaths': {
        const off = { x: q.x - d.start.x, y: q.y - d.start.y };
        const next = clonePath(d.orig);
        for (const i of this.selectedSubpaths) {
          const sp = next.subpaths[i];
          if (!sp) continue;
          next.subpaths[i] = { ...sp, knots: sp.knots.map((k) => ({ ...k, anchor: addp(k.anchor, off), in: addp(k.in, off), out: addp(k.out, off) })) };
        }
        this.work = next;
        return { path: next, commit: null };
      }
      case 'marquee':
        d.now = q;
        return { path: null, commit: null };
      case 'freeform':
        if (dist(q, d.pts[d.pts.length - 1]!) >= 0.75) d.pts.push(q);
        return { path: null, commit: null };
    }
  }

  private up(q: Pt, e: VectorPointer): GestureResult {
    const d = this.drag;
    const p = this.work;
    this.drag = null;
    if (!d || !p) return { path: null, commit: null };
    switch (d.kind) {
      case 'newKnot':
        if (d.closing) {
          this.drawing = null;
          return { path: p, commit: 'Close Path' };
        }
        return { path: p, commit: p.subpaths[d.s]!.knots.length === 1 ? (p.subpaths.length === 1 ? 'New Work Path' : 'New Anchor Point') : 'Add Anchor Point' };
      case 'knots':
        return { path: p, commit: this.selected.length ? 'Drag Anchor' : null };
      case 'handle':
        return { path: p, commit: 'Drag Handle' };
      case 'convert':
        return { path: p, commit: 'Convert Point' };
      case 'subpaths':
        return { path: p, commit: d.duplicate ? 'Duplicate Path' : 'Drag Paths' };
      case 'marquee': {
        const m = { x0: Math.min(d.start.x, q.x), y0: Math.min(d.start.y, q.y), x1: Math.max(d.start.x, q.x), y1: Math.max(d.start.y, q.y) };
        const inside = (pt: Pt) => pt.x >= m.x0 && pt.x <= m.x1 && pt.y >= m.y0 && pt.y <= m.y1;
        if (this.tool === 'pathSelect') {
          this.selectedSubpaths = p.subpaths.map((sp, i) => (sp.knots.some((k) => inside(k.anchor)) ? i : -1)).filter((i) => i >= 0);
        } else {
          const picked: KnotRef[] = [];
          p.subpaths.forEach((sp, s) => sp.knots.forEach((k, ki) => inside(k.anchor) && picked.push({ s, k: ki })));
          this.selected = e.shift ? [...this.selected, ...picked] : picked;
        }
        return { path: null, commit: null };
      }
      case 'freeform': {
        const pts = [...d.pts, q];
        if (pts.length < 2) return { path: null, commit: null };
        const closed = pts.length > 3 && dist(pts[0]!, q) <= this.hitPx();
        const fitted = cubicsToSubpath(fitCurve(pts, this.options.curveFit, closed), closed);
        if (fitted.knots.length < 2) return { path: null, commit: null };
        p.subpaths.push({ ...fitted, op: this.options.op });
        return { path: p, commit: p.subpaths.length === 1 ? 'New Work Path' : 'Freeform Pen' };
      }
    }
  }

  /** Enter/Escape end the Pen's open sub-path; Backspace deletes the selected anchors. */
  key(target: Path | null, key: string): GestureResult {
    if (key === 'Escape' || key === 'Enter') {
      const was = this.drawing !== null || this.curvature !== null;
      this.drawing = null;
      this.curvature = null;
      if (!was) {
        this.selected = [];
        this.selectedSubpaths = [];
      }
      return { path: null, commit: null };
    }
    if ((key === 'Backspace' || key === 'Delete') && target) {
      let p = target;
      if (this.tool === 'pathSelect' && this.selectedSubpaths.length) {
        p = { subpaths: p.subpaths.filter((_, i) => !this.selectedSubpaths.includes(i)) };
        this.selectedSubpaths = [];
        return { path: p, commit: 'Delete Path' };
      }
      if (this.selected.length) {
        // Delete from the highest index down so earlier indices stay valid.
        for (const r of [...this.selected].sort((a, b) => b.s - a.s || b.k - a.k)) p = deleteKnot(p, r.s, r.k);
        this.selected = [];
        this.drawing = null;
        return { path: p, commit: 'Delete Anchor Point' };
      }
    }
    return { path: null, commit: null };
  }
}

/**
 * The Curvature Pen's curve through its points: each smooth point's handles run parallel to
 * the line through its neighbours (Catmull-Rom, a third of the way), corners and the ends of
 * an open curve have none. `[fit]`: Photoshop's κ-curves (Yan 2017) put the curvature maxima
 * on the points; this interpolates them with a simpler, similar-looking spline.
 */
export function curvatureSubpath(pts: Pt[], corners: boolean[], closed: boolean): Subpath {
  const n = pts.length;
  const knots: Knot[] = pts.map((p, i) => {
    const isEnd = !closed && (i === 0 || i === n - 1);
    if (corners[i] || isEnd || n < 3) return corner(p.x, p.y);
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const t = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
    return { anchor: p, in: sub(p, t), out: addp(p, t), smooth: true };
  });
  return { closed, op: 'add', knots };
}

/** Flattened outline for the overlay, in document coordinates. */
export function overlayOutline(p: Path): Pt[][] {
  return p.subpaths.map((sp) => {
    const pts = flattenSubpath(sp, 0.3);
    return sp.closed && pts.length ? [...pts, pts[0]!] : pts;
  });
}
