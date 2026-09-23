/**
 * The shape tools' options bar — spec 04 §6: tool mode (Shape / Path / Pixels), fill and
 * stroke (width, alignment, caps, joins, dashes), the path operation, and each tool's own
 * settings (corner radius, sides and star ratio, line weight and arrowheads, the custom
 * shape). Also the Path Selection tool's Path Alignment and Path Arrangement.
 */
import { For, Show, createSignal, onMount } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, IconButton, Select, Separator } from '@umbra/ui/widgets/controls';
import { pathBounds, type Path, type PathArrange, type ShapeOptions } from '@umbra/engine';
import { store } from '../state/store';
import { Swatch, type Rgb } from '../fx/controls';

const send = (m: unknown) => store.engine?.(m as never);

/** A path as SVG path data, fitted into a `size` square (for the custom shape picker). */
export function pathSvg(path: Path, size: number): string {
  const b = pathBounds(path, 0.1);
  if (!b) return '';
  const k = (size - 2) / Math.max(1e-9, b.x1 - b.x0, b.y1 - b.y0);
  const ox = (size - (b.x1 - b.x0) * k) / 2;
  const oy = (size - (b.y1 - b.y0) * k) / 2;
  const f = (q: { x: number; y: number }) => `${((q.x - b.x0) * k + ox).toFixed(2)} ${((q.y - b.y0) * k + oy).toFixed(2)}`;
  return path.subpaths
    .map((sp) => {
      const ks = sp.knots;
      if (!ks.length) return '';
      let d = `M${f(ks[0]!.anchor)}`;
      const n = sp.closed ? ks.length : ks.length - 1;
      for (let i = 0; i < n; i++) {
        const a = ks[i]!;
        const c = ks[(i + 1) % ks.length]!;
        d += `C${f(a.out)} ${f(c.in)} ${f(c.anchor)}`;
      }
      return sp.closed ? d + 'Z' : d;
    })
    .join('');
}

const DASHES: { value: string; label: string; dashes: number[]; cap?: 'round' }[] = [
  { value: 'solid', label: 'Solid', dashes: [] },
  { value: 'dashed', label: 'Dashed', dashes: [4, 2] },
  { value: 'dotted', label: 'Dotted', dashes: [0, 2], cap: 'round' },
];

function CustomShapePicker() {
  // The options bar clips its overflow, so the popup is fixed, placed under the button.
  const [open, setOpen] = createSignal<{ top: number; left: number } | null>(null);
  let file!: HTMLInputElement;
  onMount(() => send({ t: 'requestCustomShapes' }));
  const current = () => store.customShapes().find((c) => c.id === store.shapeOptions().customShape);
  const set = (patch: Partial<ShapeOptions>) => store.setShapeOptions({ ...store.shapeOptions(), ...patch });
  return (
    <span class="shape-picker">
      <span class="options-label">Shape:</span>
      <button type="button" class="shape-picker-button" title={current()?.name ?? 'Pick a shape'} onClick={(e) => {
          if (open()) return setOpen(null);
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ top: r.bottom + 4, left: Math.max(4, r.right - 232) });
        }}>
        <Show when={current()}>{(c) => <svg width="20" height="20" viewBox="0 0 20 20"><path d={pathSvg(c().path, 20)} fill-rule="evenodd" /></svg>}</Show>
        <Icon name="chevronDown" size={10} />
      </button>
      <Show when={open()}>
        <div class="shape-picker-pop" style={{ top: `${open()!.top}px`, left: `${open()!.left}px` }} onPointerLeave={() => setOpen(null)}>
          <div class="shape-grid">
            <For each={store.customShapes()}>
              {(c) => (
                <button
                  type="button"
                  class="shape-cell"
                  classList={{ selected: c.id === store.shapeOptions().customShape }}
                  title={c.name}
                  onClick={() => {
                    set({ customShape: c.id });
                    setOpen(null);
                  }}
                >
                  <svg width="30" height="30" viewBox="0 0 30 30">
                    <path d={pathSvg(c.path, 30)} fill-rule="evenodd" />
                  </svg>
                </button>
              )}
            </For>
          </div>
          <button type="button" class="dialog-button" onClick={() => file.click()}>
            Load Shapes…
          </button>
          <input
            ref={file}
            type="file"
            accept=".csh"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!f) return;
              const buffer = await f.arrayBuffer();
              send({ t: 'loadCustomShapes', buffer });
            }}
          />
        </div>
      </Show>
    </span>
  );
}

