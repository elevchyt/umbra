import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Select, Checkbox, Slider } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { hsbToRgb, rgbToCss, rgbToHsb, rgbToHex, hexToRgb, type RGB } from '@umbra/core/color';
import { store } from '../state/store';
import { PANEL_META } from './registry';

export { PANEL_META, PANEL_BY_COMMAND } from './registry';

/**
 * Panel registry — spec 01 §4.
 *
 * Every panel in the Window menu has an entry so it can be opened and docked. Panels whose
 * real content depends on a later milestone render a short, honest placeholder naming the
 * milestone rather than a fake UI, so the shell can be evaluated without implying the feature
 * works.
 */

export function renderPanel(id: string): JSX.Element {
  switch (id) {
    case 'layers':
      return <LayersPanel />;
    case 'color':
      return <ColorPanel />;
    case 'swatches':
      return <SwatchesPanel />;
    case 'navigator':
      return <NavigatorPanel />;
    case 'info':
      return <InfoPanel />;
    case 'properties':
      return <PropertiesPanel />;
    case 'history':
      return <HistoryPanel />;
    case 'channels':
      return <ChannelsPanel />;
    case 'paths':
      return <Placeholder name="Paths" milestone="M7" what="work path, saved paths, fill and stroke path" />;
    case 'adjustments':
      return <Placeholder name="Adjustments" milestone="M4" what="the 16 adjustment layers and their presets" />;
    case 'brushSettings':
      return <Placeholder name="Brush Settings" milestone="M8" what="shape dynamics, scattering, texture, dual brush, transfer" />;
    case 'brushes':
      return <Placeholder name="Brushes" milestone="M3" what="brush presets and .abr import" />;
    case 'histogram':
      return <Placeholder name="Histogram" milestone="M4" what="per-channel histograms and statistics" />;
    default:
      return <Placeholder name={PANEL_META[id]?.title ?? id} milestone="later" what="" />;
  }
}

function Placeholder(props: { name: string; milestone: string; what: string }) {
  return (
    <div class="panel-placeholder">
      <div class="panel-placeholder-title">{props.name}</div>
      <Show when={props.what}>
        <p>{props.what}</p>
      </Show>
      <p class="dim">Arrives in {props.milestone}.</p>
    </div>
  );
}

// ---- Layers ---------------------------------------------------------------------------

