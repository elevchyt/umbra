/**
 * Layer effects in the render tree — spec 06 §9.
 *
 * A layer with effects is drawn as the layer plus generated pixel layers: the effects below
 * its content (Drop Shadows, Outer Glow) just before it, the ones above (overlays, Satin,
 * Inner Glow/Shadow, Stroke, Bevel) just after it — and after any layers clipped to it, so
 * they still clip to its content. Each generated layer carries its effect's blend mode and
 * the effect's opacity times the layer's, with the layer's shape already baked into its
 * coverage. Both compositors (GPU and the CPU reference) draw them as ordinary layers.
 *
 * Effects are computed on the CPU over the layer's bounds grown by the effects' reach, and
 * cached per layer until its pixels, mask, effects, the global light or the canvas change.
 */
import { rectIntersect, rectIsEmpty, type Rect } from '@umbra/core/geom';
import { DEFAULT_GLOBAL_LIGHT, effectsReach, hasVisibleEffects, renderEffects, type GlobalLight, type LayerEffects } from '@umbra/kernels/effects/index';
import { DEFAULT_BLENDING_STATE, NO_LOCKS, type Doc, type Layer, type PixelLayer } from './document.js';
import { MipPlane } from './tiles/mip.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { planeFromBitmap } from './psd-open.js';
import { bitmapFromPlane, tightBounds } from './psd-save.js';

export interface EffectsContext {
  width: number;
  height: number;
  globalLight?: GlobalLight;
}

/** A generated layer, tagged with the layer whose effect it draws (for live transforms). */
export type EffectLayer = PixelLayer & { readonly effectOf: number };

interface Entry {
  plane: Plane | null;
  mask: Plane | null;
  maskOn: boolean;
  effects: LayerEffects;
  light: string;
  size: string;
  below: EffectLayer[];
  above: EffectLayer[];
}

/** Per-layer effect renders, kept across frames. */
export class EffectsCache {
  private entries = new Map<number, Entry>();
  get(layer: Layer, ctx: EffectsContext): { below: EffectLayer[]; above: EffectLayer[] } | null {
    const fx = layer.effects;
    if (!hasVisibleEffects(fx)) return null;
    if (layer.kind === 'adjustment' || layer.kind === 'group') return null;
    const plane = layer.kind === 'fill' ? null : layer.plane.base;
    const mask = layer.mask?.plane.base ?? null;
    const maskOn = !!layer.mask?.enabled;
    const light = JSON.stringify(ctx.globalLight ?? DEFAULT_GLOBAL_LIGHT);
    const size = `${ctx.width}x${ctx.height}`;
    const hit = this.entries.get(layer.id);
    if (hit && hit.plane === plane && hit.mask === mask && hit.maskOn === maskOn && hit.effects === fx && hit.light === light && hit.size === size) return hit;
    const made = generate(layer, fx, ctx);
    const entry: Entry = { plane, mask, maskOn, effects: fx, light, size, ...made };
    this.entries.set(layer.id, entry);
    return entry;
  }
  clear(): void {
    this.entries.clear();
  }
}

/** The layer's coverage over `rect`, after its mask: the shape effects are drawn from. */
function shapeOf(layer: Layer, rect: Rect): Float32Array {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const s = new Float32Array(w * h);
  if (layer.kind === 'fill') s.fill(1);
  else if (layer.kind === 'pixel' || layer.kind === 'smart') {
    const px = bitmapFromPlane(layer.plane.base, rect).data;
    for (let i = 0; i < s.length; i++) s[i] = px[i * 4 + 3]! / 255;
  }
  const m = layer.mask;
  if (m?.enabled) {
    const mp = bitmapFromPlane(m.plane.base, rect).data;
    for (let i = 0; i < s.length; i++) s[i] = s[i]! * (1 - m.density * (1 - mp[i * 4]! / 255));
  }
  return s;
}

