/** Layer ▸ Layer Style ▸ Global Light: the angle and altitude "Use Global Light" effects share. */
import { createSignal, onCleanup } from 'solid-js';
import { DEFAULT_GLOBAL_LIGHT, type GlobalLight } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { AngleRow, Slide } from './controls';

export function GlobalLightDialog(props: { send: (m: unknown) => void; onClose: () => void }) {
  const [light, setLight] = createSignal<GlobalLight>(store.doc()?.globalLight ?? DEFAULT_GLOBAL_LIGHT);
  onCleanup(() => undefined);
  return (
    <Dialog
      title="Global Light"
      width={300}
      onOk={() => {
        props.send({ t: 'setGlobalLight', light: light() });
        props.onClose();
      }}
      onCancel={props.onClose}
    >
      <div class="adjust-editor">
        <AngleRow angle={light().angle} onAngle={(a) => setLight({ ...light(), angle: a })} />
        <Slide label="Altitude" value={light().altitude} min={0} max={90} suffix="°" onChange={(a) => setLight({ ...light(), altitude: a })} />
      </div>
    </Dialog>
  );
}
