/**
 * PSD → document tree (spec 07 §1).
 *
 * The reader streams one decoded layer at a time; each is tiled immediately so the decoded
 * bitmap can be released before the next one is produced.
 *
 * Fidelity policy (spec 07 §1.3): anything we cannot yet model — type layers, effects,
 * smart objects, the adjustment kinds not implemented yet — still opens, still renders from
 * the raster stored in the file, and is flagged so the UI can say so plainly rather than
 * pretending it is editable. Adjustment layers of the implemented kinds open as live layers.
 */
import { TILE_SIZE, TILE_SHIFT, type PlaneFormat } from '@umbra/core/pixels';
import type { BlendMode } from '@umbra/core/blend';
import {
  readPsdDocument,
  PSD_BLEND_MODE,
  type PsdBitmap,
  type PsdLayerInfo,
  type PsdMaskInfo,
} from '@umbra/psd';
import { Plane, Tile } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';
import { fromPsdAdjustment, fromPsdFill } from './psd-adjust.js';
import type { PatternDef } from '@umbra/kernels/fill';
import {
  emptyDoc,
  makeAdjustmentLayer,
  makeFillLayer,
  makeGroup,
  makePixelLayer,
  DEFAULT_BLENDING_STATE,
  NO_LOCKS,
  nextLayerId,
  type Doc,
  type Layer,
  type RasterMask,
  type SmartFilter,
  type SmartObjectLayer,
  type SmartSource,
} from './document.js';
import type { Filter as AgFilter } from 'ag-psd';
import { makeSmartLayer, makeSource, whiteMask } from './smart.js';
import { fromPsdFilter, isAffineQuad, isIdentityWarp, quadToMatrix } from './psd-smart.js';

const MASK_FORMAT: PlaneFormat = { layout: 'A', sample: 'u8' };

/** Copy an RGBA bitmap positioned at (left, top) in document space into tiles. */
export function planeFromBitmap(bmp: PsdBitmap): Plane {
  const { data, width, height, left, top } = bmp;
  const writer = Plane.empty(RGBA8).writer();

  const tx0 = left >> TILE_SHIFT;
  const ty0 = top >> TILE_SHIFT;
  const tx1 = (left + width - 1) >> TILE_SHIFT;
  const ty1 = (top + height - 1) >> TILE_SHIFT;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const dx0 = Math.max(tx << TILE_SHIFT, left);
      const dy0 = Math.max(ty << TILE_SHIFT, top);
      const dx1 = Math.min(((tx + 1) << TILE_SHIFT) - 1, left + width - 1);
      const dy1 = Math.min(((ty + 1) << TILE_SHIFT) - 1, top + height - 1);
      if (dx1 < dx0 || dy1 < dy0) continue;

      // Skip tiles the layer covers but leaves fully transparent, so a big mostly-empty
      // layer costs only the tiles that actually hold pixels.
      let any = false;
      for (let y = dy0; y <= dy1 && !any; y++) {
        const row = ((y - top) * width + (dx0 - left)) * 4;
        for (let x = 0; x <= dx1 - dx0; x++) {
          if (data[row + x * 4 + 3] !== 0) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;

      const dst = writer.mutable(tx, ty);
      for (let y = dy0; y <= dy1; y++) {
        const src = ((y - top) * width + (dx0 - left)) * 4;
        const out = ((y - (ty << TILE_SHIFT)) * TILE_SIZE + (dx0 - (tx << TILE_SHIFT))) * 4;
        dst.set(data.subarray(src, src + (dx1 - dx0 + 1) * 4), out);
      }
    }
  }
  return writer.commit();
}

/** Masks are single-channel; PSD stores them as grayscale bitmaps at their own bounds. */
export function planeFromMask(mask: PsdMaskInfo): Plane {
  const { data, width, height, left, top } = mask;
  const def = mask.defaultColor === 255 ? [255] : [0];
  const writer = Plane.empty(MASK_FORMAT, def).writer();

  const tx0 = left >> TILE_SHIFT;
  const ty0 = top >> TILE_SHIFT;
  const tx1 = (left + width - 1) >> TILE_SHIFT;
  const ty1 = (top + height - 1) >> TILE_SHIFT;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const dx0 = Math.max(tx << TILE_SHIFT, left);
      const dy0 = Math.max(ty << TILE_SHIFT, top);
      const dx1 = Math.min(((tx + 1) << TILE_SHIFT) - 1, left + width - 1);
      const dy1 = Math.min(((ty + 1) << TILE_SHIFT) - 1, top + height - 1);
      if (dx1 < dx0 || dy1 < dy0) continue;

      const dst = writer.mutable(tx, ty);
      for (let y = dy0; y <= dy1; y++) {
        // ag-psd hands masks back as RGBA; the coverage is in the red channel.
        const src = ((y - top) * width + (dx0 - left)) * 4;
        const out = (y - (ty << TILE_SHIFT)) * TILE_SIZE + (dx0 - (tx << TILE_SHIFT));
        for (let x = 0; x <= dx1 - dx0; x++) dst[out + x] = data[src + x * 4]!;
      }
    }
  }
  return writer.commit();
}

