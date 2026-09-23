/**
 * Window ▸ Glyphs, Character Styles, Paragraph Styles — spec 01 §5.
 *
 * Glyphs shows the characters the current font maps, a page at a time; clicking one types it
 * into the text being edited. The styles panels keep named character and paragraph styles
 * (saved with the app, not the document, for now) and apply them to the selection or the
 * selected type layers.
 */
import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { DEFAULT_CHAR, DEFAULT_PARA, type CharStyle, type ParaStyle } from '@umbra/engine';
import { store } from '../state/store';
import { applyChar, applyPara, currentChar, currentPara, FontPicker } from './TypePanels';
import { Dialog } from '../dialogs/Dialogs';

const send = (m: unknown) => store.engine?.(m as never);
const PAGE = 240;

type GlyphPage = { font: string; from: number; upem: number; total: number; glyphs: { cp: number; d: string; adv: number }[] };

export function GlyphsPanel() {
  const [page, setPage] = createSignal<GlyphPage | null>(null);
  const [from, setFrom] = createSignal(0);
  const font = () => currentChar().font;
  const onGlyphs = (e: Event) => setPage((e as CustomEvent<GlyphPage>).detail);
  window.addEventListener('umbra:glyphs', onGlyphs);
  onCleanup(() => window.removeEventListener('umbra:glyphs', onGlyphs));
  createEffect(on([font, from], ([f, n]) => send({ t: 'requestGlyphs', font: f, from: n, count: PAGE })));
  createEffect(on(font, () => setFrom(0), { defer: true }));
  const insert = (cp: number) => {
    if (store.doc()?.typeEdit) send({ t: 'typeInput', text: String.fromCodePoint(cp) });
    else store.setStatusMessage('Click into type with the Type tool, then pick a glyph to insert it.');
  };
  return (
    <div class="glyphs-panel">
      <div class="type-row">
        <FontPicker width={120} />
      </div>
      <div class="glyph-grid">
        <Show when={page()} fallback={<div class="dim adjustments-note">Loading glyphs…</div>}>
          {(p) => (
            <For each={p().glyphs}>
              {(g) => (
                <button type="button" class="glyph-cell" title={`U+${g.cp.toString(16).toUpperCase().padStart(4, '0')}`} onClick={() => insert(g.cp)}>
                  <svg viewBox={`${-p().upem * 0.1} ${-p().upem * 0.9} ${p().upem * 1.2} ${p().upem * 1.2}`} width="26" height="26">
                    <path d={g.d} transform="scale(1,-1)" />
                  </svg>
                </button>
              )}
            </For>
          )}
        </Show>
      </div>
      <Show when={page()}>
        {(p) => (
          <div class="panel-footer glyph-foot">
            <button type="button" class="mini-icon" title="Previous page" disabled={from() === 0} onClick={() => setFrom(Math.max(0, from() - PAGE))}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <span class="dim">
              {from() + 1}–{Math.min(p().total, from() + PAGE)} of {p().total}
            </span>
            <button type="button" class="mini-icon" title="Next page" disabled={from() + PAGE >= p().total} onClick={() => setFrom(from() + PAGE)}>
              <Icon name="chevronRight" size={14} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

type Named<T> = { name: string; style: T };
function saved<T>(key: string): Named<T>[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as Named<T>[];
  } catch {
    return [];
  }
}
function persist<T>(key: string, list: Named<T>[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Styles are kept for the session anyway.
  }
}

/** A style list with "new from current", apply on click, rename by double-click, delete. */
function StylesList<T>(props: { storageKey: string; base: string; current: () => T; apply: (s: T) => void; describe: (s: T) => string }) {
  const [list, setList] = createSignal<Named<T>[]>(saved<T>(props.storageKey));
  const [picked, setPicked] = createSignal<number | null>(null);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const update = (next: Named<T>[]) => {
    setList(next);
    persist(props.storageKey, next);
  };
  return (
    <div class="styles-list-panel">
      <div class="paths-list">
        <div class="path-row" classList={{ selected: picked() === -1 }} onClick={() => setPicked(-1)}>
          <span class="path-name">[Basic {props.base} Style]</span>
        </div>
        <For each={list()}>
          {(s, i) => (
            <div
              class="path-row"
              classList={{ selected: picked() === i() }}
              title={props.describe(s.style)}
              onClick={() => {
                setPicked(i());
                props.apply(s.style);
              }}
              onDblClick={() => setRenaming(i())}
            >
              <Show when={renaming() === i()} fallback={<span class="path-name">{s.name}</span>}>
                <input
                  class="styles-name"
                  value={s.name}
                  ref={(el) => queueMicrotask(() => el.select())}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => {
                    const name = e.currentTarget.value.trim();
                    setRenaming(null);
                    if (name) update(list().map((x, j) => (j === i() ? { ...x, name } : x)));
                  }}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="panel-footer">
        <button type="button" class="mini-icon" title={`Create a new ${props.base.toLowerCase()} style from the current settings`} onClick={() => update([...list(), { name: `${props.base} Style ${list().length + 1}`, style: props.current() }])}>
          <Icon name="newLayer" size={15} />
        </button>
        <button type="button" class="mini-icon" title="Redefine the style from the current settings" disabled={(picked() ?? -1) < 0} onClick={() => update(list().map((x, j) => (j === picked() ? { ...x, style: props.current() } : x)))}>
          <Icon name="check" size={15} />
        </button>
        <button
          type="button"
          class="mini-icon"
          title="Delete the style"
          disabled={(picked() ?? -1) < 0}
          onClick={() => {
            update(list().filter((_, j) => j !== picked()));
            setPicked(null);
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}

/** What a character style sets: everything but the text colour's identity is kept. */
function charOf(c: CharStyle): Partial<CharStyle> {
  const { language: _l, ...rest } = c;
  return rest;
}

export function CharacterStylesPanel() {
  return (
    <StylesList<Partial<CharStyle>>
      storageKey="umbra.charStyles"
      base="Character"
      current={() => charOf(currentChar())}
      apply={(s) => applyChar(Object.keys(s).length ? s : charOf(DEFAULT_CHAR))}
      describe={(s) => `${s.family ?? ''} ${s.fontStyle ?? ''} ${s.size ?? ''} pt`.trim()}
    />
  );
}

export function ParagraphStylesPanel() {
  return (
    <StylesList<Partial<ParaStyle>>
      storageKey="umbra.paraStyles"
      base="Paragraph"
      current={() => currentPara()}
      apply={(s) => applyPara(Object.keys(s).length ? s : DEFAULT_PARA)}
      describe={(s) => `${s.align ?? 'left'}, indents ${s.indentLeft ?? 0}/${s.indentRight ?? 0}`}
    />
  );
}

/** Type ▸ Resolve Missing Fonts: each missing font mapped to an installed family and style. */
export function missingFonts(): string[] {
  const out = new Set<string>();
  for (const l of store.doc()?.layers ?? []) for (const f of l.type?.missingFonts ?? []) out.add(f);
  return [...out];
}

/** The dialog: every missing font with the installed face to use instead. */
export function ResolveFontsDialog(props: { onClose: () => void }) {
  const faces = () => store.fonts().flatMap((f) => f.styles.map((s) => ({ value: s.postscript, label: `${f.family} ${s.style}` })));
  const [map, setMap] = createSignal<Record<string, string>>(Object.fromEntries(missingFonts().map((f) => [f, 'NotoSans-Regular'])));
  if (!store.fonts().length) send({ t: 'requestFonts' });
  return (
    <Dialog
      title="Resolve Missing Fonts"
      width={420}
      onOk={() => {
        send({ t: 'replaceFonts', map: map() });
        props.onClose();
      }}
      onCancel={props.onClose}
    >
      <div class="adjust-editor">
        <Show when={missingFonts().length} fallback={<div class="dim">No fonts are missing.</div>}>
          <For each={Object.keys(map())}>
            {(f) => (
              <div class="type-row">
                <span class="resolve-font-name">{f}</span>
                <select class="resolve-font-select" value={map()[f]} onChange={(e) => setMap({ ...map(), [f]: e.currentTarget.value })}>
                  <For each={faces()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                </select>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  );
}
