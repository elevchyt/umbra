/**
 * Layer ▸ Layer Style — spec 01 §6: the list of Blending Options and the ten effects on the
 * left (checkbox to switch one on, "+" for the five that may repeat, ▲▼ and 🗑 below), the
 * selected page in the middle, and OK / Cancel / Preview with a preview tile on the right.
 * Every change previews on the canvas; OK commits the whole style as one step.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Button, Checkbox } from '@umbra/ui/widgets/controls';
import { StyleTile } from './StyleTile';
import { EFFECT_DEFAULTS, EMPTY_EFFECTS, DEFAULT_GLOBAL_LIGHT, type LayerEffects, type GlobalLight, type LayerSummary } from '@umbra/engine';
import { Dialog } from '../dialogs/Dialogs';
import { store } from '../state/store';
import { BevelContourPage, BevelPage, BevelTexturePage, BlendingPage, ColorOverlayPage, GlowPage, GradientOverlayPage, PatternOverlayPage, SatinPage, ShadowPage, StrokePage, type BlendingValue } from './pages';
import type { Rgb } from './controls';

export type StyleKey =
  | 'styles'
  | 'blending'
  | 'bevel'
  | 'bevelContour'
  | 'bevelTexture'
  | 'stroke'
  | 'innerShadow'
  | 'innerGlow'
  | 'satin'
  | 'colorOverlay'
  | 'gradientOverlay'
  | 'patternOverlay'
  | 'outerGlow'
  | 'dropShadow';

type Multi = 'stroke' | 'innerShadow' | 'colorOverlay' | 'gradientOverlay' | 'dropShadow';
type Single = 'bevel' | 'innerGlow' | 'satin' | 'patternOverlay' | 'outerGlow';
const MULTI = new Set<StyleKey>(['stroke', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'dropShadow']);

/** Photoshop's list, top to bottom (the top one draws in front). */
export const STYLE_ITEMS: { key: StyleKey; label: string }[] = [
  { key: 'styles', label: 'Styles' },
  { key: 'blending', label: 'Blending Options' },
  { key: 'bevel', label: 'Bevel & Emboss' },
  { key: 'bevelContour', label: 'Contour' },
  { key: 'bevelTexture', label: 'Texture' },
  { key: 'stroke', label: 'Stroke' },
  { key: 'innerShadow', label: 'Inner Shadow' },
  { key: 'innerGlow', label: 'Inner Glow' },
  { key: 'satin', label: 'Satin' },
  { key: 'colorOverlay', label: 'Color Overlay' },
  { key: 'gradientOverlay', label: 'Gradient Overlay' },
  { key: 'patternOverlay', label: 'Pattern Overlay' },
  { key: 'outerGlow', label: 'Outer Glow' },
  { key: 'dropShadow', label: 'Drop Shadow' },
];

export interface LayerStylePayload {
  layerId: number;
  page?: StyleKey;
}

const fgbg = (): { fg: Rgb; bg: Rgb } => {
  const f = store.foreground();
  const b = store.background();
  return { fg: [f.r, f.g, f.b], bg: [b.r, b.g, b.b] };
};

function freshEffect(key: Multi | Single) {
  const { fg, bg } = fgbg();
  if (key === 'gradientOverlay') return EFFECT_DEFAULTS.gradientOverlay(fg, bg);
  if (key === 'patternOverlay') return EFFECT_DEFAULTS.patternOverlay(null);
  return EFFECT_DEFAULTS[key]();
}

