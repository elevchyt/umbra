import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, Select, Separator, Spacer, IconButton } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { TOOL_BY_ID, PAINT_TOOLS } from '../tools/registry';
import { beginSymmetryEdit, endSymmetryEdit, moveSymmetryRefTo, setSymmetryRef, symmetryAboutRef, symmetryRef } from './SymmetryGuide';
import { FOREGROUND_TO_BACKGROUND, FOREGROUND_TO_TRANSPARENT, sampleGradient, DEFAULT_SYMMETRY, RETOUCH_TOOLS, IDENTITY_SYMMETRY_TRANSFORM, type SymmetryMode, type Symmetry, type SymmetryTransform } from '@umbra/engine';
import { store } from '../state/store';
import { PathAlignOptions, ShapeToolOptions } from './ShapeOptions';
import { TypeToolOptions } from '../type/TypePanels';
import { BrushPicker } from '../brush/BrushesPanel';
import { ToolPresetPicker } from '../brush/ToolPresets';
import { RetouchToolOptions } from '../brush/RetouchOptions';

/**
 * Options bar — spec 01 §1. Contents are contextual on the active tool, and the leftmost slot
 * is always the tool preset picker, as in Photoshop.
 *
 * Only tools that actually do something get real controls; the rest show their preset picker
 * and a plain statement that the tool is not wired up, which is more useful than a row of
 * dead widgets.
 */

export interface OptionsBarProps {
  onCommand: (cmd: string) => void;
}

/** The four combine modes, shared by every selection tool. */
function SelectionOps() {
  const sel = store.selectOptions;
  return (
    <div class="segmented">
      <For
        each={
          [
            { op: 'new', icon: 'marqueeRect', title: 'New selection' },
            { op: 'add', icon: 'plus', title: 'Add to selection (Shift)' },
            { op: 'subtract', icon: 'minus', title: 'Subtract from selection (Alt)' },
            { op: 'intersect', icon: 'grid', title: 'Intersect with selection (Shift+Alt)' },
          ] as const
        }
      >
        {(o) => (
          <IconButton
            icon={o.icon}
            title={o.title}
            active={sel.op === o.op}
            onClick={() => store.setSelectOptions('op', o.op)}
          />
        )}
      </For>
    </div>
  );
}

/** Tools that share the brush options row. */
const PAINT_OPTION_TOOLS = new Set(['brush', 'pencil', 'eraser']);

/**
 * The paint modes. Behind and Clear exist only for painting — they act on alpha rather than
 * on colour, so they are not in the layer blend menu.
 */
const paintModeOptions = [
  ...BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({
    value: m as string,
    label: BLEND_LABEL[m as BlendMode],
  })),
  { value: 'behind', label: 'Behind' },
  { value: 'clear', label: 'Clear' },
];

/**
 * The gradient's ramp, drawn from the live stops. It doubles as the editor's button; the
 * editor dialog itself arrives with the preset manager.
 */