function generate(layer: Layer, fx: LayerEffects, ctx: EffectsContext): { below: EffectLayer[]; above: EffectLayer[] } {
  const canvas: Rect = { x0: 0, y0: 0, x1: ctx.width, y1: ctx.height };
  const content = layer.kind === 'pixel' || layer.kind === 'smart' ? tightBounds(layer.plane.base) : canvas;
  if (rectIsEmpty(content)) return { below: [], above: [] };
  const reach = effectsReach(fx);
  const rect = rectIntersect({ x0: content.x0 - reach, y0: content.y0 - reach, x1: content.x1 + reach, y1: content.y1 + reach }, canvas);
  if (rectIsEmpty(rect)) return { below: [], above: [] };
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const shape = shapeOf(layer, rect);
  const rendered = renderEffects(fx, {
    shape,
    width: w,
    height: h,
    originX: rect.x0,
    originY: rect.y0,
    docWidth: ctx.width,
    docHeight: ctx.height,
    bounds: rectIntersect(content, canvas),
    light: ctx.globalLight ?? DEFAULT_GLOBAL_LIGHT,
  });
  let k = 0;
  const toLayer = (e: (typeof rendered.below)[number]): EffectLayer => ({
    kind: 'pixel',
    // Generated ids are negative and never collide with a real layer's.
    id: -(layer.id * 64 + ++k),
    name: `${layer.name} ▸ ${e.name}`,
    visible: true,
    opacity: e.opacity,
    fill: 1,
    blendMode: e.blendMode,
    clipped: false,
    locks: NO_LOCKS,
    color: 'none',
    blending: DEFAULT_BLENDING_STATE,
    seed: 0,
    plane: new MipPlane(planeFromBitmap({ data: e.data as unknown as Uint8Array, width: w, height: h, left: rect.x0, top: rect.y0 })),
    effectOf: layer.id,
  });
  return { below: rendered.below.map(toLayer), above: rendered.above.map(toLayer) };
}

/** Fold the layer's own visibility, opacity and clipping into a generated layer. */
const place = (e: EffectLayer, layer: Layer, clipped: boolean): EffectLayer => ({ ...e, visible: layer.visible, opacity: e.opacity * layer.opacity, clipped });

/**
 * The layer list with every layer's effects spliced in as generated layers. Without any
 * effects the input comes back unchanged (same array), so callers pay nothing.
 */
export function expandEffects(layers: readonly Layer[], ctx: EffectsContext, cache: EffectsCache = new EffectsCache()): readonly Layer[] {
  let any = false;
  const out: Layer[] = [];
  const nodes = (l: Layer, clipped: boolean): Layer[] => {
    const node = l.kind === 'group' ? withChildren(l) : l;
    const fx = l.visible ? cache.get(l, ctx) : null;
    if (!fx) return [node];
    any = true;
    return [...fx.below.map((e) => place(e, l, clipped)), node, ...fx.above.map((e) => place(e, l, clipped))];
  };
  const withChildren = (g: Extract<Layer, { kind: 'group' }>): Layer => {
    const children = expandEffects(g.children, ctx, cache);
    if (children === g.children) return g;
    any = true;
    return { ...g, children };
  };
  let i = 0;
  while (i < layers.length) {
    const l = layers[i]!;
    const fx = l.visible && !l.clipped ? cache.get(l, ctx) : null;
    if (!fx) {
      out.push(...nodes(l, l.clipped));
      i++;
      continue;
    }
    any = true;
    // Layers clipped to this one stay clipped to its content, so its upper effects wait
    // until after them.
    let j = i + 1;
    const followers: Layer[] = [];
    while (j < layers.length && layers[j]!.clipped) followers.push(...nodes(layers[j]!, true)), j++;
    const node = l.kind === 'group' ? withChildren(l) : l;
    if (l.opacity >= 1) {
      out.push(...fx.below.map((e) => place(e, l, false)), node, ...followers, ...fx.above.map((e) => place(e, l, false)));
    } else {
      // Opacity applies to the layer and its effects together, as one: a pass-through group
      // cross-fades the lot against the backdrop, where scaling each piece would let the
      // overlays stack up (50 % content under a 50 % overlay would show 75 %).
      out.push({
        ...node,
        kind: 'group',
        id: -(l.id * 64),
        name: `${l.name} ▸ Effects`,
        visible: l.visible,
        opacity: l.opacity,
        fill: 1,
        blendMode: 'passThrough',
        clipped: false,
        mask: undefined,
        blending: DEFAULT_BLENDING_STATE,
        expanded: true,
        children: [...fx.below, { ...node, opacity: 1 } as Layer, ...followers, ...fx.above],
      } as Layer);
    }
    i = j;
  }
  return any ? out : layers;
}
