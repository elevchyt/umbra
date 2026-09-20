import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '../icons/Icon';

/**
 * Application menu bar — drawn in-app rather than natively so Linux and Windows look
 * identical and so disabled/checked state is driven by our own command registry (spec 01 §1).
 *
 * Every panel renders through a Portal with FIXED positioning. Nesting them inside the parent
 * panel is the obvious approach but cannot work: long menus (Filter, Layer) have to scroll,
 * and `overflow-y: auto` establishes a clipping context that an absolutely positioned submenu
 * cannot escape — the submenu simply vanishes. Portalling also lets a panel that would run off
 * the bottom or right of the window flip back on itself.
 *
 * Behaviours copied from every desktop menu: click to open, then HOVER switches menus without
 * a second click; submenus open on hover after a short delay; Escape closes; a click outside
 * closes.
 */

export interface MenuBarNode {
  separator?: true;
  label?: string;
  cmd?: string;
  shortcut?: string;
  items?: MenuBarNode[];
  done?: true;
  checkable?: true;
}

export interface MenuBarMenu {
  label: string;
  items: MenuBarNode[];
}

export interface MenuBarProps {
  menus: MenuBarMenu[];
  onCommand: (cmd: string) => void;
  isEnabled?: (cmd: string) => boolean;
  isChecked?: (cmd: string) => boolean;
}

interface Anchor {
  x: number;
  y: number;
  /** Right edge / bottom of the anchor, used when flipping. */
  right: number;
  bottom: number;
}

const MENU_MIN_WIDTH = 220;

export function MenuBar(props: MenuBarProps) {
  const [open, setOpen] = createSignal<{ index: number; anchor: Anchor } | null>(null);
  let barRef!: HTMLDivElement;

  const close = () => setOpen(null);

  const anchorOf = (el: HTMLElement): Anchor => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom, right: r.right, bottom: r.bottom };
  };

  onMount(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!open()) return;
      const t = e.target as HTMLElement;
      // Clicks inside the bar or inside any portalled panel keep the menu open.
      if (barRef.contains(t) || t.closest('.menu-panel')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open()) {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    });
  });

  const enabled = (n: MenuBarNode) => {
    if (n.items) return true;
    if (!n.cmd) return false;
    return props.isEnabled ? props.isEnabled(n.cmd) : !!n.done;
  };

  return (
    <div class="menubar" ref={barRef} role="menubar">
      <For each={props.menus}>
        {(menu, i) => (
          <button
            type="button"
            class="menubar-item"
            classList={{ open: open()?.index === i() }}
            aria-haspopup="true"
            aria-expanded={open()?.index === i()}
            onPointerDown={(e) => {
              e.preventDefault();
              if (open()?.index === i()) close();
              else setOpen({ index: i(), anchor: anchorOf(e.currentTarget) });
            }}
            onPointerEnter={(e) => {
              if (open()) setOpen({ index: i(), anchor: anchorOf(e.currentTarget) });
            }}
          >
            {menu.label}
          </button>
        )}
      </For>

      <Show when={open()}>
        {(o) => (
          <MenuPanel
            items={props.menus[o().index]!.items}
            anchor={o().anchor}
            submenu={false}
            enabled={enabled}
            isChecked={props.isChecked}
            onPick={(cmd) => {
              close();
              props.onCommand(cmd);
            }}
          />
        )}
      </Show>
    </div>
  );
}

function MenuPanel(props: {
  items: MenuBarNode[];
  anchor: Anchor;
  submenu: boolean;
  enabled: (n: MenuBarNode) => boolean;
  isChecked?: (cmd: string) => boolean;
  onPick: (cmd: string) => void;
}) {
  const [sub, setSub] = createSignal<{ index: number; anchor: Anchor } | null>(null);
  const [el, setEl] = createSignal<HTMLDivElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  /** Keep the panel inside the window, flipping rather than overflowing. */
  const placement = () => {
    const a = props.anchor;
    const node = el();
    const w = node?.offsetWidth ?? MENU_MIN_WIDTH;
    const h = node?.offsetHeight ?? 0;
    let left = props.submenu ? a.right : a.x;
    let top = props.submenu ? a.y : a.bottom;
    if (left + w > window.innerWidth - 4) {
      left = props.submenu ? Math.max(4, a.x - w) : Math.max(4, window.innerWidth - w - 4);
    }
    if (h && top + h > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - h - 4);
    }
    return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
  };

  const scheduleSub = (index: number | null, target?: HTMLElement) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        if (index === null || !target) setSub(null);
        else {
          const r = target.getBoundingClientRect();
          setSub({ index, anchor: { x: r.left, y: r.top - 5, right: r.right, bottom: r.bottom } });
        }
      },
      index === null ? 200 : 70,
    );
  };

  return (
    <Portal>
      <div
        class="menu-panel"
        classList={{ submenu: props.submenu }}
        style={placement()}
        ref={setEl}
        role="menu"
      >
        <For each={props.items}>
          {(node, i) => (
            <Show when={!node.separator} fallback={<div class="menu-separator" role="separator" />}>
              <div
                class="menu-row"
                classList={{
                  disabled: !props.enabled(node),
                  'has-sub': !!node.items,
                  'sub-open': sub()?.index === i(),
                }}
                role="menuitem"
                aria-disabled={!props.enabled(node)}
                onPointerEnter={(e) => scheduleSub(node.items ? i() : null, e.currentTarget)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (node.items || !node.cmd || !props.enabled(node)) return;
                  props.onPick(node.cmd);
                }}
              >
                <span class="menu-check">
                  <Show when={node.checkable && node.cmd && props.isChecked?.(node.cmd)}>
                    <Icon name="check" size={12} />
                  </Show>
                </span>
                <span class="menu-label">{node.label}</span>
                <Show when={node.shortcut}>
                  <span class="menu-shortcut">{node.shortcut}</span>
                </Show>
                <span class="menu-arrow">
                  <Show when={node.items}>
                    <Icon name="chevronRight" size={12} />
                  </Show>
                </span>
              </div>
            </Show>
          )}
        </For>
      </div>

      <Show when={sub()}>
        {(s) => (
          <MenuPanel
            items={props.items[s().index]!.items!}
            anchor={s().anchor}
            submenu={true}
            enabled={props.enabled}
            isChecked={props.isChecked}
            onPick={props.onPick}
          />
        )}
      </Show>
    </Portal>
  );
}
