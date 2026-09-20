import { describe, expect, it } from 'vitest';
import {
  applyToRgb,
  applyToRgba8,
  brightnessContrastLut,
  compile,
  defaultAdjustment,
  exposureLut,
  hslToRgb,
  isNoOp,
  luminance,
  posterizeLut,
  rgbToHsl,
  type Adjustment,
} from './adjust.js';

/** Every adjustment at its default parameters must leave a pixel alone. */
const KINDS: Adjustment['kind'][] = [
  'brightnessContrast',
  'levels',
  'curves',
  'exposure',
  'invert',
  'posterize',
  'threshold',
  'desaturate',
  'channelMixer',
  'hueSaturation',
  'vibrance',
  'colorBalance',
  'blackWhite',
  'photoFilter',
  'gradientMap',
];

describe('identity parameters', () => {
  // Invert, posterize, threshold, desaturate, blackWhite and gradientMap change the image by
  // definition; the rest must be no-ops until a slider moves.
  const NEUTRAL = new Set<Adjustment['kind']>([
    'brightnessContrast',
    'levels',
    'curves',
    'exposure',
    'channelMixer',
    'hueSaturation',
    'vibrance',
    'colorBalance',
  ]);

  for (const kind of KINDS) {
    if (!NEUTRAL.has(kind)) continue;
    it(`${kind} at defaults leaves pixels unchanged`, () => {
      for (const px of [
        [0, 0, 0],
        [255, 255, 255],
        [128, 64, 200],
        [12, 200, 33],
      ] as const) {
        const out = applyToRgb(defaultAdjustment(kind), px[0], px[1], px[2]);
        expect(out[0]).toBeCloseTo(px[0], -0.5);
        expect(out[1]).toBeCloseTo(px[1], -0.5);
        expect(out[2]).toBeCloseTo(px[2], -0.5);
      }
    });
  }

  it('levels and curves compile to a table that reports itself as a no-op', () => {
    expect(isNoOp(compile(defaultAdjustment('levels')))).toBe(true);
    expect(isNoOp(compile(defaultAdjustment('curves')))).toBe(true);
  });
});

describe('brightness/contrast (legacy is exact)', () => {
  it('matches its published formula at every level', () => {
    for (const [brightness, contrast] of [
      [0, 0],
      [40, 0],
      [-40, 0],
      [0, 50],
      [0, -30],
      [25, 75],
    ] as const) {
      const lut = brightnessContrastLut(brightness, contrast, true);
      const k = contrast > 0 ? 100 / (100 - contrast) : (100 + contrast) / 100;
      for (let v = 0; v < 256; v++) {
        const expected = Math.min(255, Math.max(0, Math.round(127.5 + (v + brightness - 127.5) * k)));
        expect(lut[v]).toBe(expected);
      }
    }
  });

  it('legacy contrast pivots about 127.5, not 128', () => {
    const lut = brightnessContrastLut(0, 50, true);
    // The two levels straddling the pivot move outward by the same amount.
    expect(lut[127]).toBe(127);
    expect(lut[128]).toBe(129);
    expect(lut[200]!).toBeGreaterThan(200);
    expect(lut[56]!).toBeLessThan(56);
  });

  it('modern mode does not clip at full contrast, where legacy does', () => {
    const modern = brightnessContrastLut(0, 100, false);
    const legacy = brightnessContrastLut(0, 100, true);
    // Legacy at +100 leaves two levels; the modern curve must keep the tones apart.
    expect(new Set(legacy).size).toBeLessThanOrEqual(3);
    expect(new Set(modern).size).toBeGreaterThan(100);
  });

  it('modern mode is always monotone', () => {
    for (const [b, c] of [
      [150, 100],
      [-150, -50],
      [75, -20],
      [0, 0],
    ] as const) {
      const lut = brightnessContrastLut(b, c, false);
      for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
    }
  });

  it('modern brightness alone pins black and white', () => {
    // Brightness is a gamma, so it lifts the midtones without moving the endpoints. Reducing
    // CONTRAST does move them, by design — that is what less contrast means.
    for (const b of [150, -150, 75]) {
      const lut = brightnessContrastLut(b, 0, false);
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
    }
    expect(brightnessContrastLut(0, -50, false)[0]!).toBeGreaterThan(0);
  });
});

