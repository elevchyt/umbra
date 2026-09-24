/**
 * The retouching tools' options bars — spec 04 §4.2's table, per tool: the brush picker and
 * size, then what the tool itself takes (Clone Stamp's Aligned and Sample, Dodge's Range and
 * Exposure, Colour Replacement's Mode, Sampling, Limits and Tolerance, …).
 */
import { Match, Show, Switch } from 'solid-js';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, IconButton, Select, Separator } from '@umbra/ui/widgets/controls';
import type { RetouchOptions } from '@umbra/engine';
import { store } from '../state/store';
import { BrushPicker } from './BrushesPanel';
import { PatternPicker } from '../adjust/fill';

const set = (patch: Partial<RetouchOptions>) => store.setRetouchOptions({ ...store.retouchOptions(), ...patch });
const pct = (v: number) => Math.round(v * 100);

function Opacity() {
  return (
    <>
      <NumberField label="Opacity" value={pct(store.brush.opacity)} min={1} max={100} suffix="%" width={38} onChange={(v) => store.setBrush('opacity', v / 100)} />
      <NumberField label="Flow" value={pct(store.brush.flow)} min={1} max={100} suffix="%" width={38} onChange={(v) => store.setBrush('flow', v / 100)} />
    </>
  );
}

function Sample() {
  return (
    <Select
      label="Sample"
      value={store.retouchOptions().sample}
      width={130}
      options={[
        { value: 'current', label: 'Current Layer' },
        { value: 'currentBelow', label: 'Current & Below' },
        { value: 'all', label: 'All Layers' },
      ]}
      onChange={(v) => set({ sample: v as RetouchOptions['sample'] })}
    />
  );
}

function Tolerance() {
  const o = () => store.retouchOptions();
  return (
    <>
      <Select
        label="Sampling"
        value={o().sampling}
        width={110}
        options={[
          { value: 'continuous', label: 'Continuous' },
          { value: 'once', label: 'Once' },
          { value: 'backgroundSwatch', label: 'Background Swatch' },
        ]}
        onChange={(v) => set({ sampling: v as RetouchOptions['sampling'] })}
      />
      <Select
        label="Limits"
        value={o().limits}
        width={100}
        options={[
          { value: 'discontiguous', label: 'Discontiguous' },
          { value: 'contiguous', label: 'Contiguous' },
          { value: 'findEdges', label: 'Find Edges' },
        ]}
        onChange={(v) => set({ limits: v as RetouchOptions['limits'] })}
      />
      <NumberField label="Tolerance" value={pct(o().tolerance)} min={0} max={100} suffix="%" width={38} onChange={(v) => set({ tolerance: v / 100 })} />
      <Checkbox checked={o().antiAlias} label="Anti-alias" onChange={(v) => set({ antiAlias: v })} />
    </>
  );
}

/** The retouching tools that take no brush: a click or a selection drag. */
const NO_BRUSH = new Set(['magicEraser', 'patch', 'contentAwareMove', 'redEye']);

