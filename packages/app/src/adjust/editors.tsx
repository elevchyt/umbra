/**
 * Adjustment parameter editors — spec 05 §A.
 *
 * One editor per adjustment kind, shared by the Image ▸ Adjustments dialogs and the
 * Properties panel, exactly as one registry definition serves both in Photoshop. An editor is
 * controlled: it shows `value` and reports every change as `(next, final)`, where `final` is
 * false during a drag and true when the gesture ends. The dialog previews on every change;
 * the Properties panel records one history step per `final`.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Select, Checkbox, Button } from '@umbra/ui/widgets/controls';
import {
  DEFAULT_LEVELS,
  evaluateCurve,
  normaliseCurve,
  sampleGradient,
  type Adjustment,
  type ChannelMixerOutput,
  type ColorBalanceBand,
  type CurvePoint,
  type Gradient,
  type LevelsChannel,
  type SelectiveRange,
  type CmykShift,
  defaultHueBands,
  type HueBand,
  type HueBandName,
} from '@umbra/engine';
import { store, type Histogram, type HistogramSource } from '../state/store';

export type Change = (next: Adjustment, final: boolean) => void;
type Of<K extends Adjustment['kind']> = Extract<Adjustment, { kind: K }>;

export interface EditorProps {
  value: Adjustment;
  onChange: Change;
  /** Narrow layout for the Properties panel. */
  compact?: boolean;
  /** Which histogram Levels, Curves and Threshold draw behind their controls. */
  histogram?: HistogramSource;
}

export function AdjustmentEditor(props: EditorProps): JSX.Element {
  // Each editor gets the value narrowed to its kind; `as never` bridges the union once here.
  const v = () => props.value as never;
  const hist = () => store.histogram(props.histogram ?? 'layer');
  // Switch on the KIND only. Reading `props.value.kind` directly in the JSX expression would
  // track the whole value, re-mounting the editor on every change — and replacing the slider
  // under the pointer in the middle of a drag.
  const kind = createMemo(() => props.value.kind);
  return (
    <div class="adjust-editor" classList={{ compact: props.compact }}>
      {(() => {
        switch (kind()) {
          case 'brightnessContrast':
            return <BrightnessContrast value={v()} onChange={props.onChange} />;
          case 'levels':
            return <Levels value={v()} onChange={props.onChange} histogram={hist()} />;
          case 'curves':
            return <Curves value={v()} onChange={props.onChange} compact={props.compact} histogram={hist()} />;
          case 'exposure':
            return <Exposure value={v()} onChange={props.onChange} />;
          case 'vibrance':
            return <Vibrance value={v()} onChange={props.onChange} />;
          case 'hueSaturation':
            return <HueSaturation value={v()} onChange={props.onChange} />;
          case 'colorBalance':
            return <ColorBalance value={v()} onChange={props.onChange} />;
          case 'blackWhite':
            return <BlackWhite value={v()} onChange={props.onChange} />;
          case 'photoFilter':
            return <PhotoFilter value={v()} onChange={props.onChange} />;
          case 'channelMixer':
            return <ChannelMixer value={v()} onChange={props.onChange} />;
          case 'posterize':
            return <Posterize value={v()} onChange={props.onChange} />;
          case 'threshold':
            return <Threshold value={v()} onChange={props.onChange} histogram={hist()} />;
          case 'gradientMap':
            return <GradientMap value={v()} onChange={props.onChange} />;
          case 'selectiveColor':
            return <SelectiveColor value={v()} onChange={props.onChange} />;
          case 'colorLookup':
            return <ColorLookup value={v()} onChange={props.onChange} />;
          default:
            return <div class="dim adjust-none">This adjustment has no settings.</div>;
        }
      })()}
    </div>
  );
}

// ---- shared controls ------------------------------------------------------------------------

/**
 * A labelled slider with a numeric field — Photoshop's standard adjustment row. The range
 * reports every step while dragging and `final` on release; typing in the field is final.
 */
export function Param(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  suffix?: string;
  /** CSS background for the track, e.g. the Cyan→Red ramp of Color Balance. */
  track?: string;
  onChange: (v: number, final: boolean) => void;
}) {
  return (
    <div class="adjust-param">
      <div class="adjust-param-head">
        <span class="adjust-param-label">{props.label}</span>
        <NumberField
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          precision={props.precision ?? 0}
          suffix={props.suffix}
          width={54}
          onChange={(v) => props.onChange(v, true)}
        />
      </div>
      <input
        type="range"
        class="adjust-range"
        classList={{ tracked: !!props.track }}
        style={props.track ? { background: props.track } : undefined}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        aria-label={props.label}
        onInput={(e) => props.onChange(+e.currentTarget.value, false)}
        onChange={(e) => props.onChange(+e.currentTarget.value, true)}
        onDblClick={() => props.onChange(Math.min(props.max, Math.max(props.min, 0)), true)}
      />
    </div>
  );
}

