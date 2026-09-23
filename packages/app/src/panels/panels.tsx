import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { ADJUSTMENT_LABEL, defaultAdjustment, type Adjustment } from '@umbra/engine';
import { AdjustmentEditor } from '../adjust/editors';
import { ADJUSTMENT_ICON, initialAdjustment } from '../adjust/initial';
import { FillEditor, PatternPicker, patternThumb } from '../adjust/fill';
import { gradientCss } from '../adjust/editors';
import { STYLE_ITEMS, type StyleKey } from '../fx/LayerStyleDialog';
import { MENUS } from '../menus/menus';
import { StylesPanel } from '../fx/StylesPanel';
import { PathsPanel } from '../paths/PathsPanel';
import { pathSvg } from '../workspace/ShapeOptions';
import { FILL_LABEL, FILTER_BY_ID, type LayerEffects, type FillSummary, type ProbePoint, type SmartFilterSummary, type SmartSummary } from '@umbra/engine';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Select, Checkbox, Slider } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { hsbToRgb, rgbToCss, rgbToHsb, rgbToHex, hexToRgb, rgbToCmyk, type RGB } from '@umbra/core/color';
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
      return <PathsPanel />;
    case 'adjustments':
      return <AdjustmentsPanel />;
    case 'brushSettings':
      return <Placeholder name="Brush Settings" milestone="M8" what="shape dynamics, scattering, texture, dual brush, transfer" />;
    case 'brushes':
      return <Placeholder name="Brushes" milestone="M3" what="brush presets and .abr import" />;
    case 'histogram':
      return <HistogramPanel />;
    case 'styles':
      return <StylesPanel />;
    case 'patterns':
      return <PatternsPanel />;
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
  const [fxMenu, setFxMenu] = createSignal(false);
  const [adjMenu, setAdjMenu] = createSignal(false);
  // Effect lists show until folded, as Photoshop shows a new style's.
  const [fxClosed, setFxClosed] = createSignal<Set<number>>(new Set());
  const fxOpen = () => ({ has: (id: number) => !fxClosed().has(id) });
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
          ['lockTransparency', 'Lock transparent pixels', 'transparency'],
          ['lockPixels', 'Lock image pixels', 'pixels'],
          ['lockPosition', 'Lock position', 'position'],
          ['lock', 'Lock all', 'all'],
        ] as const}>
          {([icon, title, key]) => (
            <button
              type="button"
              class="mini-icon"
              classList={{ active: !!selected()?.locks?.[key] }}
              title={title}
              disabled={!selected()}
              onClick={() => {
                const l = selected();
                if (!l) return;
                store.engine?.({ t: 'setLayerLocks', id: l.id, locks: { [key]: !l.locks?.[key] } });
              }}
            >
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
              <>
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

                <div
                  class="layer-thumb"
                  classList={{
                    group: l.kind === 'group',
                    adjustment: l.kind === 'adjustment',
                    fill: l.kind === 'fill',
                    smart: l.kind === 'smart',
                    targeted: active().includes(l.id) && (l.kind === 'pixel' || l.kind === 'smart') && store.doc()?.maskTarget !== l.id && store.doc()?.filterMaskTarget !== l.id,
                  }}
                  aria-hidden="true"
                  onClick={() => {
                    // Clicking the layer thumbnail makes the pixels the edit target again.
                    if ((l.hasMask && l.kind === 'pixel') || l.kind === 'smart') store.engine?.({ t: 'setMaskTarget', id: l.id, mask: false });
                  }}
                  onDblClick={() => {
                    // Photoshop opens an adjustment layer's settings from its thumbnail, and a
                    // smart object's contents.
                    if (l.kind === 'adjustment' || l.kind === 'fill' || l.kind === 'shape') store.openPanel('properties');
                    if (l.kind === 'smart') store.engine?.({ t: 'editContents' });
                  }}
                >
                  <Show when={l.kind === 'group'}>
                    <Icon name="folder" size={14} />
                  </Show>
                  <Show when={l.kind === 'adjustment' && l.adjustment}>
                    {(a) => <Icon name={ADJUSTMENT_ICON[a().kind]} size={15} />}
                  </Show>
                  <Show when={l.kind === 'fill' && l.fillContent}>
                    {(c) => <span class="layer-fill-swatch" style={{ background: fillCss(c()) }} />}
                  </Show>
                  <Show when={l.kind === 'smart'}>
                    <span class="layer-smart-badge" title={`Smart object — ${l.smart?.sourceName ?? ''}`} />
                  </Show>
                  <Show when={l.kind === 'shape' && l.shape}>
                    {(sh) => (
                      <svg class="layer-shape-thumb" viewBox="0 0 24 24" width="24" height="24">
                        <path
                          d={pathSvg(sh().path, 24)}
                          fill-rule="evenodd"
                          fill={sh().fill ? svgPaint(sh().fill!) : 'none'}
                          stroke={sh().stroke?.enabled ? svgPaint(sh().stroke!.content) : sh().fill ? 'none' : 'currentColor'}
                          stroke-width="1"
                        />
                      </svg>
                    )}
                  </Show>
                </div>

                <Show when={l.hasMask}>
                  <div
                    class="layer-mask-thumb"
                    classList={{ disabled: !l.maskEnabled, targeted: store.doc()?.maskTarget === l.id }}
                    title={
                      l.maskEnabled
                        ? 'Layer mask — click to paint into it, Shift-click to disable'
                        : 'Layer mask — disabled (Shift-click to enable)'
                    }
                    onClick={(e) => {
                      if (e.shiftKey) {
                        e.stopPropagation();
                        store.engine?.({ t: 'maskCommand', command: 'toggle', id: l.id });
                        return;
                      }
                      // Select the layer (the row's own handler) and make its mask the target.
                      store.engine?.({ t: 'setMaskTarget', id: l.id, mask: true });
                    }}
                  />
                </Show>

                <Show when={l.vectorMask}>
                  {(vm) => (
                    <div
                      class="layer-mask-thumb vector"
                      classList={{ disabled: !vm().enabled }}
                      title={vm().enabled ? 'Vector mask — click to edit its path, Shift-click to disable' : 'Vector mask — disabled (Shift-click to enable)'}
                      onClick={(e) => {
                        if (e.shiftKey) {
                          e.stopPropagation();
                          store.engine?.({ t: 'selectLayer', id: l.id });
                          store.engine?.({ t: 'vectorMaskCommand', cmd: 'toggle' });
                          return;
                        }
                        // The row selects the layer; clearing the path selection targets its vector mask.
                        store.engine?.({ t: 'pathCommand', cmd: 'select' });
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="24" height="24">
                        <path d={pathSvg(vm().path, 24)} fill-rule="evenodd" />
                      </svg>
                    </div>
                  )}
                </Show>

                <Show
                  when={store.renamingLayerId() === l.id}
                  fallback={
                    <span
                      class="layer-name"
                      title="Double-click to rename"
                      onDblClick={(e) => {
                        e.stopPropagation();
                        store.setRenamingLayerId(l.id);
                      }}
                    >
                      <Show when={l.clipped}>
                        <span class="layer-clip" title="Clipped to the layer below">↳</span>
                      </Show>
                      {l.name}
                    </span>
                  }
                >
                  <LayerNameEditor id={l.id} name={l.name} />
                </Show>

                <Show when={l.blendMode !== 'normal' && l.blendMode !== 'passThrough'}>
                  <span class="layer-badge" title={`Blend mode: ${l.blendMode}`}>
                    {l.blendMode.slice(0, 3)}
                  </span>
                </Show>
                <Show when={l.opacity < 1}>
                  <span class="layer-badge" title="Opacity">{Math.round(l.opacity * 100)}%</span>
                </Show>
                <Show when={l.effects}>
                  <button
                    type="button"
                    class="layer-fx"
                    classList={{ off: !l.effects!.enabled }}
                    title={fxOpen().has(l.id) ? 'Hide the list of effects' : 'Show the list of effects'}
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = new Set(fxClosed());
                      if (next.has(l.id)) next.delete(l.id);
                      else next.add(l.id);
                      setFxClosed(next);
                    }}
                    onDblClick={(e) => {
                      e.stopPropagation();
                      store.openDialog('layerStyle', { layerId: l.id, page: 'blending' });
                    }}
                  >
                    fx {fxOpen().has(l.id) ? '▾' : '▸'}
                  </button>
                </Show>
              </div>
              <Show when={l.kind === 'smart' && l.smart && l.smart.filters.length > 0 ? l.smart : null}>
                {(sm) => <SmartFilterRows layerId={l.id} depth={l.depth} smart={sm()} />}
              </Show>
              <Show when={l.effects && fxOpen().has(l.id) ? l.effects : null}>
                {(fx) => <EffectRows layerId={l.id} depth={l.depth} effects={fx()} />}
              </Show>
              </>
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
        {/* Link, layer styles and fill/adjustment layers are not built yet (M6, M4); they stay
            visibly disabled and SAY so, rather than looking live and doing nothing. */}
        <button type="button" class="mini-icon" title="Link layers — not available yet" disabled>
          <Icon name="linkChain" size={15} />
        </button>
        <div class="fx-menu-anchor">
          <button type="button" class="mini-icon" title="Add a layer style" disabled={!selected() || selected()?.kind === 'adjustment'} onClick={() => setFxMenu(!fxMenu())}>
            <Icon name="fx" size={15} />
          </button>
          <Show when={fxMenu()}>
            <div class="fx-menu" onMouseLeave={() => setFxMenu(false)}>
              <For each={STYLE_ITEMS.filter((i) => i.key !== 'bevelContour' && i.key !== 'bevelTexture' && i.key !== 'styles')}>
                {(item) => (
                  <div
                    class="fx-menu-item"
                    onClick={() => {
                      setFxMenu(false);
                      const id = selected()?.id;
                      if (id !== undefined) store.openDialog('layerStyle', { layerId: id, page: item.key });
                    }}
                  >
                    {item.label}…
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
        <button
          type="button"
          class="mini-icon"
          title="Add layer mask (Alt: hide instead of reveal)"
          disabled={!selected() || !!selected()?.hasMask}
          onClick={(e) => {
            const id = selected()?.id;
            if (id === undefined) return;
            const hasSel = !!store.doc()?.hasSelection;
            // Photoshop: click reveals (the selection, or everything); Alt-click hides.
            const command = e.altKey
              ? hasSel ? 'hideSelection' : 'hideAll'
              : hasSel ? 'revealSelection' : 'revealAll';
            store.engine?.({ t: 'maskCommand', command, id });
          }}
        >
          <Icon name="addMask" size={15} />
        </button>
        <div class="fx-menu-anchor">
          <button type="button" class="mini-icon" title="Create new fill or adjustment layer" disabled={!store.doc()} onClick={() => setAdjMenu(!adjMenu())}>
            <Icon name="adjustment" size={15} />
          </button>
          <Show when={adjMenu()}>
            <div class="fx-menu fx-menu-tall" onMouseLeave={() => setAdjMenu(false)}>
              <For each={NEW_LAYER_ITEMS()}>
                {(item) =>
                  item.cmd ? (
                    <div
                      class="fx-menu-item"
                      onClick={() => {
                        setAdjMenu(false);
                        window.dispatchEvent(new CustomEvent('umbra:command', { detail: item.cmd }));
                      }}
                    >
                      {item.label}
                    </div>
                  ) : (
                    <div class="fx-menu-sep" />
                  )
                }
              </For>
            </div>
          </Show>
        </div>
        <button
          type="button"
          class="mini-icon"
          title="Create a new group from the selected layers"
          disabled={active().length === 0}
          onClick={() => store.engine?.({ t: 'layerCommand', command: 'group', ids: [...active()] })}
        >
          <Icon name="folder" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Create a new layer"
          onClick={() => store.engine?.({ t: 'layerCommand', command: 'add' })}
        >
          <Icon name="newLayer" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Delete layer"
          disabled={!selected()}
          onClick={() => {
            const id = selected()?.id;
            if (id !== undefined) store.engine?.({ t: 'layerCommand', command: 'delete', id });
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * Inline rename, as Photoshop does it: the name becomes a field in place, Enter or clicking
 * away commits, Escape abandons. Blank is refused by the engine rather than stored.
 */
function LayerNameEditor(props: { id: number; name: string }) {
  let input!: HTMLInputElement;
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit) store.engine?.({ t: 'renameLayer', id: props.id, name: input.value });
    store.setRenamingLayerId(null);
  };
  onMount(() => {
    input.focus();
    input.select();
  });
  return (
    <input
      ref={input}
      class="layer-name-edit"
      value={props.name}
      spellcheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keep the shell's shortcuts out: a letter typed here is part of the name, not a tool.
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
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

/**
 * Navigator — spec 01 §4. A thumbnail of the whole document with the visible area outlined in
 * red; click or drag on it to pan, and the field and slider set the zoom.
 *
 * The thumbnail is requested rather than pushed: it only costs anything while this panel is
 * open, and requests are coalesced so a burst of edits renders it once.
 */
const NAV_SIZE = 200;

function NavigatorPanel() {
  let canvas!: HTMLCanvasElement;
  const zoom = () => (store.stats()?.zoom ?? 1) * 100;
  const send = (msg: unknown) => store.engine?.(msg);

  // Coalesce: many document updates in quick succession become one render.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      send({ t: 'requestThumbnail', size: NAV_SIZE });
    }, 150);
  };
  createEffect(() => {
    store.doc();
    store.engineReady();
    request();
  });
  onCleanup(() => pending && clearTimeout(pending));

  const draw = () => {
    const t = store.thumbnail();
    const s = store.stats();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = t.width;
    canvas.height = t.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(t.pixels), t.width, t.height), 0, 0);
    if (!s) return;

    // The viewport's four corners, taken back into document space through the view's zoom and
    // rotation, then down to thumbnail scale. A rotated canvas gives a rotated box.
    const k = t.width / t.docWidth;
    const cos = Math.cos(-s.viewRotation);
    const sin = Math.sin(-s.viewRotation);
    const corner = (sx: number, sy: number) => {
      const dx = (sx - s.viewWidth / 2) / s.zoom;
      const dy = (sy - s.viewHeight / 2) / s.zoom;
      return [(s.centreX + dx * cos - dy * sin) * k, (s.centreY + dx * sin + dy * cos) * k] as const;
    };
    const pts = [corner(0, 0), corner(s.viewWidth, 0), corner(s.viewWidth, s.viewHeight), corner(0, s.viewHeight)];
    ctx.strokeStyle = '#e03030';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.stroke();
  };
  createEffect(draw);

  const panTo = (e: PointerEvent) => {
    const t = store.thumbnail();
    if (!t) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * t.docWidth;
    const y = ((e.clientY - r.top) / r.height) * t.docHeight;
    send({ t: 'setCentre', x, y });
  };

  return (
    <div class="navigator-panel">
      <div class="navigator-thumb">
        <Show when={store.doc()} fallback={<span class="dim">No document</span>}>
          <canvas
            ref={canvas}
            class="navigator-canvas"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              panTo(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons & 1) panTo(e);
            }}
          />
        </Show>
      </div>
      <div class="navigator-controls">
        <NumberField
          value={zoom()}
          onChange={(v) => send({ t: 'setZoom', zoom: Math.max(0.1, v) / 100 })}
          min={0.1}
          max={12800}
          precision={1}
          suffix="%"
          width={52}
        />
        <Slider
          value={Math.log2(Math.max(zoom() / 100, 0.001))}
          min={-5}
          max={6}
          step={0.01}
          onChange={(v) => send({ t: 'setZoom', zoom: Math.pow(2, v) })}
          width={110}
        />
      </div>
    </div>
  );
}

