/**
 * Filter ▸ Filter Gallery — spec 05 §B.10: 47 effects in six folders, applied as a stack of
 * effect layers. The gallery is itself one registry filter whose single parameter is the
 * stack, so preview, the preview box, Last Filter, Fade and (later) smart filters treat it like
 * any other filter.
 */
import { ARTISTIC } from './artistic.js';
import { BRUSH_STROKES, GALLERY_DISTORT, GALLERY_STYLIZE } from './brush.js';
import { SKETCH } from './sketch.js';
import { TEXTURE } from './texture.js';
import { defaultsOf, type FilterDef, type FilterParams, type GalleryCategory, type GalleryEffect, type GalleryLayer } from '../types.js';

export const GALLERY_EFFECTS: GalleryEffect[] = [...ARTISTIC, ...BRUSH_STROKES, ...GALLERY_DISTORT, ...SKETCH, ...GALLERY_STYLIZE, ...TEXTURE];
export const GALLERY_BY_ID = new Map(GALLERY_EFFECTS.map((e) => [e.id, e]));
export const GALLERY_CATEGORIES: GalleryCategory[] = ['Artistic', 'Brush Strokes', 'Distort', 'Sketch', 'Stylize', 'Texture'];

/** The stack a fresh gallery opens with: one layer of the first effect, as Photoshop does. */
export const DEFAULT_STACK: GalleryLayer[] = [{ id: 'gallery.cutout', params: defaultsOf(GALLERY_BY_ID.get('gallery.cutout')!), visible: true }];

/** Parse a stack parameter, dropping unknown effects and filling in missing settings. */
export function parseStack(json: string): GalleryLayer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: GalleryLayer[] = [];
  for (const l of raw as Partial<GalleryLayer>[]) {
    const def = l && typeof l.id === 'string' ? GALLERY_BY_ID.get(l.id) : undefined;
    if (!def) continue;
    out.push({ id: def.id, params: { ...defaultsOf(def), ...((l.params ?? {}) as FilterParams) }, visible: l.visible !== false });
  }
  return out;
}

const visibleLayers = (p: FilterParams) => parseStack(p.stack as string).filter((l) => l.visible);

export const filterGallery: FilterDef = {
  id: 'filter.gallery',
  label: 'Filter Gallery',
  category: 'Gallery',
  params: [{ key: 'stack', label: 'Effect Layers', type: 'stack', default: JSON.stringify(DEFAULT_STACK) }],
  // Effects run in sequence, so their context adds up.
  pad: (p) => {
    let total = 0;
    for (const l of visibleLayers(p)) {
      const pad = GALLERY_BY_ID.get(l.id)!.pad(l.params);
      if (pad === 'full') return 'full';
      total += pad;
    }
    return total;
  },
  run: (src, p, ctx) => {
    let r = src;
    for (const l of visibleLayers(p)) r = GALLERY_BY_ID.get(l.id)!.run(r, l.params, ctx);
    return r;
  },
};
