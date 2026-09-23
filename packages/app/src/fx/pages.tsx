/** The Layer Style dialog's pages: one per effect, and Blending Options. */
import { For, Show } from 'solid-js';
import { Checkbox, Select, Button } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import type { BlendMode } from '@umbra/core/blend';
import type {
  AdvancedBlending,
  BevelEffect,
  BlendIfRange,
  ColorOverlayEffect,
  GlowEffect,
  GradientOverlayEffect,
  PatternOverlayEffect,
  SatinEffect,
  ShadowEffect,
  StrokeEffect,
  StrokeFill,
  Gradient,
} from '@umbra/engine';
import { AngleRow, ContourRow, GradientRow, Group, ModeRow, PatternRow, Radio, Slide, Swatch, MODES, type Rgb } from './controls';

type Set<T> = (patch: Partial<T>) => void;

const GRADIENT_STYLES = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
] as const;

export function ShadowPage(props: { value: ShadowEffect; set: Set<ShadowEffect>; inner: boolean; light: number; onLight: (a: number) => void }) {
  const v = () => props.value;
  const angle = () => (v().useGlobalLight ? props.light : v().angle);
  return (
    <>
      <Group title="Structure">
        <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} color={v().color} onColor={(c) => props.set({ color: c })} />
        <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
        <AngleRow angle={angle()} onAngle={(a) => (v().useGlobalLight ? props.onLight(a) : props.set({ angle: a }))} global={v().useGlobalLight} onGlobal={(g) => props.set({ useGlobalLight: g, angle: angle() })} />
        <Slide label="Distance" value={v().distance} min={0} max={props.inner ? 30000 : 30000} suffix="px" onChange={(d) => props.set({ distance: d })} />
        <Slide label={props.inner ? 'Choke' : 'Spread'} value={v().spread} min={0} max={100} suffix="%" onChange={(s) => props.set({ spread: s })} />
        <Slide label="Size" value={v().size} min={0} max={250} suffix="px" onChange={(s) => props.set({ size: s })} />
      </Group>
      <Group title="Quality">
        <ContourRow contour={v().contour} onContour={(c) => props.set({ contour: c })} aa={v().antiAlias} onAa={(a) => props.set({ antiAlias: a })} />
        <Slide label="Noise" value={v().noise} min={0} max={100} suffix="%" onChange={(n) => props.set({ noise: n })} />
      </Group>
      <Show when={!props.inner}>
        <Checkbox checked={v().knockout} label="Layer Knocks Out Drop Shadow" onChange={(k) => props.set({ knockout: k })} />
      </Show>
    </>
  );
}

export function GlowPage(props: { value: GlowEffect; set: Set<GlowEffect>; inner: boolean; fg: Rgb }) {
  const v = () => props.value;
  const fillType = () => v().fill.type;
  return (
    <>
      <Group title="Structure">
        <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} />
        <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
        <Slide label="Noise" value={v().noise} min={0} max={100} suffix="%" onChange={(n) => props.set({ noise: n })} />
        <div class="fx-row">
          <Radio
            value={fillType()}
            options={[
              { value: 'color', label: 'Color' },
              { value: 'gradient', label: 'Gradient' },
            ]}
            onChange={(t) =>
              props.set({
                fill:
                  t === 'color'
                    ? { type: 'color', color: [1, 1, 190 / 255] }
                    : { type: 'gradient', gradient: { colorStops: [{ at: 0, color: props.fg }, { at: 1, color: props.fg }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 0 }], name: 'Foreground to Transparent' } },
              })
            }
          />
          <Show when={v().fill.type === 'color'}>
            <Swatch value={(v().fill as { color: Rgb }).color} onChange={(c) => props.set({ fill: { type: 'color', color: c } })} />
          </Show>
        </div>
        <Show when={v().fill.type === 'gradient'}>
          <GradientRow gradient={(v().fill as { gradient: Gradient }).gradient} reverse={false} onGradient={(g) => props.set({ fill: { type: 'gradient', gradient: g } })} />
        </Show>
      </Group>
      <Group title="Elements">
        <Select
          value={v().technique}
          label="Technique"
          width={110}
          options={[
            { value: 'softer', label: 'Softer' },
            { value: 'precise', label: 'Precise' },
          ]}
          onChange={(t) => props.set({ technique: t })}
        />
        <Show when={props.inner}>
          <Radio
            value={v().source}
            options={[
              { value: 'center', label: 'Center' },
              { value: 'edge', label: 'Edge' },
            ]}
            onChange={(s) => props.set({ source: s })}
          />
        </Show>
        <Slide label={props.inner ? 'Choke' : 'Spread'} value={v().spread} min={0} max={100} suffix="%" onChange={(s) => props.set({ spread: s })} />
        <Slide label="Size" value={v().size} min={0} max={250} suffix="px" onChange={(s) => props.set({ size: s })} />
      </Group>
      <Group title="Quality">
        <ContourRow contour={v().contour} onContour={(c) => props.set({ contour: c })} aa={v().antiAlias} onAa={(a) => props.set({ antiAlias: a })} />
        <Slide label="Range" value={v().range} min={1} max={100} suffix="%" onChange={(r) => props.set({ range: r })} />
        <Slide label="Jitter" value={v().jitter} min={0} max={100} suffix="%" onChange={(j) => props.set({ jitter: j })} />
      </Group>
    </>
  );
}

