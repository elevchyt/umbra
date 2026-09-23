/**
 * The Styles panel's starter set: Umbra's own styles (not Photoshop's), a few of each common
 * kind so the panel is useful before any .asl is loaded.
 */
import type { Gradient } from '../gradient.js';
import { CONTOUR_PRESETS } from './contour.js';
import { DEFAULTS, EMPTY_EFFECTS, type LayerEffects } from './types.js';

export interface StylePreset {
  id: string;
  name: string;
  effects: LayerEffects;
}

const grad = (a: [number, number, number], b: [number, number, number], name: string, fade = false): Gradient => ({
  name,
  colorStops: [
    { at: 0, color: a },
    { at: 1, color: b },
  ],
  opacityStops: [
    { at: 0, opacity: 1 },
    { at: 1, opacity: fade ? 0 : 1 },
  ],
});

export function builtinStyles(): StylePreset[] {
  const fx = (over: Partial<LayerEffects>): LayerEffects => ({ ...EMPTY_EFFECTS, ...over });
  return [
    { id: 'umbra-soft-shadow', name: 'Soft Shadow', effects: fx({ dropShadow: [{ ...DEFAULTS.dropShadow(), opacity: 0.5, distance: 6, size: 12 }] }) },
    { id: 'umbra-hard-shadow', name: 'Hard Shadow', effects: fx({ dropShadow: [{ ...DEFAULTS.dropShadow(), opacity: 0.8, distance: 5, size: 0, useGlobalLight: false, angle: 135 }] }) },
    { id: 'umbra-outline', name: 'Outline', effects: fx({ stroke: [{ ...DEFAULTS.stroke(), size: 3 }] }) },
    { id: 'umbra-embossed', name: 'Embossed', effects: fx({ bevel: { ...DEFAULTS.bevel(), size: 8 }, dropShadow: [{ ...DEFAULTS.dropShadow(), distance: 2, size: 3 }] }) },
    {
      id: 'umbra-inset',
      name: 'Inset',
      effects: fx({ innerShadow: [{ ...DEFAULTS.innerShadow(), opacity: 0.65, distance: 3, size: 5 }], stroke: [{ ...DEFAULTS.stroke(), size: 1, position: 'outside', opacity: 0.35, fill: { type: 'color', color: [1, 1, 1] } }] }),
    },
    { id: 'umbra-glow', name: 'Glow', effects: fx({ outerGlow: { ...DEFAULTS.outerGlow(), opacity: 0.85, size: 18 } }) },
    {
      id: 'umbra-neon',
      name: 'Neon',
      effects: fx({
        stroke: [{ ...DEFAULTS.stroke(), size: 2, position: 'center', fill: { type: 'color', color: [0.3, 1, 1] } }],
        outerGlow: { ...DEFAULTS.outerGlow(), opacity: 0.9, size: 16, fill: { type: 'color', color: [0, 0.85, 1] } },
        innerGlow: { ...DEFAULTS.innerGlow(), opacity: 0.6, size: 8, fill: { type: 'color', color: [0.6, 1, 1] } },
      }),
    },
    {
      id: 'umbra-glass',
      name: 'Glass Button',
      effects: fx({
        gradientOverlay: [{ ...DEFAULTS.gradientOverlay(), blendMode: 'screen', opacity: 0.7, gradient: grad([1, 1, 1], [1, 1, 1], 'White to Transparent', true), angle: -90, scale: 60, offset: { x: 0, y: -20 } }],
        bevel: { ...DEFAULTS.bevel(), size: 12, soften: 4, highlightOpacity: 0.5, shadowOpacity: 0.4 },
        dropShadow: [{ ...DEFAULTS.dropShadow(), opacity: 0.45, distance: 4, size: 8 }],
      }),
    },
    {
      id: 'umbra-gold',
      name: 'Gold',
      effects: fx({
        gradientOverlay: [{ ...DEFAULTS.gradientOverlay(), gradient: grad([0.55, 0.38, 0.08], [1, 0.87, 0.45], 'Gold'), angle: 90 }],
        bevel: { ...DEFAULTS.bevel(), technique: 'chiselHard', size: 6, gloss: CONTOUR_PRESETS[6]! },
        stroke: [{ ...DEFAULTS.stroke(), size: 1, position: 'inside', fill: { type: 'color', color: [0.45, 0.3, 0.05] } }],
      }),
    },
    {
      id: 'umbra-satin-dark',
      name: 'Dark Satin',
      effects: fx({ satin: { ...DEFAULTS.satin(), opacity: 0.6 }, colorOverlay: [{ ...DEFAULTS.colorOverlay(), color: [0.15, 0.15, 0.2], blendMode: 'multiply', opacity: 0.4 }] }),
    },
  ];
}
