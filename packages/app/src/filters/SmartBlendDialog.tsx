/**
 * A smart filter's Blending Options (the icon at the right of its row): the mode and opacity
 * its result is blended onto what is beneath it with — spec 05 §B.11.
 */
import { createSignal, onCleanup, onMount } from 'solid-js';
import { Select, Checkbox } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { Dialog } from '../dialogs/Dialogs';
import { Param } from '../adjust/editors';

const MODES = BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({ value: m as BlendMode, label: BLEND_LABEL[m as BlendMode] }));

export interface SmartBlendPayload {
  layerId: number;
  index: number;
  label: string;
  blendMode: BlendMode;
  opacity: number;
}

export function SmartBlendDialog(props: { payload: SmartBlendPayload; send: (m: unknown) => void; onClose: () => void }) {
  const p = props.payload;
  const [opacity, setOpacity] = createSignal(Math.round(p.opacity * 100));
  const [mode, setMode] = createSignal<BlendMode>(p.blendMode);
  const [preview, setPreview] = createSignal(true);
  let timer = 0;
  const push = () => {
    clearTimeout(timer);
    timer = window.setTimeout(
      () => props.send({ t: 'previewSmartBlend', layerId: p.layerId, index: p.index, blend: preview() ? { blendMode: mode(), opacity: opacity() / 100 } : null }),
      30,
    );
  };
  onMount(push);
  onCleanup(() => clearTimeout(timer));
  return (
    <Dialog
      title={`Blending Options (${p.label})`}
      width={300}
      onOk={() => {
        clearTimeout(timer);
        props.send({ t: 'smartFilterOp', layerId: p.layerId, index: p.index, op: { kind: 'blend', blendMode: mode(), opacity: opacity() / 100 } });
        props.onClose();
      }}
      onCancel={() => {
        clearTimeout(timer);
        props.send({ t: 'previewSmartBlend', layerId: p.layerId, index: p.index, blend: null });
        props.onClose();
      }}
      footer={
        <Checkbox
          checked={preview()}
          label="Preview"
          onChange={(v) => {
            setPreview(v);
            push();
          }}
        />
      }
    >
      <div class="adjust-editor">
        <Select value={mode()} label="Mode" width={150} options={MODES} onChange={(m) => { setMode(m); push(); }} />
        <Param label="Opacity" value={opacity()} min={0} max={100} suffix="%" onChange={(v) => { setOpacity(v); push(); }} />
      </div>
    </Dialog>
  );
}
