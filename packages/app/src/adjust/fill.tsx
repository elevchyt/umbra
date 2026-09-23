/**
 * Fill layer editors — Layer ▸ New Fill Layer and the Properties panel for a fill layer.
 *
 * Like the adjustment editors these are controlled and report `(next, final)`. A pattern is
 * named by id; the pixels stay in the worker and the picker shows the library's thumbnails.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Select, Checkbox, Button } from '@umbra/ui/widgets/controls';
import { FILL_LABEL, type FillSummary, type Gradient, type GradientStyle, type PatternSummary } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Param, gradientCss, gradientPresets } from './editors';

type Change = (next: FillSummary, final: boolean) => void;

const toHex = (c: readonly number[]) =>
  '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

export function FillEditor(props: { value: FillSummary; onChange: Change }) {
  const v = () => props.value;
  return (
    <div class="adjust-editor">
      <Show when={v().type === 'solid'}>
        <SolidEditor value={v() as Extract<FillSummary, { type: 'solid' }>} onChange={props.onChange} />
      </Show>
      <Show when={v().type === 'gradient'}>
        <GradientFillEditor value={v() as Extract<FillSummary, { type: 'gradient' }>} onChange={props.onChange} />
      </Show>
      <Show when={v().type === 'pattern'}>
        <PatternFillEditor value={v() as Extract<FillSummary, { type: 'pattern' }>} onChange={props.onChange} />
      </Show>
    </div>
  );
}

function SolidEditor(props: { value: Extract<FillSummary, { type: 'solid' }>; onChange: Change }) {
  return (
    <div class="adjust-fields">
      <span class="adjust-param-label">Color</span>
      <input
        type="color"
        class="adjust-color wide"
        value={toHex(props.value.color)}
        onInput={(e) => props.onChange({ type: 'solid', color: fromHex(e.currentTarget.value) }, false)}
        onChange={(e) => props.onChange({ type: 'solid', color: fromHex(e.currentTarget.value) }, true)}
      />
      <span class="dim mono">{toHex(props.value.color).toUpperCase()}</span>
      <Button
        width={96}
        title="Use the current foreground colour"
        onClick={() => {
          const fg = store.foreground();
          props.onChange({ type: 'solid', color: [fg.r, fg.g, fg.b] }, true);
        }}
      >
        Foreground
      </Button>
    </div>
  );
}

const STYLE_OPTIONS: { value: GradientStyle; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

function GradientFillEditor(props: { value: Extract<FillSummary, { type: 'gradient' }>; onChange: Change }) {
  const set = (patch: Partial<Extract<FillSummary, { type: 'gradient' }>>, final: boolean) =>
    props.onChange({ ...props.value, ...patch }, final);
  const presets = gradientPresets();
  const index = () => presets.findIndex((p) => p.name === props.value.gradient.name);
  return (
    <>
      <div class="gradient-preview wide" style={{ background: gradientCss(props.value.gradient, props.value.reverse) }} />
      <Select
        value={index()}
        label="Gradient"
        width={170}
        options={[
          ...presets.map((p, i) => ({ value: i, label: p.name ?? `Gradient ${i + 1}` })),
          ...(index() < 0 ? [{ value: -1, label: props.value.gradient.name ?? 'Custom', separatorBefore: true }] : []),
        ]}
        onChange={(i) => {
          if (i >= 0) set({ gradient: presets[i] as Gradient }, true);
        }}
      />
      <Select value={props.value.style} label="Style" width={110} options={STYLE_OPTIONS} onChange={(s) => set({ style: s }, true)} />
      <Param label="Angle" value={props.value.angle} min={-180} max={180} suffix="°" onChange={(a, f) => set({ angle: a }, f)} />
      <Param label="Scale" value={props.value.scale} min={10} max={150} suffix="%" onChange={(a, f) => set({ scale: a }, f)} />
      <Checkbox checked={props.value.reverse} label="Reverse" onChange={(r) => set({ reverse: r }, true)} />
      <div class="adjust-fields">
        <NumberField label="Offset X" value={props.value.offset.x} min={-100} max={100} suffix="%" width={52} onChange={(x) => set({ offset: { ...props.value.offset, x } }, true)} />
        <NumberField label="Y" value={props.value.offset.y} min={-100} max={100} suffix="%" width={52} onChange={(y) => set({ offset: { ...props.value.offset, y } }, true)} />
        <Button width={56} onClick={() => set({ offset: { x: 0, y: 0 } }, true)}>
          Reset
        </Button>
      </div>
    </>
  );
}

/** Pattern thumbnails as data URLs, cached by id: the grid re-renders on every change. */
const thumbUrls = new Map<string, string>();
export function patternThumb(p: PatternSummary): string {
  let url = thumbUrls.get(p.id);
  if (!url) {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.thumb), 32, 32), 0, 0);
    url = c.toDataURL();
    thumbUrls.set(p.id, url);
  }
  return url;
}

