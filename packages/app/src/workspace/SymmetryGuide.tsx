/**
 * The paint symmetry's guide on the canvas — Photoshop's symmetry path. While a painting tool
 * has symmetry on, its axes (or wave, circle or spiral) are drawn over the document. Editing
 * the symmetry (choosing a type, the options bar's Transform button, or its row in the Paths
 * panel) opens a transform box round the figure, as Free Transform does:
 *
 * - corner and side handles scale it about its centre (Shift keeps the proportions);
 * - Ctrl on the top or bottom handle skews it;
 * - the knob above the box turns it (Shift: 15° steps); the centre handle moves it;
 * - Enter commits, Esc puts it back as it was.
 *
 * Outside editing only the lines show, and nothing takes the pointer: strokes go through.
 */
import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { screenPointAtDoc, docPointAtScreen, symmetryCurve, IDENTITY_SYMMETRY_TRANSFORM, type Symmetry, type ViewState } from '@umbra/engine';
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

/** The symmetry's placement: figure space (about the origin, angle 0) → document. */
export function placementOf(s: Symmetry): { toDoc: (x: number, y: number) => Pt } {
  const t = s.transform ?? IDENTITY_SYMMETRY_TRANSFORM;
  const th = (s.angle * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const k = Math.tan((Math.max(-89, Math.min(89, t.skew)) * Math.PI) / 180);
  const a = cos * t.scaleX;
  const b = sin * t.scaleX;
  const c = cos * t.scaleX * k - sin * t.scaleY;
  const d = sin * t.scaleX * k + cos * t.scaleY;
  return { toDoc: (x, y) => ({ x: s.cx + a * x + c * y, y: s.cy + b * x + d * y }) };
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

/** Open the transform box on the current symmetry. */
export function beginSymmetryEdit(): void {
  const s = store.brush.symmetry;
  if (!s || s.mode === 'off' || s.mode === 'path') return;
  store.setSymmetryEdit({ start: JSON.parse(JSON.stringify(s)) as Symmetry });
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
    const a0 = Math.atan2(from.y - s.cy, from.x - s.cx);
    const a1 = Math.atan2(p.y - s.cy, p.x - s.cx);
    let angle = s.angle + ((a1 - a0) * 180) / Math.PI;
    if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
    angle = ((((angle + 180) % 360) + 360) % 360) - 180;
    return { angle: Math.round(angle * 10) / 10 };
  });

  /** A box handle: scale about the centre (Shift: proportionally); Ctrl on top/bottom: skew. */
  const scaleBy = (hx: number, hy: number) =>
    drag((p, s, _from, ev) => {
      const t = s.transform ?? IDENTITY_SYMMETRY_TRANSFORM;
      const E = halfOf(s);
      const th = (s.angle * Math.PI) / 180;
      // The pointer in the symmetry's turned frame (before its scale and skew).
      const dx = p.x - s.cx;
      const dy = p.y - s.cy;
      const vx = dx * Math.cos(th) + dy * Math.sin(th);
      const vy = -dx * Math.sin(th) + dy * Math.cos(th);
      const k = Math.tan((t.skew * Math.PI) / 180);
      const clampS = (v: number) => (Math.abs(v) < 0.05 ? 0.05 * Math.sign(v || 1) : Math.round(v * 1000) / 1000);
      if ((ev.ctrlKey || ev.metaKey) && hx === 0 && hy !== 0) {
        // Skew: the top or bottom edge slides sideways.
        const skew = (Math.atan(vx / (t.scaleX * hy * E)) * 180) / Math.PI;
        return { transform: { ...t, skew: Math.round(Math.max(-80, Math.min(80, skew)) * 10) / 10 } };
      }
      let scaleX = t.scaleX;
      let scaleY = t.scaleY;
      if (hy !== 0) scaleY = vy / (hy * E);
      if (hx !== 0) scaleX = vx / (hx * E + k * hy * E);
      if (ev.shiftKey && hx !== 0 && hy !== 0) {
        // Proportionally: along the corner's own direction from the centre.
        const cx = t.scaleX * (hx * E + k * hy * E);
        const cy = t.scaleY * hy * E;
        const f = (vx * cx + vy * cy) / (cx * cx + cy * cy);
        scaleX = t.scaleX * f;
        scaleY = t.scaleY * f;
      }
      return { transform: { ...t, scaleX: clampS(scaleX), scaleY: clampS(scaleY) } };
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
            </Show>
          </svg>
        );
      }}
    </Show>
  );
}
