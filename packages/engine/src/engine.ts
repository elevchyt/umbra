/**
 * Engine: owns the document, the history and the GL context. Lives in a worker so that
 * neither UI work nor engine work can stall the other (spec 03 §2).
 */
import { TILE_SIZE, TILE_SHIFT } from '@umbra/core/pixels';
import { EMPTY_RECT, rectIsEmpty, rectUnion, type Rect } from '@umbra/core/geom';
import type { BlendMode } from '@umbra/core/blend';
import { probeCaps, type GpuCaps } from './gpu/caps.js';
import { isDegenerateViewport } from './render/view.js';
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
  makeAdjustmentLayer,
  insertLayer,
  panelRows,
  totalTiles,
  updateLayer,
  findLayer,
  countLayers,
  walkLayers,
  type Doc,
  type Layer,
  type PixelLayer,
  type SmartObjectLayer,
  type SmartSource,
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
import type { Resample } from './commands/image.js';
import * as FillCmd from './commands/fill.js';
import * as TransformCmd from './commands/transform.js';
import * as ClipCmd from './commands/clipboard.js';
import * as ChannelCmd from './commands/channels.js';
import * as MaskCmd from './commands/masks.js';
import * as AdjustCmd from './commands/adjust.js';
import * as SpatialCmd from './commands/spatial.js';
import * as MaskPaint from './commands/mask-paint.js';
import * as FilterCmd from './commands/filter.js';
import * as Smart from './smart.js';
import { FILTER_BY_ID, type FilterParams } from '@umbra/kernels/filters/index';
import { compositePixel } from '@umbra/kernels/blend';
import type { BlendMode as FadeMode } from '@umbra/core/blend';
import { colorStats, replaceColorMask, SPATIAL_LABEL, type SpatialAdjustment } from '@umbra/kernels/spatial';
import {
  applyImage,
  calculations as runCalculations,
  type ApplyImageOptions,
  type CalculationsOptions,
} from '@umbra/kernels/applyimage';
import { bitmapFromPlane } from './psd-save.js';
import { ADJUSTMENT_LABEL, luminance, type Adjustment } from '@umbra/kernels/adjust';
import { autoColor, autoContrast, autoTone, equalizeLut } from '@umbra/kernels/auto';
import { builtinPatterns, FILL_LABEL, type FillContent, type PatternDef } from '@umbra/kernels/fill';
import type { FillSummary, PatternSummary, ProbeReply, SmartSummary } from './protocol.js';
import {
  IDENTITY,
  about,
  apply as applyMat,
  compose,
  composeAll,
  decompose as decomposeMat,
  fromRectToQuad,
  invert as invertMat,
  isIdentity,
  rotate as rotateMat,
  scale as scaleMat,
  translate as translateMat,
  type Mat,
} from '@umbra/kernels/matrix';
import { hitHandle, handlePoint, type HandleId } from './render/handles.js';
import { magicWand } from '@umbra/kernels/selection';
import type { Gradient, GradientStyle } from '@umbra/kernels/gradient';
import type { PaintMode } from './commands/fill.js';
import type { LayerLocks } from './document.js';
import {
  DEFAULT_BRUSH,
  beginStroke as beginBrushStroke,
  strokeTo,
  type BrushParams,
  type Dab,
  type StrokeState,
} from '@umbra/kernels/brush';
import { savePsd } from './psd-save.js';
import { Journal } from './journal.js';
import { openPsd, type PendingSource } from './psd-open.js';
import type { DocSummary, EngineStats } from './protocol.js';

/** The Free Transform options bar's numbers, derived from the live matrix. */
function transformReadout(box: Rect, m: Mat) {
  const d = decomposeMat(m);
  const origin = applyMat(m, { x: box.x0, y: box.y0 });
  return {
    x: origin.x,
    y: origin.y,
    scaleX: d.scaleX,
    scaleY: d.scaleY,
    rotation: (d.rotation * 180) / Math.PI,
  };
}

const STROKE_SPACING = 0.25; // fraction of diameter, Photoshop's default