describe('exposure', () => {
  it('matches its published formula', () => {
    const [E, O, G] = [1.5, 0.05, 1.2];
    const lut = exposureLut(E, O, G);
    for (let v = 0; v < 256; v++) {
      const lin = Math.max(0, Math.pow(v / 255, 2.2) * Math.pow(2, E) + O);
      const expected = Math.min(255, Math.max(0, Math.round(Math.pow(Math.pow(lin, 1 / 2.2), 1 / G) * 255)));
      expect(lut[v]).toBe(expected);
    }
  });

  it('one stop up roughly doubles the linear value', () => {
    const lut = exposureLut(1, 0, 1);
    const linIn = Math.pow(100 / 255, 2.2);
    const linOut = Math.pow(lut[100]! / 255, 2.2);
    expect(linOut / linIn).toBeCloseTo(2, 1);
  });
});

describe('posterize', () => {
  it('matches its published formula', () => {
    for (const n of [2, 4, 7, 32]) {
      const lut = posterizeLut(n);
      for (let v = 0; v < 256; v++) {
        expect(lut[v]).toBe(Math.round((Math.floor((v * n) / 256) * 255) / (n - 1)));
      }
    }
  });

  it('produces exactly n distinct levels', () => {
    for (const n of [2, 3, 8]) expect(new Set(posterizeLut(n)).size).toBe(n);
  });

  it('keeps black and white', () => {
    const lut = posterizeLut(5);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });
});

describe('invert and threshold', () => {
  it('invert is 255 − v', () => {
    expect(applyToRgb({ kind: 'invert' }, 10, 128, 255)).toEqual([245, 127, 0]);
  });

  it('invert twice is the original', () => {
    const once = applyToRgb({ kind: 'invert' }, 10, 128, 255);
    expect(applyToRgb({ kind: 'invert' }, once[0], once[1], once[2])).toEqual([10, 128, 255]);
  });

  it('threshold splits on luminance, not on the channels', () => {
    // Pure green is bright by luminance; pure blue is not.
    expect(applyToRgb({ kind: 'threshold', level: 128 }, 0, 255, 0)).toEqual([255, 255, 255]);
    expect(applyToRgb({ kind: 'threshold', level: 128 }, 0, 0, 255)).toEqual([0, 0, 0]);
  });
});

describe('desaturate', () => {
  it('uses HSL lightness, not luminance', () => {
    // (max+min)/2 of pure red is 127.5; its luminance would be 76.
    const [r, g, b] = applyToRgb({ kind: 'desaturate' }, 255, 0, 0);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });

  it('leaves a neutral alone', () => {
    expect(applyToRgb({ kind: 'desaturate' }, 90, 90, 90)).toEqual([90, 90, 90]);
  });
});

describe('channel mixer', () => {
  it('swaps channels exactly', () => {
    const adj: Adjustment = {
      kind: 'channelMixer',
      r: { r: 0, g: 0, b: 100, constant: 0 },
      g: { r: 0, g: 100, b: 0, constant: 0 },
      b: { r: 100, g: 0, b: 0, constant: 0 },
      monochrome: false,
    };
    expect(applyToRgb(adj, 10, 20, 30)).toEqual([30, 20, 10]);
  });

  it('applies the constant', () => {
    const adj: Adjustment = {
      kind: 'channelMixer',
      r: { r: 100, g: 0, b: 0, constant: 20 },
      g: { r: 0, g: 100, b: 0, constant: 0 },
      b: { r: 0, g: 0, b: 100, constant: 0 },
      monochrome: false,
    };
    expect(applyToRgb(adj, 100, 100, 100)[0]).toBe(Math.round(100 + 0.2 * 255));
  });

  it('monochrome drives all three outputs from one row', () => {
    const adj: Adjustment = {
      kind: 'channelMixer',
      r: { r: 100, g: 0, b: 0, constant: 0 },
      g: { r: 0, g: 100, b: 0, constant: 0 },
      b: { r: 0, g: 0, b: 100, constant: 0 },
      monochrome: true,
    };
    const [r, g, b] = applyToRgb(adj, 200, 50, 10);
    expect(r).toBe(200);
    expect(g).toBe(200);
    expect(b).toBe(200);
  });
});

