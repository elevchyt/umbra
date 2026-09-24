/**
 * Window ▸ Brushes — spec 01 §5: a size slider, search, folders of presets with stroke
 * previews drawn by the brush engine; New Brush Preset, New Group, Load/Export .abr, rename by
 * double-click, delete. The same list drops down from the options bar's preset picker.
 *
 * Choosing a preset replaces the tip and every Brush Settings section; opacity, flow and mode
 * stay the tool's own unless the preset carries them, as in Photoshop.
 */
import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { Icon } from '@umbra/ui/icons/Icon';
import { physicalTip, DEFAULT_BRUSH, beginBrushStroke, brushStrokeTo, renderDabs, type BrushParams, type BrushPreset, type Dab, type TipBitmap } from '@umbra/engine';
import { store } from '../state/store';
import { Slide } from '../fx/controls';

const send = (m: unknown) => store.engine?.(m as never);

/** Apply a preset to the brush. */
export function applyBrushPreset(p: BrushPreset): void {
  const b = store.brush;
  const next: BrushParams & { mode: string } = {
    ...DEFAULT_BRUSH,
    // Tool options stay unless the preset has its own.
    opacity: b.opacity,
    flow: b.flow,
    smoothing: b.smoothing,
    airbrush: b.airbrush,
    airbrushRate: b.airbrushRate,
    pressureSize: b.pressureSize,
    pressureOpacity: b.pressureOpacity,
    symmetry: b.symmetry,
    mode: b.mode,
    tip: { kind: 'computed' },
    ...JSON.parse(JSON.stringify(p.params)),
  };
  store.setBrush(reconcile(next));
  store.setBrushPresetId(p.id);
}

/** A preset's stroke, drawn on the CPU into a small canvas. */
function StrokeThumb(props: { preset: BrushPreset; tips: Record<string, TipBitmap>; width?: number; height?: number }) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const W = props.width ?? 150;
    const H = props.height ?? 28;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const src = props.preset.params;
    const size = Math.min(src.size, H - 6);
    const k = size / Math.max(1, src.size);
    const p: BrushParams = {
      ...DEFAULT_BRUSH,
      ...JSON.parse(JSON.stringify(src)),
      size,
      opacity: 1,
      smoothing: 0,
      pressureSize: false,
      pressureOpacity: false,
      seed: 7,
      texture: undefined,
      symmetry: undefined,
      ...(src.dual ? { dual: { ...src.dual, size: src.dual.size * k } } : {}),
    };
    const s = beginBrushStroke(p, { fg: [0.9, 0.9, 0.9], bg: [0.5, 0.5, 0.5] });
    const dabs: Dab[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      dabs.push(...brushStrokeTo(s, { x: 6 + t * (W - 12), y: H / 2 + Math.sin(t * Math.PI * 2) * (H / 2 - size / 2 - 2), pressure: 0.3 + 0.7 * Math.sin(t * Math.PI), time: i * 16 }));
    }
    const cov = renderDabs(dabs, W, H, { tips: (id) => props.tips[id] ?? physicalTip(id), ...(p.dual?.enabled ? { dual: { hardness: p.dual.hardness, mode: p.dual.mode, tip: p.dual.tip.kind === 'sampled' ? props.tips[p.dual.tip.id] : undefined } } : {}) });
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const a = Math.min(1, p.wetEdges ? cov[i]! * (0.5 + 2 * cov[i]! * (1 - cov[i]!)) : cov[i]!);
      img.data.set([220, 220, 220, Math.round(a * 255)], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  });
  return <canvas ref={canvas} class="brush-thumb" width={props.width ?? 150} height={props.height ?? 28} />;
}

