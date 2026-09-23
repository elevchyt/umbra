/**
 * Window ▸ Brush Settings (F5) — spec 01 §5: the sections down the left, each with its
 * checkbox, the selected section's controls on the right, and a live stroke preview drawn by
 * the brush engine itself (the CPU reference of the same dabs the canvas gets).
 */
import { For, Show, createEffect, createSignal, type JSX } from 'solid-js';
import { Checkbox, Select } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import {
  DEFAULT_COLOR_DYNAMICS,
  DEFAULT_DUAL,
  DEFAULT_POSE,
  DEFAULT_SCATTERING,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_SMOOTHING,
  DEFAULT_TEXTURE,
  DEFAULT_TRANSFER,
  beginBrushStroke,
  brushStrokeTo,
  renderDabs,
  type BrushParams,
  type ControlSource,
  type Dab,
  type Dynamic,
  type DualMode,
  type TextureMode,
} from '@umbra/engine';
import { store } from '../state/store';
import { Slide } from '../fx/controls';
import { PatternPicker } from '../adjust/fill';

type SectionKey = 'tip' | 'shape' | 'scatter' | 'texture' | 'dual' | 'color' | 'transfer' | 'pose' | 'noise' | 'wet' | 'buildup' | 'smoothing' | 'protect';

const SECTIONS: { key: SectionKey; label: string; toggle?: boolean }[] = [
  { key: 'tip', label: 'Brush Tip Shape' },
  { key: 'shape', label: 'Shape Dynamics', toggle: true },
  { key: 'scatter', label: 'Scattering', toggle: true },
  { key: 'texture', label: 'Texture', toggle: true },
  { key: 'dual', label: 'Dual Brush', toggle: true },
  { key: 'color', label: 'Color Dynamics', toggle: true },
  { key: 'transfer', label: 'Transfer', toggle: true },
  { key: 'pose', label: 'Brush Pose', toggle: true },
  { key: 'noise', label: 'Noise', toggle: true },
  { key: 'wet', label: 'Wet Edges', toggle: true },
  { key: 'buildup', label: 'Build-up', toggle: true },
  { key: 'smoothing', label: 'Smoothing', toggle: true },
  { key: 'protect', label: 'Protect Texture', toggle: true },
];

const CONTROLS: { value: ControlSource; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'fade', label: 'Fade' },
  { value: 'pressure', label: 'Pen Pressure' },
  { value: 'tilt', label: 'Pen Tilt' },
  { value: 'wheel', label: 'Stylus Wheel' },
  { value: 'rotation', label: 'Rotation' },
  { value: 'initialDirection', label: 'Initial Direction' },
  { value: 'direction', label: 'Direction' },
];

const DUAL_MODES: { value: DualMode; label: string }[] = [
  { value: 'multiply', label: 'Multiply' },
  { value: 'darken', label: 'Darken' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'colorDodge', label: 'Color Dodge' },
  { value: 'colorBurn', label: 'Color Burn' },
  { value: 'linearBurn', label: 'Linear Burn' },
  { value: 'hardMix', label: 'Hard Mix' },
  { value: 'linearHeight', label: 'Linear Height' },
];

const TEXTURE_MODES: { value: TextureMode; label: string }[] = [
  ...DUAL_MODES.filter((m) => m.value !== 'linearHeight'),
  { value: 'subtract', label: 'Subtract' },
  { value: 'linearHeight', label: 'Linear Height' },
  { value: 'height', label: 'Height' },
];

const pct = (v: number) => Math.round(v * 100);

/** One dynamic: jitter, its control (with fade steps), and a minimum where it has one. */
function DynamicRow(props: { label: string; value: Dynamic; onChange: (d: Dynamic) => void; minimum?: boolean; controls?: ControlSource[]; jitterMax?: number }) {
  const d = () => props.value;
  const set = (patch: Partial<Dynamic>) => props.onChange({ ...d(), ...patch });
  return (
    <div class="bs-dynamic">
      <Slide label={`${props.label} Jitter`} value={pct(d().jitter)} min={0} max={props.jitterMax ?? 100} suffix="%" onChange={(v) => set({ jitter: v / 100 })} />
      <div class="bs-row">
        <Select label="Control" value={d().control} width={120} options={props.controls ? CONTROLS.filter((c) => props.controls!.includes(c.value)) : CONTROLS} onChange={(v) => set({ control: v as ControlSource })} />
        <Show when={d().control === 'fade'}>
          <NumberField value={d().fadeSteps} min={1} max={9999} width={48} title="Fade steps" onChange={(v) => set({ fadeSteps: v })} />
        </Show>
      </div>
      <Show when={props.minimum}>
        <Slide label="Minimum" value={pct(d().minimum)} min={0} max={100} suffix="%" onChange={(v) => set({ minimum: v / 100 })} />
      </Show>
    </div>
  );
}

