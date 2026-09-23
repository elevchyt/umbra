/**
 * Window ▸ Paths — spec 01 §5: the Work Path (italic, unsaved), saved paths, and the buttons
 * Photoshop puts along the bottom: fill with the foreground colour, stroke with the brush, load
 * as a selection, make a work path from the selection, add a vector mask (M7 stage 3), new
 * path, delete. Double-click a name to rename it (the Work Path: to save it). Clicking the
 * empty part of the list deselects, so the Pen starts a new Work Path.
 */
import { For, Show, createEffect, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { rasterizePath, transformPath, pathBounds, type Path } from '@umbra/engine';
import { store } from '../state/store';

const THUMB = 36;

/** A path drawn into a small square, scaled to the document. */
function PathThumb(props: { path: Path; docW: number; docH: number }) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const k = THUMB / Math.max(1, props.docW, props.docH);
    const p = transformPath(props.path, { a: k, b: 0, c: 0, d: k, e: 0, f: 0 });
    const cov = rasterizePath(p, { x0: 0, y0: 0, x1: THUMB, y1: THUMB });
    const img = new ImageData(THUMB, THUMB);
    for (let i = 0; i < cov.length; i++) {
      const v = 255 - Math.round(cov[i]! * 200);
      img.data.set([v, v, v, 255], i * 4);
    }
    canvas.getContext('2d')?.putImageData(img, 0, 0);
  });
  return <canvas ref={canvas} class="path-thumb" width={THUMB} height={THUMB} />;
}

export function PathsPanel() {
  const send = (m: unknown) => store.engine?.(m as never);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const doc = () => store.doc();
  const active = () => doc()?.activePathId ?? null;
  const fg = (): [number, number, number] => {
    const f = store.foreground();
    return [f.r, f.g, f.b];
  };
  const finishRename = (id: number, name: string, work: boolean) => {
    setRenaming(null);
    if (!name.trim()) return;
    send({ t: 'pathCommand', cmd: work ? 'save' : 'rename', id, name: name.trim() });
  };
  return (
    <div class="paths-panel">
      <div class="paths-list" onClick={() => send({ t: 'pathCommand', cmd: 'select' })}>
        <For each={doc()?.paths ?? []}>
          {(p) => (
            <div
              class="path-row"
              classList={{ selected: active() === p.id, work: p.work }}
              onClick={(e) => {
                e.stopPropagation();
                send({ t: 'pathCommand', cmd: 'select', id: p.id });
              }}
              onDblClick={() => setRenaming(p.id)}
            >
              <PathThumb path={p.path} docW={doc()!.width} docH={doc()!.height} />
              <Show when={renaming() === p.id} fallback={<span class="path-name">{p.name}</span>}>
                <input
                  class="styles-name"
                  value={p.work ? `Path ${(doc()?.paths ?? []).filter((q) => !q.work).length + 1}` : p.name}
                  ref={(el) => queueMicrotask(() => el.select())}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') finishRename(p.id, e.currentTarget.value, p.work);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => finishRename(p.id, e.currentTarget.value, p.work)}
                  onClick={(e) => e.stopPropagation()}
                />
              </Show>
            </div>
          )}
        </For>
        <Show when={(doc()?.paths ?? []).length === 0}>
          <div class="dim adjustments-note">Draw with the Pen tool to make a Work Path.</div>
        </Show>
      </div>
      <div class="panel-footer">
        <button type="button" class="mini-icon" title="Fill path with foreground color" disabled={active() === null} onClick={() => send({ t: 'pathCommand', cmd: 'fill', color: fg() })}>
          <Icon name="paintBucket" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Stroke path with brush"
          disabled={active() === null}
          onClick={() => {
            const { mode, ...brush } = store.brush;
            send({ t: 'pathCommand', cmd: 'stroke', tool: 'brush', brush, color: fg(), mode });
          }}
        >
          <Icon name="brush" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Load path as a selection" disabled={active() === null} onClick={() => send({ t: 'pathCommand', cmd: 'toSelection', op: 'new' })}>
          <Icon name="marqueeRect" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Make work path from selection" disabled={!doc()?.hasSelection} onClick={() => send({ t: 'pathCommand', cmd: 'fromSelection', tolerance: 2 })}>
          <Icon name="pen" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Add vector mask — arrives with shape layers (M7)" disabled>
          <Icon name="addMask" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Create new path" onClick={() => send({ t: 'pathCommand', cmd: 'new' })}>
          <Icon name="newLayer" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Delete current path" disabled={active() === null} onClick={() => send({ t: 'pathCommand', cmd: 'delete' })}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}
