import { Icon } from '@umbra/ui/icons/Icon';
import { onCleanup } from 'solid-js';
import { store } from '../state/store';

/**
 * Where the pointer is and whether a button is down, tracked for the whole window. A dialog's
 * canvas pick answers asynchronously (the worker samples the image), so by the time it
 * arrives the drag has begun; this is what lets the drag be picked up from there.
 */
const pointer = { down: false, x: 0, y: 0 };
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => Object.assign(pointer, { down: true, x: e.clientX, y: e.clientY }), true);
  window.addEventListener('pointermove', (e) => Object.assign(pointer, { x: e.clientX, y: e.clientY }), true);
  window.addEventListener('pointerup', () => (pointer.down = false), true);
}

/** Receives drag distances (px, right and UP positive) until the button is released. */
export type OnImageDrag = (dx: number, dy: number, final: boolean) => void;

/**
 * Photoshop's targeted-adjustment ("on-image") tool: arm it, press on the image to choose
 * what to adjust by its colour, and drag to adjust it. `onStart` gets the sampled colour and
 * returns the drag handler, or null to ignore the click.
 */
export function OnImageButton(props: { id: string; title: string; onStart: (rgb: [number, number, number]) => OnImageDrag | null }) {
  const armed = () => store.pickRequest()?.id === props.id;
  onCleanup(() => {
    if (armed()) store.setPickRequest(null);
  });
  const onPick = (rgb: [number, number, number]) => {
    const drag = props.onStart(rgb);
    if (!drag) return;
    if (!pointer.down) {
      drag(0, 0, true);
      return;
    }
    const x0 = pointer.x;
    const y0 = pointer.y;
    const move = (e: PointerEvent) => drag(e.clientX - x0, y0 - e.clientY, false);
    const up = (e: PointerEvent) => {
      drag(e.clientX - x0, y0 - e.clientY, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <button
      type="button"
      class="dropper"
      classList={{ armed: armed() }}
      title={`${props.title} — click, then drag on the image`}
      onClick={() => store.setPickRequest(armed() ? null : { id: props.id, onPick })}
    >
      <Icon name="hand" size={14} />
    </button>
  );
}
