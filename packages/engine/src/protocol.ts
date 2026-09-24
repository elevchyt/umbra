/** Message protocol between the UI thread and the engine worker (spec 03 §2). */
import type { BrushParams } from '@umbra/kernels/brush';
import type { Gradient } from '@umbra/kernels/gradient';
import type { Adjustment } from '@umbra/kernels/adjust';
import type { FillContent } from '@umbra/kernels/fill';
import type { SpatialAdjustment } from '@umbra/kernels/spatial';
import type { ApplyImageOptions, CalculationsOptions } from '@umbra/kernels/applyimage';
import type { FilterParams } from '@umbra/kernels/filters/types';
import type { BlendMode } from '@umbra/core/blend';
import type { GlobalLight, LayerEffects } from '@umbra/kernels/effects/types';
import type { StylePreset } from '@umbra/kernels/effects/presets';
import type { AdvancedBlending } from '@umbra/kernels/composite';
import type { ToolPresetExport, ToolPresetImport } from './tpl.js';
import type { LayerStyleProps, PathCommand, SmartCommand, SmartFilterOp, StyleCommand, TypeCommand, VectorMaskCommand, BrushLibraryOp, PatchOptions, CloneOverlay, CafOptions, CafState } from './engine.js';
import type { BrushGroup, BrushPreset, TipBitmap } from '@umbra/kernels/brush';
import type { RetouchOptions, RetouchToolId } from './retouch.js';
import type { PathArrange, VectorOptions, VectorToolId } from './vector-tool.js';
import type { ShapeOptions, ShapeToolId } from './shape-tool.js';
import type { Path } from '@umbra/kernels/vector/path';
import type { AntiAlias, CharStyle, ParaStyle, TextSpec } from '@umbra/text/style';
import type { WarpSpec } from '@umbra/text/warp';
import type { LiveShape } from '@umbra/kernels/vector/shapes';
import type { StrokeStyle } from '@umbra/kernels/vector/stroke';

type Rgb3 = [number, number, number];

/**
 * A fill layer's content as the UI sees it: the same as the model, except a pattern is named
 * by id — its pixels stay in the worker and reach the UI only as a thumbnail.
 */
export type FillSummary =
  | Exclude<FillContent, { type: 'pattern' }>
  | { type: 'pattern'; patternId: string; patternName: string; scale: number; phase: { x: number; y: number } };

export interface ProbePoint {
  /** Document pixel. */
  x: number;
  y: number;
  /** RGBA 0…255 of the composite, or null off the canvas. */
  before: [number, number, number, number] | null;
  /** The same with the open dialog's preview applied; null when nothing is previewing. */
  after: [number, number, number, number] | null;
}

export interface ProbeReply {
  cursor: ProbePoint | null;
  samplers: ProbePoint[];
}

export interface PatternSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 32×32 RGBA preview. */
  thumb: Uint8Array;
}
import type { GpuCaps } from './gpu/caps.js';


export interface LayerSummary {
  id: number;
  name: string;
  kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart' | 'shape' | 'type';
  /** Shape layers: the path, live-shape parameters, fill and stroke, for Properties and the tools. */
  shape?: { path: Path; live?: LiveShape; fill: FillContentSummary | null; stroke: ShapeStrokeSummary | null };
  /** Type layers: the text, its anti-aliasing and placement, and fonts the file named that are missing. */
  type?: { text: TextSpec; antiAlias: AntiAlias; transform: { a: number; b: number; c: number; d: number; e: number; f: number }; missingFonts?: string[] };
  /** The layer's vector mask path, when it has one. */
  vectorMask?: { path: Path; enabled: boolean };
  /** The layer style, when the layer has one. */
  effects?: LayerEffects;
  /** Advanced blending: channels, knockout, Blend If (Layer Style ▸ Blending Options). */
  blending: AdvancedBlending;
  /** Smart objects: the contents and the smart filters, for the Layers panel's filter rows. */
  smart?: SmartSummary;
  /** Adjustment layers: the parameters, for the Properties panel to edit. */
  adjustment?: Adjustment;
  /** Fill layers: the content, for the thumbnail and the Properties panel. */
  fillContent?: FillSummary;
  /** Indentation level in the Layers panel. */
  depth: number;
  opacity: number;
  fill: number;
  blendMode: string;
  visible: boolean;
  clipped: boolean;
  hasMask: boolean;
  maskEnabled: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean; all: boolean };
  expanded: boolean;
  tiles: number;
}

