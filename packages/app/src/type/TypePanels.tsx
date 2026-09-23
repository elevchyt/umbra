/**
 * Type in the UI — spec 04 §7 and spec 01 §5: the type tools' options bar, the Character and
 * Paragraph panels, and the font menu (search, favourites, loading font files and the
 * system's fonts). They show the style at the caret while editing, else the selected type
 * layer's, else what new type will start with; a change applies to the selection, the
 * selected type layers, and the tool's defaults.
 */
import { For, Show, createMemo, createSignal } from 'solid-js';
import { Icon } from '@umbra/ui/icons/Icon';
import { NumberField } from '@umbra/ui/widgets/NumberField';
import { Checkbox, IconButton, Select, Separator } from '@umbra/ui/widgets/controls';
import { DEFAULT_CHAR, DEFAULT_PARA, type AntiAlias, type CharStyle, type ParaStyle } from '@umbra/engine';
import { store } from '../state/store';
import { Swatch } from '../fx/controls';

const send = (m: unknown) => store.engine?.(m as never);

/** The character style the controls show. */
export function currentChar(): CharStyle {
  const d = store.doc();
  if (d?.typeEdit) return d.typeEdit.style;
  const l = d?.layers.find((x) => x.id === d.activeLayerIds[0]);
  const run = l?.type?.text.runs[0]?.style;
  if (run) return run;
  const o = store.typeOptions();
  const f = store.foreground();
  return { ...DEFAULT_CHAR, font: o.font, family: o.family, fontStyle: o.fontStyle, size: o.size, color: [f.r, f.g, f.b] };
}

export function currentPara(): ParaStyle {
  const d = store.doc();
  if (d?.typeEdit) return d.typeEdit.para;
  const l = d?.layers.find((x) => x.id === d.activeLayerIds[0]);
  return l?.type?.text.paragraphs[0] ?? { ...DEFAULT_PARA, align: store.typeOptions().align };
}

function currentAA(): AntiAlias {
  const d = store.doc();
  const l = d?.layers.find((x) => x.id === (d.typeEdit?.layerId ?? d.activeLayerIds[0]));
  return l?.type?.antiAlias ?? store.typeOptions().antiAlias;
}

/** Apply a character-style change everywhere it belongs. */
export function applyChar(patch: Partial<CharStyle>): void {
  const o = store.typeOptions();
  const keep: Partial<ReturnType<typeof store.typeOptions>> = {};
  if (patch.font !== undefined) Object.assign(keep, { font: patch.font, family: patch.family ?? o.family, fontStyle: patch.fontStyle ?? o.fontStyle });
  if (patch.size !== undefined) keep.size = patch.size;
  if (Object.keys(keep).length) store.setTypeOptions({ ...o, ...keep });
  send({ t: 'setTypeStyle', patch });
}

export function applyPara(patch: Partial<ParaStyle>): void {
  if (patch.align === 'left' || patch.align === 'center' || patch.align === 'right') store.setTypeOptions({ ...store.typeOptions(), align: patch.align });
  send({ t: 'setTypePara', patch });
}

function applyAA(aa: AntiAlias): void {
  store.setTypeOptions({ ...store.typeOptions(), antiAlias: aa });
  const d = store.doc();
  const l = d?.layers.find((x) => x.id === (d.typeEdit?.layerId ?? d.activeLayerIds[0]));
  if (l?.kind === 'type') send({ t: 'typeCommand', cmd: `aa:${aa}` });
}

const AA_OPTIONS: { value: AntiAlias; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sharp', label: 'Sharp' },
  { value: 'crisp', label: 'Crisp' },
  { value: 'strong', label: 'Strong' },
  { value: 'smooth', label: 'Smooth' },
];

const FAV_KEY = 'umbra.fontFavourites';
function loadFavs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Load font files, or (where the platform allows) the system's fonts. */
export async function loadFontFiles(files: FileList | File[]): Promise<void> {
  const buffers = await Promise.all([...files].map((f) => f.arrayBuffer()));
  if (buffers.length) send({ t: 'addFonts', buffers });
}

