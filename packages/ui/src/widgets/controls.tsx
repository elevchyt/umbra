import { For, Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/icons';

/** Small, dependency-free controls shared by the options bar, panels and dialogs. */

export function Separator() {
  return <span class="sep" aria-hidden="true" />;
}

export function Spacer() {
  return <span class="spacer" />;
}

export interface ToolButtonProps {
  icon: IconName | string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  size?: number;
}

export function IconButton(props: ToolButtonProps) {
  return (
    <button
      type="button"
      class="icon-button"
      classList={{ active: props.active }}
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      <Icon name={props.icon} size={props.size ?? 16} />
    </button>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  title?: string;
  disabled?: boolean;
}

export function Checkbox(props: CheckboxProps) {
  return (
    <label class="checkbox" classList={{ disabled: props.disabled }} title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="checkbox-box" aria-hidden="true">
        <Show when={props.checked}>
          <Icon name="check" size={12} />
        </Show>
      </span>
      <Show when={props.label}>
        <span class="checkbox-label">{props.label}</span>
      </Show>
    </label>
  );
}

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Renders a divider above this entry. */
  separatorBefore?: boolean;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (v: T) => void;
  label?: string;
  width?: number;
  disabled?: boolean;
  title?: string;
}

/**
 * Native <select> under custom chrome. A bespoke popup would be needed for previews-on-hover
 * (the blend-mode menu in M2), but for the shell the native control is correct, accessible
 * and free.
 */
export function Select<T extends string | number>(props: SelectProps<T>) {
  return (
    <label class="select" classList={{ disabled: props.disabled }} title={props.title}>
      <Show when={props.label}>
        <span class="select-label">{props.label}</span>
      </Show>
      <span class="select-body" style={{ width: props.width ? `${props.width}px` : undefined }}>
        <select
          value={String(props.value)}
          disabled={props.disabled}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const match = props.options.find((o) => String(o.value) === raw);
            if (match) props.onChange(match.value);
          }}
        >
          <For each={props.options}>
            {(o) => (
              <option value={String(o.value)} disabled={o.disabled}>
                {o.label}
              </option>
            )}
          </For>
        </select>
        <Icon name="chevronDown" size={12} />
      </span>
    </label>
  );
}

export interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  width?: number;
  disabled?: boolean;
}

export function Slider(props: SliderProps) {
  return (
    <label class="slider" classList={{ disabled: props.disabled }}>
      <Show when={props.label}>
        <span class="slider-label">{props.label}</span>
      </Show>
      <input
        type="range"
        min={props.min ?? 0}
        max={props.max ?? 100}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        style={{ width: `${props.width ?? 92}px` }}
        onInput={(e) => props.onChange(+e.currentTarget.value)}
      />
    </label>
  );
}

export interface ButtonProps {
  children: JSX.Element;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  width?: number;
}

export function Button(props: ButtonProps) {
  return (
    <button
      type="button"
      class="button"
      classList={{ primary: props.primary }}
      disabled={props.disabled}
      title={props.title}
      style={{ width: props.width ? `${props.width}px` : undefined }}
      onClick={() => props.onClick?.()}
    >
      {props.children}
    </button>
  );
}

/**
 * Foreground/background colour wells with the swap (X) and reset-to-default (D) affordances,
 * exactly where Photoshop puts them at the bottom of the tools panel.
 */
export function ColorWells(props: {
  foreground: string;
  background: string;
  onSwap: () => void;
  onReset: () => void;
  onPick: (which: 'foreground' | 'background') => void;
}) {
  return (
    <div class="color-wells">
      <button
        type="button"
        class="well well-fg"
        style={{ background: props.foreground }}
        title="Set foreground color"
        onClick={() => props.onPick('foreground')}
      />
      <button
        type="button"
        class="well well-bg"
        style={{ background: props.background }}
        title="Set background color"
        onClick={() => props.onPick('background')}
      />
      <button type="button" class="well-swap" title="Switch foreground and background colors (X)" onClick={props.onSwap}>
        <Icon name="swapColors" size={12} />
      </button>
      <button type="button" class="well-default" title="Default foreground and background colors (D)" onClick={props.onReset}>
        <Icon name="defaultColors" size={11} />
      </button>
    </div>
  );
}

/** A labelled group used in the options bar and dialogs. */
export function Field(props: { label?: string; children: JSX.Element; title?: string }) {
  return (
    <label class="field" title={props.title}>
      <Show when={props.label}>
        <span class="field-label">{props.label}</span>
      </Show>
      {props.children}
    </label>
  );
}

export function useToggle(initial = false) {
  const [on, setOn] = createSignal(initial);
  return [on, () => setOn((v) => !v), setOn] as const;
}
