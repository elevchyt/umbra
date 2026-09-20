/**
 * Document tree → PSD (spec 07 §1).
 *
 * PSD stores each layer cropped to its own bounds, so every layer is scanned for its tight
 * non-transparent rect and only that region is written. A layer that covers a 10000² canvas
 * but holds a 40 px dot writes 40 px.
 *
 * The codec never renders: it is handed the pixels. The merged composite ("Maximize
 * Compatibility") and the thumbnail come from the CPU reference compositor, so what Photoshop
 * shows for a file we wrote is what our own renderer shows.
 *
 * KNOWN GAP: unknown-block pass-through (spec 07 §1.1 item 8) is NOT implemented. ag-psd
 * parses the blocks it understands and discards the rest, so a round trip through Umbra
 * currently drops anything it cannot model. Preserving those bytes needs the vendored codec
 * fork and is tracked as the main remaining PSD risk.
 */
import { writePsdBuffer, initializeCanvas, type Layer as AgLayer, type Psd } from 'ag-psd';
import { TILE_SIZE, TILE_SHIFT, channelCount, maxValue } from '@umbra/core/pixels';
import type { BlendMode } from '@umbra/core/blend';
import { PSD_BLEND_MODE } from '@umbra/psd';
import { compositeDocument } from '@umbra/kernels/composite';
import { rectIsEmpty, type Rect } from '@umbra/core/geom';
import type { Doc, Layer } from './document.js';
import type { Plane } from './tiles/plane.js';
import { tilesInRect } from './tiles/plane.js';
import { toCompositeLayers } from './render/cpu-composite.js';

/** Our mode ids → the names ag-psd writes. */
const TO_PSD_MODE: Record<string, string> = Object.fromEntries(
  Object.entries(PSD_BLEND_MODE).map(([psd, ours]) => [ours, psd]),
);

let canvasReady = false;
function ensureCanvas(): void {
  if (canvasReady) return;
  canvasReady = true;
  initializeCanvas(
    () => {
      throw new Error('ag-psd asked for a canvas; Umbra always supplies imageData directly');
    },
    (width: number, height: number) =>
      ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as ImageData,
  );
}

/** Tight bounds of the non-transparent pixels in a plane, in document coordinates. */
export function tightBounds(plane: Plane): Rect {
  const n = channelCount(plane.format.layout);
  const alphaIdx = n - 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const { tx, ty } of tilesInRect(plane.bounds)) {
    if (!plane.hasTile(tx, ty)) continue;
    const tile = plane.tileAt(tx, ty);
    const ox = tx << TILE_SHIFT;
    const oy = ty << TILE_SHIFT;

    if (tile.uniform) {
      if (tile.data[alphaIdx] === 0) continue;
      x0 = Math.min(x0, ox);
      y0 = Math.min(y0, oy);
      x1 = Math.max(x1, ox + TILE_SIZE);
      y1 = Math.max(y1, oy + TILE_SIZE);
      continue;
    }

    const d = tile.data;
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        if (d[(y * TILE_SIZE + x) * n + alphaIdx] === 0) continue;
        if (ox + x < x0) x0 = ox + x;
        if (oy + y < y0) y0 = oy + y;
        if (ox + x + 1 > x1) x1 = ox + x + 1;
        if (oy + y + 1 > y1) y1 = oy + y + 1;
      }
    }
  }

  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

