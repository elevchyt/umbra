/**
 * Engine: owns the document, the history and the GL context. Lives in a worker so that
 * neither UI work nor engine work can stall the other (spec 03 §2).
 */
import { VectorTool, arrangeSubpaths, mergeComponents, overlayOutline, type PathArrange, type VectorOptions, type VectorToolId } from './vector-tool.js';
import type { PathOverlay } from './render/path-overlay.js';
import { flattenSubpath, transformPath, type Path } from '@umbra/kernels/vector/path';
import { rasterizePath } from '@umbra/kernels/vector/raster';
import { coverageToPath } from '@umbra/kernels/vector/trace';
import { BUILTIN_SHAPES, readCsh, type CustomShape } from '@umbra/kernels/vector/custom';
import { DEFAULT_SHAPE_OPTIONS, SHAPE_NAMES, SHAPE_TOOLS, shapeFromDrag, type ShapeOptions, type ShapeToolId } from './shape-tool.js';
import { liveAfterEdit, makeShapeLayer, reshaped, VectorMaskCache, withLive } from './shape-layers.js';
import { ensureText, fontRegistry, layoutOf, makeTypeLayer, retyped, textReady, typeBounds, typeLayerName, typePath } from './type-layers.js';
import { alongInverse, alongPoint, trackOf, caretAt, hitTest, lineRangeAt, paragraphAt, replaceText, restyleAll, restyleParagraphs, restyleRange, selectionRects, stepCaret, styleAt, textOf, wordAt, type AntiAlias, type CharStyle, type ParaStyle, type TextSpec, type WarpSpec } from '@umbra/text';
import type { LiveShape } from '@umbra/kernels/vector/shapes';
import { layerPathName } from './shape-tool.js';
import { combine as combineMask, createMask } from '@umbra/kernels/selection';
import { DEFAULT_GLOBAL_LIGHT, mapEffectPatterns, scaleEffects, type GlobalLight, type LayerEffects } from '@umbra/kernels/effects/types';
import { EffectsCache, type EffectLayer } from './effects-layers.js';
import { builtinStyles, type StylePreset } from '@umbra/kernels/effects/presets';
import { readAsl, writeAsl } from './asl.js';
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
  insertBelow,
  DEFAULT_BLENDING_STATE,
  replaceLayer,
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
  type SavedPath,
  type ShapeLayer,
  type TypeLayer,
  hasPlane,
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
import { bitmapFromPlane, tightBounds } from './psd-save.js';
import { planeFromBitmap } from './psd-open.js';
import { ADJUSTMENT_LABEL, luminance, type Adjustment } from '@umbra/kernels/adjust';
import { autoColor, autoContrast, autoTone, equalizeLut } from '@umbra/kernels/auto';
import { builtinPatterns, FILL_LABEL, type FillContent, type PatternDef } from '@umbra/kernels/fill';
import type { FillSummary, PatternSummary, ShapeStrokeSummary, ProbeReply, SmartSummary } from './protocol.js';
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
  isPhysical,
  physicalTip,
  physicalTipId,
  catchUp as catchUpStroke,
  dabAlpha,
  finishStroke,
  strokeTo,
  type BrushParams,
  type BrushPattern,
  type CoverageContext,
  type Dab,
  type StrokeState,
  type TipBitmap,
  builtinBrushes,
  builtinTips,
  type BrushGroup,
  type BrushPreset,
} from '@umbra/kernels/brush';
import { readAbrFile, writeAbrFile } from './abr.js';
import { DEFAULT_RETOUCH, RetouchStroke, readPixel, type RetouchOptions, type RetouchToolId, type Rgba } from './retouch.js';
import * as HealCmd from './heal-tools.js';
import { readTplFile, type ToolPresetImport } from './tpl.js';
import { heal } from '@umbra/kernels/heal';
import { DUAL_MODES, TEXTURE_MODES, type DabStyle } from './render/dab.js';
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

export interface PathCommand {
  cmd: 'select' | 'new' | 'save' | 'rename' | 'duplicate' | 'delete' | 'fill' | 'stroke' | 'toSelection' | 'fromSelection' | 'toVectorMask';
  /** The path to act on; the selected one when absent. */
  id?: number;
  name?: string;
  color?: [number, number, number];
  mode?: string;
  opacity?: number;
  preserveTransparency?: boolean;
  feather?: number;
  antiAlias?: boolean;
  op?: string;
  tolerance?: number;
  tool?: 'brush' | 'pencil' | 'eraser';
  brush?: BrushParams;
  simulatePressure?: boolean;
}
/** History names of the retouching tools' strokes. */
export const RETOUCH_NAMES: Record<RetouchToolId, string> = {
  cloneStamp: 'Clone Stamp',
  patternStamp: 'Pattern Stamp',
  historyBrush: 'History Brush',
  spotHealing: 'Spot Healing Brush',
  removeTool: 'Remove Tool',
  artHistoryBrush: 'Art History Brush',
  colorReplacement: 'Color Replacement',
  backgroundEraser: 'Background Eraser',
  dodgeTool: 'Dodge',
  burnTool: 'Burn',
  spongeTool: 'Sponge',
  blurTool: 'Blur',
  sharpenTool: 'Sharpen',
  smudgeTool: 'Smudge',
  mixerBrush: 'Mixer Brush',
  healingBrush: 'Healing Brush',
};

/** Clone Source ▸ Show Overlay: how the source is shown under (or around) the brush. */
export interface CloneOverlay {
  show: boolean;
  /** 0…1 */
  opacity: number;
  /** Only under the brush tip. */
  clipped: boolean;
  /** Hidden while painting. */
  autoHide: boolean;
  invert: boolean;
  mode: 'normal' | 'darken' | 'lighten' | 'difference';
  sample: 'current' | 'currentBelow' | 'all';
  aligned: boolean;
  /** The brush's radius, px (for Clipped). */
  radius: number;
  transform: { scaleX: number; scaleY: number; angle: number; flipX: boolean; flipY: boolean };
}

/** Edit ▸ Content-Aware Fill's workspace settings (Photoshop's Content-Aware Fill panel). */
export interface CafOptions {
  sampling: 'auto' | 'rectangular' | 'custom';
  sampleAll: boolean;
  colorAdaptation: 'none' | 'default' | 'high' | 'veryHigh';
  rotation: 'none' | 'low' | 'medium' | 'high' | 'full';
  scale: boolean;
  mirror: boolean;
  output: 'current' | 'new' | 'duplicate';
  overlay: { show: boolean; opacity: number; color: [number, number, number]; indicates: 'sampling' | 'excluded' };
}

export const DEFAULT_CAF: CafOptions = {
  sampling: 'auto',
  sampleAll: false,
  colorAdaptation: 'default',
  rotation: 'none',
  scale: false,
  mirror: false,
  output: 'new',
  overlay: { show: true, opacity: 0.5, color: [0, 1, 0], indicates: 'sampling' },
};

/** What the workspace shows: its sampling mode (painting makes it Custom) and the preview. */
export interface CafState {
  active: boolean;
  sampling?: CafOptions['sampling'];
  preview?: { pixels: Uint8Array; width: number; height: number };
  busy?: boolean;
  note?: string;
}

/** Colour Adaptation and Rotation Adaptation levels [fit]: Photoshop does not publish them. */
const CAF_ADAPTATION = { none: 0, default: 0.4, high: 0.75, veryHigh: 1 } as const;
const CAF_ROTATION = { none: 0, low: Math.PI / 12, medium: Math.PI / 4, high: Math.PI / 2, full: Math.PI } as const;

/** The overlay's synthetic layer id: never a document layer's. */
const OVERLAY_ID = -1001;

export interface PatchOptions {
  tool: 'patch' | 'contentAwareMove';
  patchMode: 'normal' | 'contentAware';
  patchDirection: 'source' | 'destination';
  moveMode: 'move' | 'extend';
}

export type BrushLibraryOp =
  | { op: 'newPreset'; name: string; params: BrushPreset['params']; group?: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string }
  | { op: 'newGroup'; name: string }
  | { op: 'deleteGroup'; name: string }
  | { op: 'renameGroup'; name: string; to: string };
