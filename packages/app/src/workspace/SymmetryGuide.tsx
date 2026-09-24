/**
 * The paint symmetry's guide on the canvas — Photoshop's symmetry path. While a painting tool
 * has symmetry on, its axes (or wave, circle or spiral) are drawn over the document. Editing
 * the symmetry (choosing a type, the options bar's Transform button, or its row in the Paths
 * panel) opens a transform box round the figure, as Free Transform does:
 *
 * - corner and side handles scale it about the reference point (Shift keeps the proportions);
 * - Ctrl on a top or bottom handle skews it horizontally, on a side handle vertically;
 * - the knob above the box turns it about the reference point (Shift: 15° steps);
 * - the reference point (a crosshair, or the options bar's locator) can be put anywhere;
 * - the centre handle moves the whole figure, reference point and all;
 * - Enter commits, Esc puts it back as it was.
 *
 * Outside editing only the lines show, and nothing takes the pointer: strokes go through.
 */
import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { screenPointAtDoc, docPointAtScreen, symmetryCurve, symmetryLinear, IDENTITY_SYMMETRY_TRANSFORM, type Symmetry, type SymmetryTransform, type ViewState } from '@umbra/engine';
import { store } from '../state/store';
import { PAINT_TOOLS } from '../tools/registry';

type Pt = { x: number; y: number };
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Each box handle's place on the figure's square, in units of its half-size. */
const HANDLES: [Handle, number, number][] = [
  ['nw', -1, -1],
  ['n', 0, -1],
  ['ne', 1, -1],
  ['e', 1, 0],
  ['se', 1, 1],
  ['s', 0, 1],
  ['sw', -1, 1],
  ['w', -1, 0],
];

function viewOf(): ViewState | null {
  const s = store.stats();
  if (!s) return null;
  return { zoom: s.zoom, rotation: s.viewRotation, centre: { x: s.centreX, y: s.centreY }, width: s.viewWidth, height: s.viewHeight, devicePixelRatio: 1 };
}

/** The symmetry's placement: figure space (about the origin, angle 0) → document, and back. */
export function placementOf(s: Symmetry): { toDoc: (x: number, y: number) => Pt; toFigure: (x: number, y: number) => Pt } {
  const [a, b, c, d] = symmetryLinear(s);
  const det = a * d - b * c;
  return {
    toDoc: (x, y) => ({ x: s.cx + a * x + c * y, y: s.cy + b * x + d * y }),
    toFigure: (x, y) => ({ x: (d * (x - s.cx) - c * (y - s.cy)) / det, y: (-b * (x - s.cx) + a * (y - s.cy)) / det }),
  };
}

/** The box's half-size in figure space: the figure's own size. */
const halfOf = (s: Symmetry) => Math.max(16, s.size ?? 100);

/** Leave the transform box: keep the symmetry, or put it back as it was. */
export function endSymmetryEdit(commit: boolean): void {
  const e = store.symmetryEdit();
  if (!e) return;
  if (!commit) store.setBrush('symmetry', reconcile({ ...e.start, transform: e.start.transform ?? IDENTITY_SYMMETRY_TRANSFORM }));
  store.setSymmetryEdit(null);
}

/** Open the transform box on the current symmetry, its reference point at the centre. */
export function beginSymmetryEdit(): void {
  const s = store.brush.symmetry;
  if (!s || s.mode === 'off' || s.mode === 'path') return;
  store.setSymmetryEdit({ start: JSON.parse(JSON.stringify(s)) as Symmetry, ref: { u: 0, v: 0 } });
}

/** The reference point in the figure's frame, and on the document, for a symmetry. */
function refOf(s: Symmetry): { q: Pt; doc: Pt } {
  const r = store.symmetryEdit()?.ref ?? { u: 0, v: 0 };
  const E = halfOf(s);
  const q = { x: r.u * E, y: r.v * E };
  return { q, doc: placementOf(s).toDoc(q.x, q.y) };
}

/**
 * A new shape or angle for the symmetry that keeps the reference point where it was on the
 * document: the centre moves to make it so. The options bar's fields use this too.
 */
