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
      return <Placeholder name="Channels" milestone="M3" what="alpha and spot channels, save/load selection" />;
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
  const [blend, setBlend] = createSignal<BlendMode>('normal');
  const [opacity, setOpacity] = createSignal(100);
  const [fill, setFill] = createSignal(100);
  const [selected, setSelected] = createSignal<number | null>(null);

  // The engine stores layers bottom-first; the panel shows them top-first.
  const rows = createMemo(() => [...(store.doc()?.layers ?? [])].reverse());

  const blendOptions = BLEND_MENU.filter((m) => m !== '-').map((m) => ({
    value: m as BlendMode,
    label: BLEND_LABEL[m as BlendMode],
  }));

  return (
    <div class="layers-panel">
      <div class="layers-filter">
        <Select value="kind" options={[{ value: 'kind', label: 'Kind' }]} onChange={() => {}} width={62} />
        <div class="layers-filter-icons">
          <For each={['newLayer', 'adjustment', 'type', 'customShape', 'snapshot']}>
            {(ic) => (
              <button type="button" class="mini-icon" disabled title="Filter by layer kind (M2)">
                <Icon name={ic} size={13} />
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="layers-blend">
        <Select value={blend()} options={blendOptions} onChange={setBlend} width={118} />
        <NumberField label="Opacity" value={opacity()} onChange={setOpacity} min={0} max={100} suffix="%" width={34} />
      </div>

      <div class="layers-locks">
        <span class="locks-label">Lock:</span>
        <For each={[
          ['lockTransparency', 'Lock transparent pixels'],
          ['lockPixels', 'Lock image pixels'],
          ['lockPosition', 'Lock position'],
          ['artboard', 'Prevent auto-nesting into artboards'],
          ['lock', 'Lock all'],
        ] as const}>
          {([icon, title]) => (
            <button type="button" class="mini-icon" title={title} disabled>
              <Icon name={icon} size={13} />
            </button>
          )}
        </For>
        <NumberField label="Fill" value={fill()} onChange={setFill} min={0} max={100} suffix="%" width={34} />
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
                classList={{ selected: selected() === l.id }}
                onClick={() => setSelected(l.id)}
              >
                <button type="button" class="layer-eye" title="Toggle layer visibility">
                  <Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} />
                </button>
                <div class="layer-thumb" aria-hidden="true" />
                <span class="layer-name">{l.name}</span>
                <span class="layer-tiles" title="Tiles allocated for this layer">
                  {l.tiles}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

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
            <button type="button" class="mini-icon" title={title} disabled={icon !== 'newLayer'}>
              <Icon name={icon} size={15} />
            </button>
          )}
        </For>
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
