/**
 * Filter dialogs — generated from each filter's parameter list (spec 03 §8), with
 * Photoshop's preview box: a crop of the image at 100% (or zoomed out), dragged to pan, and
 * held down to see the original. The Preview checkbox adds the on-canvas preview, computed in
 * the worker (latest request wins).
 */
import { For, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Select, Checkbox, Button } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { FILTER_BY_ID, defaultsOf, type FilterParams, type ParamSpec } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Param } from '../adjust/editors';

const BOX = 220;
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4];

/** Filter settings last used per filter this session — Photoshop reopens dialogs with them. */
const lastParams = new Map<string, FilterParams>();

export function colours(): { fg: [number, number, number]; bg: [number, number, number] } {
  const f = store.foreground();
  const b = store.background();
  return { fg: [f.r, f.g, f.b], bg: [b.r, b.g, b.b] };
}

export function FilterDialog(props: { id: string; send: (m: unknown) => void; onClose: () => void }) {
  const def = FILTER_BY_ID.get(props.id)!;
  const [params, setParams] = createSignal<FilterParams>(structuredClone(lastParams.get(props.id) ?? defaultsOf(def)));
  const [preview, setPreview] = createSignal(true);
  const [zoom, setZoom] = createSignal(1);
  const doc = () => store.doc();
  // Centre of the box, in document pixels.
  const [centre, setCentre] = createSignal({ x: (doc()?.width ?? 0) / 2, y: (doc()?.height ?? 0) / 2 });
  const [showBefore, setShowBefore] = createSignal(false);
  let canvas!: HTMLCanvasElement;
  let seq = 0;
  let latest: { before: Uint8Array; after: Uint8Array; width: number; height: number; rect: { x0: number; y0: number } } | null = null;

  const rect = () => {
    const half = BOX / zoom() / 2;
    const c = centre();
    return { x0: c.x - half, y0: c.y - half, x1: c.x + half, y1: c.y + half };
  };

  let boxTimer = 0;
  let canvasTimer = 0;
  const request = () => {
    const { fg, bg } = colours();
    clearTimeout(boxTimer);
    boxTimer = window.setTimeout(() => props.send({ t: 'filterBox', id: props.id, params: params(), fg, bg, rect: rect(), seq: ++seq }), 16);
    clearTimeout(canvasTimer);
    canvasTimer = window.setTimeout(() => props.send({ t: 'previewFilter', id: preview() ? props.id : null, params: preview() ? params() : null, fg, bg }), 60);
  };

  const draw = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, BOX, BOX);
    if (!latest) return;
    const px = showBefore() ? latest.before : latest.after;
    const img = new ImageData(new Uint8ClampedArray(px), latest.width, latest.height);
    // Draw at the box's zoom; the returned rect may be clipped by the canvas edges.
    const tmp = document.createElement('canvas');
    tmp.width = latest.width;
    tmp.height = latest.height;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
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
    request();
  });
  onCleanup(() => {
    clearTimeout(boxTimer);
    clearTimeout(canvasTimer);
  });
  createEffect(() => {
    showBefore();
    draw();
  });

  const set = (key: string, v: FilterParams[string]) => {
    setParams({ ...params(), [key]: v });
    request();
  };

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

  const close = () => {
    props.send({ t: 'previewFilter', id: null, params: null, ...colours() });
    props.onClose();
  };

  return (
    <Dialog
      title={def.label}
      width={300}
      onOk={() => {
        clearTimeout(boxTimer);
        clearTimeout(canvasTimer);
        lastParams.set(props.id, params());
        props.send({ t: 'applyFilter', id: props.id, params: params(), ...colours() });
        props.onClose();
      }}
      onCancel={close}
      onReset={() => {
        setParams(defaultsOf(def));
        request();
      }}
      footer={
        <Checkbox
          checked={preview()}
          label="Preview"
          onChange={(v) => {
            setPreview(v);
            request();
          }}
        />
      }
    >
      <div class="adjust-editor">
        <canvas ref={canvas} class="filter-box" width={BOX} height={BOX} onPointerDown={pan} title="Drag to move the preview; hold to see the original" />
        <div class="adjust-fields filter-zoom">
          <Button width={28} onClick={() => { setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom()) - 1)]!); request(); }}>
            −
          </Button>
          <span>{Math.round(zoom() * 100)}%</span>
          <Button width={28} onClick={() => { setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom()) + 1)]!); request(); }}>
            +
          </Button>
        </div>
        <For each={def.params}>{(spec) => <ParamControl spec={spec} value={params()[spec.key]!} onChange={(v) => set(spec.key, v)} />}</For>
      </div>
    </Dialog>
  );
}

