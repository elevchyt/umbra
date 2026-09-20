/** Message protocol between the UI thread and the engine worker (spec 03 §2). */
import type { GpuCaps } from './gpu/caps.js';


export interface LayerSummary {
  id: number;
  name: string;
  kind: 'pixel' | 'group';
  /** Indentation level in the Layers panel. */
  depth: number;
  opacity: number;
  fill: number;
  blendMode: string;
  visible: boolean;
  clipped: boolean;
  hasMask: boolean;
  expanded: boolean;
  tiles: number;
}

export interface DocSummary {
  name: string;
  width: number;
  height: number;
  /** Flattened for display: top-most first, groups above their children. */
  layers: LayerSummary[];
  activeLayerIds: number[];
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
  /** Most recent input→pixels latency in ms, or null when nothing was painted. */
  lastLatencyMs: number | null;
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
  | { t: 'openPsd'; buffer: ArrayBuffer; name: string }
  | { t: 'setLayerVisible'; id: number; visible: boolean }
  | { t: 'setLayerOpacity'; id: number; opacity: number }
  | { t: 'setLayerBlendMode'; id: number; mode: string }
  | { t: 'selectLayer'; id: number }
  | { t: 'toggleGroup'; id: number }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'synthetic'; layers: number; width: number; height: number }
  | { t: 'newDoc'; width: number; height: number }
  | { t: 'strokeBegin'; size: number; hardness: number; color: [number, number, number, number] }
  | { t: 'strokeEnd' }
  | { t: 'loseContext' }
  | { t: 'runSpikes' }
  | { t: 'runParity' };

export type FromEngine =
  | { t: 'ready'; caps: GpuCaps }
  | { t: 'stats'; stats: EngineStats }
  | { t: 'doc'; doc: DocSummary }
  | { t: 'contextLost' }
  | { t: 'contextRestored' }
  | { t: 'spikes'; pass: boolean; text: string }
  | { t: 'parity'; pass: boolean; text: string }
  | { t: 'error'; message: string };