function GradientPreview() {
  const css = () => {
    const fg = store.foreground();
    const bg = store.background();
    const g =
      store.gradientOptions.preset === 'custom' && store.gradientOptions.custom
        ? store.gradientOptions.custom
        : store.gradientOptions.preset === 'fgToTransparent'
        ? FOREGROUND_TO_TRANSPARENT([fg.r, fg.g, fg.b])
        : store.gradientOptions.preset === 'blackToWhite'
          ? FOREGROUND_TO_BACKGROUND([0, 0, 0], [1, 1, 1])
          : FOREGROUND_TO_BACKGROUND([fg.r, fg.g, fg.b], [bg.r, bg.g, bg.b]);
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const [r, gg, b, a] = sampleGradient(g, t);
      return `rgba(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)},${a}) ${t * 100}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  };

  const PRESETS = [
    { value: 'fgToBg', label: 'Foreground to Background' },
    { value: 'fgToTransparent', label: 'Foreground to Transparent' },
    { value: 'blackToWhite', label: 'Black, White' },
  ];

  return (
    <>
      <span class="gradient-preview" style={{ background: css() }} title="Gradient preset" />
      <Select
        value={store.gradientOptions.preset}
        options={store.gradientOptions.custom ? [...PRESETS, { value: 'custom', label: store.gradientOptions.customName || 'Custom' }] : PRESETS}
        onChange={(v) => store.setGradientOptions('preset', v as never)}
        width={172}
      />
    </>
  );
}

export function OptionsBar(props: OptionsBarProps) {
  const tool = () => TOOL_BY_ID.get(store.activeTool());
  const [mode, setMode] = createSignal<BlendMode>('normal');
  const [autoSelect, setAutoSelect] = createSignal(false);
  const [showTransform, setShowTransform] = createSignal(false);
  const sel = store.selectOptions;

  const brush = store.brush;

  return (
    <div class="options-bar">
      <ToolPresetPicker icon={tool()?.icon ?? 'brush'} title={`${tool()?.name ?? ''} — tool presets`} />
      <Separator />

      <Switch fallback={<UnimplementedNote name={tool()?.name ?? 'Tool'} />}>
        <Match when={store.symmetryEdit() && PAINT_TOOLS.has(store.activeTool()) && brush.symmetry}>
          <SymmetryTransformBar />
        </Match>
        <Match when={store.activeTool() === 'cafSampling' && store.caf()}>
          <span class="options-hint">Sampling Brush</span>
          <Select
            value={store.caf()!.subtract ? 'subtract' : 'add'}
            width={150}
            options={[
              { value: 'add', label: 'Add to Sampling Area' },
              { value: 'subtract', label: 'Subtract from Sampling Area' },
            ]}
            onChange={(v) => store.setCaf({ ...store.caf()!, subtract: v === 'subtract' })}
          />
          <NumberField label="Size" value={store.caf()!.brushSize} min={1} max={2000} suffix="px" width={44} onChange={(v) => store.setCaf({ ...store.caf()!, brushSize: v })} />
          <span class="dim options-hint">Alt paints the other way. Enter: OK · Esc: Cancel</span>
        </Match>
        {/* A live transform takes the whole row — except during a crop, which has its own
            row and its own commit, and shares only the box on screen. */}
        <Match when={store.activeTool() !== 'crop' && store.stats()?.transform}>
          {(t) => (
            <>
              <NumberField label="X" value={Math.round(t().x)} onChange={() => {}} suffix="px" width={52} disabled />
              <NumberField label="Y" value={Math.round(t().y)} onChange={() => {}} suffix="px" width={52} disabled />
              <Separator />
              <NumberField label="W" value={Math.round(t().scaleX * 100)} onChange={() => {}} suffix="%" width={46} disabled />
              <NumberField label="H" value={Math.round(t().scaleY * 100)} onChange={() => {}} suffix="%" width={46} disabled />
              <Separator />
              <NumberField label="Angle" value={Math.round(t().rotation)} onChange={() => {}} suffix="°" width={46} disabled />
              <Spacer />
              {/* Photoshop's ✗ / ✓; the keyboard equivalents are Escape and Enter. */}
              <IconButton icon="close" title="Cancel transform (Esc)" onClick={() => props.onCommand('transform.cancel')} />
              <IconButton icon="check" title="Commit transform (Enter)" onClick={() => props.onCommand('transform.commit')} />
            </>
          )}
        </Match>
        <Match when={store.activeTool() === 'move'}>
          <Checkbox checked={autoSelect()} onChange={setAutoSelect} label="Auto-Select" />
          <Select
            value="layer"
            options={[
              { value: 'layer', label: 'Layer' },
              { value: 'group', label: 'Group' },
            ]}
            onChange={() => {}}
            width={68}
          />
          <Checkbox checked={showTransform()} onChange={setShowTransform} label="Show Transform Controls" />
          <Separator />
          <span class="dim">Align:</span>
          <IconButton icon="filterRows" title="Align left edges" disabled />
        </Match>

        <Match when={PAINT_OPTION_TOOLS.has(store.activeTool())}>
          <BrushPicker />
          <NumberField label="Size" value={brush.size} onChange={(v) => store.setBrush('size', v)} min={1} max={5000} suffix="px" width={44} />
          <NumberField label="Hardness" value={Math.round(brush.hardness * 100)} onChange={(v) => store.setBrush('hardness', v / 100)} min={0} max={100} suffix="%" width={38} />
          <Separator />
          <Select label="Mode" value={brush.mode} options={paintModeOptions} onChange={(v) => store.setBrush('mode', v)} width={110} />
          <NumberField label="Opacity" value={Math.round(brush.opacity * 100)} onChange={(v) => store.setBrush('opacity', v / 100)} min={1} max={100} suffix="%" width={38} />
          <NumberField label="Flow" value={Math.round(brush.flow * 100)} onChange={(v) => store.setBrush('flow', v / 100)} min={1} max={100} suffix="%" width={38} />
          <IconButton
            icon="blurTool"
            title="Enable airbrush-style build-up effects"
            active={brush.airbrush}
            onClick={() => store.setBrush('airbrush', !brush.airbrush)}
          />
          <Separator />
          <NumberField label="Smoothing" value={Math.round(brush.smoothing * 100)} onChange={(v) => store.setBrush('smoothing', v / 100)} min={0} max={95} suffix="%" width={38} />
          <Separator />
          <NumberField label="Angle" value={brush.angle} onChange={(v) => store.setBrush('angle', v)} min={-180} max={180} suffix="°" width={38} />
          <NumberField label="Roundness" value={Math.round(brush.roundness * 100)} onChange={(v) => store.setBrush('roundness', v / 100)} min={1} max={100} suffix="%" width={38} />
          <Separator />
          <IconButton
            icon="pen"
            title="Always use Pressure for Size"
            active={brush.pressureSize}
            onClick={() => store.setBrush('pressureSize', !brush.pressureSize)}
          />
          <IconButton
            icon="brush"
            title="Always use Pressure for Opacity"
            active={brush.pressureOpacity}
            onClick={() => store.setBrush('pressureOpacity', !brush.pressureOpacity)}
          />
          <Separator />
          <Select
            label="Symmetry"
            value={brush.symmetry?.mode ?? 'off'}
            width={110}
            title="Paint symmetry about the canvas centre (Path: across the path selected in the Paths panel)"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'dualAxis', label: 'Dual Axis' },
              { value: 'diagonal', label: 'Diagonal' },
              { value: 'wavy', label: 'Wavy' },
              { value: 'circle', label: 'Circle' },
              { value: 'spiral', label: 'Spiral' },
              { value: 'parallelLines', label: 'Parallel Lines' },
              { value: 'radial', label: 'Radial' },
              { value: 'mandala', label: 'Mandala' },
              { value: 'path', label: 'Selected Path' },
            ]}
            onChange={(mode) => {
              const d = store.doc();
              const cur = brush.symmetry ?? DEFAULT_SYMMETRY;
              // A figure a quarter of the canvas's shorter side, unless one was already set.
              const size = cur.size ?? Math.max(16, Math.round(Math.min(d?.width ?? 400, d?.height ?? 400) / 4));
              const { path: _path, ...rest } = cur;
              store.setBrush('symmetry', { ...DEFAULT_SYMMETRY, ...rest, size, mode: mode as SymmetryMode, cx: (d?.width ?? 0) / 2, cy: (d?.height ?? 0) / 2 });
              // As in Photoshop, a new symmetry arrives with its transform box open.
              if (mode === 'off' || mode === 'path') store.setSymmetryEdit(null);
              else beginSymmetryEdit();
            }}
          />
          <Show when={brush.symmetry && brush.symmetry.mode !== 'off' && brush.symmetry.mode !== 'path'}>
            <IconButton icon="arrange" title="Transform the symmetry path (its box: scale, skew, turn, move)" active={!!store.symmetryEdit()} onClick={() => (store.symmetryEdit() ? endSymmetryEdit(true) : beginSymmetryEdit())} />
          </Show>
          <Show when={brush.symmetry?.mode === 'radial' || brush.symmetry?.mode === 'mandala'}>
            <NumberField label="Segments" value={brush.symmetry!.segments} min={2} max={12} width={32} onChange={(v) => store.setBrush('symmetry', { ...brush.symmetry!, segments: v })} />
          </Show>
          <Show when={['wavy', 'circle', 'spiral', 'parallelLines'].includes(brush.symmetry?.mode ?? '')}>
            <NumberField label="Size" value={brush.symmetry!.size ?? 100} min={4} max={10000} suffix="px" width={44} onChange={(v) => store.setBrush('symmetry', { ...brush.symmetry!, size: v })} />
          </Show>
          <Show when={brush.symmetry && !['off', 'path', 'circle'].includes(brush.symmetry.mode)}>
            <NumberField label="Angle" value={brush.symmetry!.angle} min={-180} max={180} suffix="°" width={36} onChange={(v) => store.setBrush('symmetry', { ...brush.symmetry!, angle: v })} />
          </Show>
          <IconButton icon="gear" title="Brush Settings (F5)" onClick={() => store.openPanel('brushSettings')} />
        </Match>

        <Match when={store.activeTool().startsWith('marquee') || store.activeTool().startsWith('lasso')}>
          <SelectionOps />
          <Separator />
          <NumberField
            label="Feather"
            value={sel.feather}
            onChange={(v) => store.setSelectOptions('feather', v)}
            min={0}
            max={1000}
            suffix="px"
            width={40}
          />
          <Checkbox
            checked={sel.antialias}
            onChange={(v) => store.setSelectOptions('antialias', v)}
            label="Anti-alias"
            disabled={store.activeTool() === 'marqueeRect'}
          />
          <Separator />
          <button type="button" class="button" disabled>
            Select and Mask…
          </button>
        </Match>

        <Match when={store.activeTool() === 'crop'}>
          <span class="dim">Drag on the canvas to set the crop, then Enter to apply.</span>
          <Separator />
          <Checkbox
            checked={store.cropDeletes()}
            onChange={(v) => {
              store.setCropDeletes(v);
              props.onCommand('crop.syncDeletes');
            }}
            label="Delete Cropped Pixels"
          />
          <Spacer />
          <IconButton icon="close" title="Cancel crop (Esc)" onClick={() => props.onCommand('transform.cancel')} />
          <IconButton icon="check" title="Commit crop (Enter)" onClick={() => props.onCommand('transform.commit')} />
        </Match>

        <Match when={store.activeTool() === 'gradient'}>
          <GradientPreview />
          <Separator />
          <div class="segmented">
            <For
              each={
                [
                  { style: 'linear', icon: 'gradient', title: 'Linear Gradient' },
                  { style: 'radial', icon: 'ellipse', title: 'Radial Gradient' },
                  { style: 'angle', icon: 'rotateView', title: 'Angle Gradient' },
                  { style: 'reflected', icon: 'filterRows', title: 'Reflected Gradient' },
                  { style: 'diamond', icon: 'polygon', title: 'Diamond Gradient' },
                ] as const
              }
            >
              {(o) => (
                <IconButton
                  icon={o.icon}
                  title={o.title}
                  active={store.gradientOptions.style === o.style}
                  onClick={() => store.setGradientOptions('style', o.style)}
                />
              )}
            </For>
          </div>
          <Separator />
          <Select
            label="Mode"
            value={store.gradientOptions.mode}
            options={paintModeOptions.filter((o) => o.value !== 'behind' && o.value !== 'clear')}
            onChange={(v) => store.setGradientOptions('mode', v)}
            width={110}
          />
          <NumberField
            label="Opacity"
            value={Math.round(store.gradientOptions.opacity * 100)}
            onChange={(v) => store.setGradientOptions('opacity', v / 100)}
            min={1}
            max={100}
            suffix="%"
            width={38}
          />
          <Separator />
          <Checkbox
            checked={store.gradientOptions.reverse}
            onChange={(v) => store.setGradientOptions('reverse', v)}
            label="Reverse"
          />
          <Checkbox
            checked={store.gradientOptions.dither}
            onChange={(v) => store.setGradientOptions('dither', v)}
            label="Dither"
          />
        </Match>

        <Match when={store.activeTool() === 'paintBucket'}>
          <Select
            label="Fill"
            value="foreground"
            options={[{ value: 'foreground', label: 'Foreground' }]}
            onChange={() => {}}
            width={110}
          />
          <Separator />
          <Select
            label="Mode"
            value={brush.mode}
            options={paintModeOptions.filter((o) => o.value !== 'behind' && o.value !== 'clear')}
            onChange={(v) => store.setBrush('mode', v)}
            width={110}
          />
          <NumberField
            label="Opacity"
            value={Math.round(brush.opacity * 100)}
            onChange={(v) => store.setBrush('opacity', v / 100)}
            min={1}
            max={100}
            suffix="%"
            width={38}
          />
          <Separator />
          <NumberField
            label="Tolerance"
            value={sel.tolerance}
            onChange={(v) => store.setSelectOptions('tolerance', v)}
            min={0}
            max={255}
            width={40}
          />
          <Checkbox
            checked={sel.antialias}
            onChange={(v) => store.setSelectOptions('antialias', v)}
            label="Anti-alias"
          />
          <Checkbox
            checked={sel.contiguous}
            onChange={(v) => store.setSelectOptions('contiguous', v)}
            label="Contiguous"
          />
        </Match>

        <Match when={['pen', 'freeformPen', 'curvaturePen', 'pathSelect', 'directSelect', 'addAnchor', 'deleteAnchor', 'convertPoint'].includes(store.activeTool())}>
          <span class="options-label">Path</span>
          <Separator />
          <Select
            label="Operation"
            value={store.vectorOptions().op}
            width={140}
            options={[
              { value: 'add', label: 'Combine Shapes' },
              { value: 'subtract', label: 'Subtract Front Shape' },
              { value: 'intersect', label: 'Intersect Shape Areas' },
              { value: 'exclude', label: 'Exclude Overlapping' },
            ]}
            onChange={(op) => store.setVectorOptions({ ...store.vectorOptions(), op: op as 'add' })}
          />
          <Show when={store.activeTool() === 'pen'}>
            <Checkbox checked={store.vectorOptions().autoAddDelete} label="Auto Add/Delete" onChange={(v) => store.setVectorOptions({ ...store.vectorOptions(), autoAddDelete: v })} />
          </Show>
          <Show when={store.activeTool() === 'freeformPen'}>
            <NumberField label="Curve Fit" value={store.vectorOptions().curveFit} min={0.5} max={10} step={0.5} precision={1} suffix="px" width={48} onChange={(v) => store.setVectorOptions({ ...store.vectorOptions(), curveFit: v })} />
          </Show>
          <Show when={store.activeTool() === 'pathSelect'}>
            <PathAlignOptions />
          </Show>
          <Separator />
          <span class="options-label">Make:</span>
          <IconButton icon="marqueeRect" title="Make Selection from the path" onClick={() => store.engine?.({ t: 'pathCommand', cmd: 'toSelection', op: 'new' } as never)} />
          <IconButton icon="pen" title="Make a Work Path from the selection" onClick={() => store.engine?.({ t: 'pathCommand', cmd: 'fromSelection', tolerance: 2 } as never)} />
        </Match>

        <Match when={[...RETOUCH_TOOLS, 'magicEraser', 'patch', 'contentAwareMove', 'redEye'].includes(store.activeTool() as never)}>
          <RetouchToolOptions />
        </Match>

        <Match when={['typeHorizontal', 'typeVertical', 'typeMaskHorizontal', 'typeMaskVertical'].includes(store.activeTool())}>
          <TypeToolOptions />
        </Match>

        <Match when={['rectangle', 'ellipse', 'triangle', 'polygon', 'line', 'customShape'].includes(store.activeTool())}>
          <ShapeToolOptions />
        </Match>

        <Match when={store.activeTool() === 'magicWand'}>
          <SelectionOps />
          <Separator />
          {/* Sample Size arrives with the wand's averaged seed; a dead menu is worse than none. */}
          <NumberField
            label="Tolerance"
            value={sel.tolerance}
            onChange={(v) => store.setSelectOptions('tolerance', v)}
            min={0}
            max={255}
            width={40}
          />
          <Checkbox
            checked={sel.antialias}
            onChange={(v) => store.setSelectOptions('antialias', v)}
            label="Anti-alias"
          />
          <Checkbox
            checked={sel.contiguous}
            onChange={(v) => store.setSelectOptions('contiguous', v)}
            label="Contiguous"
          />
        </Match>

        <Match when={store.activeTool() === 'eyedropper'}>
          <Select
            label="Sample Size"
            value={String(store.sampleSize())}
            options={[
              { value: '1', label: 'Point Sample' },
              { value: '3', label: '3 by 3 Average' },
              { value: '5', label: '5 by 5 Average' },
              { value: '11', label: '11 by 11 Average' },
              { value: '31', label: '31 by 31 Average' },
              { value: '51', label: '51 by 51 Average' },
              { value: '101', label: '101 by 101 Average' },
            ]}
            onChange={(v) => store.setSampleSize(Number(v))}
            width={132}
          />
          <Select
            label="Sample"
            value="all"
            options={[
              { value: 'all', label: 'All Layers' },
              { value: 'current', label: 'Current Layer' },
            ]}
            onChange={() => {}}
            width={112}
          />
        </Match>

        <Match when={store.activeTool() === 'zoom'}>
          <div class="segmented">
            <IconButton icon="zoom" title="Zoom in" active />
            <IconButton icon="minus" title="Zoom out" />
          </div>
          <Separator />
          <Checkbox checked onChange={() => {}} label="Scrubby Zoom" />
          <button type="button" class="button" onClick={() => props.onCommand('view.fit')}>
            Fit Screen
          </button>
          <button type="button" class="button" onClick={() => props.onCommand('view.actual')}>
            100%
          </button>
        </Match>

        <Match when={store.activeTool() === 'hand'}>
          <Checkbox checked={false} onChange={() => {}} label="Scroll All Windows" />
          <button type="button" class="button" onClick={() => props.onCommand('view.fit')}>
            Fit Screen
          </button>
          <button type="button" class="button" onClick={() => props.onCommand('view.actual')}>
            100%
          </button>
        </Match>
      </Switch>

      <Spacer />
      <button type="button" class="icon-button" title="Search (Ctrl+F)" onClick={() => props.onCommand('edit.search')}>
        <Icon name="search" size={15} />
      </button>
      <button type="button" class="icon-button" title="Choose a workspace" onClick={() => props.onCommand('workspace.menu')}>
        <Icon name="grid" size={15} />
        <Icon name="chevronDown" size={10} />
      </button>
    </div>
  );
}

function UnimplementedNote(props: { name: string }) {
  return (
    <span class="dim options-note">
      {props.name} — options arrive with the tool itself.
    </span>
  );
}

/**
 * The symmetry path's transform, as Free Transform's options bar: centre, width and height,
 * angle and skew — with commit and cancel (Enter and Esc do the same).
 */
function SymmetryTransformBar() {
  const s = () => store.brush.symmetry!;
  const t = () => ({ ...IDENTITY_SYMMETRY_TRANSFORM, ...(s().transform ?? {}) });
  // Every field works about the reference point, as Free Transform's do.
  const about = (patch: { transform?: Partial<SymmetryTransform>; angle?: number }) => store.setBrush('symmetry', symmetryAboutRef(s(), patch));
  const ref = () => symmetryRef() ?? { x: s().cx, y: s().cy };
  const current = () => store.symmetryEdit()?.ref ?? { u: 0, v: 0 };
  return (
    <>
      <span class="options-hint">Symmetry path</span>
      <span class="sym-locator" title="Reference point: what the box scales, skews and turns about">
        <For each={[-1, 0, 1].flatMap((v) => [-1, 0, 1].map((u) => [u, v] as const))}>
          {([u, v]) => <button type="button" classList={{ on: current().u === u && current().v === v }} onClick={() => setSymmetryRef(u, v)} />}
        </For>
      </span>
      <NumberField label="X" value={Math.round(ref().x * 10) / 10} suffix="px" width={48} onChange={(v) => moveSymmetryRefTo(v, ref().y)} />
      <NumberField label="Y" value={Math.round(ref().y * 10) / 10} suffix="px" width={48} onChange={(v) => moveSymmetryRefTo(ref().x, v)} />
      <NumberField label="W" value={Math.round(t().scaleX * 1000) / 10} min={-1000} max={1000} suffix="%" width={44} onChange={(v) => about({ transform: { scaleX: v / 100 || 0.05 } })} />
      <NumberField label="H" value={Math.round(t().scaleY * 1000) / 10} min={-1000} max={1000} suffix="%" width={44} onChange={(v) => about({ transform: { scaleY: v / 100 || 0.05 } })} />
      <NumberField label="∠" value={s().angle} min={-180} max={180} suffix="°" width={40} onChange={(v) => about({ angle: v })} />
      <NumberField label="H" value={t().skew} min={-80} max={80} suffix="°" width={36} title="Horizontal skew" onChange={(v) => about({ transform: { skew: v } })} />
      <NumberField label="V" value={t().skewY ?? 0} min={-80} max={80} suffix="°" width={36} title="Vertical skew" onChange={(v) => about({ transform: { skewY: v } })} />
      <Show when={s().size !== undefined}>
        <NumberField label="Size" value={s().size!} min={4} max={10000} suffix="px" width={44} onChange={(v) => store.setBrush('symmetry', { ...s(), size: v })} />
      </Show>
      <Separator />
      <IconButton icon="close" title="Cancel the transform (Esc)" onClick={() => endSymmetryEdit(false)} />
      <IconButton icon="check" title="Commit the transform (Enter)" onClick={() => endSymmetryEdit(true)} />
    </>
  );
}