export function RetouchToolOptions() {
  const o = () => store.retouchOptions();
  const tool = () => store.activeTool();
  return (
    <>
      <Show when={!NO_BRUSH.has(tool())}>
        <BrushPicker />
        <NumberField label="Size" value={store.brush.size} onChange={(v) => store.setBrush('size', v)} min={1} max={5000} suffix="px" width={44} />
        <Separator />
      </Show>
      <Switch>
        <Match when={tool() === 'cloneStamp' || tool() === 'healingBrush'}>
          <Show when={tool() === 'healingBrush'}>
            <Select label="Source" value={o().healSource} width={80} options={[{ value: 'sampled', label: 'Sampled' }, { value: 'pattern', label: 'Pattern' }]} onChange={(v) => set({ healSource: v as 'sampled' })} />
            <Show when={o().healSource === 'pattern'}>
              <PatternPicker selected={o().patternId} onPick={(p) => set({ patternId: p.id })} />
            </Show>
          </Show>
          <Show when={tool() === 'cloneStamp'}>
            <Opacity />
          </Show>
          <Checkbox checked={o().aligned} label="Aligned" onChange={(v) => set({ aligned: v })} />
          <Sample />
          <Show when={tool() === 'healingBrush'}>
            <NumberField label="Diffusion" value={o().diffusion} min={1} max={7} width={30} onChange={(v) => set({ diffusion: v })} />
          </Show>
          <IconButton icon="cloneStamp" title="Clone Source panel" onClick={() => store.openPanel('cloneSource')} />
          <span class="dim options-hint">{store.doc()?.cloneSource ? '' : 'Alt-click to set the source'}</span>
        </Match>
        <Match when={tool() === 'spotHealing'}>
          <Select
            label="Type"
            value={o().spotType}
            width={120}
            options={[
              { value: 'contentAware', label: 'Content-Aware' },
              { value: 'createTexture', label: 'Create Texture' },
              { value: 'proximityMatch', label: 'Proximity Match' },
            ]}
            onChange={(v) => set({ spotType: v as RetouchOptions['spotType'] })}
          />
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
        </Match>
        <Match when={tool() === 'removeTool'}>
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
          <span class="dim options-hint">Paint over what to remove; it is filled on release.</span>
        </Match>
        <Match when={tool() === 'patch'}>
          <Select label="Patch" value={o().patchMode} width={110} options={[{ value: 'normal', label: 'Normal' }, { value: 'contentAware', label: 'Content-Aware' }]} onChange={(v) => set({ patchMode: v as RetouchOptions['patchMode'] })} />
          <Select label="" value={o().patchDirection} width={100} options={[{ value: 'source', label: 'Source' }, { value: 'destination', label: 'Destination' }]} onChange={(v) => set({ patchDirection: v as RetouchOptions['patchDirection'] })} />
        </Match>
        <Match when={tool() === 'contentAwareMove'}>
          <Select label="Mode" value={o().moveMode} width={80} options={[{ value: 'move', label: 'Move' }, { value: 'extend', label: 'Extend' }]} onChange={(v) => set({ moveMode: v as RetouchOptions['moveMode'] })} />
        </Match>
        <Match when={tool() === 'redEye'}>
          <NumberField label="Pupil Size" value={pct(o().pupilSize)} min={1} max={100} suffix="%" width={38} onChange={(v) => set({ pupilSize: v / 100 })} />
          <NumberField label="Darken Amount" value={pct(o().darken)} min={1} max={100} suffix="%" width={38} onChange={(v) => set({ darken: v / 100 })} />
        </Match>
        <Match when={tool() === 'patternStamp'}>
          <Opacity />
          <PatternPicker selected={o().patternId} onPick={(p) => set({ patternId: p.id })} />
          <Checkbox checked={o().aligned} label="Aligned" onChange={(v) => set({ aligned: v })} />
          <Checkbox checked={o().impressionist} label="Impressionist" onChange={(v) => set({ impressionist: v })} />
        </Match>
        <Match when={tool() === 'historyBrush'}>
          <Opacity />
        </Match>
        <Match when={tool() === 'artHistoryBrush'}>
          <Opacity />
          <Select
            label="Style"
            value={o().artStyle}
            width={120}
            options={[
              { value: 'tightShort', label: 'Tight Short' },
              { value: 'tightMedium', label: 'Tight Medium' },
              { value: 'tightLong', label: 'Tight Long' },
              { value: 'looseMedium', label: 'Loose Medium' },
              { value: 'looseLong', label: 'Loose Long' },
              { value: 'dab', label: 'Dab' },
              { value: 'tightCurl', label: 'Tight Curl' },
              { value: 'tightCurlLong', label: 'Tight Curl Long' },
              { value: 'looseCurl', label: 'Loose Curl' },
              { value: 'looseCurlLong', label: 'Loose Curl Long' },
            ]}
            onChange={(v) => set({ artStyle: v as RetouchOptions['artStyle'] })}
          />
          <NumberField label="Area" value={o().area} min={0} max={500} suffix="px" width={40} onChange={(v) => set({ area: v })} />
        </Match>
        <Match when={tool() === 'colorReplacement'}>
          <Select
            label="Mode"
            value={o().replaceMode}
            width={90}
            options={[
              { value: 'hue', label: 'Hue' },
              { value: 'saturation', label: 'Saturation' },
              { value: 'color', label: 'Color' },
              { value: 'luminosity', label: 'Luminosity' },
            ]}
            onChange={(v) => set({ replaceMode: v as RetouchOptions['replaceMode'] })}
          />
          <Tolerance />
        </Match>
        <Match when={tool() === 'backgroundEraser'}>
          <Tolerance />
          <Checkbox checked={o().protectForeground} label="Protect Foreground Color" onChange={(v) => set({ protectForeground: v })} />
        </Match>
        <Match when={tool() === 'magicEraser'}>
          <NumberField label="Tolerance" value={pct(o().tolerance)} min={0} max={100} suffix="%" width={38} onChange={(v) => set({ tolerance: v / 100 })} />
          <Checkbox checked={o().antiAlias} label="Anti-alias" onChange={(v) => set({ antiAlias: v })} />
          <Checkbox checked={o().limits !== 'discontiguous'} label="Contiguous" onChange={(v) => set({ limits: v ? 'contiguous' : 'discontiguous' })} />
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
          <NumberField label="Opacity" value={pct(store.brush.opacity)} min={1} max={100} suffix="%" width={38} onChange={(v) => store.setBrush('opacity', v / 100)} />
        </Match>
        <Match when={tool() === 'dodgeTool' || tool() === 'burnTool'}>
          <Select
            label="Range"
            value={o().range}
            width={90}
            options={[
              { value: 'shadows', label: 'Shadows' },
              { value: 'midtones', label: 'Midtones' },
              { value: 'highlights', label: 'Highlights' },
            ]}
            onChange={(v) => set({ range: v as RetouchOptions['range'] })}
          />
          <NumberField label="Exposure" value={pct(o().exposure)} min={1} max={100} suffix="%" width={38} onChange={(v) => set({ exposure: v / 100 })} />
          <IconButton icon="blurTool" title="Airbrush (build up while held)" active={store.brush.airbrush} onClick={() => store.setBrush('airbrush', !store.brush.airbrush)} />
          <Checkbox checked={o().protectTones} label="Protect Tones" onChange={(v) => set({ protectTones: v })} />
        </Match>
        <Match when={tool() === 'spongeTool'}>
          <Select label="Mode" value={o().spongeMode} width={100} options={[{ value: 'desaturate', label: 'Desaturate' }, { value: 'saturate', label: 'Saturate' }]} onChange={(v) => set({ spongeMode: v as 'saturate' })} />
          <NumberField label="Flow" value={pct(store.brush.flow)} min={1} max={100} suffix="%" width={38} onChange={(v) => store.setBrush('flow', v / 100)} />
          <Checkbox checked={o().vibrance} label="Vibrance" onChange={(v) => set({ vibrance: v })} />
        </Match>
        <Match when={tool() === 'blurTool' || tool() === 'sharpenTool' || tool() === 'smudgeTool'}>
          <NumberField label="Strength" value={pct(o().strength)} min={1} max={100} suffix="%" width={38} onChange={(v) => set({ strength: v / 100 })} />
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
          <Show when={tool() === 'sharpenTool'}>
            <Checkbox checked={o().protectDetail} label="Protect Detail" onChange={(v) => set({ protectDetail: v })} />
          </Show>
          <Show when={tool() === 'smudgeTool'}>
            <Checkbox checked={o().fingerPainting} label="Finger Painting" onChange={(v) => set({ fingerPainting: v })} />
          </Show>
        </Match>
        <Match when={tool() === 'mixerBrush'}>
          <Checkbox checked={o().loadColor} label="Load" title="Load the brush with the foreground colour" onChange={(v) => set({ loadColor: v })} />
          <NumberField label="Wet" value={pct(o().wet)} min={0} max={100} suffix="%" width={38} onChange={(v) => set({ wet: v / 100 })} />
          <NumberField label="Load" value={pct(o().load)} min={1} max={100} suffix="%" width={38} onChange={(v) => set({ load: v / 100 })} />
          <NumberField label="Mix" value={pct(o().mix)} min={0} max={100} suffix="%" width={38} onChange={(v) => set({ mix: v / 100 })} />
          <NumberField label="Flow" value={pct(store.brush.flow)} min={1} max={100} suffix="%" width={38} onChange={(v) => store.setBrush('flow', v / 100)} />
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
        </Match>
      </Switch>
    </>
  );
}