export function BevelPage(props: { value: BevelEffect; set: Set<BevelEffect>; light: { angle: number; altitude: number }; onLight: (l: { angle: number; altitude: number }) => void }) {
  const v = () => props.value;
  const angle = () => (v().useGlobalLight ? props.light.angle : v().angle);
  const altitude = () => (v().useGlobalLight ? props.light.altitude : v().altitude);
  return (
    <>
      <Group title="Structure">
        <Select
          value={v().style}
          label="Style"
          width={130}
          options={[
            { value: 'outerBevel', label: 'Outer Bevel' },
            { value: 'innerBevel', label: 'Inner Bevel' },
            { value: 'emboss', label: 'Emboss' },
            { value: 'pillowEmboss', label: 'Pillow Emboss' },
            { value: 'strokeEmboss', label: 'Stroke Emboss' },
          ]}
          onChange={(s) => props.set({ style: s })}
        />
        <Select
          value={v().technique}
          label="Technique"
          width={130}
          options={[
            { value: 'smooth', label: 'Smooth' },
            { value: 'chiselHard', label: 'Chisel Hard' },
            { value: 'chiselSoft', label: 'Chisel Soft' },
          ]}
          onChange={(t) => props.set({ technique: t })}
        />
        <Slide label="Depth" value={v().depth} min={1} max={1000} suffix="%" onChange={(d) => props.set({ depth: d })} />
        <Radio
          value={v().direction}
          options={[
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
          ]}
          onChange={(d) => props.set({ direction: d })}
        />
        <Slide label="Size" value={v().size} min={0} max={250} suffix="px" onChange={(s) => props.set({ size: s })} />
        <Slide label="Soften" value={v().soften} min={0} max={16} suffix="px" onChange={(s) => props.set({ soften: s })} />
      </Group>
      <Group title="Shading">
        <AngleRow
          angle={angle()}
          onAngle={(a) => (v().useGlobalLight ? props.onLight({ angle: a, altitude: altitude() }) : props.set({ angle: a }))}
          global={v().useGlobalLight}
          onGlobal={(g) => props.set({ useGlobalLight: g, angle: angle(), altitude: altitude() })}
        />
        <Slide
          label="Altitude"
          value={altitude()}
          min={0}
          max={90}
          suffix="°"
          onChange={(a) => (v().useGlobalLight ? props.onLight({ angle: angle(), altitude: a }) : props.set({ altitude: a }))}
        />
        <ContourRow label="Gloss Contour" contour={v().gloss} onContour={(c) => props.set({ gloss: c })} aa={v().antiAliasGloss} onAa={(a) => props.set({ antiAliasGloss: a })} />
        <ModeRow label="Highlight Mode" mode={v().highlightMode} onMode={(m) => props.set({ highlightMode: m })} color={v().highlightColor} onColor={(c) => props.set({ highlightColor: c })} />
        <Slide label="Opacity" value={Math.round(v().highlightOpacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ highlightOpacity: o / 100 })} />
        <ModeRow label="Shadow Mode" mode={v().shadowMode} onMode={(m) => props.set({ shadowMode: m })} color={v().shadowColor} onColor={(c) => props.set({ shadowColor: c })} />
        <Slide label="Opacity" value={Math.round(v().shadowOpacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ shadowOpacity: o / 100 })} />
      </Group>
    </>
  );
}

export function BevelContourPage(props: { value: BevelEffect; set: Set<BevelEffect> }) {
  return (
    <Group title="Elements">
      <ContourRow contour={props.value.contour} onContour={(c) => props.set({ contour: c, contourEnabled: true })} aa={props.value.contourAntiAlias} onAa={(a) => props.set({ contourAntiAlias: a })} />
      <Slide label="Range" value={props.value.contourRange} min={1} max={100} suffix="%" onChange={(r) => props.set({ contourRange: r })} />
    </Group>
  );
}