function BrushPreview() {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    // Read every field so the preview follows each change.
    const b = JSON.parse(JSON.stringify(store.brush)) as BrushParams;
    const W = 260;
    const H = 70;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Shown at a size that fits the strip; everything else is relative to the size.
    const size = Math.min(b.size, 36);
    const k = size / Math.max(1, b.size);
    const p: BrushParams = {
      ...b,
      size,
      smoothing: 0,
      airbrush: false,
      seed: 42,
      pressureSize: false,
      pressureOpacity: false,
      ...(b.dual ? { dual: { ...b.dual, size: b.dual.size * k } } : {}),
      // Sampled tips and textures need the engine's bitmaps; the preview draws the shape.
      // (The dual brush is drawn: its tip is computed unless sampled.)
      tip: { kind: 'computed' },
      texture: undefined,
      symmetry: undefined,
    };
    const s = beginBrushStroke(p, { fg: [0, 0, 0], bg: [0.5, 0.5, 0.5] });
    const dabs: Dab[] = [];
    // An S-curve whose pressure rises and falls, like Photoshop's preview stroke.
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      const x = 20 + t * (W - 40);
      const y = H / 2 + Math.sin(t * Math.PI * 2) * (H / 2 - size / 2 - 4);
      dabs.push(...brushStrokeTo(s, { x, y, pressure: Math.sin(t * Math.PI), time: i * 16, tiltX: 0, tiltY: 0, twist: t * 360 }));
    }
    const cov = renderDabs(dabs, W, H, { noise: !!p.noise, ...(p.dual?.enabled ? { dual: { hardness: p.dual.hardness, mode: p.dual.mode } } : {}) });
    const img = ctx.createImageData(W, H);
    const colorAt = new Float32Array(W * H * 3).fill(0);
    // Colour Dynamics: the last dab over a pixel gives its colour (good enough to see jitter).
    for (const d of dabs) {
      if (!d.color) continue;
      const r = Math.ceil(d.radius);
      for (let y = Math.max(0, Math.floor(d.y - r)); y < Math.min(H, d.y + r); y++)
        for (let x = Math.max(0, Math.floor(d.x - r)); x < Math.min(W, d.x + r); x++)
          if ((x - d.x) ** 2 + (y - d.y) ** 2 <= r * r) colorAt.set(d.color, (y * W + x) * 3);
    }
    for (let i = 0; i < W * H; i++) {
      const a = Math.min(1, (b.wetEdges ? cov[i]! * (0.5 + 2 * cov[i]! * (1 - cov[i]!)) : cov[i]!) * b.opacity);
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round((1 - a) * 235 + a * colorAt[i * 3 + c]! * 255);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  return <canvas ref={canvas} class="bs-preview" width={260} height={70} />;
}

