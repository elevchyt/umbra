/**
 * Edit ▸ Content-Aware Fill. Photoshop opens a workspace with a sampling-area overlay and a
 * live preview; this is its settings panel as a dialog: the sampling area, colour adaptation
 * and where the result goes. The fill itself is PatchMatch (kernels/patchmatch.ts).
 */
import { createSignal } from 'solid-js';
import { Checkbox, Select } from '@umbra/ui/widgets/controls';
import { Dialog } from '../dialogs/Dialogs';

type Sampling = 'auto' | 'rectangular' | 'all';
type Output = 'current' | 'new' | 'duplicate';

export function ContentAwareFillDialog(props: { send: (m: unknown) => void; onClose: () => void }) {
  const [sampling, setSampling] = createSignal<Sampling>('auto');
  const [colorAdaptation, setColorAdaptation] = createSignal(true);
  const [output, setOutput] = createSignal<Output>('current');
  return (
    <Dialog
      title="Content-Aware Fill"
      width={320}
      onOk={() => {
        props.send({ t: 'contentAwareFill', sampling: sampling(), colorAdaptation: colorAdaptation(), output: output() });
        props.onClose();
      }}
      onCancel={props.onClose}
    >
      <div class="adjust-editor">
        <Select
          label="Sampling Area"
          value={sampling()}
          width={150}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'rectangular', label: 'Rectangular' },
            { value: 'all', label: 'All (whole image)' },
          ]}
          onChange={(v) => setSampling(v as Sampling)}
        />
        <Checkbox checked={colorAdaptation()} label="Color Adaptation" onChange={setColorAdaptation} />
        <Select
          label="Output To"
          value={output()}
          width={150}
          options={[
            { value: 'current', label: 'Current Layer' },
            { value: 'new', label: 'New Layer' },
            { value: 'duplicate', label: 'Duplicate Layer' },
          ]}
          onChange={(v) => setOutput(v as Output)}
        />
      </div>
    </Dialog>
  );
}
