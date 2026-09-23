/**
 * CPU reference compositor — docs/spec/06-compositing-math.md §3–§7.
 *
 * This is the authority for what a document looks like. The GPU compositor is tested against
 * it pixel-for-pixel (spec 03 §5.3), and it is also the path used for export and when no GL
 * context is available.
 *
 * Correctness over speed: it walks the layer tree per pixel through `sample` callbacks, which
 * keeps this module independent of the tile store and makes every rule in the spec visible in
 * one place. The tiled, typed-array fast path belongs with the export work, not here.
 */
import type { BlendMode } from '@umbra/core/blend';
import {
  applySpecialFill,
  compositePixel,
  dissolveNoise,
  hardMixWithFill,
  isSpecialFillMode,
  lum,
  type Composited,
  type Rgb,
} from './blend.js';

/** Straight-alpha RGBA sample. */
export interface Sample {
  color: Rgb;
  alpha: number;
}

export interface MaskInput {
  /** 0…1 coverage at a document pixel. */
  sample: (x: number, y: number) => number;
  enabled: boolean;
  /** Scales the mask's effect; 100% is a fully applied mask (spec 02 §2). */
  density: number;
}

export interface BlendIfRange {
  channel: 'gray' | 'r' | 'g' | 'b';
  /** Split slider stops, 0…1: black low, black high, white low, white high. */
  thisLayer: [number, number, number, number];
  underlying: [number, number, number, number];
}

export interface AdvancedBlending {
  /** Per-channel participation; excluded channels are restored from the backdrop. */
  channels: { r: boolean; g: boolean; b: boolean };
  knockout: 'none' | 'shallow' | 'deep';
  blendClippedLayersAsGroup: boolean;
  transparencyShapesLayer: boolean;
  blendIf: BlendIfRange[];
}

export const DEFAULT_BLENDING: AdvancedBlending = {
  channels: { r: true, g: true, b: true },
  knockout: 'none',
  blendClippedLayersAsGroup: true,
  transparencyShapesLayer: true,
  blendIf: [],
};

export interface CompositeLayer {
  kind: 'pixel' | 'group' | 'adjustment';
  name?: string;
  visible: boolean;
  /** 0…1 */
  opacity: number;
  /** 0…1 */
  fill: number;
  blendMode: BlendMode;
  clipped: boolean;
  blending: AdvancedBlending;
  mask?: MaskInput;
  /** Pixel layers only. */
  sample?: (x: number, y: number) => Sample;
  /** Group layers only, bottom-most first. */
  children?: CompositeLayer[];
  /** Adjustment layers only: the colour function applied to the backdrop (spec 06 §8). */
  adjust?: (backdrop: Rgb) => Rgb;
  /** Seed for Dissolve, so the pattern is stable per layer. */
  seed?: number;
}

const TRANSPARENT: Composited = { color: [0, 0, 0], alpha: 0 };

/** Trapezoidal weight from one split slider (spec 06 §5). */
function rampWeight(v: number, [b0, b1, w0, w1]: [number, number, number, number]): number {
  if (v < b0) return 0;
  if (v < b1) return b1 === b0 ? 1 : (v - b0) / (b1 - b0);
  if (v <= w0) return 1;
  if (v <= w1) return w1 === w0 ? 0 : 1 - (v - w0) / (w1 - w0);
  return 0;
}

function channelValue(c: Rgb, channel: BlendIfRange['channel']): number {
  switch (channel) {
    case 'r':
      return c[0];
    case 'g':
      return c[1];
    case 'b':
      return c[2];
    default:
      return lum(c);
  }
}

function blendIfWeight(ranges: BlendIfRange[], source: Rgb, backdrop: Rgb): number {
  let w = 1;
  for (const r of ranges) {
    w *= rampWeight(channelValue(source, r.channel), r.thisLayer);
    w *= rampWeight(channelValue(backdrop, r.channel), r.underlying);
    if (w <= 0) return 0;
  }
  return w;
}

/** Restore channels the layer is not allowed to affect. */
function applyChannelMask(result: Composited, backdrop: Composited, channels: AdvancedBlending['channels']): Composited {
  if (channels.r && channels.g && channels.b) return result;
  const color: Rgb = [
    channels.r ? result.color[0] : backdrop.color[0],
    channels.g ? result.color[1] : backdrop.color[1],
    channels.b ? result.color[2] : backdrop.color[2],
  ];
  return { color, alpha: result.alpha };
}

interface Ctx {
  x: number;
  y: number;
  /** Backdrop at the entry of the nearest enclosing group, for shallow knockout. */
  groupEntry: Composited;
  /** Document bottom, for deep knockout. */
  documentBase: Composited;
}

/**
 * Composite an ordered list of sibling layers (bottom-most first) onto a backdrop.
 */
