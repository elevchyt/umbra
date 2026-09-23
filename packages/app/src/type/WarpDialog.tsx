/** Type ▸ Warp Text — spec 04 §7: style, orientation, Bend and distortions, previewed live. */
import { Show, createSignal } from 'solid-js';
import { Select } from '@umbra/ui/widgets/controls';
import { WARP_STYLES, type WarpSpec } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Radio, Slide } from '../fx/controls';

export function WarpDialog(props: { onClose: () => void }) {
  const send = (m: unknown) => store.engine?.(m as never);
  const layer = () => {
    const d = store.doc();
    return d?.layers.find((l) => l.id === d.activeLayerIds[0]);
  };
  const original = layer()?.type?.text.warp ?? null;
  const [warp, setWarp] = createSignal<WarpSpec | null>(original);
  const shown = () => warp() ?? { style: 'arc', bend: 50, hDistort: 0, vDistort: 0, orientation: 'horizontal' as const };
  const update = (w: WarpSpec | null) => {
    setWarp(w);
    send({ t: 'setTypeWarp', warp: w, final: false });
  };
  const set = (patch: Partial<WarpSpec>) => update({ ...shown(), ...patch });
  return (
    <Dialog
      title="Warp Text"
      width={320}
      onOk={() => {
        send({ t: 'setTypeWarp', warp: warp(), final: true });
        props.onClose();
      }}
      onCancel={() => {
        send({ t: 'setTypeWarp', warp: original, final: false });
        props.onClose();
      }}
    >
      <div class="adjust-editor">
        <Select
          label="Style"
          value={warp()?.style ?? 'none'}
          width={140}
          options={[{ value: 'none', label: 'None' }, ...WARP_STYLES]}
          onChange={(v) => (v === 'none' ? update(null) : set({ style: v as WarpSpec['style'] }))}
        />
        <Show when={warp()}>
          <Radio
            value={shown().orientation}
            options={[
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'vertical', label: 'Vertical' },
            ]}
            onChange={(v) => set({ orientation: v })}
          />
          <Slide label="Bend" value={shown().bend} min={-100} max={100} suffix="%" onChange={(v) => set({ bend: v })} />
          <Slide label="Horizontal Distortion" value={shown().hDistort} min={-100} max={100} suffix="%" onChange={(v) => set({ hDistort: v })} />
          <Slide label="Vertical Distortion" value={shown().vDistort} min={-100} max={100} suffix="%" onChange={(v) => set({ vDistort: v })} />
        </Show>
      </div>
    </Dialog>
  );
}
