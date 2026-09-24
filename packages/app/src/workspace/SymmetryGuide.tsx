/**
 * The paint symmetry's guide on the canvas — Photoshop's symmetry path: the mirror axes (or
 * the wave, circle or spiral) drawn over the document while a painting tool has symmetry on,
 * with handles to move its centre, turn it, and size its figure. Only the handles take the
 * pointer; everywhere else strokes go through to the canvas.
 */
import { For, Show, createMemo } from 'solid-js';
import { screenPointAtDoc, docPointAtScreen, symmetryCurve, type ViewState } from '@umbra/engine';
import { store } from '../state/store';
import { PAINT_TOOLS } from '../tools/registry';

type Pt = { x: number; y: number };

/** Symmetry types whose figure has a size, and those that have an angle. */
const SIZED = new Set(['wavy', 'circle', 'spiral', 'parallelLines']);
const TURNED = new Set(['vertical', 'horizontal', 'dualAxis', 'diagonal', 'wavy', 'spiral', 'parallelLines', 'radial', 'mandala']);

function viewOf(): ViewState | null {
  const s = store.stats();
  if (!s) return null;
  return { zoom: s.zoom, rotation: s.viewRotation, centre: { x: s.centreX, y: s.centreY }, width: s.viewWidth, height: s.viewHeight, devicePixelRatio: 1 };
}