export function compositeLayers(
  layers: readonly CompositeLayer[],
  backdrop: Composited,
  ctx: Ctx,
): Composited {
  let acc = backdrop;
  let i = 0;
  while (i < layers.length) {
    const layer = layers[i]!;
    if (!layer.visible) {
      i++;
      continue;
    }

    // A clipping group is a base layer plus the contiguous run of clipped layers above it.
    let n = 0;
    while (i + 1 + n < layers.length && layers[i + 1 + n]!.clipped) n++;

    acc = n > 0
      ? compositeClipGroup(layer, layers.slice(i + 1, i + 1 + n), acc, ctx)
      : compositeOne(layer, acc, ctx);
    i += 1 + n;
  }
  return acc;
}

/** Shape alpha of a layer before opacity: pixel alpha × masks. */
function shapeAlpha(layer: CompositeLayer, x: number, y: number, pixelAlpha: number): number {
  let a = pixelAlpha;
  const m = layer.mask;
  if (m && m.enabled) {
    // Density < 100% limits how much the mask can hide (spec 02 §2).
    const coverage = m.sample(x, y);
    a *= 1 - m.density * (1 - coverage);
  }
  return a;
}

function compositeOne(layer: CompositeLayer, backdrop: Composited, ctx: Ctx): Composited {
  if (layer.kind === 'group') return compositeGroup(layer, backdrop, ctx);
  if (layer.kind === 'adjustment') return compositeAdjustment(layer, backdrop, ctx);

  const s = layer.sample!(ctx.x, ctx.y);
  const special = isSpecialFillMode(layer.blendMode);

  // Fill scales coverage for ordinary modes, but is folded into the colour for the special 8.
  const fillAsCoverage = special ? 1 : layer.fill;
  let alpha = shapeAlpha(layer, ctx.x, ctx.y, s.alpha) * fillAsCoverage * layer.opacity;
  if (alpha <= 0) return backdrop;

  let color: Rgb = special ? applySpecialFill(layer.blendMode, s.color, layer.fill) : s.color;

  if (layer.blending.blendIf.length > 0) {
    alpha *= blendIfWeight(layer.blending.blendIf, s.color, backdrop.color);
    if (alpha <= 0) return backdrop;
  }

  if (layer.blendMode === 'dissolve') {
    // Coverage becomes binary rather than partial.
    alpha = alpha > dissolveNoise(ctx.x, ctx.y, layer.seed ?? 0) ? 1 : 0;
    if (alpha <= 0) return backdrop;
  }

  const base = knockoutBackdrop(layer, backdrop, ctx);

  let result: Composited;
  if (layer.blendMode === 'hardMix' && layer.fill < 1) {
    // Hard Mix needs the backdrop inside the blend, so it cannot use the generic path.
    const blended: Rgb = [
      hardMixWithFill(base.color[0], s.color[0], layer.fill),
      hardMixWithFill(base.color[1], s.color[1], layer.fill),
      hardMixWithFill(base.color[2], s.color[2], layer.fill),
    ];
    result = compositePixel('normal', base.color, base.alpha, blended, alpha);
  } else {
    result = compositePixel(layer.blendMode, base.color, base.alpha, color, alpha);
  }

  return applyChannelMask(result, backdrop, layer.blending.channels);
}

/**
 * Adjustment layer — spec 06 §8. The layer's "source" is its function of the backdrop, its
 * coverage is mask × opacity × fill, and it adds no coverage of its own: the result keeps the
 * backdrop's alpha, so an adjustment over transparency stays transparent.
 *
 * Fill acts as a second opacity here, including for the eight special-fill modes — there is
 * no content colour for Fill to fold into.
 */
function compositeAdjustment(layer: CompositeLayer, backdrop: Composited, ctx: Ctx): Composited {
  if (backdrop.alpha <= 0 || !layer.adjust) return backdrop;
  const adjusted = layer.adjust(backdrop.color);
  let alpha = shapeAlpha(layer, ctx.x, ctx.y, 1) * layer.fill * layer.opacity;
  if (layer.blending.blendIf.length > 0) {
    alpha *= blendIfWeight(layer.blending.blendIf, adjusted, backdrop.color);
  }
  if (alpha <= 0) return backdrop;
  // Against an opaque backdrop the general equation reduces to mix(Cb, B(Cb, f(Cb)), α).
  const over = compositePixel(layer.blendMode, backdrop.color, 1, adjusted, alpha);
  return applyChannelMask({ color: over.color, alpha: backdrop.alpha }, backdrop, layer.blending.channels);
}

/** Replace the backdrop inside the layer's shape, for knockout (spec 06 §7). */
function knockoutBackdrop(layer: CompositeLayer, backdrop: Composited, ctx: Ctx): Composited {
  if (layer.blending.knockout === 'none') return backdrop;
  return layer.blending.knockout === 'deep' ? ctx.documentBase : ctx.groupEntry;
}

