import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '@umbra/core/pixels';
import { builtinPatterns } from '@umbra/kernels/fill';
import { CONTOUR_PRESETS } from '@umbra/kernels/effects/contour';
import { DEFAULTS, EMPTY_EFFECTS, type LayerEffects } from '@umbra/kernels/effects/types';
import { Plane } from './tiles/plane.js';
import { RGBA8 } from './tiles/import.js';
import { DEFAULT_BLENDING_STATE, emptyDoc, makePixelLayer, type Doc } from './document.js';
import { savePsd } from './psd-save.js';
import { openPsd } from './psd-open.js';
import { effectsFromPsd, effectsToPsd } from './psd-effects.js';

function square(): Plane {
  const w = Plane.empty(RGBA8).writer();
  for (let y = 10; y < 40; y++) for (let x = 10; x < 50; x++) w.mutable(0, 0).set([200, 60, 60, 255], (y * TILE_SIZE + x) * 4);
  return w.commit();
}

const pattern = builtinPatterns()[2]!;

/** Every effect, every one off its defaults. */
function everything(): LayerEffects {
  return {
    ...EMPTY_EFFECTS,
    dropShadow: [
      { ...DEFAULTS.dropShadow(), blendMode: 'overlay', color: [0.2, 0.4, 0.6], opacity: 0.5, useGlobalLight: false, angle: 45, distance: 12, spread: 20, size: 9, contour: CONTOUR_PRESETS[1]!, antiAlias: true, noise: 10, knockout: false },
      { ...DEFAULTS.dropShadow(), distance: 3 },
    ],
    innerShadow: [{ ...DEFAULTS.innerShadow(), opacity: 0.6, distance: 4, spread: 30, size: 7, angle: 120 }],
    outerGlow: { ...DEFAULTS.outerGlow(), opacity: 0.8, noise: 5, spread: 10, size: 15, range: 70, jitter: 20, fill: { type: 'color', color: [0, 1, 0] } },
    innerGlow: { ...DEFAULTS.innerGlow(), source: 'center', technique: 'precise', spread: 15, size: 6 },
    bevel: { ...DEFAULTS.bevel(), style: 'emboss', technique: 'chiselSoft', depth: 250, direction: 'down', size: 11, soften: 3, useGlobalLight: false, angle: 60, altitude: 45, highlightMode: 'colorDodge', highlightColor: [1, 1, 0.5], highlightOpacity: 0.6, shadowMode: 'darken', shadowColor: [0.2, 0, 0.4], shadowOpacity: 0.4 },
    satin: { ...DEFAULTS.satin(), distance: 8, size: 10, angle: 30, invert: false, color: [0.5, 0, 0] },
    colorOverlay: [{ ...DEFAULTS.colorOverlay(), color: [0, 0, 1], opacity: 0.4, blendMode: 'multiply' }],
    gradientOverlay: [{ ...DEFAULTS.gradientOverlay([1, 0, 0], [0, 0, 1]), style: 'radial', angle: 30, scale: 80, reverse: true, align: false, offset: { x: 10, y: -5 }, opacity: 0.7 }],
    patternOverlay: { ...DEFAULTS.patternOverlay(pattern), scale: 150, opacity: 0.5, phase: { x: 3, y: 4 }, link: false },
    stroke: [
      { ...DEFAULTS.stroke(), size: 6, position: 'center', blendMode: 'screen', opacity: 0.9, fill: { type: 'color', color: [1, 0.5, 0] } },
      { ...DEFAULTS.stroke(), size: 2, position: 'inside', fill: { type: 'pattern', pattern, scale: 100, link: true } },
    ],
  };
}

const round = (fx: LayerEffects) => effectsFromPsd(JSON.parse(JSON.stringify(effectsToPsd(fx))), [pattern]);

describe('layer styles in PSD', () => {
  it('every effect maps out and back', () => {
    const fx = everything();
    const { effects: back, lost } = round(fx);
    expect(lost).toEqual([]);
    const near = (a: unknown, b: unknown) => expect(JSON.parse(JSON.stringify(a), (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))).toEqual(JSON.parse(JSON.stringify(b), (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
    const strip = (x: object) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'data' ? undefined : k === 'corner' ? undefined : v)));
    // Colours travel as 8-bit, so compare at that precision.
    const q8 = (x: object) => JSON.parse(JSON.stringify(strip(x)), (k, v) => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && n <= 1) ? v.map((n: number) => Math.round(n * 255)) : v));
    near(q8(back.dropShadow), q8(fx.dropShadow));
    near(q8(back.innerShadow), q8(fx.innerShadow));
    near(q8(back.innerGlow!), q8(fx.innerGlow!));
    near(q8(back.bevel!), q8(fx.bevel!));
    near(q8(back.satin!), q8(fx.satin!));
    near(q8(back.colorOverlay), q8(fx.colorOverlay));
    near(q8(back.gradientOverlay), q8(fx.gradientOverlay));
    near(q8(back.patternOverlay!), q8(fx.patternOverlay!));
    near(q8(back.stroke), q8(fx.stroke));
    // Outer Glow's technique is not in the codec: it comes back Softer.
    near(q8({ ...back.outerGlow!, technique: 'softer' }), q8({ ...fx.outerGlow!, technique: 'softer' }));
  });

  it('a document round-trips its styles, the patterns they use and Blending Options', () => {
    const layer = makePixelLayer('Styled', square(), {
      effects: everything(),
      fill: 0.3,
      blending: {
        ...DEFAULT_BLENDING_STATE,
        channels: { r: true, g: false, b: true },
        knockout: 'shallow',
        blendClippedLayersAsGroup: false,
        transparencyShapesLayer: false,
        blendIf: [
          { channel: 'gray', thisLayer: [20 / 255, 60 / 255, 1, 1], underlying: [0, 0, 200 / 255, 240 / 255] },
          { channel: 'g', thisLayer: [0, 0, 128 / 255, 128 / 255], underlying: [0, 0, 1, 1] },
        ],
      },
    });
    const doc: Doc = { ...emptyDoc(64, 48, 'fx.psd'), layers: [layer], activeLayerIds: [layer.id] };
    const opened = openPsd(savePsd(doc));
    expect(opened.warnings).toEqual([]);
    const back = opened.doc.layers[0]!;
    expect(back.effects?.stroke.length).toBe(2);
    expect(back.effects?.patternOverlay?.pattern?.id).toBe(pattern.id);
    expect(back.effects?.patternOverlay?.pattern?.data.length).toBe(pattern.data.length);
    expect(back.fill).toBeCloseTo(0.3, 2);
    expect(back.blending).toEqual(layer.blending);
  });

  it('a hidden style and an effects scale come back as saved', () => {
    const hidden = round({ ...everything(), enabled: false }).effects;
    expect(hidden.enabled).toBe(false);
    const raw = JSON.parse(JSON.stringify(effectsToPsd({ ...EMPTY_EFFECTS, dropShadow: [{ ...DEFAULTS.dropShadow(), size: 10, distance: 4 }] })));
    raw.scale = 2;
    const scaled = effectsFromPsd(raw, []).effects.dropShadow[0]!;
    expect([scaled.size, scaled.distance]).toEqual([20, 8]);
  });
});
