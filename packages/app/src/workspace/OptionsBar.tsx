import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, Select, Separator, Spacer, IconButton } from '@umbra/ui/widgets/controls';
import { BLEND_MENU, BLEND_LABEL, type BlendMode } from '@umbra/core/blend';
import { TOOL_BY_ID } from '../tools/registry';
import { store } from '../state/store';

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
  brushSize: number;
  setBrushSize: (v: number) => void;
  brushHardness: number;
  setBrushHardness: (v: number) => void;
  brushOpacity: number;
  setBrushOpacity: (v: number) => void;
  brushFlow: number;
  setBrushFlow: (v: number) => void;
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

export function OptionsBar(props: OptionsBarProps) {
  const tool = () => TOOL_BY_ID.get(store.activeTool());
  const [mode, setMode] = createSignal<BlendMode>('normal');
  const [autoSelect, setAutoSelect] = createSignal(false);
  const [showTransform, setShowTransform] = createSignal(false);
  const [sampleSize, setSampleSize] = createSignal('point');
  const sel = store.selectOptions;

  const blendOptions = BLEND_MENU.filter((m) => m !== '-' && m !== 'passThrough').map((m) => ({
    value: m as BlendMode,
    label: BLEND_LABEL[m as BlendMode],
  }));

  return (
    <div class="options-bar">
      <button type="button" class="tool-preset-picker" title={`${tool()?.name ?? ''} — tool presets`}>
        <Icon name={tool()?.icon ?? 'brush'} size={18} />
        <Icon name="chevronDown" size={10} />
      </button>
      <Separator />

      <Switch fallback={<UnimplementedNote name={tool()?.name ?? 'Tool'} />}>
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

        <Match when={store.activeTool() === 'brush' || store.activeTool() === 'pencil'}>
          <button type="button" class="brush-preview" title="Brush preset picker">
            <span class="brush-dot" style={{ width: `${Math.min(22, Math.max(3, props.brushSize / 12))}px`, height: `${Math.min(22, Math.max(3, props.brushSize / 12))}px` }} />
            <Icon name="chevronDown" size={10} />
          </button>
          <NumberField label="Size" value={props.brushSize} onChange={props.setBrushSize} min={1} max={5000} suffix="px" width={44} />
          <NumberField label="Hardness" value={Math.round(props.brushHardness * 100)} onChange={(v) => props.setBrushHardness(v / 100)} min={0} max={100} suffix="%" width={38} />
          <Separator />
          <Select label="Mode" value={mode()} options={blendOptions} onChange={setMode} width={110} />
          <NumberField label="Opacity" value={props.brushOpacity} onChange={props.setBrushOpacity} min={1} max={100} suffix="%" width={38} />
          <NumberField label="Flow" value={props.brushFlow} onChange={props.setBrushFlow} min={1} max={100} suffix="%" width={38} />
          <IconButton icon="blurTool" title="Enable airbrush-style build-up effects" />
          <Separator />
          <NumberField label="Smoothing" value={10} onChange={() => {}} min={0} max={100} suffix="%" width={38} />
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

        <Match when={store.activeTool() === 'magicWand'}>
          <SelectionOps />
          <Separator />
          <Select
            label="Sample Size"
            value={sampleSize()}
            options={[
              { value: 'point', label: 'Point Sample' },
              { value: '3', label: '3 by 3 Average' },
              { value: '5', label: '5 by 5 Average' },
            ]}
            onChange={setSampleSize}
            width={132}
          />
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
            value={sampleSize()}
            options={[
              { value: 'point', label: 'Point Sample' },
              { value: '3', label: '3 by 3 Average' },
              { value: '5', label: '5 by 5 Average' },
              { value: '11', label: '11 by 11 Average' },
              { value: '31', label: '31 by 31 Average' },
              { value: '51', label: '51 by 51 Average' },
              { value: '101', label: '101 by 101 Average' },
            ]}
            onChange={setSampleSize}
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
