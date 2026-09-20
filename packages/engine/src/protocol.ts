/** Message protocol between the UI thread and the engine worker (spec 03 §2). */
import type { GpuCaps } from './gpu/caps.js';
import type { FrameStats } from './render/renderer.js';

export interface LayerSummary {
  id: number;
  name: string;
  opacity: number;
  visible: boolean;
  tiles: number;
}

export interface DocSummary {
  name: string;
  width: number;
  height: number;
  layers: LayerSummary[];
}

export interface EngineStats extends FrameStats {
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
  | { t: 'synthetic'; layers: number; width: number; height: number }
  | { t: 'newDoc'; width: number; height: number }
  | { t: 'strokeBegin'; size: number; hardness: number; color: [number, number, number, number] }
  | { t: 'strokeEnd' }
  | { t: 'loseContext' }
  | { t: 'runSpikes' };

export type FromEngine =
  | { t: 'ready'; caps: GpuCaps }
  | { t: 'stats'; stats: EngineStats }
  | { t: 'doc'; doc: DocSummary }
  | { t: 'contextLost' }
  | { t: 'contextRestored' }
  | { t: 'spikes'; pass: boolean; text: string }
  | { t: 'error'; message: string };