/** The folders of presets: shared by the panel and the options bar's picker. */
export function BrushPresetList(props: { compact?: boolean; onPick?: () => void }) {
  const [query, setQuery] = createSignal('');
  const [closed, setClosed] = createSignal(new Set<string>());
  const [renaming, setRenaming] = createSignal<string | null>(null);
  onMount(() => {
    if (!store.brushLibrary()) send({ t: 'requestBrushes' });
  });
  const groups = createMemo(() => {
    const lib = store.brushLibrary();
    const q = query().trim().toLowerCase();
    return (lib?.groups ?? []).map((g) => ({ ...g, presets: q ? g.presets.filter((p) => p.name.toLowerCase().includes(q)) : g.presets })).filter((g) => !q || g.presets.length);
  });
  const tips = () => store.brushLibrary()?.tips ?? {};
  return (
    <div class="brush-list" classList={{ compact: props.compact }}>
      <div class="brush-list-top">
        <Slide label="Size" value={store.brush.size} min={1} max={5000} suffix="px" onChange={(v) => store.setBrush('size', v)} />
        <input class="font-menu-search" placeholder="Search brushes" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <div class="brush-groups">
        <For each={groups()}>
          {(g) => (
            <div class="brush-group">
              <div
                class="brush-group-head"
                onClick={() => {
                  const next = new Set(closed());
                  if (next.has(g.name)) next.delete(g.name);
                  else next.add(g.name);
                  setClosed(next);
                }}
              >
                <Icon name={closed().has(g.name) ? 'chevronRight' : 'chevronDown'} size={10} />
                <Icon name="folder" size={13} />
                <span>{g.name}</span>
              </div>
              <Show when={!closed().has(g.name)}>
                <For each={g.presets}>
                  {(p) => (
                    <div
                      class="brush-row"
                      classList={{ selected: store.brushPresetId() === p.id }}
                      title={p.name}
                      onClick={() => {
                        applyBrushPreset(p);
                        props.onPick?.();
                      }}
                      onDblClick={() => !props.compact && setRenaming(p.id)}
                    >
                      <span class="brush-size-badge">{Math.round(p.params.size)}</span>
                      <StrokeThumb preset={p} tips={tips()} width={props.compact ? 120 : 150} />
                      <Show when={renaming() === p.id} fallback={<span class="brush-name">{p.name}</span>}>
                        <input
                          class="styles-name"
                          value={p.name}
                          ref={(el) => queueMicrotask(() => el.select())}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') e.currentTarget.blur();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={(e) => {
                            const name = e.currentTarget.value.trim();
                            setRenaming(null);
                            if (name && name !== p.name) send({ t: 'editBrushLibrary', op: { op: 'rename', id: p.id, name } });
                          }}
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function BrushesPanel() {
  let file!: HTMLInputElement;
  const selectedGroup = () => store.brushLibrary()?.groups.find((g) => g.presets.some((p) => p.id === store.brushPresetId()))?.name;
  const currentParams = (): BrushPreset['params'] => {
    const { mode: _m, ...rest } = JSON.parse(JSON.stringify(store.brush)) as BrushParams & { mode: string };
    return rest;
  };
  return (
    <div class="brushes-panel">
      <BrushPresetList />
      <div class="panel-footer">
        <button type="button" class="mini-icon" title="Load brushes (.abr)" onClick={() => file.click()}>
          <Icon name="folder" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Export the selected brush's group (.abr)" disabled={!selectedGroup()} onClick={() => send({ t: 'exportAbr', group: selectedGroup(), name: `${selectedGroup()}.abr` })}>
          <Icon name="newDocument" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Create a new group" onClick={() => send({ t: 'editBrushLibrary', op: { op: 'newGroup', name: 'Group' } })}>
          <Icon name="newLayer" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Create a new brush preset from the current brush"
          onClick={() => send({ t: 'editBrushLibrary', op: { op: 'newPreset', name: `Brush ${Math.round(store.brush.size)}`, params: currentParams(), group: selectedGroup() } })}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Delete the selected brush preset"
          disabled={!selectedGroup()}
          onClick={() => {
            const id = store.brushPresetId();
            if (id) send({ t: 'editBrushLibrary', op: { op: 'delete', id } });
            store.setBrushPresetId(null);
          }}
        >
          <Icon name="trash" size={15} />
        </button>
        <input
          ref={file}
          type="file"
          accept=".abr"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            for (const f of [...(e.currentTarget.files ?? [])]) send({ t: 'importAbr', bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
            e.currentTarget.value = '';
          }}
        />
      </div>
    </div>
  );
}

/** The options bar's brush preset picker: the list in a drop-down. */
export function BrushPicker() {
  const [open, setOpen] = createSignal<{ top: number; left: number } | null>(null);
  return (
    <>
      <button
        type="button"
        class="brush-preview"
        title="Brush preset picker"
        onClick={(e) => {
          if (open()) return setOpen(null);
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ top: r.bottom + 2, left: r.left });
        }}
      >
        <span
          class="brush-dot"
          style={{
            width: `${Math.min(22, Math.max(3, store.brush.size / 12))}px`,
            height: `${Math.min(22, Math.max(3, store.brush.size / 12))}px`,
          }}
        />
        <Icon name="chevronDown" size={10} />
      </button>
      <Show when={open()}>
        {(pos) => (
          <div class="brush-picker-pop" style={{ top: `${pos().top}px`, left: `${pos().left}px` }} onPointerLeave={() => setOpen(null)}>
            <BrushPresetList compact onPick={() => setOpen(null)} />
          </div>
        )}
      </Show>
    </>
  );
}
