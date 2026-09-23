/**
 * Shadows/Highlights, Replace Color, Match Color and HDR Toning dialogs. Unlike the per-pixel
 * adjustments their preview is computed on the CPU in the worker, which keeps only the newest
 * request, so a drag shows the latest settings as fast as they can be computed.
 */
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Select, Checkbox } from '@umbra/ui/widgets/controls';
import { SPATIAL_LABEL, applyToRgb, defaultAdjustment, type Adjustment, type SpatialAdjustment } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { Param } from './editors';
import { Dropper } from './dropper';

type Of<K extends SpatialAdjustment['kind']> = Extract<SpatialAdjustment, { kind: K }>;
type Change = (next: SpatialAdjustment) => void;

export function SpatialDialog(props: { initial: SpatialAdjustment; send: (msg: unknown) => void; onClose: () => void }) {
  const [value, setValue] = createSignal<SpatialAdjustment>(props.initial);
  const [preview, setPreview] = createSignal(true);
  let timer = 0;
  // A short debounce on top of the worker's latest-wins: most slider steps are superseded
  // within a frame or two, and each preview is a full-image CPU pass.
  const push = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => props.send({ t: 'previewSpatial', adjustment: preview() ? value() : null }), 40);
  };
  onMount(push);
  onCleanup(() => clearTimeout(timer));
  const change: Change = (next) => {
    setValue(next);
    push();
  };
  const close = () => {
    clearTimeout(timer);
    props.send({ t: 'previewSpatial', adjustment: null });
    props.onClose();
  };
  const v = () => value() as never;
  return (
    <Dialog
      title={SPATIAL_LABEL[props.initial.kind]}
      width={props.initial.kind === 'replaceColor' ? 340 : 320}
      passThrough={props.initial.kind === 'replaceColor'}
      onOk={() => {
        clearTimeout(timer);
        props.send({ t: 'applySpatial', adjustment: value() });
        props.onClose();
      }}
      onCancel={close}
      onReset={() => change(props.initial)}
      footer={
        <Checkbox
          checked={preview()}
          label="Preview"
          onChange={(p) => {
            setPreview(p);
            push();
          }}
        />
      }
    >
      <div class="adjust-editor">
        {(() => {
          switch (props.initial.kind) {
            case 'shadowsHighlights':
              return <ShadowsHighlights value={v()} onChange={change} />;
            case 'replaceColor':
              return <ReplaceColor value={v()} onChange={change} send={props.send} />;
            case 'matchColor':
              return <MatchColor value={v()} onChange={change} />;
            case 'hdrToning':
              return <HdrToning value={v()} onChange={change} />;
          }
        })()}
      </div>
    </Dialog>
  );
}

function ShadowsHighlights(props: { value: Of<'shadowsHighlights'>; onChange: Change }) {
  const set = (patch: Partial<Of<'shadowsHighlights'>>) => props.onChange({ ...props.value, ...patch });
  const group = (key: 'shadows' | 'highlights', label: string) => {
    const g = () => props.value[key];
    const setG = (patch: Partial<Of<'shadowsHighlights'>['shadows']>) => set({ [key]: { ...g(), ...patch } } as never);
    return (
      <>
        <div class="dialog-section-title">{label}</div>
        <Param label="Amount" value={g().amount} min={0} max={100} suffix="%" onChange={(a) => setG({ amount: a })} />
        <Param label="Tone" value={g().tone} min={0} max={100} suffix="%" onChange={(t) => setG({ tone: t })} />
        <Param label="Radius" value={g().radius} min={0} max={2500} suffix="px" onChange={(r) => setG({ radius: r })} />
      </>
    );
  };
  return (
    <>
      {group('shadows', 'Shadows')}
      {group('highlights', 'Highlights')}
      <div class="dialog-section-title">Adjustments</div>
      <Param label="Color" value={props.value.colorCorrection} min={-100} max={100} onChange={(c) => set({ colorCorrection: c })} />
      <Param label="Midtone" value={props.value.midtoneContrast} min={-100} max={100} onChange={(m) => set({ midtoneContrast: m })} />
      <Param label="Black Clip" value={props.value.blackClip} min={0} max={50} step={0.01} precision={2} suffix="%" onChange={(b) => set({ blackClip: b })} />
      <Param label="White Clip" value={props.value.whiteClip} min={0} max={50} step={0.01} precision={2} suffix="%" onChange={(w) => set({ whiteClip: w })} />
    </>
  );
}

const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

