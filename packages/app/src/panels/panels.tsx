import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { ADJUSTMENT_LABEL, defaultAdjustment, type Adjustment } from '@umbra/engine';
import { AdjustmentEditor } from '../adjust/editors';
import { ADJUSTMENT_ICON, initialAdjustment } from '../adjust/initial';
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
      return <AdjustmentsPanel />;
    case 'brushSettings':
      return <Placeholder name="Brush Settings" milestone="M8" what="shape dynamics, scattering, texture, dual brush, transfer" />;
    case 'brushes':
      return <Placeholder name="Brushes" milestone="M3" what="brush presets and .abr import" />;
    case 'histogram':
      return <HistogramPanel />;
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
                  classList={{ group: l.kind === 'group', adjustment: l.kind === 'adjustment' }}
                  aria-hidden="true"
                  onDblClick={() => {
                    // Photoshop opens an adjustment layer's settings from its thumbnail.
                    if (l.kind === 'adjustment') store.openPanel('properties');
                  }}
                >
                  <Show when={l.kind === 'group'}>
                    <Icon name="folder" size={14} />
                  </Show>
                  <Show when={l.kind === 'adjustment' && l.adjustment}>
                    {(a) => <Icon name={ADJUSTMENT_ICON[a().kind]} size={15} />}
                  </Show>
                </div>

                <Show when={l.hasMask}>
                  <div
                    class="layer-mask-thumb"
                    classList={{ disabled: !l.maskEnabled }}
                    title={l.maskEnabled ? 'Layer mask (Shift-click to disable)' : 'Layer mask — disabled (Shift-click to enable)'}
                    onClick={(e) => {
                      if (!e.shiftKey) return;
                      e.stopPropagation();
                      store.engine?.({ t: 'maskCommand', command: 'toggle', id: l.id });
                    }}
                  />
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
        {/* Link, layer styles and fill/adjustment layers are not built yet (M6, M4); they stay
            visibly disabled and SAY so, rather than looking live and doing nothing. */}
        <button type="button" class="mini-icon" title="Link layers — not available yet" disabled>
          <Icon name="linkChain" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Add a layer style — arrives in M6" disabled>
          <Icon name="fx" size={15} />
        </button>
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
        <button type="button" class="mini-icon" title="Create new fill or adjustment layer — arrives in M4" disabled>
          <Icon name="adjustment" size={15} />
        </button>
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
  const activeAdjustment = () => {
    const doc = d();
    const l = doc?.layers.find((r) => r.id === doc.activeLayerIds[0]);
    return l && l.kind === 'adjustment' && l.adjustment ? l : null;
  };
  // Keyed on the layer ID, not the layer: every document summary is a new object, and keying
  // on it re-mounted the editor on each one — replacing the slider being dragged.
  const adjustmentId = createMemo(() => activeAdjustment()?.id);
  return (
    <Show when={adjustmentId()} keyed fallback={<DocumentProperties />}>
      {(id) => <AdjustmentProperties id={id} />}
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

// ---- Adjustments -------------------------------------------------------------------------

/** Photoshop's panel order: tonal row, colour row, then the special-purpose ones. */
const ADJUSTMENT_GRID: (Adjustment['kind'] | null)[][] = [
  ['brightnessContrast', 'levels', 'curves', 'exposure'],
  ['vibrance', 'hueSaturation', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer'],
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
      <div class="dim adjustments-note">Color Lookup is not implemented yet.</div>
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
  const [channel, setChannel] = createSignal<'colors' | 'lum' | 'r' | 'g' | 'b'>('colors');
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
    const c = channel() === 'colors' || channel() === 'lum' ? hist.lum : hist[channel() as 'r' | 'g' | 'b'];
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
        ]}
        onChange={setChannel}
      />
      <Show when={h()} fallback={<div class="dim pad">No document</div>}>
        {(hist) => (
          <>
            <svg class="histogram-graph" viewBox="0 0 256 100" preserveAspectRatio="none">
              <Show
                when={channel() === 'colors'}
                fallback={
                  <path
                    class={`histogram-fill ch-${channel()}`}
                    d={path(channel() === 'lum' ? hist().lum : hist()[channel() as 'r' | 'g' | 'b'], scale([channel() === 'lum' ? hist().lum : hist()[channel() as 'r' | 'g' | 'b']]))}
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