/** Window ▸ Clone Source: five source slots and the transform the active one applies. */
/** Show Overlay: the source drawn over the canvas where it would clone to. */
function OverlayOptions() {
  const ov = () => store.cloneOverlay();
  const setOv = (patch: Partial<ReturnType<typeof ov>>) => store.setCloneOverlay({ ...ov(), ...patch });
  return (
    <div class="type-grid">
      <Checkbox checked={ov().show} label="Show Overlay" onChange={(v) => setOv({ show: v })} />
      <NumberField label="Opacity" value={Math.round(ov().opacity * 100)} min={1} max={100} suffix="%" width={38} onChange={(v) => setOv({ opacity: v / 100 })} />
      <Checkbox checked={ov().clipped} label="Clipped" onChange={(v) => setOv({ clipped: v })} />
      <Checkbox checked={ov().autoHide} label="Auto Hide" onChange={(v) => setOv({ autoHide: v })} />
      <Checkbox checked={ov().invert} label="Invert" onChange={(v) => setOv({ invert: v })} />
      <Select
        label=""
        value={ov().mode}
        width={90}
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'darken', label: 'Darken' },
          { value: 'lighten', label: 'Lighten' },
          { value: 'difference', label: 'Difference' },
        ]}
        onChange={(v) => setOv({ mode: v as 'normal' })}
      />
    </div>
  );
}

