/**
 * Engine: owns the document, the GL context and the render loop. Lives in a worker so that
 * neither UI work nor engine work can stall the other (spec 03 §2).
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { probeCaps, type GpuCaps } from './gpu/caps.js';
import { Renderer, type LayerDraw } from './render/renderer.js';
import { DabPainter } from './render/dab.js';
import {
  fitToScreen,
  initialView,
  panBy,
  zoomAt,
  docPointAtScreen,
  type ViewState,
} from './render/view.js';
import { PointerRing, FLAG_DOWN, FLAG_UP, nowAbs, type PointerSample } from './input/ring.js';
import { Plane, PlaneWriter, Tile, tileMemory } from './tiles/plane.js';
import { MipPlane } from './tiles/mip.js';
import { planeFromImageBitmap, RGBA8 } from './tiles/import.js';
import { addLayer, docRect, emptyDoc, makeLayer, type Doc, type Layer } from './doc.js';
import type { DocSummary, EngineStats } from './protocol.js';

const STROKE_SPACING = 0.25; // fraction of diameter, Photoshop's default

export class Engine {
  gl!: WebGL2RenderingContext;
  caps!: GpuCaps;
  renderer!: Renderer;
  dabs!: DabPainter;
  view: ViewState;
  doc: Doc = emptyDoc();
  contextLost = false;

  private readonly ring: PointerRing;
  private readonly samples: PointerSample[] = [];
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private lastLatencyMs: number | null = null;

  // Live stroke state.
  private strokeLayer: Layer | null = null;
  private strokeWriter: PlaneWriter | null = null;
  private strokeParams = { size: 40, hardness: 0.6, color: [0, 0, 0, 1] as [number, number, number, number] };
  private lastDab: { x: number; y: number } | null = null;
  private painting = false;
  /** Set when a frame consumed input, so latency is measured on that frame only. */
  private pendingLatencyFrom: number | null = null;

  constructor(
    private readonly canvas: OffscreenCanvas,
    ring: SharedArrayBuffer,
    width: number,
    height: number,
    dpr: number,
    private readonly atlasBudgetBytes = 1024 * 1024 * 1024,
  ) {
    this.ring = new PointerRing(ring);
    this.view = initialView(width, height, dpr);
    this.initGL();

    // OffscreenCanvas is an EventTarget; context loss must be handled or the app dies.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.caps = probeCaps(this.gl);
      this.renderer.restore(this.gl, this.caps);
      this.dabs.dispose();
      this.dabs = new DabPainter(this.gl);
      this.contextLost = false;
      this.onContextRestored?.();
    });
  }

  onContextLost?: () => void;
  onContextRestored?: () => void;
  /** Set when a stroke finished during the last frame, so the worker can push a doc update. */
  strokeEnded = false;

  private initGL(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.caps = probeCaps(gl);
    this.renderer = new Renderer(gl, this.caps, this.atlasBudgetBytes);
    this.dabs = new DabPainter(gl);
  }

  resize(width: number, height: number, dpr: number): void {
    this.view = { ...this.view, width, height, devicePixelRatio: dpr };
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  // ---- document ---------------------------------------------------------------------

  openBitmap(bitmap: ImageBitmap, name: string): void {
    const { plane, width, height } = planeFromImageBitmap(bitmap);
    this.doc = {
      name,
      width,
      height,
      layers: [makeLayer('Background', plane)],
    };
    this.view = fitToScreen(this.view, width, height);
  }

  newDoc(width: number, height: number): void {
    this.doc = emptyDoc(width, height);
    this.view = fitToScreen(this.view, width, height);
  }

  /**
   * Build N layers that cover the canvas, all drawing from a small pool of shared tiles.
   * Tiles are immutable and keyed by identity, so this stresses draw-call throughput and
   * atlas sampling — the things the 60 fps budget is about — without needing gigabytes of
   * unique pixels (100 unique 4K RGBA8 layers would be 3.3 GB).
   */
  addSyntheticLayers(count: number, width: number, height: number): void {
    const pool: Tile[] = [];
    for (let i = 0; i < 24; i++) {
      const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
      const hue = (i / 24) * 360;
      const [r, g, b] = hsvToRgb(hue, 0.55, 0.9);
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          const o = (y * TILE_SIZE + x) * 4;
          const shade = 0.6 + 0.4 * (x / TILE_SIZE);
          data[o] = Math.round(r * shade);
          data[o + 1] = Math.round(g * shade);
          data[o + 2] = Math.round(b * shade);
          data[o + 3] = 255;
        }
      }
      pool.push(new Tile(RGBA8, data, false));
    }

    const tilesX = Math.ceil(width / TILE_SIZE);
    const tilesY = Math.ceil(height / TILE_SIZE);
    let doc: Doc = { ...emptyDoc(width, height, 'Synthetic'), layers: [] };

    for (let i = 0; i < count; i++) {
      const w = Plane.empty(RGBA8).writer();
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          w.put(tx, ty, pool[(tx + ty * 3 + i * 7) % pool.length]!);
        }
      }
      doc = addLayer(
        doc,
        makeLayer(`Layer ${i + 1}`, w.commit(), { opacity: i === 0 ? 1 : 0.6 / Math.sqrt(count) }),
      );
    }
    this.doc = doc;
    this.view = fitToScreen(this.view, width, height);
  }

  // ---- view -------------------------------------------------------------------------

  pan(dx: number, dy: number): void {
    this.view = panBy(this.view, dx, dy);
  }
  zoomAtPoint(factor: number, x: number, y: number): void {
    this.view = zoomAt(this.view, factor, x, y);
  }
  setZoom(zoom: number): void {
    this.view = zoomAt(this.view, zoom / this.view.zoom, this.view.width / 2, this.view.height / 2);
  }
  rotate(radians: number): void {
    this.view = { ...this.view, rotation: radians };
  }
  fit(): void {
    this.view = fitToScreen(this.view, this.doc.width, this.doc.height);
  }
  actualPixels(): void {
    this.setZoom(1);
  }

  // ---- painting ---------------------------------------------------------------------

  beginStroke(size: number, hardness: number, color: [number, number, number, number]): void {
    this.strokeParams = { size, hardness, color };
    let layer = this.doc.layers.at(-1) ?? null;
    if (!layer) {
      layer = makeLayer('Layer 1', Plane.empty(RGBA8));
      this.doc = addLayer(this.doc, layer);
    }
    this.strokeLayer = layer;
    this.strokeWriter = layer.plane.base.writer();
    this.lastDab = null;
    this.painting = true;
    // While the stroke is live the atlas slices hold premultiplied pixels.
    this.doc = {
      ...this.doc,
      layers: this.doc.layers.map((l) => (l.id === layer!.id ? { ...l, premultiplied: true } : l)),
    };
  }

  endStroke(): void {
    if (!this.strokeWriter || !this.strokeLayer) return;
    const scratch = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    // Pull the GPU's work back into the tile store, un-premultiplying as we go, so the CPU
    // tiles are authoritative again (and the stroke survives a context loss).
    for (const tile of this.dabs.gpuDirty) {
      this.dabs.readbackTile(this.renderer.atlas, tile, scratch);
      unpremultiplyInto(scratch, tile.data as Uint8Array);
      this.renderer.atlas.invalidate(tile);
    }
    this.dabs.gpuDirty.clear();

    const committed = this.strokeWriter.commit();
    const id = this.strokeLayer.id;
    this.doc = {
      ...this.doc,
      layers: this.doc.layers.map((l) =>
        l.id === id ? { ...l, plane: new MipPlane(committed), premultiplied: false } : l,
      ),
    };
    this.strokeWriter = null;
    this.strokeLayer = null;
    this.painting = false;
    this.lastDab = null;
  }

  /** Consume queued pointer samples and stamp dabs along the path. */
  private processInput(): void {
    const samples = this.ring.drain(this.samples);
    if (samples.length === 0) return;
    let oldest: number | null = null;

    for (const s of samples) {
      if (s.flags & FLAG_DOWN) this.lastDab = null;
      if (!this.painting || !this.strokeWriter) continue;
      if (oldest === null) oldest = s.timeAbs;

      const doc = docPointAtScreen(this.view, s.x, s.y);
      const radius = (this.strokeParams.size * Math.max(0.05, s.pressure || 1)) / 2;
      const spacing = Math.max(1, this.strokeParams.size * STROKE_SPACING);

      if (!this.lastDab) {
        this.stampDab(doc.x, doc.y, radius);
        this.lastDab = { x: doc.x, y: doc.y };
      } else {
        // Walk the segment, emitting a dab every `spacing` document pixels.
        let { x, y } = this.lastDab;
        const dx = doc.x - x;
        const dy = doc.y - y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.floor(dist / spacing);
        for (let i = 1; i <= steps; i++) {
          const t = (i * spacing) / dist;
          this.stampDab(x + dx * t, y + dy * t, radius);
        }
        if (steps > 0) {
          const t = (steps * spacing) / dist;
          this.lastDab = { x: x + dx * t, y: y + dy * t };
        }
      }
      if (s.flags & FLAG_UP) {
        this.endStroke();
        this.strokeEnded = true;
      }
    }
    if (oldest !== null) this.pendingLatencyFrom = oldest;
  }

  private stampDab(x: number, y: number, radius: number): void {
    const writer = this.strokeWriter;
    if (!writer) return;
    this.dabs.paint(
      this.renderer.atlas,
      (tx, ty) => writer.mutableTile(tx, ty),
      {
        x,
        y,
        radius,
        hardness: this.strokeParams.hardness,
        color: this.strokeParams.color,
      },
    );
  }

  // ---- frame ------------------------------------------------------------------------

  frame(): EngineStats {
    const start = performance.now();
    if (this.contextLost) {
      return this.stats(0, { drawCalls: 0, instances: 0, level: 0, cpuMs: 0 });
    }

    this.processInput();

    const layers: LayerDraw[] = this.doc.layers.map((l) => ({
      plane: l.plane,
      opacity: l.opacity,
      visible: l.visible,
      premultiplied: l.premultiplied,
    }));
    const stats = this.renderer.render(this.view, docRect(this.doc), layers);

    if (this.pendingLatencyFrom !== null) {
      // A 1 px readPixels is the end point for "the pixels exist". gl.finish() is NOT a
      // reliable barrier for a worker/OffscreenCanvas context — measured against a known
      // workload it returns long before the GPU is done, whereas a read must block.
      this.syncGpu();
      this.lastLatencyMs = nowAbs() - this.pendingLatencyFrom;
      this.pendingLatencyFrom = null;
    }

    const frameMs = performance.now() - start;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    return this.stats(frameMs, stats);
  }

  /** Block until the GPU has finished producing the current frame. */
  syncGpu(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
  }
  private readonly syncPixel = new Uint8Array(4);

  private stats(frameMs: number, s: { drawCalls: number; instances: number; level: number; cpuMs: number }): EngineStats {
    const now = performance.now();
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 16.7;
    this.lastFrameAt = now;
    const a = this.renderer.atlas.stats();
    return {
      ...s,
      fps: 1000 / Math.max(dt, 0.001),
      frameMs,
      atlasResident: a.resident,
      atlasCapacity: a.capacity,
      atlasUploads: a.uploads,
      atlasEvictions: a.evictions,
      atlasThrash: a.thrash,
      atlasPages: a.pages,
      docLayers: this.doc.layers.length,
      docTiles: this.doc.layers.reduce((n, l) => n + l.plane.base.tileCount, 0),
      atlasBytes: a.bytes,
      tileBytes: tileMemory.liveBytes,
      zoom: this.view.zoom,
      centreX: this.view.centre.x,
      centreY: this.view.centre.y,
      lastLatencyMs: this.lastLatencyMs,
    };
  }

  summary(): DocSummary {
    return {
      name: this.doc.name,
      width: this.doc.width,
      height: this.doc.height,
      layers: this.doc.layers.map((l) => ({
        id: l.id,
        name: l.name,
        opacity: l.opacity,
        visible: l.visible,
        tiles: l.plane.base.tileCount,
      })),
    };
  }

  get medianFrameMs(): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return sorted[sorted.length >> 1]!;
  }

  percentileFrameMs(p: number): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  }

  resetFrameTimes(): void {
    this.frameTimes = [];
  }
}

function unpremultiplyInto(src: Uint8Array, dst: Uint8Array): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
    } else {
      dst[i] = Math.min(255, Math.round((src[i]! * 255) / a));
      dst[i + 1] = Math.min(255, Math.round((src[i + 1]! * 255) / a));
      dst[i + 2] = Math.min(255, Math.round((src[i + 2]! * 255) / a));
      dst[i + 3] = a;
    }
  }
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const t: [number, number, number] =
    seg === 0 ? [c, x, 0] : seg === 1 ? [x, c, 0] : seg === 2 ? [0, c, x]
    : seg === 3 ? [0, x, c] : seg === 4 ? [x, 0, c] : [c, 0, x];
  return [Math.round((t[0] + m) * 255), Math.round((t[1] + m) * 255), Math.round((t[2] + m) * 255)];
}

export { TILE_SHIFT };
