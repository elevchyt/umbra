/**
 * The M0 slice of the document model. The full model (spec 02) arrives in M2; this keeps
 * only what the viewport needs so the renderer and tile store can be exercised end to end.
 */
import type { BlendMode } from '@umbra/core/blend';
import { rectFromSize, type Rect } from '@umbra/core/geom';
import { MipPlane } from './tiles/mip.js';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';

export interface Layer {
  readonly id: number;
  readonly name: string;
  readonly plane: MipPlane;
  readonly opacity: number;
  readonly fill: number;
  readonly visible: boolean;
  readonly blendMode: BlendMode;
  /** Set while a live stroke is painting straight into the atlas (premultiplied). */
  readonly premultiplied: boolean;
}

export interface Doc {
  readonly width: number;
  readonly height: number;
  readonly name: string;
  /** Bottom-most first, i.e. the reverse of the Layers panel's display order. */
  readonly layers: readonly Layer[];
}

let nextLayerId = 1;

export function makeLayer(name: string, plane: Plane, over: Partial<Layer> = {}): Layer {
  return {
    id: nextLayerId++,
    name,
    plane: new MipPlane(plane),
    opacity: 1,
    fill: 1,
    visible: true,
    blendMode: 'normal',
    premultiplied: false,
    ...over,
  };
}

export function emptyDoc(width = 1920, height = 1080, name = 'Untitled-1'): Doc {
  return { width, height, name, layers: [] };
}

export function docRect(doc: Doc): Rect {
  return rectFromSize(doc.width, doc.height);
}

export function replaceLayer(doc: Doc, id: number, next: Layer): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? next : l)) };
}

export function addLayer(doc: Doc, layer: Layer): Doc {
  return { ...doc, layers: [...doc.layers, layer] };
}

export function newPixelPlane(): Plane {
  return Plane.empty(RGBA8);
}