export function SymmetryGuide() {
  const sym = () => {
    const s = store.brush.symmetry;
    return s && s.mode !== 'off' && s.mode !== 'path' && PAINT_TOOLS.has(store.activeTool()) && store.doc() ? s : null;
  };

  /** The guide in document space: polylines, and where the handles sit. */
  const figure = createMemo(() => {
    const s = sym();
    const d = store.doc();
    if (!s || !d) return null;
    const c = { x: s.cx, y: s.cy };
    const th = (s.angle * Math.PI) / 180;
    const far = Math.hypot(d.width, d.height) * 2;
    const dir = (a: number): Pt => ({ x: Math.cos(a), y: Math.sin(a) });
    const line = (a: number, off = 0): Pt[] => {
      const u = dir(a);
      const n = { x: -u.y * off, y: u.x * off };
      return [
        { x: c.x + n.x - u.x * far, y: c.y + n.y - u.y * far },
        { x: c.x + n.x + u.x * far, y: c.y + n.y + u.y * far },
      ];
    };
    const ray = (a: number): Pt[] => [c, { x: c.x + Math.cos(a) * far, y: c.y + Math.sin(a) * far }];
    const size = s.size ?? 100;
    let lines: Pt[][] = [];
    switch (s.mode) {
      case 'vertical':
        lines = [line(th + Math.PI / 2)];
        break;
      case 'horizontal':
        lines = [line(th)];
        break;
      case 'dualAxis':
        lines = [line(th), line(th + Math.PI / 2)];
        break;
      case 'diagonal':
        lines = [line(th + Math.PI / 4)];
        break;
      case 'parallelLines':
        lines = [line(th, size / 2), line(th, -size / 2)];
        break;
      case 'radial': {
        const n = Math.max(2, Math.min(12, Math.round(s.segments)));
        lines = Array.from({ length: n }, (_, k) => ray(th + (2 * Math.PI * k) / n));
        break;
      }
      case 'mandala': {
        const n = Math.max(2, Math.min(12, Math.round(s.segments)));
        lines = Array.from({ length: 2 * n }, (_, k) => ray(th + (Math.PI * k) / n));
        break;
      }
      default: {
        // Wavy, Circle, Spiral: the brush's own curve, kept to around the canvas.
        const m = Math.max(d.width, d.height);
        // A plain copy: the store merges into its object, which would defeat the curve cache.
        lines = symmetryCurve(JSON.parse(JSON.stringify(s))).map((poly) => poly.filter((p) => p.x > -m && p.y > -m && p.x < d.width + m && p.y < d.height + m));
      }
    }
    // Handles: the centre; a knob to turn it; a knob for the figure's size.
    const handles: { kind: 'centre' | 'turn' | 'size'; at: Pt }[] = [{ kind: 'centre', at: c }];
    if (SIZED.has(s.mode)) {
      const a = s.mode === 'parallelLines' ? th + Math.PI / 2 : th;
      const r = s.mode === 'parallelLines' ? size / 2 : size;
      handles.push({ kind: 'size', at: { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r } });
    }
    return { lines, handles, turnable: TURNED.has(s.mode), th };
  });

  const toScreen = (p: Pt) => screenPointAtDoc(viewOf()!, p.x, p.y);

  /** Drag a handle: every move rewrites the brush's symmetry. */
  const drag = (kind: 'centre' | 'turn' | 'size') => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as SVGElement;
    const box = el.ownerSVGElement!.getBoundingClientRect();
    // Window listeners, as the other drag handles here: they follow the pointer off the knob.
    const move = (ev: PointerEvent) => {
      const v = viewOf();
      const s = store.brush.symmetry;
      if (!v || !s) return;
      const p = docPointAtScreen(v, ev.clientX - box.left, ev.clientY - box.top);
      if (kind === 'centre') store.setBrush('symmetry', { ...s, cx: Math.round(p.x), cy: Math.round(p.y) });
      else if (kind === 'turn') {
        let a = (Math.atan2(p.y - s.cy, p.x - s.cx) * 180) / Math.PI;
        // Shift snaps to 15°, as Photoshop's transform rotation does.
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        store.setBrush('symmetry', { ...s, angle: Math.round(a * 10) / 10 });
      } else {
        const th = (s.angle * Math.PI) / 180;
        const a = s.mode === 'parallelLines' ? th + Math.PI / 2 : th;
        // Along the handle's own direction; Parallel Lines' knob is half the gap.
        const along = (p.x - s.cx) * Math.cos(a) + (p.y - s.cy) * Math.sin(a);
        const size = Math.max(4, Math.round(s.mode === 'parallelLines' ? along * 2 : Math.abs(along)));
        store.setBrush('symmetry', { ...s, size });
      }
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

  return (
    <Show when={figure() && viewOf()}>
      {(_) => {
        const f = () => figure()!;
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
        const turnKnob = () => {
          const s = store.brush.symmetry!;
          const c = toScreen({ x: s.cx, y: s.cy });
          // 56 screen px out from the centre, along the axis: mapped from the document, so the
          // view's zoom and rotation are accounted for.
          const reach = 56 / Math.max(1e-6, viewOf()!.zoom);
          const k = toScreen({ x: s.cx + Math.cos(f().th) * reach, y: s.cy + Math.sin(f().th) * reach });
          return { x: k.x, y: k.y, cx: c.x, cy: c.y };
        };
        return (
          <svg class="symmetry-guide">
            <defs>
              <clipPath id="symmetry-canvas">
                <polygon points={canvasClip()} />
              </clipPath>
            </defs>
            <g clip-path="url(#symmetry-canvas)">
              <For each={f().lines}>
                {(poly) => (
                  <>
                    <polyline class="symmetry-line-under" points={pts(poly)} />
                    <polyline class="symmetry-line" points={pts(poly)} />
                  </>
                )}
              </For>
            </g>
            <Show when={f().turnable}>
              <line class="symmetry-arm" x1={turnKnob().cx} y1={turnKnob().cy} x2={turnKnob().x} y2={turnKnob().y} />
              <circle class="symmetry-handle turn" cx={turnKnob().x} cy={turnKnob().y} r={5} onPointerDown={drag('turn')}>
                <title>Drag to turn the symmetry (Shift: 15° steps)</title>
              </circle>
            </Show>
            <For each={f().handles}>
              {(h) => (
                <circle
                  class={`symmetry-handle ${h.kind}`}
                  cx={toScreen(h.at).x}
                  cy={toScreen(h.at).y}
                  r={h.kind === 'centre' ? 6 : 5}
                  onPointerDown={drag(h.kind)}
                >
                  <title>{h.kind === 'centre' ? 'Drag to move the symmetry' : 'Drag to size the figure'}</title>
                </circle>
              )}
            </For>
          </svg>
        );
      }}
    </Show>
  );
}
