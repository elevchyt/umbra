/**
 * Engine: owns the document, the history and the GL context. Lives in a worker so that
 * neither UI work nor engine work can stall the other (spec 03 §2).
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { EMPTY_RECT, rectIsEmpty, rectUnion, type Rect } from '@umbra/core/geom';
import type { BlendMode } from '@umbra/core/blend';
import { probeCaps, type GpuCaps } from './gpu/caps.js';
import { TileAtlas } from './gpu/atlas.js';
import { DocumentRenderer } from './render/document-renderer.js';
import { DEFAULT_QUICK_MASK, type QuickMaskStyle } from './render/quick-mask.js';
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
import {
  applyShape,
  applyWand,
  makeSelection,
  selectAll,
  selectionOutline,
  selectionIsEmpty,
  invertSelection,
  featherSelection,
  expandSelection,
  contractSelection,
  borderSelection,
  smoothSelection,
  growSelection,
  type Selection,
  type SelectShape,
  type CombineOp,
  type Point,
} from './selection.js';
import * as LayerCmd from './commands/layers.js';
import * as ImageCmd from './commands/image.js';
import * as FillCmd from './commands/fill.js';
import type { PaintMode } from './commands/fill.js';
import {
  DEFAULT_BRUSH,
  beginStroke as beginBrushStroke,
  strokeTo,
  type BrushParams,
  type Dab,
  type StrokeState,
} from '@umbra/kernels/brush';
import { savePsd } from './psd-save.js';
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
  /** View ▸ Show ▸ Selection Edges. */
  showSelectionEdges = true;

  private readonly ring: PointerRing;
  private readonly samples: PointerSample[] = [];
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private lastLatencyMs: number | null = null;
  private lastPasses = 0;
  private lastInstances = 0;

  // Live stroke state.
  private strokeLayerId: number | null = null;
  /**
   * The stroke buffer: dabs accumulate here at the brush's flow, and the whole thing is
   * composited onto the layer at the brush's opacity when the stroke ends. See the header of
   * `@umbra/kernels/brush` for why that order matters.
   */
  private strokeWriter: PlaneWriter | null = null;
  private strokeState: StrokeState | null = null;
  brush: BrushParams = { ...DEFAULT_BRUSH };
  paintMode: PaintMode = 'normal';
  private strokeColor: [number, number, number] = [0, 0, 0];
  private strokeParams = {
    size: 40,
    hardness: 0.6,
    color: [0, 0, 0, 1] as [number, number, number, number],
  };
  private lastDab: { x: number; y: number } | null = null;
  private painting = false;
  private pendingLatencyFrom: number | null = null;
  private readonly syncPixel = new Uint8Array(4);

  // Selection state.
  private selectionTex: WebGLTexture | null = null;
  private selectionTexFor: Selection | null = null;
  private outlineFor: Selection | null = null;
  /** Quick Mask mode: strokes edit the selection instead of pixels. */
  quickMask = false;
  quickMaskStyle: QuickMaskStyle = DEFAULT_QUICK_MASK;
  /**
   * Region of the selection mask changed since the texture was last uploaded, so a Quick Mask
   * stroke re-uploads a few hundred rows rather than the whole canvas every frame.
   */
  private selectionDirty: Rect = EMPTY_RECT;
  /** In-flight selection gesture. */
  private gesture: {
    tool: string;
    op: CombineOp;
    start: Point;
    points: Point[];
    base: Selection | null;
  } | null = null;
  private selectOptions = { feather: 0, antialias: true, tolerance: 32, contiguous: true };
  /** Cached 1:1 composite for the Magic Wand, invalidated whenever the document changes. */
  private compositeCache: { pixels: Uint8Array; width: number; height: number; doc: Doc } | null = null;

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
    this.compositeCache = null;
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

  // ---- tree & image commands ------------------------------------------------------------

  /** Run a pure document command and push one history state. */
  private apply(name: string, fn: (d: Doc) => Doc): void {
    const next = fn(this.doc);
    if (next === this.doc) return;
    this.commit(next, name);
  }

  addLayer(): void {
    this.apply('New Layer', (d) => LayerCmd.addLayer(d, 'Layer'));
  }
  deleteLayer(id: number): void {
    this.apply('Delete Layer', (d) => LayerCmd.deleteLayer(d, id));
  }
  duplicateLayer(id: number): void {
    this.apply('Duplicate Layer', (d) => LayerCmd.duplicateLayer(d, id));
  }
  reorderLayer(id: number, delta: number): void {
    this.apply(delta > 0 ? 'Bring Forward' : 'Send Backward', (d) => LayerCmd.reorderLayer(d, id, delta));
  }
  groupLayers(ids: number[]): void {
    this.apply('Group Layers', (d) => LayerCmd.groupLayers(d, ids));
  }
  ungroupLayers(id: number): void {
    this.apply('Ungroup Layers', (d) => LayerCmd.ungroup(d, id));
  }
  mergeDown(id: number): void {
    this.apply('Merge Layers', (d) => LayerCmd.mergeDown(d, id));
  }
  mergeVisible(): void {
    this.apply('Merge Visible', (d) => LayerCmd.mergeVisible(d));
  }
  flatten(): void {
    this.apply('Flatten Image', (d) => LayerCmd.flatten(d));
  }
  stampVisible(): void {
    this.apply('Stamp Visible', (d) => LayerCmd.stampVisible(d));
  }

  imageSize(width: number, height: number, method: ImageCmd.Resample): void {
    this.apply('Image Size', (d) => ImageCmd.imageSize(d, width, height, method));
    this.fit();
  }
  canvasSize(width: number, height: number, anchor: ImageCmd.Anchor): void {
    this.apply('Canvas Size', (d) => ImageCmd.canvasSize(d, width, height, anchor));
    this.fit();
  }
  rotateImage(angle: ImageCmd.Rotation): void {
    this.apply('Rotate Canvas', (d) => ImageCmd.rotateImage(d, angle));
    this.fit();
  }
  flipImage(horizontal: boolean): void {
    this.apply('Flip Canvas', (d) => ImageCmd.flipImage(d, horizontal));
  }
  trimImage(): void {
    this.apply('Trim', (d) => ImageCmd.trim(d));
    this.fit();
  }
  revealAll(): void {
    this.apply('Reveal All', (d) => ImageCmd.revealAll(d));
    this.fit();
  }

  /** Serialise the document to a PSD for the shell to write to disk. */
  toPsd(): ArrayBuffer {
    return savePsd(this.doc);
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

  // ---- selection ----------------------------------------------------------------------

  setSelectOptions(patch: Partial<{ feather: number; antialias: boolean; tolerance: number; contiguous: boolean }>): void {
    this.selectOptions = { ...this.selectOptions, ...patch };
  }

  private setSelection(sel: Selection | null, name: string): void {
    this.commit({ ...this.doc, selection: sel && !selectionIsEmpty(sel) ? sel : null }, name);
  }

  selectAllPixels(): void {
    this.setSelection(selectAll(this.doc.width, this.doc.height), 'Select All');
  }
  deselect(): void {
    if (!this.doc.selection) return;
    this.setSelection(null, 'Deselect');
  }
  invertSelectionCmd(): void {
    const sel = this.doc.selection ?? selectAll(this.doc.width, this.doc.height);
    this.setSelection(invertSelection(sel), 'Inverse');
  }
  /**
   * Quick Mask is a VIEW of the selection, not a separate channel: the selection is already a
   * full-canvas coverage mask, so entering the mode only changes how it is drawn and what a
   * brush stroke writes to. Entering with nothing selected starts from an empty mask, which is
   * how Photoshop lets you paint a selection from scratch.
   */
  setQuickMask(on: boolean): void {
    if (this.quickMask === on) return;
    this.quickMask = on;
    if (on && !this.doc.selection) {
      this.doc = { ...this.doc, selection: makeSelection(this.doc.width, this.doc.height) };
    } else if (!on && this.doc.selection && selectionIsEmpty(this.doc.selection)) {
      this.doc = { ...this.doc, selection: null };
    }
  }

  /** Select ▸ Grow / Similar; both need the composited pixels the wand also reads. */
  growSelection(everywhere: boolean): void {
    const sel = this.doc.selection;
    if (!sel) return;
    const composite = this.documentPixels();
    if (!composite) return;
    this.setSelection(
      growSelection(sel, composite.pixels, this.selectOptions.tolerance, everywhere),
      everywhere ? 'Similar' : 'Grow',
    );
  }

  modifySelection(op: 'feather' | 'expand' | 'contract' | 'border' | 'smooth', amount: number): void {
    const sel = this.doc.selection;
    if (!sel) return;
    const fn =
      op === 'feather' ? featherSelection
      : op === 'expand' ? expandSelection
      : op === 'contract' ? contractSelection
      : op === 'border' ? borderSelection
      : smoothSelection;
    this.setSelection(fn(sel, amount), op[0]!.toUpperCase() + op.slice(1));
  }

  /** Start a marquee/lasso gesture. */
  beginSelect(tool: string, x: number, y: number, op: CombineOp): void {
    const p = docPointAtScreen(this.view, x, y);
    this.gesture = { tool, op, start: p, points: [p], base: this.doc.selection };
    this.updateSelectPreview(p);
  }

  updateSelect(x: number, y: number): void {
    if (!this.gesture) return;
    const p = docPointAtScreen(this.view, x, y);
    if (this.gesture.tool === 'lasso') this.gesture.points.push(p);
    this.updateSelectPreview(p);
  }

  /** Polygonal lasso adds a vertex per click rather than following the pointer. */
  addSelectPoint(x: number, y: number): void {
    if (!this.gesture) return;
    this.gesture.points.push(docPointAtScreen(this.view, x, y));
  }

  private shapeFor(g: NonNullable<Engine['gesture']>, current: Point): SelectShape | null {
    switch (g.tool) {
      case 'marqueeRect':
        return { kind: 'rect', x0: g.start.x, y0: g.start.y, x1: current.x, y1: current.y };
      case 'marqueeEllipse':
        return { kind: 'ellipse', x0: g.start.x, y0: g.start.y, x1: current.x, y1: current.y };
      case 'marqueeRow':
        return { kind: 'row', index: Math.floor(current.y) };
      case 'marqueeColumn':
        return { kind: 'column', index: Math.floor(current.x) };
      case 'lasso':
      case 'lassoPolygon':
        return g.points.length >= 3 ? { kind: 'polygon', points: g.points } : null;
      default:
        return null;
    }
  }

  /** Live preview: the selection updates as the pointer moves, without touching history. */
  private updateSelectPreview(current: Point): void {
    const g = this.gesture;
    if (!g) return;
    const shape = this.shapeFor(g, current);
    if (!shape) return;
    const sel = applyShape(g.base, this.doc.width, this.doc.height, shape, {
      op: g.op,
      feather: this.selectOptions.feather,
      antialias: this.selectOptions.antialias,
    });
    this.doc = { ...this.doc, selection: selectionIsEmpty(sel) ? null : sel };
  }

  endSelect(x?: number, y?: number): void {
    const g = this.gesture;
    if (!g) return;
    if (x !== undefined && y !== undefined) this.updateSelectPreview(docPointAtScreen(this.view, x, y));
    this.gesture = null;
    // One history entry for the whole gesture, not one per pointer sample.
    this.commit(this.doc, 'Selection');
  }

  cancelSelect(): void {
    if (!this.gesture) return;
    this.doc = { ...this.doc, selection: this.gesture.base };
    this.gesture = null;
  }

  magicWandAt(x: number, y: number, op: CombineOp): void {
    const p = docPointAtScreen(this.view, x, y);
    const composite = this.documentPixels();
    if (!composite) return;
    const sel = applyWand(this.doc.selection, composite.pixels, composite.width, composite.height, {
      x: p.x,
      y: p.y,
      tolerance: this.selectOptions.tolerance,
      contiguous: this.selectOptions.contiguous,
      antialias: this.selectOptions.antialias,
      op,
    });
    this.setSelection(sel, 'Magic Wand');
  }

  /** Composited document pixels at 1:1, cached until the document changes. */
  private documentPixels(): { pixels: Uint8Array; width: number; height: number } | null {
    if (this.compositeCache && this.compositeCache.doc === this.doc) return this.compositeCache;
    if (this.contextLost) return null;
    const result = this.renderer.renderToBuffer(this.doc, this.caps.maxTextureSize);
    this.compositeCache = { ...result, doc: this.doc };
    return this.compositeCache;
  }

  /** Upload the selection as an R8 texture so the brush can clip to it on the GPU. */
  private selectionTexture(): { tex: WebGLTexture; width: number; height: number } | null {
    const sel = this.doc.selection;
    if (!sel) return null;
    const gl = this.gl;
    if (this.selectionTexFor === sel && this.selectionTex && !rectIsEmpty(this.selectionDirty)) {
      // Same mask object, edited in place by a Quick Mask stroke: patch the changed rows.
      const r = this.selectionDirty;
      gl.bindTexture(gl.TEXTURE_2D, this.selectionTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sel.width);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        r.x0,
        r.y0,
        r.x1 - r.x0,
        r.y1 - r.y0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        sel.mask,
        r.y0 * sel.width + r.x0,
      );
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      this.selectionDirty = EMPTY_RECT;
      return { tex: this.selectionTex, width: sel.width, height: sel.height };
    }
    if (this.selectionTexFor !== sel || !this.selectionTex) {
      if (this.selectionTex) gl.deleteTexture(this.selectionTex);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, sel.width, sel.height);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sel.width, sel.height, gl.RED, gl.UNSIGNED_BYTE, sel.mask);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.selectionTex = tex;
      this.selectionTexFor = sel;
      this.selectionDirty = EMPTY_RECT;
    }
    return { tex: this.selectionTex, width: sel.width, height: sel.height };
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

  /**
   * Eyedropper. Samples the composited document rather than the active layer, because that is
   * what the user can see — Photoshop's "Sample: All Layers", which is its default.
   *
   * `size` is the sample square's edge in document pixels (Point Sample is 1). Averaging is
   * done on straight colour weighted by alpha, so a transparent neighbour does not drag the
   * result toward black.
   */
  sampleColor(x: number, y: number, size: number): [number, number, number] | null {
    const composite = this.documentPixels();
    if (!composite) return null;
    const p = docPointAtScreen(this.view, x, y);
    const half = Math.max(0, Math.floor((size - 1) / 2));
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let sy = cy - half; sy <= cy + half; sy++) {
      if (sy < 0 || sy >= composite.height) continue;
      for (let sx = cx - half; sx <= cx + half; sx++) {
        if (sx < 0 || sx >= composite.width) continue;
        const o = (sy * composite.width + sx) * 4;
        const a = composite.pixels[o + 3]! / 255;
        r += composite.pixels[o]! * a;
        g += composite.pixels[o + 1]! * a;
        b += composite.pixels[o + 2]! * a;
        weight += a;
      }
    }
    // Sampling empty canvas gives white, as Photoshop does over transparency.
    if (weight <= 0) return [1, 1, 1];
    return [r / weight / 255, g / weight / 255, b / weight / 255];
  }

  // ---- fill & stroke ------------------------------------------------------------------

  /**
   * Edit ▸ Fill. With nothing to fill into, a layer is created first — the same courtesy the
   * brush extends, and the alternative is a command that silently does nothing on a new
   * document.
   */
  fill(opts: FillCmd.FillOptions): void {
    let doc = this.doc;
    if (!doc.layers.some((l) => l.kind === 'pixel')) {
      const layer = makePixelLayer('Layer 1', Plane.empty(RGBA8));
      doc = { ...doc, layers: [...doc.layers, layer], activeLayerIds: [layer.id] };
    }
    const next = FillCmd.fill(doc, opts);
    if (next === doc && doc === this.doc) return;
    this.commit(next, opts.clear ? 'Clear' : 'Fill');
  }

  stroke(opts: FillCmd.StrokeOptions): void {
    const next = FillCmd.stroke(this.doc, opts);
    if (next === this.doc) return;
    this.commit(next, 'Stroke');
  }

  // ---- painting ---------------------------------------------------------------------

  beginStroke(params: BrushParams, color: [number, number, number], mode: PaintMode): void {
    this.brush = params;
    this.paintMode = mode;
    this.strokeColor = color;
    this.strokeParams = { size: params.size, hardness: params.hardness, color: [...color, 1] };
    this.strokeState = beginBrushStroke(params);
    this.lastDab = null;

    if (this.quickMask) {
      // Edit a copy so the pre-stroke mask stays on the undo stack, exactly as a pixel stroke
      // leaves the pre-stroke tiles there.
      const sel = this.doc.selection ?? makeSelection(this.doc.width, this.doc.height);
      const working = { ...sel, mask: Uint8Array.from(sel.mask) };
      this.doc = { ...this.doc, selection: working };
      this.selectionTexFor = null;
      this.painting = true;
      return;
    }

    let target = this.activePixelLayer();
    if (!target) {
      const layer = makePixelLayer('Layer 1', Plane.empty(RGBA8));
      this.doc = { ...this.doc, layers: [...this.doc.layers, layer], activeLayerIds: [layer.id] };
      target = layer;
    }
    this.strokeLayerId = target.id;
    // The stroke goes into its own empty plane, not into the layer.
    this.strokeWriter = Plane.empty(RGBA8).writer();
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
    if (this.quickMask) {
      if (!this.painting) return;
      this.painting = false;
      this.lastDab = null;
      // One history entry for the whole stroke. `this.doc` already holds the edited mask, so
      // committing it as-is records exactly what the user painted.
      this.commit(this.doc, 'Quick Mask Brush');
      return;
    }
    if (!this.strokeWriter || this.strokeLayerId === null) return;
    const scratch = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    // Pull the GPU's work back into the tile store so the CPU tiles are authoritative again.
    for (const tile of this.dabs.gpuDirty) {
      this.dabs.readbackTile(this.atlas, tile, scratch);
      unpremultiplyInto(scratch, tile.data as Uint8Array);
      // The tile's pixels changed under a stable identity; invalidate anything keyed on it.
      tile.touch();
      this.atlas.invalidate(tile);
    }
    this.dabs.gpuDirty.clear();

    const strokePlane = this.strokeWriter.commit();
    const id = this.strokeLayerId;
    this.commit(
      FillCmd.compositeStroke(this.doc, id, strokePlane, this.brush.opacity, this.paintMode),
      this.paintMode === 'clear' ? 'Eraser' : 'Brush Tool',
    );
    this.strokeWriter = null;
    this.strokeState = null;
    this.strokeLayerId = null;
    this.painting = false;
    this.lastDab = null;
  }

  private processInput(): void {
    const samples = this.ring.drain(this.samples);
    if (samples.length === 0) return;
    let oldest: number | null = null;

    for (const s of samples) {
      if (!this.painting || !this.strokeState) continue;
      if (oldest === null) oldest = s.timeAbs;

      const doc = docPointAtScreen(this.view, s.x, s.y);
      for (const dab of strokeTo(this.strokeState, {
        x: doc.x,
        y: doc.y,
        pressure: s.pressure,
        time: s.timeAbs,
      })) {
        this.stampDab(dab);
      }

      if (s.flags & FLAG_UP) {
        this.endStroke();
        this.strokeEnded = true;
      }
    }
    if (oldest !== null) this.pendingLatencyFrom = oldest;
  }

  /**
   * Airbrush build-up happens on a clock, not on pointer motion, so it needs a tick of its own
   * — a held-still pointer produces no events at all.
   */
  private airbrushTick(): void {
    if (!this.painting || !this.strokeState || !this.brush.airbrush) return;
    if (!this.strokeState.brush) return;
    const at = this.strokeState.brush;
    for (const dab of strokeTo(this.strokeState, {
      x: at.x,
      y: at.y,
      pressure: this.strokeState.lastPressure,
      time: nowAbs(),
    })) {
      this.stampDab(dab);
    }
  }

  private stampDab(dab: Dab): void {
    if (this.quickMask) {
      this.stampQuickMaskDab(dab.x, dab.y, dab.radius);
      return;
    }
    const writer = this.strokeWriter;
    if (!writer) return;
    this.dabs.paint(
      this.atlas,
      (tx, ty) => writer.mutableTile(tx, ty),
      {
        x: dab.x,
        y: dab.y,
        radius: dab.radius,
        hardness: dab.hardness,
        angle: dab.angle,
        roundness: dab.roundness,
        color: [this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], dab.flow],
      },
      this.selectionTexture(),
    );
  }

  /**
   * A dab into the Quick Mask, on the CPU.
   *
   * The GPU dab path paints into an atlas slice belonging to a tile; the selection is a flat
   * full-canvas buffer with no tiles, so there is nothing for it to target. Writing the few
   * thousand pixels a dab covers directly is both simpler and fast enough — and the dirty rect
   * it accumulates keeps the texture re-upload proportional to the stroke rather than to the
   * canvas.
   *
   * Brush colour chooses direction, as in Photoshop: black masks (removes from the selection),
   * white unmasks, and greys land in between.
   */
  private stampQuickMaskDab(x: number, y: number, radius: number): void {
    const sel = this.doc.selection;
    if (!sel) return;
    const { mask, width, height } = sel;
    const [r, g, b, alpha] = this.strokeParams.color;
    // Rec. 709 luma, the same weighting the greyscale conversion uses. Black paints rubylith
    // (coverage 0, protected); white paints it away.
    const target = 255 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
    const hardness = this.strokeParams.hardness;
    const inner = radius * hardness;
    const outer = Math.max(radius, inner + 0.5);

    const x0 = Math.max(0, Math.floor(x - outer));
    const x1 = Math.min(width, Math.ceil(x + outer) + 1);
    const y0 = Math.max(0, Math.floor(y - outer));
    const y1 = Math.min(height, Math.ceil(y + outer) + 1);
    if (x1 <= x0 || y1 <= y0) return;

    for (let py = y0; py < y1; py++) {
      const dy = py + 0.5 - y;
      for (let px = x0; px < x1; px++) {
        const dx = px + 0.5 - x;
        const d = Math.hypot(dx, dy);
        if (d >= outer) continue;
        // Same falloff as the GPU dab: hard to `inner`, then a smoothstep out to the rim.
        let a = 1;
        if (d > inner) {
          const t = (d - inner) / (outer - inner);
          a = 1 - t * t * (3 - 2 * t);
        }
        a *= alpha;
        if (a <= 0) continue;
        const i = py * width + px;
        mask[i] = Math.round(mask[i]! + (target - mask[i]!) * a);
      }
    }
    this.selectionDirty = rectUnion(this.selectionDirty, { x0, y0, x1, y1 });
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
    this.airbrushTick();

    // Quick Mask replaces the ants with the overlay, and the mask changes every frame while
    // painting, so the outline is dropped rather than re-traced. Tracking what the outline was
    // LAST built from (null included) is what stops a stale outline surviving the mode change
    // or a new document.
    const wantAnts = this.showSelectionEdges && !this.quickMask;
    const outlineFrom = wantAnts ? this.doc.selection : null;
    if (this.outlineFor !== outlineFrom) {
      this.renderer.ants.setOutline(selectionOutline(outlineFrom));
      this.outlineFor = outlineFrom;
    }

    this.atlas.beginFrame();
    // The live stroke is drawn from the base level only: it is small, and a mip built from the
    // stroke buffer would be a frame behind the dabs the GPU is still laying down.
    this.renderer.setStrokeOverlay(
      this.strokeWriter && this.strokeLayerId !== null && this.paintMode !== 'clear'
        ? {
            plane: new MipPlane(this.strokeWriter.preview(), 0),
            layerId: this.strokeLayerId,
            opacity: this.brush.opacity,
            // Behind previews as Normal; the difference only shows where the layer already has
            // pixels, and the exact result lands when the stroke is composited.
            mode: this.paintMode === 'behind' ? 'normal' : this.paintMode,
          }
        : null,
    );
    const overlay = this.quickMask ? this.selectionTexture() : null;
    const s = this.renderer.render(
      this.doc,
      this.view,
      docRect(this.doc),
      undefined,
      wantAnts,
      overlay ? { tex: overlay.tex, style: this.quickMaskStyle } : null,
    );
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
      hasSelection: !!this.doc.selection,
      selectionBounds: selectionBoundsOf(this.doc.selection),
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

function selectionBoundsOf(sel: Selection | null): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!sel) return null;
  const b = maskBoundsOf(sel);
  return b;
}

function maskBoundsOf(sel: Selection) {
  let x0 = sel.width;
  let y0 = sel.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < sel.height; y++) {
    const row = y * sel.width;
    for (let x = 0; x < sel.width; x++) {
      if (sel.mask[row + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
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
