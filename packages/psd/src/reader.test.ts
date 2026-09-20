import { describe, expect, it, beforeAll } from 'vitest';
import { writePsdBuffer } from 'ag-psd';
import { mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planeFromPixels, readPsdIntoTiles } from './reader.js';
import { TILE_SIZE } from '@umbra/core/pixels';

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

describe('planeFromPixels', () => {
  it('places an unaligned bitmap at the right document coordinates', () => {
    const w = 10;
    const h = 10;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 40;
      data[i + 1] = 80;
      data[i + 2] = 120;
      data[i + 3] = 255;
    }
    // Straddle a tile boundary deliberately.
    const plane = planeFromPixels({ data, width: w, height: h }, TILE_SIZE - 4, TILE_SIZE - 4);
    expect(plane.tileCount).toBe(4);

    const probe = new Uint8Array(4);
    plane.readPixel(TILE_SIZE - 4, TILE_SIZE - 4, probe);
    expect([...probe]).toEqual([40, 80, 120, 255]);
    plane.readPixel(TILE_SIZE + 5, TILE_SIZE + 5, probe);
    expect([...probe]).toEqual([40, 80, 120, 255]);
    // Just outside the bitmap must stay transparent.
    plane.readPixel(TILE_SIZE - 5, TILE_SIZE - 5, probe);
    expect(probe[3]).toBe(0);
    plane.readPixel(TILE_SIZE + 6, TILE_SIZE + 6, probe);
    expect(probe[3]).toBe(0);
  });

  it('allocates no tiles for a fully transparent bitmap', () => {
    const data = new Uint8Array(64 * 64 * 4);
    expect(planeFromPixels({ data, width: 64, height: 64 }, 0, 0).tileCount).toBe(0);
  });
});

describe('M0 spike 4 — reading a large PSD into tiles', () => {
  it('decodes lazily and keeps peak memory well below the eager path', () => {
    const fileMb = statSync(BIG_PSD).size / 1e6;
    const pixelMb = (LAYERS * DIM * DIM * 4) / 1e6;
    const script = join(import.meta.dirname, 'measure-read.mjs');

    // Separate processes: RSS is a high-water mark, so two modes in one process would report
    // the first run's peak for both.
    const run = (mode: 'lazy' | 'eager') =>
      JSON.parse(
        execFileSync(process.execPath, [script, BIG_PSD, mode], {
          encoding: 'utf8',
          maxBuffer: 1 << 20,
        }),
      ) as { layers: number; ms: number; growthMb: number; peakRssMb: number };

    const lazy = run('lazy');
    const eager = run('eager');

    // eslint-disable-next-line no-console
    console.log(
      `  file=${fileMb.toFixed(0)}MB pixels=${pixelMb.toFixed(0)}MB layers=${lazy.layers}\n` +
        `  lazy : peakRSS=${lazy.peakRssMb}MB growth=${lazy.growthMb}MB ${lazy.ms}ms\n` +
        `  eager: peakRSS=${eager.peakRssMb}MB growth=${eager.growthMb}MB ${eager.ms}ms`,
    );

    const ratio = lazy.growthMb / fileMb;
    // eslint-disable-next-line no-console
    console.log(
      `  lazy peak = ${ratio.toFixed(2)}x file size -> a 500 MB PSD projects to ` +
        `~${Math.round(500 * ratio)} MB (roadmap budget: < 1024 MB)`,
    );

    expect(lazy.layers).toBe(LAYERS);
    expect(eager.layers).toBe(LAYERS);
    // Holding one decoded layer instead of all of them must save most of the decoded size.
    expect(lazy.growthMb).toBeLessThan(eager.growthMb - pixelMb * 0.5);
    // ag-psd needs the whole file resident, so ~1.6x the file is the floor for this design.
    // Anything much above that means a layer is being retained by accident.
    expect(ratio).toBeLessThan(1.8);
    // The roadmap's stated criterion: a 500 MB PSD must stay under a 1 GB spike.
    expect(500 * ratio).toBeLessThan(1024);
  });

  it('produces tiles for every layer', () => {
    const doc = readPsdIntoTiles(readFileSync(BIG_PSD));
    expect(doc.layers.length).toBe(LAYERS);
    expect(doc.width).toBe(DIM);
    for (const l of doc.layers) expect(l.tileCount).toBeGreaterThan(0);
  });
});
