/** Message protocol between the UI thread and the engine worker (spec 03 §2). */
import type { BrushParams } from '@umbra/kernels/brush';
import type { Gradient } from '@umbra/kernels/gradient';
import type { Adjustment } from '@umbra/kernels/adjust';
import type { FillContent } from '@umbra/kernels/fill';
import type { SpatialAdjustment } from '@umbra/kernels/spatial';
import type { ApplyImageOptions, CalculationsOptions } from '@umbra/kernels/applyimage';
import type { FilterParams } from '@umbra/kernels/filters/types';
import type { BlendMode } from '@umbra/core/blend';
import type { SmartCommand, SmartFilterOp } from './engine.js';

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
  kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart';
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

export interface DocSummary {
  name: string;
  width: number;
  height: number;
  /** Flattened for display: top-most first, groups above their children. */
  layers: LayerSummary[];
  activeLayerIds: number[];
  /** The active layer when its MASK is the edit target (always so for adjustment/fill layers). */
  maskTarget: number | null;
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
  | { t: 'setMaskTarget'; id: number; mask: boolean }
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
      mode: string;
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
