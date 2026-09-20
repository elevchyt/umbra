/**
 * M0 de-risking spikes (docs/spec/08-roadmap.md). These run inside the engine worker against
 * the real GL context, and gate the milestone: if one fails, the architecture needs changing
 * before features are piled on top of it.
 */
import { TILE_SIZE } from '@umbra/core/pixels';
import type { Engine } from './engine.js';
import { DEFAULT_BRUSH } from '@umbra/kernels/brush';
import { PointerRing, FLAG_DOWN, FLAG_UP, nowAbs } from './input/ring.js';
import { describeCaps } from './gpu/caps.js';
import { Plane, Tile } from './tiles/plane.js';
import { MipPlane, downsample } from './tiles/mip.js';
import { RGBA8 } from './tiles/import.js';

export interface SpikeResult {
  name: string;
  pass: boolean;
  detail: string;
  budget?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSpikes(engine: Engine, ringSab: SharedArrayBuffer): Promise<{
  pass: boolean;
  text: string;
  results: SpikeResult[];
}> {
  const results: SpikeResult[] = [];

  results.push(spikeCaps(engine));
  results.push(spikeTileStore());
  results.push(await spikeSyntheticPan(engine));
  results.push(await spikeInputLatency(engine, ringSab));
  results.push(await spikeContextLoss(engine));

  const pass = results.every((r) => r.pass);
  const lines = [
    '',
    '══ M0 spikes ══════════════════════════════════════════════',
    describeCaps(engine.caps),
    '───────────────────────────────────────────────────────────',
    ...results.map(
      (r) =>
        `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}` +
        (r.budget ? `\n      budget: ${r.budget}` : ''),
    ),
    '───────────────────────────────────────────────────────────',
    `${results.filter((r) => r.pass).length}/${results.length} spikes passed`,
    '',
  ];
  return { pass, text: lines.join('\n'), results };
}

/** Spike 2: the 16-bit storage path and its fallback are both identified correctly. */
function spikeCaps(engine: Engine): SpikeResult {
  const c = engine.caps;
  const gl = engine.gl;
  let norm16Storage = false;
  if (c.norm16) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, 0x805b /* RGBA16_EXT */, TILE_SIZE, TILE_SIZE);
    norm16Storage = gl.getError() === gl.NO_ERROR;
    gl.deleteTexture(tex);
  }
  // 16-bit documents need SOME exact-enough storage plus a float accumulator to blend into.
  const storageOk = norm16Storage || c.colorBufferFloat;
  const accumulatorOk = c.colorBufferHalfFloat || c.colorBufferFloat;
  const pass = !c.softwareRasterizer && c.maxTextureSize >= 4096 && storageOk && accumulatorOk;
  return {
    name: 'GPU capabilities / 16-bit path',
    pass,
    detail:
      `hardware=${!c.softwareRasterizer} maxTex=${c.maxTextureSize} arrayLayers=${c.maxArrayLayers} ` +
      `norm16Storage=${norm16Storage} norm16Renderable=${c.norm16Renderable} ` +
      `RGBA16F=${c.colorBufferHalfFloat} RGBA32F=${c.colorBufferFloat}`,
    budget: 'hardware GL, RGBA16 or float storage, float accumulator',
  };
}

/** Copy-on-write, uniform-tile collapsing and the mip pyramid behave as specified. */
function spikeTileStore(): SpikeResult {
  const failures: string[] = [];

  // Writing must not disturb the plane it was derived from.
  const base = Plane.empty(RGBA8);
  const w = base.writer();
  const px = w.mutable(0, 0);
  px[0] = 200;
  px[3] = 255;
  const next = w.commit();
  if (base.tileCount !== 0) failures.push('base plane mutated by writer');
  if (next.tileCount !== 1) failures.push(`expected 1 tile, got ${next.tileCount}`);

  const probe = new Uint8Array(4);
  next.readPixel(0, 0, probe);
  if (probe[0] !== 200 || probe[3] !== 255) failures.push(`readPixel got ${[...probe]}`);
  base.readPixel(0, 0, probe);
  if (probe[3] !== 0) failures.push('base plane is no longer transparent');

  // Tiles shared between planes must not be cloned.
  const shared = next.tileAt(0, 0);
  const w2 = next.writer();
  w2.mutable(1, 0);
  const third = w2.commit();
  if (third.tileAt(0, 0) !== shared) failures.push('untouched tile was copied');

  // A tile painted to a single value should collapse back to one pixel.
  const w3 = Plane.empty(RGBA8).writer();
  const solid = w3.mutable(0, 0);
  for (let i = 0; i < solid.length; i += 4) {
    solid[i] = 10;
    solid[i + 1] = 20;
    solid[i + 2] = 30;
    solid[i + 3] = 255;
  }
  const collapsed = w3.commit().tileAt(0, 0);
  if (!collapsed.uniform) failures.push('uniform tile was not collapsed');

  // Half-covered tile: downsampling must halve the covered area, not the colour.
  const w4 = Plane.empty(RGBA8).writer();
  const half = w4.mutable(0, 0);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const o = (y * TILE_SIZE + x) * 4;
      half[o] = 255;
      half[o + 3] = y < TILE_SIZE / 2 ? 255 : 0;
    }
  }
  const mip = downsample(w4.commit());
  mip.readPixel(0, 0, probe);
  if (probe[0] !== 255) failures.push(`mip colour bled: got r=${probe[0]}, expected 255`);

  const pyramid = new MipPlane(Plane.fromTiles(RGBA8, [], undefined));
  if (pyramid.level(3).tileCount !== 0) failures.push('empty pyramid produced tiles');

  return {
    name: 'Tile store: copy-on-write, uniform collapse, mip pyramid',
    pass: failures.length === 0,
    detail: failures.length ? failures.join('; ') : 'all invariants hold',
  };
}

