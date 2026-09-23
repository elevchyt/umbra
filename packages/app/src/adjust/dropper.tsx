import { onCleanup } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { store } from '../state/store';

/**
 * A dialog eyedropper. Clicking arms it — the next canvas clicks sample the image (3×3
 * average) and call `onPick` — and clicking again disarms it. Closing the dialog disarms it.
 */
export function Dropper(props: {
  id: string;
  title: string;
  onPick: (rgb: [number, number, number]) => void;
  /** A small swatch in the button: the dropper's target colour (black, grey, white). */
  swatch?: string;
}) {
  const armed = () => store.pickRequest()?.id === props.id;
  onCleanup(() => {
    if (armed()) store.setPickRequest(null);
  });
  return (
    <button
      type="button"
      class="dropper"
      classList={{ armed: armed() }}
      title={`${props.title} — click, then click the image`}
      onClick={() => store.setPickRequest(armed() ? null : { id: props.id, onPick: props.onPick })}
    >
      {props.swatch ? <span class="swatch" style={{ background: props.swatch }} /> : <Icon name="eyedropper" size={14} />}
    </button>
  );
}