// ---- Info -----------------------------------------------------------------------------

/**
 * Info panel — spec 01 §4. RGB and CMYK under the pointer, the colour samplers, and — while a
 * dialog previews — Photoshop's before/after pairs ("120/135"). Values are the composite's.
 */
function InfoPanel() {
  const s = () => store.stats();
  const d = () => store.doc();
  const p = () => store.probe();
  const pair = (b: number | undefined, a: number | undefined) => (b === undefined ? '—' : a === undefined || a === b ? `${b}` : `${b}/${a}`);
  const rgbRows = (pt: ProbePoint | null | undefined) => {
    const b = pt?.before;
    const a = pt?.after ?? undefined;
    return (
      <>
        <span class="dim">R</span>
        <span>{pair(b?.[0], a?.[0])}</span>
        <span class="dim">G</span>
        <span>{pair(b?.[1], a?.[1])}</span>
        <span class="dim">B</span>
        <span>{pair(b?.[2], a?.[2])}</span>
      </>
    );
  };
  const cmyk = () => {
    const b = p()?.cursor?.before;
    if (!b) return null;
    const c = rgbToCmyk({ r: b[0] / 255, g: b[1] / 255, b: b[2] / 255 });
    return `${Math.round(c.c)}  ${Math.round(c.m)}  ${Math.round(c.y)}  ${Math.round(c.k)}`;
  };
  return (
    <div class="info-panel">
      <div class="info-grid">
        {rgbRows(p()?.cursor)}
        <span class="dim">CMYK</span>
        <span class="mono">{cmyk() ?? '—'}</span>
        <span class="dim">X</span>
        <span>{p()?.cursor ? `${p()!.cursor!.x} px` : '—'}</span>
        <span class="dim">Y</span>
        <span>{p()?.cursor ? `${p()!.cursor!.y} px` : '—'}</span>
        <span class="dim">Doc</span>
        <span>{d() ? `${d()!.width} × ${d()!.height} px` : '—'}</span>
        <span class="dim">Zoom</span>
        <span>{s() ? `${(s()!.zoom * 100).toFixed(1)}%` : '—'}</span>
      </div>
      <For each={store.samplers()}>
        {(sm, i) => (
          <div class="info-sampler">
            <span class="info-sampler-label">#{i() + 1}</span>
            <div class="info-grid">{rgbRows(p()?.samplers[i()])}</div>
            <span class="dim">
              {sm.x}, {sm.y}
            </span>
          </div>
        )}
      </For>
      <Show when={store.samplers().length}>
        <button type="button" class="link-button" onClick={() => store.setSamplers([])}>
          Clear samplers
        </button>
      </Show>
      <Show when={p()?.cursor?.after || p()?.samplers.some((x) => x.after)}>
        <div class="info-note dim">Before / after the adjustment being previewed.</div>
      </Show>
    </div>
  );
}

