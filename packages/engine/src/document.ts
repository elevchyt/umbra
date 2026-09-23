/**
 * Document model — docs/spec/02-document-model.md.
 *
 * The tree is an immutable value: every edit produces a new `Doc` that shares untouched
 * subtrees and every untouched tile with the old one (spec 03 §6). That is what makes undo a
 * pointer swap rather than a copy, and it is why nothing here mutates in place.
 */
import type { BlendMode } from '@umbra/core/blend';
import { rectFromSize, type Rect } from '@umbra/core/geom';
import { MipPlane } from './tiles/mip.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import type { AdvancedBlending } from '@umbra/kernels/composite';
import type { Adjustment } from '@umbra/kernels/adjust';
import type { Selection } from './selection.js';

export type LabelColor =
  | 'none'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'violet'
  | 'gray';

export interface LayerLocks {
  transparency: boolean;
  pixels: boolean;
  position: boolean;
  all: boolean;
}

export const NO_LOCKS: LayerLocks = {
  transparency: false,
  pixels: false,
  position: false,
  all: false,
};

export const DEFAULT_BLENDING_STATE: AdvancedBlending = {
  channels: { r: true, g: true, b: true },
  knockout: 'none',
  blendClippedLayersAsGroup: true,
  transparencyShapesLayer: true,
  blendIf: [],
};

export interface RasterMask {
  plane: MipPlane;
  enabled: boolean;
  linked: boolean;
  /** 0…1; how strongly the mask is applied (Properties ▸ Masks). */
  density: number;
  /** Gaussian feather in document pixels. */
  feather: number;
  /** Value outside the mask's stored bounds: 0 hides, 1 reveals. */
  defaultColor: 0 | 1;
}

export interface LayerBase {
  readonly id: number;
  readonly name: string;
  readonly visible: boolean;
  /** 0…1 */
  readonly opacity: number;
  /** 0…1 */
  readonly fill: number;
  readonly blendMode: BlendMode;
  readonly clipped: boolean;
  readonly locks: LayerLocks;
  readonly color: LabelColor;
  readonly mask?: RasterMask;
  readonly blending: AdvancedBlending;
  /** Dissolve pattern seed, stable across edits. */
  readonly seed: number;
  /** PSD blocks we did not interpret, re-emitted verbatim on save (spec 07 §1.1). */
  readonly psdExtra?: unknown;
}

export interface PixelLayer extends LayerBase {
  readonly kind: 'pixel';
  readonly plane: MipPlane;
}

export interface GroupLayer extends LayerBase {
  readonly kind: 'group';
  readonly children: readonly Layer[];
  readonly expanded: boolean;
}

/**
 * An adjustment layer: no pixels, only a function of whatever is composited beneath it
 * (spec 02 §3, spec 06 §8). Its mask limits where it applies, exactly as a pixel layer's does.
 */
export interface AdjustmentLayer extends LayerBase {
  readonly kind: 'adjustment';
  readonly adjustment: Adjustment;
}

export type Layer = PixelLayer | GroupLayer | AdjustmentLayer;

/**
 * A stored alpha channel — Photoshop's "saved selection". It is a coverage plane with a
 * display colour and opacity, which is all a spot channel needs too, so spot channels arrive
 * as a flag on this rather than as a second type.
 */
export interface AlphaChannel {
  readonly id: number;
  readonly name: string;
  readonly plane: MipPlane;
  /** Overlay colour when the channel is shown alongside the composite. */
  readonly color: readonly [number, number, number];
  /** 0…1 overlay opacity. */
  readonly opacity: number;
  readonly visible: boolean;
  /**
   * Photoshop asks whether the channel's stored values mean "masked area" or "selected area".
   * It only changes what the overlay paints and how a load interprets it, not the pixels.
   */
  readonly indicates: 'masked' | 'selected';
}

export interface Doc {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Bottom-most first, matching PSD storage and the compositor's walk order. */
  readonly layers: readonly Layer[];
  readonly activeLayerIds: readonly number[];
  /** Active selection; null means "no selection", which edits treat as "everywhere". */
  readonly selection: Selection | null;
  /** Saved selections and spot channels, in panel order below the colour channels. */
  readonly channels: readonly AlphaChannel[];
  /** Bottom layer is a locked Background (no alpha, no mode). */
  readonly hasBackground: boolean;
  readonly dirty: boolean;
}

let nextId = 1;
export function nextLayerId(): number {
  return nextId++;
}

export function makePixelLayer(name: string, plane: Plane, over: Partial<PixelLayer> = {}): PixelLayer {
  return {
    kind: 'pixel',
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
    plane: new MipPlane(plane),
    ...over,
  };
}