function ParamControl(props: { spec: ParamSpec; value: FilterParams[string]; onChange: (v: FilterParams[string]) => void }) {
  const s = props.spec;
  switch (s.type) {
    case 'number':
      return s.scale === 'log' ? (
        <LogParam spec={s} value={props.value as number} onChange={props.onChange} />
      ) : (
        <Param label={s.label} value={props.value as number} min={s.min} max={s.max} step={s.step ?? 1} precision={s.precision ?? 0} suffix={s.unit} onChange={(v) => props.onChange(v)} />
      );
    case 'select':
      return <Select value={props.value as string} label={s.label} width={150} options={s.options} onChange={(v) => props.onChange(v)} />;
    case 'bool':
      return <Checkbox checked={props.value as boolean} label={s.label} onChange={(v) => props.onChange(v)} />;
    case 'seed':
      return (
        <Button width={100} onClick={() => props.onChange(Math.floor(Math.random() * 1e9))}>
          Randomize
        </Button>
      );
    case 'point':
      return <PointParam label={s.label} value={props.value as { x: number; y: number }} onChange={props.onChange} />;
    case 'kernel':
      return <KernelParam size={s.size} value={props.value as number[]} onChange={props.onChange} />;
  }
}

/** A slider whose travel is logarithmic, for radii that span four orders of magnitude. */
function LogParam(props: { spec: Extract<ParamSpec, { type: 'number' }>; value: number; onChange: (v: number) => void }) {
  const s = props.spec;
  const lo = Math.log(s.min);
  const hi = Math.log(s.max);
  const toT = (v: number) => (Math.log(Math.max(s.min, v)) - lo) / (hi - lo);
  const fromT = (t: number) => {
    const v = Math.exp(lo + t * (hi - lo));
    const p = 10 ** (s.precision ?? 0);
    return Math.round(v * p) / p;
  };
  return (
    <div class="adjust-param">
      <div class="adjust-param-head">
        <span class="adjust-param-label">{s.label}</span>
        <NumberField value={props.value} min={s.min} max={s.max} step={s.step ?? 1} precision={s.precision ?? 0} suffix={s.unit} width={60} onChange={props.onChange} />
      </div>
      <input
        type="range"
        class="adjust-range"
        min={0}
        max={1000}
        value={Math.round(toT(props.value) * 1000)}
        aria-label={s.label}
        onInput={(e) => props.onChange(fromT(+e.currentTarget.value / 1000))}
      />
    </div>
  );
}

/** A position on the canvas, picked in a small proxy of it (Radial Blur's centre, …). */
function PointParam(props: { label: string; value: { x: number; y: number }; onChange: (v: { x: number; y: number }) => void }) {
  const aspect = () => (store.doc() ? store.doc()!.height / store.doc()!.width : 1);
  const pick = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const set = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      props.onChange({ x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) });
    };
    set(e);
    const up = () => {
      window.removeEventListener('pointermove', set);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', set);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="adjust-param">
      <span class="adjust-param-label">{props.label}</span>
      <div class="point-pick" style={{ height: `${120 * aspect()}px` }} onPointerDown={pick}>
        <span class="point-dot" style={{ left: `${props.value.x * 100}%`, top: `${props.value.y * 100}%` }} />
      </div>
    </div>
  );
}

function KernelParam(props: { size: number; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div class="kernel-grid" style={{ 'grid-template-columns': `repeat(${props.size}, 44px)` }}>
      <For each={props.value}>
        {(v, i) => (
          <NumberField
            value={v}
            min={-999}
            max={999}
            width={40}
            onChange={(n) => {
              const next = [...props.value];
              next[i()] = n;
              props.onChange(next);
            }}
          />
        )}
      </For>
    </div>
  );
}

