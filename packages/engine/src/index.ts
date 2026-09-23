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
export {
  DEFAULT_BRUSH,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_SCATTERING,
  DEFAULT_TEXTURE,
  DEFAULT_DUAL,
  DEFAULT_COLOR_DYNAMICS,
  DEFAULT_TRANSFER,
  DEFAULT_POSE,
  DEFAULT_SMOOTHING,
  DEFAULT_SYMMETRY,
  NO_DYNAMIC,
  renderDabs,
  beginStroke as beginBrushStroke,
  strokeTo as brushStrokeTo,
  finishStroke as finishBrushStroke,
  type BrushParams,
  type ControlSource,
  type Dynamic,
  type DualMode,
  type TextureMode,
  type SymmetryMode,
  type TipBitmap,
  type Dab,
  type BrushGroup,
  type BrushPreset,
} from '@umbra/kernels/brush';
export type { BrushLibraryOp } from './engine.js';
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
export {
  DEFAULT_APPLY_IMAGE,
  DEFAULT_CALCULATIONS,
  type ApplyImageOptions,
  type CalculationsOptions,
  type ChannelPick,
  type ApplyBlend,
} from '@umbra/kernels/applyimage';
export { FILTERS, FILTER_BY_ID, GALLERY_EFFECTS, GALLERY_BY_ID, GALLERY_CATEGORIES, DEFAULT_STACK, parseStack, fromRgba8, toRgba8 } from '@umbra/kernels/filters/index';
export { defaultsOf, type FilterDef, type FilterParams, type ParamSpec, type ParamValue, type GalleryEffect, type GalleryLayer, type GalleryCategory } from '@umbra/kernels/filters/types';
export { DEFAULTS as EFFECT_DEFAULTS, EMPTY_EFFECTS, scaleEffects, mapEffectPatterns, DEFAULT_GLOBAL_LIGHT, LINEAR_CONTOUR, hasVisibleEffects, type LayerEffects, type GlobalLight, type Contour, type ShadowEffect, type GlowEffect, type BevelEffect, type SatinEffect, type ColorOverlayEffect, type GradientOverlayEffect, type PatternOverlayEffect, type StrokeEffect, type StrokeFill, type GlowFill } from '@umbra/kernels/effects/types';
export { CONTOUR_PRESETS, contourLut, applyContour } from '@umbra/kernels/effects/contour';
export type { LayerStyleProps, StyleCommand } from './engine.js';
export { renderEffects } from '@umbra/kernels/effects/render';
export { compositePixel } from '@umbra/kernels/blend';
export type { BlendIfRange, AdvancedBlending } from '@umbra/kernels/composite';
export type { StylePreset } from '@umbra/kernels/effects/presets';
export type { PathCommand, VectorMaskCommand } from './engine.js';
export type { VectorToolId, VectorOptions, PathArrange } from './vector-tool.js';
export { DEFAULT_SHAPE_OPTIONS, SHAPE_TOOLS, type ShapeOptions, type ShapeToolId } from './shape-tool.js';
export { rasterizePath } from '@umbra/kernels/vector/raster';
export type { Path } from '@umbra/kernels/vector/path';
export { transformPath, pathBounds } from '@umbra/kernels/vector/path';
export type { TypeCommand } from './engine.js';
export { DEFAULT_CHAR, DEFAULT_PARA, type AntiAlias, type CharStyle, type ParaStyle, type TextSpec } from '@umbra/text/style';
export { WARP_STYLES, type WarpSpec, type WarpStyle } from '@umbra/text/warp';