function LayersPanel() {
  const rows = () => store.doc()?.layers ?? [];
  const active = () => store.doc()?.activeLayerIds ?? [];

  const blendOptions = BLEND_MENU.filter((m) => m !== '-').map((m) => ({
    value: m as BlendMode,
    label: BLEND_LABEL[m as BlendMode],
  }));

  const selected = () => rows().find((r) => active().includes(r.id));

  return (
    <div class="layers-panel">
      <div class="layers-filter">
        <Select value="kind" options={[{ value: 'kind', label: 'Kind' }]} onChange={() => {}} width={62} />
        <div class="layers-filter-icons">
          <For each={['newLayer', 'adjustment', 'type', 'customShape', 'snapshot']}>
            {(ic) => (
              <button type="button" class="mini-icon" disabled title="Filter by layer kind (M11)">
                <Icon name={ic} size={13} />
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="layers-blend">
        <Select
          value={(selected()?.blendMode ?? 'normal') as BlendMode}
          options={blendOptions}
          onChange={(m) => {
            const id = selected()?.id;
            if (id !== undefined) store.engine?.({ t: 'setLayerBlendMode', id, mode: m });
          }}
          width={118}
        />
        <NumberField
          label="Opacity"
          value={Math.round((selected()?.opacity ?? 1) * 100)}
          onChange={(v) => {
            const id = selected()?.id;
            if (id !== undefined) store.engine?.({ t: 'setLayerOpacity', id, opacity: v / 100 });
          }}
          min={0}
          max={100}
          suffix="%"
          width={34}
        />
      </div>

      <div class="layers-locks">
        <span class="locks-label">Lock:</span>
        <For each={[
          ['lockTransparency', 'Lock transparent pixels'],
          ['lockPixels', 'Lock image pixels'],
          ['lockPosition', 'Lock position'],
          ['lock', 'Lock all'],
        ] as const}>
          {([icon, title]) => (
            <button type="button" class="mini-icon" title={title} disabled>
              <Icon name={icon} size={13} />
            </button>
          )}
        </For>
        <NumberField label="Fill" value={Math.round((selected()?.fill ?? 1) * 100)} onChange={() => {}} min={0} max={100} suffix="%" width={34} />
      </div>

      <div class="layers-list">
        <Show
          when={rows().length > 0}
          fallback={<div class="layers-empty">No layers. Open an image or create a document.</div>}
        >
          <For each={rows()}>
            {(l) => (
              <div
                class="layer-row"
                classList={{ selected: active().includes(l.id) }}
                style={{ 'padding-left': `${6 + l.depth * 14}px` }}
                onClick={() => store.engine?.({ t: 'selectLayer', id: l.id })}
              >
                <button
                  type="button"
                  class="layer-eye"
                  title="Toggle layer visibility"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.engine?.({ t: 'setLayerVisible', id: l.id, visible: !l.visible });
                  }}
                >
                  <Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} />
                </button>

                <Show when={l.kind === 'group'}>
                  <button
                    type="button"
                    class="layer-twirl"
                    title={l.expanded ? 'Collapse group' : 'Expand group'}
                    onClick={(e) => {
                      e.stopPropagation();
                      store.engine?.({ t: 'toggleGroup', id: l.id });
                    }}
                  >
                    <Icon name={l.expanded ? 'chevronDown' : 'chevronRight'} size={11} />
                  </button>
                </Show>

                <div class="layer-thumb" classList={{ group: l.kind === 'group' }} aria-hidden="true">
                  <Show when={l.kind === 'group'}>
                    <Icon name="folder" size={14} />
                  </Show>
                </div>

                <Show when={l.hasMask}>
                  <div class="layer-mask-thumb" title="Layer mask" aria-hidden="true" />
                </Show>

                <span class="layer-name">
                  <Show when={l.clipped}>
                    <span class="layer-clip" title="Clipped to the layer below">↳</span>
                  </Show>
                  {l.name}
                </span>

                <Show when={l.blendMode !== 'normal' && l.blendMode !== 'passThrough'}>
                  <span class="layer-badge" title={`Blend mode: ${l.blendMode}`}>
                    {l.blendMode.slice(0, 3)}
                  </span>
                </Show>
                <Show when={l.opacity < 1}>
                  <span class="layer-badge" title="Opacity">{Math.round(l.opacity * 100)}%</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      <Show when={store.doc()?.warnings?.length}>
        <div class="layers-warning" title="These layers open and render from the raster stored in the file, but are not editable yet">
          <Icon name="warning" size={12} />
          {store.doc()!.warnings!.length} layer(s) use features not modelled yet
        </div>
      </Show>

      <div class="panel-footer">
        <For each={[
          ['linkChain', 'Link layers'],
          ['fx', 'Add a layer style'],
          ['addMask', 'Add layer mask'],
          ['adjustment', 'Create new fill or adjustment layer'],
          ['folder', 'Create a new group'],
          ['newLayer', 'Create a new layer'],
          ['trash', 'Delete layer'],
        ] as const}>
          {([icon, title]) => (
            <button type="button" class="mini-icon" title={title} disabled>
              <Icon name={icon} size={15} />
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

// ---- Channels -------------------------------------------------------------------------

/**
 * Channels panel — spec 01 §4.
 *
 * The colour channels are derived from the document rather than stored, so they are listed
 * from the colour mode; only the alpha channels below them are real objects. Clicking a row
 * changes what the canvas shows, which is a view setting and deliberately not undoable.
 */
function ChannelsPanel() {
  const doc = () => store.doc();
  const view = () => store.channelView();
  const send = (msg: unknown) => store.engine?.(msg);

  const setView = (v: 'all' | 'r' | 'g' | 'b' | number) => {
    store.setChannelView(v);
    send({ t: 'setChannelView', view: v });
  };

  const COLOUR_ROWS = [
    { key: 'all' as const, name: 'RGB', shortcut: 'Ctrl+2' },
    { key: 'r' as const, name: 'Red', shortcut: 'Ctrl+3' },
    { key: 'g' as const, name: 'Green', shortcut: 'Ctrl+4' },
    { key: 'b' as const, name: 'Blue', shortcut: 'Ctrl+5' },
  ];

  return (
    <div class="layers-panel">
      <div class="layer-rows">
        <For each={COLOUR_ROWS}>
          {(row) => (
            <div
              class="layer-row"
              classList={{ active: view() === row.key }}
              onClick={() => setView(row.key)}
            >
              <button
                type="button"
                class="layer-eye"
                title="Channel visibility"
                onClick={(e) => {
                  e.stopPropagation();
                  setView(row.key);
                }}
              >
                <Icon name={view() === row.key || view() === 'all' ? 'eye' : 'eyeOff'} size={14} />
              </button>
              <span class="layer-thumb channel-thumb" />
              <span class="layer-name">{row.name}</span>
              <span class="dim">{row.shortcut}</span>
            </div>
          )}
        </For>
        <For each={doc()?.channels ?? []}>
          {(c) => (
            <div
              class="layer-row"
              classList={{ active: view() === c.id }}
              onClick={() => setView(c.id)}
            >
              <button
                type="button"
                class="layer-eye"
                title="Channel visibility"
                onClick={(e) => {
                  e.stopPropagation();
                  send({ t: 'channelCommand', command: 'update', id: c.id, patch: { visible: !c.visible } });
                }}
              >
                <Icon name={c.visible ? 'eye' : 'eyeOff'} size={14} />
              </button>
              <span class="layer-thumb channel-thumb" />
              <span class="layer-name">{c.name}</span>
            </div>
          )}
        </For>
      </div>
      <div class="panel-footer">
        <button
          type="button"
          class="icon-button"
          title="Load channel as selection"
          disabled={typeof view() !== 'number'}
          onClick={() => send({ t: 'loadSelection', channelId: view() })}
        >
          <Icon name="marqueeRect" size={14} />
        </button>
        <button
          type="button"
          class="icon-button"
          title="Save selection as channel"
          disabled={!doc()?.hasSelection}
          onClick={() => send({ t: 'saveSelection' })}
        >
          <Icon name="quickMask" size={14} />
        </button>
        <button
          type="button"
          class="icon-button"
          title="Create new channel"
          onClick={() => send({ t: 'channelCommand', command: 'newFromSelection' })}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          class="icon-button"
          title="Delete channel"
          disabled={typeof view() !== 'number'}
          onClick={() => {
            send({ t: 'channelCommand', command: 'delete', id: view() });
            setView('all');
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

// ---- Color ----------------------------------------------------------------------------

function ColorPanel() {
  const fg = () => store.foreground();
  const hsb = createMemo(() => rgbToHsb(fg()));

  const setFromHsb = (patch: Partial<{ h: number; s: number; b: number }>) => {
    store.setForeground(hsbToRgb({ ...hsb(), ...patch }));
  };

  return (
    <div class="color-panel">
      <div class="color-swatch-row">
        <div class="color-current" style={{ background: rgbToCss(fg()) }} />
        <div class="color-sliders">
          <ColorSlider label="H" value={hsb().h} max={360} onChange={(h) => setFromHsb({ h })}
            gradient="linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" />
          <ColorSlider label="S" value={hsb().s} max={100} onChange={(s) => setFromHsb({ s })}
            gradient={`linear-gradient(to right, ${rgbToCss(hsbToRgb({ ...hsb(), s: 0 }))}, ${rgbToCss(hsbToRgb({ ...hsb(), s: 100 }))})`} />
          <ColorSlider label="B" value={hsb().b} max={100} onChange={(b) => setFromHsb({ b })}
            gradient={`linear-gradient(to right, #000, ${rgbToCss(hsbToRgb({ ...hsb(), b: 100 }))})`} />
        </div>
      </div>
      <div class="color-hex">
        <span>#</span>
        <input
          value={rgbToHex(fg())}
          spellcheck={false}
          onChange={(e) => {
            const c = hexToRgb(e.currentTarget.value);
            if (c) store.setForeground(c);
            else e.currentTarget.value = rgbToHex(fg());
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div class="color-ramp" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setFromHsb({ h: ((e.clientX - r.left) / r.width) * 360, s: 100, b: 100 });
      }} />
    </div>
  );
}

function ColorSlider(props: { label: string; value: number; max: number; gradient: string; onChange: (v: number) => void }) {
  return (
    <div class="color-slider">
      <span class="color-slider-label">{props.label}</span>
      <div class="color-slider-track" style={{ background: props.gradient }}>
        <input
          type="range"
          min={0}
          max={props.max}
          step={1}
          value={props.value}
          onInput={(e) => props.onChange(+e.currentTarget.value)}
        />
      </div>
      <NumberField value={Math.round(props.value)} onChange={props.onChange} min={0} max={props.max} width={32} />
    </div>
  );
}

// ---- Swatches -------------------------------------------------------------------------

/** Original default swatch set — no Adobe preset library is redistributed (spec 07 §3). */
const DEFAULT_SWATCHES: RGB[] = [
  ...['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff'],
  ...['#ff0000', '#ff7f00', '#ffff00', '#7fff00', '#00ff00'],
  ...['#00ff7f', '#00ffff', '#007fff', '#0000ff', '#7f00ff'],
  ...['#ff00ff', '#ff007f', '#7f3f00', '#3f7f00', '#003f7f'],
].map((h) => hexToRgb(h)!);

function SwatchesPanel() {
  return (
    <div class="swatches-panel">
      <div class="swatch-grid">
        <For each={DEFAULT_SWATCHES}>
          {(c) => (
            <button
              type="button"
              class="swatch"
              style={{ background: rgbToCss(c) }}
              title={`#${rgbToHex(c)}`}
              onClick={() => store.setForeground(c)}
            />
          )}
        </For>
      </div>
    </div>
  );
}

// ---- Navigator ------------------------------------------------------------------------

function NavigatorPanel() {
  const zoom = () => (store.stats()?.zoom ?? 1) * 100;
  return (
    <div class="navigator-panel">
      <div class="navigator-thumb">
        <Show when={store.doc()} fallback={<span class="dim">No document</span>}>
          {(d) => (
            <div
              class="navigator-doc"
              style={{ 'aspect-ratio': `${d().width} / ${d().height}` }}
            />
          )}
        </Show>
      </div>
      <div class="navigator-controls">
        <NumberField value={zoom()} onChange={() => {}} precision={1} suffix="%" width={52} />
        <Slider value={Math.log2(Math.max(zoom() / 100, 0.001))} min={-10} max={7} step={0.01} onChange={() => {}} width={110} />
      </div>
    </div>
  );
}

// ---- Info -----------------------------------------------------------------------------

function InfoPanel() {
  const s = () => store.stats();
  const d = () => store.doc();
  return (
    <div class="info-panel">
      <div class="info-grid">
        <span class="dim">W</span>
        <span>{d()?.width ?? '—'} px</span>
        <span class="dim">H</span>
        <span>{d()?.height ?? '—'} px</span>
        <span class="dim">Zoom</span>
        <span>{s() ? `${(s()!.zoom * 100).toFixed(1)}%` : '—'}</span>
        <span class="dim">Layers</span>
        <span>{d()?.layers.length ?? 0}</span>
      </div>
      <div class="info-note dim">
        Colour readouts, samplers and before/after values arrive with the adjustment work in M4.
      </div>
    </div>
  );
}

// ---- Properties -----------------------------------------------------------------------

function PropertiesPanel() {
  const d = () => store.doc();
  return (
    <div class="properties-panel">
      <div class="properties-head">Document</div>
      <Show when={d()} fallback={<div class="dim pad">No document</div>}>
        {(doc) => (
          <div class="properties-grid">
            <NumberField label="W" value={doc().width} onChange={() => {}} suffix="px" width={56} />
            <NumberField label="H" value={doc().height} onChange={() => {}} suffix="px" width={56} />
            <Checkbox checked={store.extras.rulers} onChange={(v) => store.setExtras('rulers', v)} label="Rulers" />
            <Checkbox checked={store.extras.grid} onChange={(v) => store.setExtras('grid', v)} label="Grid" />
            <Checkbox checked={store.extras.guides} onChange={(v) => store.setExtras('guides', v)} label="Guides" />
          </div>
        )}
      </Show>
    </div>
  );
}

// ---- History --------------------------------------------------------------------------

function HistoryPanel() {
  return (
    <div class="history-panel">
      <div class="history-row current">
        <Icon name="snapshot" size={14} />
        <span>{store.doc()?.name ?? 'Untitled'}</span>
      </div>
      <div class="panel-placeholder">
        <p class="dim">
          History states, snapshots and the history-brush source appear here once the command
          bus records undo in M2.
        </p>
      </div>
    </div>
  );
}
