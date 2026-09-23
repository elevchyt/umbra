/**
 * Built-in adjustment presets — the Preset menu at the top of the dialogs and of Properties.
 * The names describe what each does; the values are Umbra's own.
 */
import { defaultAdjustment, defaultHueBands, type Adjustment } from '@umbra/engine';

type Of<K extends Adjustment['kind']> = Extract<Adjustment, { kind: K }>;
const P = (x: number, y: number) => ({ x: x / 255, y: y / 255 });
const line = [P(0, 0), P(255, 255)];

function curves(master: ReturnType<typeof P>[], r = line, g = line, b = line): Of<'curves'> {
  return { kind: 'curves', master, r, g, b };
}
function levels(inBlack: number, gamma: number, inWhite: number, outBlack = 0, outWhite = 255): Of<'levels'> {
  const d = defaultAdjustment('levels') as Of<'levels'>;
  return { ...d, master: { inBlack, gamma, inWhite, outBlack, outWhite } };
}
function bw(reds: number, yellows: number, greens: number, cyans: number, blues: number, magentas: number): Of<'blackWhite'> {
  return { kind: 'blackWhite', reds, yellows, greens, cyans, blues, magentas, tint: null };
}
function hs(patch: Partial<Of<'hueSaturation'>>): Of<'hueSaturation'> {
  return { ...(defaultAdjustment('hueSaturation') as Of<'hueSaturation'>), ...patch };
}
const mixer = (r: [number, number, number], g: [number, number, number], b: [number, number, number], monochrome = false): Of<'channelMixer'> => ({
  kind: 'channelMixer',
  r: { r: r[0], g: r[1], b: r[2], constant: 0 },
  g: { r: g[0], g: g[1], b: g[2], constant: 0 },
  b: { r: b[0], g: b[1], b: b[2], constant: 0 },
  monochrome,
});

export const PRESETS: Partial<Record<Adjustment['kind'], { name: string; value: Adjustment }[]>> = {
  curves: [
    { name: 'Cross Process', value: curves(line, [P(0, 0), P(64, 44), P(191, 214), P(255, 255)], [P(0, 0), P(64, 56), P(191, 202), P(255, 255)], [P(0, 38), P(255, 214)]) },
    { name: 'Darker', value: curves([P(0, 0), P(128, 100), P(255, 255)]) },
    { name: 'Increase Contrast', value: curves([P(0, 0), P(64, 52), P(191, 204), P(255, 255)]) },
    { name: 'Lighter', value: curves([P(0, 0), P(128, 156), P(255, 255)]) },
    { name: 'Linear Contrast', value: curves([P(0, 0), P(32, 16), P(223, 239), P(255, 255)]) },
    { name: 'Medium Contrast', value: curves([P(0, 0), P(64, 48), P(191, 208), P(255, 255)]) },
    { name: 'Negative', value: curves([P(0, 255), P(255, 0)]) },
    { name: 'Strong Contrast', value: curves([P(0, 0), P(64, 38), P(191, 218), P(255, 255)]) },
  ],
  levels: [
    { name: 'Darker', value: levels(15, 1, 255) },
    { name: 'Increase Contrast 1', value: levels(10, 1, 245) },
    { name: 'Increase Contrast 2', value: levels(20, 1, 235) },
    { name: 'Increase Contrast 3', value: levels(30, 1, 225) },
    { name: 'Lighten Shadows', value: levels(0, 1.6, 255) },
    { name: 'Lighter', value: levels(0, 1, 230) },
    { name: 'Midtones Brighter', value: levels(0, 1.25, 255) },
    { name: 'Midtones Darker', value: levels(0, 0.8, 255) },
  ],
  exposure: [
    { name: 'Minus 1.0', value: { kind: 'exposure', exposure: -1, offset: 0, gamma: 1 } },
    { name: 'Minus 2.0', value: { kind: 'exposure', exposure: -2, offset: 0, gamma: 1 } },
    { name: 'Plus 1.0', value: { kind: 'exposure', exposure: 1, offset: 0, gamma: 1 } },
    { name: 'Plus 2.0', value: { kind: 'exposure', exposure: 2, offset: 0, gamma: 1 } },
  ],
  blackWhite: [
    { name: 'Blue Filter', value: bw(0, 0, 60, 120, 100, 90) },
    { name: 'Green Filter', value: bw(40, 120, 150, 70, 10, 50) },
    { name: 'High Contrast Blue Filter', value: bw(-50, -40, 30, 140, 170, 90) },
    { name: 'High Contrast Red Filter', value: bw(120, 120, -10, -50, -50, 120) },
    { name: 'Infrared', value: bw(-40, 235, 144, -68, -3, -107) },
    { name: 'Maximum Black', value: bw(0, 0, 0, 0, 0, 0) },
    { name: 'Maximum White', value: bw(100, 100, 100, 100, 100, 100) },
    { name: 'Neutral Density', value: bw(28, 31, 21, 24, 7, 38) },
    { name: 'Red Filter', value: bw(120, 110, -10, -50, -50, 120) },
    { name: 'Yellow Filter', value: bw(120, 110, 40, -30, 0, 70) },
  ],
  hueSaturation: [
    { name: 'Cyanotype', value: hs({ colorize: true, colorizeHue: 200, colorizeSaturation: 30, colorizeLightness: 0 }) },
    { name: 'Increase Saturation', value: hs({ master: { hue: 0, saturation: 20, lightness: 0 } }) },
    { name: 'Old Style', value: hs({ master: { hue: 0, saturation: -60, lightness: 0 } }) },
    {
      name: 'Red Boost',
      value: hs({ bands: { ...defaultHueBands(), reds: { ...defaultHueBands().reds, saturation: 30 } } }),
    },
    { name: 'Sepia', value: hs({ colorize: true, colorizeHue: 35, colorizeSaturation: 25, colorizeLightness: 0 }) },
    { name: 'Strong Saturation', value: hs({ master: { hue: 0, saturation: 50, lightness: 0 } }) },
    {
      name: 'Yellow Boost',
      value: hs({ bands: { ...defaultHueBands(), yellows: { ...defaultHueBands().yellows, saturation: 30 } } }),
    },
  ],
  channelMixer: [
    { name: 'Black & White Infrared', value: mixer([-70, 200, -30], [-70, 200, -30], [-70, 200, -30], true) },
    { name: 'Black & White with Blue Filter', value: mixer([0, 0, 100], [0, 0, 100], [0, 0, 100], true) },
    { name: 'Black & White with Green Filter', value: mixer([0, 100, 0], [0, 100, 0], [0, 100, 0], true) },
    { name: 'Black & White with Orange Filter', value: mixer([50, 50, 0], [50, 50, 0], [50, 50, 0], true) },
    { name: 'Black & White with Red Filter', value: mixer([100, 0, 0], [100, 0, 0], [100, 0, 0], true) },
    { name: 'Black & White with Yellow Filter', value: mixer([34, 66, 0], [34, 66, 0], [34, 66, 0], true) },
    { name: 'Swap Red and Blue', value: mixer([0, 0, 100], [0, 100, 0], [100, 0, 0]) },
    { name: 'Swap Red and Green', value: mixer([0, 100, 0], [100, 0, 0], [0, 0, 100]) },
  ],
};