function ReplaceColor(props: { value: Of<'replaceColor'>; onChange: Change; send: (msg: unknown) => void }) {
  const set = (patch: Partial<Of<'replaceColor'>>) => props.onChange({ ...props.value, ...patch });
  const [mask, setMask] = createSignal<string | null>(null);
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => props.send({ t: 'requestReplaceColorPreview', color: props.value.color, fuzziness: props.value.fuzziness, size: 200 }), 60);
  };
  onMount(() => {
    const onPreview = (e: Event) => {
      const { pixels, width, height } = (e as CustomEvent<{ pixels: Uint8Array; width: number; height: number }>).detail;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      setMask(c.toDataURL());
    };
    window.addEventListener('umbra:replace-color-preview', onPreview);
    onCleanup(() => window.removeEventListener('umbra:replace-color-preview', onPreview));
    // Arm the dropper straight away, as Photoshop does: the first thing to do is click a colour.
    store.setPickRequest({ id: 'replace-color', onPick: pick });
    refresh();
  });
  onCleanup(() => clearTimeout(timer));
  const pick = (rgb: [number, number, number]) => {
    set({ color: rgb });
    refresh();
  };
  /** The result swatch: the sampled colour through the replacement sliders (Hue/Saturation's). */
  const replaced = () => {
    const hs: Adjustment = {
      ...(defaultAdjustment('hueSaturation') as Extract<Adjustment, { kind: 'hueSaturation' }>),
      master: { hue: props.value.hue, saturation: props.value.saturation, lightness: props.value.lightness },
    };
    const [r, g, b] = props.value.color.map((c) => Math.round(c * 255)) as [number, number, number];
    return css(applyToRgb(hs, r, g, b).map((c) => c / 255));
  };
  return (
    <>
      <div class="adjust-fields">
        <Dropper id="replace-color" title="Sample the colour to replace" onPick={pick} />
        <span class="dropper-swatch" style={{ background: css(props.value.color) }} title="Selected colour" />
        <span class="dim">Click the image to choose the colour.</span>
      </div>
      <Param label="Fuzziness" value={props.value.fuzziness} min={0} max={200} onChange={(f) => { set({ fuzziness: f }); refresh(); }} />
      <Show when={mask()}>{(src) => <img class="replace-mask" src={src()} alt="Selection preview" />}</Show>
      <div class="dialog-section-title">Replacement</div>
      <Param label="Hue" value={props.value.hue} min={-180} max={180} onChange={(h) => set({ hue: h })} />
      <Param label="Saturation" value={props.value.saturation} min={-100} max={100} onChange={(s) => set({ saturation: s })} />
      <Param label="Lightness" value={props.value.lightness} min={-100} max={100} onChange={(l) => set({ lightness: l })} />
      <div class="adjust-fields">
        <span class="adjust-param-label">Result</span>
        <span class="dropper-swatch" style={{ background: replaced() }} />
      </div>
    </>
  );
}

function MatchColor(props: { value: Of<'matchColor'>; onChange: Change }) {
  const set = (patch: Partial<Of<'matchColor'>>) => props.onChange({ ...props.value, ...patch });
  const target = () => store.doc()?.activeLayerIds[0];
  const sources = () => [
    { value: -1, label: 'Merged image' },
    ...(store.doc()?.layers ?? [])
      .filter((l) => l.kind === 'pixel' && l.id !== target())
      .map((l) => ({ value: l.id, label: l.name })),
  ];
  return (
    <>
      <div class="dialog-section-title">Image Options</div>
      <Param label="Luminance" value={props.value.luminance} min={1} max={200} onChange={(l) => set({ luminance: l })} />
      <Param label="Color Intensity" value={props.value.colorIntensity} min={1} max={200} onChange={(c) => set({ colorIntensity: c })} />
      <Param label="Fade" value={props.value.fade} min={0} max={100} onChange={(f) => set({ fade: f })} />
      <Checkbox checked={props.value.neutralize} label="Neutralize" onChange={(n) => set({ neutralize: n })} />
      <div class="dialog-section-title">Image Statistics</div>
      <Select
        value={props.value.sourceLayerId ?? -1}
        label="Source"
        width={170}
        options={sources()}
        onChange={(id) => set({ sourceLayerId: id === -1 ? null : id })}
      />
      <div class="dim">Other open documents are not available as sources yet — there is one document.</div>
    </>
  );
}

const HDR_METHODS: { value: Of<'hdrToning'>['method']; label: string }[] = [
  { value: 'localAdaptation', label: 'Local Adaptation' },
  { value: 'equalize', label: 'Equalize Histogram' },
  { value: 'exposureGamma', label: 'Exposure and Gamma' },
  { value: 'highlightCompression', label: 'Highlight Compression' },
];

function HdrToning(props: { value: Of<'hdrToning'>; onChange: Change }) {
  const set = (patch: Partial<Of<'hdrToning'>>) => props.onChange({ ...props.value, ...patch });
  const local = () => props.value.method === 'localAdaptation';
  return (
    <>
      <div class="dim">HDR Toning flattens the image, as in Photoshop.</div>
      <Select value={props.value.method} label="Method" width={170} options={HDR_METHODS} onChange={(m) => set({ method: m })} />
      <Show when={local()}>
        <div class="dialog-section-title">Edge Glow</div>
        <Param label="Radius" value={props.value.radius} min={1} max={500} suffix="px" onChange={(r) => set({ radius: r })} />
        <Param label="Strength" value={props.value.strength} min={0.1} max={4} step={0.01} precision={2} onChange={(s) => set({ strength: s })} />
      </Show>
      <Show when={local() || props.value.method === 'exposureGamma'}>
        <div class="dialog-section-title">Tone and Detail</div>
        <Param label="Gamma" value={props.value.gamma} min={0.1} max={2} step={0.01} precision={2} onChange={(g) => set({ gamma: g })} />
        <Param label="Exposure" value={props.value.exposure} min={-5} max={5} step={0.01} precision={2} onChange={(e) => set({ exposure: e })} />
      </Show>
      <Show when={local()}>
        <Param label="Detail" value={props.value.detail} min={-100} max={300} suffix="%" onChange={(d) => set({ detail: d })} />
        <div class="dialog-section-title">Advanced</div>
        <Param label="Shadow" value={props.value.shadow} min={-100} max={100} suffix="%" onChange={(s) => set({ shadow: s })} />
        <Param label="Highlight" value={props.value.highlight} min={-100} max={100} suffix="%" onChange={(h) => set({ highlight: h })} />
        <Param label="Vibrance" value={props.value.vibrance} min={-100} max={100} suffix="%" onChange={(v) => set({ vibrance: v })} />
        <Param label="Saturation" value={props.value.saturation} min={-100} max={100} suffix="%" onChange={(s) => set({ saturation: s })} />
      </Show>
    </>
  );
}
