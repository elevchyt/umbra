import { describe, expect, it, beforeAll } from 'vitest';
import { writePsdBuffer } from 'ag-psd';
import { mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPsdDocument, PSD_BLEND_MODE } from './reader.js';


const FIXTURES = join(import.meta.dirname, '../../testkit/fixtures/generated');
const BIG_PSD = join(FIXTURES, 'large.psd');

/** Layer count × size chosen so the uncompressed layer data is several hundred MB. */
const LAYERS = 14;
const DIM = 2048;

function makeLayerPixels(seed: number) {
  const data = new Uint8Array(DIM * DIM * 4);
  // Noise-ish content so RLE cannot compress the file down to nothing.
  let s = seed * 2654435761;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = s & 0xff;
    data[i + 1] = (s >>> 8) & 0xff;
    data[i + 2] = (s >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { data, width: DIM, height: DIM };
}

beforeAll(() => {
  if (existsSync(BIG_PSD)) return;
  mkdirSync(FIXTURES, { recursive: true });
  const children = [];
  for (let i = 0; i < LAYERS; i++) {
    children.push({
      name: `Layer ${i + 1}`,
      left: 0,
      top: 0,
      right: DIM,
      bottom: DIM,
      opacity: 1,
      imageData: makeLayerPixels(i + 1),
    });
  }
  const buf = writePsdBuffer(
    { width: DIM, height: DIM, children } as never,
    { generateThumbnail: false, psb: true },
  );
  writeFileSync(BIG_PSD, buf);
}, 600_000);

describe('PSD reader', () => {
  it('streams every layer and reports the document structure', () => {
    const seen: string[] = [];
    const info = readPsdDocument(readFileSync(BIG_PSD), {
      onLayerPixels: (layer, bitmap) => {
        seen.push(layer.name);
        expect(bitmap, layer.name).not.toBeNull();
        expect(bitmap!.width).toBe(DIM);
        expect(bitmap!.data.length).toBe(DIM * DIM * 4);
      },
    });
    expect(info.width).toBe(DIM);
    expect(info.height).toBe(DIM);
    expect(info.layers).toHaveLength(LAYERS);
    expect(seen).toHaveLength(LAYERS);
    // Layers arrive in file order, which is bottom-most first.
    expect(seen[0]).toBe('Layer 1');
  });

  it('holds at most one decoded layer at a time', () => {
    // The whole point of the lazy path: the callback receives a bitmap and it is released
    // before the next one is decoded, so peak memory tracks the file, not the layer count.
    const pixelBytes = LAYERS * DIM * DIM * 4;
    const before = process.memoryUsage().rss;
    let peak = before;
    readPsdDocument(readFileSync(BIG_PSD), {
      onLayerPixels: () => {
        peak = Math.max(peak, process.memoryUsage().rss);
      },
    });
    expect(peak - before).toBeLessThan(pixelBytes);
  });

  it('maps every PSD blend key to a known mode', () => {
    for (const mode of Object.values(PSD_BLEND_MODE)) {
      expect(typeof mode).toBe('string');
    }
    expect(PSD_BLEND_MODE['pass through']).toBe('passThrough');
    expect(PSD_BLEND_MODE['linear dodge']).toBe('linearDodge');
    expect(PSD_BLEND_MODE['color burn']).toBe('colorBurn');
  });
});
