/**
 * The preview box of filter dialogs: a crop of the image computed in the worker, at 100% or
 * zoomed, dragged to pan and held down to see the original. Asks again whenever the filter or
 * its settings change; the newest request wins.
 */
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Button } from '@umbra/ui/widgets/controls';
import type { FilterParams } from '@umbra/engine';
import { store } from '../state/store';
import { colours } from './FilterDialog';

const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4];

export function PreviewBox(props: { id: string; params: FilterParams; width: number; height: number; send: (m: unknown) => void; smartIndex?: number }) {
  const [zoom, setZoom] = createSignal(1);
  const doc = () => store.doc();
  // Centre of the box, in document pixels.
  const [centre, setCentre] = createSignal({ x: (doc()?.width ?? 0) / 2, y: (doc()?.height ?? 0) / 2 });
  const [showBefore, setShowBefore] = createSignal(false);
  let canvas!: HTMLCanvasElement;
  let seq = 0;
  let latest: { before: Uint8Array; after: Uint8Array; width: number; height: number; rect: { x0: number; y0: number } } | null = null;

  const rect = () => {
    const hw = props.width / zoom() / 2;
    const hh = props.height / zoom() / 2;
    const c = centre();
    return { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };
  };

  let timer = 0;
  const request = () => {
    const { fg, bg } = colours();
    const id = props.id;
    const params = props.params;
    clearTimeout(timer);
    const smartIndex = props.smartIndex;
    timer = window.setTimeout(() => props.send({ t: 'filterBox', id, params, fg, bg, rect: rect(), seq: ++seq, smartIndex }), 16);
  };

  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, props.width, props.height);
    if (!latest) return;
    const px = showBefore() ? latest.before : latest.after;
    const tmp = document.createElement('canvas');
    tmp.width = latest.width;
    tmp.height = latest.height;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), latest.width, latest.height), 0, 0);
    // Draw at the box's zoom; the returned rect may be clipped by the canvas edges.
    const r = rect();
    ctx.imageSmoothingEnabled = zoom() < 1;
    ctx.drawImage(tmp, (latest.rect.x0 - r.x0) * zoom(), (latest.rect.y0 - r.y0) * zoom(), latest.width * zoom(), latest.height * zoom());
  };

  onMount(() => {
    const onBox = (e: Event) => {
      const m = (e as CustomEvent).detail as { seq: number } & typeof latest;
      if (!m || m.seq !== seq) return;
      latest = m;
      draw();
    };
    window.addEventListener('umbra:filter-box', onBox);
    onCleanup(() => window.removeEventListener('umbra:filter-box', onBox));
  });
  onCleanup(() => clearTimeout(timer));
  createEffect(() => {
    // Track the filter and its settings.
    void props.id;
    void props.params;
    request();
  });
  createEffect(() => {
    showBefore();
    draw();
  });

  const pan = (e: PointerEvent) => {
    e.preventDefault();
    setShowBefore(true);
    const start = { x: e.clientX, y: e.clientY, c: centre() };
    const move = (ev: PointerEvent) => {
      setCentre({ x: start.c.x - (ev.clientX - start.x) / zoom(), y: start.c.y - (ev.clientY - start.y) / zoom() });
      draw();
    };
    const up = () => {
      setShowBefore(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      request();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const step = (d: number) => {
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoom()) + d))]!);
    request();
  };

  return (
    <div class="preview-box">
      <canvas
        ref={canvas}
        class="filter-box"
        style={{ width: `${props.width}px`, height: `${props.height}px` }}
        width={props.width}
        height={props.height}
        onPointerDown={pan}
        title="Drag to move the preview; hold to see the original"
      />
      <div class="adjust-fields filter-zoom">
        <Button width={28} onClick={() => step(-1)}>
          −
        </Button>
        <span>{Math.round(zoom() * 100)}%</span>
        <Button width={28} onClick={() => step(1)}>
          +
        </Button>
      </div>
    </div>
  );
}