export function BevelTexturePage(props: { value: BevelEffect; set: Set<BevelEffect> }) {
  return (
    <Group title="Elements">
      <PatternRow pattern={props.value.texture} onPattern={(p) => props.set({ texture: p, textureEnabled: true })} />
      <Slide label="Scale" value={props.value.textureScale} min={1} max={1000} suffix="%" onChange={(s) => props.set({ textureScale: s })} />
      <Slide label="Depth" value={props.value.textureDepth} min={-1000} max={1000} suffix="%" onChange={(d) => props.set({ textureDepth: d })} />
      <Checkbox checked={props.value.textureInvert} label="Invert" onChange={(i) => props.set({ textureInvert: i })} />
    </Group>
  );
}

export function SatinPage(props: { value: SatinEffect; set: Set<SatinEffect> }) {
  const v = () => props.value;
  return (
    <Group title="Structure">
      <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} color={v().color} onColor={(c) => props.set({ color: c })} />
      <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
      <AngleRow angle={v().angle} onAngle={(a) => props.set({ angle: a })} />
      <Slide label="Distance" value={v().distance} min={1} max={250} suffix="px" onChange={(d) => props.set({ distance: d })} />
      <Slide label="Size" value={v().size} min={0} max={250} suffix="px" onChange={(s) => props.set({ size: s })} />
      <ContourRow contour={v().contour} onContour={(c) => props.set({ contour: c })} aa={v().antiAlias} onAa={(a) => props.set({ antiAlias: a })} />
      <Checkbox checked={v().invert} label="Invert" onChange={(i) => props.set({ invert: i })} />
    </Group>
  );
}

export function ColorOverlayPage(props: { value: ColorOverlayEffect; set: Set<ColorOverlayEffect> }) {
  return (
    <Group title="Color">
      <ModeRow mode={props.value.blendMode} onMode={(m) => props.set({ blendMode: m })} color={props.value.color} onColor={(c) => props.set({ color: c })} />
      <Slide label="Opacity" value={Math.round(props.value.opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
    </Group>
  );
}

export function GradientOverlayPage(props: { value: GradientOverlayEffect; set: Set<GradientOverlayEffect> }) {
  const v = () => props.value;
  return (
    <Group title="Gradient">
      <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} />
      <Checkbox checked={v().dither} label="Dither" onChange={(d) => props.set({ dither: d })} />
      <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
      <GradientRow gradient={v().gradient} reverse={v().reverse} onGradient={(g) => props.set({ gradient: g })} onReverse={(r) => props.set({ reverse: r })} />
      <div class="fx-row">
        <Select value={v().style} label="Style" width={110} options={[...GRADIENT_STYLES]} onChange={(s) => props.set({ style: s })} />
        <Checkbox checked={v().align} label="Align with Layer" onChange={(a) => props.set({ align: a })} />
      </div>
      <AngleRow angle={v().angle} onAngle={(a) => props.set({ angle: a })} />
      <Slide label="Scale" value={v().scale} min={10} max={150} suffix="%" onChange={(s) => props.set({ scale: s })} />
      <Button width={120} onClick={() => props.set({ offset: { x: 0, y: 0 } })}>
        Reset Alignment
      </Button>
    </Group>
  );
}

export function PatternOverlayPage(props: { value: PatternOverlayEffect; set: Set<PatternOverlayEffect> }) {
  const v = () => props.value;
  return (
    <Group title="Pattern">
      <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} />
      <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
      <PatternRow pattern={v().pattern} onPattern={(p) => props.set({ pattern: p })} />
      <Slide label="Scale" value={v().scale} min={1} max={1000} suffix="%" onChange={(s) => props.set({ scale: s })} />
      <div class="fx-row">
        <Checkbox checked={v().link} label="Link with Layer" onChange={(l) => props.set({ link: l })} />
        <Button width={110} onClick={() => props.set({ phase: { x: 0, y: 0 } })}>
          Snap to Origin
        </Button>
      </div>
    </Group>
  );
}