/** Spike 3: 100 layers at 4K must pan at 60 fps. */
async function spikeSyntheticPan(engine: Engine): Promise<SpikeResult> {
  const LAYERS = 100;
  engine.resize(1600, 900, 1);
  engine.addSyntheticLayers(LAYERS, 3840, 2160);
  engine.fit();

  // Warm up: shader compiles and the first atlas uploads are one-off costs.
  for (let i = 0; i < 10; i++) engine.frame();
  engine.gl.finish();
  engine.resetFrameTimes();

  // Each frame ends with a readPixels round trip. gl.finish() looks like the right barrier
  // but is not one here: with it the same workload "measured" 0.2 ms/frame, i.e. ~450
  // GPixel/s on a card that can do ~50, because nothing ever read the backbuffer.
  const FRAMES = 120;
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    engine.pan(3, 1);
    engine.frame();
    readCentrePixel(engine);
  }
  const wall = performance.now() - t0;
  const perFrame = wall / FRAMES;
  const stats = engine.frame();

  // A perf number measured against a degenerate drawing buffer is worthless, so prove the
  // framebuffer really is viewport-sized and that the frame really produced pixels.
  const bw = engine.gl.drawingBufferWidth;
  const bh = engine.gl.drawingBufferHeight;
  const drew = centrePixelIsPainted(engine);
  // Sanity check the measurement itself: compositing cost must grow with layer count. If it
  // does not, the timing is not capturing GPU work and the headline number means nothing.
  const scaling = await measureScaling(engine, [10, 50, 200]);
  // Restore the 100-layer document the headline figure refers to.
  const ratio = scaling[2]!.ms / Math.max(scaling[0]!.ms, 1e-6);
  const scalesWithLoad = ratio > 3;

  const pass = perFrame <= 16.7 && bw >= 800 && bh >= 500 && drew && scalesWithLoad;
  return {
    name: `Pan ${LAYERS} layers @ 3840×2160`,
    pass,
    detail:
      `${perFrame.toFixed(2)} ms/frame (${(1000 / perFrame).toFixed(0)} fps), ` +
      `buffer=${bw}x${bh} painted=${drew} ` +
      `drawCalls=${stats.drawCalls} instances=${stats.instances} mip=L${stats.level} ` +
      `atlas=${stats.atlasResident}/${stats.atlasCapacity} pages=${stats.atlasPages} (${(stats.atlasBytes/1e6).toFixed(0)} MB VRAM) evict=${stats.atlasEvictions} thrash=${stats.atlasThrash} ` +
      `tileRAM=${(stats.tileBytes / 1e6).toFixed(1)} MB\n      ` +
      `scaling: ${scaling.map((x) => `${x.layers}L=${x.ms.toFixed(2)}ms`).join('  ')} ` +
      `(200L/10L = ${ratio.toFixed(1)}x, expect >3x)`,
    budget: '≤ 16.7 ms/frame, and cost must scale with layer count',
  };
}

/** Time one frame at several layer counts, to confirm the timer sees real GPU work. */
async function measureScaling(
  engine: Engine,
  counts: number[],
): Promise<{ layers: number; ms: number }[]> {
  const out: { layers: number; ms: number }[] = [];
  for (const layers of counts) {
    engine.addSyntheticLayers(layers, 3840, 2160);
    engine.fit();
    for (let i = 0; i < 5; i++) engine.frame();
    engine.gl.finish();
    const N = 30;
    const t = performance.now();
    for (let i = 0; i < N; i++) {
      engine.pan(2, 1);
      engine.frame();
      // readPixels forces a true round trip: the CPU cannot continue until the GPU has
      // produced this frame, which finish() alone did not guarantee here.
      readCentrePixel(engine);
    }
    out.push({ layers, ms: (performance.now() - t) / N });
    await sleep(2);
  }
  return out;
}