describe('HSL round trip', () => {
  it('survives a round trip for saturated and neutral colours', () => {
    for (const px of [
      [1, 0, 0],
      [0.2, 0.7, 0.3],
      [0.5, 0.5, 0.5],
      [0, 0, 0],
      [1, 1, 1],
    ] as const) {
      const [h, s, l] = rgbToHsl(px[0], px[1], px[2]);
      const back = hslToRgb(h, s, l);
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(px[i]!, 6);
    }
  });
});

describe('hue/saturation', () => {
  const base = defaultAdjustment('hueSaturation') as Extract<Adjustment, { kind: 'hueSaturation' }>;

  it('a 120° hue shift walks red to green', () => {
    const [r, g, b] = applyToRgb({ ...base, master: { hue: 120, saturation: 0, lightness: 0 } }, 255, 0, 0);
    expect(g).toBeGreaterThan(240);
    expect(r).toBeLessThan(15);
    expect(b).toBeLessThan(15);
  });

  it('saturation at −100 is a neutral', () => {
    const [r, g, b] = applyToRgb({ ...base, master: { hue: 0, saturation: -100, lightness: 0 } }, 200, 40, 90);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('lightness at +100 is white and at −100 is black', () => {
    expect(applyToRgb({ ...base, master: { hue: 0, saturation: 0, lightness: 100 } }, 120, 60, 30)).toEqual([255, 255, 255]);
    expect(applyToRgb({ ...base, master: { hue: 0, saturation: 0, lightness: -100 } }, 120, 60, 30)).toEqual([0, 0, 0]);
  });

  it('colorize replaces hue while keeping lightness order', () => {
    const adj = { ...base, colorize: true, colorizeHue: 210, colorizeSaturation: 50 };
    const dark = applyToRgb(adj, 40, 40, 40);
    const light = applyToRgb(adj, 200, 200, 200);
    expect(light[2]).toBeGreaterThan(dark[2]!);
    // A blue-ish tint: blue leads.
    expect(light[2]).toBeGreaterThan(light[0]!);
  });
});

describe('vibrance', () => {
  it('lifts a dull colour more than an already saturated one', () => {
    const adj: Adjustment = { kind: 'vibrance', vibrance: 100, saturation: 0 };
    const dullBefore = rgbToHsl(0.5, 0.45, 0.4)[1];
    const dullAfter = rgbToHsl(...(applyToRgb(adj, 128, 115, 102).map((v) => v / 255) as [number, number, number]))[1];
    const vividBefore = rgbToHsl(1, 0.05, 0.05)[1];
    const vividAfter = rgbToHsl(...(applyToRgb(adj, 255, 13, 13).map((v) => v / 255) as [number, number, number]))[1];
    expect(dullAfter - dullBefore).toBeGreaterThan(vividAfter - vividBefore);
  });

  it('leaves a neutral neutral — it has no hue to boost', () => {
    expect(applyToRgb({ kind: 'vibrance', vibrance: 100, saturation: 0 }, 128, 128, 128)).toEqual([128, 128, 128]);
  });
});

describe('colour balance', () => {
  const base = defaultAdjustment('colorBalance') as Extract<Adjustment, { kind: 'colorBalance' }>;

  it('pushes midtones toward red without changing luminance', () => {
    const before = luminance(0.5, 0.5, 0.5);
    const [r, g, b] = applyToRgb(
      { ...base, midtones: { cyanRed: 50, magentaGreen: 0, yellowBlue: 0 } },
      128,
      128,
      128,
    );
    expect(r).toBeGreaterThan(128);
    expect(luminance(r / 255, g / 255, b / 255)).toBeCloseTo(before, 2);
  });

  it('a shadows-only shift leaves the highlights alone', () => {
    const adj = { ...base, shadows: { cyanRed: 100, magentaGreen: 0, yellowBlue: 0 } };
    const shadow = applyToRgb(adj, 30, 30, 30);
    const highlight = applyToRgb(adj, 240, 240, 240);
    expect(shadow[0]! - shadow[2]!).toBeGreaterThan(highlight[0]! - highlight[2]!);
  });
});

describe('black & white', () => {
  it('produces a neutral', () => {
    const [r, g, b] = applyToRgb(defaultAdjustment('blackWhite'), 200, 40, 90);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('the red slider moves reds and leaves blues alone', () => {
    const base = defaultAdjustment('blackWhite') as Extract<Adjustment, { kind: 'blackWhite' }>;
    const redUp = { ...base, reds: 200 };
    expect(applyToRgb(redUp, 255, 0, 0)[0]).toBeGreaterThan(applyToRgb(base, 255, 0, 0)[0]!);
    expect(applyToRgb(redUp, 0, 0, 255)[0]).toBe(applyToRgb(base, 0, 0, 255)[0]);
  });

  it('tint produces a coloured result rather than a grey', () => {
    const base = defaultAdjustment('blackWhite') as Extract<Adjustment, { kind: 'blackWhite' }>;
    const [r, g, b] = applyToRgb({ ...base, tint: [1, 0.8, 0.5] }, 128, 128, 128);
    expect(r).toBeGreaterThan(b);
  });
});

describe('photo filter', () => {
  it('warms an image and holds its luminance', () => {
    const before = luminance(0.5, 0.5, 0.5);
    const [r, g, b] = applyToRgb(defaultAdjustment('photoFilter'), 128, 128, 128);
    expect(r).toBeGreaterThan(b);
    expect(luminance(r / 255, g / 255, b / 255)).toBeCloseTo(before, 2);
  });

  it('density zero changes nothing', () => {
    const base = defaultAdjustment('photoFilter') as Extract<Adjustment, { kind: 'photoFilter' }>;
    expect(applyToRgb({ ...base, density: 0 }, 128, 64, 32)).toEqual([128, 64, 32]);
  });
});

describe('gradient map', () => {
  const base = defaultAdjustment('gradientMap') as Extract<Adjustment, { kind: 'gradientMap' }>;

  it('maps luminance onto the ramp', () => {
    expect(applyToRgb(base, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(applyToRgb(base, 255, 255, 255)).toEqual([255, 255, 255]);
  });

  it('reverse flips the ramp', () => {
    expect(applyToRgb({ ...base, reverse: true }, 0, 0, 0)).toEqual([255, 255, 255]);
  });

  it('ignores hue, using only luminance', () => {
    // Two colours with the same luminance map to the same output.
    const a = applyToRgb(base, 255, 0, 0);
    const b = applyToRgb(base, 0, Math.round((0.3 * 255) / 0.59), 0);
    expect(Math.abs(a[0]! - b[0]!)).toBeLessThanOrEqual(1);
  });
});

describe('applying over pixels', () => {
  it('skips fully transparent pixels', () => {
    const data = new Uint8Array([10, 20, 30, 0, 10, 20, 30, 255]);
    applyToRgba8(compile({ kind: 'invert' }), data);
    expect([...data.slice(0, 4)]).toEqual([10, 20, 30, 0]);
    expect([...data.slice(4, 8)]).toEqual([245, 235, 225, 255]);
  });

  it('blends by mask coverage', () => {
    const data = new Uint8Array([0, 0, 0, 255]);
    applyToRgba8(compile({ kind: 'invert' }), data, new Uint8Array([128]));
    expect(data[0]).toBe(128);
  });

  it('a zero mask leaves everything alone', () => {
    const data = new Uint8Array([10, 20, 30, 255]);
    applyToRgba8(compile({ kind: 'invert' }), data, new Uint8Array([0]));
    expect([...data]).toEqual([10, 20, 30, 255]);
  });

  it('pixel-shaped adjustments honour coverage too', () => {
    const data = new Uint8Array([255, 0, 0, 255]);
    applyToRgba8(compile({ kind: 'desaturate' }), data, new Uint8Array([128]));
    // Coverage is 128/255, not exactly a half, and desaturating pure red gives 127.5.
    expect(data[0]).toBe(191);
  });
});