export function CloneSourcePanel() {
  const slot = () => store.cloneSlots()[store.cloneSlot()]!;
  const setSlot = (patch: Partial<ReturnType<typeof slot>>) => store.setCloneSlots(store.cloneSlots().map((s, i) => (i === store.cloneSlot() ? { ...s, ...patch } : s)));
  const send = (m: unknown) => store.engine?.(m as never);
  return (
    <div class="type-panel">
      <div class="type-row">
        {store.cloneSlots().map((s, i) => (
          <IconButton
            icon="cloneStamp"
            title={s.point ? `Source ${i + 1}: ${Math.round(s.point.x)}, ${Math.round(s.point.y)}` : `Source ${i + 1} (Alt-click with the Clone Stamp to set it)`}
            active={store.cloneSlot() === i}
            onClick={() => {
              store.setCloneSlot(i);
              if (s.point) send({ t: 'setCloneSource', x: s.point.x, y: s.point.y, doc: true });
            }}
          />
        ))}
      </div>
      <div class="type-grid">
        <span class="dim">Source</span>
        <span>{store.doc()?.cloneSource ? `${Math.round(store.doc()!.cloneSource!.x)}, ${Math.round(store.doc()!.cloneSource!.y)}` : 'not set'}</span>
        <span class="dim">Offset</span>
        <span>{store.doc()?.cloneOffset ? `${Math.round(store.doc()!.cloneOffset!.dx)}, ${Math.round(store.doc()!.cloneOffset!.dy)}` : '—'}</span>
        <NumberField label="W" value={slot().scaleX} min={1} max={1000} suffix="%" width={44} onChange={(v) => setSlot({ scaleX: v })} />
        <NumberField label="H" value={slot().scaleY} min={1} max={1000} suffix="%" width={44} onChange={(v) => setSlot({ scaleY: v })} />
        <NumberField label="Angle" value={slot().angle} min={-360} max={360} suffix="°" width={44} onChange={(v) => setSlot({ angle: v })} />
        <span class="type-field">
          <Checkbox checked={slot().flipX} label="Flip H" onChange={(v) => setSlot({ flipX: v })} />
          <Checkbox checked={slot().flipY} label="Flip V" onChange={(v) => setSlot({ flipY: v })} />
        </span>
      </div>
      <button type="button" class="dialog-button" onClick={() => setSlot({ scaleX: 100, scaleY: 100, angle: 0, flipX: false, flipY: false })}>
        Reset Transform
      </button>
      <OverlayOptions />
    </div>
  );
}