export type SmartCommand = 'convert' | 'rasterize' | 'viaCopy' | 'toLayers' | 'clearFilters' | 'toggleFilters' | 'toggleFilterMask' | 'deleteFilterMask';
export type SmartFilterOp = { kind: 'toggle' } | { kind: 'delete' } | { kind: 'move'; to: number } | { kind: 'blend'; blendMode: BlendMode; opacity: number };

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
  /**
   * Move / Free Transform. One state serves both: the Move tool is a transform restricted to
   * translation that commits on pointer-up, and Free Transform is the same box left open until
   * Enter. `base` is the untransformed bounding box; `matrix` is what the handles have built.
   */
  private transform: {
    box: Rect;
    matrix: Mat;
    ids: number[];
    /** Transform the selection outline instead of pixels (Select ▸ Transform Selection). */
    selectionOnly: boolean;
    /** The selection as it was when the transform opened, so dragging re-derives from it. */
    baseSelection: Selection | null;
    /** True for the Move tool, which commits as soon as the button is released. */
    transient: boolean;
    drag: {
      handle: HandleId | 'body' | 'rotate';
      startScreen: Point;
      startMatrix: Mat;
    } | null;
  } | null = null;

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

  /**
   * A fit requested while the viewport was still unlaid-out (0×0). The client sends `init`
   * with the canvas's size at construction, which can precede layout; fitting then clamps to
   * MIN_ZOOM and, with nothing to refit afterwards, the document stayed a dot at 0.1% until
   * the user fitted by hand. The first usable resize completes the fit instead.
   */
  private fitPending = false;

  private fitView(docW: number, docH: number): void {
    this.view = fitToScreen(this.view, docW, docH);
    this.fitPending = isDegenerateViewport(this.view);
  }

  resize(width: number, height: number, dpr: number): void {
    this.view = { ...this.view, width, height, devicePixelRatio: dpr };
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    if (this.fitPending && !isDegenerateViewport(this.view)) this.fitView(this.doc.width, this.doc.height);
  }

  // ---- document ---------------------------------------------------------------------

  private commit(doc: Doc, historyName: string): void {
    // Any committed edit makes a spatial preview stale, and ends what Fade could fade.
    this.previewDoc = null;
    this.fadeState = null;
    this.doc = doc;
    this.history.push(historyName, doc);
    this.compositeCache = null;
  }

  openBitmap(bitmap: ImageBitmap, name: string): void {
    this.dropContents();
    const { plane, width, height } = planeFromImageBitmap(bitmap);
    const layer = makePixelLayer('Background', plane);
    this.warnings = [];
    this.doc = { ...emptyDoc(width, height, name), layers: [layer], activeLayerIds: [layer.id] };
    this.history = new History(this.doc, 'Open');
    this.fitView(width, height);
  }

  /**
   * Add a bitmap as a new layer, centred on the view — what pasting an image from the system
   * clipboard or dropping a file onto an open document should do. `openBitmap` replaces the
   * document instead, which is right for File ▸ Open and wrong for everything else.
   */
  placeBitmap(bitmap: ImageBitmap, name: string): void {
    const { plane, width, height } = planeFromImageBitmap(bitmap);
    const dx = Math.round(this.view.centre.x - width / 2);
    const dy = Math.round(this.view.centre.y - height / 2);
    const layer = makePixelLayer(name, TransformCmd.shiftPlane(plane, dx, dy));
    this.commit(
      {
        ...this.doc,
        layers: [...this.doc.layers, layer],
        activeLayerIds: [layer.id],
      },
      'Place',
    );
  }

  /** Smart objects' embedded pictures still to decode — see `resolvePendingSources`. */
  private pendingSources: PendingSource[] = [];

  openPsdBuffer(buffer: ArrayBuffer, name: string): void {
    this.dropContents();
    const { doc, warnings, patterns, pendingSources } = openPsd(buffer, name);
    this.pendingSources = pendingSources;
    for (const p of patterns) if (!this.patternLibrary.some((q) => q.id === p.id)) this.patternLibrary.push(p);
    this.warnings = warnings;
    this.doc = doc;
    this.history = new History(doc, 'Open');
    this.fitView(doc.width, doc.height);
  }

  newDoc(width: number, height: number): void {
    this.dropContents();
    this.warnings = [];
    this.doc = emptyDoc(width, height);
    this.history = new History(this.doc, 'New');
    this.fitView(width, height);
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
    this.fitView(width, height);
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
    this.apply('New Layer', (d) => LayerCmd.addLayer(d));
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
  /** What the last Deselect dropped, for Select ▸ Reselect. */
  private lastSelection: Selection | null = null;

  deselect(): void {
    if (!this.doc.selection) return;
    this.lastSelection = this.doc.selection;
    this.setSelection(null, 'Deselect');
  }

  /**
   * Select ▸ Reselect. The dropped selection is only valid on a canvas the same size — after
   * a crop or an Image Size it describes pixels that are no longer there, so it is refused.
   */
  reselect(): boolean {
    const sel = this.lastSelection;
    if (!sel || sel.width !== this.doc.width || sel.height !== this.doc.height) return false;
    this.setSelection(sel, 'Reselect');
    return true;
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
    this.fitPending = false;
    this.view = panBy(this.view, dx, dy);
  }
  zoomAtPoint(factor: number, x: number, y: number): void {
    this.fitPending = false;
    this.view = zoomAt(this.view, factor, x, y);
  }
  /** Centre the view on a document point — the Navigator's click-to-pan. */
  setCentre(x: number, y: number): void {
    this.fitPending = false;
    this.view = { ...this.view, centre: { x, y } };
  }

  /** A scaled render of the whole document; null while the GPU context is lost. */
  thumbnail(maxSize: number): { pixels: Uint8Array; width: number; height: number } | null {
    // A size that is not a positive number would make a zero-sized render target.
    if (this.contextLost || this.doc.layers.length === 0 || !(maxSize >= 1)) return null;
    return this.renderer.renderThumbnail(this.doc, maxSize);
  }

  setZoom(zoom: number): void {
    this.fitPending = false;
    this.view = zoomAt(this.view, zoom / this.view.zoom, this.view.width / 2, this.view.height / 2);
  }
  rotate(radians: number): void {
    this.fitPending = false;
    this.view = { ...this.view, rotation: radians };
  }
  fit(): void {
    this.fitView(this.doc.width, this.doc.height);
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

  // ---- crash recovery ---------------------------------------------------------------------

  readonly journal = new Journal();
  /** Doc the journal last holds, so an idle session does not rewrite the same bytes. */
  private journalledDoc: Doc | null = null;
  private journalDueAt = 0;
  /** Photoshop's default autosave interval is 10 minutes; a crash journal wants to be denser. */
  journalIntervalMs = 30_000;

  /**
   * Write a recovery snapshot when the document has changed and enough time has passed.
   *
   * Called from the frame loop rather than a timer so it can never fire while an edit is
   * half-applied: at this point the document is always a committed, consistent value.
   */
  private maybeJournal(now: number): void {
    if (this.journalIntervalMs <= 0) return;
    // While a smart object's contents are open, the document worth recovering is the outermost
    // one, as it stood when they were last saved into it.
    const rootDoc = this.parents.length ? this.parents[0]!.doc : this.doc;
    const rootHistory = this.parents.length ? this.parents[0]!.history : this.history;
    if (rootDoc === this.journalledDoc) return;
    if (rootDoc.layers.length === 0) return;
    // Nothing to recover until the user has changed something: the default document is
    // recreated on launch, and a freshly opened file is already on disk. Snapshotting either
    // costs about two seconds of this thread (measured: a 2400×1600 six-layer document encodes
    // in ~1.9 s) for no benefit.
    if (rootHistory.list().length <= 1) return;
    if (now < this.journalDueAt) return;
    // Encoding a PSD blocks this thread for as long as it takes, so it must not land in the
    // middle of a stroke or a drag. Both end in a committed document a moment later anyway.
    if (this.painting || this.transform || this.crop) return;
    this.journalDueAt = now + this.journalIntervalMs;
    this.journalledDoc = rootDoc;
    try {
      // No flattened composite: a journal is read back by this program, not by another one,
      // and the composite would add another full canvas to every snapshot.
      this.journal.write(savePsd(rootDoc, { maximizeCompatibility: false }), {
        name: rootDoc.name,
        savedAt: Date.now(),
        width: rootDoc.width,
        height: rootDoc.height,
      });
    } catch (err) {
      // A document the PSD writer cannot express yet must not break editing; the next
      // interval will try again, and the failure is visible in the save path anyway.
      // Silent failure here would be worse than the noise: it is the difference between a
      // recoverable crash and an unrecoverable one.
      console.warn('[journal] snapshot failed', err);
    }
  }

  /** Called after an explicit save, so the next start does not offer a stale recovery. */
  forgetJournal(): void {
    this.journalledDoc = this.doc;
    void this.journal.clear();
  }

  /** Toggle "clipped to the layer below" — Layer ▸ Create/Release Clipping Mask. */
  toggleClipped(id: number): boolean {
    const layer = findLayer(this.doc.layers, id);
    if (!layer) return false;
    const next = LayerCmd.setClipped(this.doc, id, !layer.clipped);
    if (next === this.doc) return false;
    this.commit(next, layer.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask');
    return true;
  }

  setLayerLocks(id: number, patch: Partial<LayerLocks>): void {
    const layer = findLayer(this.doc.layers, id);
    if (!layer) return;
    const locks = { ...layer.locks, ...patch };
    this.commit(
      { ...this.doc, layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, locks })) },
      'Lock',
    );
  }

  // ---- adjustments -------------------------------------------------------------------------

  /**
   * An open Image ▸ Adjustments dialog's preview. The selection's mask plane is built once and
   * reused while the selection is unchanged, so a slider step costs a GPU pass and nothing else.
   */
  private adjustPreview: {
    layerId: number;
    adjustment: Adjustment;
    mask: MipPlane | null;
    selection: Doc['selection'];
  } | null = null;

  /** The active layer, when it is one that Image ▸ Adjustments can change. */
  private adjustTarget(): number | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    return layer && layer.kind === 'pixel' ? layer.id : null;
  }

  previewAdjustment(adjustment: Adjustment | null): void {
    const id = this.adjustTarget();
    if (!adjustment || id === null) {
      this.adjustPreview = null;
      return;
    }
    const prev = this.adjustPreview;
    const reuse = prev && prev.layerId === id && prev.selection === this.doc.selection;
    const plane = reuse ? null : MaskCmd.selectionPlane(this.doc);
    this.adjustPreview = {
      layerId: id,
      adjustment,
      mask: reuse ? prev.mask : plane ? new MipPlane(plane) : null,
      selection: this.doc.selection,
    };
  }

  /** Image ▸ Adjustments ▸ …, OK. */
  applyAdjustment(adjustment: Adjustment): boolean {
    this.adjustPreview = null;
    this.previewDoc = null;
    const id = this.adjustTarget();
    if (id === null) return false;
    const before = this.doc;
    const next = AdjustCmd.applyAdjustment(this.doc, id, adjustment);
    if (next === this.doc) return false;
    this.commit(next, ADJUSTMENT_LABEL[adjustment.kind]);
    this.fadeState = { before, after: next, name: ADJUSTMENT_LABEL[adjustment.kind], layerId: id, mask: false };
    return true;
  }

  /**
   * Image ▸ Auto Tone / Auto Contrast / Auto Color, and Adjustments ▸ Equalize: Levels (or a
   * table) computed from the target's own histogram — inside the selection when there is one.
   */
  autoAdjust(mode: 'tone' | 'contrast' | 'color' | 'equalize'): boolean {
    const id = this.adjustTarget();
    if (id === null) return false;
    const h = this.histogram('layer');
    const next =
      mode === 'equalize'
        ? AdjustCmd.applyLut(this.doc, id, equalizeLut(h))
        : AdjustCmd.applyAdjustment(this.doc, id, mode === 'tone' ? autoTone(h) : mode === 'contrast' ? autoContrast(h) : autoColor(h));
    if (next === this.doc) return false;
    this.commit(next, { tone: 'Auto Tone', contrast: 'Auto Contrast', color: 'Auto Color', equalize: 'Equalize' }[mode]);
    return true;
  }

  // ---- spatial adjustments --------------------------------------------------------------

  /**
   * A whole document shown in place of the real one: the preview of a Shadows/Highlights,
   * Replace Color, Match Color or HDR Toning dialog. Those are not per-pixel, so there is no
   * GPU shortcut — the result is computed on the CPU (latest request wins, see the worker) and
   * drawn instead of the document until OK or Cancel.
   */
  private previewDoc: Doc | null = null;

  private spatialContext(adj: SpatialAdjustment): SpatialCmd.SpatialContext {
    if (adj.kind !== 'matchColor') return {};
    if (adj.sourceLayerId === null) {
      const merged = this.documentPixels();
      return merged ? { sourceStats: colorStats(merged.pixels) } : {};
    }
    const src = findLayer(this.doc.layers, adj.sourceLayerId);
    if (!src || src.kind !== 'pixel') return {};
    return { sourceStats: colorStats(SpatialCmd.layerRaster(this.doc, src)) };
  }

  previewSpatial(adj: SpatialAdjustment | null): void {
    const id = this.adjustTarget();
    this.previewDoc = adj && id !== null ? SpatialCmd.applySpatial(this.doc, id, adj, this.spatialContext(adj)) : null;
  }

  applySpatial(adj: SpatialAdjustment): boolean {
    this.previewDoc = null;
    const id = this.adjustTarget();
    if (id === null) return false;
    const before = this.doc;
    const next = SpatialCmd.applySpatial(this.doc, id, adj, this.spatialContext(adj));
    if (next === this.doc) return false;
    this.commit(next, SPATIAL_LABEL[adj.kind]);
    // HDR Toning flattens, so there is no single "before" layer to fade against.
    if (adj.kind !== 'hdrToning') this.fadeState = { before, after: next, name: SPATIAL_LABEL[adj.kind], layerId: id, mask: false };
    return true;
  }

  /** Replace Color's selection preview: the target's match weights, scaled to fit `maxSize`. */
  replaceColorPreview(color: [number, number, number], fuzziness: number, maxSize: number): { pixels: Uint8Array; width: number; height: number } | null {
    const id = this.adjustTarget();
    const layer = id === null ? undefined : findLayer(this.doc.layers, id);
    if (!layer || layer.kind !== 'pixel') return null;
    const raster = SpatialCmd.layerRaster(this.doc, layer);
    const mask = replaceColorMask(raster, color, fuzziness);
    const scale = Math.min(1, maxSize / Math.max(this.doc.width, this.doc.height));
    const w = Math.max(1, Math.round(this.doc.width * scale));
    const h = Math.max(1, Math.round(this.doc.height * scale));
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = mask[Math.min(this.doc.height - 1, Math.floor(y / scale)) * this.doc.width + Math.min(this.doc.width - 1, Math.floor(x / scale))]!;
        pixels.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    return { pixels, width: w, height: h };
  }

  // ---- filters -------------------------------------------------------------------------

  /** Filter ▸ Last Filter: the last filter applied, with its parameters. */
  private lastFilterRun: { id: string; params: FilterParams } | null = null;

  private filterRun(id: string, params: FilterParams, fg: [number, number, number], bg: [number, number, number]): FilterCmd.FilterRun | null {
    const def = FILTER_BY_ID.get(id);
    return def ? { def, params, foreground: fg, background: bg } : null;
  }

  /** A 'layer' parameter's pixels (Displace's map, Lens Blur's depth), as a canvas raster. */
  private filterMap(run: FilterCmd.FilterRun): ArrayLike<number> | null {
    const spec = run.def.params.find((s) => s.type === 'layer');
    if (!spec) return null;
    const id = run.params[spec.key] as number;
    const layer = id >= 0 ? findLayer(this.doc.layers, id) : undefined;
    return layer && layer.kind === 'pixel' ? SpatialCmd.layerRaster(this.doc, layer) : null;
  }

  private filterDoc(run: FilterCmd.FilterRun, smartIndex?: number): Doc | null {
    if (this.activeSmart()) return this.smartFilterDoc(run, smartIndex);
    const target = this.paintTarget();
    if (!target) return null;
    const next = FilterCmd.applyFilter(this.doc, target.id, target.mask, run, this.filterMap(run));
    return next === this.doc ? null : next;
  }

  /** The active layer when it is a smart object and its pixels, not its mask, are the target. */
  private activeSmart(): SmartObjectLayer | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    return layer && layer.kind === 'smart' && this.maskTarget !== layer.id ? layer : null;
  }

  /** A smart filter's 'layer' parameter, resolved in this document. */
  private readonly smartMap: Smart.MapResolver = (f) => {
    const def = FILTER_BY_ID.get(f.filterId);
    return def ? this.filterMap({ def, params: f.params, foreground: f.foreground, background: f.background }) : null;
  };

  /**
   * A filter on a smart object goes on its smart-filter stack instead of into pixels — or, with
   * `smartIndex`, replaces that filter's settings (double-clicking a smart filter). A selection
   * active when the first filter goes on becomes the filter mask, as in Photoshop.
   */
  private smartFilterDoc(run: FilterCmd.FilterRun, smartIndex?: number): Doc | null {
    const layer = this.activeSmart();
    if (!layer) return null;
    const f = { filterId: run.def.id, params: run.params, foreground: run.foreground, background: run.background };
    if (smartIndex !== undefined) {
      const cur = layer.filters[smartIndex];
      if (!cur) return null;
      // OK without a change is not an edit.
      const same = cur.filterId === f.filterId && JSON.stringify(cur.params) === JSON.stringify(f.params) && JSON.stringify([cur.foreground, cur.background]) === JSON.stringify([f.foreground, f.background]);
      return same ? null : Smart.updateSmartFilter(this.doc, layer.id, smartIndex, f, this.smartMap);
    }
    let doc = this.doc;
    if (!layer.filterMask && doc.selection) {
      const plane = MaskCmd.selectionPlane(doc)!;
      const filterMask = { plane: new MipPlane(plane), enabled: true, linked: true, density: 1, feather: 0, defaultColor: 0 as const };
      doc = { ...doc, layers: updateLayer(doc.layers, layer.id, (l) => ({ ...(l as SmartObjectLayer), filterMask })) };
    }
    return Smart.addSmartFilter(doc, layer.id, { ...f, blendMode: 'normal', opacity: 1, enabled: true }, this.smartMap);
  }

  applyFilter(id: string, params: FilterParams, fg: [number, number, number], bg: [number, number, number], smartIndex?: number): boolean {
    this.previewDoc = null;
    const run = this.filterRun(id, params, fg, bg);
    if (!run) return false;
    const before = this.doc;
    const next = this.filterDoc(run, smartIndex);
    if (!next) return false;
    if (this.activeSmart()) {
      // Fade has nothing to fade on a smart filter — its blending options do that job.
      this.commit(next, smartIndex === undefined ? run.def.label : `Edit ${run.def.label}`);
      if (smartIndex === undefined) this.lastFilterRun = { id, params };
      this.fadeState = null;
      return true;
    }
    const target = this.paintTarget()!;
    this.commit(next, run.def.label);
    this.lastFilterRun = { id, params };
    this.fadeState = { before, after: next, name: run.def.label, layerId: target.id, mask: target.mask };
    return true;
  }

  /** Filter ▸ Last Filter: the same filter and settings again. */
  repeatLastFilter(fg: [number, number, number], bg: [number, number, number]): boolean {
    const last = this.lastFilterRun;
    return last ? this.applyFilter(last.id, last.params, fg, bg) : false;
  }

  previewFilter(id: string | null, params: FilterParams | null, fg: [number, number, number], bg: [number, number, number], smartIndex?: number): void {
    const run = id && params ? this.filterRun(id, params, fg, bg) : null;
    this.previewDoc = run ? this.filterDoc(run, smartIndex) : null;
  }

  /** What a smart filter at `index` is applied to: the object rendered through the filters below it. */
  private smartBoxBase: { layer: SmartObjectLayer; index: number; plane: Plane } | null = null;
  private smartBase(layer: SmartObjectLayer, index: number | undefined): Plane {
    if (index === undefined) return layer.plane.base;
    const c = this.smartBoxBase;
    if (c && c.layer === layer && c.index === index) return c.plane;
    const plane = Smart.renderSmart({ ...layer, filters: layer.filters.slice(0, index) }, this.doc, this.smartMap).base;
    this.smartBoxBase = { layer, index, plane };
    return plane;
  }

  /**
   * The filter dialog's preview box: a document rectangle before and after, computed on that
   * rectangle alone (plus the filter's pad) — fast whatever the document size.
   */
  filterBox(id: string, params: FilterParams, fg: [number, number, number], bg: [number, number, number], rect: Rect, smartIndex?: number): { before: Uint8Array; after: Uint8Array; width: number; height: number; rect: Rect } | null {
    const run = this.filterRun(id, params, fg, bg);
    const smart = this.activeSmart();
    const target = smart ? { id: smart.id, mask: false } : this.paintTarget();
    if (!run || !target) return null;
    const layer = findLayer(this.doc.layers, target.id);
    if (!layer) return null;
    const r = {
      x0: Math.max(0, Math.floor(rect.x0)),
      y0: Math.max(0, Math.floor(rect.y0)),
      x1: Math.min(this.doc.width, Math.ceil(rect.x1)),
      y1: Math.min(this.doc.height, Math.ceil(rect.y1)),
    };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    const canvasRect = { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
    const plane = smart ? this.smartBase(smart, smartIndex) : target.mask ? layer.mask?.plane.base : layer.kind === 'pixel' ? layer.plane.base : undefined;
    if (!plane) return null;
    const canvas = bitmapFromPlane(plane, canvasRect).data;
    // A smart filter sees no selection (it becomes the filter mask) and centres on the object.
    const bounds = smart ? Smart.contentBounds(smart) : FilterCmd.affectedRegion(this.doc);
    const after = FilterCmd.filterRegion(this.doc, canvas, r, { ...run, bounds }, smart ? null : (this.doc.selection?.mask ?? null), this.filterMap(run));
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const before = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) before.set(canvas.subarray(((r.y0 + y) * this.doc.width + r.x0) * 4, ((r.y0 + y) * this.doc.width + r.x1) * 4), y * w * 4);
    return { before, after: new Uint8Array(after.buffer), width: w, height: h, rect: r };
  }

  // ---- smart objects -----------------------------------------------------------------------

  /** Layer ▸ Smart Objects ▸ …, Filter ▸ Convert for Smart Filters and Layer ▸ Smart Filter ▸ …, on the active layer. */
  smartCommand(cmd: SmartCommand): boolean {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (!layer) return false;
    const smart = layer.kind === 'smart' ? layer : null;
    let next = this.doc;
    let name = '';
    switch (cmd) {
      case 'convert':
        // Convert for Smart Filters on a smart object has nothing to do.
        if (smart && this.doc.activeLayerIds.length === 1) return false;
        next = Smart.convertToSmart(this.doc);
        name = 'Convert to Smart Object';
        break;
      case 'rasterize':
        if (smart) next = Smart.rasterizeSmart(this.doc, smart.id);
        name = 'Rasterize Smart Object';
        break;
      case 'viaCopy':
        if (smart) next = Smart.newSmartViaCopy(this.doc, smart.id);
        name = 'New Smart Object via Copy';
        break;
      case 'toLayers':
        if (smart) next = Smart.convertToLayers(this.doc, smart.id);
        name = 'Convert to Layers';
        break;
      case 'clearFilters':
        if (smart) next = Smart.clearSmartFilters(this.doc, smart.id);
        name = 'Clear Smart Filters';
        break;
      case 'toggleFilters':
        if (smart) next = Smart.setSmartFiltersEnabled(this.doc, smart.id, !smart.filtersEnabled);
        name = smart?.filtersEnabled ? 'Disable Smart Filters' : 'Enable Smart Filters';
        break;
      case 'toggleFilterMask':
        if (smart?.filterMask) next = Smart.setFilterMaskEnabled(this.doc, smart.id, !smart.filterMask.enabled);
        name = smart?.filterMask?.enabled ? 'Disable Filter Mask' : 'Enable Filter Mask';
        break;
      case 'deleteFilterMask':
        if (smart) next = Smart.deleteFilterMask(this.doc, smart.id);
        name = 'Delete Filter Mask';
        break;
    }
    if (next === this.doc) return false;
    this.previewDoc = null;
    this.commit(next, name);
    return true;
  }

  /** One smart filter's row in the Layers panel: its eye, delete, reorder, blending options. */
  smartFilterOp(layerId: number, index: number, op: SmartFilterOp): boolean {
    const layer = findLayer(this.doc.layers, layerId);
    if (!layer || layer.kind !== 'smart' || !layer.filters[index]) return false;
    const f = layer.filters[index]!;
    const label = FILTER_BY_ID.get(f.filterId)?.label ?? 'Smart Filter';
    let next: Doc;
    let name: string;
    switch (op.kind) {
      case 'toggle':
        next = Smart.updateSmartFilter(this.doc, layerId, index, { enabled: !f.enabled }, this.smartMap);
        name = f.enabled ? `Hide ${label}` : `Show ${label}`;
        break;
      case 'delete':
        next = Smart.removeSmartFilter(this.doc, layerId, index);
        name = `Delete ${label}`;
        break;
      case 'move':
        next = Smart.moveSmartFilter(this.doc, layerId, index, op.to);
        name = `Move ${label}`;
        break;
      case 'blend':
        next = Smart.updateSmartFilter(this.doc, layerId, index, { blendMode: op.blendMode, opacity: op.opacity }, this.smartMap);
        name = `${label} Blending Options`;
        break;
    }
    this.previewDoc = null;
    if (next === this.doc) return false;
    this.commit(next, name);
    return true;
  }

  /** The smart filter Blending Options dialog's live preview. */
  previewSmartBlend(layerId: number, index: number, blend: { blendMode: BlendMode; opacity: number } | null): void {
    this.previewDoc = blend ? Smart.updateSmartFilter(this.doc, layerId, index, blend, this.smartMap) : null;
    if (this.previewDoc === this.doc) this.previewDoc = null;
  }

  // ---- Edit Contents and Place --------------------------------------------------------------

  /**
   * Layer ▸ Smart Objects ▸ Edit Contents opens the embedded document in place of the one
   * holding it (Photoshop opens a tab; this is the same with the parent kept aside until the
   * contents close). Nested smart objects nest.
   */
  private parents: { doc: Doc; history: History; view: ViewState; source: SmartSource; warnings: Engine['warnings'] }[] = [];
  /** The contents as last saved into the parent, to tell whether closing needs to ask. */
  private contentsSaved: Doc | null = null;

  get editingContents(): { path: string[]; dirty: boolean } | null {
    if (this.parents.length === 0) return null;
    return { path: [...this.parents.map((p) => p.doc.name), this.doc.name], dirty: this.doc !== this.contentsSaved };
  }

  editContents(): boolean {
    const smart = this.activeSmart() ?? this.activeSmartAny();
    if (!smart) return false;
    this.previewDoc = null;
    this.fadeState = null;
    this.parents.push({ doc: this.doc, history: this.history, view: this.view, source: smart.source, warnings: this.warnings });
    this.doc = { ...smart.source.doc, name: smart.source.name };
    this.contentsSaved = this.doc;
    this.history = new History(this.doc, 'Open');
    this.warnings = [];
    this.fitView(this.doc.width, this.doc.height);
    return true;
  }

  /** Another document replaces this one: any open contents go with it. */
  private dropContents(): void {
    this.parents = [];
    this.contentsSaved = null;
  }

  private activeSmartAny(): SmartObjectLayer | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    return layer && layer.kind === 'smart' ? layer : null;
  }

  /** File ▸ Save while editing contents: every instance in the parent takes the new contents. */
  saveContents(): boolean {
    const top = this.parents[this.parents.length - 1];
    if (!top || this.doc === this.contentsSaved) return false;
    const source = Smart.makeSource(top.source.name, { ...this.doc, name: top.source.doc.name }, top.source.id);
    const next = Smart.replaceSource(top.doc, source);
    top.history.push('Update Smart Object', next);
    top.doc = next;
    top.source = source;
    this.contentsSaved = this.doc;
    return true;
  }

  /** Close the contents, saving them into the parent first when `save`. */
  closeContents(save: boolean): boolean {
    if (this.parents.length === 0) return false;
    if (save) this.saveContents();
    const top = this.parents.pop()!;
    this.previewDoc = null;
    this.fadeState = null;
    this.doc = top.doc;
    this.history = top.history;
    this.view = top.view;
    this.warnings = top.warnings;
    this.contentsSaved = this.parents.length ? this.doc : null;
    this.compositeCache = null;
    return true;
  }

  /**
   * Decode smart objects' embedded pictures with the browser's decoder (asynchronous, hence
   * after the open) and give them their real contents. Nothing re-renders: they already show
   * the file's rendering. Resolves true when the document changed.
   */
  async resolvePendingSources(): Promise<boolean> {
    const pending = this.pendingSources;
    this.pendingSources = [];
    if (pending.length === 0) return false;
    const decoded: SmartSource[] = [];
    for (const p of pending) {
      try {
        const bitmap = await createImageBitmap(new Blob([p.bytes as BlobPart], { type: p.type }));
        const { plane, width, height } = planeFromImageBitmap(bitmap);
        const layer = makePixelLayer(p.source.name.replace(/\.[^.]+$/, ''), plane);
        const inner = { ...emptyDoc(width, height, p.source.name), layers: [layer], activeLayerIds: [layer.id] };
        decoded.push(Smart.makeSource(p.source.name, inner, p.source.id, { bytes: p.bytes, type: p.type }));
      } catch {
        // An undecodable picture leaves the stand-in: the layer still shows the file's pixels.
      }
    }
    let doc = this.doc;
    for (const src of decoded) doc = Smart.swapSource(doc, src);
    if (doc === this.doc) return false;
    // The file's contents belong to the state it opened in, not to a step of their own.
    if (this.history.list().length === 1) this.history = new History(doc, this.history.list()[0]!.name);
    else this.history.amend(this.history.list()[this.history.index]!.name, doc);
    this.doc = doc;
    return true;
  }

  /** A file's contents as a document: a PSD's layers, or a picture as one layer. */
  private contentsFrom(file: { name: string; bitmap?: ImageBitmap; psd?: ArrayBuffer }): Doc | null {
    if (file.psd) {
      const opened = openPsd(file.psd, file.name);
      this.pendingSources.push(...opened.pendingSources);
      return opened.doc;
    }
    if (!file.bitmap) return null;
    const { plane, width, height } = planeFromImageBitmap(file.bitmap);
    const layer = makePixelLayer(file.name.replace(/\.[^.]+$/, ''), plane);
    return { ...emptyDoc(width, height, file.name), layers: [layer], activeLayerIds: [layer.id] };
  }

  /**
   * File ▸ Place Embedded (into this document, above the active layer) and File ▸ Open as
   * Smart Object (`asDocument`: a new document holding just the smart object).
   */
  placeEmbedded(file: { name: string; bitmap?: ImageBitmap; psd?: ArrayBuffer; bytes?: Uint8Array; type?: string; asDocument?: boolean }): boolean {
    const contents = this.contentsFrom(file);
    if (!contents) return false;
    const psb = file.psd ? file.name.replace(/\.psd$/i, '.psb') : file.name;
    const source = Smart.makeSource(psb, contents, undefined, file.bytes && file.type ? { bytes: file.bytes, type: file.type } : undefined);
    const name = file.name.replace(/\.[^.]+$/, '');
    if (file.asDocument) {
      this.dropContents();
      const layer = Smart.makeSmartLayer(name, source, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, contents);
      this.warnings = [];
      this.doc = { ...emptyDoc(contents.width, contents.height, file.name), layers: [layer], activeLayerIds: [layer.id] };
      this.history = new History(this.doc, 'Open');
      this.fitView(contents.width, contents.height);
      return true;
    }
    const layer = Smart.makeSmartLayer(name, source, Smart.placeTransform(contents, this.doc), this.doc);
    const above = this.doc.activeLayerIds[0];
    this.commit({ ...this.doc, layers: insertLayer(this.doc.layers, layer, above), activeLayerIds: [layer.id] }, 'Place Embedded');
    return true;
  }

  // ---- Edit ▸ Fade ------------------------------------------------------------------------

  /**
   * What Fade can fade: the step just taken by a filter, adjustment or brush stroke, as the
   * document before and after it and the one layer (or mask) it changed. Any other commit
   * clears it — Fade is only offered immediately after.
   */
  private fadeState: { before: Doc; after: Doc; name: string; layerId: number; mask: boolean } | null = null;

  get fadeName(): string | null {
    return this.fadeState && this.history.current === this.fadeState.after ? this.fadeState.name : null;
  }

  private fadeDoc(opacity: number, mode: FadeMode): Doc | null {
    const f = this.fadeState;
    if (!f || this.history.current !== f.after) return null;
    const lb = findLayer(f.before.layers, f.layerId);
    const la = findLayer(f.after.layers, f.layerId);
    if (!lb || !la) return null;
    const rect = { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
    if (f.mask) {
      if (!lb.mask || !la.mask) return null;
      const b = bitmapFromPlane(lb.mask.plane.base, rect).data;
      const a = bitmapFromPlane(la.mask.plane.base, rect).data;
      const grey = new Uint8Array(this.doc.width * this.doc.height);
      for (let i = 0; i < grey.length; i++) {
        const out = compositePixel(mode, [b[i * 4]! / 255, b[i * 4]! / 255, b[i * 4]! / 255], 1, [a[i * 4]! / 255, a[i * 4]! / 255, a[i * 4]! / 255], opacity);
        grey[i] = Math.round(out.color[0] * 255);
      }
      return MaskPaint.setMaskFromGrey(f.after, f.layerId, grey);
    }
    if (lb.kind !== 'pixel' || la.kind !== 'pixel') return null;
    const b = bitmapFromPlane(lb.plane.base, rect).data;
    const a = bitmapFromPlane(la.plane.base, rect).data;
    const out = new Uint8ClampedArray(b.length);
    for (let i = 0; i < b.length; i += 4) {
      if (b[i + 3] === 0 && a[i + 3] === 0) continue;
      // The result of the step, faded onto the state before it with the chosen mode.
      const r = compositePixel(mode, [b[i]! / 255, b[i + 1]! / 255, b[i + 2]! / 255], b[i + 3]! / 255, [a[i]! / 255, a[i + 1]! / 255, a[i + 2]! / 255], (a[i + 3]! / 255) * opacity);
      // Fading never grows coverage past what either state had.
      const alpha = Math.min(r.alpha, Math.max(b[i + 3]!, a[i + 3]!) / 255);
      out[i] = Math.round(r.color[0] * 255);
      out[i + 1] = Math.round(r.color[1] * 255);
      out[i + 2] = Math.round(r.color[2] * 255);
      out[i + 3] = Math.round(alpha * 255);
    }
    const plane = new MipPlane(SpatialCmd.writeRaster(lb.plane.base, this.doc.width, this.doc.height, out));
    return { ...f.after, layers: updateLayer(f.after.layers, f.layerId, (l) => ({ ...l, plane }) as typeof l) };
  }

  previewFade(opacity: number | null, mode: FadeMode): void {
    this.previewDoc = opacity === null ? null : this.fadeDoc(opacity, mode);
  }

  fade(opacity: number, mode: FadeMode): boolean {
    this.previewDoc = null;
    const name = this.fadeState?.name;
    const next = this.fadeDoc(opacity, mode);
    if (!next || !name) return false;
    this.commit(next, `Fade ${name}`);
    return true;
  }

  // ---- Apply Image and Calculations -------------------------------------------------------

  /** A source image for Apply Image/Calculations: the merged composite, or a pixel layer. */
  private sourceRaster(layerId: number | null): ArrayLike<number> | null {
    if (layerId === null) return this.documentPixels()?.pixels ?? null;
    const layer = findLayer(this.doc.layers, layerId);
    return layer && layer.kind === 'pixel' ? SpatialCmd.layerRaster(this.doc, layer) : null;
  }

  /** The document Apply Image would produce — into the target's pixels or, if targeted, its mask. */
  private applyImageDoc(o: ApplyImageOptions): Doc | null {
    const target = this.paintTarget();
    const src = this.sourceRaster(o.sourceLayerId);
    if (!target || !src) return null;
    const layer = findLayer(this.doc.layers, target.id);
    if (!layer) return null;
    const coverage = this.doc.selection?.mask;
    const rect = { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
    if (target.mask) {
      if (!layer.mask) return null;
      const raster = bitmapFromPlane(layer.mask.plane.base, rect).data;
      applyImage(raster, src, o, coverage);
      const grey = new Uint8Array(raster.length / 4);
      for (let i = 0; i < grey.length; i++) grey[i] = Math.round(0.3 * raster[i * 4]! + 0.59 * raster[i * 4 + 1]! + 0.11 * raster[i * 4 + 2]!);
      return MaskPaint.setMaskFromGrey(this.doc, target.id, grey);
    }
    if (layer.kind !== 'pixel' || layer.locks.pixels || layer.locks.all) return null;
    const raster = SpatialCmd.layerRaster(this.doc, layer);
    applyImage(raster, src, o, coverage);
    const plane = new MipPlane(SpatialCmd.writeRaster(layer.plane.base, this.doc.width, this.doc.height, raster));
    return { ...this.doc, layers: updateLayer(this.doc.layers, layer.id, (l) => ({ ...l, plane }) as typeof l) };
  }

  previewApplyImage(o: ApplyImageOptions | null): void {
    this.previewDoc = o ? this.applyImageDoc(o) : null;
  }

  applyImage(o: ApplyImageOptions): boolean {
    this.previewDoc = null;
    const next = this.applyImageDoc(o);
    if (!next) return false;
    this.commit(next, 'Apply Image');
    return true;
  }

  /** Image ▸ Calculations: two channels blended into a new alpha channel or a selection. */
  calculations(o: CalculationsOptions): boolean {
    const a = this.sourceRaster(o.source1.layerId);
    const b = this.sourceRaster(o.source2.layerId);
    if (!a || !b) return false;
    const grey = runCalculations(a, b, o);
    const sel = makeSelection(this.doc.width, this.doc.height, grey);
    if (o.result === 'selection') {
      this.commit({ ...this.doc, selection: sel }, 'Calculations');
    } else {
      this.commit(ChannelCmd.saveSelection(this.doc, sel, {}), 'Calculations');
    }
    return true;
  }

  // ---- Info panel probes ------------------------------------------------------------------

  /** The composite WITH the open dialog's preview, for the Info panel's "after" numbers. */
  private afterPixels: { key: unknown; px: { pixels: Uint8Array; width: number; height: number } } | null = null;

  private previewPixels(): { pixels: Uint8Array; width: number; height: number } | null {
    const key = this.previewDoc ?? this.adjustPreview;
    if (!key) return null;
    if (this.afterPixels?.key === key) return this.afterPixels.px;
    let doc: Doc;
    if (this.previewDoc) doc = this.previewDoc;
    else {
      // The GPU preview as a real (clipped, masked) adjustment layer, so the offscreen render
      // takes the same path the frame does.
      const p = this.adjustPreview!;
      const layer = makeAdjustmentLayer('<preview>', p.adjustment, {
        clipped: true,
        mask: p.mask ? { plane: p.mask, enabled: true, linked: true, density: 1, feather: 0, defaultColor: 0 } : undefined,
      });
      doc = { ...this.doc, layers: insertLayer(this.doc.layers, layer, p.layerId) };
    }
    const px = this.renderer.renderToBuffer(doc, this.caps.maxTextureSize);
    this.afterPixels = { key, px };
    return px;
  }

  /**
   * Colour readouts for the Info panel: under the pointer (screen coordinates, if given) and
   * at each colour sampler (document coordinates). "after" is present only while a dialog is
   * previewing, which is when Photoshop shows before/after pairs.
   */
  probe(cursor: { x: number; y: number } | null, samplers: readonly { x: number; y: number }[]): ProbeReply {
    const before = this.documentPixels();
    const after = this.previewPixels();
    const read = (px: { pixels: Uint8Array; width: number; height: number } | null, x: number, y: number): [number, number, number, number] | null => {
      if (!px || x < 0 || y < 0 || x >= px.width || y >= px.height) return null;
      const o = (y * px.width + x) * 4;
      return [px.pixels[o]!, px.pixels[o + 1]!, px.pixels[o + 2]!, px.pixels[o + 3]!];
    };
    const at = (x: number, y: number) => ({ x, y, before: read(before, x, y), after: after ? read(after, x, y) : null });
    let c = null;
    if (cursor) {
      const p = docPointAtScreen(this.view, cursor.x, cursor.y);
      c = at(Math.floor(p.x), Math.floor(p.y));
    }
    return { cursor: c, samplers: samplers.map((s) => at(Math.floor(s.x), Math.floor(s.y))) };
  }

  // ---- fill layers and patterns ---------------------------------------------------------

  /**
   * Patterns available to fill layers: the built-ins, anything made with Edit ▸ Define
   * Pattern this session, and every pattern found in an opened PSD. Photoshop keeps this as a
   * preset library; here it lives as long as the worker.
   */
  private patternLibrary: PatternDef[] = builtinPatterns();

  private findPattern(id: string): PatternDef | null {
    const lib = this.patternLibrary.find((p) => p.id === id);
    if (lib) return lib;
    for (const { layer } of walkLayers(this.doc.layers)) {
      if (layer.kind === 'fill' && layer.content.type === 'pattern' && layer.content.pattern.id === id) return layer.content.pattern;
    }
    return null;
  }

  private fillFromSummary(s: FillSummary): FillContent | null {
    if (s.type !== 'pattern') return s;
    const pattern = this.findPattern(s.patternId);
    return pattern ? { type: 'pattern', pattern, scale: s.scale, phase: s.phase } : null;
  }

  static fillToSummary(c: FillContent): FillSummary {
    if (c.type !== 'pattern') return c;
    return { type: 'pattern', patternId: c.pattern.id, patternName: c.pattern.name, scale: c.scale, phase: c.phase };
  }

  addFillLayer(content: FillSummary): boolean {
    const c = this.fillFromSummary(content);
    if (!c) return false;
    this.commit(AdjustCmd.addFillLayer(this.doc, c), `New ${FILL_LABEL[c.type]} Layer`);
    return true;
  }

  /**
   * Like `setLayerAdjustment`: intermediate steps skip history, `final` records one step.
   * `amend` folds the final content into the step that CREATED the layer instead — the New
   * Fill Layer dialog creates the layer so it can preview, and OK should still be one step.
   */
  setFillContent(id: number, content: FillSummary, final: boolean, amend = false): boolean {
    const c = this.fillFromSummary(content);
    if (!c) return false;
    const next = AdjustCmd.setFillContent(this.doc, id, c);
    if (next === this.doc) return false;
    if (final && amend) {
      this.doc = next;
      this.history.amend(`New ${FILL_LABEL[c.type]} Layer`, next);
      this.compositeCache = null;
    } else if (final) {
      this.commit(next, `Modify ${FILL_LABEL[c.type]} Layer`);
    } else {
      this.doc = next;
    }
    return true;
  }

  patternSummaries(): PatternSummary[] {
    return this.patternLibrary.map((p) => {
      // Nearest-neighbour 32×32 preview, tiling small patterns so they read as patterns.
      const thumb = new Uint8Array(32 * 32 * 4);
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const sx = p.width >= 32 ? Math.floor((x * p.width) / 32) : x % p.width;
          const sy = p.height >= 32 ? Math.floor((y * p.height) / 32) : y % p.height;
          thumb.set(p.data.subarray((sy * p.width + sx) * 4, (sy * p.width + sx) * 4 + 4), (y * 32 + x) * 4);
        }
      }
      return { id: p.id, name: p.name, width: p.width, height: p.height, thumb };
    });
  }

  /**
   * Edit ▸ Define Pattern: the visible image inside a rectangular selection (or the whole
   * canvas) becomes a pattern. Photoshop takes the merged image too; its 4000 px cap on each
   * side is kept.
   */
  definePattern(name: string): boolean {
    const bounds = selectionBoundsOf(this.doc.selection) ?? { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
    const w = Math.min(4000, bounds.x1 - bounds.x0);
    const h = Math.min(4000, bounds.y1 - bounds.y0);
    if (w < 1 || h < 1) return false;
    const { pixels, width } = this.renderer.renderToBuffer(this.doc, this.caps.maxTextureSize);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((bounds.y0 + y) * width + bounds.x0) * 4;
      data.set(pixels.subarray(src, src + w * 4), y * w * 4);
    }
    const id = `umbra-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.patternLibrary.push({ id, name: name || `Pattern ${this.patternLibrary.length + 1}`, width: w, height: h, data });
    return true;
  }

  /** Layer ▸ New Adjustment Layer ▸ …, and the Adjustments panel. */
  addAdjustmentLayer(adjustment: Adjustment): boolean {
    const next = AdjustCmd.addAdjustmentLayer(this.doc, adjustment);
    this.commit(next, `New ${ADJUSTMENT_LABEL[adjustment.kind]} Layer`);
    return true;
  }

  /**
   * Edit an adjustment layer from the Properties panel. Intermediate values of a drag are
   * applied without a history step; `final` records one step for the whole gesture, named as
   * Photoshop names it ("Modify Curves Layer").
   */
  setLayerAdjustment(id: number, adjustment: Adjustment, final: boolean): boolean {
    const next = AdjustCmd.setAdjustment(this.doc, id, adjustment);
    if (next === this.doc) return false;
    if (final) this.commit(next, `Modify ${ADJUSTMENT_LABEL[adjustment.kind]} Layer`);
    else this.doc = next;
    return true;
  }

  /**
   * Histograms for the Levels and Curves editors. `layer` counts the active layer's pixels
   * inside the selection — what a destructive adjustment will act on. `below` counts the
   * composite underneath adjustment layer `id` — what that layer receives as its input.
   * `composite` is the whole image, for the Histogram panel. Fully transparent pixels are not
   * counted in any of them.
   */
  histogram(source: 'layer' | 'below' | 'composite', id?: number): { r: Uint32Array; g: Uint32Array; b: Uint32Array; lum: Uint32Array } {
    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    const lum = new Uint32Array(256);
    const count = (R: number, G: number, B: number) => {
      r[R]!++;
      g[G]!++;
      b[B]!++;
      lum[Math.round(luminance(R, G, B))]!++;
    };

    if (source === 'layer') {
      const layerId = this.adjustTarget();
      const layer = layerId === null ? undefined : findLayer(this.doc.layers, layerId);
      if (!layer || layer.kind !== 'pixel') return { r, g, b, lum };
      const plane = layer.plane.base;
      const sel = this.doc.selection;
      for (const { tx, ty } of plane.tileCells()) {
        if (!plane.hasTile(tx, ty)) continue;
        const tile = plane.tileAt(tx, ty);
        const d = tile.data;
        for (let y = 0; y < TILE_SIZE; y++) {
          const dy = (ty << TILE_SHIFT) + y;
          if (dy < 0 || dy >= this.doc.height) continue;
          for (let x = 0; x < TILE_SIZE; x++) {
            const dx = (tx << TILE_SHIFT) + x;
            if (dx < 0 || dx >= this.doc.width) continue;
            if (sel && sel.mask[dy * sel.width + dx]! < 128) continue;
            const o = tile.uniform ? 0 : (y * TILE_SIZE + x) * 4;
            if (d[o + 3] === 0) continue;
            count(d[o]!, d[o + 1]!, d[o + 2]!);
          }
        }
      }
      return { r, g, b, lum };
    }

    let below = this.doc;
    if (source === 'below') {
      const target = id ?? this.doc.activeLayerIds[0];
      if (target === undefined) return { r, g, b, lum };
      below = { ...this.doc, layers: layersBelow(this.doc.layers, target) };
    }
    const { pixels } = this.renderer.renderToBuffer(below, this.caps.maxTextureSize);
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue;
      count(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    }
    return { r, g, b, lum };
  }

  // ---- masks ----------------------------------------------------------------------------

  maskCommand(command: string, id?: number): boolean {
    const target = id ?? this.doc.activeLayerIds[0];
    if (target === undefined) return false;
    let next: Doc;
    let name: string;
    switch (command) {
      case 'revealAll':
      case 'hideAll':
      case 'revealSelection':
      case 'hideSelection':
      case 'fromTransparency':
        next = MaskCmd.addMask(this.doc, target, command);
        name = 'Add Layer Mask';
        break;
      case 'add': {
        // The Layers panel button: reveal the selection when there is one, else reveal all.
        next = MaskCmd.addMask(this.doc, target, this.doc.selection ? 'revealSelection' : 'revealAll');
        name = 'Add Layer Mask';
        break;
      }
      case 'delete':
        next = MaskCmd.deleteMask(this.doc, target);
        name = 'Delete Layer Mask';
        break;
      case 'apply':
        next = MaskCmd.applyMask(this.doc, target);
        name = 'Apply Layer Mask';
        break;
      case 'toggle': {
        // The menu's single Enable/Disable item, and Shift-click on the mask thumbnail.
        const layer = findLayer(this.doc.layers, target);
        if (!layer?.mask) return false;
        const on = !layer.mask.enabled;
        next = MaskCmd.setMaskEnabled(this.doc, target, on);
        name = on ? 'Enable Layer Mask' : 'Disable Layer Mask';
        break;
      }
      default:
        return false;
    }
    if (next === this.doc) return false;
    this.commit(next, name);
    return true;
  }

  // ---- layer via copy / cut --------------------------------------------------------------

  /**
   * Layer ▸ New ▸ Layer Via Copy / Via Cut. These go through the clipboard's extract and paste
   * but never TOUCH the clipboard — Photoshop keeps whatever the user copied, and so do we.
   */
  layerVia(cut: boolean): boolean {
    const clip = ClipCmd.copy(this.doc);
    if (!clip) return false;
    const source = cut ? ClipCmd.clearSelection(this.doc) : this.doc;
    const next = ClipCmd.paste({ ...source, selection: null }, clip, 'inPlace', this.view.centre);
    this.commit(next, cut ? 'Layer Via Cut' : 'Layer Via Copy');
    return true;
  }

  // ---- fixed layer transforms -------------------------------------------------------------

  /**
   * Edit ▸ Transform ▸ Rotate 180° / 90° CW / 90° CCW / Flip Horizontal / Flip Vertical on the
   * active layer, about its own centre. (Image ▸ Image Rotation does the same to the whole
   * canvas; these leave the canvas alone.)
   */
  transformLayerFixed(op: 'rotate180' | 'rotate90cw' | 'rotate90ccw' | 'flipH' | 'flipV'): boolean {
    const ids = this.doc.activeLayerIds.length > 0 ? [...this.doc.activeLayerIds] : this.fallbackLayerIds();
    const box = TransformCmd.transformBounds(this.doc, ids);
    if (!box) return false;
    const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    const m =
      op === 'rotate180' ? rotateMat(Math.PI)
      : op === 'rotate90cw' ? rotateMat(Math.PI / 2)
      : op === 'rotate90ccw' ? rotateMat(-Math.PI / 2)
      : op === 'flipH' ? scaleMat(-1, 1)
      : scaleMat(1, -1);
    // Quarter turns and flips of an integer-sized box land on whole pixels when the centre
    // does; rounding the pivot keeps them lossless instead of resampling half a pixel.
    const pivot = { x: Math.round(centre.x * 2) / 2, y: Math.round(centre.y * 2) / 2 };
    const next = TransformCmd.transformLayers(this.doc, about(m, pivot), 'nearest', ids);
    if (next === this.doc) return false;
    this.commit(next, op.startsWith('flip') ? 'Flip' : 'Rotate');
    return true;
  }

  renameLayer(id: number, name: string): void {
    const trimmed = name.trim();
    const layer = findLayer(this.doc.layers, id);
    // An empty name is refused rather than stored: Photoshop reverts to the old name.
    if (!layer || !trimmed || trimmed === layer.name) return;
    this.commit(
      { ...this.doc, layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, name: trimmed })) },
      'Rename Layer',
    );
  }

  // ---- history --------------------------------------------------------------------------

  /** Jump to any state, as clicking a row in the History panel does. */
  historyGoto(index: number): boolean {
    const doc = this.history.goto(index);
    if (!doc) return false;
    this.doc = doc;
    this.compositeCache = null;
    return true;
  }

  historySnapshot(name?: string): void {
    this.history.snapshot(name ?? `Snapshot ${this.history.list().filter((s) => s.snapshot).length}`);
  }

  historyConfigure(patch: { limit?: number; nonLinear?: boolean }): void {
    this.history.configure(patch);
  }

  /** Edit ▸ Toggle Last State (Ctrl+Alt+Z). */
  toggleLastState(): boolean {
    const doc = this.history.toggleLast();
    if (!doc) return false;
    this.doc = doc;
    this.compositeCache = null;
    return true;
  }

  // ---- channels -------------------------------------------------------------------------

  /**
   * Which channel the canvas shows. 'all' is the normal composite; 'r'/'g'/'b' show one colour
   * channel as greyscale; a number shows that alpha channel. Photoshop treats this as a view
   * setting, not a document edit, so it is not on the undo stack.
   */
  channelView: 'all' | 'r' | 'g' | 'b' | number = 'all';

  saveSelection(opts: { targetId?: number; op?: CombineOp; name?: string } = {}): void {
    if (!this.doc.selection) return;
    this.commit(ChannelCmd.saveSelection(this.doc, this.doc.selection, opts), 'Save Selection');
  }

  loadSelection(channelId: number, opts: { op?: CombineOp; invert?: boolean } = {}): void {
    const sel = ChannelCmd.loadSelection(this.doc, channelId, opts);
    if (sel) this.setSelection(sel, 'Load Selection');
  }

  channelCommand(command: string, id?: number, patch?: Record<string, unknown>): void {
    switch (command) {
      case 'delete':
        if (id !== undefined) this.commit(ChannelCmd.deleteChannel(this.doc, id), 'Delete Channel');
        break;
      case 'duplicate':
        if (id !== undefined) this.commit(ChannelCmd.duplicateChannel(this.doc, id), 'Duplicate Channel');
        break;
      case 'update':
        if (id !== undefined && patch) {
          this.commit(ChannelCmd.updateChannel(this.doc, id, patch as never), 'Channel Options');
        }
        break;
      case 'newFromSelection':
        this.saveSelection({});
        break;
    }
  }

  // ---- crop -----------------------------------------------------------------------------

  /**
   * The Crop tool's rectangle, in document space. It reuses the transform box for its handles
   * — a crop rectangle and a transform box are dragged the same way — but it commits by
   * moving the canvas rather than the pixels.
   */
  private crop: { rect: Rect } | null = null;
  /**
   * The last committed Free Transform, for Edit ▸ Transform ▸ Again. It is kept in document
   * space, pivot included, so repeating it CONTINUES the motion — rotate 15° about a point,
   * then Again, and the layer is at 30° about the same point. That is what makes Again useful
   * for laying copies out around a centre.
   */
  private lastTransform: Mat | null = null;
  cropDeletesPixels = false;

  get cropActive(): boolean {
    return this.crop !== null;
  }

  beginCrop(): void {
    // Photoshop opens the crop on the whole canvas, or on the selection when there is one.
    const sel = TransformCmd.selectionBoundsOf(this.doc);
    this.crop = { rect: sel ?? { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height } };
    this.transform = {
      box: this.crop.rect,
      matrix: IDENTITY,
      ids: [],
      selectionOnly: true,
      baseSelection: null,
      transient: false,
      drag: null,
    };
  }

  /** Drag a corner to set the crop rectangle directly, as dragging on an empty canvas does. */
  setCropRect(x0: number, y0: number, x1: number, y1: number): void {
    const a = docPointAtScreen(this.view, x0, y0);
    const b = docPointAtScreen(this.view, x1, y1);
    const rect: Rect = {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y),
    };
    this.crop = { rect };
    if (this.transform) this.transform = { ...this.transform, box: rect, matrix: IDENTITY };
  }

  commitCrop(): void {
    const c = this.crop;
    const t = this.transform;
    if (!c) return;
    // The handles moved the box through a matrix; the crop rectangle is where it ended up.
    const rect = t ? TransformCmd.transformedRect(t.box, t.matrix) : c.rect;
    this.crop = null;
    this.transform = null;
    const clipped: Rect = {
      x0: Math.max(0, Math.round(rect.x0)),
      y0: Math.max(0, Math.round(rect.y0)),
      x1: Math.min(this.doc.width, Math.round(rect.x1)),
      y1: Math.min(this.doc.height, Math.round(rect.y1)),
    };
    if (clipped.x1 - clipped.x0 < 1 || clipped.y1 - clipped.y0 < 1) return;
    this.commit(ImageCmd.crop(this.doc, clipped, this.cropDeletesPixels), 'Crop');
    this.fitView(this.doc.width, this.doc.height);
  }

  cancelCrop(): void {
    this.crop = null;
    this.transform = null;
  }

  /** Image ▸ Crop: straight to the selection's bounds, with no interactive step. */
  cropToSelection(): void {
    const rect = TransformCmd.selectionBoundsOf(this.doc);
    if (!rect) return;
    this.commit(ImageCmd.crop(this.doc, rect, this.cropDeletesPixels), 'Crop');
    this.fitView(this.doc.width, this.doc.height);
  }

  // ---- bucket & gradient ----------------------------------------------------------------

  /**
   * Paint Bucket. The region comes from the same flood fill the Magic Wand uses, on the same
   * composited pixels — so clicking with the bucket fills exactly what clicking with the wand
   * would have selected, which is the behaviour users rely on.
   */
  bucketAt(x: number, y: number, color: [number, number, number], mode: PaintMode, opacity: number): void {
    const composite = this.documentPixels();
    if (!composite) return;
    const p = docPointAtScreen(this.view, x, y);
    const mask = magicWand(composite.pixels, { width: composite.width, height: composite.height }, Math.floor(p.x), Math.floor(p.y), {
      tolerance: this.selectOptions.tolerance,
      contiguous: this.selectOptions.contiguous,
      antialias: this.selectOptions.antialias,
    });
    this.commit(
      FillCmd.bucketFill(this.doc, mask, {
        color,
        mode: mode === 'behind' || mode === 'clear' ? 'normal' : mode,
        opacity,
        preserveTransparency: false,
      }),
      'Paint Bucket',
    );
  }

  /** Gradient tool. The drag is in screen space; the gradient is drawn in document space. */
  drawGradient(opts: {
    gradient: Gradient;
    style: GradientStyle;
    from: { x: number; y: number };
    to: { x: number; y: number };
    reverse: boolean;
    dither: boolean;
    mode: PaintMode;
    opacity: number;
  }): void {
    const a = docPointAtScreen(this.view, opts.from.x, opts.from.y);
    const b = docPointAtScreen(this.view, opts.to.x, opts.to.y);
    const target = this.paintTarget();
    if (target?.mask) {
      const next = MaskPaint.gradientMask(this.doc, target.id, {
        gradient: opts.gradient,
        style: opts.style,
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        reverse: opts.reverse,
        dither: opts.dither,
        mode: 'normal',
        opacity: opts.opacity,
        preserveTransparency: false,
      });
      if (next !== this.doc) this.commit(next, 'Gradient');
      return;
    }
    if (target === null && this.maskOnlyActive()) return;
    this.commit(
      FillCmd.drawGradient(this.doc, {
        gradient: opts.gradient,
        style: opts.style,
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        reverse: opts.reverse,
        dither: opts.dither,
        mode: opts.mode === 'behind' || opts.mode === 'clear' ? 'normal' : opts.mode,
        opacity: opts.opacity,
        preserveTransparency: false,
      }),
      'Gradient',
    );
  }

  // ---- clipboard ------------------------------------------------------------------------

  /**
   * The application clipboard. It is deliberately NOT the system clipboard: the system one
   * carries a flattened bitmap, which would lose the soft selection edge and the exact
   * coordinates Paste in Place needs. Importing an image FROM the system clipboard goes
   * through the normal open path instead.
   */
  private clipboard: ClipCmd.Clipboard | null = null;

  get hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  copy(merged: boolean): void {
    if (merged) {
      const composite = this.documentPixels();
      if (!composite) return;
      this.clipboard = ClipCmd.copyMerged(this.doc, composite) ?? this.clipboard;
      return;
    }
    this.clipboard = ClipCmd.copy(this.doc) ?? this.clipboard;
  }

  cut(): void {
    const next = ClipCmd.copy(this.doc);
    if (!next) return;
    this.clipboard = next;
    this.commit(ClipCmd.clearSelection(this.doc), 'Cut');
  }

  paste(mode: ClipCmd.PasteMode): void {
    if (!this.clipboard) return;
    this.commit(
      ClipCmd.paste(this.doc, this.clipboard, mode, this.view.centre),
      mode === 'inPlace' ? 'Paste in Place' : mode === 'normal' ? 'Paste' : 'Paste Into',
    );
  }

  // ---- move & transform ---------------------------------------------------------------

  get transformActive(): boolean {
    return this.transform !== null;
  }

  /**
   * Open a transform box. `transient` is the Move tool: same machinery, but it commits on
   * pointer-up instead of waiting for Enter, which is the only real difference between
   * dragging a layer and transforming it.
   */
  beginTransform(transient: boolean, selectionOnly = false): boolean {
    if (this.transform) return true;
    const ids = this.doc.activeLayerIds.length > 0 ? [...this.doc.activeLayerIds] : [];
    const box = selectionOnly
      ? TransformCmd.selectionBoundsOf(this.doc)
      : TransformCmd.transformBounds(this.doc, ids);
    if (!box) return false;
    this.transform = {
      box,
      matrix: IDENTITY,
      ids: ids.length > 0 ? ids : this.fallbackLayerIds(),
      selectionOnly,
      baseSelection: this.doc.selection,
      transient,
      drag: null,
    };
    return true;
  }

  private fallbackLayerIds(): number[] {
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i]!;
      if (l.kind === 'pixel') return [l.id];
    }
    return [];
  }

  /** The handle under a screen point, for the cursor and for starting a drag. */
  transformHandleAt(x: number, y: number): HandleId | 'body' | null {
    const t = this.transform;
    if (!t) return null;
    const h = hitHandle(t.box, t.matrix, this.view, x, y);
    if (h) return h;
    // Inside the box drags it; Photoshop moves the content from anywhere within.
    const inv = invertMat(t.matrix);
    if (!inv) return null;
    const p = docPointAtScreen(this.view, x, y);
    const local = applyMat(inv, p);
    const inside =
      local.x >= t.box.x0 && local.x <= t.box.x1 && local.y >= t.box.y0 && local.y <= t.box.y1;
    return inside ? 'body' : null;
  }

  beginTransformDrag(x: number, y: number, rotateHandle: boolean): boolean {
    const t = this.transform;
    if (!t) return false;
    const handle = rotateHandle ? 'rotate' : this.transformHandleAt(x, y);
    if (!handle) return false;
    t.drag = { handle, startScreen: { x, y }, startMatrix: t.matrix };
    return true;
  }

  /**
   * Update the in-flight drag. `constrain` is Shift (keep the aspect ratio, or snap rotation
   * to 15°) and `fromCentre` is Alt, both matching Photoshop's modifiers.
   */
  updateTransformDrag(x: number, y: number, constrain: boolean, fromCentre: boolean): void {
    const t = this.transform;
    if (!t?.drag) return;
    const start = docPointAtScreen(this.view, t.drag.startScreen.x, t.drag.startScreen.y);
    const now = docPointAtScreen(this.view, x, y);
    const { box } = t;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (w === 0 || h === 0) return;

    if (t.drag.handle === 'body') {
      t.matrix = compose(t.drag.startMatrix, translateMat(now.x - start.x, now.y - start.y));
      return;
    }

    const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };

    if (t.drag.handle === 'rotate') {
      const pivot = applyMat(t.drag.startMatrix, centre);
      let angle = Math.atan2(now.y - pivot.y, now.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x);
      // Shift snaps to 15°, as Photoshop's rotate does.
      if (constrain) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      t.matrix = compose(t.drag.startMatrix, about(rotateMat(angle), pivot));
      return;
    }

    // Scaling: work in the box's own space, so a rotated box still scales along its own axes.
    const inv = invertMat(t.drag.startMatrix);
    if (!inv) return;
    const localStart = applyMat(inv, start);
    const localNow = applyMat(inv, now);
    const dx = localNow.x - localStart.x;
    const dy = localNow.y - localStart.y;

    const id = t.drag.handle;
    const movesX = id === 'w' || id === 'e' || id.length === 2;
    const movesY = id === 'n' || id === 's' || id.length === 2;
    const west = id.includes('w');
    const north = id.includes('n');

    let sx = movesX ? (west ? (w - dx) / w : (w + dx) / w) : 1;
    let sy = movesY ? (north ? (h - dy) / h : (h + dy) / h) : 1;
    if (constrain && movesX && movesY) {
      // Keep the aspect ratio by taking the larger change, which is what feels responsive.
      const k = Math.abs(sx) > Math.abs(sy) ? sx : sy;
      sx = k;
      sy = k;
    }

    // The anchor is the opposite corner, unless Alt scales about the centre.
    const anchor = fromCentre
      ? centre
      : {
          x: movesX ? (west ? box.x1 : box.x0) : centre.x,
          y: movesY ? (north ? box.y1 : box.y0) : centre.y,
        };
    t.matrix = compose(about(scaleMat(sx, sy), anchor), t.drag.startMatrix);
  }

  /** End the pointer drag. The Move tool commits here; Free Transform waits for Enter. */
  endTransformDrag(): void {
    const t = this.transform;
    if (!t) return;
    t.drag = null;
    if (t.transient) this.commitTransform();
  }

  /** Nudge by the arrow keys, which the Move tool supports with no drag at all. */
  nudge(dx: number, dy: number): void {
    if (this.transform) {
      this.transform.matrix = compose(this.transform.matrix, translateMat(dx, dy));
      if (this.transform.transient) this.commitTransform();
      return;
    }
    this.commit(TransformCmd.transformLayers(this.doc, translateMat(dx, dy)), 'Move');
  }

  commitTransform(method: Resample = 'bicubic'): void {
    const t = this.transform;
    if (!t) return;
    this.transform = null;
    if (isIdentity(t.matrix)) return;

    if (t.selectionOnly) {
      if (!t.baseSelection) return;
      this.setSelection(TransformCmd.transformSelection(t.baseSelection, t.matrix), 'Transform Selection');
      return;
    }

    if (!t.transient) this.lastTransform = t.matrix;
    let next = TransformCmd.transformLayers(this.doc, t.matrix, method, t.ids);
    // A selection moves with the pixels when they are dragged, as Photoshop does for a
    // floating selection — otherwise the marching ants would be left behind.
    if (next.selection && !t.transient) next = { ...next, selection: next.selection };
    this.commit(next, t.transient ? 'Move' : 'Free Transform');
  }

  /** Edit ▸ Transform ▸ Again. Returns false when there is nothing to repeat. */
  transformAgain(): boolean {
    if (!this.lastTransform || this.transform) return false;
    const next = TransformCmd.transformLayers(this.doc, this.lastTransform);
    if (next === this.doc) return false;
    this.commit(next, 'Transform Again');
    return true;
  }

  cancelTransform(): void {
    this.transform = null;
  }

  /** Replace the transform with an exact matrix, for the options bar's numeric fields. */
  setTransformMatrix(m: Mat): void {
    if (this.transform) this.transform.matrix = m;
  }

  transformState(): { box: Rect; matrix: Mat } | null {
    return this.transform ? { box: this.transform.box, matrix: this.transform.matrix } : null;
  }

  // ---- fill & stroke ------------------------------------------------------------------

  /**
   * Edit ▸ Fill. With nothing to fill into, a layer is created first — the same courtesy the
   * brush extends, and the alternative is a command that silently does nothing on a new
   * document.
   */
  fill(opts: FillCmd.FillOptions): void {
    const target = this.paintTarget();
    if (target?.mask) {
      // Fill with Transparent (and Delete) on a mask reveals, as the background colour would.
      const next = MaskPaint.fillMask(this.doc, target.id, opts.clear ? [1, 1, 1] : opts.color, opts.opacity);
      if (next !== this.doc) this.commit(next, opts.clear ? 'Clear' : 'Fill');
      return;
    }
    if (target === null && this.maskOnlyActive()) return;
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

    const paint = this.paintTarget();
    if (paint?.mask) {
      // Masks hold grey: the brush paints its colour's luminance, the eraser white (revealing,
      // as Photoshop's eraser paints the default white background colour into a mask).
      const g = mode === 'clear' ? 1 : MaskPaint.lumOf(color);
      this.strokeParams = { size: params.size, hardness: params.hardness, color: [g, g, g, 1] };
      this.strokeIntoMask = true;
      this.strokeLayerId = paint.id;
      this.strokeWriter = Plane.empty(RGBA8).writer();
      this.painting = true;
      return;
    }
    this.strokeIntoMask = false;
    if (paint === null && this.maskOnlyActive()) return;

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

  // ---- mask targeting ---------------------------------------------------------------------

  /**
   * The layer whose MASK is the edit target — Photoshop's "clicked the mask thumbnail". An
   * adjustment or fill layer's mask is always the target: they have nothing else to paint.
   */
  private maskTarget: number | null = null;
  private strokeIntoMask = false;

  setMaskTarget(id: number, mask: boolean): boolean {
    const layer = findLayer(this.doc.layers, id);
    const next = mask && layer?.mask ? id : null;
    if (next === this.maskTarget) return false;
    this.maskTarget = next;
    return true;
  }

  /** What painting acts on: the active layer's pixels or its mask; null when neither. */
  private paintTarget(): { id: number; mask: boolean } | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (!layer) return null;
    if (layer.kind === 'adjustment' || layer.kind === 'fill') return layer.mask ? { id: layer.id, mask: true } : null;
    if (this.maskTarget === layer.id && layer.mask) return { id: layer.id, mask: true };
    return layer.kind === 'pixel' ? { id: layer.id, mask: false } : null;
  }

  /** The active layer exists and has no paintable pixels — a group, or a maskless adjustment. */
  private maskOnlyActive(): boolean {
    const id = this.doc.activeLayerIds[0];
    return id !== undefined && !!findLayer(this.doc.layers, id);
  }

  private activePixelLayer(): PixelLayer | null {
    const id = this.doc.activeLayerIds[0];
    const found = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (found && found.kind === 'pixel') return found;
    // A group, adjustment or fill layer is active: Photoshop refuses rather than painting
    // somewhere else. (Their masks are painted through `paintTarget`.)
    if (found) return null;
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
    const before = this.doc;
    const intoMask = this.strokeIntoMask;
    this.commit(
      this.strokeIntoMask
        ? MaskPaint.compositeStrokeIntoMask(this.doc, id, strokePlane, this.brush.opacity)
        : FillCmd.compositeStroke(this.doc, id, strokePlane, this.brush.opacity, this.paintMode),
      this.paintMode === 'clear' ? 'Eraser' : 'Brush Tool',
    );
    this.fadeState = { before, after: this.doc, name: this.paintMode === 'clear' ? 'Eraser' : 'Brush Tool', layerId: id, mask: intoMask };
    this.strokeIntoMask = false;
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
    this.maybeJournal(start);

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
    const live = this.strokeWriter && this.strokeLayerId !== null;
    this.renderer.setMaskStrokeOverlay(
      live && this.strokeIntoMask
        ? { plane: new MipPlane(this.strokeWriter!.preview(), 0), layerId: this.strokeLayerId!, opacity: this.brush.opacity }
        : null,
    );
    this.renderer.setEraseOverlay(
      this.strokeWriter && this.strokeLayerId !== null && !this.strokeIntoMask && this.paintMode === 'clear'
        ? {
            plane: new MipPlane(this.strokeWriter.preview(), 0),
            layerId: this.strokeLayerId,
            opacity: this.brush.opacity,
          }
        : null,
    );
    this.renderer.setStrokeOverlay(
      this.strokeWriter && this.strokeLayerId !== null && !this.strokeIntoMask && this.paintMode !== 'clear'
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
    // Layers under a live transform draw through its matrix rather than being rewritten.
    this.renderer.setLiveTransform(
      this.transform && !this.transform.selectionOnly && !isIdentity(this.transform.matrix)
        ? { ids: new Set(this.transform.ids), matrix: this.transform.matrix }
        : null,
    );
    this.renderer.setAdjustPreview(this.adjustPreview);
    const overlay = this.quickMask ? this.selectionTexture() : null;
    const s = this.renderer.render(
      this.previewDoc ?? this.doc,
      this.view,
      docRect(this.doc),
      undefined,
      wantAnts,
      overlay ? { tex: overlay.tex, style: this.quickMaskStyle } : null,
      this.transformState(),
      typeof this.channelView === 'string' ? this.channelView : 'all',
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
      viewWidth: this.view.width,
      viewHeight: this.view.height,
      viewRotation: this.view.rotation,
      lastLatencyMs: this.lastLatencyMs,
      transform: this.transform ? transformReadout(this.transform.box, this.transform.matrix) : null,
    };
  }

  summary(): DocSummary {
    return {
      name: this.doc.name,
      width: this.doc.width,
      height: this.doc.height,
      activeLayerIds: [...this.doc.activeLayerIds],
      maskTarget: this.paintTarget()?.mask ? this.doc.activeLayerIds[0] ?? null : null,
      editingContents: this.editingContents,
      lastFilter: this.lastFilterRun ? { id: this.lastFilterRun.id, label: FILTER_BY_ID.get(this.lastFilterRun.id)?.label ?? '' } : null,
      fadeName: this.fadeName,
      hasSelection: !!this.doc.selection,
      history: this.history.list().map((h) => ({
        name: h.name,
        snapshot: h.snapshot,
        time: h.time,
      })),
      historyIndex: this.history.index,
      channels: this.doc.channels.map((c) => ({
        id: c.id,
        name: c.name,
        visible: c.visible,
        indicates: c.indicates,
      })),
      selectionBounds: selectionBoundsOf(this.doc.selection),
      warnings: this.warnings.length ? this.warnings : undefined,
      layers: panelRows(this.doc.layers).map(({ layer, depth }) => ({
        id: layer.id,
        name: layer.name,
        kind: layer.kind,
        smart: layer.kind === 'smart' ? Engine.smartToSummary(layer) : undefined,
        adjustment: layer.kind === 'adjustment' ? layer.adjustment : undefined,
        fillContent: layer.kind === 'fill' ? Engine.fillToSummary(layer.content) : undefined,
        depth,
        opacity: layer.opacity,
        fill: layer.fill,
        blendMode: layer.blendMode,
        visible: layer.visible,
        clipped: layer.clipped,
        hasMask: !!layer.mask,
        maskEnabled: layer.mask ? layer.mask.enabled : false,
        locks: layer.locks,
        expanded: layer.kind === 'group' ? layer.expanded : false,
        tiles: layer.kind === 'pixel' || layer.kind === 'smart' ? layer.plane.base.tileCount : 0,
      })),
    };
  }

  private static smartToSummary(layer: SmartObjectLayer): SmartSummary {
    return {
      sourceName: layer.source.name,
      width: layer.source.doc.width,
      height: layer.source.doc.height,
      filtersEnabled: layer.filtersEnabled,
      hasFilterMask: !!layer.filterMask,
      filterMaskEnabled: !!layer.filterMask?.enabled,
      filters: layer.filters.map((f) => ({
        id: f.id,
        filterId: f.filterId,
        label: FILTER_BY_ID.get(f.filterId)?.label ?? f.filterId,
        enabled: f.enabled,
        blendMode: f.blendMode,
        opacity: f.opacity,
        params: f.params,
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

/**
 * The layer tree as it is beneath layer `id`: its later siblings dropped, and at every level
 * above it, everything after the group that contains it. What an adjustment layer receives.
 */
function layersBelow(layers: readonly Layer[], id: number): Layer[] {
  const out: Layer[] = [];
  for (const l of layers) {
    if (l.id === id) return out;
    if (l.kind === 'group' && findLayer(l.children, id)) {
      out.push({ ...l, children: layersBelow(l.children, id) });
      return out;
    }
    out.push(l);
  }
  return out;
}
