/**
 * Type layers — spec 02 §6, spec 03 §7. The type engine (HarfBuzz and the bundled fonts) is
 * loaded on first use; until then type layers keep whatever pixels they have (a PSD's own
 * rendering). Layouts are cached per text spec.
 */
import { rectIntersect, rectIsEmpty, type Rect } from '@umbra/core/geom';
import { compose, type Mat } from '@umbra/kernels/matrix';
import { FontRegistry, inkBounds, layoutText, layoutToPath, loadBundledFonts, loadHarfBuzz, renderLayout, type HB, type TextLayout, type TextSpec, type AntiAlias } from '@umbra/text';
import type { Path } from '@umbra/kernels/vector/path';
import { DEFAULT_BLENDING_STATE, NO_LOCKS, nextLayerId, type TypeLayer, type VectorLayer } from './document.js';
import { retransformShape } from './shape-layers.js';
import { MipPlane } from './tiles/mip.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { planeFromBitmap } from './psd-open.js';

export interface Size {
  width: number;
  height: number;
}

let hb: HB | null = null;
let registry: FontRegistry | null = null;
let loading: Promise<FontRegistry> | null = null;

/** Load HarfBuzz and the bundled fonts (once). */
export function ensureText(load?: (url: URL) => Promise<ArrayBuffer>): Promise<FontRegistry> {
  loading ??= (async () => {
    const h = await loadHarfBuzz();
    const reg = new FontRegistry(h);
    await loadBundledFonts(reg, load);
    hb = h;
    registry = reg;
    return reg;
  })();
  return loading;
}

/** For tests and the Node tools: install an already-built registry. */
export function setTextEngine(h: HB, reg: FontRegistry): void {
  hb = h;
  registry = reg;
  loading = Promise.resolve(reg);
}

export function textReady(): boolean {
  return !!registry;
}

export function fontRegistry(): FontRegistry | null {
  return registry;
}

const layouts = new WeakMap<TextSpec, TextLayout>();

export function layoutOf(spec: TextSpec): TextLayout | null {
  if (!registry || !hb) return null;
  let l = layouts.get(spec);
  if (!l) {
    l = layoutText(spec, { registry, hb });
    layouts.set(spec, l);
  }
  return l;
}

/** Which of a spec's fonts the registry lacks. */
export function missingFonts(spec: TextSpec): string[] {
  if (!registry) return [];
  const out = new Set<string>();
  for (const r of spec.runs) if (!registry.byPostscript(r.style.font) && !registry.match(r.style.family, r.style.fontStyle)) out.add(r.style.font);
  return [...out];
}

/** Render a type layer's pixels (null while the type engine is not loaded). */
export function renderType(layer: Pick<TypeLayer, 'text' | 'antiAlias' | 'transform'>, size: Size): MipPlane | null {
  const layout = layoutOf(layer.text);
  if (!layout) return null;
  const b = inkBounds(layout, layer.transform);
  if (!b) return new MipPlane(Plane.empty(RGBA8));
  const rect: Rect = rectIntersect({ x0: Math.floor(b.x0) - 1, y0: Math.floor(b.y0) - 1, x1: Math.ceil(b.x1) + 1, y1: Math.ceil(b.y1) + 1 }, { x0: 0, y0: 0, x1: size.width, y1: size.height });
  if (rectIsEmpty(rect)) return new MipPlane(Plane.empty(RGBA8));
  const bmp = renderLayout(layout, rect, layer.antiAlias, layer.transform);
  return new MipPlane(planeFromBitmap(bmp));
}

/** A type layer re-rendered after its text or transform changed (pixels kept if the engine is not loaded). */
export function retyped(layer: TypeLayer, size: Size): TypeLayer {
  const plane = renderType(layer, size);
  return plane ? { ...layer, plane, missingFonts: undefined } : layer;
}

export function makeTypeLayer(name: string, text: TextSpec, transform: Mat, antiAlias: AntiAlias, size: Size, over: Partial<TypeLayer> = {}): TypeLayer {
  const layer: TypeLayer = {
    kind: 'type',
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 1,
    fill: 1,
    blendMode: 'normal',
    clipped: false,
    locks: NO_LOCKS,
    color: 'none',
    blending: DEFAULT_BLENDING_STATE,
    seed: 0,
    text,
    antiAlias,
    transform,
    plane: new MipPlane(Plane.empty(RGBA8)),
    ...over,
  };
  return over.plane ? layer : retyped(layer, size);
}

/**
 * Transform a type layer: the matrix composes into its transform and the text is drawn again
 * from its outlines. Before the type engine is loaded the pixels are resampled instead, and
 * drawn properly at the next edit.
 */
export function retransformType(layer: TypeLayer, m: Mat, size: Size, planeFn: (p: Plane) => Plane): TypeLayer {
  const mask = layer.mask ? { ...layer.mask, plane: new MipPlane(planeFn(layer.mask.plane.base)) } : layer.mask;
  const next = { ...layer, mask, transform: compose(layer.transform, m) };
  const plane = renderType(next, size);
  return plane ? { ...next, plane } : { ...next, plane: new MipPlane(planeFn(layer.plane.base)) };
}

/** A type layer's outlines as a path, for Convert to Shape and Create Work Path. */
export function typePath(layer: TypeLayer): Path | null {
  const layout = layoutOf(layer.text);
  return layout ? layoutToPath(layout, layer.transform) : null;
}

/** A name from the text, as Photoshop names type layers: the first line, trimmed. */
export function typeLayerName(text: string): string {
  const first = text.split(/[\n\u2028]/)[0]!.trim();
  return first.length > 30 ? first.slice(0, 30) : first || 'Layer';
}

/** Shape or type: transformed exactly, from their vectors. */
export function retransformVector(layer: VectorLayer, m: Mat, size: Size, planeFn: (p: Plane) => Plane): VectorLayer {
  return layer.kind === 'shape' ? retransformShape(layer, m, size, planeFn) : retransformType(layer, m, size, planeFn);
}

/** A type layer's ink bounds in the document (its pixels' bounds before the engine loads). */
export function typeBounds(layer: TypeLayer): Rect {
  const layout = layoutOf(layer.text);
  const b = layout ? inkBounds(layout, layer.transform) : null;
  return b ?? layer.plane.base.bounds;
}