export type TypeCommand = 'rasterize' | 'toShape' | 'workPath' | 'horizontal' | 'vertical' | 'toParagraph' | 'toPoint' | `aa:${'none' | 'sharp' | 'crisp' | 'strong' | 'smooth'}`;
export type VectorMaskCommand = 'revealAll' | 'hideAll' | 'currentPath' | 'delete' | 'toggle' | 'rasterize' | 'rasterizeShape';
export type StyleCommand = 'copy' | 'paste' | 'clear' | 'hideAll' | 'scale' | 'createLayers' | 'rasterize';
export interface LayerStyleProps {
  opacity?: number;
  fill?: number;
  blendMode?: BlendMode;
  blending?: Layer['blending'];
}
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
  /** A retouching stroke (Clone Stamp, Dodge, Blur…): its CPU dabs, and for direct tools the working layer. */
  private retouch: RetouchStroke | null = null;
  private retouchLayer: PlaneWriter | null = null;
  private retouchDirty = false;
  private retouchTool: RetouchToolId | null = null;
  /** Healing Brush: the stroke's healed colours (same coverage), healed as it is painted. */
  private healWriter: PlaneWriter | null = null;
  /** Dabs painted since the last heal (x, y, reach). */
  private healPending: { x: number; y: number; r: number }[] = [];
  /** Clone Stamp / Healing: the Alt-clicked source point, and the offset the first aligned stroke fixed. */
  cloneSource: { x: number; y: number } | null = null;
  private cloneOffset: { dx: number; dy: number } | null = null;
  /** The History Brush's source state (its index in the History panel). */
  historyBrushSource = 0;
  private strokeState: StrokeState | null = null;
  brush: BrushParams = { ...DEFAULT_BRUSH };
  paintMode: PaintMode = 'normal';
  private strokeColor: [number, number, number] = [0, 0, 0];
  /** Sampled brush tips (built in, from ABR files, from Define Brush Preset), by id. */
  readonly brushTips = builtinTips();
  /** The stroke's shader settings and the same for the CPU reference (Quick Mask, retouch). */
  private dabStyle: DabStyle = {};
  private coverageCtx: CoverageContext = {};
  private patternLum = new Map<string, BrushPattern>();
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
    // Any other command ends a type session: its text becomes a history step of its own.
    const te = this.typeEdit;
    if (te && !this.committingType) {
      this.typeEdit = null;
      this.typeDrag = null;
      if (te.created || te.undo.length) this.history.push(te.created ? 'Type Tool' : 'Edit Type Layer', this.doc);
    }
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

  // ---- layer styles ----------------------------------------------------------------------

  /**
   * A style's patterns arrive from the UI by id (it only holds thumbnails); give them their
   * pixels from the library.
   */
  private resolveEffects(fx: LayerEffects): LayerEffects {
    return mapEffectPatterns(fx, (p) => (p.data.length ? p : this.findPattern(p.id)));
  }

  private styled(id: number, effects: LayerEffects | null, props?: LayerStyleProps): Doc {
    const fx = effects ? this.resolveEffects(effects) : undefined;
    return {
      ...this.doc,
      layers: updateLayer(this.doc.layers, id, (l) => ({
        ...l,
        effects: fx,
        ...(props?.opacity !== undefined ? { opacity: props.opacity } : {}),
        ...(props?.fill !== undefined ? { fill: props.fill } : {}),
        ...(props?.blendMode !== undefined ? { blendMode: props.blendMode } : {}),
        ...(props?.blending !== undefined ? { blending: props.blending } : {}),
      })),
    };
  }

  /** The Layer Style dialog's OK: effects and, from its Blending Options page, the layer's blending. */
  setLayerStyle(id: number, effects: LayerEffects | null, props?: LayerStyleProps, globalLight?: GlobalLight, historyName = 'Layer Style'): boolean {
    const layer = findLayer(this.doc.layers, id);
    if (!layer || (effects && layer.kind === 'adjustment')) return false;
    this.previewDoc = null;
    const next = this.styled(id, effects, props);
    this.commit(globalLight ? { ...next, globalLight } : next, historyName);
    return true;
  }

  /** The Layer Style dialog's live preview; null ends it. */
  previewLayerStyle(id: number, effects: LayerEffects | null, props?: LayerStyleProps, globalLight?: GlobalLight): void {
    if (!effects && !props) {
      this.previewDoc = null;
      return;
    }
    const doc = this.styled(id, effects, props);
    this.previewDoc = globalLight ? { ...doc, globalLight } : doc;
  }

  /** Layer ▸ Layer Style ▸ Global Light. */
  setGlobalLight(light: GlobalLight): boolean {
    this.previewDoc = null;
    this.commit({ ...this.doc, globalLight: light }, 'Global Light');
    return true;
  }

  /** Copy Layer Style keeps the effects and the blending options, as Photoshop's does. */
  private styleClipboard: { effects: LayerEffects | undefined; fill: number; blending: Layer['blending'] } | null = null;

  styleCommand(cmd: StyleCommand, amount?: number): boolean {
    const ids = this.doc.activeLayerIds;
    const layer = ids[0] === undefined ? undefined : findLayer(this.doc.layers, ids[0]);
    let doc = this.doc;
    let name = '';
    switch (cmd) {
      case 'copy':
        if (!layer) return false;
        this.styleClipboard = { effects: layer.effects, fill: layer.fill, blending: layer.blending };
        return true;
      case 'paste': {
        const c = this.styleClipboard;
        if (!c) return false;
        for (const id of ids) doc = { ...doc, layers: updateLayer(doc.layers, id, (l) => (l.kind === 'adjustment' ? l : { ...l, effects: c.effects, fill: c.fill, blending: c.blending })) };
        name = 'Paste Layer Style';
        break;
      }
      case 'clear':
        for (const id of ids) doc = { ...doc, layers: updateLayer(doc.layers, id, (l) => ({ ...l, effects: undefined, fill: 1, blending: DEFAULT_BLENDING_STATE })) };
        name = 'Clear Layer Style';
        break;
      case 'hideAll': {
        // Photoshop's item toggles: Hide All Effects when any show, else Show All Effects.
        const anyOn = [...walkLayers(doc.layers)].some(({ layer: l }) => l.effects?.enabled);
        let layers = doc.layers;
        for (const { layer: l } of walkLayers(doc.layers)) {
          if (l.effects) layers = updateLayer(layers, l.id, (x) => ({ ...x, effects: { ...x.effects!, enabled: !anyOn } }));
        }
        doc = { ...doc, layers };
        name = anyOn ? 'Hide All Effects' : 'Show All Effects';
        break;
      }
      case 'scale':
        if (!layer?.effects || !amount) return false;
        doc = { ...doc, layers: updateLayer(doc.layers, layer.id, (l) => ({ ...l, effects: scaleEffects(l.effects!, amount / 100) })) };
        name = 'Scale Effects';
        break;
      case 'createLayers': {
        if (!layer?.effects) return false;
        const made = new EffectsCache().get(layer, this.doc);
        if (!made) return false;
        // The generated layers become real ones, named as Photoshop names them.
        const real = (e: EffectLayer) => makePixelLayer(`${layer.name}'s ${e.name.split(' ▸ ')[1]}`, e.plane.base, { blendMode: e.blendMode, opacity: e.opacity * layer.opacity, visible: layer.visible });
        let layers = updateLayer(doc.layers, layer.id, (l) => ({ ...l, effects: undefined }));
        let below: number | undefined = undefined;
        // The lower ones go beneath the layer (the topmost of them just under it), the upper
        // ones above it in order.
        for (const e of [...made.below].reverse()) {
          const l = real(e);
          layers = insertBelow(layers, l, below ?? layer.id);
          below = l.id;
        }
        let above = layer.id;
        for (const e of made.above) {
          const l = real(e);
          layers = insertLayer(layers, l, above);
          above = l.id;
        }
        doc = { ...doc, layers };
        name = 'Create Layers';
        break;
      }
      case 'rasterize':
        if (!layer?.effects || layer.kind === 'group') return false;
        doc = {
          ...doc,
          layers: replaceLayer(doc.layers, layer.id, makePixelLayer(layer.name, LayerCmd.rasterize([{ ...layer, opacity: 1, visible: true }], { x0: 0, y0: 0, x1: doc.width, y1: doc.height }, doc.globalLight), { id: layer.id, opacity: layer.opacity, blendMode: layer.blendMode, visible: layer.visible, clipped: layer.clipped })),
        };
        name = 'Rasterize Layer Style';
        break;
    }
    if (doc === this.doc) return false;
    this.previewDoc = null;
    this.commit(doc, name);
    return true;
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
    // Undo from the menu ends a type session first (Ctrl+Z inside one undoes typing instead).
    this.typeCommit();
    const doc = this.history.undo();
    if (!doc) return false;
    this.doc = doc;
    // A path edit in progress refers to indices the older path may not have.
    this.vector.reset();
    return true;
  }

  redo(): boolean {
    this.typeCommit();
    const doc = this.history.redo();
    if (!doc) return false;
    this.doc = doc;
    this.vector.reset();
    return true;
  }

  // ---- paths and the vector tools --------------------------------------------------------

  /** Pen, Freeform/Curvature Pen, anchor tools, Path/Direct Selection (spec 04 §6). */
  readonly vector = new VectorTool(() => 6 / Math.max(1e-6, this.view.zoom));
  /** A vector tool is the active tool (anchors show only then). */
  vectorToolActive = false;
  /** The path the Paths panel has selected: what the vector tools edit and the commands use. */
  activePathId: number | null = null;
  private nextPathId = 1;

  private targetPath(): SavedPath | null {
    return (this.doc.paths ?? []).find((p) => p.id === this.activePathId) ?? null;
  }

  /** The active layer's own path: a shape layer's outline, or its vector mask. */
  private layerPath(): { layer: Layer; kind: 'shape' | 'mask'; path: Path } | null {
    const id = this.doc.activeLayerIds[0];
    const l = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (!l) return null;
    if (l.kind === 'shape') return { layer: l, kind: 'shape', path: l.path };
    if (l.vectorMask) return { layer: l, kind: 'mask', path: l.vectorMask.path };
    return null;
  }

  /** What the vector tools edit and the path commands use: the selected saved path, else the active layer's own. */
  private editPath(): Path | null {
    return this.targetPath()?.path ?? this.layerPath()?.path ?? null;
  }

  /** The document with the target path replaced; with no target, a new Work Path (replacing any old one). */
  private withPath(path: Path): Doc {
    const paths = this.doc.paths ?? [];
    const cur = this.targetPath();
    if (cur) return { ...this.doc, paths: paths.map((p) => (p.id === cur.id ? { ...p, path } : p)) };
    const lp = this.layerPath();
    if (lp) return { ...this.doc, layers: replaceLayer(this.doc.layers, lp.layer.id, this.layerWithPath(lp.layer, path)) };
    const id = this.nextPathId++;
    this.activePathId = id;
    return { ...this.doc, paths: [...paths.filter((p) => !p.work), { id, name: 'Work Path', path, work: true }] };
  }

  private layerWithPath(l: Layer, path: Path): Layer {
    if (l.kind === 'shape') return reshaped({ ...l, path, live: liveAfterEdit(l, path) }, this.doc);
    return { ...l, vectorMask: { enabled: true, ...l.vectorMask, path } };
  }

  private applyVector(r: { path: Path | null; commit: string | null }): boolean {
    if (r.path) this.doc = this.withPath(r.path);
    if (r.commit) {
      this.previewDoc = null;
      this.fadeState = null;
      this.history.push(r.commit, this.doc);
    }
    return !!(r.path || r.commit);
  }

  setVectorTool(tool: VectorToolId | ShapeToolId | null, options?: Partial<VectorOptions>): void {
    this.shapeDrag = null;
    if (tool && (SHAPE_TOOLS as readonly string[]).includes(tool)) {
      this.shapeTool = tool as ShapeToolId;
      this.vectorToolActive = false;
      return;
    }
    this.shapeTool = null;
    if (tool && tool !== this.vector.tool) {
      this.vector.tool = tool as VectorToolId;
      this.vector.drawing = null;
    }
    this.vectorToolActive = !!tool;
    if (options) this.vector.options = { ...this.vector.options, ...options };
  }

  /** A pointer event for the active vector tool, in screen coordinates. */
  vectorPointer(e: { phase: 'down' | 'move' | 'up'; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; clicks: number }): boolean {
    const d = docPointAtScreen(this.view, e.x, e.y);
    if (this.shapeTool) return this.shapePointer(e.phase, d, e.shift, e.alt);
    const r = this.vector.pointer(this.editPath(), { ...e, x: d.x, y: d.y });
    return this.applyVector(r) || e.phase !== 'move';
  }

  vectorKey(key: string): boolean {
    if (this.shapeTool) return false;
    return this.applyVector(this.vector.key(this.editPath(), key));
  }

  // ---- the shape tools ------------------------------------------------------------------

  shapeTool: ShapeToolId | null = null;
  shapeOptions: ShapeOptions = DEFAULT_SHAPE_OPTIONS;
  /** The built-in shapes and any loaded from .csh files. */
  customShapes: CustomShape[] = [...BUILTIN_SHAPES];
  private shapeDrag: { a: { x: number; y: number }; b: { x: number; y: number }; shift: boolean; alt: boolean } | null = null;

  setShapeOptions(patch: Partial<ShapeOptions>): void {
    this.shapeOptions = { ...this.shapeOptions, ...patch };
  }

  /** Load a .csh file into the custom shape set; returns the shapes added. */
  loadCustomShapes(buf: ArrayBuffer): { id: string; name: string }[] {
    const added = readCsh(buf).map((c) => ({ ...c, id: `${c.id}#${this.customShapes.length}` }));
    this.customShapes = [...this.customShapes, ...added];
    return added.map(({ id, name }) => ({ id, name }));
  }

  private dragShape(): ReturnType<typeof shapeFromDrag> {
    const g = this.shapeDrag;
    return g && this.shapeTool ? shapeFromDrag(this.shapeTool, g.a, g.b, g.shift, g.alt, this.shapeOptions, this.customShapes) : null;
  }

  private shapePointer(phase: 'down' | 'move' | 'up', d: { x: number; y: number }, shift: boolean, alt: boolean): boolean {
    if (phase === 'down') {
      this.shapeDrag = { a: d, b: d, shift, alt };
      return true;
    }
    if (!this.shapeDrag) return false;
    this.shapeDrag = { ...this.shapeDrag, b: d, shift, alt };
    if (phase === 'move') return true;
    const shape = this.dragShape();
    const tool = this.shapeTool!;
    this.shapeDrag = null;
    if (shape) this.drawShape(tool, shape);
    return true;
  }

  /** Commit a drawn shape as the tool mode says: a shape layer, path components, or pixels. */
  drawShape(tool: ShapeToolId, shape: NonNullable<ReturnType<typeof shapeFromDrag>>): void {
    const o = this.shapeOptions;
    const op = o.op === 'new' ? 'add' : o.op;
    const components = shape.path.subpaths.map((sp, i) => ({ ...sp, op: i === 0 ? op : sp.op === 'add' ? op : sp.op }));
    if (o.mode === 'pixels') {
      const sel = this.pathSelection(shape.path, 'new', 0, o.antiAlias);
      const color = o.fill?.type === 'solid' ? o.fill.color : [0, 0, 0];
      if (!sel) return;
      const next = FillCmd.fill({ ...this.doc, selection: sel }, { color: color as [number, number, number], mode: 'normal', opacity: 1, preserveTransparency: false });
      this.commit({ ...next, selection: this.doc.selection }, `${SHAPE_NAMES[tool]} Tool`);
      return;
    }
    if (o.mode === 'path') {
      const cur = this.editPath();
      const created = !cur;
      const path = { subpaths: [...(cur?.subpaths ?? []), ...components] };
      this.vector.reset();
      this.commit(this.withPath(path), created ? 'New Work Path' : 'Add Path Component');
      return;
    }
    const lp = this.layerPath();
    if (o.op !== 'new' && lp?.kind === 'shape') {
      const l = lp.layer as ShapeLayer;
      const next = reshaped({ ...l, path: { subpaths: [...l.path.subpaths, ...components] }, live: undefined }, this.doc);
      this.commit({ ...this.doc, layers: replaceLayer(this.doc.layers, l.id, next) }, 'Combine Shapes');
      return;
    }
    const name = LayerCmd.numberedName(this.doc, SHAPE_NAMES[tool]);
    const layer = makeShapeLayer(name, shape.path, o.fill, o.stroke.enabled ? o.stroke : null, this.doc, shape.live ? { live: shape.live } : {});
    const above = this.doc.activeLayerIds[0];
    // A new shape layer takes the path focus from any saved path, as in Photoshop.
    this.activePathId = null;
    this.vector.reset();
    this.commit({ ...this.doc, layers: insertLayer(this.doc.layers, layer, above), activeLayerIds: [layer.id] }, 'New Shape Layer');
  }

  /** The overlay the renderer draws for the vector tools. */
  private pathOverlay(): PathOverlay | null {
    const p = this.editPath();
    const trail = this.vector.trail;
    const drawn = this.dragShape();
    const extra = drawn ? overlayOutline(drawn.path) : [];
    const patchBox = this.patchOverlay();
    if (patchBox) return { outlines: [], anchors: [], handles: [], rubber: null, marquee: patchBox, trail: null };
    const type = this.typeOverlay();
    if (type) return { anchors: [], handles: [], rubber: null, trail: null, ...type, outlines: [...extra, ...(type.outlines ?? [])], marquee: type.marquee ?? null };
    if (!p) return trail || drawn ? { outlines: extra, anchors: [], handles: [], rubber: null, marquee: this.vector.marquee, trail } : null;
    const tools = this.vectorToolActive;
    const selected = new Set(this.vector.selected.map((r) => `${r.s}:${r.k}`));
    const wholeSelected = new Set(this.vector.selectedSubpaths);
    const anchors: PathOverlay['anchors'] = [];
    if (tools) {
      p.subpaths.forEach((sp, s) => sp.knots.forEach((k, i) => anchors.push({ p: k.anchor, selected: selected.has(`${s}:${i}`) || wholeSelected.has(s) })));
    }
    const handles: PathOverlay['handles'] = [];
    if (tools) {
      for (const r of this.vector.visibleHandleKnots(p)) {
        const k = p.subpaths[r.s]?.knots[r.k];
        if (!k) continue;
        if (Math.hypot(k.in.x - k.anchor.x, k.in.y - k.anchor.y) > 0.01) handles.push({ anchor: k.anchor, handle: k.in });
        if (Math.hypot(k.out.x - k.anchor.x, k.out.y - k.anchor.y) > 0.01) handles.push({ anchor: k.anchor, handle: k.out });
      }
    }
    let rubber: PathOverlay['rubber'] = null;
    const drawing = this.vector.drawing;
    if (tools && drawing !== null && this.vector.hover && this.vector.tool === 'pen') {
      const knots = p.subpaths[drawing]?.knots;
      if (knots?.length) rubber = [knots[knots.length - 1]!.anchor, this.vector.hover];
    }
    return { outlines: [...overlayOutline(p), ...extra], anchors, handles, rubber, marquee: this.vector.marquee, trail };
  }

  /** Paths panel commands and Fill/Stroke Path, Make Selection, Make Work Path. */
  pathCommand(cmd: PathCommand): boolean {
    const paths = this.doc.paths ?? [];
    const commitPaths = (next: readonly SavedPath[], name: string) => {
      this.commit({ ...this.doc, paths: next }, name);
      return true;
    };
    const target = cmd.id !== undefined ? paths.find((p) => p.id === cmd.id) : this.targetPath();
    // With no saved path selected, the commands act on the active layer's shape path or vector mask.
    const lp = cmd.id === undefined && !target ? this.layerPath() : null;
    const tpath = target?.path ?? lp?.path ?? null;
    switch (cmd.cmd) {
      case 'select':
        this.activePathId = cmd.id ?? null;
        this.vector.reset();
        return true;
      case 'new': {
        const id = this.nextPathId++;
        this.activePathId = id;
        this.vector.reset();
        return commitPaths([...paths, { id, name: cmd.name || `Path ${paths.filter((p) => !p.work).length + 1}`, path: { subpaths: [] }, work: false }], 'New Path');
      }
      case 'save':
        if (!target) return false;
        return commitPaths(paths.map((p) => (p.id === target.id ? { ...p, work: false, name: cmd.name || `Path ${paths.filter((q) => !q.work).length + 1}` } : p)), 'Save Path');
      case 'rename':
        if (!target || !cmd.name) return false;
        return commitPaths(paths.map((p) => (p.id === target.id ? { ...p, name: cmd.name! } : p)), 'Rename Path');
      case 'duplicate': {
        if (!tpath) return false;
        const id = this.nextPathId++;
        const base = target?.name ?? (lp ? layerPathName(lp.layer.name, lp.kind) : 'Path');
        return commitPaths([...paths, { id, name: `${base} copy`, path: tpath, work: false }], 'Duplicate Path');
      }
      case 'delete':
        if (lp) {
          // Deleting a layer's path deletes the vector mask; a shape layer's path cannot go.
          if (lp.kind !== 'mask') return false;
          return this.vectorMaskCommand('delete');
        }
        if (!target) return false;
        if (this.activePathId === target.id) this.activePathId = null;
        this.vector.reset();
        return commitPaths(paths.filter((p) => p.id !== target.id), 'Delete Path');
      case 'fill': {
        if (!tpath) return false;
        const sel = this.pathSelection(tpath, 'new', cmd.feather ?? 0, cmd.antiAlias !== false);
        if (!sel) return false;
        const next = FillCmd.fill({ ...this.doc, selection: sel }, { color: cmd.color ?? [0, 0, 0], mode: (cmd.mode ?? 'normal') as never, opacity: cmd.opacity ?? 1, preserveTransparency: !!cmd.preserveTransparency });
        this.commit({ ...next, selection: this.doc.selection }, 'Fill Path');
        return true;
      }
      case 'stroke':
        return tpath ? this.strokePath(tpath, cmd) : false;
      case 'toSelection': {
        if (!tpath) return false;
        const sel = this.pathSelection(tpath, (cmd.op ?? 'new') as CombineOp, cmd.feather ?? 0, cmd.antiAlias !== false);
        if (!sel) return false;
        this.setSelection(sel, 'Make Selection');
        return true;
      }
      case 'toVectorMask':
        return target ? this.vectorMaskCommand('currentPath') : this.vectorMaskCommand('revealAll');
      case 'fromSelection': {
        const sel = this.doc.selection;
        if (!sel) return false;
        const cov = new Float32Array(sel.mask.length);
        for (let i = 0; i < cov.length; i++) cov[i] = sel.mask[i]! / 255;
        const path = coverageToPath(cov, sel.width, sel.height, cmd.tolerance ?? 2);
        const id = this.nextPathId++;
        this.activePathId = id;
        this.vector.reset();
        return commitPaths([...paths.filter((p) => !p.work), { id, name: 'Work Path', path, work: true }], 'Make Work Path');
      }
    }
  }

  /** Layer ▸ Vector Mask ▸ …, and Layer ▸ Rasterize ▸ Vector Mask / Shape, on the active layer. */
  vectorMaskCommand(cmd: VectorMaskCommand): boolean {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (!layer || layer.kind === 'group' && cmd === 'rasterizeShape') return false;
    const put = (l: Layer, name: string) => {
      this.vector.reset();
      this.commit({ ...this.doc, layers: replaceLayer(this.doc.layers, layer.id, l) }, name);
      return true;
    };
    const vm = layer.vectorMask;
    switch (cmd) {
      case 'revealAll':
      case 'hideAll':
        if (vm) return false;
        return put({ ...layer, vectorMask: { path: { subpaths: [] }, enabled: true, hideAll: cmd === 'hideAll' } }, 'Add Vector Mask');
      case 'currentPath': {
        const saved = this.targetPath();
        if (vm || !saved) return false;
        this.activePathId = null;
        return put({ ...layer, vectorMask: { path: saved.path, enabled: true } }, 'Add Vector Mask');
      }
      case 'delete':
        if (!vm) return false;
        return put({ ...layer, vectorMask: undefined }, 'Delete Vector Mask');
      case 'toggle':
        if (!vm) return false;
        return put({ ...layer, vectorMask: { ...vm, enabled: !vm.enabled } }, vm.enabled ? 'Disable Vector Mask' : 'Enable Vector Mask');
      case 'rasterize': {
        if (!vm) return false;
        const mask = vm.enabled ? new VectorMaskCache().effectiveMask(layer, this.doc) : layer.mask;
        return put({ ...layer, vectorMask: undefined, mask }, 'Rasterize Vector Mask');
      }
      case 'rasterizeShape': {
        if (layer.kind !== 'shape') return false;
        const { path: _p, live: _l, fillContent: _f, stroke: _s, kind: _k, ...rest } = layer;
        return put(makePixelLayer(layer.name, layer.plane.base, { ...rest, id: layer.id }), 'Rasterize Shape');
      }
    }
  }

  /**
   * Layer ▸ Combine Shapes: the selected shape layers become one, the top one keeping its
   * name and appearance; each upper layer's components join with the operation. 'merge' is
   * Merge Shape Components on the active shape layer (or the selected path).
   */
  combineShapes(op: 'add' | 'subtract' | 'intersect' | 'exclude' | 'merge'): boolean {
    if (op === 'merge') {
      const path = this.editPath();
      if (!path?.subpaths.length) return false;
      this.vector.reset();
      this.commit(this.withPath(mergeComponents(path)), 'Merge Shape Components');
      return true;
    }
    const ids = new Set(this.doc.activeLayerIds);
    const picked = [...walkLayers(this.doc.layers)].map((w) => w.layer).filter((l): l is ShapeLayer => l.kind === 'shape' && ids.has(l.id));
    if (picked.length < 2) return false;
    const top = picked[picked.length - 1]!;
    const subpaths = picked.flatMap((l, n) => (n === 0 ? l.path.subpaths : l.path.subpaths.map((sp, i) => (i === 0 || sp.op === 'add' ? { ...sp, op } : sp))));
    const merged = reshaped({ ...top, path: { subpaths }, live: undefined }, this.doc);
    let layers = replaceLayer(this.doc.layers, top.id, merged);
    for (const l of picked) if (l !== top) layers = LayerCmd.deleteLayer({ ...this.doc, layers }, l.id).layers as Layer[];
    this.vector.reset();
    this.commit({ ...this.doc, layers, activeLayerIds: [top.id] }, 'Combine Shapes');
    return true;
  }

  /** Path Alignment and Path Arrangement on the components the Path Selection tool has selected. */
  arrangePath(cmd: PathArrange): boolean {
    const path = this.editPath();
    if (!path) return false;
    const r = arrangeSubpaths(path, this.vector.selectedSubpaths, cmd, this.doc);
    if (r.path === path) return false;
    this.vector.selectedSubpaths = r.selected;
    this.commit(this.withPath(r.path), cmd.startsWith('align') || cmd.startsWith('distribute') ? 'Align Components' : 'Arrange Components');
    return true;
  }

  /** Edit ▸ Define Custom Shape: the selected path (or the active layer's) joins the custom shapes. */
  defineCustomShape(name: string): boolean {
    const path = this.editPath();
    if (!path?.subpaths.some((sp) => sp.knots.length > 1)) return false;
    this.customShapes = [...this.customShapes, { id: `user-${this.customShapes.length}-${Date.now()}`, name: name || 'Shape', path }];
    return true;
  }

  /** A path's fill as a selection combined with the current one. */
  private pathSelection(path: Path, op: CombineOp, feather: number, antiAlias: boolean): Selection | null {
    const { width: w, height: h } = this.doc;
    const cov = rasterizePath(path, { x0: 0, y0: 0, x1: w, y1: h });
    const mask = createMask(w, h);
    for (let i = 0; i < mask.length; i++) mask[i] = antiAlias ? Math.round(cov[i]! * 255) : cov[i]! >= 0.5 ? 255 : 0;
    let sel = makeSelection(w, h, mask);
    if (feather > 0) sel = featherSelection(sel, feather);
    if (op === 'new' || !this.doc.selection) return sel;
    const dst = Uint8Array.from(this.doc.selection.mask);
    return makeSelection(w, h, combineMask(dst, sel.mask, op));
  }

  /**
   * Stroke Path: the brush (or pencil, or eraser) run along the path with the current tip and
   * colour; Simulate Pressure tapers it from nothing to full and back, as Photoshop does.
   */
  private strokePath(path: Path, cmd: PathCommand): boolean {
    if (!cmd.brush) return false;
    const mode: PaintMode = cmd.tool === 'eraser' ? 'clear' : ((cmd.mode ?? 'normal') as PaintMode);
    const brush = cmd.tool === 'pencil' ? { ...cmd.brush, hardness: 1 } : cmd.brush;
    let stroked = false;
    for (const sp of path.subpaths) {
      const pts = flattenSubpath(sp, 0.25);
      if (sp.closed && pts.length > 1) pts.push(pts[0]!);
      if (pts.length === 0) continue;
      // Resample at half-pixel spacing so the brush engine's own spacing decides the dabs.
      const along: { x: number; y: number }[] = [pts[0]!];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
        for (let j = 1; j <= n; j++) along.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n });
      }
      this.beginStroke(brush, cmd.color ?? [0, 0, 0], mode);
      if (!this.painting || !this.strokeState) continue;
      const t0 = nowAbs();
      along.forEach((q, i) => {
        const f = along.length > 1 ? i / (along.length - 1) : 0.5;
        const pressure = cmd.simulatePressure ? Math.sin(Math.PI * f) : 1;
        for (const dab of strokeTo(this.strokeState!, { x: q.x, y: q.y, pressure, time: t0 + i })) this.stampDab(dab);
      });
      this.endStroke();
      stroked = true;
    }
    if (stroked) this.history.amend('Stroke Path', this.doc);
    return stroked;
  }

  // ---- type ------------------------------------------------------------------------------

  /** The type tools' settings: the style new type starts in, and whether it makes a mask. */
  typeTool: { mask: boolean; vertical: boolean; style: CharStyle; para: ParaStyle; antiAlias: AntiAlias } | null = null;
  /** An open editing session on a type layer. */
  typeEdit: {
    layerId: number;
    caret: number;
    anchor: number;
    created: boolean;
    mask: boolean;
    before: Doc;
    /** The style the next typed text takes, when the panels changed it at a collapsed caret. */
    typing: CharStyle | null;
    undo: { text: TextSpec; caret: number; anchor: number }[];
    redo: { text: TextSpec; caret: number; anchor: number }[];
  } | null = null;
  private typeDrag: { mode: 'create' | 'select'; start: { x: number; y: number }; now: { x: number; y: number } } | null = null;

  /** Choose (or leave) a type tool; loads the type engine the first time. */
  async setTypeTool(opts: { mask: boolean; vertical: boolean; style: CharStyle; para: ParaStyle; antiAlias: AntiAlias } | null): Promise<void> {
    if (!opts) {
      this.typeCommit();
      this.typeTool = null;
      return;
    }
    this.typeTool = opts;
    await ensureText();
  }

  private typeLayer(): TypeLayer | null {
    const e = this.typeEdit;
    const l = e ? findLayer(this.doc.layers, e.layerId) : undefined;
    return l?.kind === 'type' ? l : null;
  }

  /** Replace the edited layer's text (no history: the session is one step). */
  private setTypeText(text: TextSpec, caret: number, anchor = caret, record = true): void {
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (!e || !l) return;
    if (record) {
      e.undo.push({ text: l.text, caret: e.caret, anchor: e.anchor });
      if (e.undo.length > 200) e.undo.shift();
      e.redo = [];
    }
    const next = retyped({ ...l, text }, this.doc);
    this.doc = { ...this.doc, layers: replaceLayer(this.doc.layers, l.id, next) };
    this.compositeCache = null;
    e.caret = caret;
    e.anchor = anchor;
  }

  /** The layer-space point of a document point, for the edited layer. */
  private toLayout(l: TypeLayer, p: { x: number; y: number }): { x: number; y: number } {
    const inv = invertMat(l.transform);
    const q = inv ? applyMat(inv, p) : p;
    // Type on a path: back from the page to the position along the line.
    const track = layoutOf(l.text)?.path;
    return track ? alongInverse(track, q) : q;
  }

  /** The page point of a point on a type layer's line (through its path, then its transform). */
  private fromLayout(l: TypeLayer, x: number, y: number): { x: number; y: number } {
    const track = layoutOf(l.text)?.path;
    return applyMat(l.transform, track ? alongPoint(track, x, y) : { x, y });
  }

  /** The topmost visible type layer under a document point. */
  private typeLayerAt(p: { x: number; y: number }): TypeLayer | null {
    const hits = [...walkLayers(this.doc.layers)].map((w) => w.layer).filter((l): l is TypeLayer => l.kind === 'type' && l.visible);
    for (let i = hits.length - 1; i >= 0; i--) {
      const l = hits[i]!;
      const box = l.text.kind === 'paragraph' && l.text.box ? this.toLayout(l, p) : null;
      if (box && box.x >= 0 && box.y >= 0 && box.x <= l.text.box!.width && box.y <= l.text.box!.height) return l;
      const b = typeBounds(l);
      const m = 4 / Math.max(1e-6, this.view.zoom);
      if (p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m) return l;
    }
    return null;
  }

  private beginTypeEdit(l: TypeLayer, caret: number, created: boolean, before: Doc): void {
    this.typeEdit = { layerId: l.id, caret, anchor: caret, created, mask: !!this.typeTool?.mask, before, typing: null, undo: [], redo: [] };
    if (!this.doc.activeLayerIds.includes(l.id) || this.doc.activeLayerIds.length !== 1) this.doc = { ...this.doc, activeLayerIds: [l.id] };
    // A layer whose fonts were missing is drawn with substitutes from here on.
    if (l.missingFonts?.length) {
      this.doc = { ...this.doc, layers: replaceLayer(this.doc.layers, l.id, retyped(l, this.doc)) };
      this.statusNote = `Missing fonts replaced by Noto Sans: ${l.missingFonts.join(', ')}`;
    }
  }
  /** A one-off message for the status bar (read and cleared by the summary). */
  statusNote: string | null = null;

  /** What the type tools draw over the canvas: caret, selection, box, a box being dragged. */
  private typeOverlay(): (Partial<PathOverlay> & { marquee?: PathOverlay['marquee'] }) | null {
    const drag = this.typeDrag;
    if (drag?.mode === 'create') {
      const { start: a, now: b } = drag;
      return { marquee: { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) } };
    }
    const e = this.typeEdit;
    const l = this.typeLayer();
    const layout = l && layoutOf(l.text);
    if (!e || !l || !layout) return null;
    const T = (x: number, y: number) => this.fromLayout(l, x, y);
    const c = caretAt(layout, e.caret);
    const caret: [{ x: number; y: number }, { x: number; y: number }] = layout.vertical ? [T(c.from, c.at), T(c.to, c.at)] : [T(c.at, c.from), T(c.at, c.to)];
    const bx = l.text.kind === 'paragraph' ? l.text.box : undefined;
    const box = bx ? [T(0, 0), T(bx.width, 0), T(bx.width, bx.height), T(0, bx.height)] : null;
    // Path and area type show the path they follow.
    const guide = l.text.kind === 'onPath' ? l.text.path : l.text.kind === 'inShape' ? l.text.shape : undefined;
    const outlines = guide ? overlayOutline(transformPath(guide, l.transform)) : [];
    // A selection on a path is drawn as a band along it: sample each rectangle's long edges.
    const along = (r: { x0: number; y0: number; x1: number; y1: number }) => {
      if (!layout.path) return [[T(r.x0, r.y0), T(r.x1, r.y0), T(r.x1, r.y1), T(r.x0, r.y1)]];
      const n = Math.max(1, Math.ceil((r.x1 - r.x0) / 4));
      const quads: { x: number; y: number }[][] = [];
      for (let i = 0; i < n; i++) {
        const a = r.x0 + ((r.x1 - r.x0) * i) / n;
        const b = r.x0 + ((r.x1 - r.x0) * (i + 1)) / n;
        quads.push([T(a, r.y0), T(b, r.y0), T(b, r.y1), T(a, r.y1)]);
      }
      return quads;
    };
    const bands = e.caret === e.anchor ? [] : selectionRects(layout, e.caret, e.anchor).flatMap(along);
    return { caret: e.caret === e.anchor ? caret : null, highlight: bands, box, outlines };
  }

  /** Type tool pointer events, in screen coordinates. */
  typePointer(e: { phase: 'down' | 'move' | 'up'; x: number; y: number; shift: boolean; clicks: number }): boolean {
    if (!this.typeTool || !textReady()) return false;
    const p = docPointAtScreen(this.view, e.x, e.y);
    const edit = this.typeEdit;
    if (e.phase === 'down') {
      const l = this.typeLayer();
      if (edit && l) {
        const hit = this.typeLayerAt(p);
        if (hit?.id === l.id) {
          const layout = layoutOf(l.text)!;
          const q = this.toLayout(l, p);
          const i = hitTest(layout, q.x, q.y);
          const text = layout.text;
          if (e.clicks === 2) [edit.anchor, edit.caret] = wordAt(text, i);
          else if (e.clicks === 3) [edit.anchor, edit.caret] = lineRangeAt(text, i);
          else if (e.clicks >= 4) [edit.anchor, edit.caret] = [0, text.length];
          else {
            edit.caret = i;
            if (!e.shift) edit.anchor = i;
          }
          edit.typing = null;
          this.typeDrag = e.clicks <= 1 ? { mode: 'select', start: p, now: p } : null;
          return true;
        }
        // A click away from the text commits it (and starts nothing, as in Photoshop).
        this.typeCommit();
        return true;
      }
      const hit = this.typeTool.mask ? null : this.typeLayerAt(p);
      if (hit) {
        const layout = layoutOf(hit.text);
        const q = this.toLayout(hit, p);
        this.beginTypeEdit(hit, layout ? hitTest(layout, q.x, q.y) : 0, false, this.doc);
        this.typeDrag = { mode: 'select', start: p, now: p };
        return true;
      }
      this.typeDrag = { mode: 'create', start: p, now: p };
      return true;
    }
    const drag = this.typeDrag;
    if (!drag) return false;
    drag.now = p;
    if (drag.mode === 'select' && edit) {
      const l = this.typeLayer();
      const layout = l && layoutOf(l.text);
      if (l && layout) {
        const q = this.toLayout(l, p);
        edit.caret = hitTest(layout, q.x, q.y);
      }
    }
    if (e.phase === 'move') return true;
    this.typeDrag = null;
    if (drag.mode === 'create') {
      const t = this.typeTool;
      const w = Math.abs(drag.now.x - drag.start.x);
      const h = Math.abs(drag.now.y - drag.start.y);
      const box = w * this.view.zoom > 4 && h * this.view.zoom > 4;
      const spec: TextSpec = {
        kind: box ? 'paragraph' : 'point',
        orientation: t.vertical ? 'vertical' : 'horizontal',
        ...(box ? { box: { width: w, height: h } } : {}),
        runs: [{ text: '', style: t.style }],
        paragraphs: [t.para],
      };
      const origin = box ? { x: Math.min(drag.start.x, drag.now.x), y: Math.min(drag.start.y, drag.now.y) } : drag.start;
      // A click on a path puts type on it; a click inside a closed path fills it with type.
      const guide = !box && !t.vertical ? this.editPath() : null;
      if (guide) {
        const track = trackOf(guide, 0);
        const on = alongInverse(track, drag.start);
        const near = Math.abs(on.y) * this.view.zoom < 6;
        const inside = !near && guide.subpaths.some((sp) => sp.closed) && rasterizePath(guide, { x0: Math.floor(drag.start.x), y0: Math.floor(drag.start.y), x1: Math.floor(drag.start.x) + 1, y1: Math.floor(drag.start.y) + 1 })[0]! > 0.5;
        if (near || inside) {
          const guided: TextSpec = near ? { ...spec, kind: 'onPath', path: guide, pathStart: on.x } : { ...spec, kind: 'inShape', shape: guide };
          const layer = makeTypeLayer(t.mask ? 'Type Mask' : 'Layer', guided, IDENTITY, t.antiAlias, this.doc);
          const before = this.doc;
          this.doc = { ...this.doc, layers: insertLayer(this.doc.layers, layer, this.doc.activeLayerIds[0]), activeLayerIds: [layer.id] };
          this.activePathId = null;
          this.beginTypeEdit(layer, 0, true, before);
          return true;
        }
      }
      const layer = makeTypeLayer(t.mask ? 'Type Mask' : 'Layer', spec, translateMat(origin.x, origin.y), t.antiAlias, this.doc);
      const before = this.doc;
      const above = this.doc.activeLayerIds[0];
      this.doc = { ...this.doc, layers: insertLayer(this.doc.layers, layer, above), activeLayerIds: [layer.id] };
      this.activePathId = null;
      this.beginTypeEdit(layer, 0, true, before);
    }
    return true;
  }

  /** Text typed (or pasted, or composed by an IME) into the session. */
  typeInput(str: string): boolean {
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (!e || !l) return false;
    const clean = str.replace(/\r\n?/g, '\n');
    const a = Math.min(e.caret, e.anchor);
    const b = Math.max(e.caret, e.anchor);
    const next = replaceText(l.text, a, b, clean, e.typing ?? undefined);
    e.typing = null;
    this.setTypeText(next, a + clean.length);
    return true;
  }

  /** The selected text of the session, for Copy and Cut. */
  typeSelection(): string {
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (!e || !l) return '';
    return textOf(l.text).slice(Math.min(e.caret, e.anchor), Math.max(e.caret, e.anchor)).replace(/\u2028/g, '\n');
  }

  typeKey(k: { key: string; shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (!e || !l) return false;
    const text = textOf(l.text);
    const a = Math.min(e.caret, e.anchor);
    const b = Math.max(e.caret, e.anchor);
    const move = (to: number) => {
      e.caret = Math.max(0, Math.min(text.length, to));
      if (!k.shift) e.anchor = e.caret;
      e.typing = null;
      return true;
    };
    const layout = layoutOf(l.text);
    const key = k.key;
    if (k.ctrl && !k.alt) {
      const lower = key.toLowerCase();
      if (lower === 'a') {
        e.anchor = 0;
        e.caret = text.length;
        return true;
      }
      if (lower === 'z') return k.shift ? this.typeRedo() : this.typeUndo();
      if (lower === 'y') return this.typeRedo();
      if (key === 'Enter') {
        this.typeCommit();
        return true;
      }
      // Photoshop's type shortcuts: Ctrl+Shift+ B/I/U/K/L/C/R/</>.
      if (k.shift) {
        const st = styleAt(l.text, a === b ? a : a + 1);
        const toggle = (p: Partial<CharStyle>) => this.setTypeStyle(p);
        if (lower === 'b') return toggle({ fauxBold: !st.fauxBold });
        if (lower === 'i') return toggle({ fauxItalic: !st.fauxItalic });
        if (lower === 'u') return toggle({ underline: !st.underline });
        if (lower === 'k') return toggle({ allCaps: !st.allCaps });
        if (lower === 'l') return this.setTypePara({ align: 'left' });
        if (lower === 'c') return this.setTypePara({ align: 'center' });
        if (lower === 'r') return this.setTypePara({ align: 'right' });
        if (key === '>' || key === '.') return toggle({ size: st.size + 2 });
        if (key === '<' || key === ',') return toggle({ size: Math.max(1, st.size - 2) });
      }
    }
    // Alt+Left/Right: tracking (a selection) or kerning (at the caret), 20/1000 em.
    if (k.alt && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const d = (key === 'ArrowRight' ? 20 : -20) * (k.ctrl ? 5 : 1);
      if (a === b) {
        if (a === 0) return false;
        const st = styleAt(l.text, a);
        const kern = (typeof st.kerning === 'number' ? st.kerning : 0) + d;
        this.setTypeText(restyleRange(l.text, stepCaret(text, a, -1, false), a, { kerning: kern }), e.caret, e.anchor);
        return true;
      }
      const st = styleAt(l.text, a + 1);
      this.setTypeText(restyleRange(l.text, a, b, { tracking: st.tracking + d }), e.caret, e.anchor);
      return true;
    }
    switch (key) {
      case 'Escape':
        this.typeCancel();
        return true;
      case 'Enter': {
        return this.typeInput(k.shift ? '\u2028' : '\n');
      }
      case 'Backspace':
      case 'Delete': {
        if (a !== b) {
          this.setTypeText(replaceText(l.text, a, b, ''), a);
          return true;
        }
        const back = key === 'Backspace';
        const to = stepCaret(text, a, back ? -1 : 1, k.ctrl);
        if (to === a) return false;
        const [s, t] = back ? [to, a] : [a, to];
        this.setTypeText(replaceText(l.text, s, t, ''), s);
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const vertical = l.text.orientation === 'vertical';
        if (vertical) return this.typeLineStep(key === 'ArrowLeft' ? 1 : -1, k.shift);
        if (!k.shift && a !== b) return move(key === 'ArrowLeft' ? a : b);
        // Visual direction: in a right-to-left line, Left moves forward in the text.
        const li = layout ? caretAt(layout, e.caret).line : 0;
        const rtl = layout?.lines[li]?.rtl ?? false;
        const forward = (key === 'ArrowRight') !== rtl;
        return move(stepCaret(text, e.caret, forward ? 1 : -1, k.ctrl));
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        if (l.text.orientation === 'vertical') return move(stepCaret(text, e.caret, key === 'ArrowDown' ? 1 : -1, k.ctrl));
        return this.typeLineStep(key === 'ArrowDown' ? 1 : -1, k.shift);
      }
      case 'Home':
      case 'End': {
        if (k.ctrl) return move(key === 'Home' ? 0 : text.length);
        const line = layout?.lines[layout ? caretAt(layout, e.caret).line : 0];
        if (!line) return false;
        let end = line.end;
        if (key === 'End' && end > line.start && (text[end - 1] === ' ' || text[end - 1] === '\u2028')) end--;
        return move(key === 'Home' ? line.start : end);
      }
    }
    return false;
  }

  /** Up/Down (Left/Right in vertical type): the nearest caret on the neighbouring line. */
  private typeLineStep(dir: 1 | -1, extend: boolean): boolean {
    const e = this.typeEdit;
    const l = this.typeLayer();
    const layout = l && layoutOf(l.text);
    if (!e || !l || !layout) return false;
    const c = caretAt(layout, e.caret);
    const target = layout.lines[c.line + dir];
    if (!target) {
      e.caret = dir < 0 ? 0 : layout.text.length;
    } else {
      const across = target.baseline;
      e.caret = layout.vertical ? hitTest(layout, across, c.at) : hitTest(layout, c.at, across);
    }
    if (!extend) e.anchor = e.caret;
    e.typing = null;
    return true;
  }

  private typeUndo(): boolean {
    const e = this.typeEdit;
    const l = this.typeLayer();
    const prev = e?.undo.pop();
    if (!e || !l || !prev) return false;
    e.redo.push({ text: l.text, caret: e.caret, anchor: e.anchor });
    this.setTypeText(prev.text, prev.caret, prev.anchor, false);
    return true;
  }

  private typeRedo(): boolean {
    const e = this.typeEdit;
    const l = this.typeLayer();
    const next = e?.redo.pop();
    if (!e || !l || !next) return false;
    e.undo.push({ text: l.text, caret: e.caret, anchor: e.anchor });
    this.setTypeText(next.text, next.caret, next.anchor, false);
    return true;
  }

  private committingType = false;

  /** Commit the session: one history step (or none, for new type left empty). */
  typeCommit(): boolean {
    this.committingType = true;
    try {
      return this.typeCommitInner();
    } finally {
      this.committingType = false;
    }
  }

  private typeCommitInner(): boolean {
    const e = this.typeEdit;
    if (!e) return false;
    const l = this.typeLayer();
    this.typeEdit = null;
    this.typeDrag = null;
    if (!l) return false;
    const text = textOf(l.text);
    if (!text.trim()) {
      // Empty type is not kept: new type vanishes; emptied type is deleted.
      if (e.created) {
        this.doc = e.before;
        this.compositeCache = null;
        return true;
      }
      this.commit({ ...this.doc, layers: LayerCmd.deleteLayer(this.doc, l.id).layers }, 'Delete Layer');
      return true;
    }
    if (e.mask) {
      const path = typePath(l);
      const sel = path ? this.pathSelection(path, 'new', 0, true) : null;
      this.commit({ ...e.before, selection: sel }, 'Type Mask');
      return true;
    }
    const named = e.created ? { ...l, name: LayerCmd.nameFor(this.doc, typeLayerName(text)) } : l;
    const doc = { ...this.doc, layers: replaceLayer(this.doc.layers, l.id, named) };
    if (!e.created && e.undo.length === 0) {
      this.doc = doc;
      return true;
    }
    this.commit(doc, e.created ? 'Type Tool' : 'Edit Type Layer');
    return true;
  }

  typeCancel(): boolean {
    const e = this.typeEdit;
    if (!e) return false;
    this.typeEdit = null;
    this.typeDrag = null;
    this.doc = e.before;
    this.compositeCache = null;
    return true;
  }

  /** The type layers a panel change applies to outside an editing session: the selected ones. */
  private selectedTypeLayers(): TypeLayer[] {
    const ids = new Set(this.doc.activeLayerIds);
    return [...walkLayers(this.doc.layers)].map((w) => w.layer).filter((l): l is TypeLayer => l.kind === 'type' && ids.has(l.id));
  }

  /**
   * Character panel / options bar: while editing, the selection (or the style typing
   * continues in); otherwise every selected type layer, whole. Also the tool's default.
   */
  setTypeStyle(patch: Partial<CharStyle>): boolean {
    // With no text to apply it to, a change sets what new type starts with.
    if (this.typeTool && !this.typeEdit && !this.selectedTypeLayers().length) this.typeTool = { ...this.typeTool, style: { ...this.typeTool.style, ...patch } };
    if (!textReady()) return false;
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (e && l) {
      const a = Math.min(e.caret, e.anchor);
      const b = Math.max(e.caret, e.anchor);
      if (!textOf(l.text).length) {
        this.setTypeText(restyleAll(l.text, patch), e.caret, e.anchor);
        return true;
      }
      if (a === b) {
        e.typing = { ...(e.typing ?? styleAt(l.text, a)), ...patch };
        return true;
      }
      this.setTypeText(restyleRange(l.text, a, b, patch), e.caret, e.anchor);
      return true;
    }
    const targets = this.selectedTypeLayers();
    if (!targets.length) return false;
    let layers = this.doc.layers;
    for (const t of targets) layers = replaceLayer(layers, t.id, retyped({ ...t, text: restyleAll(t.text, patch) }, this.doc));
    this.commit({ ...this.doc, layers }, 'Edit Type Layer');
    return true;
  }

  setTypePara(patch: Partial<ParaStyle>): boolean {
    if (this.typeTool && !this.typeEdit && !this.selectedTypeLayers().length) this.typeTool = { ...this.typeTool, para: { ...this.typeTool.para, ...patch } };
    if (!textReady()) return false;
    const e = this.typeEdit;
    const l = this.typeLayer();
    if (e && l) {
      this.setTypeText(restyleParagraphs(l.text, e.caret, e.anchor, patch), e.caret, e.anchor);
      return true;
    }
    const targets = this.selectedTypeLayers();
    if (!targets.length) return false;
    let layers = this.doc.layers;
    for (const t of targets) layers = replaceLayer(layers, t.id, retyped({ ...t, text: restyleParagraphs(t.text, 0, textOf(t.text).length, patch) }, this.doc));
    this.commit({ ...this.doc, layers }, 'Edit Type Layer');
    return true;
  }

  /** Type ▸ … and Layer ▸ Rasterize ▸ Type on the active type layer (or the edited one). */
  typeCommand(cmd: TypeCommand): boolean {
    if (!textReady()) return false;
    this.typeCommit();
    const id = this.doc.activeLayerIds[0];
    const l = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (l?.kind !== 'type') return false;
    const put = (next: Layer, name: string) => {
      this.commit({ ...this.doc, layers: replaceLayer(this.doc.layers, l.id, next) }, name);
      return true;
    };
    const layout = layoutOf(l.text);
    switch (cmd) {
      case 'rasterize': {
        const { text: _t, antiAlias: _a, transform: _m, missingFonts: _f, kind: _k, ...rest } = l;
        return put(makePixelLayer(l.name, l.plane.base, { ...rest, id: l.id }), 'Rasterize Type');
      }
      case 'toShape': {
        const path = typePath(l);
        if (!path) return false;
        const color = l.text.runs[0]?.style.color ?? [0, 0, 0];
        const { text: _t, antiAlias: _a, transform: _m, missingFonts: _f, kind: _k, plane: _p, ...rest } = l;
        return put(makeShapeLayer(l.name, path, { type: 'solid', color }, null, this.doc, { ...rest, id: l.id }), 'Convert to Shape');
      }
      case 'workPath': {
        const path = typePath(l);
        if (!path) return false;
        const pid = this.nextPathId++;
        this.activePathId = pid;
        this.vector.reset();
        this.commit({ ...this.doc, paths: [...(this.doc.paths ?? []).filter((p) => !p.work), { id: pid, name: 'Work Path', path, work: true }] }, 'Create Work Path');
        return true;
      }
      case 'horizontal':
      case 'vertical':
        if (l.text.orientation === cmd) return false;
        return put(retyped({ ...l, text: { ...l.text, orientation: cmd } }, this.doc), cmd === 'vertical' ? 'Vertical' : 'Horizontal');
      case 'toParagraph': {
        if (l.text.kind === 'paragraph' || !layout) return false;
        const b = layout.bounds;
        const text = { ...l.text, kind: 'paragraph' as const, box: { width: Math.ceil(b.x1 - b.x0) + 2, height: Math.ceil(b.y1 - b.y0) + 2 } };
        return put(retyped({ ...l, text, transform: compose(translateMat(b.x0, b.y0), l.transform) }, this.doc), 'Convert to Paragraph Text');
      }
      case 'toPoint': {
        if (l.text.kind !== 'paragraph' || !layout) return false;
        // Each wrapped line ends with a return, as Photoshop converts it.
        let spec = l.text;
        const t = layout.text;
        for (const line of [...layout.lines].reverse()) if (line.start > 0 && t[line.start - 1] !== '\n' && t[line.start - 1] !== '\u2028') spec = replaceText(spec, line.start, line.start, '\n');
        const align = spec.paragraphs[0]?.align ?? 'left';
        const w = l.text.box?.width ?? 0;
        const ox = align === 'center' || align === 'justifyCenter' ? w / 2 : align === 'right' || align === 'justifyRight' ? w : 0;
        const baseline = layout.lines[0]?.baseline ?? 0;
        const { box: _b, ...rest } = spec;
        return put(retyped({ ...l, text: { ...rest, kind: 'point' }, transform: compose(translateMat(ox, baseline), l.transform) }, this.doc), 'Convert to Point Text');
      }
      default: {
        const aa = cmd.startsWith('aa:') ? (cmd.slice(3) as AntiAlias) : null;
        if (!aa || aa === l.antiAlias) return false;
        return put(retyped({ ...l, antiAlias: aa }, this.doc), 'Anti Alias');
      }
    }
  }

  /** Type ▸ Warp Text: previews while the dialog is open (not final), one step on OK. */
  setTypeWarp(warp: WarpSpec | null, final: boolean): boolean {
    if (!textReady()) return false;
    this.typeCommit();
    const id = this.doc.activeLayerIds[0];
    const l = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (l?.kind !== 'type') return false;
    const { warp: _w, ...rest } = l.text;
    const text: TextSpec = warp ? { ...rest, warp } : rest;
    const doc = { ...this.doc, layers: replaceLayer(this.doc.layers, l.id, retyped({ ...l, text }, this.doc)) };
    if (final) this.commit(doc, 'Warp Text');
    else {
      this.doc = doc;
      this.compositeCache = null;
    }
    return true;
  }

  /**
   * The Glyphs panel: the characters a face maps, with each glyph's outline as SVG path data
   * in font units (y up), a page at a time.
   */
  glyphPage(font: string, from: number, count: number): { upem: number; total: number; glyphs: { cp: number; d: string; adv: number }[] } | null {
    const reg = fontRegistry();
    const face = reg?.byPostscript(font) ?? reg?.fallbacks[0];
    if (!face) return null;
    const cps = [...face.hb.face.collectUnicodes()].filter((cp) => cp > 0x20 && !(cp >= 0x7f && cp < 0xa0)).sort((a, b) => a - b);
    const glyphs = cps.slice(from, from + count).map((cp) => {
      const gid = face.hb.nominalGlyph(cp) ?? 0;
      return { cp, d: face.hb.glyphToPath(gid), adv: face.hb.glyphHAdvance(gid) };
    });
    return { upem: face.metrics.upem, total: cps.length, glyphs };
  }

  /** Type ▸ Resolve Missing Fonts: each missing font replaced by an installed one, everywhere. */
  replaceFonts(map: Record<string, string>): boolean {
    const reg = fontRegistry();
    if (!reg) return false;
    this.typeCommit();
    let layers = this.doc.layers;
    let changed = false;
    for (const { layer } of walkLayers(this.doc.layers)) {
      if (layer.kind !== 'type') continue;
      const uses = layer.text.runs.some((r) => map[r.style.font]);
      if (!uses && !layer.missingFonts?.some((f) => map[f])) continue;
      const runs = layer.text.runs.map((r) => {
        const to = map[r.style.font] ? reg.byPostscript(map[r.style.font]!) : undefined;
        return to ? { ...r, style: { ...r.style, font: to.postscriptName, family: to.family, fontStyle: to.style } } : r;
      });
      layers = replaceLayer(layers, layer.id, retyped({ ...layer, text: { ...layer.text, runs } }, this.doc));
      changed = true;
    }
    if (changed) this.commit({ ...this.doc, layers }, 'Replace Fonts');
    return changed;
  }

  /** Fonts for the menus: families with their styles and PostScript names. */
  fontList(): { family: string; styles: { style: string; postscript: string }[] }[] {
    const reg = fontRegistry();
    if (!reg) return [];
    const map = new Map<string, { style: string; postscript: string }[]>();
    for (const f of reg.faces) map.set(f.family, [...(map.get(f.family) ?? []), { style: f.style, postscript: f.postscriptName }]);
    return [...map].map(([family, styles]) => ({ family, styles })).sort((a, b) => a.family.localeCompare(b.family));
  }

  /** Add font files (the user's, or the system's through Local Font Access). */
  async addFonts(buffers: ArrayBuffer[]): Promise<number> {
    const reg = await ensureText();
    let n = 0;
    for (const b of buffers) {
      try {
        n += reg.add(new Uint8Array(b), 'user').length;
      } catch {
        // Not a font HarfBuzz can read; skip it.
      }
    }
    return n;
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
    const next = this.onTarget(target, (d) => FilterCmd.applyFilter(d, target.id, target.mask, run, this.filterMap(run)));
    return next === this.doc ? null : next;
  }

  /** The active layer when it is a smart object and its pixels, not its mask, are the target. */
  private activeSmart(): SmartObjectLayer | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    return layer && layer.kind === 'smart' && this.maskTarget !== layer.id && this.filterMaskTarget !== layer.id ? layer : null;
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
    // Fade reads the layer mask; a filter mask's step is not offered.
    this.fadeState = target.filter ? null : { before, after: next, name: run.def.label, layerId: target.id, mask: target.mask };
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
    const maskOf = target.mask && 'filter' in target && target.filter && layer.kind === 'smart' ? layer.filterMask : layer.mask;
    const plane = smart ? this.smartBase(smart, smartIndex) : target.mask ? maskOf?.plane.base : layer.kind === 'pixel' ? layer.plane.base : undefined;
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
      return this.onTarget(target, (d) => {
        const l = findLayer(d.layers, target.id);
        if (!l?.mask) return d;
        const raster = bitmapFromPlane(l.mask.plane.base, rect).data;
        applyImage(raster, src, o, coverage);
        const grey = new Uint8Array(raster.length / 4);
        for (let i = 0; i < grey.length; i++) grey[i] = Math.round(0.3 * raster[i * 4]! + 0.59 * raster[i * 4 + 1]! + 0.11 * raster[i * 4 + 2]!);
        return MaskPaint.setMaskFromGrey(d, target.id, grey);
      });
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
    this.cursorScreen = cursor;
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

  /**
   * Properties for a shape layer: its live-shape parameters, fill and stroke. Non-final
   * edits (a scrub) show without history; the final one commits.
   */
  setShape(id: number, patch: { live?: LiveShape; fill?: FillSummary | null; stroke?: ShapeStrokeSummary | null }, final: boolean): boolean {
    const layer = findLayer(this.doc.layers, id);
    if (layer?.kind !== 'shape') return false;
    let next: ShapeLayer = layer;
    let name = 'Edit Shape';
    if (patch.live) next = withLive(next, patch.live, this.doc);
    if (patch.fill !== undefined) {
      const fillContent = patch.fill ? this.fillFromSummary(patch.fill) : null;
      if (patch.fill && !fillContent) return false;
      next = { ...next, fillContent: fillContent ?? null };
      name = 'Change Shape Fill';
    }
    if (patch.stroke !== undefined) {
      const content = patch.stroke ? this.fillFromSummary(patch.stroke.content) : null;
      if (patch.stroke && !content) return false;
      next = { ...next, stroke: patch.stroke && content ? { ...patch.stroke, content, blendMode: patch.stroke.blendMode as BlendMode } : null };
      name = 'Change Shape Stroke';
    }
    if (patch.fill !== undefined || patch.stroke !== undefined) next = reshaped(next, this.doc);
    const doc = { ...this.doc, layers: replaceLayer(this.doc.layers, id, next) };
    if (final) this.commit(doc, name);
    else this.doc = doc;
    return true;
  }

  // ---- the Styles panel's library -------------------------------------------------------

  private styleLibrary: StylePreset[] = builtinStyles();
  private styleSeq = 1;

  /** The library for the UI: patterns by id only. */
  styleSummaries(): StylePreset[] {
    return this.styleLibrary.map((s) => ({ ...s, effects: Engine.effectsToSummary(s.effects) }));
  }

  /** Click a style: it replaces the style of every selected layer, as in Photoshop. */
  applyStyle(id: string): boolean {
    const style = this.styleLibrary.find((s) => s.id === id);
    if (!style) return false;
    let layers = this.doc.layers;
    for (const lid of this.doc.activeLayerIds) {
      layers = updateLayer(layers, lid, (l) => (l.kind === 'adjustment' ? l : { ...l, effects: style.effects }));
    }
    if (layers === this.doc.layers) return false;
    this.previewDoc = null;
    this.commit({ ...this.doc, layers }, 'Apply Style');
    return true;
  }

  /** New Style…: from the given effects (the Layer Style dialog's) or the active layer's. */
  newStyle(name: string, effects?: LayerEffects | null): boolean {
    const id = this.doc.activeLayerIds[0];
    const fx = effects ?? (id === undefined ? undefined : findLayer(this.doc.layers, id)?.effects);
    if (!fx) return false;
    this.styleLibrary.push({ id: `user-${Date.now().toString(36)}-${this.styleSeq++}`, name: name || `Style ${this.styleLibrary.length + 1}`, effects: this.resolveEffects(fx) });
    return true;
  }

  deleteStyle(id: string): boolean {
    const n = this.styleLibrary.length;
    this.styleLibrary = this.styleLibrary.filter((s) => s.id !== id);
    return this.styleLibrary.length !== n;
  }

  renameStyle(id: string, name: string): boolean {
    const s = this.styleLibrary.find((x) => x.id === id);
    if (!s || !name) return false;
    s.name = name;
    return true;
  }

  /** Load Styles…: an .asl's styles join the library, its patterns the pattern library. */
  loadAsl(bytes: Uint8Array): { added: number; lost: { style: string; features: string[] }[] } {
    const lib = readAsl(bytes);
    for (const p of lib.patterns) if (!this.patternLibrary.some((q) => q.id === p.id)) this.patternLibrary.push(p);
    for (const s of lib.styles) {
      const i = this.styleLibrary.findIndex((x) => x.id === s.id);
      if (i >= 0) this.styleLibrary[i] = s;
      else this.styleLibrary.push(s);
    }
    return { added: lib.styles.length, lost: lib.lost };
  }

  /** Save Styles…: the whole library (or the given styles) as an .asl. */
  exportAsl(ids?: readonly string[]): Uint8Array {
    const chosen = ids?.length ? this.styleLibrary.filter((s) => ids.includes(s.id)) : this.styleLibrary;
    return writeAsl(chosen.map((s) => ({ ...s, effects: this.resolveEffects(s.effects) })));
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

  // ---- the brush library (Brushes panel, .abr) -------------------------------------------

  /** Brush preset groups, as the Brushes panel shows them: the built-ins, then imports. */
  brushGroups: BrushGroup[] = builtinBrushes();
  private tipThumbs = new Map<string, TipBitmap>();

  /** A tip bitmap by id: the library's sampled tips, else a generated physical tip. */
  private tipOf(id: string): TipBitmap | undefined {
    return this.brushTips.get(id) ?? physicalTip(id);
  }

  /** How worn each erodible tip is (by its settings), carried from stroke to stroke. */
  private tipWear = new Map<string, number>();

  /** Brush Settings ▸ Sharpen Tip: every erodible tip back to its point. */
  sharpenTip(): void {
    this.tipWear.clear();
  }

  /** Tips shrunk to fit 48 px, for the panel's previews (sent once, cached). */
  private tipThumb(id: string): TipBitmap | null {
    const hit = this.tipThumbs.get(id);
    if (hit) return hit;
    const t = this.brushTips.get(id);
    if (!t) return null;
    const k = Math.min(1, 48 / Math.max(t.width, t.height));
    const w = Math.max(1, Math.round(t.width * k));
    const h = Math.max(1, Math.round(t.height * k));
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Area average over the source cells.
        const x0 = Math.floor((x * t.width) / w);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * t.width) / w));
        const y0 = Math.floor((y * t.height) / h);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * t.height) / h));
        let sum = 0;
        for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) sum += t.data[j * t.width + i]!;
        data[y * w + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
      }
    }
    const thumb = { width: w, height: h, data };
    this.tipThumbs.set(id, thumb);
    return thumb;
  }

  /** The library for the panel: groups, and a small bitmap of every sampled tip they use. */
  brushLibrary(): { groups: BrushGroup[]; tips: Record<string, TipBitmap> } {
    const tips: Record<string, TipBitmap> = {};
    for (const g of this.brushGroups) {
      for (const p of g.presets) {
        for (const tip of [p.params.tip, p.params.dual?.tip]) {
          if (tip?.kind === 'sampled' && !tips[tip.id]) {
            const t = this.tipThumb(tip.id);
            if (t) tips[tip.id] = t;
          }
        }
      }
    }
    return { groups: this.brushGroups, tips };
  }

  /** Load Brushes…: an .abr file becomes a group named after it. Returns what could not be read. */
  importAbr(bytes: Uint8Array, fileName: string): { added: number; lost: string[] } {
    const name = fileName.replace(/\.abr$/i, '');
    const abr = readAbrFile(bytes, name);
    for (const [id, t] of abr.tips) this.brushTips.set(id, t);
    for (const p of abr.patterns) if (!this.patternLibrary.some((q) => q.id === p.id)) this.patternLibrary.push(p);
    let group = name;
    for (let n = 2; this.brushGroups.some((g) => g.name === group); n++) group = `${name} ${n}`;
    this.brushGroups = [...this.brushGroups, { name: group, presets: abr.presets }];
    return { added: abr.presets.length, lost: abr.lost };
  }

  /**
   * Load Tool Presets… (.tpl): the presets, mapped to Umbra's tools and options. Their brushes'
   * sampled tips join the tip library and their patterns the pattern library, so the presets
   * can refer to them by id.
   */
  importTpl(bytes: Uint8Array, fileName: string): ToolPresetImport[] {
    const t = readTplFile(bytes, fileName);
    for (const [id, tip] of t.tips) this.brushTips.set(id, tip);
    for (const p of t.patterns) if (!this.patternLibrary.some((q) => q.id === p.id)) this.patternLibrary.push(p);
    return t.presets;
  }

  /** Export Selected Brushes…: presets (by id, or a whole group) with their tips and textures. */
  exportAbr(opts: { group?: string; ids?: readonly string[] }): Uint8Array {
    const all = this.brushGroups.flatMap((g) => g.presets.map((p) => ({ p, g: g.name })));
    const chosen = all.filter(({ p, g }) => (opts.ids?.length ? opts.ids.includes(p.id) : opts.group ? g === opts.group : true)).map(({ p }) => p);
    return writeAbrFile(chosen, this.brushTips, this.patternLibrary);
  }

  /** New Brush Preset, rename, delete, new group: the panel's edits. */
  editBrushLibrary(op: BrushLibraryOp): boolean {
    const groups = this.brushGroups;
    switch (op.op) {
      case 'newPreset': {
        const group = op.group ?? groups[groups.length - 1]?.name ?? 'Brushes';
        const preset: BrushPreset = { id: `user:${Date.now().toString(36)}:${Math.floor(Math.random() * 1e6).toString(36)}`, name: op.name, params: op.params };
        const has = groups.some((g) => g.name === group);
        this.brushGroups = has ? groups.map((g) => (g.name === group ? { ...g, presets: [...g.presets, preset] } : g)) : [...groups, { name: group, presets: [preset] }];
        return true;
      }
      case 'rename':
        this.brushGroups = groups.map((g) => ({ ...g, presets: g.presets.map((p) => (p.id === op.id ? { ...p, name: op.name } : p)) }));
        return true;
      case 'delete':
        this.brushGroups = groups.map((g) => ({ ...g, presets: g.presets.filter((p) => p.id !== op.id) }));
        return true;
      case 'newGroup': {
        let name = op.name;
        for (let n = 2; groups.some((g) => g.name === name); n++) name = `${op.name} ${n}`;
        this.brushGroups = [...groups, { name, presets: [] }];
        return true;
      }
      case 'deleteGroup':
        this.brushGroups = groups.filter((g) => g.name !== op.name);
        return true;
      case 'renameGroup':
        this.brushGroups = groups.map((g) => (g.name === op.name ? { ...g, name: op.to } : g));
        return true;
    }
  }

  /**
   * Edit ▸ Define Brush Preset: the selection's area of the image (or the whole image) as a
   * sampled tip — darker is more paint, white is none — cropped to its ink.
   */
  defineBrush(name: string): BrushPreset | null {
    const bounds = selectionBoundsOf(this.doc.selection) ?? { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
    const { pixels, width } = this.renderer.renderToBuffer(this.doc, this.caps.maxTextureSize);
    const w0 = Math.min(5000, bounds.x1 - bounds.x0);
    const h0 = Math.min(5000, bounds.y1 - bounds.y0);
    if (w0 < 1 || h0 < 1) return null;
    const sel = this.doc.selection;
    const ink = new Uint8Array(w0 * h0);
    let x0 = w0;
    let y0 = h0;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h0; y++) {
      for (let x = 0; x < w0; x++) {
        const dx = bounds.x0 + x;
        const dy = bounds.y0 + y;
        const o = (dy * width + dx) * 4;
        const a = pixels[o + 3]! / 255;
        // Over white, then luminance; the selection's coverage fades it too.
        const lum = (0.299 * pixels[o]! + 0.587 * pixels[o + 1]! + 0.114 * pixels[o + 2]!) * a + 255 * (1 - a);
        const cover = sel ? sel.mask[dy * sel.width + dx]! / 255 : 1;
        const v = Math.round((255 - lum) * cover);
        ink[y * w0 + x] = v;
        if (v > 0) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) data.set(ink.subarray((y + y0) * w0 + x0, (y + y0) * w0 + x0 + w), y * w);
    const id = `defined:${Date.now().toString(36)}:${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.brushTips.set(id, { width: w, height: h, data });
    const preset: BrushPreset = { id, name: name || `Sampled Brush ${w}`, params: { size: Math.max(w, h), spacing: 0.25, hardness: 1, tip: { kind: 'sampled', id } } };
    this.editBrushLibrary({ op: 'newPreset', name: preset.name, params: preset.params });
    const last = this.brushGroups[this.brushGroups.length - 1]!;
    return last.presets[last.presets.length - 1] ?? preset;
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

  /**
   * Magic Eraser: the Magic Wand's region under the click, erased — on the active layer, from
   * the layer's own pixels or (Sample All Layers) the composite; through the selection.
   */
  magicErase(x: number, y: number, opts: { tolerance: number; contiguous: boolean; antiAlias: boolean; sampleAll: boolean; opacity: number }): boolean {
    const layer = this.activePixelLayer();
    if (!layer) return false;
    const p = docPointAtScreen(this.view, x, y);
    const doc = opts.sampleAll ? this.doc : { ...this.doc, layers: [{ ...layer, visible: true, opacity: 1, blendMode: 'normal' as const, effects: undefined, mask: undefined, clipped: false }] };
    const { pixels, width, height } = this.renderer.renderToBuffer(doc, this.caps.maxTextureSize);
    const mask = magicWand(pixels, { width, height }, Math.floor(p.x), Math.floor(p.y), { tolerance: Math.round(opts.tolerance * 255), contiguous: opts.contiguous, antialias: opts.antiAlias });
    const sel = this.doc.selection;
    const w = layer.plane.base.writer();
    let any = false;
    for (let py = 0; py < this.doc.height; py++) {
      for (let px = 0; px < this.doc.width; px++) {
        const i = py * this.doc.width + px;
        let m = (mask[i] ?? 0) / 255;
        if (sel) m *= sel.mask[i]! / 255;
        if (m <= 0) continue;
        const d = w.mutable(px >> TILE_SHIFT, py >> TILE_SHIFT);
        const o = ((py & (TILE_SIZE - 1)) * TILE_SIZE + (px & (TILE_SIZE - 1))) * 4 + 3;
        if (!d[o]) continue;
        d[o] = Math.round(d[o]! * (1 - m * opts.opacity));
        any = true;
      }
    }
    if (!any) return false;
    this.commit({ ...this.doc, layers: updateLayer(this.doc.layers, layer.id, (l) => ({ ...l, plane: new MipPlane(w.commit()) }) as typeof l) }, 'Magic Eraser');
    return true;
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
      const next = this.onTarget(target, (d) => MaskPaint.gradientMask(d, target.id, {
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
      }));
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
      const next = this.onTarget(target, (d) => MaskPaint.fillMask(d, target.id, opts.clear ? [1, 1, 1] : opts.color, opts.opacity));
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

  /** A pattern's luminance, for brush textures (cached per pattern). */
  private brushPattern(id: string): { id: string; pattern: BrushPattern } | null {
    const def = this.findPattern(id) ?? this.patternLibrary[0] ?? null;
    if (!def) return null;
    let lum = this.patternLum.get(def.id);
    if (!lum) {
      const v = new Float32Array(def.width * def.height);
      for (let i = 0; i < v.length; i++) {
        const a = def.data[i * 4 + 3]! / 255;
        // Transparent pattern pixels read as white: they leave the tip untouched.
        const l = (0.299 * def.data[i * 4]! + 0.587 * def.data[i * 4 + 1]! + 0.114 * def.data[i * 4 + 2]!) / 255;
        v[i] = l * a + (1 - a);
      }
      lum = { width: def.width, height: def.height, lum: v };
      this.patternLum.set(def.id, lum);
    }
    return { id: def.id, pattern: lum };
  }

  beginStroke(params: BrushParams, color: [number, number, number], mode: PaintMode, bg: [number, number, number] = [1, 1, 1], retouch?: { tool: RetouchToolId; options: RetouchOptions }): void {
    this.retouch = null;
    this.retouchLayer = null;
    this.retouchTool = null;
    // Each stroke gets its own seed unless one is given, so jitter differs stroke to stroke
    // but a stroke can be replayed exactly.
    const seed = params.seed ?? 1 + Math.floor(Math.random() * 0x7ffffffe);
    // Tools that carry or blend the pixels they pass over step closely, or each dab's rim shows.
    const close = retouch && ['smudgeTool', 'blurTool', 'sharpenTool', 'mixerBrush'].includes(retouch.tool);
    // Path symmetry mirrors across the Paths panel's selected path (or the layer's own).
    if (params.symmetry?.mode === 'path' && !params.symmetry.path?.length) {
      const path = this.editPath();
      if (path?.subpaths.length) params = { ...params, symmetry: { ...params.symmetry, path: path.subpaths.map((sp) => ({ points: flattenSubpath(sp, 0.25), closed: sp.closed })) } };
      else {
        this.statusNote = 'Path symmetry: select a path in the Paths panel to mirror across.';
        params = { ...params, symmetry: undefined };
      }
    }
    this.brush = { ...params, seed, ...(close ? { spacing: Math.min(params.spacing, 0.1) } : {}) };
    params = this.brush;
    this.paintMode = mode;
    this.strokeColor = color;
    this.strokeParams = { size: params.size, hardness: params.hardness, color: [...color, 1] };
    this.strokeState = beginBrushStroke(params, { fg: color, bg, zoom: this.view.zoom, wear: params.tip?.kind === 'erodible' ? (this.tipWear.get(JSON.stringify(params.tip)) ?? 0) : 0 });
    this.lastDab = null;
    // What the dab shader (and the CPU reference) need beyond each dab.
    const style: DabStyle = { noise: !!params.noise, noiseSeed: seed & 0xffff };
    const ctx: CoverageContext = { tips: (id) => this.tipOf(id), noise: !!params.noise, noiseSeed: seed & 0xffff };
    const d = params.dual?.enabled ? params.dual : null;
    if (d) {
      const tip = d.tip.kind === 'sampled' ? d.tip.id : isPhysical(d.tip) ? physicalTipId(d.tip, 0) : undefined;
      style.dual = { tip, hardness: d.hardness, mode: DUAL_MODES.indexOf(d.mode) };
      ctx.dual = { tip: tip ? this.tipOf(tip) : undefined, hardness: d.hardness, mode: d.mode };
    }
    const t = params.texture?.enabled ? params.texture : null;
    const pat = t ? this.brushPattern(t.patternId) : null;
    if (t && pat) {
      this.dabs.textures.setPattern(pat.id, pat.pattern.width, pat.pattern.height, pat.pattern.lum);
      style.texture = { scale: t.scale / 100, brightness: t.brightness, contrast: t.contrast, invert: t.invert, mode: TEXTURE_MODES.indexOf(t.mode) };
      ctx.texture = { pattern: pat.pattern, scale: t.scale, brightness: t.brightness, contrast: t.contrast, invert: t.invert, mode: t.mode };
    }
    this.dabStyle = style;
    this.coverageCtx = ctx;

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
      this.strokeIntoFilterMask = !!paint.filter;
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
    if (retouch) this.beginRetouch(retouch.tool, retouch.options, target, color, bg, seed);
  }

  /** Set up a retouching stroke on the pixel layer being painted. */
  private beginRetouch(tool: RetouchToolId, options: RetouchOptions, target: PixelLayer, fg: [number, number, number], bg: [number, number, number], seed: number): void {
    const orig = target.plane.base;
    if (tool === 'spotHealing' || tool === 'removeTool') {
      // The stroke marks the area (drawn as a dim overlay); the fill happens when it ends.
      this.retouchTool = tool;
      this.regionOptions = options;
      this.strokeColor = [0.1, 0.1, 0.1];
      this.brush = { ...this.brush, opacity: 0.5 };
      return;
    }
    const W = this.doc.width;
    const H = this.doc.height;
    const clampRead = (plane: Plane) => (x: number, y: number, out: Rgba) => readPixel(plane, Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)), out);
    // A composite of the document (or of the target and what is under it) as a sampler.
    const compositeSampler = (belowOnly: boolean) => {
      let doc = this.doc;
      if (belowOnly) {
        const i = doc.layers.findIndex((l) => l.id === target.id);
        if (i >= 0) doc = { ...doc, layers: doc.layers.slice(0, i + 1) };
      }
      const { pixels, width } = this.renderer.renderToBuffer(doc, this.caps.maxTextureSize);
      return (x: number, y: number, out: Rgba) => {
        const o = (Math.min(H - 1, Math.max(0, y)) * width + Math.min(W - 1, Math.max(0, x))) * 4;
        out[0] = pixels[o]! / 255;
        out[1] = pixels[o + 1]! / 255;
        out[2] = pixels[o + 2]! / 255;
        out[3] = pixels[o + 3]! / 255;
        return out;
      };
    };
    let source: ((x: number, y: number, out: Rgba) => Rgba) | undefined;
    let map: ((x: number, y: number) => { x: number; y: number }) | undefined;
    if (tool === 'cloneStamp' || tool === 'healingBrush') {
      const src = this.cloneSource;
      if (!src && !(tool === 'healingBrush' && options.healSource === 'pattern')) {
        this.statusNote = 'Alt-click to define a source point to clone from.';
        this.strokeWriter = null;
        this.painting = false;
        return;
      }
      source = options.sample === 'current' ? clampRead(orig) : compositeSampler(options.sample === 'currentBelow');
      if (src) {
        // Aligned: the first stroke fixes the offset from source to paint; unaligned, every
        // stroke starts over at the source point.
        this.pendingCloneAnchor = true;
        const t = options.clone;
        map = (x, y) => {
          const off = this.cloneOffset ?? { dx: 0, dy: 0 };
          // Clone Source transform: about the source point, scale, rotate, flip.
          const px = x - (src.x + off.dx);
          const py = y - (src.y + off.dy);
          const a = (-(t?.angle ?? 0) * Math.PI) / 180;
          let qx = px * Math.cos(a) - py * Math.sin(a);
          let qy = px * Math.sin(a) + py * Math.cos(a);
          qx /= (t?.scaleX ?? 100) / 100;
          qy /= (t?.scaleY ?? 100) / 100;
          if (t?.flipX) qx = -qx;
          if (t?.flipY) qy = -qy;
          return { x: src.x + qx, y: src.y + qy };
        };
      }
    } else if (tool === 'historyBrush' || tool === 'artHistoryBrush') {
      const states = this.history.list();
      const state = states[Math.min(states.length - 1, Math.max(0, this.historyBrushSource))];
      const layer = state ? findLayer(state.doc.layers, target.id) : undefined;
      if (layer?.kind === 'pixel') source = clampRead(layer.plane.base);
      else if (state) {
        // The layer did not exist in that state: its composite, as Photoshop falls back to.
        const doc = this.doc;
        this.doc = state.doc;
        source = compositeSampler(false);
        this.doc = doc;
      }
    } else if (options.sampleAll && (tool === 'blurTool' || tool === 'sharpenTool' || tool === 'smudgeTool' || tool === 'mixerBrush')) {
      source = compositeSampler(false);
    }
    const pat = tool === 'patternStamp' || (tool === 'healingBrush' && options.healSource === 'pattern') ? (this.findPattern(options.patternId ?? '') ?? this.patternLibrary[0] ?? null) : null;
    const direct = ['dodgeTool', 'burnTool', 'spongeTool', 'blurTool', 'sharpenTool', 'smudgeTool', 'mixerBrush'].includes(tool);
    this.healWriter = tool === 'healingBrush' ? Plane.empty(RGBA8).writer() : null;
    this.healPending = [];
    this.retouchLayer = direct ? orig.writer() : null;
    this.retouchTool = tool;
    this.retouch = new RetouchStroke({
      tool,
      options,
      width: W,
      height: H,
      orig,
      stroke: this.strokeWriter ?? undefined,
      layer: this.retouchLayer ?? undefined,
      source,
      map,
      pattern: pat ? { width: pat.width, height: pat.height, data: pat.data } : undefined,
      fg,
      bg,
      flow: this.brush.flow,
      seed,
    });
    // Stroke-buffer tools composite like a brush stroke: normal, or clear for the Background Eraser.
    if (!direct) this.paintMode = this.retouch.mode === 'clear' ? 'clear' : this.paintMode === 'clear' ? 'normal' : this.paintMode;
  }

  /** Spot Healing / Remove: the options their region fill uses when the stroke ends. */
  private regionOptions: RetouchOptions | null = null;

  /** The document before a direct retouch stroke swapped its working plane in. */
  private docBeforeRetouch: Doc | null = null;

  private finishRetouch(): void {
    this.retouch = null;
    this.healWriter = null;
    this.healPending = [];
    this.retouchLayer = null;
    this.retouchTool = null;
    this.retouchDirty = false;
    this.docBeforeRetouch = null;
    this.strokeWriter = null;
    this.strokeState = null;
    this.strokeLayerId = null;
    this.painting = false;
    this.lastDab = null;
  }

  // ---- Clone Source overlay ----------------------------------------------------------------

  private cloneOverlayOpts: CloneOverlay | null = null;
  /** The pointer over the canvas (screen px), from the Info probe; null when it is outside. */
  private cursorScreen: { x: number; y: number } | null = null;
  private overlayBase: PixelLayer | null = null;
  private overlayClip: { key: string; plane: MipPlane } | null = null;
  private overlayComposite: { doc: Doc; below: boolean; plane: MipPlane } | null = null;
  private overlayInverted: { from: MipPlane; plane: MipPlane } | null = null;

  /** Set by the UI while the Clone Stamp or Healing Brush is the tool (null otherwise). */
  setCloneOverlay(o: CloneOverlay | null): void {
    this.cloneOverlayOpts = o;
  }

  /** Where a source pixel shows on the canvas: about the source, flip, scale, rotate, then offset. */
  private cloneMatrix(o: CloneOverlay, off: { dx: number; dy: number }): Mat {
    const src = this.cloneSource!;
    const t = o.transform;
    return composeAll(
      translateMat(-src.x, -src.y),
      scaleMat(t.flipX ? -1 : 1, t.flipY ? -1 : 1),
      scaleMat(t.scaleX / 100, t.scaleY / 100),
      rotateMat((t.angle * Math.PI) / 180),
      translateMat(src.x + off.dx, src.y + off.dy),
    );
  }

  /** The source the overlay shows: the layer being cloned into, or a composite. */
  private overlaySource(o: CloneOverlay): MipPlane | null {
    const target = this.activePixelLayer();
    if (o.sample === 'current') return target?.plane ?? null;
    const below = o.sample === 'currentBelow';
    const c = this.overlayComposite;
    if (c && c.doc === this.doc && c.below === below) return c.plane;
    let doc = this.doc;
    if (below && target) {
      const i = doc.layers.findIndex((l) => l.id === target.id);
      if (i >= 0) doc = { ...doc, layers: doc.layers.slice(0, i + 1) };
    }
    const { pixels, width, height } = this.renderer.renderToBuffer(doc, this.caps.maxTextureSize);
    const plane = new MipPlane(planeFromBitmap({ data: pixels, width, height, left: 0, top: 0 }));
    this.overlayComposite = { doc: this.doc, below, plane };
    return plane;
  }

  /**
   * The overlay as a layer to draw on top, and the matrix it draws through (none when it is
   * already in canvas space). Clipped, it is the source sampled under the brush on the CPU;
   * otherwise the whole source, drawn through the clone mapping on the GPU.
   */
  private cloneOverlayLayer(): { layer: PixelLayer; matrix: Mat | null } | null {
    const o = this.cloneOverlayOpts;
    const src = this.cloneSource;
    if (!o?.show || !src || (o.autoHide && this.painting) || this.previewDoc) return null;
    const cur = this.cursorScreen ? docPointAtScreen(this.view, this.cursorScreen.x, this.cursorScreen.y) : null;
    // Before an aligned offset exists (or for each unaligned stroke), the source point sits
    // under the pointer.
    const off = (o.aligned || this.painting) && this.cloneOffset ? this.cloneOffset : cur ? { dx: cur.x - src.x, dy: cur.y - src.y } : null;
    const source = this.overlaySource(o);
    if (!off || !source) return null;
    this.overlayBase ??= makePixelLayer('Clone Source Overlay', Plane.empty(RGBA8), { id: OVERLAY_ID });
    const base = { ...this.overlayBase, opacity: o.opacity, blendMode: o.mode };
    const m = this.cloneMatrix(o, off);
    // A brush bigger than this is shown unclipped: sampling it on the CPU per move is too slow.
    if (o.clipped && o.radius <= 400) {
      if (!cur) return null;
      const inv = invertMat(m);
      if (!inv) return null;
      const r = Math.max(1, o.radius);
      const key = `${Math.round(cur.x * 4)},${Math.round(cur.y * 4)},${off.dx},${off.dy},${r},${JSON.stringify(o.transform)},${o.invert}`;
      if (this.overlayClip?.key !== key || this.overlayClipFrom !== source) {
        const w = Plane.empty(RGBA8).writer();
        const W = this.doc.width;
        const H = this.doc.height;
        const px = new Float32Array(4);
        for (let y = Math.max(0, Math.floor(cur.y - r - 1)); y < Math.min(H, Math.ceil(cur.y + r + 1)); y++) {
          for (let x = Math.max(0, Math.floor(cur.x - r - 1)); x < Math.min(W, Math.ceil(cur.x + r + 1)); x++) {
            const cov = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cur.x, y + 0.5 - cur.y)));
            if (cov <= 0) continue;
            const sp = applyMat(inv, { x: x + 0.5, y: y + 0.5 });
            readPixel(source.base, Math.min(W - 1, Math.max(0, Math.floor(sp.x))), Math.min(H - 1, Math.max(0, Math.floor(sp.y))), px);
            const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
            const q = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
            for (let c = 0; c < 3; c++) d[q + c] = Math.round((o.invert ? 1 - px[c]! : px[c]!) * 255);
            d[q + 3] = Math.round(px[3]! * cov * 255);
          }
        }
        this.overlayClip = { key, plane: new MipPlane(w.commit(), 0) };
        this.overlayClipFrom = source;
      }
      return { layer: { ...base, plane: this.overlayClip.plane }, matrix: null };
    }
    let plane = source;
    if (o.invert) {
      if (this.overlayInverted?.from !== source) {
        const w = source.base.writer();
        const all = { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height };
        const { rgb, alpha } = HealCmd.readRect(source.base, all);
        for (let i = 0; i < alpha.length; i++) {
          if (alpha[i]! <= 0) continue;
          const x = i % this.doc.width;
          const y = (i - x) / this.doc.width;
          const d = w.mutable(x >> TILE_SHIFT, y >> TILE_SHIFT);
          const q = ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;
          for (let c = 0; c < 3; c++) d[q + c] = Math.round((1 - rgb[i * 3 + c]!) * 255);
        }
        this.overlayInverted = { from: source, plane: new MipPlane(w.commit()) };
      }
      plane = this.overlayInverted.plane;
    }
    return { layer: { ...base, plane }, matrix: m };
  }

  private overlayClipFrom: MipPlane | null = null;

  // ---- Patch, Content-Aware Move, Content-Aware Fill, Red Eye ------------------------------

  private patchDrag: { start: { x: number; y: number }; now: { x: number; y: number } } | null = null;
  private patchLasso = false;

  /**
   * The Patch and Content-Aware Move tools: outside the selection a drag draws one (a lasso);
   * inside it, the drag moves it, and on release the patch or move is made.
   */
  patchPointer(e: { phase: 'down' | 'move' | 'up'; x: number; y: number }, opts: PatchOptions): boolean {
    const p = docPointAtScreen(this.view, e.x, e.y);
    if (e.phase === 'down') {
      const sel = this.doc.selection;
      const inside = sel && p.x >= 0 && p.y >= 0 && p.x < sel.width && p.y < sel.height && sel.mask[Math.floor(p.y) * sel.width + Math.floor(p.x)]! > 127;
      if (inside) this.patchDrag = { start: p, now: p };
      else {
        this.patchLasso = true;
        this.beginSelect('lasso', e.x, e.y, 'new');
      }
      return true;
    }
    if (this.patchLasso) {
      if (e.phase === 'move') this.updateSelect(e.x, e.y);
      else {
        this.patchLasso = false;
        this.endSelect(e.x, e.y);
      }
      return true;
    }
    const drag = this.patchDrag;
    if (!drag) return false;
    drag.now = p;
    if (e.phase === 'move') return true;
    this.patchDrag = null;
    const d = { x: Math.round(drag.now.x - drag.start.x), y: Math.round(drag.now.y - drag.start.y) };
    if (d.x === 0 && d.y === 0) return true;
    return opts.tool === 'patch' ? this.applyPatch(d, opts) : this.applyContentAwareMove(d, opts);
  }

  /** The live Patch / Content-Aware Move drag: the selection's box where it would land. */
  private patchOverlay(): PathOverlay['marquee'] {
    const drag = this.patchDrag;
    const b = drag ? selectionBoundsOf(this.doc.selection) : null;
    if (!drag || !b) return null;
    const dx = drag.now.x - drag.start.x;
    const dy = drag.now.y - drag.start.y;
    return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  }

  /** The selection's coverage (0…1) over a rectangle, shifted by `d`. */
  private selectionOver(r: HealCmd.IRect, d = { x: 0, y: 0 }): Float32Array {
    const sel = this.doc.selection!;
    const w = r.x1 - r.x0;
    const out = new Float32Array(w * (r.y1 - r.y0));
    for (let y = r.y0; y < r.y1; y++)
      for (let x = r.x0; x < r.x1; x++) {
        const sx = x - d.x;
        const sy = y - d.y;
        if (sx < 0 || sy < 0 || sx >= sel.width || sy >= sel.height) continue;
        out[(y - r.y0) * w + (x - r.x0)] = sel.mask[sy * sel.width + sx]! / 255;
      }
    return out;
  }

  private shiftSelection(d: { x: number; y: number }): Selection | null {
    const sel = this.doc.selection;
    if (!sel) return null;
    const mask = createMask(sel.width, sel.height);
    for (let y = 0; y < sel.height; y++)
      for (let x = 0; x < sel.width; x++) {
        const sx = x - d.x;
        const sy = y - d.y;
        if (sx >= 0 && sy >= 0 && sx < sel.width && sy < sel.height) mask[y * sel.width + x] = sel.mask[sy * sel.width + sx]!;
      }
    return makeSelection(sel.width, sel.height, mask);
  }

  private applyPatch(d: { x: number; y: number }, opts: PatchOptions): boolean {
    const layer = this.activePixelLayer();
    const b = selectionBoundsOf(this.doc.selection);
    if (!layer || !b) return false;
    // Source: the selected area takes the pixels from where it was dragged to. Destination:
    // the selected pixels go where it was dragged to.
    const dest = opts.patchDirection === 'source' ? { x: 0, y: 0 } : d;
    const from = opts.patchDirection === 'source' ? d : { x: -d.x, y: -d.y };
    const both = { x0: Math.min(b.x0, b.x0 + d.x), y0: Math.min(b.y0, b.y0 + d.y), x1: Math.max(b.x1, b.x1 + d.x), y1: Math.max(b.y1, b.y1 + d.y) };
    const r = HealCmd.grow(both, 16, this.doc.width, this.doc.height);
    const mask = this.selectionOver(r, dest);
    const { rgb, weight } = HealCmd.patchArea(layer.plane.base, r, mask, { dx: from.x, dy: from.y }, opts.patchMode === 'contentAware');
    const plane = HealCmd.writeRect(layer.plane.base, r, rgb, weight);
    const selection = opts.patchDirection === 'destination' ? this.shiftSelection(d) : this.doc.selection;
    this.commit({ ...this.doc, selection, layers: updateLayer(this.doc.layers, layer.id, (l) => ({ ...l, plane: new MipPlane(plane) }) as typeof l) }, 'Patch Tool');
    return true;
  }

  private applyContentAwareMove(d: { x: number; y: number }, opts: PatchOptions): boolean {
    const layer = this.activePixelLayer();
    const b = selectionBoundsOf(this.doc.selection);
    if (!layer || !b) return false;
    const both = { x0: Math.min(b.x0, b.x0 + d.x), y0: Math.min(b.y0, b.y0 + d.y), x1: Math.max(b.x1, b.x1 + d.x), y1: Math.max(b.y1, b.y1 + d.y) };
    const r = HealCmd.grow(both, Math.max(24, Math.max(b.x1 - b.x0, b.y1 - b.y0)), this.doc.width, this.doc.height);
    let plane = layer.plane.base;
    // 1. What was selected, placed where it was dropped and healed into its new surroundings.
    const at = this.selectionOver(r, d);
    const placed = HealCmd.patchArea(plane, r, at, { dx: -d.x, dy: -d.y }, false);
    // Healing (Structure) keeps the moved pixels' detail; colour meets the new boundary.
    plane = HealCmd.writeRect(plane, r, placed.rgb, placed.weight);
    // 2. Move (not Extend): the hole it left, filled from the surroundings.
    if (opts.moveMode === 'move') {
      const was = this.selectionOver(r);
      const hole = new Float32Array(was.length);
      for (let i = 0; i < hole.length; i++) hole[i] = Math.max(0, was[i]! - at[i]!);
      const filled = HealCmd.spotHeal(plane, r, hole, 'contentAware');
      plane = HealCmd.writeRect(plane, r, filled.rgb, filled.weight);
    }
    this.commit({ ...this.doc, selection: this.shiftSelection(d), layers: updateLayer(this.doc.layers, layer.id, (l) => ({ ...l, plane: new MipPlane(plane) }) as typeof l) }, 'Content-Aware Move');
    return true;
  }

  // ---- Content-Aware Fill workspace ------------------------------------------------------

  private caf: {
    opts: CafOptions;
    /** The sampling area, 255 = sampled, over the whole canvas. */
    mask: Uint8Array;
    /** The selection the automatic sampling area was made for. */
    maskFor: Selection | null;
    tex: WebGLTexture | null;
    texDirty: Rect;
    /** When the preview went stale (ms), or null when it is current. */
    previewAt: number | null;
    painting: { x: number; y: number } | null;
    composite: { doc: Doc; plane: Plane } | null;
  } | null = null;
  /** Set by the worker: the workspace's state, whenever it changes. */
  onCafState?: (s: CafState) => void;

  /** Edit ▸ Content-Aware Fill: open the workspace on the selection. */
  cafBegin(opts: CafOptions): boolean {
    if (!this.activePixelLayer() || !selectionBoundsOf(this.doc.selection)) {
      this.statusNote = 'Content-Aware Fill needs a selection on a pixel layer.';
      return false;
    }
    const W = this.doc.width;
    const H = this.doc.height;
    this.caf = { opts, mask: new Uint8Array(W * H), maskFor: null, tex: null, texDirty: EMPTY_RECT, previewAt: 0, painting: null, composite: null };
    this.cafAutoSampling();
    this.onCafState?.({ active: true, sampling: opts.sampling, busy: true });
    return true;
  }

  cafSetOptions(opts: CafOptions): void {
    const c = this.caf;
    if (!c) return;
    const prev = c.opts;
    c.opts = opts;
    if (opts.sampling !== prev.sampling && opts.sampling !== 'custom') this.cafAutoSampling();
    // Only the overlay's look changed: the fill is still current.
    const fillChanged = JSON.stringify({ ...prev, overlay: 0 }) !== JSON.stringify({ ...opts, overlay: 0 });
    if (fillChanged) {
      c.previewAt = performance.now();
      this.onCafState?.({ active: true, sampling: opts.sampling, busy: true });
    }
  }

  /** Auto: a band around the fill area about its own size; Rectangular: its box, grown. [fit] */
  private cafAutoSampling(): void {
    const c = this.caf!;
    const sel = this.doc.selection;
    const b = selectionBoundsOf(sel);
    const W = this.doc.width;
    const H = this.doc.height;
    c.mask.fill(0);
    c.maskFor = sel;
    if (!sel || !b) return;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    if (c.opts.sampling === 'rectangular') {
      const r = HealCmd.grow(b, Math.max(16, Math.round(size / 2)), W, H);
      for (let y = r.y0; y < r.y1; y++) c.mask.fill(255, y * W + r.x0, y * W + r.x1);
    } else {
      // Within `d` of the fill area (a square window, through a summed-area table).
      const d = Math.max(24, size);
      const r = HealCmd.grow(b, d, W, H);
      const rw = r.x1 - r.x0;
      const rh = r.y1 - r.y0;
      const sum = new Int32Array((rw + 1) * (rh + 1));
      for (let y = 0; y < rh; y++)
        for (let x = 0; x < rw; x++) {
          const k = (y + 1) * (rw + 1) + x + 1;
          sum[k] = sum[k - 1]! + sum[k - rw - 1]! - sum[k - rw - 2]! + (sel.mask[(r.y0 + y) * W + r.x0 + x]! > 127 ? 1 : 0);
        }
      const box = (x0: number, y0: number, x1: number, y1: number) => sum[y1 * (rw + 1) + x1]! - sum[y0 * (rw + 1) + x1]! - sum[y1 * (rw + 1) + x0]! + sum[y0 * (rw + 1) + x0]!;
      for (let y = 0; y < rh; y++)
        for (let x = 0; x < rw; x++)
          if (box(Math.max(0, x - d), Math.max(0, y - d), Math.min(rw, x + d + 1), Math.min(rh, y + d + 1)) > 0) c.mask[(r.y0 + y) * W + r.x0 + x] = 255;
    }
    // Never sample what is being filled.
    for (let i = 0; i < c.mask.length; i++) if (sel.mask[i]! > 127) c.mask[i] = 0;
    c.texDirty = { x0: 0, y0: 0, x1: W, y1: H };
    c.previewAt = performance.now();
  }

  /** The Sampling Brush: paint the sampling area in (or out, with `subtract`). */
  cafPaint(phase: 'down' | 'move' | 'up', sx: number, sy: number, size: number, subtract: boolean): void {
    const c = this.caf;
    if (!c) return;
    if (phase === 'up') {
      c.painting = null;
      c.previewAt = performance.now();
      this.onCafState?.({ active: true, sampling: c.opts.sampling, busy: true });
      return;
    }
    const p = docPointAtScreen(this.view, sx, sy);
    const from = phase === 'down' || !c.painting ? p : c.painting;
    c.painting = p;
    if (c.opts.sampling !== 'custom') {
      c.opts = { ...c.opts, sampling: 'custom' };
      this.onCafState?.({ active: true, sampling: 'custom', busy: true });
    }
    const W = this.doc.width;
    const H = this.doc.height;
    const r = Math.max(0.5, size / 2);
    const len = Math.hypot(p.x - from.x, p.y - from.y);
    const steps = Math.max(1, Math.ceil(len / Math.max(1, r / 2)));
    const v = subtract ? 0 : 255;
    const sel = this.doc.selection;
    for (let k = 0; k <= steps; k++) {
      const cx = from.x + ((p.x - from.x) * k) / steps;
      const cy = from.y + ((p.y - from.y) * k) / steps;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++)
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r && !(sel && sel.mask[y * W + x]! > 127)) c.mask[y * W + x] = v;
    }
    c.texDirty = rectUnion(c.texDirty, { x0: Math.max(0, Math.floor(Math.min(p.x, from.x) - r)), y0: Math.max(0, Math.floor(Math.min(p.y, from.y) - r)), x1: Math.min(W, Math.ceil(Math.max(p.x, from.x) + r)), y1: Math.min(H, Math.ceil(Math.max(p.y, from.y) + r)) });
  }

  /** The fill over its working rectangle: the fill area and every sampled pixel. */
  private cafFill(maxDim?: number): { r: HealCmd.IRect; fill: ReturnType<typeof HealCmd.fillFromSampling>; layer: PixelLayer } | null {
    const c = this.caf;
    const layer = this.activePixelLayer();
    const b = selectionBoundsOf(this.doc.selection);
    if (!c || !layer || !b) return null;
    const W = this.doc.width;
    let x0 = b.x0;
    let y0 = b.y0;
    let x1 = b.x1;
    let y1 = b.y1;
    for (let i = 0; i < c.mask.length; i++) {
      if (!c.mask[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
    const r = { x0, y0, x1, y1 };
    const rw = x1 - x0;
    const allowed = new Uint8Array(rw * (y1 - y0));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) allowed[(y - y0) * rw + (x - x0)] = c.mask[y * W + x]! ? 1 : 0;
    let source = layer.plane.base;
    if (c.opts.sampleAll) {
      if (c.composite?.doc !== this.doc) c.composite = { doc: this.doc, plane: this.compositePlane() };
      source = c.composite.plane;
    }
    const fill = HealCmd.fillFromSampling(source, r, this.selectionOver(r), allowed, {
      rotation: CAF_ROTATION[c.opts.rotation],
      scale: c.opts.scale,
      mirror: c.opts.mirror,
      adaptation: CAF_ADAPTATION[c.opts.colorAdaptation],
      seed: 7,
      maxDim,
    });
    return { r, fill, layer };
  }

  /** The Preview panel's picture: the fill area and its surroundings, filled, at a small size. */
  private cafPreview(): CafState['preview'] | undefined {
    const res = this.cafFill(360);
    const b = selectionBoundsOf(this.doc.selection);
    if (!res || !b) return undefined;
    const { r, fill } = res;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const f = HealCmd.grow(b, Math.round(size / 2), this.doc.width, this.doc.height);
    // The frame in the fill's (reduced) samples.
    const fx0 = Math.max(0, Math.floor((f.x0 - r.x0) / fill.step));
    const fy0 = Math.max(0, Math.floor((f.y0 - r.y0) / fill.step));
    const fx1 = Math.min(fill.w, Math.ceil((f.x1 - r.x0) / fill.step));
    const fy1 = Math.min(fill.h, Math.ceil((f.y1 - r.y0) / fill.step));
    const width = Math.max(1, fx1 - fx0);
    const height = Math.max(1, fy1 - fy0);
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (fy0 + y) * fill.w + fx0 + x;
        const o = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) pixels[o + ch] = Math.round(Math.max(0, Math.min(1, fill.rgb[i * 3 + ch]!)) * 255);
        pixels[o + 3] = 255;
      }
    return { pixels, width, height };
  }

  /** The workspace's per-frame work: follow the selection, upload the overlay, refresh the preview. */
  private cafFrame(): void {
    const c = this.caf;
    if (!c) {
      this.renderer.cafOverlay = null;
      return;
    }
    // The Lasso changed the fill area: the automatic sampling area follows it.
    if (this.doc.selection !== c.maskFor) {
      if (c.opts.sampling === 'custom') {
        c.maskFor = this.doc.selection;
        c.previewAt = performance.now();
      } else this.cafAutoSampling();
      this.onCafState?.({ active: true, sampling: c.opts.sampling, busy: true });
    }
    const gl = this.gl;
    const W = this.doc.width;
    const H = this.doc.height;
    if (!c.tex) {
      c.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, c.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, W, H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      c.texDirty = { x0: 0, y0: 0, x1: W, y1: H };
    }
    if (!rectIsEmpty(c.texDirty)) {
      const r = c.texDirty;
      gl.bindTexture(gl.TEXTURE_2D, c.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, gl.RED, gl.UNSIGNED_BYTE, c.mask, r.y0 * W + r.x0);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      c.texDirty = EMPTY_RECT;
    }
    const o = c.opts.overlay;
    this.renderer.cafOverlay = o.show ? { tex: c.tex, style: { color: o.color, opacity: o.opacity, indicateSelected: o.indicates === 'sampling' } } : null;
    // A quarter-second after the last change (and not mid-stroke), the preview is redone.
    if (c.previewAt !== null && !c.painting && performance.now() - c.previewAt > 250) {
      c.previewAt = null;
      this.onCafState?.({ active: true, sampling: c.opts.sampling, preview: this.cafPreview(), busy: false });
    }
  }

  /** OK (the fill, as the output says) or Cancel. */
  cafEnd(commit: boolean): boolean {
    const c = this.caf;
    if (!c) return false;
    let done = false;
    if (commit) {
      const res = this.cafFill();
      if (res) {
        const { r, fill, layer } = res;
        let doc = this.doc;
        if (c.opts.output === 'current') {
          const plane = HealCmd.writeRect(layer.plane.base, r, fill.rgb, fill.weight);
          doc = { ...doc, layers: updateLayer(doc.layers, layer.id, (l) => ({ ...l, plane: new MipPlane(plane) }) as typeof l) };
        } else {
          const base = c.opts.output === 'duplicate' ? layer.plane.base : Plane.empty(RGBA8);
          const plane = HealCmd.writeRect(base, r, fill.rgb, fill.weight, c.opts.output === 'new');
          const added = makePixelLayer(c.opts.output === 'new' ? 'Content-Aware Fill' : `${layer.name} copy`, plane);
          doc = { ...doc, layers: insertLayer(doc.layers, added, layer.id), activeLayerIds: [added.id] };
        }
        this.commit(doc, 'Content-Aware Fill');
        done = true;
      }
    }
    if (c.tex) this.gl.deleteTexture(c.tex);
    this.caf = null;
    this.renderer.cafOverlay = null;
    this.onCafState?.({ active: false });
    return done;
  }

  /**
   * Content-Aware Fill in one step (scripts and the old message): the workspace opened with
   * these settings and OK'd at once. 'all' samples the whole canvas.
   */
  contentAwareFill(opts: { sampling: 'auto' | 'rectangular' | 'all'; colorAdaptation: boolean; output: 'current' | 'new' | 'duplicate' }): boolean {
    const o: CafOptions = { ...DEFAULT_CAF, sampling: opts.sampling === 'all' ? 'custom' : opts.sampling, colorAdaptation: opts.colorAdaptation ? 'default' : 'none', output: opts.output };
    const quiet = this.onCafState;
    this.onCafState = undefined;
    try {
      if (!this.cafBegin(o)) return false;
      if (opts.sampling === 'all') {
        const sel = this.doc.selection!;
        for (let i = 0; i < this.caf!.mask.length; i++) this.caf!.mask[i] = sel.mask[i]! > 127 ? 0 : 255;
      }
      return this.cafEnd(true);
    } finally {
      this.onCafState = quiet;
    }
  }

  /** The Red Eye tool: a click on a red pupil. */
  redEye(x: number, y: number, pupilSize: number, darken: number): boolean {
    const layer = this.activePixelLayer();
    if (!layer) return false;
    const p = docPointAtScreen(this.view, x, y);
    const plane = HealCmd.redEye(layer.plane.base, p.x, p.y, this.doc.width, this.doc.height, pupilSize, darken);
    if (!plane) {
      this.statusNote = 'Red Eye: no red pupil under the click.';
      return false;
    }
    this.commit({ ...this.doc, layers: updateLayer(this.doc.layers, layer.id, (l) => ({ ...l, plane: new MipPlane(plane) }) as typeof l) }, 'Red Eye Tool');
    return true;
  }

  /**
   * Healing Brush: heal the dabs painted since the last frame into the healed plane. Dabs are
   * taken in runs whose box stays small, so a fast stroke is healed in pieces, each joining the
   * pieces before it.
   */
  private healNow(): void {
    const hw = this.healWriter;
    const layer = this.strokeLayerId !== null ? findLayer(this.doc.layers, this.strokeLayerId) : undefined;
    if (!hw || !this.strokeWriter || layer?.kind !== 'pixel' || !this.healPending.length) return;
    const pending = this.healPending;
    this.healPending = [];
    const diffusion = this.retouch?.s.options.diffusion ?? 5;
    const stroke = this.strokeWriter.preview();
    const W = this.doc.width;
    const H = this.doc.height;
    for (let at = 0; at < pending.length; ) {
      // One run: dabs while the box stays within 256².
      let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      let end = at;
      for (; end < pending.length; end++) {
        const d = pending[end]!;
        const next = { x0: Math.min(box.x0, d.x - d.r), y0: Math.min(box.y0, d.y - d.r), x1: Math.max(box.x1, d.x + d.r), y1: Math.max(box.y1, d.y + d.r) };
        if (end > at && (next.x1 - next.x0) * (next.y1 - next.y0) > 256 * 256) break;
        box = next;
      }
      const run = pending.slice(at, end);
      at = end;
      const r = HealCmd.grow({ x0: Math.floor(box.x0), y0: Math.floor(box.y0), x1: Math.ceil(box.x1), y1: Math.ceil(box.y1) }, 3, W, H);
      if (rectIsEmpty(r)) continue;
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      const fresh = new Uint8Array(w * h);
      for (const d of run) {
        const rr = d.r * d.r;
        for (let y = Math.max(r.y0, Math.floor(d.y - d.r)); y < Math.min(r.y1, Math.ceil(d.y + d.r)); y++)
          for (let x = Math.max(r.x0, Math.floor(d.x - d.r)); x < Math.min(r.x1, Math.ceil(d.x + d.r)); x++)
            if ((x + 0.5 - d.x) ** 2 + (y + 0.5 - d.y) ** 2 <= rr) fresh[(y - r.y0) * w + (x - r.x0)] = 1;
      }
      const out = HealCmd.healLive(layer.plane.base, stroke, hw.preview(), r, fresh, diffusion);
      const touched = new Set<string>();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!out.region[i]) continue;
          const X = r.x0 + x;
          const Y = r.y0 + y;
          const d = hw.mutable(X >> TILE_SHIFT, Y >> TILE_SHIFT);
          const o = ((Y & (TILE_SIZE - 1)) * TILE_SIZE + (X & (TILE_SIZE - 1))) * 4;
          for (let c = 0; c < 3; c++) d[o + c] = Math.round(Math.max(0, Math.min(1, out.rgb[i * 3 + c]!)) * 255);
          d[o + 3] = Math.round(out.alpha[i]! * 255);
          touched.add(`${X >> TILE_SHIFT},${Y >> TILE_SHIFT}`);
        }
      for (const k of touched) {
        const [tx, ty] = k.split(',').map(Number) as [number, number];
        this.atlas.invalidate(hw.mutableTile(tx, ty));
      }
    }
  }

  /** Spot Healing / Remove: the painted area, filled when the stroke ends. */
  private finishRegionStroke(): void {
    const tool = this.retouchTool!;
    const id = this.strokeLayerId!;
    const stroke = this.strokeWriter!.commit();
    const opts = this.regionOptions ?? DEFAULT_RETOUCH;
    const layer = findLayer(this.doc.layers, id);
    const b = tightBounds(stroke);
    if (layer?.kind === 'pixel' && !rectIsEmpty(b)) {
      // Room around the area to sample from: about its own size again.
      const margin = Math.max(24, Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * (tool === 'removeTool' ? 1.5 : 1)));
      const r = HealCmd.grow(b, margin, this.doc.width, this.doc.height);
      const cover = HealCmd.readRect(stroke, r).alpha;
      const src = opts.sampleAll ? this.compositePlane() : layer.plane.base;
      const type = tool === 'removeTool' ? 'contentAware' : opts.spotType;
      const { rgb, weight } = HealCmd.spotHeal(src, r, cover, type, (this.brush.seed ?? 1) & 0xffff);
      const plane = HealCmd.writeRect(layer.plane.base, r, rgb, weight, opts.sampleAll);
      this.commit({ ...this.doc, layers: updateLayer(this.doc.layers, id, (l) => ({ ...l, plane: new MipPlane(plane) }) as typeof l) }, RETOUCH_NAMES[tool]);
    }
    this.regionOptions = null;
    this.brush = { ...this.brush, opacity: 1 };
    this.finishRetouch();
  }

  /** The document composited into a plane (Sample All Layers). */
  private compositePlane(): Plane {
    const { pixels, width, height } = this.renderer.renderToBuffer(this.doc, this.caps.maxTextureSize);
    return planeFromBitmap({ data: pixels, width, height, left: 0, top: 0 });
  }

  /** Clone Stamp / Healing: an aligned stroke's first dab fixes the offset. */
  private pendingCloneAnchor = false;

  /** Alt-click with the Clone Stamp or Healing Brush: the source point (screen coordinates). */
  setCloneSource(x: number, y: number, doc = false): void {
    const p = doc ? { x, y } : docPointAtScreen(this.view, x, y);
    this.cloneSource = { x: p.x, y: p.y };
    this.cloneOffset = null;
    this.statusNote = `Clone source set at ${Math.round(p.x)}, ${Math.round(p.y)}`;
  }

  // ---- mask targeting ---------------------------------------------------------------------

  /**
   * The layer whose MASK is the edit target — Photoshop's "clicked the mask thumbnail". An
   * adjustment or fill layer's mask is always the target: they have nothing else to paint.
   */
  private maskTarget: number | null = null;
  private strokeIntoMask = false;
  /** The mask stroke goes into a smart object's filter mask: no live overlay, the result lands at the end. */
  private strokeIntoFilterMask = false;

  /** The smart object whose filter mask is the target (clicked in the Smart Filters row). */
  private filterMaskTarget: number | null = null;

  setMaskTarget(id: number, mask: boolean, filter = false): boolean {
    const layer = findLayer(this.doc.layers, id);
    const nextFilter = mask && filter && layer?.kind === 'smart' && layer.filterMask ? id : null;
    const next = mask && !filter && layer?.mask ? id : null;
    if (next === this.maskTarget && nextFilter === this.filterMaskTarget) return false;
    this.maskTarget = next;
    this.filterMaskTarget = nextFilter;
    return true;
  }

  /**
   * Run a mask edit on a smart object's filter mask: the mask is lent to the layer's `mask`
   * slot, so every mask operation (brush, fill, gradient, filters, Apply Image) works on it
   * unchanged, then handed back and the object re-rendered. Any other target runs as is.
   */
  private onTarget(target: { id: number; filter?: boolean }, op: (doc: Doc) => Doc): Doc {
    if (!target.filter) return op(this.doc);
    const layer = findLayer(this.doc.layers, target.id);
    if (!layer || layer.kind !== 'smart' || !layer.filterMask) return this.doc;
    const lent: Doc = { ...this.doc, layers: updateLayer(this.doc.layers, target.id, (l) => ({ ...l, mask: layer.filterMask })) };
    const out = op(lent);
    if (out === lent) return this.doc;
    const after = findLayer(out.layers, target.id) as SmartObjectLayer;
    const back = Smart.rendered({ ...after, mask: layer.mask, filterMask: after.mask }, out, this.smartMap);
    return { ...out, layers: replaceLayer(out.layers, target.id, back) };
  }

  /** What painting acts on: the active layer's pixels or its mask; null when neither. */
  private paintTarget(): { id: number; mask: boolean; filter?: boolean } | null {
    const id = this.doc.activeLayerIds[0];
    const layer = id === undefined ? undefined : findLayer(this.doc.layers, id);
    if (!layer) return null;
    if (layer.kind === 'smart' && this.filterMaskTarget === layer.id && layer.filterMask) return { id: layer.id, mask: true, filter: true };
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
    // Catch-up on Stroke End: the brush runs on to where the pointer let go.
    if (this.painting && this.strokeState) for (const dab of finishStroke(this.strokeState)) this.stampDab(dab);
    // An erodible tip stays as worn as the stroke left it.
    const tip = this.strokeState?.params.tip;
    if (tip?.kind === 'erodible') this.tipWear.set(JSON.stringify(tip), this.strokeState!.wear);
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

    if (this.retouch && this.retouch.family === 'direct' && this.retouchLayer) {
      // Direct tools: the working copy is the result.
      const id = this.strokeLayerId;
      const before = this.docBeforeRetouch ?? this.doc;
      const plane = this.retouchLayer.commit();
      const layers = updateLayer(before.layers, id, (l) => (l.kind === 'pixel' ? { ...l, plane: new MipPlane(plane) } : l));
      const name = RETOUCH_NAMES[this.retouchTool!];
      this.doc = before;
      this.commit({ ...before, layers }, name);
      this.fadeState = { before, after: this.doc, name, layerId: id, mask: false };
      this.finishRetouch();
      return;
    }
    if (this.retouchTool === 'spotHealing' || this.retouchTool === 'removeTool') {
      this.finishRegionStroke();
      return;
    }
    // The Healing Brush commits what it showed: the healed colours, healed as it painted.
    if (this.healWriter) this.healNow();
    let strokePlane = this.strokeWriter.commit();
    if (this.healWriter) strokePlane = this.healWriter.commit();
    const id = this.strokeLayerId;
    const before = this.doc;
    const intoMask = this.strokeIntoMask;
    const intoFilterMask = this.strokeIntoFilterMask;
    this.commit(
      this.strokeIntoMask
        ? this.onTarget({ id, filter: intoFilterMask }, (d) => MaskPaint.compositeStrokeIntoMask(d, id, strokePlane, this.brush.opacity, !!this.brush.wetEdges))
        : FillCmd.compositeStroke(this.doc, id, strokePlane, this.brush.opacity, this.paintMode, !!this.brush.wetEdges),
      this.retouchTool ? RETOUCH_NAMES[this.retouchTool] : this.paintMode === 'clear' ? 'Eraser' : 'Brush Tool',
    );
    this.fadeState = intoFilterMask ? null : { before, after: this.doc, name: this.retouchTool ? RETOUCH_NAMES[this.retouchTool] : this.paintMode === 'clear' ? 'Eraser' : 'Brush Tool', layerId: id, mask: intoMask };
    this.finishRetouch();
    this.strokeIntoMask = false;
    this.strokeIntoFilterMask = false;
    this.strokeWriter = null;
    this.strokeState = null;
    this.strokeLayerId = null;
    this.painting = false;
    this.lastDab = null;
  }

  /** A stroke asked for while the last one's samples are still in the ring. */
  private pendingStroke: [BrushParams, [number, number, number], PaintMode, [number, number, number] | undefined, { tool: RetouchToolId; options: RetouchOptions } | undefined] | null = null;

  /**
   * Start a stroke from the pointer. The request arrives by message, at once, but the last
   * stroke's samples (its pointer-up included) are only drained on the frame clock; if that
   * stroke is still open, the new one waits for its own pointer-down in the ring — otherwise a
   * quick second stroke during a slow frame would inherit the first one's tail.
   */
  requestStroke(params: BrushParams, color: [number, number, number], mode: PaintMode, bg?: [number, number, number], retouch?: { tool: RetouchToolId; options: RetouchOptions }): void {
    if (this.painting && !this.quickMask) this.pendingStroke = [params, color, mode, bg, retouch];
    else this.beginStroke(params, color, mode, bg, retouch);
  }

  private processInput(): void {
    const samples = this.ring.drain(this.samples);
    if (samples.length === 0) return;
    let oldest: number | null = null;

    for (const s of samples) {
      if (s.flags & FLAG_DOWN && this.pendingStroke) {
        if (this.painting) this.endStroke();
        const [p, c, m, bg, rt] = this.pendingStroke;
        this.pendingStroke = null;
        this.beginStroke(p, c, m, bg, rt);
      }
      if (!this.painting || !this.strokeState) continue;
      if (oldest === null) oldest = s.timeAbs;

      const doc = docPointAtScreen(this.view, s.x, s.y);
      for (const dab of strokeTo(this.strokeState, {
        x: doc.x,
        y: doc.y,
        pressure: s.pressure,
        time: s.timeAbs,
        tiltX: s.tiltX,
        tiltY: s.tiltY,
        twist: s.twist,
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
    if (!this.painting || !this.strokeState) return;
    // Stroke Catch-up: a lagging brush keeps closing on a pointer held still.
    for (const dab of catchUpStroke(this.strokeState)) this.stampDab(dab);
    if (!this.brush.airbrush) return;
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
      this.stampQuickMaskDab(dab);
      return;
    }
    if (this.retouch) {
      this.stampRetouchDab(dab);
      return;
    }
    const writer = this.strokeWriter;
    if (!writer) return;
    // Colour Dynamics give a dab its own colour; into a mask it is the colour's grey.
    let color: [number, number, number] = dab.color ?? this.strokeColor;
    if (this.strokeIntoMask) {
      const g = dab.color && this.paintMode !== 'clear' ? MaskPaint.lumOf(dab.color) : this.strokeParams.color[0];
      color = [g, g, g];
    }
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
        color: [color[0], color[1], color[2], dab.flow],
        flipX: dab.flipX,
        flipY: dab.flipY,
        tip: dab.tip,
        dual: dab.dual,
        textureDepth: dab.textureDepth,
      },
      this.selectionTexture(),
      this.dabStyle,
      (id) => this.tipOf(id),
    );
  }

  private stampRetouchDab(dab: Dab): void {
    const r = this.retouch!;
    if (this.pendingCloneAnchor && this.cloneSource) {
      // The first dab of the stroke: an unaligned stroke (or the first aligned one) anchors the
      // source point here.
      const aligned = this.retouchOptionsAligned;
      if (!aligned || !this.cloneOffset) this.cloneOffset = { dx: dab.x - this.cloneSource.x, dy: dab.y - this.cloneSource.y };
      this.pendingCloneAnchor = false;
    }
    const sel = this.doc.selection;
    const ctx = this.coverageCtx;
    r.dab(dab, (x, y) => {
      const a = dabAlpha(dab, x, y, ctx);
      if (!sel || a <= 0) return a;
      return a * (sel.mask[Math.floor(y) * sel.width + Math.floor(x)] ?? 0) / 255;
    });
    // The Healing Brush heals what the dab laid down on the next frame.
    if (this.healWriter) this.healPending.push({ x: dab.x, y: dab.y, r: dab.radius * (dab.tip ? 1.5 : 1) + 1 });
    // Refresh what the dab wrote on the GPU.
    const writer = r.family === 'direct' ? this.retouchLayer : this.strokeWriter;
    for (const [tx, ty] of r.takeTouched()) if (writer) this.atlas.invalidate(writer.mutableTile(tx, ty));
    if (r.family === 'direct') this.retouchDirty = true;
  }

  /** The Aligned option of the stroke in progress. */
  private get retouchOptionsAligned(): boolean {
    return this.retouch?.s.options.aligned ?? true;
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
  private stampQuickMaskDab(dab: Dab): void {
    const sel = this.doc.selection;
    if (!sel) return;
    const { mask, width, height } = sel;
    const [r, g, b] = dab.color ?? this.strokeParams.color;
    // Rec. 709 luma, the same weighting the greyscale conversion uses. Black paints rubylith
    // (coverage 0, protected); white paints it away.
    const target = 255 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
    const reach = dab.radius / Math.max(0.01, Math.min(1, dab.roundness)) * (dab.tip ? Math.SQRT2 : 1) + 1;
    const x0 = Math.max(0, Math.floor(dab.x - reach));
    const x1 = Math.min(width, Math.ceil(dab.x + reach) + 1);
    const y0 = Math.max(0, Math.floor(dab.y - reach));
    const y1 = Math.min(height, Math.ceil(dab.y + reach) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        // The CPU reference: the same tip, dual brush, texture and noise as the GPU dab.
        const a = dabAlpha(dab, px + 0.5, py + 0.5, this.coverageCtx);
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

    // A direct retouch stroke shows by swapping its working plane into the layer.
    if (this.retouch?.family === 'direct' && this.retouchDirty && this.retouchLayer && this.strokeLayerId !== null) {
      this.docBeforeRetouch ??= this.doc;
      const plane = new MipPlane(this.retouchLayer.preview(), 0);
      this.doc = { ...this.docBeforeRetouch, layers: updateLayer(this.docBeforeRetouch.layers, this.strokeLayerId, (l) => (l.kind === 'pixel' ? { ...l, plane } : l)) };
      this.retouchDirty = false;
    }
    this.cafFrame();
    this.atlas.beginFrame();
    // The live stroke is drawn from the base level only: it is small, and a mip built from the
    // stroke buffer would be a frame behind the dabs the GPU is still laying down.
    const live = this.strokeWriter && this.strokeLayerId !== null;
    this.renderer.setMaskStrokeOverlay(
      live && this.strokeIntoMask && !this.strokeIntoFilterMask
        ? { plane: new MipPlane(this.strokeWriter!.preview(), 0), layerId: this.strokeLayerId!, opacity: this.brush.opacity, wet: !!this.brush.wetEdges }
        : null,
    );
    this.renderer.setEraseOverlay(
      this.strokeWriter && this.strokeLayerId !== null && !this.strokeIntoMask && this.paintMode === 'clear'
        ? {
            plane: new MipPlane(this.strokeWriter.preview(), 0),
            layerId: this.strokeLayerId,
            opacity: this.brush.opacity,
            wet: !!this.brush.wetEdges,
          }
        : null,
    );
    // The Healing Brush heals what was painted since the last frame, then shows the healed plane.
    if (this.healWriter && this.healPending.length) this.healNow();
    this.renderer.setStrokeOverlay(
      this.strokeWriter && this.strokeLayerId !== null && !this.strokeIntoMask && this.paintMode !== 'clear'
        ? {
            plane: new MipPlane((this.healWriter ?? this.strokeWriter).preview(), 0),
            layerId: this.strokeLayerId,
            opacity: this.brush.opacity,
            // Behind previews as Normal; the difference only shows where the layer already has
            // pixels, and the exact result lands when the stroke is composited.
            mode: this.paintMode === 'behind' ? 'normal' : this.paintMode,
            wet: !!this.brush.wetEdges,
          }
        : null,
    );
    // Layers under a live transform draw through its matrix rather than being rewritten.
    const cloneOverlay = this.transform ? null : this.cloneOverlayLayer();
    this.renderer.setLiveTransform(
      this.transform && !this.transform.selectionOnly && !isIdentity(this.transform.matrix)
        ? { ids: new Set(this.transform.ids), matrix: this.transform.matrix }
        : cloneOverlay?.matrix
          ? { ids: new Set([OVERLAY_ID]), matrix: cloneOverlay.matrix, bounded: true }
          : null,
    );
    this.renderer.setAdjustPreview(this.adjustPreview);
    const overlay = this.quickMask ? this.selectionTexture() : null;
    this.renderer.pathOverlay = this.pathOverlay();
    const s = this.renderer.render(
      this.previewDoc ?? (cloneOverlay ? { ...this.doc, layers: [...this.doc.layers, cloneOverlay.layer] } : this.doc),
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
      maskTarget: this.paintTarget()?.mask && !this.paintTarget()?.filter ? (this.doc.activeLayerIds[0] ?? null) : null,
      editingContents: this.editingContents,
      globalLight: this.doc.globalLight ?? DEFAULT_GLOBAL_LIGHT,
      paths: (this.doc.paths ?? []).map((p) => ({ id: p.id, name: p.name, work: p.work, path: p.path })),
      activePathId: this.targetPath()?.id ?? null,
      typeReady: textReady(),
      cloneSource: this.cloneSource,
      cloneOffset: this.cloneOffset,
      historyBrushSource: this.historyBrushSource,
      typeEdit: (() => {
        const e = this.typeEdit;
        const l = this.typeLayer();
        if (!e || !l) return null;
        const a = Math.min(e.caret, e.anchor);
        const b = Math.max(e.caret, e.anchor);
        return { layerId: l.id, caret: e.caret, anchor: e.anchor, style: e.typing ?? styleAt(l.text, a === b ? a : a + 1), para: l.text.paragraphs[paragraphAt(l.text, e.caret)] ?? l.text.paragraphs[0]!, selected: textOf(l.text).slice(a, b), mask: e.mask };
      })(),
      statusNote: (() => {
        const n = this.statusNote;
        this.statusNote = null;
        return n;
      })(),
      layerPath: (() => {
        const lp = this.layerPath();
        return lp ? { kind: lp.kind, name: layerPathName(lp.layer.name, lp.kind), path: lp.path } : null;
      })(),
      filterMaskTarget: this.paintTarget()?.filter ? (this.doc.activeLayerIds[0] ?? null) : null,
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
        effects: layer.effects ? Engine.effectsToSummary(layer.effects) : undefined,
        blending: layer.blending,
        shape:
          layer.kind === 'shape'
            ? {
                path: layer.path,
                live: layer.live,
                fill: layer.fillContent ? Engine.fillToSummary(layer.fillContent) : null,
                stroke: layer.stroke ? { ...layer.stroke, content: Engine.fillToSummary(layer.stroke.content) } : null,
              }
            : undefined,
        vectorMask: layer.vectorMask,
        type: layer.kind === 'type' ? { text: layer.text, antiAlias: layer.antiAlias, transform: layer.transform, missingFonts: layer.missingFonts ? [...layer.missingFonts] : undefined } : undefined,
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
        tiles: hasPlane(layer) ? layer.plane.base.tileCount : 0,
      })),
    };
  }

  /** A style for the UI: patterns by id only (their pixels stay here). */
  private static effectsToSummary(fx: LayerEffects): LayerEffects {
    return mapEffectPatterns(fx, (p) => ({ ...p, data: new Uint8Array(0) }));
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