export interface OpenPsdResult {
  doc: Doc;
  /** Layers carrying features we do not model yet, for an honest post-open report. */
  warnings: { layer: string; features: string[] }[];
  /** Patterns stored in the file, for the pattern library. */
  patterns: PatternDef[];
  /**
   * Smart objects whose contents are a picture (PNG, JPEG…): decoding one needs the browser,
   * which is asynchronous, so they open showing the file's own rendering and the caller
   * decodes these and fills the sources in. Nested documents' pending pictures are included.
   */
  pendingSources: PendingSource[];
}

export interface PendingSource {
  source: SmartSource;
  bytes: Uint8Array;
  type: string;
}

const MIME: Record<string, string> = { 'png ': 'image/png', JPEG: 'image/jpeg', 'GIFf': 'image/gif', WEBP: 'image/webp' };

/** An embedded file's kind, by its type code or, failing that, its first bytes. */
function embeddedKind(f: { type?: string; data?: Uint8Array }): 'psd' | string | null {
  const d = f.data;
  if (!d || d.length < 4) return null;
  if (d[0] === 0x38 && d[1] === 0x42 && d[2] === 0x50 && d[3] === 0x53) return 'psd';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  return f.type ? (MIME[f.type] ?? null) : null;
}

export function openPsd(buffer: ArrayBuffer | ArrayBufferView, name = 'Untitled.psd'): OpenPsdResult {
  // Tiled planes, keyed by the reader's layer index, filled as the stream produces them.
  const planes = new Map<number, Plane>();
  const masks = new Map<number, RasterMask>();

  const info = readPsdDocument(buffer, {
    onLayerPixels: (layerInfo, bitmap, mask) => {
      if (bitmap) planes.set(layerInfo.index, planeFromBitmap(bitmap));
      if (mask) {
        masks.set(layerInfo.index, {
          plane: new MipPlane(planeFromMask(mask)),
          enabled: !mask.disabled,
          linked: true,
          density: (mask.density ?? 255) / 255,
          feather: mask.feather ?? 0,
          defaultColor: mask.defaultColor === 255 ? 1 : 0,
        });
      }
    },
  });

  const warnings: { layer: string; features: string[] }[] = [];
  const pendingSources: PendingSource[] = [];
  // One source per embedded file, so every instance of it shares one, as in Photoshop.
  const sources = new Map<string, SmartSource | null>();
  const linkedById = new Map((info.linkedFiles ?? []).map((f) => [f.id, f]));
  const sourceFor = (id: string, width: number, height: number, features: string[]): SmartSource | null => {
    if (sources.has(id)) return sources.get(id)!;
    const file = linkedById.get(id);
    let source: SmartSource | null = null;
    const kind = file ? embeddedKind(file) : null;
    if (file && kind === 'psd') {
      try {
        const inner = openPsd(file.data!, file.name);
        source = makeSource(file.name, { ...inner.doc, name: file.name });
        pendingSources.push(...inner.pendingSources);
        for (const w of inner.warnings) warnings.push({ layer: `${file.name} ▸ ${w.layer}`, features: w.features });
      } catch {
        features.push('smart object contents (unreadable)');
      }
    } else if (file && kind) {
      // A picture: an empty stand-in of the right size until the caller decodes it.
      source = makeSource(file.name, { ...emptyDoc(width, height, file.name) });
      pendingSources.push({ source, bytes: file.data!, type: kind });
    } else {
      features.push(file ? `smart object contents (${file.type ?? 'unknown'} file)` : 'linked smart object (file not embedded)');
    }
    sources.set(id, source);
    return source;
  };
  const patterns: PatternDef[] = (info.patterns ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    width: p.bounds.w,
    height: p.bounds.h,
    data: p.data,
  }));

  /**
   * A smart object layer. It shows the pixels Photoshop stored for it — its own rendering —
   * until something changes; from then on it re-renders from the contents.
   */
  const smartLayer = (it: PsdLayerInfo, plane: Plane, common: Partial<SmartObjectLayer>, features: string[]): SmartObjectLayer | null => {
    const placed = it.placed as { id: string; transform: number[]; nonAffineTransform?: number[]; width?: number; height?: number; warp?: unknown; filter?: { enabled?: boolean; maskEnabled?: boolean; list?: AgFilter[] } };
    const q = placed.nonAffineTransform ?? placed.transform;
    const w = placed.width ?? Math.round(Math.hypot(q[2]! - q[0]!, q[3]! - q[1]!));
    const h = placed.height ?? Math.round(Math.hypot(q[6]! - q[0]!, q[7]! - q[1]!));
    const source = sourceFor(placed.id, w, h, features);
    if (!source) return null;
    if (!isAffineQuad(q)) features.push('perspective smart object transform (affine part kept)');
    if (!isIdentityWarp(placed.warp)) features.push('smart object warp');
    const size = { width: info.width, height: info.height };
    const filters: SmartFilter[] = [];
    for (const f of placed.filter?.list ?? []) {
      const r = fromPsdFilter(f, size);
      if ('unsupported' in r) features.push(`smart filter "${r.unsupported}"`);
      else filters.push({ ...r, id: nextLayerId() });
    }
    if (filters.length && info.hasFilterMasks) features.push('smart filter mask (not read; the filters apply everywhere)');
    return makeSmartLayer(it.name, source, quadToMatrix(q, source.doc.width, source.doc.height), size, {
      ...common,
      filters,
      filtersEnabled: placed.filter?.enabled !== false,
      filterMask: filters.length ? { ...whiteMask(), enabled: placed.filter?.maskEnabled !== false } : undefined,
      plane: new MipPlane(plane),
    });
  };

  const build = (items: PsdLayerInfo[]): Layer[] =>
    items.map((it) => {
      const features = [...(it.unsupported ?? [])];
      const adjusted = it.adjustment ? fromPsdAdjustment(it.adjustment) : null;
      if (it.adjustment && !adjusted) {
        features.push(`${(it.adjustment as { type?: string }).type ?? 'unknown'} adjustment layer`);
      }
      if (adjusted) features.push(...adjusted.lost);
      const filled = it.vectorFill ? fromPsdFill(it.vectorFill, patterns) : null;
      if (it.vectorFill && !filled) features.push('fill layer (noise gradient or missing pattern)');
      if (filled) features.push(...filled.lost);
      if (features.length) warnings.push({ layer: it.name, features });

      const common = {
        id: nextLayerId(),
        name: it.name,
        visible: it.visible,
        opacity: it.opacity,
        fill: it.fillOpacity,
        blendMode: (PSD_BLEND_MODE[it.blendMode] ?? 'normal') as BlendMode,
        clipped: it.clipping,
        locks: NO_LOCKS,
        color: 'none' as const,
        blending: DEFAULT_BLENDING_STATE,
        seed: it.index,
        mask: masks.get(it.index),
      };

      if (it.kind === 'group') {
        return makeGroup(it.name, build(it.children ?? []), {
          ...common,
          // PSD stores "pass through" explicitly; anything else isolates the group.
          blendMode: (PSD_BLEND_MODE[it.blendMode] ?? 'passThrough') as BlendMode,
        });
      }
      if (adjusted) {
        return makeAdjustmentLayer(it.name, adjusted.adjustment, {
          ...common,
          // An untouched adjustment mask is all white, which a PSD stores as no pixels at all
          // and our reader therefore returns as no mask. Put the empty reveal-all mask back,
          // so there is something to paint into, as there is in Photoshop.
          mask: common.mask ?? {
            plane: new MipPlane(Plane.empty(MASK_FORMAT, [255])),
            enabled: true,
            linked: true,
            density: 1,
            feather: 0,
            defaultColor: 1,
          },
          psdExtra: { adjustment: it.adjustment },
        });
      }
      if (filled) {
        return makeFillLayer(it.name, filled.content, {
          ...common,
          mask: common.mask ?? {
            plane: new MipPlane(Plane.empty(MASK_FORMAT, [255])),
            enabled: true,
            linked: true,
            density: 1,
            feather: 0,
            defaultColor: 1,
          },
          psdExtra: { vectorFill: it.vectorFill },
        });
      }
      const plane = planes.get(it.index) ?? Plane.empty(RGBA8);
      if (it.placed) {
        const smart = smartLayer(it, plane, common, features);
        if (features.length && !warnings.some((w) => w.layer === it.name)) warnings.push({ layer: it.name, features });
        if (smart) return smart;
      }
      return makePixelLayer(it.name, plane, common);
    });

  const layers = build(info.layers);
  const doc: Doc = {
    ...emptyDoc(info.width, info.height, name),
    layers,
    activeLayerIds: layers.length ? [layers[layers.length - 1]!.id] : [],
  };
  return { doc, warnings, patterns, pendingSources };
}

export { Tile };
