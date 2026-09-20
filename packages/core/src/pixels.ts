/**
 * Pixel format vocabulary shared by the tile store, kernels and GPU backend.
 *
 * Alpha is stored STRAIGHT (un-premultiplied), matching PSD, so that round-tripping a file
 * never loses colour in transparent areas. Kernels that filter spatially premultiply
 * internally; see docs/spec/03-architecture.md §4.1.
 */

/** Edge length of a square tile, in pixels. */
export const TILE_SIZE = 256;
export const TILE_SHIFT = 8;
export const TILE_MASK = TILE_SIZE - 1;
export const TILE_PIXELS = TILE_SIZE * TILE_SIZE;

export type SampleType = 'u8' | 'u16' | 'f32';

/**
 * Photoshop's 16-bit is really 15-bit + 1: samples run 0…32768 inclusive, so 50% grey is
 * exactly 16384 and `(a*b + 16384) >> 15` is an exact multiply.
 */
export const U16_MAX = 32768;
export const U8_MAX = 255;

export type ChannelLayout = 'RGBA' | 'GA' | 'A';

export function channelCount(layout: ChannelLayout): number {
  switch (layout) {
    case 'RGBA':
      return 4;
    case 'GA':
      return 2;
    case 'A':
      return 1;
  }
}

export function bytesPerSample(t: SampleType): number {
  return t === 'u8' ? 1 : t === 'u16' ? 2 : 4;
}

export function maxValue(t: SampleType): number {
  return t === 'u8' ? U8_MAX : t === 'u16' ? U16_MAX : 1;
}

export interface PlaneFormat {
  layout: ChannelLayout;
  sample: SampleType;
}

export function bytesPerPixel(f: PlaneFormat): number {
  return channelCount(f.layout) * bytesPerSample(f.sample);
}

export function tileByteLength(f: PlaneFormat): number {
  return TILE_PIXELS * bytesPerPixel(f);
}

export type TypedPixels = Uint8Array | Uint16Array | Float32Array;

export function viewOf(f: PlaneFormat, buf: ArrayBuffer, byteOffset = 0, length?: number) {
  const n = length ?? (buf.byteLength - byteOffset) / bytesPerSample(f.sample);
  switch (f.sample) {
    case 'u8':
      return new Uint8Array(buf, byteOffset, n);
    case 'u16':
      return new Uint16Array(buf, byteOffset, n);
    case 'f32':
      return new Float32Array(buf, byteOffset, n);
  }
}

export function allocTile(f: PlaneFormat): TypedPixels {
  return viewOf(f, new ArrayBuffer(tileByteLength(f)));
}

/** Convert a document coordinate to the tile index that contains it (floor division). */
export function tileIndex(coord: number): number {
  return coord >> TILE_SHIFT;
}

/**
 * Pack signed tile coordinates into one number usable as a Map key.
 * Range ±2^19 tiles ≈ ±134M px, comfortably beyond the 300 000 px PSB limit.
 */
const TILE_KEY_BIAS = 1 << 19;
const TILE_KEY_STRIDE = 1 << 20;

export function tileKey(tx: number, ty: number): number {
  return (tx + TILE_KEY_BIAS) * TILE_KEY_STRIDE + (ty + TILE_KEY_BIAS);
}
export function tileKeyX(key: number): number {
  return Math.floor(key / TILE_KEY_STRIDE) - TILE_KEY_BIAS;
}
export function tileKeyY(key: number): number {
  return (key % TILE_KEY_STRIDE) - TILE_KEY_BIAS;
}