export function symmetryAboutRef(s: Symmetry, patch: { transform?: Partial<SymmetryTransform>; angle?: number }): Symmetry {
  const { q, doc: r } = refOf(s);
  const next: Symmetry = {
    ...s,
    ...(patch.angle !== undefined ? { angle: patch.angle } : {}),
    transform: { ...IDENTITY_SYMMETRY_TRANSFORM, ...(s.transform ?? {}), ...(patch.transform ?? {}) },
  };
  const [a, b, c, d] = symmetryLinear(next);
  return { ...next, cx: r.x - (a * q.x + c * q.y), cy: r.y - (b * q.x + d * q.y) };
}

/** Where the reference point is (the options bar's X and Y), and moving the figure to put it elsewhere. */
export function symmetryRef(): Pt | null {
  const s = store.brush.symmetry;
  return s && store.symmetryEdit() ? refOf(s).doc : null;
}
export function moveSymmetryRefTo(x: number, y: number): void {
  const s = store.brush.symmetry;
  const r = symmetryRef();
  if (!s || !r) return;
  store.setBrush('symmetry', { ...s, cx: s.cx + x - r.x, cy: s.cy + y - r.y });
}

/** The options bar's locator: the reference point to a corner, a side's middle, or the centre. */
export function setSymmetryRef(u: number, v: number): void {
  const e = store.symmetryEdit();
  if (e) store.setSymmetryEdit({ ...e, ref: { u, v } });
}