// ---- Properties -----------------------------------------------------------------------

function PropertiesPanel() {
  const d = () => store.doc();
  const activeAdjustment = () => {
    const doc = d();
    const l = doc?.layers.find((r) => r.id === doc.activeLayerIds[0]);
    return l && ((l.kind === 'adjustment' && l.adjustment) || (l.kind === 'fill' && l.fillContent)) ? l : null;
  };
  const activeKind = createMemo(() => activeAdjustment()?.kind);
  const shapeId = createMemo(() => {
    const doc = d();
    const l = doc?.layers.find((r) => r.id === doc.activeLayerIds[0]);
    return l?.kind === 'shape' ? l.id : undefined;
  });
  // Keyed on the layer ID, not the layer: every document summary is a new object, and keying
  // on it re-mounted the editor on each one — replacing the slider being dragged.
  const adjustmentId = createMemo(() => activeAdjustment()?.id);
  return (
    <Show when={adjustmentId()} keyed fallback={<Show when={shapeId()} keyed fallback={<DocumentProperties />}>{(id) => <ShapeProperties id={id} />}</Show>}>
      {(id) => (activeKind() === 'fill' ? <FillProperties id={id} /> : <AdjustmentProperties id={id} />)}
    </Show>
  );
}

/**
 * An adjustment layer's settings — the Properties panel as Photoshop shows it for one.
 *
 * The editor works on a local copy while a drag is in progress: the engine echoes every step
 * back as a summary, and applying those echoes mid-drag would pull the control back to where
 * it was a message ago. Outside a drag the summary wins, which is how undo shows up here.
 */
