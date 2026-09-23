/**
 * Filter dialogs — generated from each filter's parameter list (spec 03 §8), with
 * Photoshop's preview box: a crop of the image at 100% (or zoomed out), dragged to pan, and
 * held down to see the original. The Preview checkbox adds the on-canvas preview, computed in
 * the worker (latest request wins).
 */
import { For, createEffect, createSignal, onCleanup } from 'solid-js';
import { PreviewBox } from './PreviewBox';
import { Select, Checkbox, Button } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { FILTER_BY_ID, defaultsOf, type FilterParams, type ParamSpec } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Param } from '../adjust/editors';

const BOX = 220;

/** Filter settings last used per filter this session — Photoshop reopens dialogs with them. */
const lastParams = new Map<string, FilterParams>();

export function colours(): { fg: [number, number, number]; bg: [number, number, number] } {
  const f = store.foreground();
  const b = store.background();
  return { fg: [f.r, f.g, f.b], bg: [b.r, b.g, b.b] };
}

/** What the filter dialog opens on: a filter to apply, or (with `smartIndex`) a smart filter to re-edit. */
export type FilterDialogPayload = string | { id: string; params: FilterParams; smartIndex: number };

export function FilterDialog(props: { payload: FilterDialogPayload; send: (m: unknown) => void; onClose: () => void }) {
  const p = props.payload;
  const id = typeof p === 'string' ? p : p.id;
  const smartIndex = typeof p === 'string' ? undefined : p.smartIndex;
  const def = FILTER_BY_ID.get(id)!;
  const [params, setParams] = createSignal<FilterParams>(structuredClone(typeof p === 'string' ? (lastParams.get(id) ?? defaultsOf(def)) : { ...defaultsOf(def), ...p.params }));
  const [preview, setPreview] = createSignal(true);
  const canvasPreview = useCanvasPreview(props.send, () => id, params, preview, smartIndex);

  const set = (key: string, v: FilterParams[string]) => setParams({ ...params(), [key]: v });

  return (
    <Dialog
      title={smartIndex === undefined ? def.label : `${def.label} (Smart Filter)`}
      width={300}
      onOk={() => {
        canvasPreview.cancel();
        if (smartIndex === undefined) lastParams.set(id, params());
        props.send({ t: 'applyFilter', id, params: params(), ...colours(), smartIndex });
        props.onClose();
      }}
      onCancel={() => {
        canvasPreview.clear();
        props.onClose();
      }}
      onReset={() => setParams(defaultsOf(def))}
      footer={<Checkbox checked={preview()} label="Preview" onChange={setPreview} />}
    >
      <div class="adjust-editor">
        <PreviewBox id={id} params={params()} width={BOX} height={BOX} send={props.send} smartIndex={smartIndex} />
        <For each={def.params}>{(spec) => <ParamControl spec={spec} value={params()[spec.key]!} onChange={(v) => set(spec.key, v)} />}</For>
      </div>
    </Dialog>
  );
}

/**
 * The on-canvas preview of a filter dialog: the worker computes the filtered document
 * (latest request wins); a short delay coalesces slider drags.
 */
export function useCanvasPreview(send: (m: unknown) => void, id: () => string, params: () => FilterParams, on: () => boolean, smartIndex?: number) {
  let timer = 0;
  createEffect(() => {
    const p = params();
    const show = on();
    const f = id();
    clearTimeout(timer);
    timer = window.setTimeout(() => send({ t: 'previewFilter', id: show ? f : null, params: show ? p : null, ...colours(), smartIndex }), 60);
  });
  const cancel = () => clearTimeout(timer);
  onCleanup(cancel);
  return {
    cancel,
    /** Cancel and take the preview off the canvas. */
    clear: () => {
      cancel();
      send({ t: 'previewFilter', id: null, params: null, ...colours() });
    },
  };
}

export function ParamControl(props: { spec: ParamSpec; value: FilterParams[string]; onChange: (v: FilterParams[string]) => void }) {
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
    case 'layer': {
      // Any pixel layer of this document; a separate file needs a second open document (M11).
      const options = () => [
        { value: '-1', label: 'None' },
        ...(store.doc()?.layers ?? []).filter((l) => l.kind === 'pixel').map((l) => ({ value: String(l.id), label: l.name })),
      ];
      return <Select value={String(props.value)} label={s.label} width={150} options={options()} onChange={(v) => props.onChange(Number(v))} />;
    }
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