export function SymmetryGuide() {
  const sym = () => {
    const s = store.brush.symmetry;
    return s && s.mode !== 'off' && s.mode !== 'path' && PAINT_TOOLS.has(store.activeTool()) && store.doc() ? s : null;
  };
  const editing = () => !!store.symmetryEdit() && !!sym();

  // Leaving the painting tools, or turning symmetry off, commits the box.
  createEffect(() => {
    if (store.symmetryEdit() && !sym()) store.setSymmetryEdit(null);
  });
  // Enter commits, Esc cancels — not while typing in a field.
  createEffect(() => {
    if (!editing()) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      endSymmetryEdit(e.key === 'Enter');
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    onCleanup(() => window.removeEventListener('keydown', key, true));
  });

  /** The guide in document space: the figure's lines, placed. */
  const lines = createMemo(() => {
    const s = sym();
    const d = store.doc();
    if (!s || !d) return [] as Pt[][];
    const place = placementOf(s);
    const t = s.transform ?? IDENTITY_SYMMETRY_TRANSFORM;
    // Long enough in figure space to cross the canvas after the placement's scale.
    const far = (Math.hypot(d.width, d.height) * 2) / Math.max(0.05, Math.min(Math.abs(t.scaleX), Math.abs(t.scaleY)));
    const line = (a: number, off = 0): Pt[] => {
      const u = { x: Math.cos(a), y: Math.sin(a) };
      return [
        { x: -u.y * off - u.x * far, y: u.x * off - u.y * far },
        { x: -u.y * off + u.x * far, y: u.x * off + u.y * far },
      ];
    };
    const ray = (a: number): Pt[] => [{ x: 0, y: 0 }, { x: Math.cos(a) * far, y: Math.sin(a) * far }];
    const size = s.size ?? 100;
    const n = Math.max(2, Math.min(12, Math.round(s.segments)));
    let fig: Pt[][];
    switch (s.mode) {
      case 'vertical':
        fig = [line(Math.PI / 2)];
        break;
      case 'horizontal':
        fig = [line(0)];
        break;
      case 'dualAxis':
        fig = [line(0), line(Math.PI / 2)];
        break;
      case 'diagonal':
        fig = [line(Math.PI / 4)];
        break;
      case 'parallelLines':
        fig = [line(0, size / 2), line(0, -size / 2)];
        break;
      case 'radial':
        fig = Array.from({ length: n }, (_, k) => ray((2 * Math.PI * k) / n));
        break;
      case 'mandala':
        fig = Array.from({ length: 2 * n }, (_, k) => ray((Math.PI * k) / n));
        break;
      default:
        // Wavy, Circle, Spiral: the brush's own curve, laid out about the origin. (A plain
        // copy: the store merges into its object, which would defeat the curve cache.)
        fig = symmetryCurve({ ...(JSON.parse(JSON.stringify(s)) as Symmetry), cx: 0, cy: 0, angle: 0, transform: undefined });
    }
    const m = Math.max(d.width, d.height);
    return fig.map((poly) => poly.map((p) => place.toDoc(p.x, p.y)).filter((p) => p.x > -m && p.y > -m && p.x < d.width + m && p.y < d.height + m));
  });

  const toScreen = (p: Pt) => screenPointAtDoc(viewOf()!, p.x, p.y);

  /**
   * Drag part of the box. `apply` turns the pointer (document px), the symmetry as it was when
   * the drag began and where the drag began into the change to make.
   */
  const drag = (apply: (p: Pt, start: Symmetry, from: Pt, ev: PointerEvent) => Partial<Symmetry>) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    const start = JSON.parse(JSON.stringify(store.brush.symmetry)) as Symmetry;
    const at = (ev: PointerEvent) => docPointAtScreen(viewOf()!, ev.clientX - box.left, ev.clientY - box.top);
    const from = at(e);
    // Window listeners, as the other drag handles here: they follow the pointer off the handle.
    const move = (ev: PointerEvent) => {
      if (!viewOf()) return;
      const patch = apply(at(ev), start, from, ev);
      store.setBrush('symmetry', { ...start, ...patch });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const moveCentre = drag((p, s, from) => ({ cx: Math.round((s.cx + p.x - from.x) * 10) / 10, cy: Math.round((s.cy + p.y - from.y) * 10) / 10 }));

  const turn = drag((p, s, from, ev) => {
    const { doc: r } = refOf(s);
    const a0 = Math.atan2(from.y - r.y, from.x - r.x);
    const a1 = Math.atan2(p.y - r.y, p.x - r.x);
    let angle = s.angle + ((a1 - a0) * 180) / Math.PI;
    if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
    angle = Math.round((((((angle + 180) % 360) + 360) % 360) - 180) * 10) / 10;
    return symmetryAboutRef(s, { angle });
  });

  /** The reference point itself: dragged anywhere, kept in the figure's frame. */
  const moveRef = drag((p, s) => {
    const q = placementOf(s).toFigure(p.x, p.y);
    const E = halfOf(s);
    setSymmetryRef(Math.round((q.x / E) * 1000) / 1000, Math.round((q.y / E) * 1000) / 1000);
    return {};
  });

  /**
   * A box handle: scale about the reference point (Shift: proportionally); with Ctrl, a top or
   * bottom handle skews horizontally and a side handle vertically.
   */
  const scaleBy = (hx: number, hy: number) =>
    drag((p, s, _from, ev) => {
      const t = { ...IDENTITY_SYMMETRY_TRANSFORM, ...(s.transform ?? {}) };
      const E = halfOf(s);
      const { q, doc: r } = refOf(s);
      const th = (s.angle * Math.PI) / 180;
      // The pointer from the reference point, in the symmetry's turned frame.
      const dx = p.x - r.x;
      const dy = p.y - r.y;
      const vx = dx * Math.cos(th) + dy * Math.sin(th);
      const vy = -dx * Math.sin(th) + dy * Math.cos(th);
      // The handle from the reference point, in the figure's frame.
      const Dx = hx * E - q.x;
      const Dy = hy * E - q.y;
      const kx = Math.tan((t.skew * Math.PI) / 180);
      const ky = Math.tan(((t.skewY ?? 0) * Math.PI) / 180);
      const deg = (v: number) => Math.round(Math.max(-80, Math.min(80, (Math.atan(v) * 180) / Math.PI)) * 10) / 10;
      const ok = (v: number) => Number.isFinite(v) && Math.abs(v) > 1e-6;
      if ((ev.ctrlKey || ev.metaKey) && hx === 0 && hy !== 0 && ok(Dy)) return symmetryAboutRef(s, { transform: { skew: deg((vx / t.scaleX - Dx) / Dy) } });
      if ((ev.ctrlKey || ev.metaKey) && hy === 0 && hx !== 0 && ok(Dx)) return symmetryAboutRef(s, { transform: { skewY: deg((vy / t.scaleY - Dy) / Dx) } });
      const clampS = (v: number) => (Math.abs(v) < 0.05 ? 0.05 * Math.sign(v || 1) : Math.round(v * 1000) / 1000);
      let scaleX = t.scaleX;
      let scaleY = t.scaleY;
      const den = { x: Dx + kx * Dy, y: ky * Dx + Dy };
      if (hx !== 0 && ok(den.x)) scaleX = vx / den.x;
      if (hy !== 0 && ok(den.y)) scaleY = vy / den.y;
      if (ev.shiftKey && hx !== 0 && hy !== 0) {
        // Proportionally: along the handle's own direction from the reference point.
        const cx = t.scaleX * den.x;
        const cy = t.scaleY * den.y;
        const f = (vx * cx + vy * cy) / (cx * cx + cy * cy || 1);
        scaleX = t.scaleX * f;
        scaleY = t.scaleY * f;
      }
      return symmetryAboutRef(s, { transform: { scaleX: clampS(scaleX), scaleY: clampS(scaleY) } });
    });

  return (
    <Show when={sym() && viewOf()}>
      {(_) => {
        const s = () => store.brush.symmetry!;
        const canvasClip = () => {
          const d = store.doc()!;
          return [
            { x: 0, y: 0 },
            { x: d.width, y: 0 },
            { x: d.width, y: d.height },
            { x: 0, y: d.height },
          ]
            .map(toScreen)
            .map((p) => `${p.x},${p.y}`)
            .join(' ');
        };
        const pts = (poly: Pt[]) =>
          poly
            .map(toScreen)
            .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(' ');
        const corner = (hx: number, hy: number) => {
          const E = halfOf(s());
          return toScreen(placementOf(s()).toDoc(hx * E, hy * E));
        };
        const boxPoints = () => [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map((p) => `${p.x},${p.y}`).join(' ');
        const knob = () => {
          // Beyond the top edge's middle, 24 px further out on screen.
          const top = corner(0, -1);
          const c = toScreen({ x: s().cx, y: s().cy });
          const len = Math.hypot(top.x - c.x, top.y - c.y) || 1;
          return { x: top.x + ((top.x - c.x) / len) * 24, y: top.y + ((top.y - c.y) / len) * 24, fx: top.x, fy: top.y };
        };
        const centre = () => toScreen({ x: s().cx, y: s().cy });
        const refScreen = () => toScreen(refOf(s()).doc);
        return (
          <svg class="symmetry-guide">
            <defs>
              <clipPath id="symmetry-canvas">
                <polygon points={canvasClip()} />
              </clipPath>
            </defs>
            <g clip-path="url(#symmetry-canvas)">
              <For each={lines()}>
                {(poly) => (
                  <>
                    <polyline class="symmetry-line-under" points={pts(poly)} />
                    <polyline class="symmetry-line" points={pts(poly)} />
                  </>
                )}
              </For>
            </g>
            <Show when={editing()}>
              <polygon class="symmetry-box" points={boxPoints()} />
              <line class="symmetry-arm" x1={knob().fx} y1={knob().fy} x2={knob().x} y2={knob().y} />
              <circle class="symmetry-handle turn" cx={knob().x} cy={knob().y} r={5} onPointerDown={turn}>
                <title>Drag to turn (Shift: 15° steps)</title>
              </circle>
              <For each={HANDLES}>
                {([id, hx, hy]) => (
                  <rect class={`symmetry-handle box ${id}`} x={corner(hx, hy).x - 4} y={corner(hx, hy).y - 4} width={8} height={8} onPointerDown={scaleBy(hx, hy)}>
                    <title>{hx !== 0 && hy !== 0 ? 'Drag to scale (Shift: proportionally)' : hy !== 0 ? 'Drag to scale (Ctrl: skew)' : 'Drag to scale'}</title>
                  </rect>
                )}
              </For>
              <circle class="symmetry-handle centre" cx={centre().x} cy={centre().y} r={6} onPointerDown={moveCentre}>
                <title>Drag to move the symmetry</title>
              </circle>
              <g class="symmetry-ref" transform={`translate(${refScreen().x},${refScreen().y})`}>
                <line x1={-9} y1={0} x2={9} y2={0} />
                <line x1={0} y1={-9} x2={0} y2={9} />
                <circle class="symmetry-handle ref" r={4} onPointerDown={moveRef}>
                  <title>The reference point: scaling, skewing and turning happen about it. Drag to move it.</title>
                </circle>
              </g>
            </Show>
          </svg>
        );
      }}
    </Show>
  );
}