function AdjustmentProperties(props: { id: number }) {
  const send = (msg: unknown) => store.engine?.(msg);
  const summary = () => store.doc()?.layers.find((l) => l.id === props.id)?.adjustment;
  const [local, setLocal] = createSignal<Adjustment | undefined>(summary());
  // Until the engine has echoed our last change, its summaries describe states we have
  // already moved past (the echoes of earlier drag steps) and are ignored.
  let awaiting: string | null = null;
  createEffect(
    on(summary, (s) => {
      if (!s) return;
      if (awaiting !== null) {
        if (JSON.stringify(s) !== awaiting) return;
        awaiting = null;
      }
      setLocal(s);
    }),
  );

  // Levels, Curves and Threshold draw the histogram of what this layer receives.
  const needsHistogram = () => {
    const k = local()?.kind;
    return k === 'levels' || k === 'curves' || k === 'threshold';
  };
  createEffect(
    on(
      () => [props.id, store.doc()?.historyIndex, needsHistogram()] as const,
      ([id, , need]) => {
        if (need) send({ t: 'requestHistogram', source: 'below', id });
      },
    ),
  );

  const change = (next: Adjustment, final: boolean) => {
    awaiting = JSON.stringify(next);
    setLocal(next);
    send({ t: 'setLayerAdjustment', id: props.id, adjustment: next, final });
  };

  return (
    <div class="properties-panel">
      <Show when={local()}>
        {(a) => (
          <>
            <div class="properties-head adjust-head">
              <Icon name={ADJUSTMENT_ICON[a().kind]} size={15} />
              <span>{ADJUSTMENT_LABEL[a().kind]}</span>
            </div>
            <div class="properties-adjust">
              <AdjustmentEditor value={a()} onChange={change} compact histogram="below" />
            </div>
            <div class="properties-foot">
              <button
                type="button"
                class="mini-icon"
                title="Reset to adjustment defaults"
                onClick={() => change(a().kind === 'gradientMap' ? initialAdjustment('gradientMap') : defaultAdjustment(a().kind), true)}
              >
                <Icon name="reset" size={14} />
              </button>
              <button
                type="button"
                class="mini-icon"
                title="Toggle layer visibility"
                onClick={() => {
                  const l = store.doc()?.layers.find((r) => r.id === props.id);
                  if (l) send({ t: 'setLayerVisible', id: props.id, visible: !l.visible });
                }}
              >
                <Icon name="eye" size={14} />
              </button>
              <button
                type="button"
                class="mini-icon"
                title="Delete this adjustment layer"
                onClick={() => {
                  send({ t: 'selectLayer', id: props.id });
                  send({ t: 'layerCommand', command: 'delete' });
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

type LiveShapeSummary = NonNullable<NonNullable<ReturnType<typeof shapeOf>>['live']>;
function shapeOf(id: number) {
  return store.doc()?.layers.find((l) => l.id === id)?.shape;
}

/** The box a live shape occupies, and the shape moved/resized to a new box. */
function liveBox(s: LiveShapeSummary): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case 'rect':
    case 'triangle':
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case 'ellipse':
      return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 };
    case 'polygon':
      return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 };
    case 'line':
      return { x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1), w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) };
  }
}
function withBox(s: LiveShapeSummary, b: { x: number; y: number; w: number; h: number }): LiveShapeSummary {
  switch (s.kind) {
    case 'rect':
    case 'triangle':
      return { ...s, ...b };
    case 'ellipse':
      return { ...s, cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 };
    case 'polygon': {
      const r = Math.max(0.5, Math.min(b.w, b.h) / 2);
      return { ...s, cx: b.x + b.w / 2, cy: b.y + b.h / 2, r };
    }
    case 'line': {
      const o = liveBox(s);
      const sx = o.w ? b.w / o.w : 1;
      const sy = o.h ? b.h / o.h : 1;
      return { ...s, x0: b.x + (s.x0 - o.x) * sx, y0: b.y + (s.y0 - o.y) * sy, x1: b.x + (s.x1 - o.x) * sx, y1: b.y + (s.y1 - o.y) * sy };
    }
  }
}

const SHAPE_LABEL: Record<LiveShapeSummary['kind'], string> = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line' };

/**
 * A shape layer in Properties: the live shape's box and its own parameters (corner radii,
 * sides, star ratio, line weight), then fill and stroke. Colour wells commit when the
 * picking pauses, so a drag through the colour picker is one history step.
 */