export interface PixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Copy a rect out of a plane into a flat RGBA bitmap. */
export function bitmapFromPlane(plane: Plane, rect: Rect): PixelData {
  const width = Math.max(0, rect.x1 - rect.x0);
  const height = Math.max(0, rect.y1 - rect.y0);
  const out = new Uint8ClampedArray(width * height * 4);
  if (width === 0 || height === 0) return { data: out, width, height };

  const n = channelCount(plane.format.layout);
  const max = maxValue(plane.format.sample);
  const single = n === 1;

  for (let y = 0; y < height; y++) {
    const docY = rect.y0 + y;
    const ty = docY >> TILE_SHIFT;
    const ly = docY - (ty << TILE_SHIFT);
    for (let x = 0; x < width; x++) {
      const docX = rect.x0 + x;
      const tx = docX >> TILE_SHIFT;
      const tile = plane.tileAt(tx, ty);
      const lx = docX - (tx << TILE_SHIFT);
      const src = tile.uniform ? 0 : (ly * TILE_SIZE + lx) * n;
      const o = (y * width + x) * 4;
      if (single) {
        // Masks are single-channel; PSD wants them as a grey bitmap.
        const v = Math.round((tile.data[src]! / max) * 255);
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      } else {
        out[o] = Math.round((tile.data[src]! / max) * 255);
        out[o + 1] = Math.round((tile.data[src + 1]! / max) * 255);
        out[o + 2] = Math.round((tile.data[src + 2]! / max) * 255);
        out[o + 3] = Math.round((tile.data[src + 3]! / max) * 255);
      }
    }
  }
  return { data: out, width, height };
}

function toAgLayer(layer: Layer, doc: Doc): AgLayer {
  const common: AgLayer = {
    name: layer.name,
    opacity: layer.opacity,
    hidden: !layer.visible,
    blendMode: (TO_PSD_MODE[layer.blendMode] ?? 'normal') as AgLayer['blendMode'],
    clipping: layer.clipped,
    transparencyProtected: layer.locks.transparency,
  };
  // ag-psd only writes fillOpacity when it differs from full.
  if (layer.fill < 1) (common as { fillOpacity?: number }).fillOpacity = layer.fill;

  if (layer.mask) {
    const mrect = tightBounds(layer.mask.plane.base);
    if (!rectIsEmpty(mrect)) {
      common.mask = {
        left: mrect.x0,
        top: mrect.y0,
        right: mrect.x1,
        bottom: mrect.y1,
        defaultColor: layer.mask.defaultColor === 1 ? 255 : 0,
        disabled: !layer.mask.enabled,
        imageData: bitmapFromPlane(layer.mask.plane.base, mrect) as unknown as ImageData,
      };
    }
  }

  if (layer.kind === 'group') {
    return { ...common, opened: layer.expanded, children: layer.children.map((c) => toAgLayer(c, doc)) };
  }

  const rect = tightBounds(layer.plane.base);
  if (rectIsEmpty(rect)) {
    // An empty layer still has to exist in the file, just with no pixels.
    return { ...common, left: 0, top: 0, right: 0, bottom: 0 };
  }
  return {
    ...common,
    left: rect.x0,
    top: rect.y0,
    right: rect.x1,
    bottom: rect.y1,
    imageData: bitmapFromPlane(layer.plane.base, rect) as unknown as ImageData,
  };
}

/**
 * Render the flattened document. Photoshop shows this when it cannot (or will not) rebuild
 * the layer stack, so it must agree with our own compositor — hence the CPU reference.
 */
export function renderComposite(doc: Doc): PixelData {
  const layers = toCompositeLayers(doc);
  const data = new Uint8ClampedArray(doc.width * doc.height * 4);
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const px = compositeDocument(layers, x, y);
      const o = (y * doc.width + x) * 4;
      data[o] = Math.round(px.color[0] * 255);
      data[o + 1] = Math.round(px.color[1] * 255);
      data[o + 2] = Math.round(px.color[2] * 255);
      data[o + 3] = Math.round(px.alpha * 255);
    }
  }
  return { data, width: doc.width, height: doc.height };
}

export interface SavePsdOptions {
  /** Write the flattened composite so other applications can read the file (default true). */
  maximizeCompatibility?: boolean;
  psb?: boolean;
}

export function savePsd(doc: Doc, opts: SavePsdOptions = {}): ArrayBuffer {
  ensureCanvas();
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3, // RGB
    children: doc.layers.map((l) => toAgLayer(l, doc)),
  };

  if (opts.maximizeCompatibility !== false && doc.layers.length > 0) {
    psd.imageData = renderComposite(doc) as unknown as ImageData;
  }

  const out = writePsdBuffer(psd, {
    generateThumbnail: false,
    psb: opts.psb,
    // Layers are already cropped to their tight bounds above.
    trimImageData: false,
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