function compositeGroup(group: CompositeLayer, backdrop: Composited, ctx: Ctx): Composited {
  const children = group.children ?? [];
  const maskAndOpacity =
    shapeAlpha(group, ctx.x, ctx.y, 1) * group.opacity;

  if (group.blendMode === 'passThrough') {
    // Children composite straight onto the running backdrop, so adjustment layers inside a
    // pass-through group affect everything below it. Group opacity/mask then cross-fade the
    // result against what the backdrop was before the group ran.
    const inner = compositeLayers(children, backdrop, { ...ctx, groupEntry: backdrop });
    if (maskAndOpacity >= 1) return inner;
    return lerpComposited(backdrop, inner, maskAndOpacity);
  }

  // Isolated group: children composite onto transparency, then the result blends as one layer.
  const inner = compositeLayers(children, TRANSPARENT, { ...ctx, groupEntry: TRANSPARENT });
  const alpha = inner.alpha * maskAndOpacity;
  if (alpha <= 0) return backdrop;
  const result = compositePixel(group.blendMode, backdrop.color, backdrop.alpha, inner.color, alpha);
  return applyChannelMask(result, backdrop, group.blending.channels);
}

/** Premultiplied cross-fade, used for pass-through group opacity. */
function lerpComposited(a: Composited, b: Composited, t: number): Composited {
  const alpha = a.alpha + (b.alpha - a.alpha) * t;
  if (alpha <= 0) return TRANSPARENT;
  const color: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const pa = a.color[i]! * a.alpha;
    const pb = b.color[i]! * b.alpha;
    color[i] = (pa + (pb - pa) * t) / alpha;
  }
  return { color, alpha };
}

/**
 * Clipping group (spec 06 §6): the clipped layers are confined to the base layer's alpha, and
 * with "Blend Clipped Layers as Group" on (the default) the whole stack blends to the backdrop
 * with the BASE layer's mode and opacity.
 */
function compositeClipGroup(
  base: CompositeLayer,
  clipped: readonly CompositeLayer[],
  backdrop: Composited,
  ctx: Ctx,
): Composited {
  if (base.kind === 'group' || !base.sample) {
    // A group acting as a clipping base still clips, but its content is composited normally.
    let acc = compositeOne(base, backdrop, ctx);
    for (const c of clipped) acc = compositeOne(c, acc, ctx);
    return acc;
  }

  const baseSample = base.sample(ctx.x, ctx.y);
  const baseAlpha = shapeAlpha(base, ctx.x, ctx.y, baseSample.alpha);
  if (baseAlpha <= 0) return backdrop;

  if (!base.blending.blendClippedLayersAsGroup) {
    // Each clipped layer blends directly to the backdrop, its coverage limited by the base.
    let acc = compositeOne(base, backdrop, ctx);
    for (const c of clipped) {
      const limited: CompositeLayer = {
        ...c,
        sample: (x, y) => {
          const s = c.sample!(x, y);
          return { color: s.color, alpha: s.alpha * baseAlpha };
        },
      };
      acc = compositeOne(limited, acc, ctx);
    }
    return acc;
  }

  // Build the clipped stack on top of the base's colour, treating it as opaque, then blend the
  // whole thing to the backdrop using the base's alpha.
  let stack: Composited = { color: baseSample.color, alpha: 1 };
  for (const c of clipped) {
    if (!c.visible) continue;
    stack = compositeOne(c, stack, { ...ctx, groupEntry: stack });
  }

  const special = isSpecialFillMode(base.blendMode);
  const alpha = baseAlpha * (special ? 1 : base.fill) * base.opacity;
  const color = special ? applySpecialFill(base.blendMode, stack.color, base.fill) : stack.color;
  const result = compositePixel(base.blendMode, backdrop.color, backdrop.alpha, color, alpha);
  return applyChannelMask(result, backdrop, base.blending.channels);
}

/** Composite a whole document at one pixel. */
export function compositeDocument(
  layers: readonly CompositeLayer[],
  x: number,
  y: number,
  base: Composited = TRANSPARENT,
): Composited {
  return compositeLayers(layers, base, { x, y, groupEntry: base, documentBase: base });
}

/** Render a rectangle into an RGBA8 buffer (straight alpha), for tests and export. */
export function renderRegion(
  layers: readonly CompositeLayer[],
  width: number,
  height: number,
  out = new Uint8ClampedArray(width * height * 4),
): Uint8ClampedArray {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = compositeDocument(layers, x, y);
      const o = (y * width + x) * 4;
      out[o] = Math.round(px.color[0] * 255);
      out[o + 1] = Math.round(px.color[1] * 255);
      out[o + 2] = Math.round(px.color[2] * 255);
      out[o + 3] = Math.round(px.alpha * 255);
    }
  }
  return out;
}

/** Convenience: a solid-colour pixel layer, used heavily by the golden tests. */
export function solidLayer(
  color: Rgb,
  alpha: number,
  over: Partial<CompositeLayer> = {},
): CompositeLayer {
  return {
    kind: 'pixel',
    visible: true,
    opacity: 1,
    fill: 1,
    blendMode: 'normal',
    clipped: false,
    blending: DEFAULT_BLENDING,
    sample: () => ({ color, alpha }),
    ...over,
  };
}
