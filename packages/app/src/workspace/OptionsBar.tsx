import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, Select, Separator, Spacer, IconButton } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { TOOL_BY_ID } from '../tools/registry';
import { FOREGROUND_TO_BACKGROUND, FOREGROUND_TO_TRANSPARENT, sampleGradient } from '@umbra/engine';
import { store } from '../state/store';
import { PathAlignOptions, ShapeToolOptions } from './ShapeOptions';
import { TypeToolOptions } from '../type/TypePanels';

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
      store.gradientOptions.preset === 'fgToTransparent'
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
        options={PRESETS}
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
      <button type="button" class="tool-preset-picker" title={`${tool()?.name ?? ''} — tool presets`}>
        <Icon name={tool()?.icon ?? 'brush'} size={18} />
        <Icon name="chevronDown" size={10} />
      </button>
      <Separator />

      <Switch fallback={<UnimplementedNote name={tool()?.name ?? 'Tool'} />}>
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
          <button type="button" class="brush-preview" title="Brush preset picker">
            <span
              class="brush-dot"
              style={{
                width: `${Math.min(22, Math.max(3, brush.size / 12))}px`,
                height: `${Math.min(22, Math.max(3, brush.size / 12))}px`,
              }}
            />
            <Icon name="chevronDown" size={10} />
          </button>
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
