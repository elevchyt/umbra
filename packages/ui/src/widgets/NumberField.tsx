import { createEffect, createSignal, Show } from 'solid-js';
import { parseNumeric, type Unit } from './numeric';

export * from './numeric';

/**
 * Scrubby numeric field — spec 01 §2.
 *
 * The behaviours that make Photoshop's fields feel the way they do:
 *  - dragging the LABEL scrubs the value (the "scrubby slider"), with a resize cursor
 *  - ↑/↓ step by 1, Shift by 10, Alt by 0.1
 *  - a unit suffix is understood and converted ("2in", "50%", "3 cm")
 *  - simple arithmetic is evaluated ("100+20", "200/3")
 *  - the value commits on Enter or blur, and reverts on Escape
 */

export interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown. */
  precision?: number;
  unit?: Unit;
  /** Suffix rendered after the number (e.g. "%", "px"); defaults to `unit`. */
  suffix?: string;
  ppi?: number;
  /** 100% basis for percentage entry. */
  basis?: number;
  width?: number;
  disabled?: boolean;
  title?: string;
  /** Pixels of drag per step when scrubbing. */
  scrubScale?: number;
}

export function NumberField(props: NumberFieldProps) {
  const [text, setText] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  let input!: HTMLInputElement;

  const precision = () => props.precision ?? 0;
  const step = () => props.step ?? 1;
  const clamp = (v: number) => {
    const lo = props.min ?? -Infinity;
    const hi = props.max ?? Infinity;
    return Math.min(hi, Math.max(lo, v));
  };
  const format = (v: number) => v.toFixed(precision());

  // Keep the displayed text in sync while the user is not typing.
  createEffect(() => {
    if (!editing()) setText(format(props.value));
  });

  const commit = () => {
    const parsed = parseNumeric(text(), {
      unit: props.unit,
      ppi: props.ppi,
      basis: props.basis,
    });
    setEditing(false);
    if (parsed === null) {
      setText(format(props.value));
      return;
    }
    const next = clamp(parsed);
    setText(format(next));
    if (next !== props.value) props.onChange(next);
  };

  const nudge = (dir: 1 | -1, e: KeyboardEvent) => {
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const next = clamp(props.value + dir * step() * mult);
    props.onChange(next);
    setText(format(next));
  };

  const startScrub = (e: PointerEvent) => {
    if (props.disabled) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startValue = props.value;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const perPixel = (props.scrubScale ?? 1) * step() * mult;
      props.onChange(clamp(startValue + Math.round(dx) * perPixel));
    };
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      // A click without movement focuses the field for typing.
      if (!moved) input.select();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <div class="numfield" classList={{ disabled: props.disabled }} title={props.title}>
      <Show when={props.label}>
        <span class="numfield-label" onPointerDown={startScrub}>
          {props.label}
        </span>
      </Show>
      <input
        ref={input}
        class="numfield-input"
        style={{ width: `${props.width ?? 48}px` }}
        value={text()}
        disabled={props.disabled}
        inputMode="decimal"
        spellcheck={false}
        onInput={(e) => {
          setEditing(true);
          setText(e.currentTarget.value);
        }}
        onFocus={() => input.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            input.select();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
            setText(format(props.value));
            input.blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(1, e);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(-1, e);
          }
          // Everything else (including the app keymap's single-letter tool shortcuts) must
          // not escape a focused text field.
          e.stopPropagation();
        }}
      />
      <Show when={props.suffix ?? (props.unit && props.unit !== 'px' ? props.unit : undefined)}>
        {(s) => <span class="numfield-suffix">{s()}</span>}
      </Show>
    </div>
  );
}