function ShapeProperties(props: { id: number }) {
  const send = (m: unknown) => store.engine?.(m as never);
  const sh = () => shapeOf(props.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const put = (patch: Record<string, unknown>, final = true) => {
    clearTimeout(timer);
    send({ t: 'setShape', id: props.id, ...patch, final });
  };
  const putSoon = (patch: Record<string, unknown>) => {
    put(patch, false);
    timer = setTimeout(() => put(patch, true), 400);
  };
  onCleanup(() => clearTimeout(timer));
  const live = () => sh()?.live;
  const setLive = (next: LiveShapeSummary) => put({ live: next });
  const box = () => (live() ? liveBox(live()!) : null);
  const setBox = (k: 'x' | 'y' | 'w' | 'h', v: number) => {
    const l = live();
    const b = box();
    if (l && b) setLive(withBox(l, { ...b, [k]: k === 'w' || k === 'h' ? Math.max(0.5, v) : v }));
  };
  const fillRgb = (): [number, number, number] => (sh()?.fill?.type === 'solid' ? (sh()!.fill as { color: [number, number, number] }).color : [0, 0, 0]);
  const stroke = () => sh()?.stroke ?? null;
  const strokeRgb = (): [number, number, number] => (stroke()?.content.type === 'solid' ? (stroke()!.content as { color: [number, number, number] }).color : [0, 0, 0]);
  const defaultStroke = () => ({ enabled: true, style: { width: 3, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dashes: [], dashOffset: 0 }, content: { type: 'solid', color: [0, 0, 0] }, opacity: 1, blendMode: 'normal' });
  const setStroke = (patch: Record<string, unknown>, soon = false) => {
    const next = { ...(stroke() ?? defaultStroke()), ...patch };
    if (soon) putSoon({ stroke: next });
    else put({ stroke: next });
  };
  const hex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const unhex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  return (
    <div class="properties-panel">
      <Show when={sh()}>
        <div class="properties-head adjust-head">
          <Icon name={live() ? (live()!.kind === 'rect' ? 'rectangle' : live()!.kind) as never : 'customShape'} size={15} />
          <span>{live() ? `Live ${SHAPE_LABEL[live()!.kind]} Properties` : 'Shape Properties'}</span>
        </div>
        <div class="properties-adjust shape-props">
          <Show when={box()}>
            {(b) => (
              <div class="shape-props-grid">
                <NumberField label="W" value={b().w} min={0.5} max={30000} precision={1} suffix="px" width={56} onChange={(v) => setBox('w', v)} />
                <NumberField label="H" value={b().h} min={0.5} max={30000} precision={1} suffix="px" width={56} onChange={(v) => setBox('h', v)} />
                <NumberField label="X" value={b().x} min={-30000} max={30000} precision={1} suffix="px" width={56} onChange={(v) => setBox('x', v)} />
                <NumberField label="Y" value={b().y} min={-30000} max={30000} precision={1} suffix="px" width={56} onChange={(v) => setBox('y', v)} />
              </div>
            )}
          </Show>
          <Show when={live()?.kind === 'rect' && (live() as Extract<LiveShapeSummary, { kind: 'rect' }>)}>
            {(r) => (
              <div class="shape-props-grid">
                <For each={['Top left', 'Top right', 'Bottom right', 'Bottom left']}>
                  {(label, i) => (
                    <NumberField
                      label={label.split(' ').map((w) => w[0]!.toUpperCase()).join('')}
                      title={`${label} corner radius`}
                      value={r().radii[i()]!}
                      min={0}
                      max={10000}
                      precision={1}
                      suffix="px"
                      width={56}
                      onChange={(v) => {
                        const radii = [...r().radii] as [number, number, number, number];
                        radii[i()] = v;
                        setLive({ ...r(), radii });
                      }}
                    />
                  )}
                </For>
              </div>
            )}
          </Show>
          <Show when={live()?.kind === 'polygon' && (live() as Extract<LiveShapeSummary, { kind: 'polygon' }>)}>
            {(p) => (
              <div class="shape-props-grid">
                <NumberField label="Sides" value={p().sides} min={3} max={100} width={44} onChange={(v) => setLive({ ...p(), sides: v })} />
                <NumberField label="Star" title="Star ratio" value={100 - p().star} min={1} max={100} suffix="%" width={48} onChange={(v) => setLive({ ...p(), star: 100 - v })} />
                <NumberField label="Radius" title="Corner radius" value={p().radius} min={0} max={10000} suffix="px" width={48} onChange={(v) => setLive({ ...p(), radius: v })} />
                <NumberField label="Angle" value={p().angle} min={-360} max={360} suffix="°" width={48} onChange={(v) => setLive({ ...p(), angle: v })} />
              </div>
            )}
          </Show>
          <Show when={live()?.kind === 'line' && (live() as Extract<LiveShapeSummary, { kind: 'line' }>)}>
            {(l) => (
              <div class="shape-props-grid">
                <NumberField label="Weight" value={l().weight} min={0.1} max={1000} precision={1} suffix="px" width={52} onChange={(v) => setLive({ ...l(), weight: v })} />
                <Checkbox checked={l().arrowStart} label="Arrow start" onChange={(v) => setLive({ ...l(), arrowStart: v })} />
                <Checkbox checked={l().arrowEnd} label="Arrow end" onChange={(v) => setLive({ ...l(), arrowEnd: v })} />
              </div>
            )}
          </Show>
          <Show when={live() && live()!.kind !== 'polygon' && live()!.kind !== 'line' && (live() as Extract<LiveShapeSummary, { angle: number }>)}>
            {(a) => <NumberField label="Angle" value={a().angle} min={-360} max={360} precision={1} suffix="°" width={52} onChange={(v) => setLive({ ...a(), angle: v } as LiveShapeSummary)} />}
          </Show>
          <div class="shape-props-row">
            <Checkbox checked={!!sh()?.fill} label="Fill" onChange={(v) => put({ fill: v ? { type: 'solid', color: fillRgb() } : null })} />
            <Show when={sh()?.fill?.type === 'solid'}>
              <input type="color" class="fx-swatch" title="Fill colour" value={hex(fillRgb())} onInput={(e) => putSoon({ fill: { type: 'solid', color: unhex(e.currentTarget.value) } })} />
            </Show>
          </div>
          <div class="shape-props-row">
            <Checkbox checked={!!stroke()?.enabled} label="Stroke" onChange={(v) => (v ? setStroke({ enabled: true }) : put({ stroke: null }))} />
            <Show when={stroke()?.enabled}>
              <Show when={stroke()!.content.type === 'solid'}>
                <input type="color" class="fx-swatch" title="Stroke colour" value={hex(strokeRgb())} onInput={(e) => setStroke({ content: { type: 'solid', color: unhex(e.currentTarget.value) } }, true)} />
              </Show>
              <NumberField value={stroke()!.style.width} min={0.1} max={1000} step={0.5} precision={1} suffix="px" width={52} onChange={(v) => setStroke({ style: { ...stroke()!.style, width: v } })} />
              <Select
                value={stroke()!.style.align}
                width={70}
                title="Align"
                options={[
                  { value: 'inside', label: 'Inside' },
                  { value: 'center', label: 'Center' },
                  { value: 'outside', label: 'Outside' },
                ]}
                onChange={(v) => setStroke({ style: { ...stroke()!.style, align: v } })}
              />
            </Show>
          </div>
          <Show when={!live()}>
            <div class="dim adjustments-note">Not a live shape: edit its path with the Direct Selection tool.</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** An SVG paint for a shape's fill or stroke thumbnail: its colour, or grey for gradients and patterns. */
function svgPaint(c: FillSummary): string {
  return c.type === 'solid' ? `rgb(${c.color.map((v) => Math.round(v * 255)).join(',')})` : '#888';
}

/** CSS background standing in for a fill layer's content, for its Layers-panel thumbnail. */
function fillCss(c: FillSummary): string {
  if (c.type === 'solid') return `rgb(${c.color.map((v) => Math.round(v * 255)).join(',')})`;
  if (c.type === 'gradient') return gradientCss(c.gradient, c.reverse);
  const p = store.patterns().find((q) => q.id === c.patternId);
  return p ? `url(${patternThumb(p)})` : 'var(--panel-sunken)';
}

/** A fill layer's settings in Properties — the same echo handling as an adjustment layer's. */
function FillProperties(props: { id: number }) {
  const send = (msg: unknown) => store.engine?.(msg);
  const summary = () => store.doc()?.layers.find((l) => l.id === props.id)?.fillContent;
  const [local, setLocal] = createSignal<FillSummary | undefined>(summary());
  let awaiting: string | null = null;
  createEffect(
    on(summary, (s) => {
      if (!s) return;
      if (awaiting !== null) {
        if (JSON.stringify(s) !== awaiting) return;
        awaiting = null;
      }
      setLocal(s);
    }),
  );
  onMount(() => send({ t: 'requestPatterns' }));
  const change = (next: FillSummary, final: boolean) => {
    awaiting = JSON.stringify(next);
    setLocal(next);
    send({ t: 'setFillContent', id: props.id, content: next, final });
  };
  return (
    <div class="properties-panel">
      <Show when={local()}>
        {(c) => (
          <>
            <div class="properties-head adjust-head">
              <span class="layer-fill-swatch small" style={{ background: fillCss(c()) }} />
              <span>{FILL_LABEL[c().type]}</span>
            </div>
            <div class="properties-adjust">
              <FillEditor value={c()} onChange={change} />
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

// ---- Patterns ----------------------------------------------------------------------------

function PatternsPanel() {
  const [picked, setPicked] = createSignal<string | undefined>();
  return (
    <div class="patterns-panel">
      <PatternPicker
        selected={picked()}
        onPick={(p) => {
          setPicked(p.id);
          // Clicking a pattern with a pattern fill layer active applies it, as dragging a
          // swatch onto one does in Photoshop.
          const d = store.doc();
          const l = d?.layers.find((r) => r.id === d.activeLayerIds[0]);
          if (l?.kind === 'fill' && l.fillContent?.type === 'pattern') {
            store.engine?.({ t: 'setFillContent', id: l.id, content: { ...l.fillContent, patternId: p.id, patternName: p.name }, final: true });
          }
        }}
      />
      <div class="dim adjustments-note">
        {store.patterns().find((p) => p.id === picked())?.name ?? 'Edit ▸ Define Pattern adds the selection (or the canvas) here.'}
      </div>
    </div>
  );
}

// ---- Adjustments -------------------------------------------------------------------------

/** Photoshop's panel order: tonal row, colour row, then the special-purpose ones. */
const ADJUSTMENT_GRID: (Adjustment['kind'] | null)[][] = [
  ['brightnessContrast', 'levels', 'curves', 'exposure'],
  ['vibrance', 'hueSaturation', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'colorLookup'],
  ['invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor'],
];

function AdjustmentsPanel() {
  const add = (kind: Adjustment['kind']) => {
    store.engine?.({ t: 'addAdjustmentLayer', adjustment: initialAdjustment(kind) });
    store.openPanel('properties');
  };
  return (
    <div class="adjustments-panel">
      <div class="adjustments-caption">Add an adjustment</div>
      <For each={ADJUSTMENT_GRID}>
        {(row) => (
          <div class="adjustments-row">
            <For each={row}>
              {(kind) => (
                <Show when={kind}>
                  {(k) => (
                    <button
                      type="button"
                      class="adjustments-button"
                      title={`${ADJUSTMENT_LABEL[k()]} — new adjustment layer`}
                      disabled={!store.doc()}
                      onClick={() => add(k())}
                    >
                      <Icon name={ADJUSTMENT_ICON[k()]} size={18} />
                    </button>
                  )}
                </Show>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

// ---- Histogram ---------------------------------------------------------------------------

/**
 * Histogram panel — the composite's per-channel histograms, overlaid in their colours, with
 * the luminosity one behind in grey, plus Photoshop's statistics for the chosen channel.
 * Recomputed when the document changes (each history step), not per frame.
 */
function HistogramPanel() {
  const send = (msg: unknown) => store.engine?.(msg);
  const [channel, setChannel] = createSignal<'colors' | 'lum' | 'r' | 'g' | 'b' | 'all'>('colors');
  createEffect(
    on(
      () => [store.doc()?.historyIndex, store.doc()?.history.length, store.doc()?.name] as const,
      () => {
        if (store.doc()) send({ t: 'requestHistogram', source: 'composite' });
      },
    ),
  );
  const h = () => store.histogram('composite');

  const path = (c: Uint32Array | undefined, max: number) => {
    if (!c) return '';
    let d = 'M0 100';
    for (let i = 0; i < 256; i++) {
      const y = 100 - Math.min(1, c[i]! / max) * 100;
      d += `L${i} ${y}L${i + 1} ${y}`;
    }
    return `${d}L256 100Z`;
  };
  const scale = (cs: (Uint32Array | undefined)[]) => {
    let max = 1;
    for (const c of cs) if (c) for (let i = 1; i < 255; i++) max = Math.max(max, c[i]!);
    return max;
  };

  const stats = createMemo(() => {
    const hist = h();
    if (!hist) return null;
    const c = channel() === 'colors' || channel() === 'lum' || channel() === 'all' ? hist.lum : hist[channel() as 'r' | 'g' | 'b'];
    let n = 0;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      n += c[i]!;
      sum += i * c[i]!;
    }
    if (n === 0) return { mean: 0, dev: 0, median: 0, pixels: 0 };
    const mean = sum / n;
    let v = 0;
    let acc = 0;
    let median = 0;
    let found = false;
    for (let i = 0; i < 256; i++) {
      v += c[i]! * (i - mean) ** 2;
      acc += c[i]!;
      if (!found && acc >= n / 2) {
        median = i;
        found = true;
      }
    }
    return { mean, dev: Math.sqrt(v / n), median, pixels: n };
  });

  return (
    <div class="histogram-panel">
      <Select
        value={channel()}
        label="Channel"
        width={96}
        options={[
          { value: 'colors', label: 'Colors' },
          { value: 'lum', label: 'Luminosity' },
          { value: 'r', label: 'Red' },
          { value: 'g', label: 'Green' },
          { value: 'b', label: 'Blue' },
          { value: 'all', label: 'All Channels View', separatorBefore: true },
        ]}
        onChange={setChannel}
      />
      <Show when={h()} fallback={<div class="dim pad">No document</div>}>
        {(hist) => (
          <>
            <Show when={channel() === 'all'}>
              <For each={[['r', 'Red'], ['g', 'Green'], ['b', 'Blue']] as const}>
                {([k, label]) => (
                  <>
                    <div class="dim">{label}</div>
                    <svg class="histogram-graph small" viewBox="0 0 256 100" preserveAspectRatio="none">
                      <path class={`histogram-fill ch-${k}`} d={path(hist()[k], scale([hist()[k]]))} />
                    </svg>
                  </>
                )}
              </For>
              <div class="dim">Luminosity</div>
            </Show>
            <svg class="histogram-graph" viewBox="0 0 256 100" preserveAspectRatio="none">
              <Show
                when={channel() === 'colors'}
                fallback={
                  <path
                    class={`histogram-fill ch-${channel() === 'all' ? 'lum' : channel()}`}
                    d={(() => {
                      const c = channel() === 'lum' || channel() === 'all' ? hist().lum : hist()[channel() as 'r' | 'g' | 'b'];
                      return path(c, scale([c]));
                    })()}
                  />
                }
              >
                {(() => {
                  const max = scale([hist().r, hist().g, hist().b]);
                  return (
                    <>
                      <path class="histogram-fill ch-r blend" d={path(hist().r, max)} />
                      <path class="histogram-fill ch-g blend" d={path(hist().g, max)} />
                      <path class="histogram-fill ch-b blend" d={path(hist().b, max)} />
                    </>
                  );
                })()}
              </Show>
            </svg>
            <Show when={stats()}>
              {(s) => (
                <div class="histogram-stats">
                  <span>Mean:</span>
                  <span>{s().mean.toFixed(2)}</span>
                  <span>Std Dev:</span>
                  <span>{s().dev.toFixed(2)}</span>
                  <span>Median:</span>
                  <span>{s().median}</span>
                  <span>Pixels:</span>
                  <span>{s().pixels}</span>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function DocumentProperties() {
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

/**
 * History panel — spec 01 §4.
 *
 * Rows below the current state are dimmed rather than hidden: they are still reachable until
 * the next edit discards them, and seeing what undo has put aside is most of what the panel is
 * for. Snapshots sit at the top with their own icon, pinned against the state limit.
 */
function HistoryPanel() {
  const send = (msg: unknown) => store.engine?.(msg);
  const states = () => store.doc()?.history ?? [];
  const index = () => store.doc()?.historyIndex ?? 0;

  return (
    <div class="history-panel">
      <div class="history-rows">
        <For each={states()}>
          {(s, i) => (
            <div
              class="history-row"
              classList={{ current: i() === index(), future: i() > index() }}
              onClick={() => send({ t: 'historyGoto', index: i() })}
              title={new Date(s.time).toLocaleTimeString()}
            >
              <Icon name={s.snapshot ? 'snapshot' : 'historyBrush'} size={14} />
              <span>{s.name}</span>
            </div>
          )}
        </For>
      </div>
      <div class="panel-footer">
        <button
          type="button"
          class="icon-button"
          title="Create new snapshot"
          onClick={() => send({ t: 'historySnapshot' })}
        >
          <Icon name="snapshot" size={14} />
        </button>
        <Checkbox
          checked={store.nonLinearHistory()}
          onChange={(v) => {
            store.setNonLinearHistory(v);
            send({ t: 'historyConfigure', nonLinear: v });
          }}
          label="Non-Linear"
        />
      </div>
    </div>
  );
}

/**
 * The rows under a smart object with filters (spec 01 §5, Layers): "Smart Filters" with the
 * filter mask and an eye for them all, then one row per filter, topmost first — eye, name
 * (double-click to edit its settings), and buttons for its blending options, order and removal.
 */
/** The footer's fill/adjustment menu: Layer ▸ New Fill Layer and New Adjustment Layer, as Photoshop's button lists them. */
const NEW_LAYER_ITEMS = () => {
  const layer = MENUS.find((m) => m.label === 'Layer')!.items;
  const sub = (label: string) => (layer.find((n) => n.label === label)?.items ?? []).filter((n) => n.cmd);
  return [...sub('New Fill Layer'), { label: '' }, ...sub('New Adjustment Layer')] as { label?: string; cmd?: string }[];
};

function SmartFilterRows(props: { layerId: number; depth: number; smart: SmartSummary }) {
  const send = (m: unknown) => store.engine?.(m as never);
  const select = () => send({ t: 'selectLayer', id: props.layerId });
  const op = (index: number, o: unknown) => send({ t: 'smartFilterOp', layerId: props.layerId, index, op: o });
  const edit = (f: SmartFilterSummary, index: number) => {
    select();
    if (f.filterId === 'filter.gallery') store.openDialog('gallery', { stack: f.params.stack as string, smartIndex: index });
    else if ((FILTER_BY_ID.get(f.filterId)?.params.length ?? 0) > 0) store.openDialog('filter', { id: f.filterId, params: f.params, smartIndex: index });
  };
  const rows = () => props.smart.filters.map((f, i) => ({ f, i })).reverse();
  return (
    <>
      <div class="layer-row smart-filters-row" style={{ 'padding-left': `${22 + props.depth * 14}px` }} onClick={select}>
        <button
          type="button"
          class="layer-eye"
          title={props.smart.filtersEnabled ? 'Hide all smart filters' : 'Show smart filters'}
          onClick={(e) => {
            e.stopPropagation();
            select();
            send({ t: 'smartCommand', cmd: 'toggleFilters' });
          }}
        >
          <Icon name={props.smart.filtersEnabled ? 'eye' : 'eyeOff'} size={14} />
        </button>
        <Show when={props.smart.hasFilterMask}>
          <div
            class="layer-mask-thumb"
            classList={{ disabled: !props.smart.filterMaskEnabled, targeted: store.doc()?.filterMaskTarget === props.layerId }}
            title={props.smart.filterMaskEnabled ? 'Filter mask — click to paint into it, Shift-click to disable' : 'Filter mask — disabled (Shift-click to enable)'}
            onClick={(e) => {
              e.stopPropagation();
              select();
              if (e.shiftKey) send({ t: 'smartCommand', cmd: 'toggleFilterMask' });
              else send({ t: 'setMaskTarget', id: props.layerId, mask: true, filter: true });
            }}
          />
        </Show>
        <span class="layer-name">Smart Filters</span>
      </div>
      <For each={rows()}>
        {({ f, i }) => (
          <div
            class="layer-row smart-filter-row"
            classList={{ off: !f.enabled || !props.smart.filtersEnabled }}
            style={{ 'padding-left': `${22 + props.depth * 14}px` }}
            onClick={select}
            onDblClick={() => edit(f, i)}
            title="Double-click to edit the filter's settings"
          >
            <button
              type="button"
              class="layer-eye"
              title={f.enabled ? 'Hide this filter' : 'Show this filter'}
              onClick={(e) => {
                e.stopPropagation();
                op(i, { kind: 'toggle' });
              }}
            >
              <Icon name={f.enabled ? 'eye' : 'eyeOff'} size={14} />
            </button>
            <span class="layer-name smart-filter-name">{f.label}</span>
            <Show when={f.blendMode !== 'normal' || f.opacity < 1}>
              <span class="layer-badge">{f.opacity < 1 ? `${Math.round(f.opacity * 100)}%` : f.blendMode.slice(0, 3)}</span>
            </Show>
            <button type="button" class="mini-icon smart-filter-btn" title="Move up" disabled={i === props.smart.filters.length - 1} onClick={(e) => { e.stopPropagation(); op(i, { kind: 'move', to: i + 1 }); }}>
              <Icon name="chevronUp" size={11} />
            </button>
            <button type="button" class="mini-icon smart-filter-btn" title="Move down" disabled={i === 0} onClick={(e) => { e.stopPropagation(); op(i, { kind: 'move', to: i - 1 }); }}>
              <Icon name="chevronDown" size={11} />
            </button>
            <button
              type="button"
              class="mini-icon smart-filter-btn"
              title="Blending options"
              onClick={(e) => {
                e.stopPropagation();
                select();
                store.openDialog('smartBlend', { layerId: props.layerId, index: i, label: f.label, blendMode: f.blendMode, opacity: f.opacity });
              }}
            >
              <Icon name="gear" size={12} />
            </button>
            <button type="button" class="mini-icon smart-filter-btn" title="Delete this filter" onClick={(e) => { e.stopPropagation(); op(i, { kind: 'delete' }); }}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        )}
      </For>
    </>
  );
}

/**
 * The rows under a layer with a style (spec 01 §5, Layers): "Effects" with an eye for them
 * all, then one row per effect, as Photoshop lists them; double-click opens its page.
 */
function EffectRows(props: { layerId: number; depth: number; effects: LayerEffects }) {
  const send = (m: unknown) => store.engine?.(m as never);
  const commit = (effects: LayerEffects, name: string) => send({ t: 'setLayerStyle', id: props.layerId, effects, name });
  type Row = { key: StyleKey; index: number; label: string; enabled: boolean };
  const rows = (): Row[] => {
    const fx = props.effects;
    const out: Row[] = [];
    for (const item of STYLE_ITEMS) {
      const v = (fx as unknown as Record<string, unknown>)[item.key];
      if (Array.isArray(v)) v.forEach((e: { enabled: boolean }, index) => out.push({ key: item.key, index, label: item.label, enabled: e.enabled }));
      else if (v && typeof v === 'object') out.push({ key: item.key, index: 0, label: item.label, enabled: (v as { enabled: boolean }).enabled });
    }
    return out;
  };
  const toggle = (r: Row) => {
    const fx = props.effects as unknown as Record<string, unknown>;
    const v = fx[r.key];
    const next = Array.isArray(v) ? v.map((e, i) => (i === r.index ? { ...e, enabled: !e.enabled } : e)) : { ...(v as object), enabled: !r.enabled };
    commit({ ...props.effects, [r.key]: next } as LayerEffects, `${r.enabled ? 'Hide' : 'Show'} ${r.label}`);
  };
  return (
    <>
      <div class="layer-row fx-row-effects" style={{ 'padding-left': `${22 + props.depth * 14}px` }} onClick={() => send({ t: 'selectLayer', id: props.layerId })}>
        <button
          type="button"
          class="layer-eye"
          title={props.effects.enabled ? 'Hide all effects' : 'Show all effects'}
          onClick={(e) => {
            e.stopPropagation();
            commit({ ...props.effects, enabled: !props.effects.enabled }, props.effects.enabled ? 'Hide Effects' : 'Show Effects');
          }}
        >
          <Icon name={props.effects.enabled ? 'eye' : 'eyeOff'} size={14} />
        </button>
        <span class="layer-name">Effects</span>
      </div>
      <For each={rows()}>
        {(r) => (
          <div
            class="layer-row fx-row-effect"
            classList={{ off: !r.enabled || !props.effects.enabled }}
            style={{ 'padding-left': `${22 + props.depth * 14}px` }}
            onClick={() => send({ t: 'selectLayer', id: props.layerId })}
            onDblClick={() => store.openDialog('layerStyle', { layerId: props.layerId, page: r.key })}
            title="Double-click to edit"
          >
            <button
              type="button"
              class="layer-eye"
              title={r.enabled ? `Hide ${r.label}` : `Show ${r.label}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle(r);
              }}
            >
              <Icon name={r.enabled ? 'eye' : 'eyeOff'} size={14} />
            </button>
            <span class="layer-name smart-filter-name">{r.label}</span>
          </div>
        )}
      </For>
    </>
  );
}
