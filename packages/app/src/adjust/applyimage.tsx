/** Image ▸ Apply Image and Image ▸ Calculations dialogs. */
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Select, Checkbox } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import {
  DEFAULT_APPLY_IMAGE,
  DEFAULT_CALCULATIONS,
  type ApplyBlend,
  type ApplyImageOptions,
  type CalculationsOptions,
  type ChannelPick,
} from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Param } from './editors';

const BLENDS: { value: ApplyBlend; label: string; separatorBefore?: boolean }[] = [
  ...BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough' && m !== 'dissolve').map((m) => ({ value: m as BlendMode, label: BLEND_LABEL[m as BlendMode] })),
  { value: 'add', label: 'Add', separatorBefore: true },
  { value: 'subtract', label: 'Subtract' },
];

const CHANNELS: { value: ChannelPick; label: string }[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
  { value: 'gray', label: 'Gray' },
  { value: 'alpha', label: 'Transparency' },
];

/** Sources: the merged image, or any pixel layer. */
function sourceOptions() {
  return [
    { value: -1, label: 'Merged' },
    ...(store.doc()?.layers ?? []).filter((l) => l.kind === 'pixel').map((l) => ({ value: l.id, label: l.name })),
  ];
}

function BlendingFields(props: { blend: ApplyBlend; opacity: number; scale: number; offset: number; onChange: (p: Partial<{ blend: ApplyBlend; opacity: number; scale: number; offset: number }>) => void }) {
  return (
    <>
      <Select value={props.blend} label="Blending" width={150} options={BLENDS} onChange={(b) => props.onChange({ blend: b })} />
      <Param label="Opacity" value={Math.round(props.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => props.onChange({ opacity: v / 100 })} />
      <Show when={props.blend === 'add' || props.blend === 'subtract'}>
        <div class="adjust-fields">
          <NumberField label="Scale" value={props.scale} min={1} max={2} step={0.001} precision={3} width={56} onChange={(v) => props.onChange({ scale: v })} />
          <NumberField label="Offset" value={props.offset} min={-255} max={255} width={50} onChange={(v) => props.onChange({ offset: v })} />
        </div>
      </Show>
    </>
  );
}

export function ApplyImageDialog(props: { send: (m: unknown) => void; onClose: () => void }) {
  const [o, setO] = createSignal<ApplyImageOptions>(DEFAULT_APPLY_IMAGE);
  const [preview, setPreview] = createSignal(true);
  let timer = 0;
  const push = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => props.send({ t: 'previewApplyImage', options: preview() ? o() : null }), 40);
  };
  const set = (patch: Partial<ApplyImageOptions>) => {
    setO({ ...o(), ...patch });
    push();
  };
  onMount(push);
  onCleanup(() => clearTimeout(timer));
  const target = () => {
    const d = store.doc();
    const l = d?.layers.find((x) => x.id === d.activeLayerIds[0]);
    return l ? `${l.name}${d?.maskTarget === l.id ? ' (Layer Mask)' : ''}` : '—';
  };
  return (
    <Dialog
      title="Apply Image"
      width={330}
      onOk={() => {
        clearTimeout(timer);
        props.send({ t: 'applyImage', options: o() });
        props.onClose();
      }}
      onCancel={() => {
        clearTimeout(timer);
        props.send({ t: 'previewApplyImage', options: null });
        props.onClose();
      }}
      footer={<Checkbox checked={preview()} label="Preview" onChange={(p) => { setPreview(p); push(); }} />}
    >
      <div class="adjust-editor">
        <div class="dialog-section-title">Source</div>
        <Select value={o().sourceLayerId ?? -1} label="Layer" width={170} options={sourceOptions()} onChange={(id) => set({ sourceLayerId: id === -1 ? null : id })} />
        <Select value={o().channel} label="Channel" width={120} options={CHANNELS} onChange={(c) => set({ channel: c })} />
        <Checkbox checked={o().invert} label="Invert" onChange={(v) => set({ invert: v })} />
        <div class="dialog-section-title">Target: {target()}</div>
        <BlendingFields blend={o().blend} opacity={o().opacity} scale={o().scale} offset={o().offset} onChange={set} />
        <div class="dim">Transparent pixels of the target are left alone (Preserve Transparency is always on).</div>
      </div>
    </Dialog>
  );
}

export function CalculationsDialog(props: { send: (m: unknown) => void; onClose: () => void }) {
  const [o, setO] = createSignal<CalculationsOptions>(DEFAULT_CALCULATIONS);
  const set = (patch: Partial<CalculationsOptions>) => setO({ ...o(), ...patch });
  const single = CHANNELS.filter((c) => c.value !== 'rgb') as { value: Exclude<ChannelPick, 'rgb'>; label: string }[];
  const source = (key: 'source1' | 'source2', label: string) => (
    <>
      <div class="dialog-section-title">{label}</div>
      <Select value={o()[key].layerId ?? -1} label="Layer" width={170} options={sourceOptions()} onChange={(id) => set({ [key]: { ...o()[key], layerId: id === -1 ? null : id } } as never)} />
      <div class="adjust-fields">
        <Select value={o()[key].channel} label="Channel" width={120} options={single} onChange={(c) => set({ [key]: { ...o()[key], channel: c } } as never)} />
        <Checkbox checked={o()[key].invert} label="Invert" onChange={(v) => set({ [key]: { ...o()[key], invert: v } } as never)} />
      </div>
    </>
  );
  return (
    <Dialog
      title="Calculations"
      width={330}
      onOk={() => {
        props.send({ t: 'calculations', options: o() });
        props.onClose();
      }}
      onCancel={props.onClose}
    >
      <div class="adjust-editor">
        {source('source1', 'Source 1')}
        {source('source2', 'Source 2')}
        <BlendingFields blend={o().blend} opacity={o().opacity} scale={o().scale} offset={o().offset} onChange={set} />
        <Select
          value={o().result}
          label="Result"
          width={150}
          options={[
            { value: 'channel', label: 'New Channel' },
            { value: 'selection', label: 'Selection' },
          ]}
          onChange={(r) => set({ result: r })}
        />
        <div class="dim">A new document as the result needs more than one open document, which is not built yet.</div>
      </div>
    </Dialog>
  );
}
