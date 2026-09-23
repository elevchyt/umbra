/** Edit ▸ Fade: the last filter, adjustment or stroke, faded with an opacity and a mode. */
import { createSignal, onCleanup, onMount } from 'solid-js';
import { Select, Checkbox } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { Dialog } from '../dialogs/Dialogs';
import { Param } from '../adjust/editors';

const MODES = BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({ value: m as BlendMode, label: BLEND_LABEL[m as BlendMode] }));

export function FadeDialog(props: { name: string; send: (m: unknown) => void; onClose: () => void }) {
  const [opacity, setOpacity] = createSignal(100);
  const [mode, setMode] = createSignal<BlendMode>('normal');
  const [preview, setPreview] = createSignal(true);
  let timer = 0;
  const push = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => props.send({ t: 'previewFade', opacity: preview() ? opacity() / 100 : null, mode: mode() }), 30);
  };
  onMount(push);
  onCleanup(() => clearTimeout(timer));
  return (
    <Dialog
      title="Fade"
      width={300}
      onOk={() => {
        clearTimeout(timer);
        props.send({ t: 'fade', opacity: opacity() / 100, mode: mode() });
        props.onClose();
      }}
      onCancel={() => {
        clearTimeout(timer);
        props.send({ t: 'previewFade', opacity: null, mode: 'normal' });
        props.onClose();
      }}
      footer={<Checkbox checked={preview()} label="Preview" onChange={(v) => { setPreview(v); push(); }} />}
    >
      <div class="adjust-editor">
        <div class="dim">Fading: {props.name}</div>
        <Param label="Opacity" value={opacity()} min={0} max={100} suffix="%" onChange={(v) => { setOpacity(v); push(); }} />
        <Select value={mode()} label="Mode" width={150} options={MODES} onChange={(m) => { setMode(m); push(); }} />
      </div>
    </Dialog>
  );
}
