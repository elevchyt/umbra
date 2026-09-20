import { For, Show } from 'solid-js';
import { ICONS, type IconName } from './icons';

export interface IconProps {
  name: IconName | string;
  size?: number;
  /** Extra classes, e.g. for colour overrides. */
  class?: string;
  title?: string;
}

/**
 * Renders an icon from the registry. Icons inherit `currentColor`, so a parent's `color`
 * (hover, active, disabled) drives them with no per-icon state.
 */
export function Icon(props: IconProps) {
  const def = () => ICONS[props.name as IconName];
  const paths = () => {
    const d = def()?.d;
    return d === undefined ? [] : Array.isArray(d) ? d : [d];
  };
  const size = () => props.size ?? 16;

  return (
    <Show
      when={def()}
      fallback={
        // A missing icon should be obvious in development, not silently blank.
        <svg
          width={size()}
          height={size()}
          viewBox="0 0 16 16"
          class={props.class}
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-dasharray="2 2" opacity="0.5" />
        </svg>
      }
    >
      <svg
        width={size()}
        height={size()}
        viewBox="0 0 16 16"
        class={props.class}
        fill="none"
        stroke={def()!.fill ? 'none' : 'currentColor'}
        stroke-width="1.25"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray={def()!.dash}
        aria-hidden={props.title ? undefined : 'true'}
        role={props.title ? 'img' : undefined}
      >
        <Show when={props.title}>
          <title>{props.title}</title>
        </Show>
        <For each={paths()}>{(d) => <path d={d} fill={def()!.fill ? 'currentColor' : 'none'} />}</For>
      </svg>
    </Show>
  );
}
