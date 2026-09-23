/**
 * Filter ▸ Filter Gallery — spec 05 §B.10. Left, the preview; centre, the six effect folders
 * with thumbnails; right, the selected effect layer's settings and the stack of effect layers
 * (eye, new, delete, reorder). Clicking a thumbnail changes the selected layer's effect, as in
 * Photoshop; New Effect Layer duplicates it. The whole stack is one registry filter, so OK,
 * Last Filter and Fade treat it like any other filter.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Button, Checkbox, Select } from '@umbra/ui/widgets/controls';
import { DEFAULT_STACK, GALLERY_BY_ID, GALLERY_CATEGORIES, GALLERY_EFFECTS, defaultsOf, fromRgba8, parseStack, toRgba8, type FilterParams, type GalleryCategory, type GalleryLayer } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { ParamControl, colours, useCanvasPreview } from './FilterDialog';
import { PreviewBox } from './PreviewBox';

/** The stack last applied this session — the gallery reopens with it. */
let lastStack: GalleryLayer[] = DEFAULT_STACK;

const THUMB_W = 72;
const THUMB_H = 54;

/** A small scene to show each effect on: sky, sun, hills, a house — something with edges, flats and gradients. */
function sampleScene(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
  for (let y = 0; y < THUMB_H; y++) {
    for (let x = 0; x < THUMB_W; x++) {
      const o = (y * THUMB_W + x) * 4;
      let c = [90 + y * 2, 150 + y, 235];
      const ground = 34 + 5 * Math.sin(x / 8) + 2 * Math.sin(x / 3 + y / 5);
      if (Math.hypot(x - 54, y - 13) < 7) c = [255, 220, 90];
      if (y > ground) c = [55 + ((x * 7 + y * 13) % 23) * 2, 125 + ((x * 5 + y * 3) % 17) * 3, 40];
      if (x > 14 && x < 32 && y > 25 && y < 42) c = x > 21 && x < 26 && y > 34 ? [70, 40, 30] : [190, 70, 50];
      if (y > 16 && y <= 25 && Math.abs(x - 23) < (y - 16) * 1.2) c = [110, 60, 60];
      if (Math.hypot(x - 45, y - 42) < 5) c = [240, 240, 250];
      px[o] = c[0]!;
      px[o + 1] = c[1]!;
      px[o + 2] = c[2]!;
      px[o + 3] = 255;
    }
  }
  return px;
}