export function LayerStyleDialog(props: { payload: LayerStylePayload; send: (m: unknown) => void; onClose: () => void }) {
  const id = props.payload.layerId;
  const layer = (): LayerSummary | undefined => store.doc()?.layers.find((l) => l.id === id);
  const initial = layer();
  const [fx, setFx] = createSignal<LayerEffects>(structuredClone(initial?.effects ?? EMPTY_EFFECTS));
  const [blend, setBlend] = createSignal<BlendingValue>({
    opacity: initial?.opacity ?? 1,
    fill: initial?.fill ?? 1,
    blendMode: (initial?.blendMode ?? 'normal') as BlendingValue['blendMode'],
    blending: structuredClone(initial?.blending ?? { channels: { r: true, g: true, b: true }, knockout: 'none', blendClippedLayersAsGroup: true, transparencyShapesLayer: true, blendIf: [] }),
  });
  const light0 = store.doc()?.globalLight ?? DEFAULT_GLOBAL_LIGHT;
  const [light, setLight] = createSignal<GlobalLight>(light0);
  const [page, setPage] = createSignal<{ key: StyleKey; index: number }>({ key: props.payload.page ?? 'blending', index: 0 });
  const [preview, setPreview] = createSignal(true);
  const [naming, setNaming] = createSignal(false);
  const [styleName, setStyleName] = createSignal(`${initial?.name ?? 'Layer'} Style`);
  onMount(() => props.send({ t: 'requestStyles' }));

  const list = (k: Multi) => fx()[k] as { enabled: boolean }[];
  const single = (k: Single) => fx()[k] as { enabled: boolean } | null;
  const update = (patch: Partial<LayerEffects>) => setFx({ ...fx(), ...patch });

  /** Make sure the page's effect exists (a click on its name switches it on, as in Photoshop). */
  const ensure = (key: StyleKey, index = 0) => {
    if (key === 'blending' || key === 'styles') return;
    if (key === 'bevelContour' || key === 'bevelTexture') {
      const b = fx().bevel ?? { ...EFFECT_DEFAULTS.bevel() };
      update({ bevel: { ...b, enabled: true, ...(key === 'bevelContour' ? { contourEnabled: true } : { textureEnabled: true }) } });
      return;
    }
    if (MULTI.has(key)) {
      const l = list(key as Multi);
      if (l.length === 0) update({ [key]: [freshEffect(key as Multi)] } as never);
      else if (l[index] && !l[index]!.enabled) update({ [key]: l.map((e, i) => (i === index ? { ...e, enabled: true } : e)) } as never);
      return;
    }
    const s = single(key as Single);
    if (!s) update({ [key]: freshEffect(key as Single) } as never);
    else if (!s.enabled) update({ [key]: { ...s, enabled: true } } as never);
  };

  const checked = (key: StyleKey, index: number): boolean => {
    if (key === 'blending' || key === 'styles') return true;
    if (key === 'bevelContour') return !!fx().bevel?.contourEnabled;
    if (key === 'bevelTexture') return !!fx().bevel?.textureEnabled;
    if (MULTI.has(key)) return !!list(key as Multi)[index]?.enabled;
    return !!single(key as Single)?.enabled;
  };

  const toggle = (key: StyleKey, index: number) => {
    if (key === 'bevelContour' || key === 'bevelTexture') {
      const b = fx().bevel ?? EFFECT_DEFAULTS.bevel();
      const flag = key === 'bevelContour' ? 'contourEnabled' : 'textureEnabled';
      update({ bevel: { ...b, [flag]: !b[flag] } });
      return;
    }
    if (MULTI.has(key)) {
      const l = list(key as Multi);
      if (l.length === 0) update({ [key]: [freshEffect(key as Multi)] } as never);
      else update({ [key]: l.map((e, i) => (i === index ? { ...e, enabled: !e.enabled } : e)) } as never);
      return;
    }
    const s = single(key as Single);
    update({ [key]: s ? { ...s, enabled: !s.enabled } : freshEffect(key as Single) } as never);
  };

  /** "+": a copy of this instance, above it. */
  const addInstance = (key: Multi, index: number) => {
    const l = list(key);
    if (l.length >= 10) return;
    const copy = structuredClone(l[index] ?? freshEffect(key));
    const next = [...l];
    next.splice(index, 0, { ...copy, enabled: true });
    update({ [key]: next } as never);
    setPage({ key, index });
  };

  const removeInstance = () => {
    const { key, index } = page();
    if (!MULTI.has(key)) {
      if (key !== 'blending' && key !== 'styles') update({ [key === 'bevelContour' || key === 'bevelTexture' ? 'bevel' : key]: null } as never);
      setPage({ key: 'blending', index: 0 });
      return;
    }
    const l = list(key as Multi).filter((_, i) => i !== index);
    update({ [key]: l } as never);
    setPage(l.length ? { key, index: Math.max(0, index - 1) } : { key: 'blending', index: 0 });
  };

  const moveInstance = (d: -1 | 1) => {
    const { key, index } = page();
    if (!MULTI.has(key)) return;
    const l = [...list(key as Multi)];
    const j = index + d;
    if (j < 0 || j >= l.length) return;
    [l[index], l[j]] = [l[j]!, l[index]!];
    update({ [key]: l } as never);
    setPage({ key, index: j });
  };

  // Opened from an effect's menu item: that effect is switched on, as in Photoshop.
  if (props.payload.page && props.payload.page !== 'blending' && props.payload.page !== 'styles') ensure(props.payload.page);

  /** Rows of the left list: multi-instance effects get a row per instance. */
  const rows = createMemo(() =>
    STYLE_ITEMS.flatMap((item) => {
      if (!MULTI.has(item.key)) return [{ ...item, index: 0, count: 1 }];
      const n = Math.max(1, list(item.key as Multi).length);
      return Array.from({ length: n }, (_, index) => ({ ...item, index, count: n }));
    }),
  );

  const present = () => {
    const f = fx();
    return f.dropShadow.length + f.innerShadow.length + f.colorOverlay.length + f.gradientOverlay.length + f.stroke.length > 0 || !!(f.outerGlow || f.innerGlow || f.bevel || f.satin || f.patternOverlay);
  };
  const lightChanged = () => light().angle !== light0.angle || light().altitude !== light0.altitude;
  const props0 = () => ({ opacity: blend().opacity, fill: blend().fill, blendMode: blend().blendMode, blending: blend().blending });

  let timer = 0;
  createEffect(() => {
    const f = fx();
    const p = props0();
    const l = light();
    const on = preview();
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (on) props.send({ t: 'previewLayerStyle', id, effects: f, props: p, globalLight: l });
      else props.send({ t: 'previewLayerStyle', id, effects: null });
    }, 40);
  });
  onCleanup(() => clearTimeout(timer));

  const setAt = <K extends Multi | Single>(key: K, index: number) => (patch: object) => {
    if (MULTI.has(key)) update({ [key]: list(key as Multi).map((e, i) => (i === index ? { ...e, ...patch } : e)) } as never);
    else update({ [key]: { ...(single(key as Single) as object), ...patch } } as never);
  };
  const at = (key: Multi, index: number) => list(key)[index];
  const { fg, bg } = fgbg();

  return (
    <Dialog
      title="Layer Style"
      width={860}
      onOk={() => {
        clearTimeout(timer);
        props.send({ t: 'setLayerStyle', id, effects: present() ? fx() : null, props: props0(), globalLight: lightChanged() ? light() : undefined });
        props.onClose();
      }}
      onCancel={() => {
        clearTimeout(timer);
        props.send({ t: 'previewLayerStyle', id, effects: null });
        props.onClose();
      }}
    >
      <div class="fx-dialog">
        <div class="fx-list">
          <For each={rows()}>
            {(r) => (
              <div
                class="fx-item"
                classList={{ selected: page().key === r.key && page().index === r.index, sub: r.key === 'bevelContour' || r.key === 'bevelTexture', header: r.key === 'blending' || r.key === 'styles' }}
                onClick={() => {
                  ensure(r.key, r.index);
                  setPage({ key: r.key, index: r.index });
                }}
              >
                <Show when={r.key !== 'blending' && r.key !== 'styles'}>
                  <input type="checkbox" checked={checked(r.key, r.index)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.key, r.index)} />
                </Show>
                <span>{r.label}</span>
                <Show when={MULTI.has(r.key)}>
                  <button
                    type="button"
                    class="fx-plus"
                    title={`Add another ${r.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      addInstance(r.key as Multi, r.index);
                    }}
                  >
                    +
                  </button>
                </Show>
              </div>
            )}
          </For>
          <div class="fx-list-buttons">
            <Button width={28} title="Move the effect up" onClick={() => moveInstance(-1)}>
              ▲
            </Button>
            <Button width={28} title="Move the effect down" onClick={() => moveInstance(1)}>
              ▼
            </Button>
            <Button width={28} title="Delete the effect" onClick={removeInstance}>
              🗑
            </Button>
          </div>
        </div>
        <div class="fx-page">
          <h3 class="fx-title">{STYLE_ITEMS.find((i) => i.key === page().key)?.label}</h3>
          <Switch>
            <Match when={page().key === 'styles'}>
              <div class="styles-grid fx-styles">
                <For each={store.styles()}>
                  {(st) => (
                    <button type="button" class="style-cell" title={`${st.name} — replaces the effects here`} onClick={() => setFx(structuredClone(st.effects))}>
                      <StyleTile fx={st.effects} size={52} />
                    </button>
                  )}
                </For>
              </div>
            </Match>
            <Match when={page().key === 'blending'}>
              <BlendingPage value={blend()} set={(p) => setBlend({ ...blend(), ...p })} />
            </Match>
            <Match when={page().key === 'dropShadow' && at('dropShadow', page().index)}>
              <ShadowPage value={fx().dropShadow[page().index]!} set={setAt('dropShadow', page().index)} inner={false} light={light().angle} onLight={(a) => setLight({ ...light(), angle: a })} />
            </Match>
            <Match when={page().key === 'innerShadow' && at('innerShadow', page().index)}>
              <ShadowPage value={fx().innerShadow[page().index]!} set={setAt('innerShadow', page().index)} inner light={light().angle} onLight={(a) => setLight({ ...light(), angle: a })} />
            </Match>
            <Match when={page().key === 'outerGlow' && fx().outerGlow}>
              <GlowPage value={fx().outerGlow!} set={setAt('outerGlow', 0)} inner={false} fg={fg} />
            </Match>
            <Match when={page().key === 'innerGlow' && fx().innerGlow}>
              <GlowPage value={fx().innerGlow!} set={setAt('innerGlow', 0)} inner fg={fg} />
            </Match>
            <Match when={page().key === 'bevel' && fx().bevel}>
              <BevelPage value={fx().bevel!} set={setAt('bevel', 0)} light={light()} onLight={setLight} />
            </Match>
            <Match when={page().key === 'bevelContour' && fx().bevel}>
              <BevelContourPage value={fx().bevel!} set={setAt('bevel', 0)} />
            </Match>
            <Match when={page().key === 'bevelTexture' && fx().bevel}>
              <BevelTexturePage value={fx().bevel!} set={setAt('bevel', 0)} />
            </Match>
            <Match when={page().key === 'satin' && fx().satin}>
              <SatinPage value={fx().satin!} set={setAt('satin', 0)} />
            </Match>
            <Match when={page().key === 'colorOverlay' && at('colorOverlay', page().index)}>
              <ColorOverlayPage value={fx().colorOverlay[page().index]!} set={setAt('colorOverlay', page().index)} />
            </Match>
            <Match when={page().key === 'gradientOverlay' && at('gradientOverlay', page().index)}>
              <GradientOverlayPage value={fx().gradientOverlay[page().index]!} set={setAt('gradientOverlay', page().index)} />
            </Match>
            <Match when={page().key === 'patternOverlay' && fx().patternOverlay}>
              <PatternOverlayPage value={fx().patternOverlay!} set={setAt('patternOverlay', 0)} />
            </Match>
            <Match when={page().key === 'stroke' && at('stroke', page().index)}>
              <StrokePage value={fx().stroke[page().index]!} set={setAt('stroke', page().index)} fg={fg} bg={bg} />
            </Match>
          </Switch>
        </div>
        <div class="fx-side">
          <Button width={100} onClick={() => setNaming(true)} title="Add these effects to the Styles panel">
            New Style…
          </Button>
          <Show when={naming()}>
            <input
              class="styles-name"
              placeholder="Style name"
              value={styleName()}
              onInput={(e) => setStyleName(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  props.send({ t: 'newStyle', name: styleName(), effects: fx() });
                  setNaming(false);
                }
                if (e.key === 'Escape') setNaming(false);
              }}
            />
          </Show>
          <Checkbox checked={preview()} label="Preview" onChange={setPreview} />
          <StyleTile fx={fx()} light={light()} size={100} />
        </div>
      </div>
    </Dialog>
  );
}
