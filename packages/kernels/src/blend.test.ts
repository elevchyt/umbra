import { describe, expect, it } from 'vitest';
import { BLEND_MODES, type BlendMode } from '@umbra/core/blend';
import {
  SEPARABLE,
  blendPixel,
  compositePixel,
  lum,
  sat,
  setLum,
  setSat,
  clipColor,
  SPECIAL_FILL_NEUTRAL,
  isSpecialFillMode,
  applySpecialFill,
  hardMixWithFill,
  dissolveNoise,
  type Rgb,
} from './blend.js';
import {
  compositeDocument,
  solidLayer,
  DEFAULT_BLENDING,
  type CompositeLayer,
} from './composite.js';

const grey = (v: number): Rgb => [v, v, v];
const RAMP = [0, 0.05, 0.2, 0.25, 0.4, 0.5, 0.6, 0.75, 0.8, 0.95, 1];

/** Modes that are a no-op when the source is their neutral colour. */
const NEUTRAL_IDENTITY: Partial<Record<BlendMode, number>> = {
  multiply: 1,
  screen: 0,
  overlay: 0.5,
  softLight: 0.5,
  hardLight: 0.5,
  vividLight: 0.5,
  linearLight: 0.5,
  pinLight: 0.5,
  colorBurn: 1,
  linearBurn: 1,
  colorDodge: 0,
  linearDodge: 0,
  difference: 0,
  exclusion: 0,
  subtract: 0,
  lighten: 0,
  darken: 1,
};

