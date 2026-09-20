/**
 * Decoded-image → Plane conversion. Runs strip by strip so peak memory stays bounded by one
 * tile row rather than the whole image, which matters when opening large files.
 */
import { TILE_SIZE, TILE_SHIFT, type PlaneFormat } from '@umbra/core/pixels';
import { Plane, Tile } from './plane.js';

export const RGBA8: PlaneFormat = { layout: 'RGBA', sample: 'u8' };

export interface ImportedImage {
  plane: Plane;
  width: number;
  height: number;
}

/**
 * Note: the 2D canvas round-trip un-premultiplies, so fully transparent pixels lose their
 * colour. Codecs that preserve straight alpha (our own PNG/PSD paths) bypass this.
 */
export function planeFromImageBitmap(bmp: ImageBitmap): ImportedImage {
  const { width, height } = bmp;
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);

  const strip = new OffscreenCanvas(tilesX * TILE_SIZE, TILE_SIZE);
  const ctx = strip.getContext('2d', { willReadFrequently: true, alpha: true });
  if (!ctx) throw new Error('planeFromImageBitmap: no 2d context');
  ctx.imageSmoothingEnabled = false;

  const writer = Plane.empty(RGBA8).writer();

  for (let ty = 0; ty < tilesY; ty++) {
    const sy = ty << TILE_SHIFT;
    const sh = Math.min(TILE_SIZE, height - sy);
    ctx.clearRect(0, 0, strip.width, strip.height);
    ctx.drawImage(bmp, 0, sy, width, sh, 0, 0, width, sh);
    const img = ctx.getImageData(0, 0, tilesX * TILE_SIZE, TILE_SIZE);
    const src = img.data;

    for (let tx = 0; tx < tilesX; tx++) {
      const dst = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
      const x0 = tx << TILE_SHIFT;
      let empty = true;
      for (let y = 0; y < TILE_SIZE; y++) {
        const srcOff = (y * img.width + x0) * 4;
        const dstOff = y * TILE_SIZE * 4;
        dst.set(src.subarray(srcOff, srcOff + TILE_SIZE * 4), dstOff);
      }
      for (let i = 3; i < dst.length; i += 4) {
        if (dst[i] !== 0) {
          empty = false;
          break;
        }
      }
      if (!empty) writer.put(tx, ty, new Tile(RGBA8, dst, false));
    }
  }
  bmp.close();
  return { plane: writer.commit(), width, height };
}