export function PatternPicker(props: { selected?: string; onPick: (p: PatternSummary) => void }) {
  onMount(() => store.engine?.({ t: 'requestPatterns' }));
  return (
    <div class="pattern-grid">
      <For each={store.patterns()}>
        {(p) => (
          <button
            type="button"
            class="pattern-cell"
            classList={{ selected: props.selected === p.id }}
            title={`${p.name} (${p.width}×${p.height})`}
            onClick={() => props.onPick(p)}
          >
            <img src={patternThumb(p)} alt={p.name} width="32" height="32" />
          </button>
        )}
      </For>
    </div>
  );
}

function PatternFillEditor(props: { value: Extract<FillSummary, { type: 'pattern' }>; onChange: Change }) {
  const set = (patch: Partial<Extract<FillSummary, { type: 'pattern' }>>, final: boolean) =>
    props.onChange({ ...props.value, ...patch }, final);
  return (
    <>
      <PatternPicker selected={props.value.patternId} onPick={(p) => set({ patternId: p.id, patternName: p.name }, true)} />
      <div class="dim">{props.value.patternName}</div>
      <Param label="Scale" value={props.value.scale} min={1} max={1000} suffix="%" onChange={(s, f) => set({ scale: s }, f)} />
      <div class="adjust-fields">
        <NumberField label="Phase X" value={props.value.phase.x} min={-4000} max={4000} suffix="px" width={56} onChange={(x) => set({ phase: { ...props.value.phase, x } }, true)} />
        <NumberField label="Y" value={props.value.phase.y} min={-4000} max={4000} suffix="px" width={56} onChange={(y) => set({ phase: { ...props.value.phase, y } }, true)} />
        <Button width={110} onClick={() => set({ phase: { x: 0, y: 0 } }, true)}>
          Snap to Origin
        </Button>
      </div>
    </>
  );
}

/**
 * New Fill Layer ▸ …: the layer is created on open so the canvas previews it, every change
 * edits it without history, OK folds the final content into the creation step, and Cancel
 * undoes the creation — one history step or none, as in Photoshop.
 */
export function FillLayerDialog(props: { initial: FillSummary; send: (msg: unknown) => void; onClose: () => void }) {
  const [value, setValue] = createSignal<FillSummary>(props.initial);
  const [id, setId] = createSignal<number | null>(null);
  const before = store.doc()?.activeLayerIds[0];
  onMount(() => props.send({ t: 'addFillLayer', content: props.initial }));
  // The new layer is the first fill layer to become active after we asked for it.
  createEffect(() => {
    if (id() !== null) return;
    const d = store.doc();
    const active = d?.activeLayerIds[0];
    const layer = d?.layers.find((l) => l.id === active);
    if (active !== undefined && active !== before && layer?.kind === 'fill') setId(active);
  });

  let pending = 0;
  const push = () => {
    if (pending || id() === null) return;
    pending = window.setTimeout(() => {
      pending = 0;
      props.send({ t: 'setFillContent', id: id(), content: value(), final: false });
    }, 16);
  };
  onCleanup(() => pending && clearTimeout(pending));

  return (
    <Dialog
      title={FILL_LABEL[props.initial.type]}
      width={330}
      onOk={() => {
        if (pending) clearTimeout(pending);
        pending = 0;
        if (id() !== null) props.send({ t: 'setFillContent', id: id(), content: value(), final: true, amend: true });
        props.onClose();
      }}
      onCancel={() => {
        if (pending) clearTimeout(pending);
        pending = 0;
        if (id() !== null) props.send({ t: 'undo' });
        props.onClose();
      }}
      onReset={() => {
        setValue(props.initial);
        push();
      }}
    >
      <FillEditor
        value={value()}
        onChange={(next) => {
          setValue(next);
          push();
        }}
      />
    </Dialog>
  );
}