export function makeGroup(name: string, children: Layer[], over: Partial<GroupLayer> = {}): GroupLayer {
  return {
    kind: 'group',
    id: nextLayerId(),
    name,
    visible: true,
    opacity: 1,
    fill: 1,
    blendMode: 'passThrough',
    clipped: false,
    locks: NO_LOCKS,
    color: 'none',
    blending: DEFAULT_BLENDING_STATE,
    seed: 0,
    children,
    expanded: true,
    ...over,
  };
}

export function makeAdjustmentLayer(
  name: string,
  adjustment: Adjustment,
  over: Partial<AdjustmentLayer> = {},
): AdjustmentLayer {
  return {
    kind: 'adjustment',
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
    adjustment,
    ...over,
  };
}

export function emptyDoc(width = 1920, height = 1080, name = 'Untitled-1'): Doc {
  return {
    name,
    width,
    height,
    layers: [],
    activeLayerIds: [],
    selection: null,
    channels: [],
    hasBackground: false,
    dirty: false,
  };
}

export function docRect(doc: Doc): Rect {
  return rectFromSize(doc.width, doc.height);
}

export function newPixelPlane(): Plane {
  return Plane.empty(RGBA8);
}

// ---- tree traversal --------------------------------------------------------------------

/** Depth-first walk, groups before their children. */
export function* walkLayers(
  layers: readonly Layer[],
  depth = 0,
): Generator<{ layer: Layer; depth: number }> {
  for (const l of layers) {
    yield { layer: l, depth };
    if (l.kind === 'group') yield* walkLayers(l.children, depth + 1);
  }
}

export function findLayer(layers: readonly Layer[], id: number): Layer | undefined {
  for (const { layer } of walkLayers(layers)) if (layer.id === id) return layer;
  return undefined;
}

export function countLayers(layers: readonly Layer[]): number {
  let n = 0;
  for (const _ of walkLayers(layers)) n++;
  return n;
}

/** Replace one layer anywhere in the tree, sharing every untouched branch. */
export function replaceLayer(layers: readonly Layer[], id: number, next: Layer): Layer[] {
  return layers.map((l) => {
    if (l.id === id) return next;
    if (l.kind === 'group') {
      const children = replaceLayer(l.children, id, next);
      return children === l.children ? l : { ...l, children };
    }
    return l;
  });
}

/** Apply a patch to one layer. */
export function updateLayer(
  layers: readonly Layer[],
  id: number,
  patch: (l: Layer) => Layer,
): Layer[] {
  return layers.map((l) => {
    if (l.id === id) return patch(l);
    if (l.kind === 'group') {
      const children = updateLayer(l.children, id, patch);
      return children === l.children ? l : { ...l, children };
    }
    return l;
  });
}

export function removeLayer(layers: readonly Layer[], id: number): Layer[] {
  const out: Layer[] = [];
  for (const l of layers) {
    if (l.id === id) continue;
    if (l.kind === 'group') {
      const children = removeLayer(l.children, id);
      out.push(children === l.children ? l : { ...l, children });
    } else {
      out.push(l);
    }
  }
  return out;
}

/** Insert `layer` immediately above `belowId`, or at the top when it is undefined. */
export function insertLayer(
  layers: readonly Layer[],
  layer: Layer,
  belowId?: number,
): Layer[] {
  if (belowId === undefined) return [...layers, layer];
  const out: Layer[] = [];
  let placed = false;
  for (const l of layers) {
    if (l.kind === 'group') {
      const children = insertLayer(l.children, layer, belowId);
      if (children !== l.children && children.length !== l.children.length) {
        out.push({ ...l, children });
        placed = true;
        continue;
      }
    }
    out.push(l);
    if (l.id === belowId) {
      out.push(layer);
      placed = true;
    }
  }
  return placed ? out : [...layers, layer];
}

/** Flattened display order for the Layers panel: top-most first, groups above their children. */
export interface PanelRow {
  layer: Layer;
  depth: number;
}

export function panelRows(layers: readonly Layer[], depth = 0): PanelRow[] {
  const out: PanelRow[] = [];
  // The panel shows the topmost layer first, which is the reverse of storage order.
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    out.push({ layer: l, depth });
    if (l.kind === 'group' && l.expanded) out.push(...panelRows(l.children, depth + 1));
  }
  return out;
}

export function totalTiles(layers: readonly Layer[]): number {
  let n = 0;
  for (const { layer } of walkLayers(layers)) {
    if (layer.kind === 'pixel') n += layer.plane.base.tileCount;
    if (layer.mask) n += layer.mask.plane.base.tileCount;
  }
  return n;
}
