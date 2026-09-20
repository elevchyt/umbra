/**
 * PSD → tile-store reader.
 *
 * ag-psd parses a PSD from one contiguous buffer, and by default decodes every layer bitmap
 * into a canvas or an ImageData up front. For a large document that is several times the file
 * size resident at once. `useRawData` defers decoding: the reader keeps each layer's
 * compressed channel data and we decode ONE layer at a time, convert it straight into tiles,
 * then drop the raw data so it can be collected.
 *
 * Peak memory is therefore ≈ file buffer + one decoded layer + the tiles kept so far, instead
 * of file buffer + every decoded layer (spec 07 §1.1, M0 spike 4).
 */
import { readPsd, getLayerImageData, type Layer as AgLayer, type Psd } from 'ag-psd';
import { TILE_SIZE, TILE_SHIFT, type PlaneFormat } from '@umbra/core/pixels';
import { Plane, Tile, PlaneWriter } from '@umbra/engine/tiles/plane';
import { initPsdEnvironment } from './environment.js';

export const RGBA8: PlaneFormat = { layout: 'RGBA', sample: 'u8' };

export interface PsdLayerRecord {
  name: string;
  opacity: number;
  visible: boolean;
  blendMode: string;
  clipping: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  plane: Plane;
  tileCount: number;
}

export interface PsdDocument {
  width: number;
  height: number;
  channels: number;
  bitsPerChannel: number;
  colorMode: number;
  layers: PsdLayerRecord[];
}

export interface ReadProgress {
  (done: number, total: number, layerName: string): void;
}

/** Depth-first walk of the layer tree, leaves first, matching PSD's storage order. */
function* walk(layers: AgLayer[] | undefined): Generator<AgLayer> {
  for (const l of layers ?? []) {
    if (l.children) yield* walk(l.children);
    else yield l;
  }
}

export interface ReadPsdOptions {
  onProgress?: ReadProgress;
  /** Cap on decoded bytes held by ag-psd at once. */
  totalMemoryLimit?: number;
}

/**
 * Accepts a view as well as a raw ArrayBuffer. Callers should pass the Buffer/Uint8Array they
 * already have rather than slicing out an ArrayBuffer, which would double peak memory for a
 * large file.
 */
export function readPsdIntoTiles(
  buffer: ArrayBuffer | ArrayBufferView,
  opts: ReadPsdOptions = {},
): PsdDocument {
  initPsdEnvironment();
  const psd: Psd = readPsd(buffer as ArrayBuffer, {
    useRawData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    totalMemoryLimit: opts.totalMemoryLimit ?? 2 * 1024 * 1024 * 1024,
  });

  const all = [...walk(psd.children)];
  const records: PsdLayerRecord[] = [];

  all.forEach((layer, i) => {
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const right = layer.right ?? 0;
    const bottom = layer.bottom ?? 0;

    let plane = Plane.empty(RGBA8);
    if (right > left && bottom > top) {
      // Decode exactly one layer, tile it, then release the raw channels immediately so the
      // next layer's decode reuses the same memory rather than adding to it.
      const pixels = getLayerImageData(layer);
      if (pixels) plane = planeFromPixels(pixels, left, top);
      layer.rawData = undefined;
      layer.imageData = undefined;
      layer.canvas = undefined;
    }

    records.push({
      name: layer.name ?? `Layer ${i + 1}`,
      opacity: layer.opacity ?? 1,
      visible: !layer.hidden,
      blendMode: layer.blendMode ?? 'normal',
      clipping: !!layer.clipping,
      left,
      top,
      right,
      bottom,
      plane,
      tileCount: plane.tileCount,
    });
    opts.onProgress?.(i + 1, all.length, layer.name ?? '');
  });

  return {
    width: psd.width,
    height: psd.height,
    channels: psd.channels ?? 4,
    bitsPerChannel: psd.bitsPerChannel ?? 8,
    colorMode: psd.colorMode ?? 3,
    layers: records,
  };
}

export interface PixelDataLike {
  /**
   * ag-psd hands back Uint16Array/Float32Array for 16- and 32-bit documents. Tiling those
   * needs u16/f32 planes, which land with high-bit-depth support in M10 — until then a
   * non-8-bit document is rejected loudly rather than silently truncated.
   */
  data: ArrayLike<number> & ArrayBufferView;
  width: number;
  height: number;
}

function as8Bit(pixels: PixelDataLike): Uint8Array {
  if (pixels.data instanceof Uint8Array) return pixels.data;
  if (pixels.data instanceof Uint8ClampedArray) {
    return new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
  }
  throw new Error(
    `PSD layer data is ${pixels.data.constructor.name}: 16- and 32-bit documents are not ` +
      'supported yet (see docs/spec/07-file-formats.md §1.1, milestone M10)',
  );
}

/**
 * Copy an RGBA bitmap positioned at (offsetX, offsetY) in document space into tiles.
 * Layers are stored at their own bounds in PSD, so a layer rarely aligns to the tile grid.
 */
export function planeFromPixels(
  pixels: PixelDataLike,
  offsetX: number,
  offsetY: number,
): Plane {
  const { width, height } = pixels;
  const data = as8Bit(pixels);
  const writer: PlaneWriter = Plane.empty(RGBA8).writer();

  const tx0 = offsetX >> TILE_SHIFT;
  const ty0 = offsetY >> TILE_SHIFT;
  const tx1 = (offsetX + width - 1) >> TILE_SHIFT;
  const ty1 = (offsetY + height - 1) >> TILE_SHIFT;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      // Intersection of this tile with the layer's bitmap, in document coordinates.
      const dx0 = Math.max(tx << TILE_SHIFT, offsetX);
      const dy0 = Math.max(ty << TILE_SHIFT, offsetY);
      const dx1 = Math.min(((tx + 1) << TILE_SHIFT) - 1, offsetX + width - 1);
      const dy1 = Math.min(((ty + 1) << TILE_SHIFT) - 1, offsetY + height - 1);
      if (dx1 < dx0 || dy1 < dy0) continue;

      let any = false;
      for (let y = dy0; y <= dy1 && !any; y++) {
        const src = ((y - offsetY) * width + (dx0 - offsetX)) * 4;
        for (let x = 0; x <= dx1 - dx0; x++) {
          if (data[src + x * 4 + 3] !== 0) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;

      const dst = writer.mutable(tx, ty);
      for (let y = dy0; y <= dy1; y++) {
        const src = ((y - offsetY) * width + (dx0 - offsetX)) * 4;
        const out = ((y - (ty << TILE_SHIFT)) * TILE_SIZE + (dx0 - (tx << TILE_SHIFT))) * 4;
        const len = (dx1 - dx0 + 1) * 4;
        dst.set(data.subarray(src, src + len), out);
      }
    }
  }
  return writer.commit();
}

export { Tile };