export function StrokePage(props: { value: StrokeEffect; set: Set<StrokeEffect>; fg: Rgb; bg: Rgb }) {
  const v = () => props.value;
  const f = () => v().fill;
  const setFill = (fill: StrokeFill) => props.set({ fill });
  const defaultGradient = (): Gradient => ({ colorStops: [{ at: 0, color: props.fg }, { at: 1, color: props.bg }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 1 }], name: 'Foreground to Background' });
  return (
    <>
      <Group title="Structure">
        <Slide label="Size" value={v().size} min={1} max={250} suffix="px" onChange={(s) => props.set({ size: s })} />
        <Select
          value={v().position}
          label="Position"
          width={110}
          options={[
            { value: 'outside', label: 'Outside' },
            { value: 'inside', label: 'Inside' },
            { value: 'center', label: 'Center' },
          ]}
          onChange={(p) => props.set({ position: p })}
        />
        <div class="fx-row">
          <Select value={v().blendMode} label="Blend Mode" width={130} options={MODES} onChange={(m: BlendMode) => props.set({ blendMode: m })} />
          <Checkbox checked={v().overprint} label="Overprint" onChange={(o) => props.set({ overprint: o })} />
        </div>
        <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
      </Group>
      <Group title="Fill">
        <Select
          value={f().type}
          label="Fill Type"
          width={110}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'gradient', label: 'Gradient' },
            { value: 'pattern', label: 'Pattern' },
          ]}
          onChange={(t) =>
            setFill(
              t === 'color'
                ? { type: 'color', color: [0, 0, 0] }
                : t === 'gradient'
                  ? { type: 'gradient', gradient: defaultGradient(), style: 'linear', angle: 90, scale: 100, reverse: false, align: true }
                  : { type: 'pattern', pattern: null, scale: 100, link: true },
            )
          }
        />
        <Show when={f().type === 'color' ? (f() as Extract<StrokeFill, { type: 'color' }>) : null}>
          {(c) => (
            <div class="fx-row">
              <span class="fx-label">Color</span>
              <Swatch value={c().color} onChange={(color) => setFill({ type: 'color', color })} />
            </div>
          )}
        </Show>
        <Show when={f().type === 'gradient' ? (f() as Extract<StrokeFill, { type: 'gradient' }>) : null}>
          {(g) => (
            <>
              <GradientRow gradient={g().gradient} reverse={g().reverse} onGradient={(gradient) => setFill({ ...g(), gradient })} onReverse={(reverse) => setFill({ ...g(), reverse })} />
              <div class="fx-row">
                <Select value={g().style} label="Style" width={120} options={[...GRADIENT_STYLES, { value: 'shapeBurst', label: 'Shape Burst' }]} onChange={(style) => setFill({ ...g(), style })} />
                <Checkbox checked={g().align} label="Align with Layer" onChange={(align) => setFill({ ...g(), align })} />
              </div>
              <AngleRow angle={g().angle} onAngle={(angle) => setFill({ ...g(), angle })} />
              <Slide label="Scale" value={g().scale} min={10} max={150} suffix="%" onChange={(scale) => setFill({ ...g(), scale })} />
            </>
          )}
        </Show>
        <Show when={f().type === 'pattern' ? (f() as Extract<StrokeFill, { type: 'pattern' }>) : null}>
          {(p) => (
            <>
              <PatternRow pattern={p().pattern} onPattern={(pattern) => setFill({ ...p(), pattern })} />
              <Slide label="Scale" value={p().scale} min={1} max={1000} suffix="%" onChange={(scale) => setFill({ ...p(), scale })} />
              <Checkbox checked={p().link} label="Link with Layer" onChange={(link) => setFill({ ...p(), link })} />
            </>
          )}
        </Show>
      </Group>
    </>
  );
}

export interface BlendingValue {
  opacity: number;
  fill: number;
  blendMode: BlendMode;
  blending: AdvancedBlending;
}