export async function loadSystemFonts(): Promise<void> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ postscriptName: string; blob(): Promise<Blob> }[]> }).queryLocalFonts;
  if (!q) {
    store.setStatusMessage('System fonts are not available here; use Add Fonts… to load font files.');
    return;
  }
  try {
    const list = await q();
    const have = new Set(store.fonts().flatMap((f) => f.styles.map((s) => s.postscript)));
    const todo = list.filter((f) => !have.has(f.postscriptName)).slice(0, 400);
    const buffers = await Promise.all(todo.map(async (f) => (await f.blob()).arrayBuffer()));
    send({ t: 'addFonts', buffers });
  } catch (e) {
    store.setStatusMessage(`System fonts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The font family menu: search, favourites first, and loading more fonts. */
export function FontPicker(props: { width?: number }) {
  const [open, setOpen] = createSignal<{ top: number; left: number } | null>(null);
  const [query, setQuery] = createSignal('');
  const [favs, setFavs] = createSignal(loadFavs());
  let file!: HTMLInputElement;
  const cur = () => currentChar();
  const list = createMemo(() => {
    const q = query().trim().toLowerCase();
    const all = store.fonts().filter((f) => !q || f.family.toLowerCase().includes(q));
    const f = favs();
    return [...all.filter((x) => f.has(x.family)), ...all.filter((x) => !f.has(x.family))];
  });
  const toggleFav = (family: string) => {
    const next = new Set(favs());
    if (next.has(family)) next.delete(family);
    else next.add(family);
    setFavs(next);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
    } catch {
      // Favourites are a convenience; losing them is fine.
    }
  };
  const pick = (family: string) => {
    const fam = store.fonts().find((f) => f.family === family);
    const style = fam?.styles.find((s) => s.style === cur().fontStyle) ?? fam?.styles.find((s) => s.style === 'Regular') ?? fam?.styles[0];
    if (style) applyChar({ font: style.postscript, family, fontStyle: style.style });
    setOpen(null);
  };
  const styles = () => store.fonts().find((f) => f.family === cur().family)?.styles ?? [{ style: cur().fontStyle, postscript: cur().font }];
  return (
    <span class="font-picker">
      <button
        type="button"
        class="font-picker-button"
        style={{ width: `${props.width ?? 150}px` }}
        title="Font family"
        onClick={(e) => {
          if (open()) return setOpen(null);
          if (!store.fonts().length) send({ t: 'requestFonts' });
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ top: r.bottom + 2, left: r.left });
        }}
      >
        <span class="font-picker-name">{cur().family}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      <Select value={cur().fontStyle} width={90} title="Font style" options={styles().map((s) => ({ value: s.style, label: s.style }))} onChange={(v) => {
        const s = styles().find((x) => x.style === v);
        if (s) applyChar({ font: s.postscript, family: cur().family, fontStyle: s.style });
      }} />
      <Show when={open()}>
        {(pos) => (
          <div class="font-menu" style={{ top: `${pos().top}px`, left: `${pos().left}px` }} onPointerLeave={() => setOpen(null)}>
            <input class="font-menu-search" placeholder="Search fonts" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} onKeyDown={(e) => e.key === 'Escape' && setOpen(null)} />
            <div class="font-menu-list">
              <For each={list()}>
                {(f) => (
                  <div class="font-menu-row" classList={{ selected: f.family === cur().family }} onClick={() => pick(f.family)}>
                    <button type="button" class="font-fav" classList={{ on: favs().has(f.family) }} title="Favourite" onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(f.family);
                    }}>
                      ★
                    </button>
                    <span>{f.family}</span>
                    <span class="dim font-menu-count">{f.styles.length}</span>
                  </div>
                )}
              </For>
              <Show when={!list().length}>
                <div class="dim font-menu-empty">{store.fonts().length ? 'No match' : 'Loading fonts…'}</div>
              </Show>
            </div>
            <div class="font-menu-foot">
              <button type="button" class="dialog-button" onClick={() => file.click()}>Add Fonts…</button>
              <button type="button" class="dialog-button" onClick={() => void loadSystemFonts()}>System Fonts</button>
              <input ref={file} type="file" multiple accept=".ttf,.otf,.ttc,.otc" style={{ display: 'none' }} onChange={(e) => {
                const fs = e.currentTarget.files;
                if (fs) void loadFontFiles(fs);
                e.currentTarget.value = '';
              }} />
            </div>
          </div>
        )}
      </Show>
    </span>
  );
}

const ALIGNS: [ParaStyle['align'], string, string][] = [
  ['left', 'textLeft', 'Left align text'],
  ['center', 'textCenter', 'Center text'],
  ['right', 'textRight', 'Right align text'],
];
const JUSTIFY: [ParaStyle['align'], string, string][] = [
  ['justifyLeft', 'justifyLeft', 'Justify last left'],
  ['justifyCenter', 'justifyCenter', 'Justify last centered'],
  ['justifyRight', 'justifyRight', 'Justify last right'],
  ['justifyAll', 'justifyAll', 'Justify all'],
];

/** The type tools' options bar. */
export function TypeToolOptions() {
  const c = () => currentChar();
  const editing = () => !!store.doc()?.typeEdit;
  return (
    <>
      <IconButton icon="textOrientation" title="Toggle text orientation" onClick={() => {
        const d = store.doc();
        const l = d?.layers.find((x) => x.id === (d.typeEdit?.layerId ?? d.activeLayerIds[0]));
        if (l?.type) send({ t: 'typeCommand', cmd: l.type.text.orientation === 'vertical' ? 'horizontal' : 'vertical' });
        else store.setActiveTool(store.activeTool().endsWith('Vertical') ? store.activeTool().replace('Vertical', 'Horizontal') : store.activeTool().replace('Horizontal', 'Vertical'));
      }} />
      <FontPicker />
      <NumberField value={c().size} min={0.5} max={1296} step={1} precision={1} suffix="pt" width={52} title="Font size" onChange={(v) => applyChar({ size: v })} />
      <Select value={currentAA()} width={72} title="Anti-aliasing" options={AA_OPTIONS} onChange={(v) => applyAA(v as AntiAlias)} />
      <Separator />
      <For each={ALIGNS}>{([a, icon, title]) => <IconButton icon={icon as never} title={title} active={currentPara().align === a} onClick={() => applyPara({ align: a })} />}</For>
      <Separator />
      <Swatch value={c().color} title="Text colour" onChange={(color) => applyChar({ color })} />
      <Separator />
      <button type="button" class="dialog-button" title="Warp Text" onClick={() => window.dispatchEvent(new CustomEvent('umbra:command', { detail: 'type.warp' }))}>
        Warp
      </button>
      <IconButton icon="panelMenu" title="Character and Paragraph panels" onClick={() => {
        store.openPanel('character');
        store.openPanel('paragraph');
      }} />
      <Show when={editing()}>
        <Separator />
        <IconButton icon="cancel" title="Cancel all current edits (Esc)" onClick={() => send({ t: 'typeCancel' })} />
        <IconButton icon="commit" title="Commit all current edits (Ctrl+Enter)" onClick={() => send({ t: 'typeCommit' })} />
      </Show>
    </>
  );
}

function Toggle(props: { label: string; title: string; on: boolean; onChange: (v: boolean) => void; style?: Record<string, string> }) {
  return (
    <button type="button" class="type-toggle" classList={{ on: props.on }} title={props.title} style={props.style} onClick={() => props.onChange(!props.on)}>
      {props.label}
    </button>
  );
}

/** Window ▸ Character. */
export function CharacterPanel() {
  const c = () => currentChar();
  const leading = () => c().leading;
  const kerning = () => c().kerning;
  return (
    <div class="type-panel">
      <div class="type-row">
        <FontPicker width={130} />
      </div>
      <div class="type-grid">
        <NumberField label="Size" value={c().size} min={0.5} max={1296} precision={1} suffix="pt" width={52} onChange={(v) => applyChar({ size: v })} />
        <span class="type-field">
          <Select value={leading() === 'auto' ? 'auto' : 'set'} width={56} title="Leading" options={[{ value: 'auto', label: 'Auto' }, { value: 'set', label: 'Set' }]} onChange={(v) => applyChar({ leading: v === 'auto' ? 'auto' : Math.round(c().size * 1.2) })} />
          <Show when={leading() !== 'auto'}>
            <NumberField value={leading() as number} min={0.1} max={5000} precision={1} suffix="pt" width={48} title="Leading" onChange={(v) => applyChar({ leading: v })} />
          </Show>
        </span>
        <span class="type-field">
          <Select value={typeof kerning() === 'number' ? 'set' : (kerning() as string)} width={70} title="Kerning" options={[{ value: 'metrics', label: 'Metrics' }, { value: 'optical', label: 'Optical' }, { value: 'set', label: 'Manual' }]} onChange={(v) => applyChar({ kerning: v === 'set' ? 0 : (v as 'metrics') })} />
          <Show when={typeof kerning() === 'number'}>
            <NumberField value={kerning() as number} min={-1000} max={10000} width={44} title="Kerning (1/1000 em)" onChange={(v) => applyChar({ kerning: v })} />
          </Show>
        </span>
        <NumberField label="Tracking" value={c().tracking} min={-1000} max={10000} width={48} onChange={(v) => applyChar({ tracking: v })} />
        <NumberField label="V scale" value={c().vScale} min={1} max={1000} suffix="%" width={48} onChange={(v) => applyChar({ vScale: v })} />
        <NumberField label="H scale" value={c().hScale} min={1} max={1000} suffix="%" width={48} onChange={(v) => applyChar({ hScale: v })} />
        <NumberField label="Baseline" value={c().baselineShift} min={-1296} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyChar({ baselineShift: v })} />
        <span class="type-field">
          <span class="options-label">Color</span>
          <Swatch value={c().color} title="Text colour" onChange={(color) => applyChar({ color })} />
        </span>
      </div>
      <div class="type-row type-toggles">
        <Toggle label="B" title="Faux Bold" on={c().fauxBold} onChange={(v) => applyChar({ fauxBold: v })} style={{ 'font-weight': '700' }} />
        <Toggle label="I" title="Faux Italic" on={c().fauxItalic} onChange={(v) => applyChar({ fauxItalic: v })} style={{ 'font-style': 'italic' }} />
        <Toggle label="TT" title="All Caps" on={c().allCaps} onChange={(v) => applyChar({ allCaps: v })} />
        <Toggle label="Tt" title="Small Caps" on={c().smallCaps} onChange={(v) => applyChar({ smallCaps: v })} />
        <Toggle label="T¹" title="Superscript" on={c().position === 'superscript'} onChange={(v) => applyChar({ position: v ? 'superscript' : 'normal' })} />
        <Toggle label="T₁" title="Subscript" on={c().position === 'subscript'} onChange={(v) => applyChar({ position: v ? 'subscript' : 'normal' })} />
        <Toggle label="U" title="Underline" on={c().underline} onChange={(v) => applyChar({ underline: v })} style={{ 'text-decoration': 'underline' }} />
        <Toggle label="S" title="Strikethrough" on={c().strikethrough} onChange={(v) => applyChar({ strikethrough: v })} style={{ 'text-decoration': 'line-through' }} />
      </div>
      <div class="type-row type-toggles">
        <Toggle label="fi" title="Standard Ligatures" on={c().ligatures} onChange={(v) => applyChar({ ligatures: v })} />
        <Toggle label="st" title="Discretionary Ligatures" on={c().discretionaryLigatures} onChange={(v) => applyChar({ discretionaryLigatures: v })} />
        <Toggle label="½" title="Fractions" on={!!c().features.frac} onChange={(v) => applyChar({ features: { ...c().features, frac: v } })} />
        <Toggle label="1st" title="Ordinals" on={!!c().features.ordn} onChange={(v) => applyChar({ features: { ...c().features, ordn: v } })} />
        <Toggle label="0¹" title="Oldstyle figures" on={!!c().features.onum} onChange={(v) => applyChar({ features: { ...c().features, onum: v } })} />
      </div>
      <div class="type-row">
        <Select value={c().language} width={110} title="Language" options={LANGS} onChange={(v) => applyChar({ language: v })} />
        <Select value={currentAA()} width={72} title="Anti-aliasing" options={AA_OPTIONS} onChange={(v) => applyAA(v as AntiAlias)} />
      </div>
    </div>
  );
}

const LANGS = [
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pt', 'Portuguese'],
  ['el', 'Greek'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
  ['ko', 'Korean'],
].map(([value, label]) => ({ value: value!, label: label! }));

/** Window ▸ Paragraph. */
export function ParagraphPanel() {
  const p = () => currentPara();
  return (
    <div class="type-panel">
      <div class="type-row">
        <For each={[...ALIGNS, ...JUSTIFY]}>{([a, icon, title]) => <IconButton icon={icon as never} title={title} active={p().align === a} onClick={() => applyPara({ align: a })} />}</For>
      </div>
      <div class="type-grid">
        <NumberField label="Indent left" value={p().indentLeft} min={-1296} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyPara({ indentLeft: v })} />
        <NumberField label="Indent right" value={p().indentRight} min={-1296} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyPara({ indentRight: v })} />
        <NumberField label="First line" value={p().indentFirst} min={-1296} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyPara({ indentFirst: v })} />
        <span />
        <NumberField label="Space before" value={p().spaceBefore} min={0} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyPara({ spaceBefore: v })} />
        <NumberField label="Space after" value={p().spaceAfter} min={0} max={1296} precision={1} suffix="pt" width={48} onChange={(v) => applyPara({ spaceAfter: v })} />
        <NumberField label="Auto leading" value={p().autoLeading} min={0} max={500} suffix="%" width={48} onChange={(v) => applyPara({ autoLeading: v })} />
        <Select value={p().direction} width={80} title="Paragraph direction" options={[{ value: 'auto', label: 'Auto' }, { value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} onChange={(v) => applyPara({ direction: v as 'auto' })} />
      </div>
      <div class="type-row">
        <Checkbox checked={p().hyphenate} label="Hyphenate" title="Hyphenation is not applied yet (the composer breaks at spaces)" disabled onChange={(v) => applyPara({ hyphenate: v })} />
      </div>
    </div>
  );
}
