/**
 * Tool presets — spec 01 §5 (Window ▸ Tool Presets) and the options bar's leftmost button: a
 * tool with its options saved under a name (the brush and its settings for painting tools, the
 * shape or type options for theirs), kept with the app. Choosing one switches to its tool and
 * restores the options. "Current Tool Only" filters the list, as in Photoshop.
 */
import { For, Show, createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { Icon } from '@umbra/ui/icons/Icon';
import { Checkbox } from '@umbra/ui/widgets/controls';
import { store } from '../state/store';
import { TOOL_BY_ID } from '../tools/registry';
import { FOREGROUND_TO_BACKGROUND, FOREGROUND_TO_TRANSPARENT, RETOUCH_TOOLS, type Gradient, type ToolPresetExport, type ToolPresetImport } from '@umbra/engine';

interface ToolPreset {
  id: string;
  name: string;
  tool: string;
  brush?: unknown;
  shape?: unknown;
  type?: unknown;
  /** From a .tpl: the retouching, selection and gradient options it sets. */
  retouch?: unknown;
  select?: unknown;
  gradient?: unknown;
}

const KEY = 'umbra.toolPresets';
const BUILTIN: ToolPreset[] = [
  { id: 'b1', name: 'Airbrush Soft Round 50% flow', tool: 'brush', brush: { size: 100, hardness: 0, spacing: 0.25, flow: 0.5, airbrush: true } },
  { id: 'b2', name: 'Hard Round 1 px', tool: 'pencil', brush: { size: 1, hardness: 1, spacing: 0.25 } },
  { id: 'b3', name: 'Soft Eraser 200 px', tool: 'eraser', brush: { size: 200, hardness: 0, spacing: 0.25 } },
];

function load(): ToolPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ToolPreset[]) : BUILTIN;
  } catch {
    return BUILTIN;
  }
}

const [presets, setPresets] = createSignal<ToolPreset[]>(load());
const save = (list: ToolPreset[]) => {
  setPresets(list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Kept for the session.
  }
};

function applyPreset(p: ToolPreset): void {
  store.setActiveTool(p.tool);
  if (p.brush) store.setBrush(reconcile({ ...JSON.parse(JSON.stringify(store.brush)), ...(p.brush as object) }));
  if (p.shape) store.setShapeOptions({ ...store.shapeOptions(), ...(p.shape as object) });
  if (p.type) store.setTypeOptions({ ...store.typeOptions(), ...(p.type as object) });
  if (p.retouch) store.setRetouchOptions({ ...store.retouchOptions(), ...(p.retouch as object) });
  if (p.select) store.setSelectOptions(p.select as never);
  if (p.gradient) {
    const g = p.gradient as ToolPresetImport['gradient'] & object;
    const { gradient, ...rest } = g;
    store.setGradientOptions({ ...rest, ...(gradient ? { preset: 'custom', custom: gradient, customName: p.name } : {}) } as never);
  }
}

/**
 * Load Tool Presets…: Photoshop's presets, as the engine mapped them. A preset for a tool Umbra
 * does not have is left out; a custom shape is found by its name in the shape library.
 */
export function addImportedPresets(list: readonly ToolPresetImport[]): number {
  const stamp = Date.now().toString(36);
  const added: ToolPreset[] = [];
  list.forEach((p, i) => {
    if (!p.tool) return;
    let shape = p.shape as (ToolPresetImport['shape'] & object) | undefined;
    if (shape?.customShapeName) {
      const { customShapeName, ...rest } = shape;
      const found = store.customShapes().find((c) => c.name === customShapeName);
      shape = found ? { ...rest, customShape: found.id } : rest;
    }
    added.push({
      id: `tpl-${stamp}-${i}`,
      name: p.name,
      tool: p.tool,
      ...(p.brush ? { brush: p.brush } : {}),
      ...(shape ? { shape } : {}),
      ...(p.type ? { type: p.type } : {}),
      ...(p.retouch ? { retouch: p.retouch } : {}),
      ...(p.select ? { select: p.select } : {}),
      ...(p.gradient ? { gradient: p.gradient } : {}),
    });
  });
  save([...presets(), ...added]);
  return added.length;
}

const SHAPE_TOOLS = ['rectangle', 'ellipse', 'triangle', 'polygon', 'line', 'customShape'];
const SELECT_TOOLS = ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeColumn', 'lasso', 'lassoPolygon', 'lassoMagnetic', 'magicWand', 'quickSelect'];

/** The gradient the Gradient tool would draw now: its preset from the colours, or its own. */
function currentGradient(): Gradient {
  const g = store.gradientOptions;
  const fg = store.foreground();
  const bg = store.background();
  if (g.preset === 'custom' && g.custom) return JSON.parse(JSON.stringify(g.custom)) as Gradient;
  if (g.preset === 'fgToTransparent') return FOREGROUND_TO_TRANSPARENT([fg.r, fg.g, fg.b]);
  if (g.preset === 'blackToWhite') return FOREGROUND_TO_BACKGROUND([0, 0, 0], [1, 1, 1]);
  return FOREGROUND_TO_BACKGROUND([fg.r, fg.g, fg.b], [bg.r, bg.g, bg.b]);
}