export function BrushSettingsPanel() {
  const [section, setSection] = createSignal<SectionKey>('tip');
  const b = store.brush;
  const set = <K extends keyof BrushParams>(k: K, v: BrushParams[K]) => store.setBrush(k as never, v as never);
  const on = (k: SectionKey): boolean => {
    switch (k) {
      case 'shape':
        return !!b.shapeDynamics?.enabled;
      case 'scatter':
        return !!b.scattering?.enabled;
      case 'texture':
        return !!b.texture?.enabled;
      case 'dual':
        return !!b.dual?.enabled;
      case 'color':
        return !!b.colorDynamics?.enabled;
      case 'transfer':
        return !!b.transfer?.enabled;
      case 'pose':
        return !!b.pose?.enabled;
      case 'noise':
        return !!b.noise;
      case 'wet':
        return !!b.wetEdges;
      case 'buildup':
        return b.airbrush;
      case 'smoothing':
        return b.smoothing > 0;
      case 'protect':
        return !!b.protectTexture;
      default:
        return true;
    }
  };
  const toggle = (k: SectionKey, v: boolean) => {
    switch (k) {
      case 'shape':
        return set('shapeDynamics', { ...(b.shapeDynamics ?? DEFAULT_SHAPE_DYNAMICS), enabled: v });
      case 'scatter':
        return set('scattering', { ...(b.scattering ?? DEFAULT_SCATTERING), enabled: v });
      case 'texture':
        return set('texture', { ...(b.texture ?? { ...DEFAULT_TEXTURE, patternId: store.patterns()[0]?.id ?? '' }), enabled: v });
      case 'dual':
        return set('dual', { ...(b.dual ?? DEFAULT_DUAL), enabled: v });
      case 'color':
        return set('colorDynamics', { ...(b.colorDynamics ?? DEFAULT_COLOR_DYNAMICS), enabled: v });
      case 'transfer':
        return set('transfer', { ...(b.transfer ?? DEFAULT_TRANSFER), enabled: v });
      case 'pose':
        return set('pose', { ...(b.pose ?? DEFAULT_POSE), enabled: v });
      case 'noise':
        return set('noise', v);
      case 'wet':
        return set('wetEdges', v);
      case 'buildup':
        return set('airbrush', v);
      case 'smoothing':
        return set('smoothing', v ? Math.max(0.1, b.smoothing) : 0);
      case 'protect':
        return set('protectTexture', v);
    }
  };
  const sd = () => b.shapeDynamics ?? DEFAULT_SHAPE_DYNAMICS;
  const setSd = (patch: Partial<typeof DEFAULT_SHAPE_DYNAMICS>) => set('shapeDynamics', { ...sd(), enabled: true, ...patch });
  const sc = () => b.scattering ?? DEFAULT_SCATTERING;
  const setSc = (patch: Partial<typeof DEFAULT_SCATTERING>) => set('scattering', { ...sc(), enabled: true, ...patch });
  const tx = () => b.texture ?? { ...DEFAULT_TEXTURE, patternId: store.patterns()[0]?.id ?? '' };
  const setTx = (patch: Partial<typeof DEFAULT_TEXTURE>) => set('texture', { ...tx(), enabled: true, ...patch });
  const du = () => b.dual ?? DEFAULT_DUAL;
  const setDu = (patch: Partial<typeof DEFAULT_DUAL>) => set('dual', { ...du(), enabled: true, ...patch });
  const cd = () => b.colorDynamics ?? DEFAULT_COLOR_DYNAMICS;
  const setCd = (patch: Partial<typeof DEFAULT_COLOR_DYNAMICS>) => set('colorDynamics', { ...cd(), enabled: true, ...patch });
  const tr = () => b.transfer ?? DEFAULT_TRANSFER;
  const setTr = (patch: Partial<typeof DEFAULT_TRANSFER>) => set('transfer', { ...tr(), enabled: true, ...patch });
  const po = () => b.pose ?? DEFAULT_POSE;
  const setPo = (patch: Partial<typeof DEFAULT_POSE>) => set('pose', { ...po(), enabled: true, ...patch });
  const so = () => b.smoothingOptions ?? DEFAULT_SMOOTHING;
  const setSo = (patch: Partial<typeof DEFAULT_SMOOTHING>) => set('smoothingOptions', { ...so(), ...patch });

  const pages: Record<SectionKey, () => JSX.Element> = {
    tip: () => (
      <>
        <Slide label="Size" value={b.size} min={1} max={5000} suffix="px" onChange={(v) => set('size', v)} />
        <div class="bs-row">
          <Checkbox checked={!!b.flipX} label="Flip X" onChange={(v) => set('flipX', v)} />
          <Checkbox checked={!!b.flipY} label="Flip Y" onChange={(v) => set('flipY', v)} />
        </div>
        <Slide label="Angle" value={b.angle} min={-180} max={180} suffix="°" onChange={(v) => set('angle', v)} />
        <Slide label="Roundness" value={pct(b.roundness)} min={1} max={100} suffix="%" onChange={(v) => set('roundness', v / 100)} />
        <Show when={b.tip?.kind !== 'sampled'}>
          <Slide label="Hardness" value={pct(b.hardness)} min={0} max={100} suffix="%" onChange={(v) => set('hardness', v / 100)} />
        </Show>
        <Slide label="Spacing" value={pct(b.spacing)} min={1} max={1000} suffix="%" onChange={(v) => set('spacing', v / 100)} />
      </>
    ),
    shape: () => (
      <>
        <DynamicRow label="Size" value={sd().size} onChange={(v) => setSd({ size: v })} controls={['off', 'fade', 'pressure', 'tilt', 'wheel', 'rotation']} />
        <Slide label="Minimum Diameter" value={pct(sd().minDiameter)} min={0} max={100} suffix="%" onChange={(v) => setSd({ minDiameter: v / 100 })} />
        <Slide label="Tilt Scale" value={pct(sd().tiltScale)} min={0} max={200} suffix="%" onChange={(v) => setSd({ tiltScale: v / 100 })} />
        <DynamicRow label="Angle" value={sd().angle} onChange={(v) => setSd({ angle: v })} />
        <DynamicRow label="Roundness" value={sd().roundness} onChange={(v) => setSd({ roundness: v })} controls={['off', 'fade', 'pressure', 'tilt', 'wheel', 'rotation']} />
        <Slide label="Minimum Roundness" value={pct(sd().minRoundness)} min={1} max={100} suffix="%" onChange={(v) => setSd({ minRoundness: v / 100 })} />
        <div class="bs-row">
          <Checkbox checked={sd().flipXJitter} label="Flip X Jitter" onChange={(v) => setSd({ flipXJitter: v })} />
          <Checkbox checked={sd().flipYJitter} label="Flip Y Jitter" onChange={(v) => setSd({ flipYJitter: v })} />
        </div>
      </>
    ),
    scatter: () => (
      <>
        <div class="bs-row">
          <Slide label="Scatter" value={pct(sc().scatter.jitter)} min={0} max={1000} suffix="%" onChange={(v) => setSc({ scatter: { ...sc().scatter, jitter: v / 100 } })} />
          <Checkbox checked={sc().bothAxes} label="Both Axes" onChange={(v) => setSc({ bothAxes: v })} />
        </div>
        <Select label="Control" value={sc().scatter.control} width={120} options={CONTROLS.filter((c) => c.value !== 'direction' && c.value !== 'initialDirection')} onChange={(v) => setSc({ scatter: { ...sc().scatter, control: v as ControlSource } })} />
        <Slide label="Count" value={sc().count} min={1} max={16} onChange={(v) => setSc({ count: v })} />
        <DynamicRow label="Count" value={sc().countJitter} onChange={(v) => setSc({ countJitter: v })} />
      </>
    ),
    texture: () => (
      <>
        <PatternPicker selected={tx().patternId} onPick={(p) => setTx({ patternId: p.id })} />
        <Checkbox checked={tx().invert} label="Invert" onChange={(v) => setTx({ invert: v })} />
        <Slide label="Scale" value={tx().scale} min={1} max={1000} suffix="%" onChange={(v) => setTx({ scale: v })} />
        <Slide label="Brightness" value={tx().brightness} min={-150} max={150} onChange={(v) => setTx({ brightness: v })} />
        <Slide label="Contrast" value={tx().contrast} min={-50} max={100} onChange={(v) => setTx({ contrast: v })} />
        <Checkbox checked={tx().eachTip} label="Texture Each Tip" onChange={(v) => setTx({ eachTip: v })} />
        <Select label="Mode" value={tx().mode} width={120} options={TEXTURE_MODES} onChange={(v) => setTx({ mode: v as TextureMode })} />
        <Slide label="Depth" value={pct(tx().depth)} min={0} max={100} suffix="%" onChange={(v) => setTx({ depth: v / 100 })} />
        <Slide label="Minimum Depth" value={pct(tx().minDepth)} min={0} max={100} suffix="%" onChange={(v) => setTx({ minDepth: v / 100 })} />
        <DynamicRow label="Depth" value={tx().depthJitter} onChange={(v) => setTx({ depthJitter: v })} />
      </>
    ),
    dual: () => (
      <>
        <div class="bs-row">
          <Select label="Mode" value={du().mode} width={120} options={DUAL_MODES} onChange={(v) => setDu({ mode: v as DualMode })} />
          <Checkbox checked={du().flip} label="Flip" onChange={(v) => setDu({ flip: v })} />
        </div>
        <Slide label="Size" value={du().size} min={1} max={2500} suffix="px" onChange={(v) => setDu({ size: v })} />
        <Slide label="Hardness" value={pct(du().hardness)} min={0} max={100} suffix="%" onChange={(v) => setDu({ hardness: v / 100 })} />
        <Slide label="Spacing" value={pct(du().spacing)} min={1} max={1000} suffix="%" onChange={(v) => setDu({ spacing: v / 100 })} />
        <div class="bs-row">
          <Slide label="Scatter" value={pct(du().scatter)} min={0} max={1000} suffix="%" onChange={(v) => setDu({ scatter: v / 100 })} />
          <Checkbox checked={du().bothAxes} label="Both Axes" onChange={(v) => setDu({ bothAxes: v })} />
        </div>
        <Slide label="Count" value={du().count} min={1} max={16} onChange={(v) => setDu({ count: v })} />
      </>
    ),
    color: () => (
      <>
        <Checkbox checked={cd().eachTip} label="Apply Per Tip" onChange={(v) => setCd({ eachTip: v })} />
        <DynamicRow label="Foreground/Background" value={cd().fgBg} onChange={(v) => setCd({ fgBg: v })} controls={['off', 'fade', 'pressure', 'tilt', 'wheel', 'rotation']} />
        <Slide label="Hue Jitter" value={pct(cd().hue)} min={0} max={100} suffix="%" onChange={(v) => setCd({ hue: v / 100 })} />
        <Slide label="Saturation Jitter" value={pct(cd().saturation)} min={0} max={100} suffix="%" onChange={(v) => setCd({ saturation: v / 100 })} />
        <Slide label="Brightness Jitter" value={pct(cd().brightness)} min={0} max={100} suffix="%" onChange={(v) => setCd({ brightness: v / 100 })} />
        <Slide label="Purity" value={pct(cd().purity)} min={-100} max={100} suffix="%" onChange={(v) => setCd({ purity: v / 100 })} />
      </>
    ),
    transfer: () => (
      <>
        <DynamicRow label="Opacity" value={tr().opacity} onChange={(v) => setTr({ opacity: v })} minimum controls={['off', 'fade', 'pressure', 'tilt', 'wheel']} />
        <DynamicRow label="Flow" value={tr().flow} onChange={(v) => setTr({ flow: v })} minimum controls={['off', 'fade', 'pressure', 'tilt', 'wheel']} />
      </>
    ),
    pose: () => (
      <>
        <div class="bs-row">
          <Checkbox checked={po().overrideTilt} label="Override Tilt" onChange={(v) => setPo({ overrideTilt: v })} />
        </div>
        <Slide label="Tilt X" value={po().tiltX} min={-90} max={90} suffix="°" onChange={(v) => setPo({ tiltX: v })} />
        <Slide label="Tilt Y" value={po().tiltY} min={-90} max={90} suffix="°" onChange={(v) => setPo({ tiltY: v })} />
        <Checkbox checked={po().overrideRotation} label="Override Rotation" onChange={(v) => setPo({ overrideRotation: v })} />
        <Slide label="Rotation" value={po().rotation} min={-180} max={180} suffix="°" onChange={(v) => setPo({ rotation: v })} />
        <Checkbox checked={po().overridePressure} label="Override Pressure" onChange={(v) => setPo({ overridePressure: v })} />
        <Slide label="Pressure" value={pct(po().pressure)} min={1} max={100} suffix="%" onChange={(v) => setPo({ pressure: v / 100 })} />
      </>
    ),
    noise: () => <div class="dim">Adds random grain to the soft edges of the tip.</div>,
    wet: () => <div class="dim">Paint pools at the stroke's edges; the middle dries to half.</div>,
    buildup: () => (
      <>
        <div class="dim">Keeps depositing while the pointer is held still, like an airbrush.</div>
        <Slide label="Rate" value={b.airbrushRate} min={1} max={200} suffix="/s" onChange={(v) => set('airbrushRate', v)} />
      </>
    ),
    smoothing: () => (
      <>
        <Slide label="Smoothing" value={pct(b.smoothing)} min={0} max={100} suffix="%" onChange={(v) => set('smoothing', v / 100)} />
        <Checkbox checked={so().pulledString} label="Pulled String Mode" onChange={(v) => setSo({ pulledString: v })} />
        <Checkbox checked={so().catchUp} label="Stroke Catch-up" onChange={(v) => setSo({ catchUp: v })} />
        <Checkbox checked={so().catchUpOnEnd} label="Catch-up on Stroke End" onChange={(v) => setSo({ catchUpOnEnd: v })} />
        <Checkbox checked={so().adjustForZoom} label="Adjust for Zoom" onChange={(v) => setSo({ adjustForZoom: v })} />
      </>
    ),
    protect: () => <div class="dim">Keeps one texture for every brush that has one (applies with Texture).</div>,
  };

  return (
    <div class="brush-settings">
      <div class="bs-body">
        <div class="bs-list">
          <For each={SECTIONS}>
            {(sec) => (
              <div class="bs-item" classList={{ selected: section() === sec.key }} onClick={() => setSection(sec.key)}>
                <Show when={sec.toggle} fallback={<span class="bs-spacer" />}>
                  <input type="checkbox" checked={on(sec.key)} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(sec.key, e.currentTarget.checked)} />
                </Show>
                <span>{sec.label}</span>
              </div>
            )}
          </For>
        </div>
        <div class="bs-page">{pages[section()]()}</div>
      </div>
      <BrushPreview />
    </div>
  );
}
