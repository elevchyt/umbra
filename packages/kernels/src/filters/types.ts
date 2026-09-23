/**
 * The filter registry's shape — spec 03 §8. One declaration drives the menu item's
 * enablement, the auto-generated dialog, the CPU implementation, region-of-interest execution
 * for previews, Last Filter, and the tests.
 */
import type { Raster } from './core.js';

export type ParamSpec =
  | {
      key: string;
      label: string;
      type: 'number';
      min: number;
      max: number;
      step?: number;
      default: number;
      /** Suffix shown after the field: 'px', '%', '°'. */
      unit?: string;
      /** Slider response: logarithmic for radii that span 0.1…1000. */
      scale?: 'log';
      precision?: number;
    }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; default: string }
  | { key: string; label: string; type: 'bool'; default: boolean }
  /** A position picked in the preview, as fractions of the canvas (Radial Blur, Lens Flare). */
  | { key: string; label: string; type: 'point'; default: { x: number; y: number } }
  /** Custom's 5×5 grid of integers. */
  | { key: string; label: string; type: 'kernel'; size: number; default: number[] }
  /** A Randomize button: an integer seed. */
  | { key: string; label: string; type: 'seed'; default: number }
  /** Another layer of the document (Displace's map, Lens Blur's depth): its id, or -1 for none. */
  | { key: string; label: string; type: 'layer'; default: number }
  /** The Filter Gallery's effect layers, as JSON: `GalleryLayer[]`. */
  | { key: string; label: string; type: 'stack'; default: string };

export type ParamValue = number | string | boolean | { x: number; y: number } | number[];
export type FilterParams = Record<string, ParamValue>;

export interface FilterContext {
  /** Where this raster's (0,0) sits in the document, and the document's size: filters whose
   *  pattern is anchored to the canvas (Clouds, Mosaic grids, noise, a Lens Flare's centre)
   *  must give the same pixel the same value in a preview crop and in the full run. */
  originX: number;
  originY: number;
  docWidth: number;
  docHeight: number;
  foreground: [number, number, number];
  background: [number, number, number];
  /** Selection coverage over this raster (0…255), for Average; null means everywhere. */
  coverage: Uint8Array | null;
  /** The 'layer' parameter's pixels, the same crop as the source; null when none is chosen. */
  map?: Raster | null;
  /**
   * The area the filter acts on, in document pixels: the selection's bounds, or the canvas.
   * Pinch, Spherize, Twirl and friends are centred and sized on it, as in Photoshop.
   */
  bounds?: { x0: number; y0: number; x1: number; y1: number };
}

export type FilterCategory = 'Blur' | 'Distort' | 'Noise' | 'Pixelate' | 'Render' | 'Sharpen' | 'Stylize' | 'Video' | 'Other' | 'Gallery';

/** The Filter Gallery's folders — spec 05 §B.10. */
export type GalleryCategory = 'Artistic' | 'Brush Strokes' | 'Distort' | 'Sketch' | 'Stylize' | 'Texture';

/** One Filter Gallery effect: a filter that lives only inside the gallery. */
export interface GalleryEffect extends Omit<FilterDef, 'category'> {
  category: GalleryCategory;
}

/** One effect layer of the gallery's stack. */
export interface GalleryLayer {
  id: string;
  params: FilterParams;
  visible: boolean;
}

export interface FilterDef {
  /** The menu command id, e.g. 'blur.gaussianblur'. */
  id: string;
  label: string;
  category: FilterCategory;
  params: ParamSpec[];
  /**
   * Pixels of context each output pixel reads, for region-of-interest execution: a preview
   * crop is computed from the crop grown by this much. 'full' when every output pixel may
   * read anywhere (Twirl, Offset, Average).
   */
  pad: (p: FilterParams) => number | 'full';
  run: (src: Raster, p: FilterParams, ctx: FilterContext) => Raster;
  /** `[fit]` notes: what the model is and what would settle it. Shown nowhere; kept honest. */
  model?: string;
}

export function defaultsOf(def: Pick<FilterDef, 'params'>): FilterParams {
  const out: FilterParams = {};
  for (const p of def.params) out[p.key] = Array.isArray(p.default) ? [...p.default] : typeof p.default === 'object' ? { ...(p.default as object) } as never : p.default;
  return out;
}

export const num = (p: FilterParams, k: string) => p[k] as number;
export const str = (p: FilterParams, k: string) => p[k] as string;
export const bool = (p: FilterParams, k: string) => p[k] as boolean;
export const pt = (p: FilterParams, k: string) => p[k] as { x: number; y: number };