/** A Blend If split slider: two handles per end; Alt-drag splits a handle to make a soft ramp. */
function BlendIfSlider(props: { label: string; value: [number, number, number, number]; onChange: (v: [number, number, number, number]) => void }) {
  let track!: HTMLDivElement;
  const drag = (which: 'black' | 'white', e: PointerEvent) => {
    e.preventDefault();
    const alt = e.altKey;
    const v0 = [...props.value] as [number, number, number, number];
    // Alt drags the handle's nearer half; otherwise both halves move together.
    const r = track.getBoundingClientRect();
    const at = (ev: PointerEvent) => Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const start = at(e);
    const [i0, i1] = which === 'black' ? [0, 1] : [2, 3];
    const half = Math.abs(start - v0[i0]!) < Math.abs(start - v0[i1]!) ? i0 : i1;
    const move = (ev: PointerEvent) => {
      const d = at(ev) - start;
      const v = [...v0] as [number, number, number, number];
      const clampTo = (x: number) => Math.min(1, Math.max(0, x));
      if (alt) v[half] = clampTo(v0[half]! + d);
      else {
        v[i0] = clampTo(v0[i0]! + d);
        v[i1] = clampTo(v0[i1]! + d);
      }
      // Black stops stay left of white stops.
      if (which === 'black') {
        v[1] = Math.min(v[1]!, v[2]!);
        v[0] = Math.min(v[0]!, v[1]!);
      } else {
        v[2] = Math.max(v[2]!, v[1]!);
        v[3] = Math.max(v[3]!, v[2]!);
      }
      props.onChange(v);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pct = (x: number) => `${x * 100}%`;
  const label = (a: number, b: number) => (Math.round(a * 255) === Math.round(b * 255) ? `${Math.round(a * 255)}` : `${Math.round(a * 255)} / ${Math.round(b * 255)}`);
  return (
    <div class="fx-col">
      <div class="fx-row fx-blendif-head">
        <span class="fx-label">{props.label}</span>
        <span class="dim mono">
          {label(props.value[0], props.value[1])} &nbsp; {label(props.value[2], props.value[3])}
        </span>
      </div>
      <div ref={track} class="fx-blendif" title="Drag to set; Alt-drag a handle to split it into a soft ramp">
        <For each={[0, 1] as const}>{(k) => <span class="fx-blendif-handle black" style={{ left: pct(props.value[k]) }} onPointerDown={(e) => drag('black', e)} />}</For>
        <For each={[2, 3] as const}>{(k) => <span class="fx-blendif-handle white" style={{ left: pct(props.value[k]) }} onPointerDown={(e) => drag('white', e)} />}</For>
      </div>
    </div>
  );
}

export function BlendingPage(props: { value: BlendingValue; set: Set<BlendingValue> }) {
  const v = () => props.value;
  const b = () => v().blending;
  const setB = (patch: Partial<AdvancedBlending>) => props.set({ blending: { ...b(), ...patch } });
  const range = (): BlendIfRange => b().blendIf[0] ?? { channel: 'gray', thisLayer: [0, 0, 1, 1], underlying: [0, 0, 1, 1] };
  const setRange = (patch: Partial<BlendIfRange>) => {
    const next = { ...range(), ...patch };
    const identity = next.thisLayer.join() === '0,0,1,1' && next.underlying.join() === '0,0,1,1';
    setB({ blendIf: identity ? [] : [next] });
  };
  return (
    <>
      <Group title="General Blending">
        <ModeRow mode={v().blendMode} onMode={(m) => props.set({ blendMode: m })} />
        <Slide label="Opacity" value={Math.round(v().opacity * 100)} min={0} max={100} suffix="%" onChange={(o) => props.set({ opacity: o / 100 })} />
      </Group>
      <Group title="Advanced Blending">
        <Slide label="Fill Opacity" value={Math.round(v().fill * 100)} min={0} max={100} suffix="%" onChange={(f) => props.set({ fill: f / 100 })} />
        <div class="fx-row">
          <span class="fx-label">Channels</span>
          <Checkbox checked={b().channels.r} label="R" onChange={(r) => setB({ channels: { ...b().channels, r } })} />
          <Checkbox checked={b().channels.g} label="G" onChange={(g) => setB({ channels: { ...b().channels, g } })} />
          <Checkbox checked={b().channels.b} label="B" onChange={(bb) => setB({ channels: { ...b().channels, b: bb } })} />
        </div>
        <Select
          value={b().knockout}
          label="Knockout"
          width={100}
          options={[
            { value: 'none', label: 'None' },
            { value: 'shallow', label: 'Shallow' },
            { value: 'deep', label: 'Deep' },
          ]}
          onChange={(k) => setB({ knockout: k })}
        />
        <Checkbox checked={b().blendClippedLayersAsGroup} label="Blend Clipped Layers as Group" onChange={(c) => setB({ blendClippedLayersAsGroup: c })} />
        <Checkbox checked={b().transparencyShapesLayer} label="Transparency Shapes Layer" onChange={(t) => setB({ transparencyShapesLayer: t })} />
      </Group>
      <Group title="Blend If">
        <Select
          value={range().channel}
          label="Blend If"
          width={90}
          options={[
            { value: 'gray', label: 'Gray' },
            { value: 'r', label: 'Red' },
            { value: 'g', label: 'Green' },
            { value: 'b', label: 'Blue' },
          ]}
          onChange={(c) => setRange({ channel: c })}
        />
        <BlendIfSlider label="This Layer:" value={range().thisLayer} onChange={(t) => setRange({ thisLayer: t })} />
        <BlendIfSlider label="Underlying Layer:" value={range().underlying} onChange={(u) => setRange({ underlying: u })} />
      </Group>
    </>
  );
}

export { NumberField };