export function ShapeToolOptions() {
  const o = () => store.shapeOptions();
  const set = (patch: Partial<ShapeOptions>) => store.setShapeOptions({ ...o(), ...patch });
  const tool = () => store.activeTool();
  const fillColor = (): Rgb => {
    const f = o().fill;
    return f?.type === 'solid' ? f.color : [0, 0, 0];
  };
  const stroke = () => o().stroke;
  const strokeColor = (): Rgb => (stroke().content.type === 'solid' ? (stroke().content as { color: Rgb }).color : [0, 0, 0]);
  const setStroke = (patch: Partial<ShapeOptions['stroke']>) => set({ stroke: { ...stroke(), ...patch } });
  const setStyle = (patch: Partial<ShapeOptions['stroke']['style']>) => setStroke({ style: { ...stroke().style, ...patch } });
  const dash = () => (stroke().style.dashes.length === 0 ? 'solid' : stroke().style.dashes[0] === 0 ? 'dotted' : 'dashed');
  return (
    <>
      <Select
        value={o().mode}
        width={70}
        title="Tool mode"
        options={[
          { value: 'shape', label: 'Shape' },
          { value: 'path', label: 'Path' },
          { value: 'pixels', label: 'Pixels' },
        ]}
        onChange={(mode) => set({ mode: mode as ShapeOptions['mode'] })}
      />
      <Show when={o().mode === 'shape'}>
        <Separator />
        <span class="options-label">Fill:</span>
        <Checkbox checked={!!o().fill} title="Fill the shape" onChange={(v) => set({ fill: v ? { type: 'solid', color: fillColor() } : null })} />
        <Show when={o().fill}>
          <Swatch value={fillColor()} title="Fill colour" onChange={(c) => set({ fill: { type: 'solid', color: c } })} />
        </Show>
        <span class="options-label">Stroke:</span>
        <Checkbox checked={stroke().enabled} title="Stroke the shape" onChange={(v) => setStroke({ enabled: v })} />
        <Show when={stroke().enabled}>
          <Swatch value={strokeColor()} title="Stroke colour" onChange={(c) => setStroke({ content: { type: 'solid', color: c } })} />
          <NumberField value={stroke().style.width} min={0.1} max={1000} step={0.5} precision={1} suffix="px" width={52} onChange={(v) => setStyle({ width: v })} />
          <Select
            value={dash()}
            width={72}
            title="Stroke type"
            options={DASHES.map((d) => ({ value: d.value, label: d.label }))}
            onChange={(v) => {
              const d = DASHES.find((x) => x.value === v)!;
              setStyle({ dashes: d.dashes, ...(d.cap ? { cap: d.cap } : {}) });
            }}
          />
          <Select
            value={stroke().style.align}
            width={70}
            title="Align"
            options={[
              { value: 'inside', label: 'Inside' },
              { value: 'center', label: 'Center' },
              { value: 'outside', label: 'Outside' },
            ]}
            onChange={(v) => setStyle({ align: v as 'center' })}
          />
          <Select
            value={stroke().style.cap}
            width={64}
            title="Caps"
            options={[
              { value: 'butt', label: 'Butt' },
              { value: 'round', label: 'Round' },
              { value: 'square', label: 'Square' },
            ]}
            onChange={(v) => setStyle({ cap: v as 'butt' })}
          />
          <Select
            value={stroke().style.join}
            width={64}
            title="Corners"
            options={[
              { value: 'miter', label: 'Miter' },
              { value: 'round', label: 'Round' },
              { value: 'bevel', label: 'Bevel' },
            ]}
            onChange={(v) => setStyle({ join: v as 'miter' })}
          />
        </Show>
      </Show>
      <Show when={o().mode === 'pixels'}>
        <Checkbox checked={o().antiAlias} label="Anti-alias" onChange={(v) => set({ antiAlias: v })} />
      </Show>
      <Show when={o().mode !== 'pixels'}>
        <Separator />
        <Select
          value={o().mode !== 'shape' && o().op === 'new' ? 'add' : o().op}
          width={140}
          title="Path operation"
          options={[
            ...(o().mode === 'shape' ? [{ value: 'new', label: 'New Layer' }] : []),
            { value: 'add', label: 'Combine Shapes' },
            { value: 'subtract', label: 'Subtract Front Shape' },
            { value: 'intersect', label: 'Intersect Shape Areas' },
            { value: 'exclude', label: 'Exclude Overlapping' },
          ]}
          onChange={(op) => set({ op: op as ShapeOptions['op'] })}
        />
      </Show>
      <Separator />
      <Show when={tool() === 'rectangle' || tool() === 'triangle' || tool() === 'polygon'}>
        <NumberField label="Radius" value={o().radius} min={0} max={1000} suffix="px" width={48} onChange={(v) => set({ radius: v })} />
      </Show>
      <Show when={tool() === 'polygon'}>
        <NumberField label="Sides" value={o().sides} min={3} max={100} width={40} onChange={(v) => set({ sides: v })} />
        <NumberField label="Star Ratio" value={100 - o().star} min={1} max={100} suffix="%" width={44} onChange={(v) => set({ star: 100 - v })} />
        <Checkbox checked={o().smoothCorners} label="Smooth Corners" onChange={(v) => set({ smoothCorners: v })} />
        <Show when={o().star > 0}>
          <Checkbox checked={o().smoothIndents} label="Smooth Indents" onChange={(v) => set({ smoothIndents: v })} />
        </Show>
      </Show>
      <Show when={tool() === 'line'}>
        <NumberField label="Weight" value={o().weight} min={0.1} max={1000} step={0.5} precision={1} suffix="px" width={48} onChange={(v) => set({ weight: v })} />
        <Checkbox checked={o().arrowStart} label="Arrow Start" onChange={(v) => set({ arrowStart: v })} />
        <Checkbox checked={o().arrowEnd} label="End" onChange={(v) => set({ arrowEnd: v })} />
        <Show when={o().arrowStart || o().arrowEnd}>
          <NumberField label="Width" value={o().arrowWidth} min={10} max={1000} suffix="%" width={48} onChange={(v) => set({ arrowWidth: v })} />
          <NumberField label="Length" value={o().arrowLength} min={10} max={5000} suffix="%" width={48} onChange={(v) => set({ arrowLength: v })} />
        </Show>
      </Show>
      <Show when={tool() === 'customShape'}>
        <CustomShapePicker />
      </Show>
    </>
  );
}

