export * from './protocol.js';
export * from './document.js';
export * from './history.js';
export * from './tiles/plane.js';
export * from './tiles/mip.js';
export * from './tiles/import.js';
export * from './input/ring.js';
export * from './render/view.js';
export { Engine } from './engine.js';
export { openPsd } from './psd-open.js';
export { toCompositeLayers, toCompositeLayer } from './render/cpu-composite.js';
export { probeCaps, describeCaps, type GpuCaps } from './gpu/caps.js';
// Re-exported so the UI can describe a brush without depending on @umbra/kernels directly:
// the dependency rule is core ← kernels ← engine ← app (spec 03 §3).
export { DEFAULT_BRUSH, type BrushParams } from '@umbra/kernels/brush';
export {
  FOREGROUND_TO_BACKGROUND,
  FOREGROUND_TO_TRANSPARENT,
  sampleGradient,
  type Gradient,
  type GradientStyle,
} from '@umbra/kernels/gradient';
export type { PaintMode } from './commands/fill.js';
export {
  ADJUSTMENT_LABEL,
  DEFAULT_LEVELS,
  applyToRgb,
  defaultAdjustment,
  type Adjustment,
  type ChannelMixerOutput,
  type ColorBalanceBand,
  type HueRange,
  HUE_BANDS,
  defaultHueBands,
  hueBandWeight,
  type HueBand,
  type HueBandName,
  type LevelsChannel,
  SELECTIVE_RANGES,
  type SelectiveRange,
  type CmykShift,
} from '@umbra/kernels/adjust';
export { evaluateCurve, normaliseCurve, type CurvePoint } from '@umbra/kernels/curve';
export { FILL_LABEL, type FillType } from '@umbra/kernels/fill';
export { SPATIAL_LABEL, defaultSpatial, type SpatialAdjustment } from '@umbra/kernels/spatial';
export {
  autoLevelsWith,
  DEFAULT_AUTO_OPTIONS,
  levelsBlackPoint,
  levelsGrayPoint,
  levelsWhitePoint,
  curvesEyedropper,
  levelsToCurves,
  mapToPoints,
  type AutoOptions,
  type AutoAlgorithm,
} from '@umbra/kernels/auto';
