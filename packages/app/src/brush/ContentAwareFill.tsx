/**
 * Edit ▸ Content-Aware Fill — Photoshop's Content-Aware Fill workspace. The canvas shows the
 * sampling area as a tinted overlay (the engine draws it); this panel holds the workspace's
 * tools (Sampling Brush, Lasso, Polygonal Lasso, Hand, Zoom), the Preview, and the settings:
 * the overlay, the sampling area, the fill (colour, rotation, scale, mirror) and the output.
 * OK fills at full size; Cancel leaves the document as it was.
 */
import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { Checkbox, IconButton, Select } from '@umbra/ui/widgets/controls';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { DEFAULT_CAF, type CafOptions } from '@umbra/engine';
import { store } from '../state/store';

const send = (m: unknown) => store.engine?.(m as never);

const OVERLAY_COLORS: { value: string; label: string; rgb: [number, number, number] }[] = [
  { value: 'green', label: 'Green', rgb: [0, 1, 0] },
  { value: 'red', label: 'Red', rgb: [1, 0, 0] },
  { value: 'blue', label: 'Blue', rgb: [0, 0.4, 1] },
  { value: 'yellow', label: 'Yellow', rgb: [1, 0.9, 0] },
];

/** The workspace's own tools, as Photoshop's CAF toolbar has them. */
const TOOLS: { id: string; icon: string; title: string }[] = [
  { id: 'cafSampling', icon: 'brush', title: 'Sampling Brush Tool (B): paint the sampling area in; Alt paints it out' },
  { id: 'lasso', icon: 'lasso', title: 'Lasso Tool (L): change the fill area' },
  { id: 'lassoPolygon', icon: 'lassoPolygon', title: 'Polygonal Lasso Tool' },
  { id: 'hand', icon: 'hand', title: 'Hand Tool (H)' },
  { id: 'zoom', icon: 'zoom', title: 'Zoom Tool (Z)' },
];

/** Open the workspace on the selection (Edit ▸ Content-Aware Fill). */
export function openContentAwareFill(): void {
  if (!store.doc()?.hasSelection) {
    store.setStatusMessage('Content-Aware Fill needs a selection.');
    return;
  }
  const options: CafOptions = JSON.parse(JSON.stringify(DEFAULT_CAF));
  store.setCaf({ options, sampling: options.sampling, preview: null, busy: true, previousTool: store.activeTool(), brushSize: 40, subtract: false });
  store.setActiveTool('cafSampling');
  send({ t: 'cafBegin', options });
}

function close(commit: boolean): void {
  const c = store.caf();
  if (!c) return;
  send({ t: 'cafEnd', commit });
  store.setActiveTool(c.previousTool);
  store.setCaf(null);
}

function Preview() {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const p = store.caf()?.preview;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!p) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // Fit the picture in the panel, keeping its shape.
    const k = Math.min(canvas.width / p.width, canvas.height / p.height);
    const img = new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height);
    const tmp = new OffscreenCanvas(p.width, p.height);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, (canvas.width - p.width * k) / 2, (canvas.height - p.height * k) / 2, p.width * k, p.height * k);
  });
  return (
    <div class="caf-preview">
      <canvas ref={canvas} width={272} height={180} />
      <Show when={store.caf()?.busy}>
        <span class="caf-busy">Updating…</span>
      </Show>
    </div>
  );
}

