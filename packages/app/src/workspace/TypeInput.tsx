/**
 * The type tool's keyboard — spec 04 §7: an off-screen textarea holds the focus while a type
 * layer is being edited, so typing, dead keys, IMEs and the system clipboard all work the way
 * the platform does them; the engine owns the text, the caret and the selection. Keys that
 * edit (arrows, Backspace, Enter, the type shortcuts) go to the engine as keys; everything
 * typed or composed goes as text.
 */
import { createEffect, on } from 'solid-js';
import { store } from '../state/store';

const send = (m: unknown) => store.engine?.(m as never);

const EDIT_KEYS = new Set(['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function TypeInput() {
  let area!: HTMLTextAreaElement;
  const editing = () => store.doc()?.typeEdit ?? null;
  // Keep the focus here for the whole session (every summary may follow a canvas click).
  createEffect(
    on(
      () => [editing()?.layerId, editing()?.caret, editing()?.anchor],
      () => {
        if (editing() && document.activeElement !== area) {
          const active = document.activeElement as HTMLElement | null;
          // Do not take the focus from a panel field being typed into.
          if (active && active !== document.body && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
          area.focus({ preventScroll: true });
        }
      },
    ),
  );
  const flush = () => {
    const v = area.value;
    area.value = '';
    if (v) send({ t: 'typeInput', text: v });
  };
  return (
    <textarea
      ref={area}
      class="type-input-proxy"
      aria-label="Type"
      autocomplete="off"
      spellcheck={false}
      onKeyDown={(e) => {
        if (!editing() || e.isComposing || e.keyCode === 229) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const lower = e.key.toLowerCase();
        // The clipboard goes through the native copy/cut/paste events below.
        if (ctrl && (lower === 'c' || lower === 'x' || lower === 'v')) return;
        if (e.key === 'Tab') {
          e.preventDefault();
          send({ t: 'typeInput', text: '\t' });
          return;
        }
        const shortcut = ctrl && (['a', 'z', 'y', 'b', 'i', 'u', 'k', 'l', 'c', 'r', '<', '>', ',', '.'].includes(lower) || e.key === 'Enter');
        if (EDIT_KEYS.has(e.key) || shortcut) {
          e.preventDefault();
          e.stopPropagation();
          send({ t: 'typeKey', key: e.key, shift: e.shiftKey, ctrl, alt: e.altKey });
        }
      }}
      onInput={(e) => {
        if ((e as InputEvent).isComposing) return;
        flush();
      }}
      onCompositionEnd={() => flush()}
      onCopy={(e) => {
        const t = editing()?.selected ?? '';
        e.clipboardData?.setData('text/plain', t);
        e.preventDefault();
      }}
      onCut={(e) => {
        const t = editing()?.selected ?? '';
        e.clipboardData?.setData('text/plain', t);
        e.preventDefault();
        if (t) send({ t: 'typeInput', text: '' });
      }}
      onPaste={(e) => {
        const t = e.clipboardData?.getData('text/plain') ?? '';
        e.preventDefault();
        if (t) send({ t: 'typeInput', text: t });
      }}
    />
  );
}
