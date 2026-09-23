import { defaultAdjustment, type Adjustment } from '@umbra/engine';
import { store } from '../state/store';

/**
 * An adjustment's starting settings: the kernel's no-op defaults, except that Gradient Map
 * starts from the current foreground and background colours, as it does in Photoshop.
 */
export function initialAdjustment(kind: Adjustment['kind']): Adjustment {
  if (kind !== 'gradientMap') return defaultAdjustment(kind);
  const fg = store.foreground();
  const bg = store.background();
  return {
    kind,
    reverse: false,
    gradient: {
      name: 'Foreground to Background',
      colorStops: [
        { at: 0, color: [fg.r, fg.g, fg.b] },
        { at: 1, color: [bg.r, bg.g, bg.b] },
      ],
      opacityStops: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 1 },
      ],
    },
  };
}

/** Icon per kind, shared by the Adjustments panel and adjustment-layer thumbnails. */
export const ADJUSTMENT_ICON: Record<Adjustment['kind'], string> = {
  brightnessContrast: 'adjBrightnessContrast',
  levels: 'adjLevels',
  curves: 'adjCurves',
  exposure: 'adjExposure',
  vibrance: 'adjVibrance',
  hueSaturation: 'adjHueSaturation',
  colorBalance: 'adjColorBalance',
  blackWhite: 'adjBlackWhite',
  photoFilter: 'adjPhotoFilter',
  channelMixer: 'adjChannelMixer',
  invert: 'adjInvert',
  posterize: 'adjPosterize',
  threshold: 'adjThreshold',
  gradientMap: 'adjGradientMap',
  desaturate: 'adjDesaturate',
  selectiveColor: 'adjSelectiveColor',
  colorLookup: 'adjColorLookup',
};
