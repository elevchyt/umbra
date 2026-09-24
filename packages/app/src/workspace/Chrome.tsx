import { For, Show, createMemo, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { store } from '../state/store';
import { TOOL_BY_ID } from '../tools/registry';

/** Document tab strip — spec 01 §1 ("Document area"). */
export function DocumentTabs(props: { onClose: (id: number) => void; onSelect: (id: number) => void; onCloseContents?: () => void }) {
  return (
    <Show when={store.tabs.length > 0}>
      <div class="doc-tabs">
        <For each={store.tabs}>
          {(t) => (
            <div
              class="doc-tab"
              classList={{ active: store.activeTab() === t.id && !store.doc()?.editingContents }}
              onClick={() => props.onSelect(t.id)}
              onAuxClick={(e) => {
                // Middle-click closes, as in every tabbed editor.
                if (e.button === 1) props.onClose(t.id);
              }}
            >
              <span class="doc-tab-title">{tabTitle(t)}</span>
              <button
                type="button"
                class="doc-tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(t.id);
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )}
        </For>
        {/* A smart object's contents open as their own tab, after the document holding them. */}
        <For each={store.doc()?.editingContents?.path.slice(1) ?? []}>
          {(name, i) => (
            <div class="doc-tab" classList={{ active: i() === (store.doc()?.editingContents?.path.length ?? 0) - 2 }}>
              <span class="doc-tab-title">
                {name}
                {i() === (store.doc()?.editingContents?.path.length ?? 0) - 2 && store.doc()?.editingContents?.dirty ? ' *' : ''}
              </span>
              <button
                type="button"
                class="doc-tab-close"
                title="Close the contents and return to the smart object"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCloseContents?.();
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function tabTitle(t: { name: string; dirty: boolean }): string {
  const doc = store.doc();
  const stats = store.stats();
  const zoom = stats ? `${(stats.zoom * 100).toFixed(1)}%` : '';
  const mode = doc ? 'RGB/8' : '';
  // Photoshop's asterisk: changes that are not saved to disk.
  return `${t.name} @ ${zoom} (${mode})${t.dirty || doc?.dirty ? '*' : ''}`;
}

/**
 * Status bar — spec 01 §1. The info field's ▸ menu chooses what is displayed; the M1 set is
 * the subset we can actually compute today.
 */
export type StatusField =
  | 'documentSizes'
  | 'documentProfile'
  | 'documentDimensions'
  | 'scratchSizes'
  | 'efficiency'
  | 'timing'
  | 'currentTool'
  | 'layerCount';

export function StatusBar(props: { onZoomChange: (pct: number) => void }) {
  const [field, setField] = createSignal<StatusField>('documentSizes');
  const stats = () => store.stats();
  const doc = () => store.doc();

  const fieldText = createMemo(() => {
    const d = doc();
    const s = stats();
    switch (field()) {
      case 'documentDimensions':
        return d ? `${d.width} px × ${d.height} px (72 ppi)` : '—';
      case 'documentProfile':
        return 'Untagged RGB';
      case 'scratchSizes':
        return s ? `Scratch: ${(s.tileBytes / 1e6).toFixed(1)} MB` : '—';
      case 'efficiency':
        return s ? `Efficiency: ${s.atlasThrash === 0 ? '100%' : '<100%'}` : '—';
      case 'timing':
        return s ? `Timing: ${s.frameMs.toFixed(2)} s` : '—';
      case 'currentTool':
        return TOOL_BY_ID.get(store.activeTool())?.name ?? '—';
      case 'layerCount':
        return `${d?.layers.length ?? 0} layers`;
      case 'documentSizes':
      default: {
        if (!d || !s) return '—';
        const flat = (d.width * d.height * 4) / 1e6;
        return `Doc: ${flat.toFixed(1)}M/${(s.tileBytes / 1e6).toFixed(1)}M`;
      }
    }
  });

  return (
    <div class="status-bar">
      <input
        class="status-zoom"
        value={stats() ? `${(stats()!.zoom * 100).toFixed(2)}%` : '100%'}
        onChange={(e) => {
          const v = parseFloat(e.currentTarget.value.replace('%', ''));
          if (Number.isFinite(v)) props.onZoomChange(v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span class="status-sep" />
      <select
        class="status-field"
        value={field()}
        onChange={(e) => setField(e.currentTarget.value as StatusField)}
        title="Choose what this field shows"
      >
        <option value="documentSizes">Document Sizes</option>
        <option value="documentProfile">Document Profile</option>
        <option value="documentDimensions">Document Dimensions</option>
        <option value="scratchSizes">Scratch Sizes</option>
        <option value="efficiency">Efficiency</option>
        <option value="timing">Timing</option>
        <option value="currentTool">Current Tool</option>
        <option value="layerCount">Layer Count</option>
      </select>
      <span class="status-text">{fieldText()}</span>

      <span class="spacer" />

      <Show when={store.statusMessage()}>
        {(m) => <span class="status-hint">{m()}</span>}
      </Show>
      <Show when={store.contextLost()}>
        <span class="status-bad">GPU context lost — restoring…</span>
      </Show>
      <Show when={stats()}>
        {(s) => (
          <span class="status-perf" title="Frame time and composite statistics">
            {s().fps.toFixed(0)} fps · {s().drawCalls} draws · {(s().tileBytes / 1e6).toFixed(0)} MB
          </span>
        )}
      </Show>
    </div>
  );
}

/** Horizontal and vertical rulers drawn around the canvas (View ▸ Rulers). */
export function Rulers(props: { width: number; height: number }) {
  return (
    <>
      <div class="ruler ruler-h" style={{ width: `${props.width}px` }} />
      <div class="ruler ruler-v" style={{ height: `${props.height}px` }} />
      <div class="ruler-corner" />
    </>
  );
}