/** New Tool Preset: the current tool and whichever options it uses. */
function snapshot(): ToolPreset {
  const tool = store.activeTool();
  const p: ToolPreset = { id: `tp-${Date.now().toString(36)}`, name: `${TOOL_BY_ID.get(tool)?.name.replace(/ Tool$/, '') ?? tool} ${presets().length + 1}`, tool };
  if (SHAPE_TOOLS.includes(tool)) p.shape = store.shapeOptions();
  else if (tool.startsWith('type')) p.type = store.typeOptions();
  else if (SELECT_TOOLS.includes(tool)) p.select = { ...store.selectOptions };
  else if (tool === 'gradient') {
    const g = store.gradientOptions;
    p.gradient = { gradient: currentGradient(), style: g.style, mode: g.mode, opacity: g.opacity, reverse: g.reverse, dither: g.dither };
  } else {
    p.brush = JSON.parse(JSON.stringify(store.brush));
    if ((RETOUCH_TOOLS as readonly string[]).includes(tool)) p.retouch = { ...store.retouchOptions() };
    if (tool === 'paintBucket' || tool === 'magicEraser') p.select = { ...store.selectOptions };
  }
  return p;
}

/** A preset as the engine saves it: a custom shape by its name, as Photoshop refers to it. */
function toExport(p: ToolPreset): ToolPresetExport {
  let shape = p.shape as (ToolPresetExport['shape'] & object) | undefined;
  if (shape?.customShape) {
    const name = store.customShapes().find((c) => c.id === shape!.customShape)?.name;
    shape = { ...shape, ...(name ? { customShapeName: name } : {}) };
  }
  return JSON.parse(
    JSON.stringify({
      name: p.name,
      tool: p.tool,
      ...(p.brush ? { brush: p.brush } : {}),
      ...(shape ? { shape } : {}),
      ...(p.type ? { type: p.type } : {}),
      ...(p.retouch ? { retouch: p.retouch } : {}),
      ...(p.select ? { select: p.select } : {}),
      ...(p.gradient ? { gradient: p.gradient } : {}),
    }),
  ) as ToolPresetExport;
}

export function ToolPresetList(props: { onPick?: () => void }) {
  const [currentOnly, setCurrentOnly] = createSignal(true);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const shown = () => presets().filter((p) => !currentOnly() || p.tool === store.activeTool());
  return (
    <div class="tool-presets">
      <div class="paths-list">
        <For each={shown()} fallback={<div class="dim adjustments-note">No presets for this tool. ＋ saves the current settings.</div>}>
          {(p) => (
            <div class="path-row" onClick={() => {
              applyPreset(p);
              props.onPick?.();
            }} onDblClick={() => setRenaming(p.id)}>
              <Icon name={(TOOL_BY_ID.get(p.tool)?.icon ?? 'brush') as never} size={15} />
              <Show when={renaming() === p.id} fallback={<span class="path-name">{p.name}</span>}>
                <input class="styles-name" value={p.name} ref={(el) => queueMicrotask(() => el.select())} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                }} onBlur={(e) => {
                  const name = e.currentTarget.value.trim();
                  setRenaming(null);
                  if (name) save(presets().map((q) => (q.id === p.id ? { ...q, name } : q)));
                }} />
              </Show>
              <button type="button" class="mini-icon tool-preset-del" title="Delete preset" onClick={(e) => {
                e.stopPropagation();
                save(presets().filter((q) => q.id !== p.id));
              }}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          )}
        </For>
      </div>
      <div class="panel-footer">
        <Checkbox checked={currentOnly()} label="Current Tool Only" onChange={setCurrentOnly} />
        <button
          type="button"
          class="mini-icon"
          title="Save Tool Presets… (.tpl, every preset in the list)"
          disabled={!presets().length}
          onClick={() => store.engine?.({ t: 'exportTpl', presets: presets().map(toExport), name: 'Tool Presets.tpl' } as never)}
        >
          <Icon name="newDocument" size={15} />
        </button>
        <label class="mini-icon" title="Load Tool Presets… (.tpl)">
          <Icon name="folder" size={15} />
          <input
            type="file"
            accept=".tpl"
            multiple
            hidden
            onChange={async (e) => {
              // currentTarget is gone once the handler awaits.
              const input = e.currentTarget;
              for (const f of [...(input.files ?? [])]) store.engine?.({ t: 'importTpl', bytes: new Uint8Array(await f.arrayBuffer()), name: f.name } as never);
              input.value = '';
            }}
          />
        </label>
        <button type="button" class="mini-icon" title="Create a new tool preset from the current tool" onClick={() => save([...presets(), snapshot()])}>
          <Icon name="plus" size={15} />
        </button>
      </div>
    </div>
  );
}

export function ToolPresetsPanel() {
  return <ToolPresetList />;
}

/** The options bar's leftmost button: the tool's icon and its presets. */
export function ToolPresetPicker(props: { icon: string; title: string }) {
  const [open, setOpen] = createSignal<{ top: number; left: number } | null>(null);
  return (
    <>
      <button type="button" class="tool-preset-picker" title={props.title} onClick={(e) => {
        if (open()) return setOpen(null);
        const r = e.currentTarget.getBoundingClientRect();
        setOpen({ top: r.bottom + 2, left: r.left });
      }}>
        <Icon name={props.icon as never} size={18} />
        <Icon name="chevronDown" size={10} />
      </button>
      <Show when={open()}>
        {(pos) => (
          <div class="brush-picker-pop tool-preset-pop" style={{ top: `${pos().top}px`, left: `${pos().left}px` }} onPointerLeave={() => setOpen(null)}>
            <ToolPresetList onPick={() => setOpen(null)} />
          </div>
        )}
      </Show>
    </>
  );
}