export interface SmartFilterSummary {
  id: number;
  filterId: string;
  label: string;
  enabled: boolean;
  blendMode: string;
  opacity: number;
  params: FilterParams;
}

export interface SmartSummary {
  sourceName: string;
  width: number;
  height: number;
  filtersEnabled: boolean;
  hasFilterMask: boolean;
  filterMaskEnabled: boolean;
  filters: SmartFilterSummary[];
}

export interface ShapeStrokeSummary {
  enabled: boolean;
  style: StrokeStyle;
  content: FillContentSummary;
  opacity: number;
  blendMode: string;
}

export interface DocSummary {
  name: string;
  width: number;
  height: number;
  /** Flattened for display: top-most first, groups above their children. */
  layers: LayerSummary[];
  activeLayerIds: number[];
  /** The active layer when its MASK is the edit target (always so for adjustment/fill layers). */
  maskTarget: number | null;
  /** Layer ▸ Layer Style ▸ Global Light. */
  globalLight: GlobalLight;
  /** The Paths panel: saved paths and the Work Path, and the one selected. */
  paths: { id: number; name: string; work: boolean; path: Path }[];
  activePathId: number | null;
  /** Clone Stamp / Healing Brush: the source point and the offset aligned strokes keep. */
  cloneSource: { x: number; y: number } | null;
  cloneOffset: { dx: number; dy: number } | null;
  /** The History Brush's source state. */
  historyBrushSource: number;
  /** The type engine has loaded (HarfBuzz and the bundled fonts). */
  typeReady: boolean;
  /** An open type editing session: the caret and selection, and the styles there. */
  typeEdit: { layerId: number; caret: number; anchor: number; style: CharStyle; para: ParaStyle; selected: string; mask: boolean } | null;
  /** A one-off note for the status bar. */
  statusNote: string | null;
  /** The active layer's own path (shape outline or vector mask), which the Paths panel lists first. */
  layerPath: { kind: 'shape' | 'mask'; name: string; path: Path } | null;
  /** The smart object whose FILTER mask is the edit target. */
  filterMaskTarget: number | null;
  /** Set while a smart object's contents are open: the documents above them, and whether they changed since saved. */
  editingContents: { path: string[]; dirty: boolean } | null;
  /** Filter ▸ Last Filter's filter, once one has been applied. */
  lastFilter: { id: string; label: string } | null;
  /** What Edit ▸ Fade would fade, while it can ("Gaussian Blur"); null otherwise. */
  fadeName: string | null;
  hasSelection: boolean;
  channels: { id: number; name: string; visible: boolean; indicates: 'masked' | 'selected' }[];
  /** The History panel's rows, oldest first; `historyIndex` is the one in effect. */
  history: { name: string; snapshot: boolean; time: number }[];
  historyIndex: number;
  selectionBounds: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Features in the opened file that we do not model yet (spec 07 §1.3). */
  warnings?: { layer: string; features: string[] }[];
}

export interface EngineStats {
  /** Blend passes issued this frame — one per visible layer (spec 03 §5.2). */
  drawCalls: number;
  /** Tile quads drawn across all source passes. */
  instances: number;
  /** Mip level the viewport is composited from. */
  level: number;
  cpuMs: number;
  fps: number;
  frameMs: number;
  atlasResident: number;
  atlasCapacity: number;
  atlasUploads: number;
  atlasEvictions: number;
  atlasThrash: number;
  atlasPages: number;
  docLayers: number;
  docTiles: number;
  layerPasses: number;
  atlasBytes: number;
  tileBytes: number;
  zoom: number;
  centreX: number;
  centreY: number;
  /** Viewport size in CSS px, so the Navigator can draw what is on screen. */
  viewWidth: number;
  viewHeight: number;
  viewRotation: number;
  /** Most recent input→pixels latency in ms, or null when nothing was painted. */
  lastLatencyMs: number | null;
  /**
   * The live transform, so the options bar's X/Y/W/H/angle fields can follow the handles.
   * It rides on the stats message because it changes every frame while a handle is dragged,
   * which is exactly the cadence stats already have.
   */
  transform: {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
  } | null;
}