/** True when the centre of the canvas is not the pasteboard colour, i.e. something rendered. */
function centrePixelIsPainted(engine: Engine): boolean {
  const px = readCentrePixel(engine);
  const pasteboard = [40, 40, 40];
  return px.slice(0, 3).some((v, i) => Math.abs(v - pasteboard[i]!) > 3);
}

/** Spike 1: pointer sample → painted pixels within one frame. */
async function spikeInputLatency(engine: Engine, ringSab: SharedArrayBuffer): Promise<SpikeResult> {
  engine.newDoc(3840, 2160);
  engine.resize(1600, 900, 1);
  engine.actualPixels();
  const writer = new PointerRing(ringSab);
  writer.drain();

  // A 500 px brush on a 4K layer is the budgeted worst case.
  engine.beginStroke(
    { ...DEFAULT_BRUSH, size: 500, hardness: 0.5, smoothing: 0, pressureSize: false },
    [0.1, 0.4, 0.9],
    'normal',
  );
  const latencies: number[] = [];

  for (let i = 0; i < 60; i++) {
    writer.push({
      x: 400 + Math.sin(i / 6) * 260,
      y: 300 + Math.cos(i / 5) * 180,
      pressure: 0.8,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      timeAbs: nowAbs(),
      flags: i === 0 ? FLAG_DOWN : 0,
    });
    engine.frame();
    const s = engine.frame();
    if (s.lastLatencyMs !== null) latencies.push(s.lastLatencyMs);
    // Let the event loop breathe, as it would between real pointer events.
    if (i % 10 === 0) await sleep(1);
  }
  writer.push({ x: 400, y: 300, pressure: 0, tiltX: 0, tiltY: 0, twist: 0, timeAbs: nowAbs(), flags: FLAG_UP });
  engine.frame();
  engine.endStroke();

  latencies.sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies.at(-1)! : Infinity;
  const median = latencies.length ? latencies[latencies.length >> 1]! : Infinity;
  const pass = p95 <= 16 && latencies.length > 0;
  return {
    name: 'Engine-side input→pixels (500 px brush, 4K layer)',
    pass,
    detail:
      `n=${latencies.length} median=${median.toFixed(2)} ms p95=${p95.toFixed(2)} ms ` +
      `dropped=${writer.dropped} — LOWER BOUND: samples are injected from inside the worker, ` +
      'so this excludes the OS→UI-thread event hop. The real figure is the HUD latency readout.',
    budget: 'p95 ≤ 16 ms (engine side)',
  };
}

/** Spike 5: a lost context is rebuilt from the CPU tiles with identical output. */
async function spikeContextLoss(engine: Engine): Promise<SpikeResult> {
  const lose = engine.caps.loseContext;
  if (!lose) return { name: 'Context-loss recovery', pass: false, detail: 'WEBGL_lose_context unavailable' };

  engine.resize(400, 300, 1);
  engine.addSyntheticLayers(3, 1024, 1024);
  engine.fit();
  engine.frame();
  const before = readCentrePixel(engine);

  let restored = false;
  engine.onContextRestored = () => {
    restored = true;
  };

  lose.loseContext();
  // The lost/restored events are delivered asynchronously.
  for (let i = 0; i < 50 && !engine.contextLost; i++) await sleep(10);
  const sawLoss = engine.contextLost;
  lose.restoreContext();
  for (let i = 0; i < 100 && !restored; i++) await sleep(10);

  if (!restored) {
    return {
      name: 'Context-loss recovery',
      pass: false,
      detail: `lost=${sawLoss} restored=false (timed out)`,
    };
  }

  engine.frame();
  engine.gl.finish();
  const after = readCentrePixel(engine);
  const diff = Math.max(...before.map((v, i) => Math.abs(v - (after[i] ?? 0))));
  const pass = sawLoss && restored && diff <= 1;
  return {
    name: 'Context-loss recovery (rebuild from CPU tiles)',
    pass,
    detail: `lost=${sawLoss} restored=${restored} centre before=[${before}] after=[${after}] maxΔ=${diff}`,
    budget: 'identical pixels after restore (Δ ≤ 1)',
  };
}

function readCentrePixel(engine: Engine): number[] {
  const gl = engine.gl;
  const px = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(
    Math.floor(gl.drawingBufferWidth / 2),
    Math.floor(gl.drawingBufferHeight / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    px,
  );
  return [...px];
}

export { Tile };