/** Thumbnails, rendered once per session in the background, a few at a time. */
const thumbs = new Map<string, ImageData>();
const [thumbsReady, setThumbsReady] = createSignal(0);
let thumbsStarted = false;
function renderThumbs() {
  if (thumbsStarted) return;
  thumbsStarted = true;
  const scene = fromRgba8(sampleScene(), THUMB_W, THUMB_H);
  const ctx = { originX: 0, originY: 0, docWidth: THUMB_W, docHeight: THUMB_H, foreground: [0, 0, 0] as [number, number, number], background: [1, 1, 1] as [number, number, number], coverage: null };
  let k = 0;
  const step = () => {
    const end = Math.min(GALLERY_EFFECTS.length, k + 4);
    for (; k < end; k++) {
      const e = GALLERY_EFFECTS[k]!;
      thumbs.set(e.id, new ImageData(new Uint8ClampedArray(toRgba8(e.run(scene, defaultsOf(e), ctx))), THUMB_W, THUMB_H));
    }
    setThumbsReady(k);
    if (k < GALLERY_EFFECTS.length) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

function Thumb(props: { id: string; selected: boolean; onPick: () => void }) {
  let canvas!: HTMLCanvasElement;
  const paint = () => {
    const img = thumbs.get(props.id);
    if (img && canvas) canvas.getContext('2d')!.putImageData(img, 0, 0);
  };
  onMount(paint);
  createMemo(() => {
    thumbsReady();
    paint();
  });
  return (
    <button type="button" class="gallery-thumb" classList={{ selected: props.selected }} onClick={props.onPick} title={GALLERY_BY_ID.get(props.id)!.label}>
      <canvas ref={canvas} width={THUMB_W} height={THUMB_H} />
      <span>{GALLERY_BY_ID.get(props.id)!.label}</span>
    </button>
  );
}

/** A smart Filter Gallery being re-edited: its stack and its place in the smart-filter list. */
export interface GalleryPayload {
  stack: string;
  smartIndex: number;
}

export function GalleryDialog(props: { payload?: GalleryPayload; send: (m: unknown) => void; onClose: () => void }) {
  const smartIndex = props.payload?.smartIndex;
  const initial = props.payload ? parseStack(props.payload.stack) : lastStack;
  const [layers, setLayers] = createSignal<GalleryLayer[]>(structuredClone(initial.length ? initial : DEFAULT_STACK));
  // Index into `layers` (bottom = 0) of the layer being edited.
  const [selected, setSelected] = createSignal(Math.max(0, layers().length - 1));
  const [preview, setPreview] = createSignal(true);
  const [open, setOpen] = createSignal<Set<GalleryCategory>>(new Set([GALLERY_BY_ID.get(layers()[layers().length - 1]?.id ?? 'gallery.cutout')!.category]));
  const params = createMemo<FilterParams>(() => ({ stack: JSON.stringify(layers()) }));
  const current = () => layers()[selected()];
  const canvasPreview = useCanvasPreview(props.send, () => 'filter.gallery', params, preview, smartIndex);

  onMount(renderThumbs);
  onCleanup(() => canvasPreview.cancel());

  const update = (i: number, next: Partial<GalleryLayer>) => setLayers(layers().map((l, k) => (k === i ? { ...l, ...next } : l)));
  const pick = (id: string) => {
    const cur = current();
    if (!cur) {
      setLayers([{ id, params: defaultsOf(GALLERY_BY_ID.get(id)!), visible: true }]);
      setSelected(0);
    } else if (cur.id !== id) update(selected(), { id, params: defaultsOf(GALLERY_BY_ID.get(id)!) });
  };
  const addLayer = () => {
    const cur = current() ?? DEFAULT_STACK[0]!;
    const next = [...layers()];
    next.splice(selected() + 1, 0, structuredClone({ ...cur, visible: true }));
    setLayers(next);
    setSelected(selected() + 1);
  };
  const deleteLayer = () => {
    if (layers().length <= 1) return;
    setLayers(layers().filter((_, k) => k !== selected()));
    setSelected(Math.max(0, selected() - 1));
  };
  const move = (d: number) => {
    const i = selected();
    const j = i + d;
    if (j < 0 || j >= layers().length) return;
    const next = [...layers()];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setLayers(next);
    setSelected(j);
  };
  const toggle = (c: GalleryCategory) => {
    const s = new Set(open());
    if (s.has(c)) s.delete(c);
    else s.add(c);
    setOpen(s);
  };

  const effectOptions = GALLERY_EFFECTS.map((e) => ({ value: e.id, label: e.label })).sort((a, b) => a.label.localeCompare(b.label));

  return (
    <Dialog
      title={`Filter Gallery (${GALLERY_BY_ID.get(current()?.id ?? '')?.label ?? ''})`}
      width={1000}
      onOk={() => {
        canvasPreview.cancel();
        if (smartIndex === undefined) lastStack = parseStack(params().stack as string);
        props.send({ t: 'applyFilter', id: 'filter.gallery', params: params(), ...colours(), smartIndex });
        props.onClose();
      }}
      onCancel={() => {
        canvasPreview.clear();
        props.onClose();
      }}
      onReset={() => {
        setLayers(structuredClone(DEFAULT_STACK));
        setSelected(0);
      }}
      footer={<Checkbox checked={preview()} label="Preview" onChange={setPreview} />}
    >
      <div class="gallery">
        <PreviewBox id="filter.gallery" params={params()} width={440} height={400} send={props.send} smartIndex={smartIndex} />
        <div class="gallery-folders">
          <For each={GALLERY_CATEGORIES}>
            {(cat) => (
              <div class="gallery-folder">
                <button type="button" class="gallery-folder-head" onClick={() => toggle(cat)}>
                  {open().has(cat) ? '▾' : '▸'} {cat}
                </button>
                <Show when={open().has(cat)}>
                  <div class="gallery-grid">
                    <For each={GALLERY_EFFECTS.filter((e) => e.category === cat)}>{(e) => <Thumb id={e.id} selected={current()?.id === e.id} onPick={() => pick(e.id)} />}</For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
        <div class="gallery-side">
          <Show when={current()}>
            {(cur) => (
              <div class="adjust-editor">
                <Select value={cur().id} width={200} options={effectOptions} onChange={pick} />
                <For each={GALLERY_BY_ID.get(cur().id)!.params}>
                  {(spec) => <ParamControl spec={spec} value={cur().params[spec.key]!} onChange={(v) => update(selected(), { params: { ...cur().params, [spec.key]: v } })} />}
                </For>
              </div>
            )}
          </Show>
          <div class="gallery-stack">
            {/* Photoshop lists the top effect first. */}
            <For each={layers().map((l, i) => ({ l, i })).reverse()}>
              {({ l, i }) => (
                <div class="gallery-layer" classList={{ selected: i === selected() }} onClick={() => setSelected(i)}>
                  <button
                    type="button"
                    class="gallery-eye"
                    title={l.visible ? 'Hide this effect' : 'Show this effect'}
                    onClick={(e) => {
                      e.stopPropagation();
                      update(i, { visible: !l.visible });
                    }}
                  >
                    {l.visible ? '👁' : ''}
                  </button>
                  <span>{GALLERY_BY_ID.get(l.id)!.label}</span>
                </div>
              )}
            </For>
          </div>
          <div class="adjust-fields gallery-stack-buttons">
            <Button width={34} title="Move the effect layer up" onClick={() => move(1)}>
              ↑
            </Button>
            <Button width={34} title="Move the effect layer down" onClick={() => move(-1)}>
              ↓
            </Button>
            <Button width={34} title="New effect layer" onClick={addLayer}>
              +
            </Button>
            <Button width={34} title="Delete effect layer" onClick={deleteLayer}>
              🗑
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