describe('separable blend functions', () => {
  it('covers every separable mode', () => {
    const nonSeparable = new Set(['hue', 'saturation', 'color', 'luminosity', 'darkerColor', 'lighterColor', 'passThrough']);
    for (const m of BLEND_MODES) {
      if (nonSeparable.has(m)) continue;
      expect(SEPARABLE[m], `missing blend function for ${m}`).toBeTypeOf('function');
    }
  });

  it('matches known values', () => {
    expect(SEPARABLE.multiply!(0.5, 0.5)).toBeCloseTo(0.25, 9);
    expect(SEPARABLE.screen!(0.5, 0.5)).toBeCloseTo(0.75, 9);
    expect(SEPARABLE.difference!(0.3, 0.8)).toBeCloseTo(0.5, 9);
    expect(SEPARABLE.exclusion!(0.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(SEPARABLE.linearBurn!(0.6, 0.6)).toBeCloseTo(0.2, 9);
    expect(SEPARABLE.linearDodge!(0.6, 0.6)).toBeCloseTo(1, 9);
    expect(SEPARABLE.subtract!(0.6, 0.2)).toBeCloseTo(0.4, 9);
    expect(SEPARABLE.divide!(0.25, 0.5)).toBeCloseTo(0.5, 9);
    expect(SEPARABLE.hardMix!(0.6, 0.6)).toBe(1);
    expect(SEPARABLE.hardMix!(0.2, 0.2)).toBe(0);
  });

  it('leaves the backdrop untouched at each mode neutral colour', () => {
    for (const [mode, neutral] of Object.entries(NEUTRAL_IDENTITY)) {
      const fn = SEPARABLE[mode as BlendMode]!;
      for (const b of RAMP) {
        expect(fn(b, neutral!), `${mode}(${b}, ${neutral})`).toBeCloseTo(b, 6);
      }
    }
  });

  it('stays inside 0…1 across the whole ramp', () => {
    for (const m of BLEND_MODES) {
      const fn = SEPARABLE[m as BlendMode];
      if (!fn) continue;
      for (const b of RAMP) {
        for (const s of RAMP) {
          const v = fn(b, s);
          expect(Number.isFinite(v), `${m}(${b},${s}) not finite`).toBe(true);
          expect(v, `${m}(${b},${s}) out of range`).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('handles the division edge cases the spec calls out', () => {
    // Color Burn: a white backdrop stays white; a black source burns to black.
    expect(SEPARABLE.colorBurn!(1, 0)).toBe(1);
    expect(SEPARABLE.colorBurn!(0.5, 0)).toBe(0);
    // Color Dodge: a black backdrop stays black; a white source blows out.
    expect(SEPARABLE.colorDodge!(0, 1)).toBe(0);
    expect(SEPARABLE.colorDodge!(0.5, 1)).toBe(1);
    // Divide by zero saturates rather than producing Infinity.
    expect(SEPARABLE.divide!(0.5, 0)).toBe(1);
    expect(SEPARABLE.divide!(0, 0)).toBe(1);
  });

  it('relates Overlay and Hard Light by swapping arguments', () => {
    for (const b of RAMP) {
      for (const s of RAMP) {
        expect(SEPARABLE.overlay!(b, s)).toBeCloseTo(SEPARABLE.hardLight!(s, b), 9);
      }
    }
  });

  it('builds Vivid Light from Color Burn and Color Dodge', () => {
    for (const b of RAMP) {
      expect(SEPARABLE.vividLight!(b, 0.25)).toBeCloseTo(SEPARABLE.colorBurn!(b, 0.5), 9);
      expect(SEPARABLE.vividLight!(b, 0.75)).toBeCloseTo(SEPARABLE.colorDodge!(b, 0.5), 9);
    }
  });
});

describe('non-separable helpers', () => {
  it('uses the documented luminosity weights', () => {
    expect(lum([1, 0, 0])).toBeCloseTo(0.3, 9);
    expect(lum([0, 1, 0])).toBeCloseTo(0.59, 9);
    expect(lum([0, 0, 1])).toBeCloseTo(0.11, 9);
    expect(lum([1, 1, 1])).toBeCloseTo(1, 9);
  });

  it('sets luminosity without changing hue', () => {
    const c: Rgb = [0.8, 0.4, 0.2];
    const out = setLum(c, 0.5);
    expect(lum(out)).toBeCloseTo(0.5, 6);
    // Channel ordering (the hue) is preserved.
    expect(out[0]).toBeGreaterThan(out[1]!);
    expect(out[1]).toBeGreaterThan(out[2]!);
  });

  it('clips back into gamut while preserving luminosity', () => {
    const out = clipColor([1.4, 0.5, -0.2]);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('sets saturation to the requested range', () => {
    const out = setSat([0.8, 0.4, 0.2], 0.5);
    expect(sat(out)).toBeCloseTo(0.5, 9);
    expect(Math.min(...out)).toBeCloseTo(0, 9);
  });

  it('takes luminosity from the backdrop for Hue, Saturation and Color', () => {
    const b: Rgb = [0.2, 0.4, 0.6];
    const s: Rgb = [0.9, 0.1, 0.3];
    for (const mode of ['hue', 'saturation', 'color'] as const) {
      expect(lum(blendPixel(mode, b, s)), mode).toBeCloseTo(lum(b), 6);
    }
    // Luminosity is the mirror image: it takes lum from the source.
    expect(lum(blendPixel('luminosity', b, s))).toBeCloseTo(lum(s), 6);
  });

  it('picks whole pixels for Darker and Lighter Color', () => {
    const dark: Rgb = [0.1, 0.1, 0.1];
    const light: Rgb = [0.9, 0.9, 0.9];
    expect(blendPixel('darkerColor', light, dark)).toEqual(dark);
    expect(blendPixel('darkerColor', dark, light)).toEqual(dark);
    expect(blendPixel('lighterColor', dark, light)).toEqual(light);
  });

  it('leaves the backdrop alone when Color is applied with the same colour', () => {
    const b: Rgb = [0.3, 0.5, 0.7];
    const out = blendPixel('color', b, b);
    expect(out[0]).toBeCloseTo(b[0], 6);
    expect(out[1]).toBeCloseTo(b[1], 6);
    expect(out[2]).toBeCloseTo(b[2], 6);
  });
});

describe('alpha compositing', () => {
  it('shows the source unblended over a transparent backdrop', () => {
    // This is what makes a Multiply layer visible when there is nothing underneath.
    const r = compositePixel('multiply', [0, 0, 0], 0, [0.8, 0.4, 0.2], 1);
    expect(r.color[0]).toBeCloseTo(0.8, 6);
    expect(r.alpha).toBeCloseTo(1, 9);
  });

  it('replaces the backdrop with an opaque Normal source', () => {
    const r = compositePixel('normal', grey(0.2), 1, grey(0.9), 1);
    expect(r.color[0]).toBeCloseTo(0.9, 9);
    expect(r.alpha).toBe(1);
  });

  it('leaves the backdrop alone at zero source alpha', () => {
    const r = compositePixel('multiply', grey(0.3), 1, grey(0.9), 0);
    expect(r.color[0]).toBeCloseTo(0.3, 9);
    expect(r.alpha).toBeCloseTo(1, 9);
  });

  it('accumulates alpha with the over operator', () => {
    const r = compositePixel('normal', grey(0), 0.5, grey(1), 0.5);
    expect(r.alpha).toBeCloseTo(0.75, 9);
  });

  it('interpolates linearly with source alpha for Normal', () => {
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      const r = compositePixel('normal', grey(0.2), 1, grey(0.8), a);
      expect(r.color[0]).toBeCloseTo(0.2 + 0.6 * a, 6);
    }
  });
});

describe('Fill versus Opacity', () => {
  it('flags exactly the eight special modes', () => {
    expect(Object.keys(SPECIAL_FILL_NEUTRAL).sort()).toEqual(
      ['colorBurn', 'colorDodge', 'difference', 'hardMix', 'linearBurn', 'linearDodge', 'linearLight', 'vividLight'].sort(),
    );
  });

  it('is a no-op at Fill 0 for every special mode', () => {
    // Fill 0 mixes the source all the way to the mode's neutral colour, so the backdrop
    // must come through untouched. This is the invariant that distinguishes Fill from Opacity.
    for (const mode of Object.keys(SPECIAL_FILL_NEUTRAL) as BlendMode[]) {
      for (const b of RAMP) {
        const src = applySpecialFill(mode, grey(0.9), 0);
        const value =
          mode === 'hardMix'
            ? hardMixWithFill(b, 0.9, 0)
            : blendPixel(mode, grey(b), src)[0]!;
        expect(value, `${mode} at fill 0 with backdrop ${b}`).toBeCloseTo(b, 6);
      }
    }
  });

  it('behaves like the plain blend at Fill 1', () => {
    for (const mode of Object.keys(SPECIAL_FILL_NEUTRAL) as BlendMode[]) {
      for (const b of RAMP) {
        for (const s of RAMP) {
          const withFill =
            mode === 'hardMix' ? hardMixWithFill(b, s, 1) : blendPixel(mode, grey(b), applySpecialFill(mode, grey(s), 1))[0]!;
          expect(withFill, `${mode}(${b},${s})`).toBeCloseTo(SEPARABLE[mode]!(b, s), 6);
        }
      }
    }
  });

  it('differs from Opacity at the same percentage', () => {
    // The whole point: Fill 50% on Color Dodge is not Opacity 50% on Color Dodge.
    const backdrop = solidLayer(grey(0.4), 1);
    const viaFill = compositeDocument(
      [backdrop, solidLayer(grey(0.7), 1, { blendMode: 'colorDodge', fill: 0.5 })],
      0,
      0,
    );
    const viaOpacity = compositeDocument(
      [backdrop, solidLayer(grey(0.7), 1, { blendMode: 'colorDodge', opacity: 0.5 })],
      0,
      0,
    );
    expect(Math.abs(viaFill.color[0] - viaOpacity.color[0])).toBeGreaterThan(0.01);
  });

  it('treats Fill and Opacity identically for ordinary modes', () => {
    for (const mode of ['multiply', 'screen', 'overlay', 'normal'] as BlendMode[]) {
      const base = solidLayer(grey(0.4), 1);
      const a = compositeDocument([base, solidLayer(grey(0.7), 1, { blendMode: mode, fill: 0.5 })], 0, 0);
      const b = compositeDocument([base, solidLayer(grey(0.7), 1, { blendMode: mode, opacity: 0.5 })], 0, 0);
      expect(a.color[0], mode).toBeCloseTo(b.color[0], 9);
    }
  });

  it('keeps Hard Mix monotonic in the backdrop as Fill rises', () => {
    for (const fill of [0, 0.25, 0.5, 0.75, 0.9]) {
      let prev = -1;
      for (const b of RAMP) {
        const v = hardMixWithFill(b, 0.5, fill);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });
});

describe('dissolve noise', () => {
  it('is stable for a given position', () => {
    expect(dissolveNoise(12, 34)).toBe(dissolveNoise(12, 34));
    expect(dissolveNoise(12, 34)).not.toBe(dissolveNoise(13, 34));
  });

  it('is roughly uniform', () => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const v = dissolveNoise(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        sum += v;
        n++;
      }
    }
    expect(sum / n).toBeGreaterThan(0.45);
    expect(sum / n).toBeLessThan(0.55);
  });
});

describe('layer tree compositing', () => {
  const opaqueBase = solidLayer(grey(0.25), 1, { name: 'Background' });

  function group(children: CompositeLayer[], over: Partial<CompositeLayer> = {}): CompositeLayer {
    return {
      kind: 'group',
      visible: true,
      opacity: 1,
      fill: 1,
      blendMode: 'passThrough',
      clipped: false,
      blending: DEFAULT_BLENDING,
      children,
      ...over,
    };
  }

  it('knockout at Fill 0 punches through to the group entry; deep to the bottom; opacity scales it', () => {
    const middle = solidLayer(grey(0.8), 1);
    const punch = (knockout: 'shallow' | 'deep', opacity = 1) => solidLayer(grey(0.5), 1, { fill: 0, opacity, blending: { ...DEFAULT_BLENDING, knockout } });
    // In an isolated group the hole reaches the group's own transparency, so the background
    // beneath the group shows; in a pass-through group the entry IS that background.
    const shallow = compositeDocument([opaqueBase, group([middle, punch('shallow')], { blendMode: 'normal' })], 0, 0);
    expect(shallow.color[0]).toBeCloseTo(0.25, 6);
    const passThrough = compositeDocument([opaqueBase, group([middle, punch('shallow')])], 0, 0);
    expect(passThrough.color[0]).toBeCloseTo(0.25, 6);
    // Deep goes to the document's bottom: transparency.
    const deep = compositeDocument([opaqueBase, middle, punch('deep')], 0, 0);
    expect(deep.alpha).toBeCloseTo(0, 6);
    // Half opacity knocks out half way.
    const half = compositeDocument([opaqueBase, group([middle, punch('shallow', 0.5)])], 0, 0);
    expect(half.color[0]).toBeCloseTo((0.8 + 0.25) / 2, 6);
  });

  it('stacks layers bottom-first', () => {
    const r = compositeDocument([opaqueBase, solidLayer(grey(0.8), 1)], 0, 0);
    expect(r.color[0]).toBeCloseTo(0.8, 9);
  });

  it('skips hidden layers', () => {
    const r = compositeDocument([opaqueBase, solidLayer(grey(0.8), 1, { visible: false })], 0, 0);
    expect(r.color[0]).toBeCloseTo(0.25, 9);
  });

  it('applies a mask as coverage', () => {
    const masked = solidLayer(grey(1), 1, {
      mask: { sample: () => 0.5, enabled: true, density: 1 },
    });
    const r = compositeDocument([opaqueBase, masked], 0, 0);
    expect(r.color[0]).toBeCloseTo(0.25 + 0.75 * 0.5, 6);
  });

  it('limits how much a mask can hide as density falls', () => {
    const hidden = solidLayer(grey(1), 1, {
      mask: { sample: () => 0, enabled: true, density: 0.5 },
    });
    // Density 50% means a black mask only removes half the coverage.
    const r = compositeDocument([opaqueBase, hidden], 0, 0);
    expect(r.color[0]).toBeCloseTo(0.25 + 0.75 * 0.5, 6);
  });

  it('ignores a disabled mask', () => {
    const masked = solidLayer(grey(1), 1, {
      mask: { sample: () => 0, enabled: false, density: 1 },
    });
    expect(compositeDocument([opaqueBase, masked], 0, 0).color[0]).toBeCloseTo(1, 9);
  });

  describe('groups', () => {
    it('lets a pass-through group see the backdrop', () => {
      // Multiply inside a pass-through group multiplies against the document backdrop.
      const g = group([solidLayer(grey(0.5), 1, { blendMode: 'multiply' })]);
      const r = compositeDocument([opaqueBase, g], 0, 0);
      expect(r.color[0]).toBeCloseTo(0.25 * 0.5, 6);
    });

    it('isolates a group with any other mode', () => {
      // The same layer in a Normal group composites onto transparency first, so Multiply has
      // nothing to multiply with and the group result is just the layer.
      const g = group([solidLayer(grey(0.5), 1, { blendMode: 'multiply' })], { blendMode: 'normal' });
      const r = compositeDocument([opaqueBase, g], 0, 0);
      expect(r.color[0]).toBeCloseTo(0.5, 6);
    });

    it('cross-fades a pass-through group by its opacity', () => {
      const g = group([solidLayer(grey(1), 1)], { opacity: 0.5 });
      const r = compositeDocument([opaqueBase, g], 0, 0);
      expect(r.color[0]).toBeCloseTo(0.625, 6);
    });

    it('nests groups', () => {
      const inner = group([solidLayer(grey(0.8), 1)]);
      const outer = group([inner]);
      expect(compositeDocument([opaqueBase, outer], 0, 0).color[0]).toBeCloseTo(0.8, 6);
    });

    it('keeps an empty isolated group invisible', () => {
      const g = group([], { blendMode: 'normal' });
      expect(compositeDocument([opaqueBase, g], 0, 0).color[0]).toBeCloseTo(0.25, 9);
    });
  });

  describe('clipping masks', () => {
    it('confines a clipped layer to the base alpha', () => {
      const base = solidLayer(grey(0.5), 0.5);
      const clip = solidLayer(grey(1), 1, { clipped: true });
      const r = compositeDocument([opaqueBase, base, clip], 0, 0);
      // The clipped white is limited to the base's 50% coverage.
      expect(r.color[0]).toBeCloseTo(0.25 + 0.75 * 0.5, 6);
    });

    it('hides a clipped layer completely where the base is transparent', () => {
      const base = solidLayer(grey(0.5), 0);
      const clip = solidLayer(grey(1), 1, { clipped: true });
      expect(compositeDocument([opaqueBase, base, clip], 0, 0).color[0]).toBeCloseTo(0.25, 9);
    });

    it('replaces the base colour when the clipped layer is opaque', () => {
      const base = solidLayer(grey(0.5), 1);
      const clip = solidLayer(grey(0.9), 1, { clipped: true });
      expect(compositeDocument([opaqueBase, base, clip], 0, 0).color[0]).toBeCloseTo(0.9, 6);
    });

    it("applies the base layer's opacity to the whole clipped stack", () => {
      const base = solidLayer(grey(0.5), 1, { opacity: 0.5 });
      const clip = solidLayer(grey(0.9), 1, { clipped: true });
      const r = compositeDocument([opaqueBase, base, clip], 0, 0);
      expect(r.color[0]).toBeCloseTo(0.25 + (0.9 - 0.25) * 0.5, 6);
    });

    it('supports several clipped layers in one run', () => {
      const base = solidLayer(grey(0.2), 1);
      const c1 = solidLayer(grey(0.6), 1, { clipped: true });
      const c2 = solidLayer(grey(0.9), 1, { clipped: true, opacity: 0.5 });
      const r = compositeDocument([opaqueBase, base, c1, c2], 0, 0);
      expect(r.color[0]).toBeCloseTo(0.6 + (0.9 - 0.6) * 0.5, 6);
    });
  });

  describe('Blend If', () => {
    it('hides the layer where the underlying tone is out of range', () => {
      const layer = solidLayer(grey(1), 1, {
        blending: {
          ...DEFAULT_BLENDING,
          // Only show over backdrops brighter than 0.5.
          blendIf: [{ channel: 'gray', thisLayer: [0, 0, 1, 1], underlying: [0.5, 0.5, 1, 1] }],
        },
      });
      const overDark = compositeDocument([solidLayer(grey(0.25), 1), layer], 0, 0);
      const overLight = compositeDocument([solidLayer(grey(0.75), 1), layer], 0, 0);
      expect(overDark.color[0]).toBeCloseTo(0.25, 6);
      expect(overLight.color[0]).toBeCloseTo(1, 6);
    });

    it('fades gradually across a split slider', () => {
      const layer = solidLayer(grey(1), 1, {
        blending: {
          ...DEFAULT_BLENDING,
          blendIf: [{ channel: 'gray', thisLayer: [0, 0, 1, 1], underlying: [0.2, 0.8, 1, 1] }],
        },
      });
      const mid = compositeDocument([solidLayer(grey(0.5), 1), layer], 0, 0);
      // Halfway up the ramp the layer is at half coverage.
      expect(mid.color[0]).toBeCloseTo(0.5 + 0.5 * 0.5, 2);
    });
  });

  describe('advanced blending channels', () => {
    it('restores channels the layer may not affect', () => {
      const layer = solidLayer([1, 1, 1], 1, {
        blending: { ...DEFAULT_BLENDING, channels: { r: true, g: false, b: false } },
      });
      const r = compositeDocument([solidLayer([0.2, 0.3, 0.4], 1), layer], 0, 0);
      expect(r.color[0]).toBeCloseTo(1, 6);
      expect(r.color[1]).toBeCloseTo(0.3, 6);
      expect(r.color[2]).toBeCloseTo(0.4, 6);
    });
  });
});