export type ToEngine =
  | { t: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number; ring: SharedArrayBuffer; atlasBudgetBytes?: number }
  | { t: 'resize'; width: number; height: number; dpr: number }
  | { t: 'tick' }
  | { t: 'pan'; dx: number; dy: number }
  | { t: 'zoomAt'; factor: number; x: number; y: number }
  | { t: 'setZoom'; zoom: number }
  | { t: 'rotate'; radians: number }
  | { t: 'fit' }
  | { t: 'actualPixels' }
  | { t: 'openBitmap'; bitmap: ImageBitmap; name: string }
  | { t: 'placeBitmap'; bitmap: ImageBitmap; name: string }
  | { t: 'openPsd'; buffer: ArrayBuffer; name: string }
  | { t: 'setLayerVisible'; id: number; visible: boolean }
  | { t: 'setLayerOpacity'; id: number; opacity: number }
  | { t: 'setLayerBlendMode'; id: number; mode: string }
  | { t: 'selectLayer'; id: number }
  | { t: 'toggleGroup'; id: number }
  | { t: 'layerCommand'; command: string; id?: number; ids?: number[]; delta?: number }
  | { t: 'imageCommand'; command: string; width?: number; height?: number; anchor?: string; method?: string; angle?: number; horizontal?: boolean }
  | { t: 'savePsd'; name: string }
  | { t: 'beginSelect'; tool: string; x: number; y: number; op: string }
  | { t: 'updateSelect'; x: number; y: number }
  | { t: 'addSelectPoint'; x: number; y: number }
  | { t: 'endSelect'; x?: number; y?: number }
  | { t: 'cancelSelect' }
  | { t: 'setQuickMask'; on: boolean }
  | { t: 'beginTransform'; transient: boolean; selectionOnly?: boolean }
  | { t: 'transformDragBegin'; x: number; y: number; rotate: boolean }
  | { t: 'transformDragMove'; x: number; y: number; constrain: boolean; fromCentre: boolean }
  | { t: 'transformDragEnd' }
  | { t: 'commitTransform'; method?: string }
  | { t: 'cancelTransform' }
  | { t: 'nudge'; dx: number; dy: number }
  | { t: 'transformAgain' }
  | { t: 'requestThumbnail'; size: number }
  | { t: 'setCentre'; x: number; y: number }
  | { t: 'setLayerLocks'; id: number; locks: Partial<{ transparency: boolean; pixels: boolean; position: boolean; all: boolean }> }
  | { t: 'maskCommand'; command: string; id?: number }
  /** `filter`: the smart object's filter mask rather than its layer mask. */
  | { t: 'setMaskTarget'; id: number; mask: boolean; filter?: boolean }
  | { t: 'previewAdjustment'; adjustment: Adjustment | null }
  | { t: 'applyAdjustment'; adjustment: Adjustment }
  | { t: 'autoAdjust'; mode: 'tone' | 'contrast' | 'color' | 'equalize' }
  | { t: 'addAdjustmentLayer'; adjustment: Adjustment }
  | { t: 'addFillLayer'; content: FillSummary }
  | { t: 'setFillContent'; id: number; content: FillSummary; final: boolean; amend?: boolean }
  | { t: 'requestPatterns' }
  | { t: 'requestLuts' }
  /** Info panel readouts: the pointer (screen coordinates) and the colour samplers (document). */
  | { t: 'probe'; cursor: { x: number; y: number } | null; samplers: { x: number; y: number }[]; tag?: string }
  /** Latest wins: the worker drops superseded previews rather than queueing them. */
  | { t: 'previewSpatial'; adjustment: SpatialAdjustment | null }
  | { t: 'applySpatial'; adjustment: SpatialAdjustment }
  /** Latest wins, like previewSpatial. */
  | { t: 'previewApplyImage'; options: ApplyImageOptions | null }
  | { t: 'applyImage'; options: ApplyImageOptions }
  | { t: 'calculations'; options: CalculationsOptions }
  /** On a smart object the filter becomes a smart filter; `smartIndex` edits an existing one instead. */
  | { t: 'applyFilter'; id: string; params: FilterParams; fg: Rgb3; bg: Rgb3; smartIndex?: number }
  /** Latest wins. `id` null ends the on-canvas preview. */
  | { t: 'previewFilter'; id: string | null; params: FilterParams | null; fg: Rgb3; bg: Rgb3; smartIndex?: number }
  /** The dialog's preview box: a document rectangle, answered with before and after. */
  | { t: 'filterBox'; id: string; params: FilterParams; fg: Rgb3; bg: Rgb3; rect: { x0: number; y0: number; x1: number; y1: number }; seq: number; smartIndex?: number }
  | { t: 'smartCommand'; cmd: SmartCommand }
  /** A layer's style: effects (null clears them) and, from Blending Options, its blending; a changed Global Light rides along. */
  | { t: 'setLayerStyle'; id: number; effects: LayerEffects | null; props?: LayerStyleProps; globalLight?: GlobalLight; name?: string }
  /** Latest wins; effects and props both absent ends the preview. */
  | { t: 'previewLayerStyle'; id: number; effects: LayerEffects | null; props?: LayerStyleProps; globalLight?: GlobalLight }
  | { t: 'styleCommand'; cmd: StyleCommand; amount?: number }
  /** The active vector tool (null: none), and its options-bar settings. */
  | { t: 'setVectorTool'; tool: VectorToolId | ShapeToolId | null; options?: Partial<VectorOptions> }
  | { t: 'setShapeOptions'; options: Partial<ShapeOptions> }
  /** The type tools: their settings (null leaves them, committing any edit). */
  | { t: 'setTypeTool'; options: { mask: boolean; vertical: boolean; style: CharStyle; para: ParaStyle; antiAlias: AntiAlias } | null }
  | { t: 'typePointer'; phase: 'down' | 'move' | 'up'; x: number; y: number; shift: boolean; clicks: number }
  | { t: 'typeInput'; text: string }
  | { t: 'typeKey'; key: string; shift: boolean; ctrl: boolean; alt: boolean }
  | { t: 'typeCommit' }
  | { t: 'typeCancel' }
  /** Copy/Cut in a type session: answered with `typeSelection`; Cut also deletes it. */
  | { t: 'typeCopy'; cut: boolean }
  | { t: 'setTypeStyle'; patch: Partial<CharStyle> }
  | { t: 'setTypePara'; patch: Partial<ParaStyle> }
  | { t: 'typeCommand'; cmd: TypeCommand }
  | { t: 'setTypeWarp'; warp: WarpSpec | null; final: boolean }
  | { t: 'requestFonts' }
  /** The brush library (answered with `brushes`), .abr import/export and edits. */
  | { t: 'requestBrushes' }
  | { t: 'patchPointer'; phase: 'down' | 'move' | 'up'; x: number; y: number; options: PatchOptions }
  | { t: 'contentAwareFill'; sampling: 'auto' | 'rectangular' | 'all'; colorAdaptation: boolean; output: 'current' | 'new' | 'duplicate' }
  | { t: 'redEye'; x: number; y: number; pupilSize: number; darken: number }
  | { t: 'sharpenTip' }
  | { t: 'cafBegin'; options: CafOptions }
  | { t: 'cafOptions'; options: CafOptions }
  | { t: 'cafPaint'; phase: 'down' | 'move' | 'up'; x: number; y: number; size: number; subtract: boolean }
  | { t: 'cafEnd'; commit: boolean }
  | { t: 'importTpl'; bytes: Uint8Array; name: string }
  | { t: 'exportTpl'; presets: ToolPresetExport[]; name: string }
  | { t: 'setCloneOverlay'; overlay: CloneOverlay | null }
  | { t: 'setCloneSource'; x: number; y: number; /** Document coordinates (a Clone Source slot), not screen. */ doc?: boolean }
  | { t: 'magicErase'; x: number; y: number; tolerance: number; contiguous: boolean; antiAlias: boolean; sampleAll: boolean; opacity: number }
  | { t: 'setHistoryBrushSource'; index: number }
  | { t: 'importAbr'; bytes: Uint8Array; name: string }
  | { t: 'exportAbr'; group?: string; ids?: string[]; name: string }
  | { t: 'editBrushLibrary'; op: BrushLibraryOp }
  | { t: 'defineBrush'; name: string }
  /** The Glyphs panel's page of a face's characters (answered with `glyphs`). */
  | { t: 'requestGlyphs'; font: string; from: number; count: number }
  | { t: 'replaceFonts'; map: Record<string, string> }
  | { t: 'addFonts'; buffers: ArrayBuffer[] }
  | { t: 'vectorMaskCommand'; cmd: VectorMaskCommand }
  /** Properties for a shape layer; non-final edits show without a history step. */
  | { t: 'setShape'; id: number; live?: LiveShape; fill?: FillSummary | null; stroke?: ShapeStrokeSummary | null; final: boolean }
  /** Custom shapes: the set (answered with `customShapes`), and a .csh file added to it. */
  | { t: 'requestCustomShapes' }
  | { t: 'defineCustomShape'; name: string }
  | { t: 'combineShapes'; op: 'add' | 'subtract' | 'intersect' | 'exclude' | 'merge' }
  | { t: 'arrangePath'; cmd: PathArrange }
  | { t: 'loadCustomShapes'; buffer: ArrayBuffer }
  | { t: 'vectorPointer'; phase: 'down' | 'move' | 'up'; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; clicks: number }
  | { t: 'vectorKey'; key: string }
  | ({ t: 'pathCommand' } & PathCommand)
  /** The Styles panel's library; each answered with the updated `styles` list. */
  | { t: 'requestStyles' }
  | { t: 'applyStyle'; id: string }
  | { t: 'newStyle'; name: string; effects?: LayerEffects | null }
  | { t: 'deleteStyle'; id: string }
  | { t: 'renameStyle'; id: string; name: string }
  | { t: 'loadAsl'; name: string; bytes: Uint8Array }
  | { t: 'exportAsl'; name: string; ids?: string[] }
  | { t: 'setGlobalLight'; light: GlobalLight }
  | { t: 'editContents' }
  /** Save the open contents into the smart object (every instance), and optionally close them. */
  | { t: 'saveContents' }
  | { t: 'closeContents'; save: boolean }
  /** File ▸ Place Embedded / Open as Smart Object. `bytes` is the original file, kept to embed in a PSD. */
  | { t: 'placeEmbedded'; name: string; bitmap?: ImageBitmap; psd?: ArrayBuffer; bytes?: Uint8Array; type?: string; asDocument?: boolean }
  | { t: 'smartFilterOp'; layerId: number; index: number; op: SmartFilterOp }
  /** Latest wins; null ends the preview. */
  | { t: 'previewSmartBlend'; layerId: number; index: number; blend: { blendMode: BlendMode; opacity: number } | null }
  | { t: 'lastFilter'; fg: Rgb3; bg: Rgb3 }
  | { t: 'fade'; opacity: number; mode: string }
  | { t: 'previewFade'; opacity: number | null; mode: string }
  | { t: 'requestReplaceColorPreview'; color: [number, number, number]; fuzziness: number; size: number }
  /** A .cube or .3dl file the user picked; the reply is the updated `luts` list. */
  | { t: 'loadLut'; fileName: string; bytes: Uint8Array }
  | { t: 'definePattern'; name: string }
  | { t: 'setLayerAdjustment'; id: number; adjustment: Adjustment; final: boolean }
  | { t: 'requestHistogram'; source: 'layer' | 'below' | 'composite'; id?: number }
  | { t: 'layerVia'; cut: boolean }
  | { t: 'reselect' }
  | { t: 'transformLayerFixed'; op: 'rotate180' | 'rotate90cw' | 'rotate90ccw' | 'flipH' | 'flipV' }
  | { t: 'renameLayer'; id: number; name: string }
  | { t: 'clipboard'; op: string }
  | { t: 'saveSelection'; targetId?: number; op?: string; name?: string }
  | { t: 'loadSelection'; channelId: number; op?: string; invert?: boolean }
  | { t: 'channelCommand'; command: string; id?: number; patch?: Record<string, unknown> }
  | { t: 'setChannelView'; view: string | number }
  | { t: 'historyGoto'; index: number }
  | { t: 'historySnapshot'; name?: string }
  | { t: 'historyConfigure'; limit?: number; nonLinear?: boolean }
  | { t: 'toggleLastState' }
  | { t: 'checkRecovery' }
  | { t: 'recover' }
  | { t: 'discardRecovery' }
  | { t: 'beginCrop' }
  | { t: 'setCropRect'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'commitCrop' }
  | { t: 'cancelCrop' }
  | { t: 'cropToSelection' }
  | { t: 'setCropDeletes'; on: boolean }
  | {
      t: 'bucket';
      x: number;
      y: number;
      color: [number, number, number];
      mode: string;
      opacity: number;
    }
  | {
      t: 'gradient';
      gradient: Gradient;
      style: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
      reverse: boolean;
      dither: boolean;
      mode: string;
      opacity: number;
    }
  | { t: 'sample'; x: number; y: number; size: number; toBackground: boolean; pick?: boolean }
  | {
      t: 'fill';
      color: [number, number, number];
      mode: string;
      opacity: number;
      preserveTransparency: boolean;
      clear?: boolean;
    }
  | {
      t: 'stroke';
      color: [number, number, number];
      mode: string;
      opacity: number;
      preserveTransparency: boolean;
      width: number;
      location: string;
    }
  | { t: 'magicWand'; x: number; y: number; op: string }
  | { t: 'selectCommand'; command: string; amount?: number }
  | { t: 'setSelectOptions'; feather?: number; antialias?: boolean; tolerance?: number; contiguous?: boolean }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'synthetic'; layers: number; width: number; height: number }
  | { t: 'newDoc'; width: number; height: number }
  | {
      t: 'strokeBegin';
      brush: BrushParams;
      color: [number, number, number];
      /** The background colour, for Colour Dynamics. */
      bg?: [number, number, number];
      mode: string;
      /** A retouching tool's stroke: the tool and its options. */
      retouch?: { tool: RetouchToolId; options: RetouchOptions };
    }
  | { t: 'strokeEnd' }
  | { t: 'loseContext' }
  | { t: 'runSpikes' }
  | { t: 'runParity' };

