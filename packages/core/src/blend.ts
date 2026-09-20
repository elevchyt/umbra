/**
 * Blend mode vocabulary. Formulas live in the engine (GLSL) and kernels (CPU reference);
 * this module only defines the identities, PSD keys and menu grouping.
 * See docs/spec/06-compositing-math.md.
 */

export const BLEND_MODES = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'colorBurn',
  'linearBurn',
  'darkerColor',
  'lighten',
  'screen',
  'colorDodge',
  'linearDodge',
  'lighterColor',
  'overlay',
  'softLight',
  'hardLight',
  'vividLight',
  'linearLight',
  'pinLight',
  'hardMix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'passThrough',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** Four-character PSD blend keys (note the trailing spaces — they are significant). */
export const BLEND_PSD_KEY: Record<BlendMode, string> = {
  normal: 'norm',
  dissolve: 'diss',
  darken: 'dark',
  multiply: 'mul ',
  colorBurn: 'idiv',
  linearBurn: 'lbrn',
  darkerColor: 'dkCl',
  lighten: 'lite',
  screen: 'scrn',
  colorDodge: 'div ',
  linearDodge: 'lddg',
  lighterColor: 'lgCl',
  overlay: 'over',
  softLight: 'sLit',
  hardLight: 'hLit',
  vividLight: 'vLit',
  linearLight: 'lLit',
  pinLight: 'pLit',
  hardMix: 'hMix',
  difference: 'diff',
  exclusion: 'smud',
  subtract: 'fsub',
  divide: 'fdiv',
  hue: 'hue ',
  saturation: 'sat ',
  color: 'colr',
  luminosity: 'lum ',
  passThrough: 'pass',
};

export const BLEND_BY_PSD_KEY: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(BLEND_PSD_KEY).map(([k, v]) => [v, k as BlendMode]),
) as Record<string, BlendMode>;

/** Separators mark where the Layers-panel menu draws a divider. */
export const BLEND_MENU: readonly (BlendMode | '-')[] = [
  'passThrough',
  '-',
  'normal',
  'dissolve',
  '-',
  'darken',
  'multiply',
  'colorBurn',
  'linearBurn',
  'darkerColor',
  '-',
  'lighten',
  'screen',
  'colorDodge',
  'linearDodge',
  'lighterColor',
  '-',
  'overlay',
  'softLight',
  'hardLight',
  'vividLight',
  'linearLight',
  'pinLight',
  'hardMix',
  '-',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  '-',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

export const BLEND_LABEL: Record<BlendMode, string> = {
  normal: 'Normal',
  dissolve: 'Dissolve',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color Burn',
  linearBurn: 'Linear Burn',
  darkerColor: 'Darker Color',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color Dodge',
  linearDodge: 'Linear Dodge (Add)',
  lighterColor: 'Lighter Color',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  hardLight: 'Hard Light',
  vividLight: 'Vivid Light',
  linearLight: 'Linear Light',
  pinLight: 'Pin Light',
  hardMix: 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
  passThrough: 'Pass Through',
};

/**
 * The eight modes where Fill is applied *inside* the blend function rather than as coverage,
 * so Fill 50% differs from Opacity 50%. See spec 06 §3.1 — the neutral colour is what the
 * source is mixed toward as Fill drops to 0.
 */
export const SPECIAL_FILL_MODES: Partial<Record<BlendMode, 'black' | 'white' | 'grey'>> = {
  colorBurn: 'white',
  linearBurn: 'white',
  colorDodge: 'black',
  linearDodge: 'black',
  vividLight: 'grey',
  linearLight: 'grey',
  hardMix: 'grey',
  difference: 'black',
};

/** Non-separable modes operate on the whole pixel, not per channel. */
export const NON_SEPARABLE: ReadonlySet<BlendMode> = new Set<BlendMode>([
  'hue',
  'saturation',
  'color',
  'luminosity',
  'darkerColor',
  'lighterColor',
]);

export function isSpecialFillMode(m: BlendMode): boolean {
  return m in SPECIAL_FILL_MODES;
}