export function ContentAwareFillWorkspace() {
  const c = () => store.caf()!;
  const o = () => c().options;
  const set = (patch: Partial<CafOptions>) => {
    const options = { ...o(), ...patch };
    store.setCaf({ ...c(), options, ...(patch.sampling ? { sampling: patch.sampling } : {}) });
    send({ t: 'cafOptions', options });
  };
  const setOverlay = (patch: Partial<CafOptions['overlay']>) => set({ overlay: { ...o().overlay, ...patch } });
  const color = () => OVERLAY_COLORS.find((k) => k.rgb.every((v, i) => v === o().overlay.color[i]))?.value ?? 'green';

  onMount(() => {
    // Enter is OK and Escape Cancel, as in Photoshop's workspace (not while typing in a field).
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    onCleanup(() => window.removeEventListener('keydown', key, true));
  });

  return (
    <div class="caf-workspace">
      <div class="dialog-title">Content-Aware Fill</div>
      <div class="caf-body">
        <div class="type-row">
          <For each={TOOLS}>{(t) => <IconButton icon={t.icon as never} title={t.title} active={store.activeTool() === t.id} onClick={() => store.setActiveTool(t.id)} />}</For>
        </div>
        <Show when={store.activeTool() === 'cafSampling'}>
          <div class="bs-row">
            <Select label="" value={c().subtract ? 'subtract' : 'add'} width={130} options={[{ value: 'add', label: 'Add to Sampling' }, { value: 'subtract', label: 'Subtract from Sampling' }]} onChange={(v) => store.setCaf({ ...c(), subtract: v === 'subtract' })} />
            <NumberField label="Size" value={c().brushSize} min={1} max={2000} suffix="px" width={40} onChange={(v) => store.setCaf({ ...c(), brushSize: v })} />
          </div>
        </Show>
        <div class="bs-subhead">Preview</div>
        <Preview />
        <div class="bs-subhead">Sampling Area Overlay</div>
        <div class="bs-row">
          <Checkbox checked={o().overlay.show} label="Show Sampling Area" onChange={(v) => setOverlay({ show: v })} />
          <NumberField label="Opacity" value={Math.round(o().overlay.opacity * 100)} min={1} max={100} suffix="%" width={34} onChange={(v) => setOverlay({ opacity: v / 100 })} />
        </div>
        <div class="bs-row">
          <Select label="Color" value={color()} width={70} options={OVERLAY_COLORS.map((k) => ({ value: k.value, label: k.label }))} onChange={(v) => setOverlay({ color: OVERLAY_COLORS.find((k) => k.value === v)!.rgb })} />
          <Select label="Indicates" value={o().overlay.indicates} width={110} options={[{ value: 'sampling', label: 'Sampling Area' }, { value: 'excluded', label: 'Excluded Area' }]} onChange={(v) => setOverlay({ indicates: v as 'sampling' })} />
        </div>
        <div class="bs-subhead">Sampling Area Options</div>
        <div class="bs-row">
          <Select label="" value={c().sampling} width={110} options={[{ value: 'auto', label: 'Auto' }, { value: 'rectangular', label: 'Rectangular' }, { value: 'custom', label: 'Custom' }]} onChange={(v) => set({ sampling: v as CafOptions['sampling'] })} />
          <Checkbox checked={o().sampleAll} label="Sample All Layers" onChange={(v) => set({ sampleAll: v })} />
        </div>
        <div class="bs-subhead">Fill Settings</div>
        <Select
          label="Color Adaptation"
          value={o().colorAdaptation}
          width={100}
          options={[
            { value: 'none', label: 'None' },
            { value: 'default', label: 'Default' },
            { value: 'high', label: 'High' },
            { value: 'veryHigh', label: 'Very High' },
          ]}
          onChange={(v) => set({ colorAdaptation: v as CafOptions['colorAdaptation'] })}
        />
        <Select
          label="Rotation Adaptation"
          value={o().rotation}
          width={100}
          options={[
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'full', label: 'Full' },
          ]}
          onChange={(v) => set({ rotation: v as CafOptions['rotation'] })}
        />
        <div class="bs-row">
          <Checkbox checked={o().scale} label="Scale" onChange={(v) => set({ scale: v })} />
          <Checkbox checked={o().mirror} label="Mirror" onChange={(v) => set({ mirror: v })} />
        </div>
        <div class="bs-subhead">Output Settings</div>
        <Select label="Output To" value={o().output} width={130} options={[{ value: 'current', label: 'Current Layer' }, { value: 'new', label: 'New Layer' }, { value: 'duplicate', label: 'Duplicate Layer' }]} onChange={(v) => set({ output: v as CafOptions['output'] })} />
      </div>
      <div class="caf-buttons">
        <button type="button" class="dialog-button" title="All settings back to their defaults" onClick={() => set(JSON.parse(JSON.stringify(DEFAULT_CAF)))}>
          Reset
        </button>
        <span class="caf-spacer" />
        <button type="button" class="dialog-button" onClick={() => close(false)}>
          Cancel
        </button>
        <button type="button" class="button primary" onClick={() => close(true)}>
          OK
        </button>
      </div>
    </div>
  );
}

