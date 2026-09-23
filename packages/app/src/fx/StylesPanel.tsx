/**
 * Window ▸ Styles — the style library (spec 01 §5): click a style to put it on the selected
 * layers (it replaces their style, as in Photoshop; Alt-click deletes it), New Style from
 * the active layer, and Load/Save as Photoshop .asl files.
 */
import { For, Show, createSignal, onMount } from 'solid-js';
import { Button } from '@umbra/ui/widgets/controls';
import { store } from '../state/store';
import { StyleTile } from './StyleTile';

export function StylesPanel() {
  const send = (m: unknown) => store.engine?.(m as never);
  const [naming, setNaming] = createSignal(false);
  const [name, setName] = createSignal('');
  const [picked, setPicked] = createSignal<string | null>(null);
  onMount(() => send({ t: 'requestStyles' }));
  const active = () => store.doc()?.layers.find((l) => l.id === store.doc()?.activeLayerIds[0]);

  const load = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.asl';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      store.engine?.({ t: 'loadAsl', name: f.name, bytes } as never);
    };
    input.click();
  };

  return (
    <div class="styles-panel">
      <div class="styles-grid">
        <For each={store.styles()}>
          {(s) => (
            <button
              type="button"
              class="style-cell"
              classList={{ selected: picked() === s.id }}
              title={`${s.name} — click to apply, Alt-click to delete`}
              onClick={(e) => {
                if (e.altKey) {
                  send({ t: 'deleteStyle', id: s.id });
                  return;
                }
                setPicked(s.id);
                send({ t: 'applyStyle', id: s.id });
              }}
            >
              <StyleTile fx={s.effects} size={44} />
            </button>
          )}
        </For>
      </div>
      <div class="dim adjustments-note">{store.styles().find((s) => s.id === picked())?.name ?? 'Click a style to apply it to the selected layers.'}</div>
      <Show when={naming()}>
        <div class="fx-row styles-new">
          <input
            class="styles-name"
            placeholder="Style name"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                send({ t: 'newStyle', name: name() });
                setNaming(false);
              }
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <Button
            width={50}
            onClick={() => {
              send({ t: 'newStyle', name: name() });
              setNaming(false);
            }}
          >
            OK
          </Button>
        </div>
      </Show>
      <div class="panel-footer">
        <Button width={60} title="Save the active layer's style as a new style" disabled={!active()?.effects} onClick={() => { setName(`${active()?.name ?? 'Style'} Style`); setNaming(true); }}>
          New
        </Button>
        <Button width={60} title="Delete the selected style" disabled={!picked()} onClick={() => { send({ t: 'deleteStyle', id: picked()! }); setPicked(null); }}>
          Delete
        </Button>
        <Button width={60} title="Load a Photoshop style library (.asl)" onClick={load}>
          Load…
        </Button>
        <Button width={60} title="Save the styles as a Photoshop style library (.asl)" onClick={() => send({ t: 'exportAsl', name: 'Styles.asl' })}>
          Save…
        </Button>
      </div>
    </div>
  );
}
