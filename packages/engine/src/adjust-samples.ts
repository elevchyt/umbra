import { defaultAdjustment, defaultHueBands, type Adjustment } from '@umbra/kernels/adjust';

/**
 * A non-trivial setting of every adjustment kind, shared by the CPU tests (destructive ≡
 * layer, PSD round trip) and the GPU parity suite, so all three check the same functions.
 */
export const ADJUSTMENT_SAMPLES: Adjustment[] = [
  { kind: 'brightnessContrast', brightness: 40, contrast: 30, legacy: false },
  { kind: 'brightnessContrast', brightness: -30, contrast: 20, legacy: true },
  {
    ...(defaultAdjustment('levels') as Extract<Adjustment, { kind: 'levels' }>),
    master: { inBlack: 20, gamma: 1.4, inWhite: 230, outBlack: 10, outWhite: 245 },
    g: { inBlack: 0, gamma: 0.8, inWhite: 255, outBlack: 0, outWhite: 255 },
  },
  {
    ...(defaultAdjustment('curves') as Extract<Adjustment, { kind: 'curves' }>),
    master: [{ x: 0, y: 0 }, { x: 64 / 255, y: 40 / 255 }, { x: 192 / 255, y: 220 / 255 }, { x: 1, y: 1 }],
  },
  { kind: 'exposure', exposure: 0.8, offset: -0.02, gamma: 1.1 },
  { kind: 'invert' },
  { kind: 'posterize', levels: 5 },
  { kind: 'threshold', level: 120 },
  { kind: 'channelMixer', r: { r: 80, g: 30, b: -10, constant: 5 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 10, g: 10, b: 80, constant: -4 }, monochrome: false },
  { kind: 'hueSaturation', master: { hue: 40, saturation: 30, lightness: -10 }, colorize: false, colorizeHue: 0, colorizeSaturation: 25, colorizeLightness: 0 },
  { kind: 'hueSaturation', master: { hue: 0, saturation: 0, lightness: 0 }, colorize: true, colorizeHue: 200, colorizeSaturation: 50, colorizeLightness: 10 },
  { kind: 'vibrance', vibrance: 60, saturation: -20 },
  { kind: 'colorBalance', shadows: { cyanRed: 20, magentaGreen: 0, yellowBlue: -10 }, midtones: { cyanRed: -30, magentaGreen: 40, yellowBlue: 0 }, highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 25 }, preserveLuminosity: true },
  { kind: 'blackWhite', reds: 60, yellows: 50, greens: 30, cyans: 70, blues: 10, magentas: 90, tint: [0.8, 0.7, 0.5] },
  { kind: 'photoFilter', color: [0.2, 0.4, 0.9], density: 60, preserveLuminosity: false },
  { kind: 'gradientMap', gradient: { colorStops: [{ at: 0, color: [0.1, 0, 0.3] }, { at: 1, color: [1, 0.9, 0.4] }], opacityStops: [{ at: 0, opacity: 1 }, { at: 1, opacity: 1 }] }, reverse: false },
  {
    ...(defaultAdjustment('selectiveColor') as Extract<Adjustment, { kind: 'selectiveColor' }>),
    relative: true,
    ranges: {
      ...(defaultAdjustment('selectiveColor') as Extract<Adjustment, { kind: 'selectiveColor' }>).ranges,
      reds: { c: 40, m: -20, y: 10, k: 15 },
      blues: { c: -30, m: 25, y: 0, k: -10 },
      neutrals: { c: 5, m: 0, y: -15, k: 20 },
      whites: { c: 0, m: 0, y: 30, k: -20 },
      blacks: { c: 0, m: 0, y: 0, k: 40 },
    },
  },
  {
    ...(defaultAdjustment('selectiveColor') as Extract<Adjustment, { kind: 'selectiveColor' }>),
    relative: false,
    ranges: {
      ...(defaultAdjustment('selectiveColor') as Extract<Adjustment, { kind: 'selectiveColor' }>).ranges,
      yellows: { c: 50, m: 20, y: -40, k: 0 },
      greens: { c: -60, m: 30, y: 20, k: 10 },
      magentas: { c: 10, m: -50, y: 0, k: 30 },
    },
  },
  {
    kind: 'hueSaturation',
    master: { hue: 10, saturation: 15, lightness: 0 },
    bands: {
      ...defaultHueBands(),
      reds: { hue: -20, saturation: 40, lightness: 10, range: [315, 345, 15, 45] },
      greens: { hue: 30, saturation: -50, lightness: -20, range: [70, 100, 140, 170] },
      blues: { hue: 0, saturation: 60, lightness: 0, range: [200, 220, 250, 290] },
    },
    colorize: false,
    colorizeHue: 0,
    colorizeSaturation: 25,
    colorizeLightness: 0,
  },
];
