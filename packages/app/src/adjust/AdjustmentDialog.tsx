import { createSignal, onCleanup, onMount } from 'solid-js';
import { Checkbox } from '@umbra/ui/widgets/controls';
import { ADJUSTMENT_LABEL, type Adjustment } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';

/** Kinds whose dialog has eyedroppers or an on-image tool, and so lets clicks reach the image. */
const PICKS_FROM_IMAGE = new Set(['levels', 'curves', 'hueSaturation', 'blackWhite']);
import { AdjustmentEditor } from './editors';

/**
 * Image ▸ Adjustments ▸ … — spec 05 §A: every dialog has Preview, and Alt turns Cancel into
 * Reset.
 *
 * The preview is not a pixel pass: the engine draws the adjustment as a temporary clipped
 * adjustment layer over the target, so a slider drag costs one GPU pass per frame whatever
 * the document size. Updates are coalesced to one per animation frame. OK runs the kernel
 * over the pixels once.
 */
export function AdjustmentDialog(props: {
  initial: Adjustment;
  send: (msg: unknown) => void;
  onClose: () => void;
}) {
  const [value, setValue] = createSignal<Adjustment>(props.initial);
  const [preview, setPreview] = createSignal(true);

  let pending = 0;
  const push = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      props.send({ t: 'previewAdjustment', adjustment: preview() ? value() : null });
    });
  };

  onMount(() => {
    props.send({ t: 'requestHistogram', source: 'layer' });
    push();
  });
  onCleanup(() => {
    if (pending) cancelAnimationFrame(pending);
  });

  const change = (next: Adjustment) => {
    setValue(next);
    push();
  };

  const close = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = 0;
    props.send({ t: 'previewAdjustment', adjustment: null });
    props.onClose();
  };

  return (
    <Dialog
      title={ADJUSTMENT_LABEL[props.initial.kind]}
      width={props.initial.kind === 'curves' ? 330 : 320}
      onOk={() => {
        if (pending) cancelAnimationFrame(pending);
        pending = 0;
        props.send({ t: 'applyAdjustment', adjustment: value() });
        store.setLastAdjustment(value());
        props.onClose();
      }}
      onCancel={close}
      passThrough={PICKS_FROM_IMAGE.has(props.initial.kind)}
      onReset={() => change(props.initial)}
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
      <AdjustmentEditor value={value()} onChange={(next) => change(next)} />
    </Dialog>
  );
}