/** A histogram as an SVG path, 256 wide, scaled so one spike does not flatten the rest. */
function HistogramPath(props: { counts: Uint32Array | undefined; height: number; class?: string }) {
  const d = createMemo(() => {
    const c = props.counts;
    if (!c) return '';
    // Scale to the largest bin other than the two ends: clipped shadows or highlights pile up
    // in bin 0 or 255 and would otherwise squash everything else into the baseline.
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, c[i]!);
    let path = `M0 ${props.height}`;
    for (let i = 0; i < 256; i++) {
      const h = Math.min(1, c[i]! / max) * props.height;
      path += `L${i} ${props.height - h}L${i + 1} ${props.height - h}`;
    }
    return `${path}L256 ${props.height}Z`;
  });
  return <path class={props.class ?? 'histogram-fill'} d={d()} />;
}

type ChannelKey = 'master' | 'r' | 'g' | 'b';
const CHANNEL_OPTIONS: { value: ChannelKey; label: string }[] = [
  { value: 'master', label: 'RGB' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
];
const histogramFor = (h: Histogram | null, ch: ChannelKey) => (h ? (ch === 'master' ? h.lum : h[ch]) : undefined);

// ---- Brightness/Contrast ---------------------------------------------------------------------

function BrightnessContrast(props: { value: Of<'brightnessContrast'>; onChange: Change }) {
  const set = (patch: Partial<Of<'brightnessContrast'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  return (
    <>
      <Param label="Brightness" value={props.value.brightness} min={-150} max={150} onChange={(v, f) => set({ brightness: v }, f)} />
      <Param
        label="Contrast"
        value={props.value.contrast}
        min={props.value.legacy ? -100 : -50}
        max={100}
        onChange={(v, f) => set({ contrast: v }, f)}
      />
      <Checkbox checked={props.value.legacy} label="Use Legacy" onChange={(v) => set({ legacy: v, contrast: v ? props.value.contrast : Math.max(-50, props.value.contrast) }, true)} />
    </>
  );
}

// ---- Levels --------------------------------------------------------------------------------

function Levels(props: { value: Of<'levels'>; onChange: Change; histogram: Histogram | null }) {
  const [channel, setChannel] = createSignal<ChannelKey>('master');
  const ch = (): LevelsChannel => props.value[channel()];
  const set = (patch: Partial<LevelsChannel>, final: boolean) =>
    props.onChange({ ...props.value, [channel()]: { ...ch(), ...patch } }, final);

  // The grey slider sits where the curve outputs 50%: t^(1/γ) = ½ ⇒ t = ½^γ.
  const midX = () => ch().inBlack + (ch().inWhite - ch().inBlack) * 0.5 ** ch().gamma;

  const drag = (which: 'inBlack' | 'mid' | 'inWhite' | 'outBlack' | 'outWhite') => (e: PointerEvent) => {
    const track = (e.currentTarget as SVGElement).ownerSVGElement!;
    const toValue = (ev: PointerEvent) => {
      // The track's viewBox is -8…264 (272 units), leaving room for the end thumbs.
      const r = track.getBoundingClientRect();
      return Math.round(Math.min(255, Math.max(0, ((ev.clientX - r.left) / r.width) * 272 - 8)));
    };
    const apply = (ev: PointerEvent, final: boolean) => {
      const x = toValue(ev);
      const c = ch();
      switch (which) {
        case 'inBlack':
          return set({ inBlack: Math.min(x, c.inWhite - 2) }, final);
        case 'inWhite':
          return set({ inWhite: Math.max(x, c.inBlack + 2) }, final);
        case 'mid': {
          const t = (Math.min(Math.max(x, c.inBlack + 1), c.inWhite - 1) - c.inBlack) / (c.inWhite - c.inBlack);
          const gamma = Math.min(9.99, Math.max(0.1, Math.log(t) / Math.log(0.5)));
          return set({ gamma: Math.round(gamma * 100) / 100 }, final);
        }
        case 'outBlack':
          return set({ outBlack: x }, final);
        case 'outWhite':
          return set({ outWhite: x }, final);
      }
    };
    e.preventDefault();
    const move = (ev: PointerEvent) => apply(ev, false);
    const up = (ev: PointerEvent) => {
      apply(ev, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const thumb = (x: () => number, fill: string, on: (e: PointerEvent) => void) => (
    <polygon
      class="levels-thumb"
      points={`${x()},0 ${x() - 6},10 ${x() + 6},10`}
      style={{ fill }}
      onPointerDown={on}
    />
  );

  return (
    <>
      <Select value={channel()} options={CHANNEL_OPTIONS} onChange={setChannel} label="Channel" width={90} />
      <svg class="levels-histogram" viewBox="0 0 256 100" preserveAspectRatio="none">
        <HistogramPath counts={histogramFor(props.histogram, channel())} height={100} />
      </svg>
      <svg class="levels-track" viewBox="-8 0 272 12" preserveAspectRatio="none">
        <line x1="0" y1="0.5" x2="256" y2="0.5" class="levels-rule" />
        {thumb(() => ch().inBlack, '#000', drag('inBlack'))}
        {thumb(midX, '#888', drag('mid'))}
        {thumb(() => ch().inWhite, '#fff', drag('inWhite'))}
      </svg>
      <div class="adjust-fields">
        <NumberField value={ch().inBlack} min={0} max={253} width={46} onChange={(v) => set({ inBlack: Math.min(v, ch().inWhite - 2) }, true)} />
        <NumberField value={ch().gamma} min={0.1} max={9.99} step={0.01} precision={2} width={46} onChange={(v) => set({ gamma: v }, true)} />
        <NumberField value={ch().inWhite} min={2} max={255} width={46} onChange={(v) => set({ inWhite: Math.max(v, ch().inBlack + 2) }, true)} />
      </div>
      <div class="adjust-caption">Output Levels</div>
      <svg class="levels-track output" viewBox="-8 0 272 12" preserveAspectRatio="none">
        <defs>
          <linearGradient id="levels-out-ramp">
            <stop offset="0" stop-color="#000" />
            <stop offset="1" stop-color="#fff" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="256" height="1" fill="url(#levels-out-ramp)" />
        {thumb(() => ch().outBlack, '#000', drag('outBlack'))}
        {thumb(() => ch().outWhite, '#fff', drag('outWhite'))}
      </svg>
      <div class="adjust-fields">
        <NumberField value={ch().outBlack} min={0} max={255} width={46} onChange={(v) => set({ outBlack: v }, true)} />
        <span class="spacer" />
        <NumberField value={ch().outWhite} min={0} max={255} width={46} onChange={(v) => set({ outWhite: v }, true)} />
      </div>
      <Button onClick={() => props.onChange({ ...props.value, [channel()]: DEFAULT_LEVELS }, true)} width={78}>
        Reset
      </Button>
    </>
  );
}

// ---- Curves --------------------------------------------------------------------------------

const MAX_POINTS = 16;

function Curves(props: { value: Of<'curves'>; onChange: Change; compact?: boolean; histogram: Histogram | null }) {
  const [channel, setChannel] = createSignal<ChannelKey>('master');
  const [selected, setSelected] = createSignal<number | null>(null);
  const points = () => props.value[channel()];
  const setPoints = (pts: CurvePoint[], final: boolean) =>
    props.onChange({ ...props.value, [channel()]: pts }, final);

  const curvePath = createMemo(() => {
    const pts = points();
    let d = '';
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const y = Math.min(1, Math.max(0, evaluateCurve(pts, x)));
      d += `${i === 0 ? 'M' : 'L'}${(x * 255).toFixed(2)} ${(255 - y * 255).toFixed(2)}`;
    }
    return d;
  });

  let svg!: SVGSVGElement;
  const toCurve = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: 1 - (e.clientY - r.top) / r.height,
      outside: e.clientX < r.left - 16 || e.clientX > r.right + 16 || e.clientY < r.top - 16 || e.clientY > r.bottom + 16,
    };
  };
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const q = (v: number) => Math.round(clamp01(v) * 255) / 255;

  /** Drag point `index`; dragging an interior point off the graph deletes it, as in Photoshop. */
  const dragPoint = (index: number, e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(index);
    const start = points();
    const last = start.length - 1;
    const apply = (ev: PointerEvent, final: boolean) => {
      const p = toCurve(ev);
      if (p.outside && index !== 0 && index !== last && start.length > 2) {
        setSelected(null);
        setPoints(start.filter((_, i) => i !== index), final);
        return;
      }
      // A point stays between its neighbours: the curve is a function of the input.
      const lo = index === 0 ? 0 : start[index - 1]!.x + 1 / 255;
      const hi = index === last ? 1 : start[index + 1]!.x - 1 / 255;
      const next = start.slice();
      next[index] = { x: q(Math.min(hi, Math.max(lo, p.x))), y: q(p.y) };
      setSelected(index);
      setPoints(next, final);
    };
    const move = (ev: PointerEvent) => apply(ev, false);
    const up = (ev: PointerEvent) => {
      apply(ev, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Click on the graph adds a point there and starts dragging it. */
  const addPoint = (e: PointerEvent) => {
    if (points().length >= MAX_POINTS) return;
    const p = toCurve(e);
    const pt = { x: q(p.x), y: q(p.y) };
    const next = normaliseCurve([...points(), pt]);
    const index = next.findIndex((n) => n === pt);
    if (index < 0) return;
    setPoints(next, false);
    // Drag against the list that now contains the point.
    queueMicrotask(() => dragPoint(index, e));
  };

  const sel = () => {
    const i = selected();
    return i === null ? null : (points()[i] ?? null);
  };
  const setSel = (patch: Partial<CurvePoint>) => {
    const i = selected();
    if (i === null) return;
    const next = points().slice();
    next[i] = { ...next[i]!, ...patch };
    setPoints(normaliseCurve(next), true);
  };

  const stroke = () => (channel() === 'r' ? '#e5484d' : channel() === 'g' ? '#46a758' : channel() === 'b' ? '#3e7bfa' : 'var(--text)');

  return (
    <>
      <Select value={channel()} options={CHANNEL_OPTIONS} onChange={(c) => { setChannel(c); setSelected(null); }} label="Channel" width={90} />
      <svg
        ref={svg}
        class="curves-graph"
        classList={{ compact: props.compact }}
        viewBox="0 0 255 255"
        onPointerDown={addPoint}
      >
        <HistogramPath counts={histogramFor(props.histogram, channel())} height={255} class="histogram-fill faint" />
        <For each={[63.75, 127.5, 191.25]}>
          {(g) => (
            <>
              <line class="curves-grid" x1={g} y1="0" x2={g} y2="255" />
              <line class="curves-grid" x1="0" y1={g} x2="255" y2={g} />
            </>
          )}
        </For>
        <line class="curves-baseline" x1="0" y1="255" x2="255" y2="0" />
        <path class="curves-line" d={curvePath()} style={{ stroke: stroke() }} />
        <For each={points()}>
          {(p, i) => (
            <rect
              class="curves-point"
              classList={{ selected: selected() === i() }}
              x={p.x * 255 - 4}
              y={255 - p.y * 255 - 4}
              width="8"
              height="8"
              onPointerDown={(e) => dragPoint(i(), e)}
            />
          )}
        </For>
      </svg>
      <div class="adjust-fields">
        <Show when={sel()} fallback={<span class="dim">Click the curve to add a point; drag one off to remove it.</span>}>
          {(p) => (
            <>
              <NumberField label="Input" value={Math.round(p().x * 255)} min={0} max={255} width={44} onChange={(v) => setSel({ x: v / 255 })} />
              <NumberField label="Output" value={Math.round(p().y * 255)} min={0} max={255} width={44} onChange={(v) => setSel({ y: v / 255 })} />
            </>
          )}
        </Show>
      </div>
    </>
  );
}

// ---- simple slider editors -----------------------------------------------------------------

function Exposure(props: { value: Of<'exposure'>; onChange: Change }) {
  const set = (patch: Partial<Of<'exposure'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  return (
    <>
      <Param label="Exposure" value={props.value.exposure} min={-20} max={20} step={0.01} precision={2} onChange={(v, f) => set({ exposure: v }, f)} />
      <Param label="Offset" value={props.value.offset} min={-0.5} max={0.5} step={0.0001} precision={4} onChange={(v, f) => set({ offset: v }, f)} />
      <Param label="Gamma Correction" value={props.value.gamma} min={0.01} max={9.99} step={0.01} precision={2} onChange={(v, f) => set({ gamma: v }, f)} />
    </>
  );
}

function Vibrance(props: { value: Of<'vibrance'>; onChange: Change }) {
  const set = (patch: Partial<Of<'vibrance'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  return (
    <>
      <Param label="Vibrance" value={props.value.vibrance} min={-100} max={100} onChange={(v, f) => set({ vibrance: v }, f)} />
      <Param label="Saturation" value={props.value.saturation} min={-100} max={100} onChange={(v, f) => set({ saturation: v }, f)} />
    </>
  );
}

const HUE_TRACK = 'linear-gradient(to right, #0ff, #00f, #f0f, #f00, #ff0, #0f0, #0ff)';

const HUE_EDIT_OPTIONS: { value: 'master' | HueBandName; label: string }[] = [
  { value: 'master', label: 'Master' },
  { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
];

function HueSaturation(props: { value: Of<'hueSaturation'>; onChange: Change }) {
  const [edit, setEdit] = createSignal<'master' | HueBandName>('master');
  const set = (patch: Partial<Of<'hueSaturation'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  const master = (patch: Partial<Of<'hueSaturation'>['master']>, final: boolean) =>
    set({ master: { ...props.value.master, ...patch } }, final);
  const bands = () => props.value.bands ?? defaultHueBands();
  const band = (): HueBand | null => (edit() === 'master' ? null : bands()[edit() as HueBandName]);
  const setBand = (patch: Partial<HueBand>, final: boolean) => {
    const name = edit();
    if (name === 'master') return;
    set({ bands: { ...bands(), [name]: { ...bands()[name], ...patch } } }, final);
  };
  return (
    <>
      <Show
        when={props.value.colorize}
        fallback={
          <>
            <Select value={edit()} options={HUE_EDIT_OPTIONS} label="Edit" width={100} onChange={setEdit} />
            <Show
              when={band()}
              fallback={
                <>
                  <Param label="Hue" value={props.value.master.hue} min={-180} max={180} track={HUE_TRACK} onChange={(v, f) => master({ hue: v }, f)} />
                  <Param label="Saturation" value={props.value.master.saturation} min={-100} max={100} onChange={(v, f) => master({ saturation: v }, f)} />
                  <Param label="Lightness" value={props.value.master.lightness} min={-100} max={100} onChange={(v, f) => master({ lightness: v }, f)} />
                </>
              }
            >
              {(b) => (
                <>
                  <Param label="Hue" value={b().hue} min={-180} max={180} track={HUE_TRACK} onChange={(v, f) => setBand({ hue: v }, f)} />
                  <Param label="Saturation" value={b().saturation} min={-100} max={100} onChange={(v, f) => setBand({ saturation: v }, f)} />
                  <Param label="Lightness" value={b().lightness} min={-100} max={100} onChange={(v, f) => setBand({ lightness: v }, f)} />
                  <HueRangeBar band={b()} onChange={(range, f) => setBand({ range }, f)} />
                </>
              )}
            </Show>
          </>
        }
      >
        <Param label="Hue" value={props.value.colorizeHue} min={0} max={360} track="linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" onChange={(v, f) => set({ colorizeHue: v }, f)} />
        <Param label="Saturation" value={props.value.colorizeSaturation} min={0} max={100} onChange={(v, f) => set({ colorizeSaturation: v }, f)} />
        <Param label="Lightness" value={props.value.colorizeLightness} min={-100} max={100} onChange={(v, f) => set({ colorizeLightness: v }, f)} />
      </Show>
      <Checkbox checked={props.value.colorize} label="Colorize" onChange={(v) => set({ colorize: v }, true)} />
    </>
  );
}

const wrap = (v: number) => ((v % 360) + 360) % 360;
const hueCss = (h: number) => `hsl(${wrap(h)}, 100%, 50%)`;

/**
 * The range bar under Hue/Saturation's sliders: the input hues on top, the output hues (after
 * this range's Hue shift) beneath, and the range's four edges as handles — the inner pair
 * bound the full-strength part, the outer pair the fall-offs. The bar is centred on the range,
 * as Photoshop draws it, so a range that wraps past 360° is not split in two.
 */
function HueRangeBar(props: { band: HueBand; onChange: (range: HueBand['range'], final: boolean) => void }) {
  const W = 256;
  const centre = () => {
    const [a, , , d] = props.band.range;
    return wrap(a + wrap(d - a) / 2);
  };
  const origin = () => centre() - 180;
  const x = (angle: number) => (wrap(angle - origin()) / 360) * W;
  const ramp = (shift: number) => {
    const stops: string[] = [];
    for (let i = 0; i <= 12; i++) stops.push(`${hueCss(origin() + i * 30 + shift)} ${((i / 12) * 100).toFixed(1)}%`);
    return `linear-gradient(to right, ${stops.join(',')})`;
  };
  let svg!: SVGSVGElement;
  const drag = (k: number) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = props.band.range;
    const o = origin();
    const apply = (ev: PointerEvent, final: boolean) => {
      const r = svg.getBoundingClientRect();
      const angle = Math.round(wrap(o + ((ev.clientX - r.left) / r.width) * 360));
      const next = [...start] as HueBand['range'];
      next[k] = angle;
      // Keep the four edges in order around the circle, measured from the first.
      const rel = next.map((v) => wrap(v - next[0]));
      const ordered = rel[1]! <= rel[2]! && rel[2]! <= rel[3]!;
      if (ordered) props.onChange(next, final);
    };
    const move = (ev: PointerEvent) => apply(ev, false);
    const up = (ev: PointerEvent) => {
      apply(ev, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="hue-range">
      <div class="hue-range-ramp" style={{ background: ramp(0) }} />
      <svg ref={svg} class="hue-range-bar" viewBox={`0 0 ${W} 16`} preserveAspectRatio="none">
        {(() => {
          const [a, b, c, d] = props.band.range.map(x) as [number, number, number, number];
          return (
            <>
              <polygon class="hue-range-shape" points={`${a},14 ${b},3 ${c},3 ${d},14`} />
              <For each={[a, b, c, d]}>
                {(px, i) => (
                  <rect
                    class="hue-range-handle"
                    classList={{ inner: i() === 1 || i() === 2 }}
                    x={px - 3}
                    y={i() === 1 || i() === 2 ? 0 : 8}
                    width="6"
                    height="8"
                    onPointerDown={drag(i())}
                  />
                )}
              </For>
            </>
          );
        })()}
      </svg>
      <div class="hue-range-ramp" style={{ background: ramp(props.band.hue) }} />
      <div class="adjust-fields dim">
        {props.band.range.map((v) => `${Math.round(v)}°`).join(' / ')}
      </div>
    </div>
  );
}

type Tone = 'shadows' | 'midtones' | 'highlights';

function ColorBalance(props: { value: Of<'colorBalance'>; onChange: Change }) {
  const [tone, setTone] = createSignal<Tone>('midtones');
  const band = (): ColorBalanceBand => props.value[tone()];
  const set = (patch: Partial<ColorBalanceBand>, final: boolean) =>
    props.onChange({ ...props.value, [tone()]: { ...band(), ...patch } }, final);
  return (
    <>
      <Select
        value={tone()}
        label="Tone"
        width={100}
        options={[
          { value: 'shadows', label: 'Shadows' },
          { value: 'midtones', label: 'Midtones' },
          { value: 'highlights', label: 'Highlights' },
        ]}
        onChange={setTone}
      />
      <Param label="Cyan — Red" value={band().cyanRed} min={-100} max={100} track="linear-gradient(to right, #0ff, #f00)" onChange={(v, f) => set({ cyanRed: v }, f)} />
      <Param label="Magenta — Green" value={band().magentaGreen} min={-100} max={100} track="linear-gradient(to right, #f0f, #0f0)" onChange={(v, f) => set({ magentaGreen: v }, f)} />
      <Param label="Yellow — Blue" value={band().yellowBlue} min={-100} max={100} track="linear-gradient(to right, #ff0, #00f)" onChange={(v, f) => set({ yellowBlue: v }, f)} />
      <Checkbox
        checked={props.value.preserveLuminosity}
        label="Preserve Luminosity"
        onChange={(v) => props.onChange({ ...props.value, preserveLuminosity: v }, true)}
      />
    </>
  );
}

const toHex = (c: readonly number[]) =>
  '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

function BlackWhite(props: { value: Of<'blackWhite'>; onChange: Change }) {
  const set = (patch: Partial<Of<'blackWhite'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  const rows: { key: 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'; label: string; color: string }[] = [
    { key: 'reds', label: 'Reds', color: '#f00' },
    { key: 'yellows', label: 'Yellows', color: '#ff0' },
    { key: 'greens', label: 'Greens', color: '#0f0' },
    { key: 'cyans', label: 'Cyans', color: '#0ff' },
    { key: 'blues', label: 'Blues', color: '#00f' },
    { key: 'magentas', label: 'Magentas', color: '#f0f' },
  ];
  return (
    <>
      <div class="adjust-fields">
        <Checkbox
          checked={!!props.value.tint}
          label="Tint"
          onChange={(v) => set({ tint: v ? [225 / 255, 211 / 255, 179 / 255] : null }, true)}
        />
        <Show when={props.value.tint}>
          {(t) => (
            <input
              type="color"
              class="adjust-color"
              value={toHex(t())}
              onInput={(e) => set({ tint: fromHex(e.currentTarget.value) }, false)}
              onChange={(e) => set({ tint: fromHex(e.currentTarget.value) }, true)}
            />
          )}
        </Show>
      </div>
      <For each={rows}>
        {(r) => (
          <Param
            label={r.label}
            value={props.value[r.key]}
            min={-200}
            max={300}
            suffix="%"
            track={`linear-gradient(to right, #000, ${r.color})`}
            onChange={(v, f) => set({ [r.key]: v } as Partial<Of<'blackWhite'>>, f)}
          />
        )}
      </For>
    </>
  );
}

/** Photoshop's Photo Filter presets, as sRGB. */
const PHOTO_FILTERS: { label: string; rgb: [number, number, number] }[] = [
  { label: 'Warming Filter (85)', rgb: [236, 138, 0] },
  { label: 'Warming Filter (LBA)', rgb: [250, 150, 0] },
  { label: 'Warming Filter (81)', rgb: [235, 177, 19] },
  { label: 'Cooling Filter (80)', rgb: [0, 109, 255] },
  { label: 'Cooling Filter (LBB)', rgb: [0, 93, 255] },
  { label: 'Cooling Filter (82)', rgb: [0, 181, 255] },
  { label: 'Red', rgb: [234, 26, 26] },
  { label: 'Orange', rgb: [243, 132, 23] },
  { label: 'Yellow', rgb: [249, 227, 28] },
  { label: 'Green', rgb: [25, 201, 25] },
  { label: 'Cyan', rgb: [29, 203, 234] },
  { label: 'Blue', rgb: [29, 53, 234] },
  { label: 'Violet', rgb: [155, 29, 234] },
  { label: 'Magenta', rgb: [227, 24, 227] },
  { label: 'Sepia', rgb: [172, 122, 51] },
  { label: 'Deep Red', rgb: [255, 0, 0] },
  { label: 'Deep Blue', rgb: [0, 34, 205] },
  { label: 'Deep Emerald', rgb: [0, 140, 0] },
  { label: 'Deep Yellow', rgb: [255, 213, 0] },
  { label: 'Underwater', rgb: [0, 194, 177] },
];

function PhotoFilter(props: { value: Of<'photoFilter'>; onChange: Change }) {
  const set = (patch: Partial<Of<'photoFilter'>>, final: boolean) => props.onChange({ ...props.value, ...patch }, final);
  const preset = () => {
    const hex = toHex(props.value.color);
    const i = PHOTO_FILTERS.findIndex((p) => toHex(p.rgb.map((v) => v / 255)) === hex);
    return i < 0 ? -1 : i;
  };
  return (
    <>
      <Select
        value={preset()}
        label="Filter"
        width={150}
        options={[
          ...PHOTO_FILTERS.map((p, i) => ({ value: i, label: p.label })),
          { value: -1, label: 'Custom', separatorBefore: true },
        ]}
        onChange={(i) => {
          if (i >= 0) set({ color: PHOTO_FILTERS[i]!.rgb.map((v) => v / 255) as [number, number, number] }, true);
        }}
      />
      <div class="adjust-fields">
        <span class="adjust-param-label">Color</span>
        <input
          type="color"
          class="adjust-color"
          value={toHex(props.value.color)}
          onInput={(e) => set({ color: fromHex(e.currentTarget.value) }, false)}
          onChange={(e) => set({ color: fromHex(e.currentTarget.value) }, true)}
        />
      </div>
      <Param label="Density" value={props.value.density} min={1} max={100} suffix="%" onChange={(v, f) => set({ density: v }, f)} />
      <Checkbox checked={props.value.preserveLuminosity} label="Preserve Luminosity" onChange={(v) => set({ preserveLuminosity: v }, true)} />
    </>
  );
}

function ChannelMixer(props: { value: Of<'channelMixer'>; onChange: Change }) {
  const [out, setOut] = createSignal<'r' | 'g' | 'b'>('r');
  // Monochrome drives all three outputs from one row, so the output menu collapses to Gray.
  const row = (): ChannelMixerOutput => props.value[props.value.monochrome ? 'r' : out()];
  const set = (patch: Partial<ChannelMixerOutput>, final: boolean) => {
    const next = { ...row(), ...patch };
    props.onChange(
      props.value.monochrome
        ? { ...props.value, r: next, g: next, b: next }
        : { ...props.value, [out()]: next },
      final,
    );
  };
  const total = () => row().r + row().g + row().b;
  return (
    <>
      <Show
        when={!props.value.monochrome}
        fallback={<Select value="gray" label="Output Channel" width={90} options={[{ value: 'gray', label: 'Gray' }]} onChange={() => {}} />}
      >
        <Select
          value={out()}
          label="Output Channel"
          width={90}
          options={[
            { value: 'r', label: 'Red' },
            { value: 'g', label: 'Green' },
            { value: 'b', label: 'Blue' },
          ]}
          onChange={setOut}
        />
      </Show>
      <Checkbox
        checked={props.value.monochrome}
        label="Monochrome"
        onChange={(v) => {
          // Photoshop starts monochrome from 40/40/20, which approximates luminance.
          const grey = { r: 40, g: 40, b: 20, constant: 0 };
          props.onChange(
            v
              ? { ...props.value, monochrome: true, r: grey, g: grey, b: grey }
              : { ...props.value, monochrome: false, r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 } },
            true,
          );
        }}
      />
      <Param label="Red" value={row().r} min={-200} max={200} suffix="%" onChange={(v, f) => set({ r: v }, f)} />
      <Param label="Green" value={row().g} min={-200} max={200} suffix="%" onChange={(v, f) => set({ g: v }, f)} />
      <Param label="Blue" value={row().b} min={-200} max={200} suffix="%" onChange={(v, f) => set({ b: v }, f)} />
      <div class="adjust-fields">
        <span class="adjust-param-label">Total</span>
        <span classList={{ 'adjust-warn': total() > 100 }} title={total() > 100 ? 'Over 100% can clip highlights' : undefined}>
          {total() > 100 ? '⚠ ' : ''}
          {total()}%
        </span>
      </div>
      <Param label="Constant" value={row().constant} min={-200} max={200} suffix="%" onChange={(v, f) => set({ constant: v }, f)} />
    </>
  );
}

function Posterize(props: { value: Of<'posterize'>; onChange: Change }) {
  return <Param label="Levels" value={props.value.levels} min={2} max={255} onChange={(v, f) => props.onChange({ ...props.value, levels: v }, f)} />;
}

function Threshold(props: { value: Of<'threshold'>; onChange: Change; histogram: Histogram | null }) {
  return (
    <>
      <svg class="levels-histogram" viewBox="0 0 256 100" preserveAspectRatio="none">
        <HistogramPath counts={props.histogram?.lum} height={100} />
        <line class="threshold-marker" x1={props.value.level} y1="0" x2={props.value.level} y2="100" />
      </svg>
      <Param label="Threshold Level" value={props.value.level} min={1} max={255} onChange={(v, f) => props.onChange({ ...props.value, level: v }, f)} />
    </>
  );
}

// ---- Gradient Map ----------------------------------------------------------------------------

const two = (a: [number, number, number], b: [number, number, number], name: string): Gradient => ({
  name,
  colorStops: [
    { at: 0, color: a },
    { at: 1, color: b },
  ],
  opacityStops: [
    { at: 0, opacity: 1 },
    { at: 1, opacity: 1 },
  ],
});

export function gradientPresets(): Gradient[] {
  const fg = store.foreground();
  const bg = store.background();
  return [
    two([fg.r, fg.g, fg.b], [bg.r, bg.g, bg.b], 'Foreground to Background'),
    two([0, 0, 0], [1, 1, 1], 'Black, White'),
    {
      name: 'Violet, Orange',
      colorStops: [
        { at: 0, color: [41 / 255, 10 / 255, 89 / 255] },
        { at: 1, color: [1, 124 / 255, 0] },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    },
    {
      name: 'Blue, Red, Yellow',
      colorStops: [
        { at: 0, color: [10 / 255, 0, 178 / 255] },
        { at: 0.5, color: [1, 0, 0] },
        { at: 1, color: [1, 252 / 255, 0] },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    },
    {
      name: 'Copper',
      colorStops: [
        { at: 0, color: [151 / 255, 70 / 255, 26 / 255] },
        { at: 0.3, color: [251 / 255, 216 / 255, 197 / 255] },
        { at: 0.83, color: [108 / 255, 46 / 255, 22 / 255] },
        { at: 1, color: [239 / 255, 219 / 255, 205 / 255] },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    },
    two([112 / 255, 66 / 255, 20 / 255], [1, 238 / 255, 196 / 255], 'Sepia'),
  ];
}

export function gradientCss(g: Gradient, reverse: boolean): string {
  const stops: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const [r, gg, b] = sampleGradient(g, reverse ? 1 - t : t);
    stops.push(`rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

function GradientMap(props: { value: Of<'gradientMap'>; onChange: Change }) {
  const presets = gradientPresets();
  const index = () => presets.findIndex((p) => p.name === props.value.gradient.name);
  return (
    <>
      <div class="gradient-preview wide" style={{ background: gradientCss(props.value.gradient, props.value.reverse) }} />
      <Select
        value={index()}
        label="Gradient"
        width={170}
        options={[
          ...presets.map((p, i) => ({ value: i, label: p.name ?? `Gradient ${i + 1}` })),
          ...(index() < 0 ? [{ value: -1, label: props.value.gradient.name ?? 'Custom', separatorBefore: true }] : []),
        ]}
        onChange={(i) => {
          if (i >= 0) props.onChange({ ...props.value, gradient: presets[i]! }, true);
        }}
      />
      <Checkbox checked={props.value.reverse} label="Reverse" onChange={(v) => props.onChange({ ...props.value, reverse: v }, true)} />
    </>
  );
}

// ---- Selective Color ----------------------------------------------------------------------

const RANGE_OPTIONS: { value: SelectiveRange; label: string }[] = [
  { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
  { value: 'whites', label: 'Whites' },
  { value: 'neutrals', label: 'Neutrals' },
  { value: 'blacks', label: 'Blacks' },
];

function SelectiveColor(props: { value: Of<'selectiveColor'>; onChange: Change }) {
  const [range, setRange] = createSignal<SelectiveRange>('reds');
  const shift = (): CmykShift => props.value.ranges[range()];
  const set = (patch: Partial<CmykShift>, final: boolean) =>
    props.onChange({ ...props.value, ranges: { ...props.value.ranges, [range()]: { ...shift(), ...patch } } }, final);
  return (
    <>
      <Select value={range()} options={RANGE_OPTIONS} label="Colors" width={100} onChange={setRange} />
      <Param label="Cyan" value={shift().c} min={-100} max={100} suffix="%" onChange={(v, f) => set({ c: v }, f)} />
      <Param label="Magenta" value={shift().m} min={-100} max={100} suffix="%" onChange={(v, f) => set({ m: v }, f)} />
      <Param label="Yellow" value={shift().y} min={-100} max={100} suffix="%" onChange={(v, f) => set({ y: v }, f)} />
      <Param label="Black" value={shift().k} min={-100} max={100} suffix="%" onChange={(v, f) => set({ k: v }, f)} />
      <Select
        value={props.value.relative ? 'relative' : 'absolute'}
        label="Method"
        width={100}
        options={[
          { value: 'relative', label: 'Relative' },
          { value: 'absolute', label: 'Absolute' },
        ]}
        onChange={(m) => props.onChange({ ...props.value, relative: m === 'relative' }, true)}
      />
    </>
  );
}

// ---- Color Lookup --------------------------------------------------------------------------

/**
 * Color Lookup's 3DLUT File menu: the built-in looks, anything loaded this session or found in
 * an opened PSD, and Load 3D LUT… for a .cube or .3dl. (Abstract and Device Link profiles are
 * ICC and are not supported.)
 */
function ColorLookup(props: { value: Of<'colorLookup'>; onChange: Change }) {
  let input!: HTMLInputElement;
  onMount(() => {
    store.engine?.({ t: 'requestLuts' });
    // A file loaded from here is selected as soon as the worker has registered it.
    const onLoaded = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const lut = store.luts().find((l) => l.id === id);
      if (lut) props.onChange({ kind: 'colorLookup', lutId: lut.id, name: lut.name }, true);
    };
    window.addEventListener('umbra:lut-loaded', onLoaded);
    onCleanup(() => window.removeEventListener('umbra:lut-loaded', onLoaded));
  });
  const options = () => {
    const list = store.luts();
    const known = list.some((l) => l.id === props.value.lutId);
    return [
      ...list.map((l) => ({ value: l.id, label: l.name })),
      ...(known ? [] : [{ value: props.value.lutId, label: props.value.name, separatorBefore: true }]),
    ];
  };
  return (
    <>
      <Select
        value={props.value.lutId}
        label="3DLUT File"
        width={170}
        options={options()}
        onChange={(id) => {
          const lut = store.luts().find((l) => l.id === id);
          if (lut) props.onChange({ kind: 'colorLookup', lutId: lut.id, name: lut.name }, true);
        }}
      />
      <input
        ref={input}
        type="file"
        accept=".cube,.3dl"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          if (!file) return;
          const bytes = new Uint8Array(await file.arrayBuffer());
          store.engine?.({ t: 'loadLut', fileName: file.name, bytes });
          e.currentTarget.value = '';
        }}
      />
      <Button width={130} onClick={() => input.click()}>
        Load 3D LUT…
      </Button>
      <div class="dim">
        {(() => {
          const lut = store.luts().find((l) => l.id === props.value.lutId);
          return lut ? `${lut.size}×${lut.size}×${lut.size} grid, tetrahedral` : 'Table not loaded — this layer has no effect.';
        })()}
      </div>
    </>
  );
}