export type FromEngine =
  | { t: 'ready'; caps: GpuCaps }
  | { t: 'stats'; stats: EngineStats }
  | { t: 'doc'; doc: DocSummary }
  | { t: 'patterns'; list: PatternSummary[] }
  | { t: 'styles'; list: StylePreset[] }
  | { t: 'customShapes'; list: { id: string; name: string; path: Path }[]; error?: string }
  | { t: 'fonts'; list: { family: string; styles: { style: string; postscript: string }[] }[]; added?: number }
  | { t: 'typeSelection'; text: string }
  | ({ t: 'cafState' } & CafState)
  | { t: 'toolPresets'; presets: ToolPresetImport[]; note?: string }
  | { t: 'brushes'; groups: BrushGroup[]; tips: Record<string, TipBitmap>; defined?: BrushPreset; note?: string }
  | { t: 'glyphs'; font: string; from: number; upem: number; total: number; glyphs: { cp: number; d: string; adv: number }[] }
  | { t: 'filterBox'; seq: number; before: Uint8Array; after: Uint8Array; width: number; height: number; rect: { x0: number; y0: number; x1: number; y1: number } }
  | ({ t: 'probe'; tag?: string } & ProbeReply)
  | { t: 'replaceColorPreview'; pixels: Uint8Array; width: number; height: number }
  | { t: 'luts'; list: { id: string; name: string; size: number }[]; loaded?: string; error?: string }
  | { t: 'histogram'; source: 'layer' | 'below' | 'composite'; r: Uint32Array; g: Uint32Array; b: Uint32Array; lum: Uint32Array }
  | { t: 'contextLost' }
  | { t: 'contextRestored' }
  | { t: 'spikes'; pass: boolean; text: string }
  | { t: 'parity'; pass: boolean; text: string }
  | { t: 'error'; message: string }
  | { t: 'psdSaved'; name: string; buffer: ArrayBuffer }
  | { t: 'sampled'; color: [number, number, number]; toBackground: boolean; pick?: boolean }
  | { t: 'transform'; active: boolean }
  | { t: 'thumbnail'; pixels: Uint8Array; width: number; height: number; docWidth: number; docHeight: number }
  | { t: 'recovery'; name: string; savedAt: number; width: number; height: number }
  | { t: 'noRecovery' };

/** A fill as the UI sees it: patterns by id (their pixels stay in the engine). */
export type FillContentSummary = FillSummary;