/** Path Selection's Path Alignment and Arrangement, on the selected components. */
export function PathAlignOptions() {
  const arrange = (cmd: PathArrange) => send({ t: 'arrangePath', cmd });
  const align: [PathArrange, string, string][] = [
    ['alignLeft', 'alignLeft', 'Align left edges'],
    ['alignHCenter', 'alignHCenter', 'Align horizontal centers'],
    ['alignRight', 'alignRight', 'Align right edges'],
    ['alignTop', 'alignTop', 'Align top edges'],
    ['alignVCenter', 'alignVCenter', 'Align vertical centers'],
    ['alignBottom', 'alignBottom', 'Align bottom edges'],
    ['distributeH', 'distributeH', 'Distribute horizontally (3 or more)'],
    ['distributeV', 'distributeV', 'Distribute vertically (3 or more)'],
  ];
  return (
    <>
      <Separator />
      <For each={align}>{([cmd, icon, title]) => <IconButton icon={icon as never} title={`${title} — one component aligns to the canvas`} onClick={() => arrange(cmd)} />}</For>
      <Select
        value=""
        width={120}
        title="Path arrangement"
        options={[
          { value: '', label: 'Arrange…' },
          { value: 'front', label: 'Bring Shape to Front' },
          { value: 'forward', label: 'Bring Shape Forward' },
          { value: 'backward', label: 'Send Shape Backward' },
          { value: 'back', label: 'Send Shape to Back' },
        ]}
        onChange={(v) => v && arrange(v as PathArrange)}
      />
    </>
  );
}
