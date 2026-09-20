/**
 * Engine: owns the document, the history and the GL context. Lives in a worker so that
 * neither UI work nor engine work can stall the other (spec 03 §2).
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import type { BlendMode } from '@umbra/core/blend';
import { probeCaps, type GpuCaps } from './gpu/caps.js';
import { TileAtlas } from './gpu/atlas.js';
import { DocumentRenderer } from './render/document-renderer.js';
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
import {
  docRect,
  emptyDoc,
  makePixelLayer,
  panelRows,
  totalTiles,
  updateLayer,
  findLayer,
  countLayers,
  type Doc,
  type Layer,
  type PixelLayer,
} from './document.js';
import { History } from './history.js';
import { openPsd } from './psd-open.js';
import type { DocSummary, EngineStats } from './protocol.js';

const STROKE_SPACING = 0.25; // fraction of diameter, Photoshop's default

export class Engine {
  gl!: WebGL2RenderingContext;
  caps!: GpuCaps;
  atlas!: TileAtlas;
  renderer!: DocumentRenderer;
  dabs!: DabPainter;
  view: ViewState;
  doc: Doc = emptyDoc();
  history: History;
  contextLost = false;
  /** Set when a stroke finished during the last frame, so the worker can push a doc update. */
  strokeEnded = false;
  warnings: { layer: string; features: string[] }[] = [];

  private readonly ring: PointerRing;
  private readonly samples: PointerSample[] = [];
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private lastLatencyMs: number | null = null;
  private lastPasses = 0;
  private lastInstances = 0;

  // Live stroke state.
  private strokeLayerId: number | null = null;
  private strokeWriter: PlaneWriter | null = null;
  private strokeParams = {
    size: 40,
    hardness: 0.6,
    color: [0, 0, 0, 1] as [number, number, number, number],
  };
  private lastDab: { x: number; y: number } | null = null;
  private painting = false;
  private pendingLatencyFrom: number | null = null;
  private readonly syncPixel = new Uint8Array(4);

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
    this.history = new History(this.doc, 'New');
    this.initGL();

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // The tile store is authoritative, so everything on the GPU is simply rebuilt.
      this.caps = probeCaps(this.gl);
      this.renderer.dispose();
      this.atlas.dispose();
      this.dabs.dispose();
      this.buildGpuObjects();
      this.contextLost = false;
      this.onContextRestored?.();
    });
  }

  onContextLost?: () => void;
  onContextRestored?: () => void;

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
    this.buildGpuObjects();
  }

  private buildGpuObjects(): void {
    this.atlas = new TileAtlas(this.gl, this.caps, this.atlasBudgetBytes);
    this.renderer = new DocumentRenderer(this.gl, this.caps, this.atlas);
    this.dabs = new DabPainter(this.gl);
  }

  resize(width: number, height: number, dpr: number): void {
    this.view = { ...this.view, width, height, devicePixelRatio: dpr };
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  // ---- document ---------------------------------------------------------------------

  private commit(doc: Doc, historyName: string): void {
    this.doc = doc;
    this.history.push(historyName, doc);
  }

  openBitmap(bitmap: ImageBitmap, name: string): void {
    const { plane, width, height } = planeFromImageBitmap(bitmap);
    const layer = makePixelLayer('Background', plane);
    this.warnings = [];
    this.doc = { ...emptyDoc(width, height, name), layers: [layer], activeLayerIds: [layer.id] };
    this.history = new History(this.doc, 'Open');
    this.view = fitToScreen(this.view, width, height);
  }

  openPsdBuffer(buffer: ArrayBuffer, name: string): void {
    const { doc, warnings } = openPsd(buffer, name);
    this.warnings = warnings;
    this.doc = doc;
    this.history = new History(doc, 'Open');
    this.view = fitToScreen(this.view, doc.width, doc.height);
  }

  newDoc(width: number, height: number): void {
    this.warnings = [];
    this.doc = emptyDoc(width, height);
    this.history = new History(this.doc, 'New');
    this.view = fitToScreen(this.view, width, height);
  }

  /**
   * Synthetic stress document. Layers share a small pool of tiles: tiles are immutable and
   * keyed by identity, so this exercises draw-call throughput and atlas residency without
   * needing gigabytes of unique pixels.
   */
  addSyntheticLayers(count: number, width: number, height: number): void {
    const pool: Tile[] = [];
    for (let i = 0; i < 24; i++) {
      const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
      const [r, g, b] = hsvToRgb((i / 24) * 360, 0.55, 0.9);
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
    const layers: Layer[] = [];
    for (let i = 0; i < count; i++) {
      const w = Plane.empty(RGBA8).writer();
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          w.put(tx, ty, pool[(tx + ty * 3 + i * 7) % pool.length]!);
        }
      }
      layers.push(
        makePixelLayer(`Layer ${i + 1}`, w.commit(), {
          opacity: i === 0 ? 1 : 0.6 / Math.sqrt(count),
        }),
      );
    }
    this.warnings = [];
    this.doc = {
      ...emptyDoc(width, height, 'Synthetic'),
      layers,
      activeLayerIds: layers.length ? [layers[layers.length - 1]!.id] : [],
    };
    this.history = new History(this.doc, 'New');
    this.view = fitToScreen(this.view, width, height);
  }

  // ---- layer commands -----------------------------------------------------------------

  setLayerVisible(id: number, visible: boolean): void {
    this.commit(
      { ...this.doc, layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, visible })) },
      visible ? 'Show Layer' : 'Hide Layer',
    );
  }

  setLayerOpacity(id: number, opacity: number): void {
    this.doc = {
      ...this.doc,
      layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, opacity })),
    };
    // A slider drag coalesces into one history entry rather than one per pixel of travel.
    this.history.amend('Layer Opacity', this.doc);
  }

  setLayerBlendMode(id: number, mode: BlendMode): void {
    this.commit(
      { ...this.doc, layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, blendMode: mode })) },
      'Blend Mode',
    );
  }

  selectLayer(id: number): void {
    this.doc = { ...this.doc, activeLayerIds: [id] };
  }

  toggleGroup(id: number): void {
    this.doc = {
      ...this.doc,
      layers: updateLayer(this.doc.layers, id, (l) =>
        l.kind === 'group' ? { ...l, expanded: !l.expanded } : l,
      ),
    };
  }

  undo(): boolean {
    const doc = this.history.undo();
    if (!doc) return false;
    this.doc = doc;
    return true;
  }

  redo(): boolean {
    const doc = this.history.redo();
    if (!doc) return false;
    this.doc = doc;
    return true;
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

    let target = this.activePixelLayer();
    if (!target) {
      const layer = makePixelLayer('Layer 1', Plane.empty(RGBA8));
      this.doc = { ...this.doc, layers: [...this.doc.layers, layer], activeLayerIds: [layer.id] };
      target = layer;
    }
    this.strokeLayerId = target.id;
    this.strokeWriter = target.plane.base.writer();
    this.lastDab = null;
    this.painting = true;
  }

  private activePixelLayer(): PixelLayer | null {
    const id = this.doc.activeLayerIds[0];
    const found = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (found && found.kind === 'pixel') return found;
    // Fall back to the topmost pixel layer at the root.
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i]!;
      if (l.kind === 'pixel') return l;
    }
    return null;
  }

  endStroke(): void {
    if (!this.strokeWriter || this.strokeLayerId === null) return;
    const scratch = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    // Pull the GPU's work back into the tile store so the CPU tiles are authoritative again.
    for (const tile of this.dabs.gpuDirty) {
      this.dabs.readbackTile(this.atlas, tile, scratch);
      unpremultiplyInto(scratch, tile.data as Uint8Array);
      this.atlas.invalidate(tile);
    }
    this.dabs.gpuDirty.clear();

    const committed = this.strokeWriter.commit();
    const id = this.strokeLayerId;
    this.commit(
      {
        ...this.doc,
        layers: updateLayer(this.doc.layers, id, (l) =>
          l.kind === 'pixel' ? { ...l, plane: new MipPlane(committed) } : l,
        ),
      },
      'Brush Tool',
    );
    this.strokeWriter = null;
    this.strokeLayerId = null;
    this.painting = false;
    this.lastDab = null;
  }

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
        const { x, y } = this.lastDab;
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
    this.dabs.paint(this.atlas, (tx, ty) => writer.mutableTile(tx, ty), {
      x,
      y,
      radius,
      hardness: this.strokeParams.hardness,
      color: this.strokeParams.color,
    });
  }

  // ---- frame ------------------------------------------------------------------------

  /** Block until the GPU has finished producing the current frame. */
  syncGpu(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
  }

  frame(): EngineStats {
    const start = performance.now();
    if (this.contextLost) return this.stats(0);

    this.processInput();
    this.atlas.beginFrame();
    const s = this.renderer.render(this.doc, this.view, docRect(this.doc));
    this.lastPasses = s.layerPasses;
    this.lastInstances = s.tileInstances;

    if (this.pendingLatencyFrom !== null) {
      // A 1 px read is the only reliable barrier here; gl.finish() returns early on a
      // worker/OffscreenCanvas context (M0 finding, spec 03 §9.1).
      this.syncGpu();
      this.lastLatencyMs = nowAbs() - this.pendingLatencyFrom;
      this.pendingLatencyFrom = null;
    }

    const frameMs = performance.now() - start;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    return this.stats(frameMs);
  }

  private stats(frameMs: number): EngineStats {
    const now = performance.now();
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 16.7;
    this.lastFrameAt = now;
    const a = this.atlas.stats();
    return {
      drawCalls: this.lastPasses,
      instances: this.lastInstances,
      level: 0,
      cpuMs: frameMs,
      fps: 1000 / Math.max(dt, 0.001),
      frameMs,
      atlasResident: a.resident,
      atlasCapacity: a.capacity,
      atlasUploads: a.uploads,
      atlasEvictions: a.evictions,
      atlasThrash: a.thrash,
      atlasPages: a.pages,
      atlasBytes: a.bytes,
      docLayers: countLayers(this.doc.layers),
      docTiles: totalTiles(this.doc.layers),
      layerPasses: this.lastPasses,
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
      activeLayerIds: [...this.doc.activeLayerIds],
      warnings: this.warnings.length ? this.warnings : undefined,
      layers: panelRows(this.doc.layers).map(({ layer, depth }) => ({
        id: layer.id,
        name: layer.name,
        kind: layer.kind,
        depth,
        opacity: layer.opacity,
        fill: layer.fill,
        blendMode: layer.blendMode,
        visible: layer.visible,
        clipped: layer.clipped,
        hasMask: !!layer.mask,
        expanded: layer.kind === 'group' ? layer.expanded : false,
        tiles: layer.kind === 'pixel' ? layer.plane.base.tileCount : 0,
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
    seg === 0 ? [c, x, 0]
    : seg === 1 ? [x, c, 0]
    : seg === 2 ? [0, c, x]
    : seg === 3 ? [0, x, c]
    : seg === 4 ? [x, 0, c]
    : [c, 0, x];
  return [Math.round((t[0] + m) * 255), Math.round((t[1] + m) * 255), Math.round((t[2] + m) * 255)];
}

export { TILE_SHIFT };
