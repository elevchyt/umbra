import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Icon } from '../icons/Icon';
import { ColorWells } from '../widgets/controls';

/**
 * Tools panel — spec 01 §1.
 *
 * A group button shows the group's most recently used tool. Groups with more than one tool
 * carry the small corner mark and open a flyout on long-press or right-click, listing every
 * member with its shortcut letter. That is exactly how Photoshop's toolbar behaves, and the
 * muscle memory depends on it.
 */

export interface ToolsPanelTool {
  id: string;
  name: string;
  icon: string;
  key?: string;
  implemented?: boolean;
}

export interface ToolsPanelGroup {
  id: string;
  tools: ToolsPanelTool[];
}

export interface ToolsPanelProps {
  groups: ToolsPanelGroup[];
  activeTool: string;
  /** Group id → currently shown tool id. */
  groupDefaults: Record<string, string>;
  doubleColumn: boolean;
  onToggleColumns: () => void;
  onSelect: (toolId: string) => void;
  foreground: string;
  background: string;
  onSwapColors: () => void;
  onResetColors: () => void;
  onPickColor: (which: 'foreground' | 'background') => void;
  quickMask: boolean;
  onToggleQuickMask: () => void;
  onCycleScreenMode: () => void;
  onEditToolbar: () => void;
}

const LONG_PRESS_MS = 320;

export function ToolsPanel(props: ToolsPanelProps) {
  const [flyout, setFlyout] = createSignal<{ group: ToolsPanelGroup; y: number } | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => clearTimeout(pressTimer));

  const shownTool = (g: ToolsPanelGroup): ToolsPanelTool => {
    const id = props.groupDefaults[g.id];
    return g.tools.find((t) => t.id === id) ?? g.tools[0]!;
  };

  const openFlyout = (g: ToolsPanelGroup, el: HTMLElement) => {
    if (g.tools.length < 2) return;
    setFlyout({ group: g, y: el.getBoundingClientRect().top });
  };

  const closeFlyout = () => setFlyout(null);

  // Escape must dismiss the flyout. Without this the full-screen scrim stays up and silently
  // swallows the next click anywhere in the app.
  createEffect(() => {
    if (!flyout()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeFlyout();
      }
    };
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => document.removeEventListener('keydown', onKey, true));
  });

  return (
    <div class="tools-panel" classList={{ double: props.doubleColumn }}>
      <button
        type="button"
        class="tools-collapse"
        title={props.doubleColumn ? 'Collapse to one column' : 'Expand to two columns'}
        onClick={props.onToggleColumns}
      >
        <Icon name={props.doubleColumn ? 'doubleChevronLeft' : 'doubleChevronRight'} size={12} />
      </button>

      <div class="tools-grid">
        <For each={props.groups}>
          {(g) => {
            const tool = () => shownTool(g);
            const isActive = () => g.tools.some((t) => t.id === props.activeTool);
            // Narrowing `tool().key` inside the template does not survive the second call.
            const title = () => {
              const t = tool();
              return t.key ? `${t.name}  (${t.key.toUpperCase()})` : t.name;
            };
            return (
              <button
                type="button"
                class="tool-button"
                classList={{ active: isActive(), unimplemented: !tool().implemented }}
                title={title()}
                onPointerDown={(e) => {
                  if (e.button === 2) return;
                  const el = e.currentTarget;
                  clearTimeout(pressTimer);
                  pressTimer = setTimeout(() => openFlyout(g, el), LONG_PRESS_MS);
                }}
                onPointerUp={() => clearTimeout(pressTimer)}
                onPointerLeave={() => clearTimeout(pressTimer)}
                onClick={() => {
                  clearTimeout(pressTimer);
                  if (!flyout()) props.onSelect(tool().id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openFlyout(g, e.currentTarget);
                }}
              >
                <Icon name={tool().icon} size={18} />
                <Show when={g.tools.length > 1}>
                  <span class="tool-corner" aria-hidden="true" />
                </Show>
              </button>
            );
          }}
        </For>
      </div>

      <button type="button" class="tools-more" title="Edit Toolbar…" onClick={props.onEditToolbar}>
        <Icon name="moreHorizontal" size={16} />
      </button>

      <div class="tools-footer">
        <ColorWells
          foreground={props.foreground}
          background={props.background}
          onSwap={props.onSwapColors}
          onReset={props.onResetColors}
          onPick={props.onPickColor}
        />
        <button
          type="button"
          class="tool-button small"
          classList={{ active: props.quickMask }}
          title="Edit in Quick Mask Mode (Q)"
          onClick={props.onToggleQuickMask}
        >
          <Icon name="quickMask" size={16} />
        </button>
        <button
          type="button"
          class="tool-button small"
          title="Change Screen Mode (F)"
          onClick={props.onCycleScreenMode}
        >
          <Icon name="screenMode" size={16} />
        </button>
      </div>

      <Show when={flyout()}>
        {(f) => (
          <>
            <div class="flyout-scrim" onPointerDown={closeFlyout} />
            <div class="tool-flyout" style={{ top: `${f().y}px` }}>
              <For each={f().group.tools}>
                {(t) => (
                  <button
                    type="button"
                    class="tool-flyout-row"
                    classList={{ active: t.id === props.activeTool, unimplemented: !t.implemented }}
                    onClick={() => {
                      closeFlyout();
                      props.onSelect(t.id);
                    }}
                  >
                    <Icon name={t.icon} size={16} />
                    <span class="tool-flyout-name">{t.name}</span>
                    <Show when={t.key}>
                      <span class="tool-flyout-key">{t.key!.toUpperCase()}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
