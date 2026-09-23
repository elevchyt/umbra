/**
 * PSD reader — structure plus per-layer bitmaps, streamed.
 *
 * ag-psd needs the whole file in one buffer and by default decodes every layer bitmap up
 * front, which costs several times the file size. `useRawData` defers decoding so we can
 * decode ONE layer, hand it to the caller, and drop it before moving on; measured peak is
 * ~1.6x the file rather than ~2.4x (spec 03 §9.1).
 *
 * This package deliberately knows nothing about tiles or the engine: it calls back with plain
 * bitmaps and the engine converts them. That keeps the dependency one-way (engine → psd) now
 * that the engine is the thing opening files.
 */
import {
  readPsd,
  getLayerImageData,
  getLayerMaskImageData,
  type Layer as AgLayer,
  type Psd,
} from 'ag-psd';
import { initPsdEnvironment } from './environment.js';

export interface PsdBitmap {
  data: Uint8Array;
  width: number;
  height: number;
  /** Document-space position of the bitmap's top-left corner. */
  left: number;
  top: number;
}

export interface PsdMaskInfo extends PsdBitmap {
  /** Value outside the stored mask rect. */
  defaultColor: 0 | 255;
  disabled: boolean;
  /** 0…100 in the file; undefined means fully applied. */
  density?: number;
  feather?: number;
}

export interface PsdLayerInfo {
  /** Stable index in file order. */
  index: number;
  name: string;
  kind: 'pixel' | 'group';
  opacity: number;
  fillOpacity: number;
  visible: boolean;
  blendMode: string;
  clipping: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Nested children, for groups. */
  children?: PsdLayerInfo[];
  /** True when ag-psd reported features we do not model yet. */
  unsupported?: string[];
  /** Adjustment layers: ag-psd's decoded record, for the engine to map (it owns the model). */
  adjustment?: unknown;
  /** Fill layers: ag-psd's decoded `vectorFill`. */
  vectorFill?: unknown;
  /** Smart objects: ag-psd's `placedLayer` (transform, contents id, smart filters). */
  placed?: unknown;
}

export interface PsdDocInfo {
  width: number;
  height: number;
  channels: number;
  bitsPerChannel: number;
  colorMode: number;
  layers: PsdLayerInfo[];
  /** Patterns stored in the file, which pattern fill layers refer to by id. */
  patterns?: { id: string; name: string; bounds: { w: number; h: number }; data: Uint8Array }[];
  /** Smart objects' contents, embedded as whole files (a PSB, a PNG…), by id. */
  linkedFiles?: { id: string; name: string; type?: string; data?: Uint8Array }[];
  /** True when the file stores smart-filter masks, which are not read yet. */
  hasFilterMasks?: boolean;
}

export interface PsdReadCallbacks {
  /**
   * Called once per pixel layer, in file order, with the decoded bitmap. The bitmap is
   * released as soon as this returns, so the callback must copy anything it keeps.
   */
  onLayerPixels?: (info: PsdLayerInfo, bitmap: PsdBitmap | null, mask: PsdMaskInfo | null) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Features ag-psd surfaces that we do not model yet; recorded so the UI can warn honestly. */
function unsupportedFeatures(layer: AgLayer): string[] | undefined {
  const out: string[] = [];
  if (layer.text) out.push('type layer');
  // A vector fill WITHOUT a vector mask is a fill layer, which the engine models; with one it
  // is a shape layer, which it does not yet.
  if (layer.vectorMask) out.push(layer.vectorFill ? 'shape layer' : 'vector mask');
  if (layer.effects) out.push('layer effects');
  // Smart objects are modelled; only what they cannot carry is reported, by the engine.
  return out.length ? out : undefined;
}

function toBitmap(pixels: { data: ArrayLike<number> & ArrayBufferView; width: number; height: number } | undefined, left: number, top: number): PsdBitmap | null {
  if (!pixels) return null;
  const src = pixels.data;
  let data: Uint8Array;
  if (src instanceof Uint8Array) data = src;
  else if (src instanceof Uint8ClampedArray) data = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  else {
    throw new Error(
      `PSD layer data is ${src.constructor.name}: 16- and 32-bit documents are not supported ` +
        'yet (spec 07 §1.1, milestone M10)',
    );
  }
  return { data, width: pixels.width, height: pixels.height, left, top };
}

export function readPsdDocument(
  buffer: ArrayBuffer | ArrayBufferView,
  cb: PsdReadCallbacks = {},
): PsdDocInfo {
  initPsdEnvironment();
  const psd: Psd = readPsd(buffer as ArrayBuffer, {
    useRawData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
    // Smart objects' contents are needed to edit them.
    skipLinkedFilesData: false,
  });

  let index = 0;
  let total = 0;
  const count = (ls: AgLayer[] | undefined): void => {
    for (const l of ls ?? []) {
      total++;
      if (l.children) count(l.children);
    }
  };
  count(psd.children);

  const convert = (layers: AgLayer[] | undefined): PsdLayerInfo[] =>
    (layers ?? []).map((layer) => {
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      const info: PsdLayerInfo = {
        index: index++,
        name: layer.name ?? `Layer ${index}`,
        kind: layer.children ? 'group' : 'pixel',
        // ag-psd reports opacity as 0…1.
        opacity: layer.opacity ?? 1,
        fillOpacity: (layer as { fillOpacity?: number }).fillOpacity ?? 1,
        visible: !layer.hidden,
        blendMode: layer.blendMode ?? 'normal',
        clipping: !!layer.clipping,
        left,
        top,
        right: layer.right ?? 0,
        bottom: layer.bottom ?? 0,
        unsupported: unsupportedFeatures(layer),
      };
      if (layer.adjustment) info.adjustment = layer.adjustment;
      if (layer.vectorFill && !layer.vectorMask) info.vectorFill = layer.vectorFill;
      if (layer.placedLayer) info.placed = layer.placedLayer;

      if (layer.children) {
        info.children = convert(layer.children);
      } else {
        let bitmap: PsdBitmap | null = null;
        let mask: PsdMaskInfo | null = null;
        if (info.right > info.left && info.bottom > info.top) {
          bitmap = toBitmap(getLayerImageData(layer), left, top);
        }
        if (layer.mask) {
          const m = layer.mask;
          const mb = toBitmap(getLayerMaskImageData(layer), m.left ?? 0, m.top ?? 0);
          if (mb) {
            mask = {
              ...mb,
              defaultColor: (m.defaultColor ?? 0) as 0 | 255,
              disabled: !!m.disabled,
              density: (m as { density?: number }).density,
              feather: (m as { feather?: number }).feather,
            };
          }
        }
        cb.onLayerPixels?.(info, bitmap, mask);
        // Release the decoded data so the next layer reuses the memory.
        layer.rawData = undefined;
        layer.imageData = undefined;
        layer.canvas = undefined;
        if (layer.mask) {
          (layer.mask as { imageData?: unknown }).imageData = undefined;
          (layer.mask as { canvas?: unknown }).canvas = undefined;
        }
      }
      cb.onProgress?.(info.index + 1, total);
      return info;
    });

  return {
    width: psd.width,
    height: psd.height,
    channels: psd.channels ?? 4,
    bitsPerChannel: psd.bitsPerChannel ?? 8,
    colorMode: psd.colorMode ?? 3,
    layers: convert(psd.children),
    patterns: (psd as { patterns?: PsdDocInfo['patterns'] }).patterns,
    linkedFiles: psd.linkedFiles?.map((f) => ({ id: f.id, name: f.name, type: f.type, data: f.data })),
    hasFilterMasks: (psd.filterEffectsMasks?.length ?? 0) > 0,
  };
}

/** PSD blend keys → our mode ids (spec 07 §1.2). ag-psd already gives readable names. */
export const PSD_BLEND_MODE: Record<string, string> = {
  'pass through': 'passThrough',
  normal: 'normal',
  dissolve: 'dissolve',
  darken: 'darken',
  multiply: 'multiply',
  'color burn': 'colorBurn',
  'linear burn': 'linearBurn',
  'darker color': 'darkerColor',
  lighten: 'lighten',
  screen: 'screen',
  'color dodge': 'colorDodge',
  'linear dodge': 'linearDodge',
  'lighter color': 'lighterColor',
  overlay: 'overlay',
  'soft light': 'softLight',
  'hard light': 'hardLight',
  'vivid light': 'vividLight',
  'linear light': 'linearLight',
  'pin light': 'pinLight',
  'hard mix': 'hardMix',
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: 'subtract',
  divide: 'divide',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};
