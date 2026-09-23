/**
 * The built-in brush library — spec 07's "same organisation, no Adobe artwork": Photoshop's
 * groups (General, Dry Media, Wet Media, Special Effects) with presets whose sampled tips are
 * generated here, procedurally and deterministically, rather than copied from anyone.
 */
import type { BrushParams } from '../brush.js';
import type { TipBitmap } from './coverage.js';
import { DEFAULT_COLOR_DYNAMICS, DEFAULT_SCATTERING, DEFAULT_SHAPE_DYNAMICS, DEFAULT_TRANSFER, NO_DYNAMIC } from './model.js';
import { hash01, rng } from './rng.js';

export interface BrushPreset {
  id: string;
  name: string;
  /** The brush's settings; tool options (opacity, flow, mode) only when the preset keeps them. */
  params: Partial<BrushParams> & { size: number };
}

export interface BrushGroup {
  name: string;
  presets: BrushPreset[];
}

const S = 128;

function makeTip(f: (u: number, v: number) => number, w = S, h = S): TipBitmap {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(Math.max(0, Math.min(1, f((x + 0.5) / w * 2 - 1, (y + 0.5) / h * 2 - 1))) * 255);
  return { width: w, height: h, data };
}

/** Smooth value noise on [−1, 1]², for grainy tips. */
function vnoise(u: number, v: number, freq: number, seed: number): number {
  const x = (u + 1) * freq;
  const y = (v + 1) * freq;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash01(i, j, seed);
  const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

/** The procedural tips, by id. */
export function builtinTips(): Map<string, TipBitmap> {
  const tips = new Map<string, TipBitmap>();
  // Chalk: a disc whose edge is eaten by coarse and fine grain.
  tips.set('builtin:chalk', makeTip((u, v) => {
    const r = Math.hypot(u, v);
    const grain = 0.55 * vnoise(u, v, 6, 11) + 0.45 * vnoise(u, v, 24, 12);
    return r < 0.95 ? (grain > 0.35 + r * 0.35 ? 1 : 0) : 0;
  }));
  // Charcoal: streaks along x, ragged at the ends.
  tips.set('builtin:charcoal', makeTip((u, v) => {
    const streak = vnoise(u * 0.15, v, 18, 21);
    const edge = 1 - Math.pow(Math.abs(u), 6) - Math.pow(Math.abs(v) * 1.1, 4);
    return edge > 0 && streak > 0.42 ? Math.min(1, edge * 2) * (0.6 + 0.4 * streak) : 0;
  }));
  // Spatter: scattered droplets of different sizes.
  {
    const r = rng(33);
    const drops = Array.from({ length: 26 }, () => {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 0.8;
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, s: 0.03 + r() * r() * 0.16 };
    });
    tips.set('builtin:spatter', makeTip((u, v) => {
      let a = 0;
      for (const p of drops) {
        const t = 1 - Math.hypot(u - p.x, v - p.y) / p.s;
        if (t > 0) a = Math.max(a, Math.min(1, t * 4));
      }
      return a;
    }));
  }
  // Sponge: cells of a jittered grid, holes between.
  tips.set('builtin:sponge', makeTip((u, v) => {
    const r = Math.hypot(u, v);
    if (r > 0.97) return 0;
    const n = vnoise(u, v, 9, 44);
    return n > 0.45 ? Math.min(1, (n - 0.45) * 6) * (1 - Math.pow(r, 8)) : 0;
  }));
  // Star: five points.
  tips.set('builtin:star', makeTip((u, v) => {
    const a = Math.atan2(v, u) + Math.PI / 2;
    const k = Math.cos((5 * a) / 2);
    const edge = 0.45 + 0.5 * Math.pow(Math.abs(k), 3);
    const r = Math.hypot(u, v);
    return Math.max(0, Math.min(1, (edge - r) * 20));
  }));
  // Grass: a tall tapering blade, curving.
  tips.set('builtin:grass', makeTip((u, v) => {
    const t = (1 - v) / 2; // 0 at the bottom, 1 at the tip
    const cx = 0.25 * t * t;
    const half = 0.18 * (1 - t) + 0.01;
    return Math.max(0, Math.min(1, (half - Math.abs(u - cx)) * 60));
  }, 64, 128));
  return tips;
}

const round = (name: string, id: string, p: Partial<BrushParams> & { size: number }): BrushPreset => ({ id: `builtin:${id}`, name, params: p });

/** Photoshop's default groups, with presets on the computed tip and the tips above. */
export function builtinBrushes(): BrushGroup[] {
  return [
    {
      name: 'General Brushes',
      presets: [
        round('Soft Round', 'soft-round', { size: 65, hardness: 0, spacing: 0.25, tip: { kind: 'computed' } }),
        round('Hard Round', 'hard-round', { size: 30, hardness: 1, spacing: 0.25, tip: { kind: 'computed' } }),
        round('Soft Round Pressure Opacity', 'soft-round-pressure-opacity', { size: 45, hardness: 0, spacing: 0.25, tip: { kind: 'computed' }, transfer: { ...DEFAULT_TRANSFER, enabled: true, opacity: { ...NO_DYNAMIC, control: 'pressure' } } }),
        round('Hard Round Pressure Size', 'hard-round-pressure-size', { size: 19, hardness: 1, spacing: 0.25, tip: { kind: 'computed' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, control: 'pressure' } } }),
        round('Hard Round Pressure Opacity and Flow', 'hard-round-pressure-opacity-flow', { size: 13, hardness: 1, spacing: 0.25, tip: { kind: 'computed' }, transfer: { enabled: true, opacity: { ...NO_DYNAMIC, control: 'pressure' }, flow: { ...NO_DYNAMIC, control: 'pressure' } } }),
      ],
    },
    {
      name: 'Dry Media Brushes',
      presets: [
        round('Chalk', 'chalk', { size: 60, spacing: 0.2, hardness: 1, tip: { kind: 'sampled', id: 'builtin:chalk' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, angle: { ...NO_DYNAMIC, jitter: 1 }, size: { ...NO_DYNAMIC, control: 'pressure' } } }),
        round('Charcoal', 'charcoal', { size: 45, spacing: 0.1, hardness: 1, tip: { kind: 'sampled', id: 'builtin:charcoal' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, angle: { ...NO_DYNAMIC, control: 'direction' }, size: { ...NO_DYNAMIC, control: 'pressure', minimum: 0.4 } }, transfer: { ...DEFAULT_TRANSFER, enabled: true, flow: { ...NO_DYNAMIC, jitter: 0.3 } } }),
      ],
    },
    {
      name: 'Wet Media Brushes',
      presets: [
        round('Watercolor Wash', 'watercolor', { size: 90, hardness: 0.2, spacing: 0.1, flow: 0.3, tip: { kind: 'computed' }, wetEdges: true, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, jitter: 0.2 } } }),
        round('Wet Sponge', 'wet-sponge', { size: 70, spacing: 0.25, hardness: 1, tip: { kind: 'sampled', id: 'builtin:sponge' }, wetEdges: true, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, angle: { ...NO_DYNAMIC, jitter: 1 } }, scattering: { ...DEFAULT_SCATTERING, enabled: true, scatter: { ...NO_DYNAMIC, jitter: 0.3 } } }),
      ],
    },
    {
      name: 'Special Effects Brushes',
      presets: [
        round('Spatter', 'spatter', { size: 80, spacing: 0.5, hardness: 1, tip: { kind: 'sampled', id: 'builtin:spatter' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, jitter: 0.5 }, angle: { ...NO_DYNAMIC, jitter: 1 } }, scattering: { ...DEFAULT_SCATTERING, enabled: true, scatter: { ...NO_DYNAMIC, jitter: 1.2 }, count: 2 } }),
        round('Scattered Stars', 'stars', { size: 40, spacing: 0.8, hardness: 1, tip: { kind: 'sampled', id: 'builtin:star' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, jitter: 0.6 }, angle: { ...NO_DYNAMIC, jitter: 1 } }, scattering: { ...DEFAULT_SCATTERING, enabled: true, scatter: { ...NO_DYNAMIC, jitter: 2 } }, colorDynamics: { ...DEFAULT_COLOR_DYNAMICS, enabled: true, hue: 0.4, brightness: 0.2 } }),
        round('Grass', 'grass', { size: 70, spacing: 0.25, hardness: 1, tip: { kind: 'sampled', id: 'builtin:grass' }, shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, size: { ...NO_DYNAMIC, jitter: 0.6 }, angle: { ...NO_DYNAMIC, jitter: 0.1 } }, scattering: { ...DEFAULT_SCATTERING, enabled: true, scatter: { ...NO_DYNAMIC, jitter: 0.8 }, count: 2 }, colorDynamics: { ...DEFAULT_COLOR_DYNAMICS, enabled: true, fgBg: { ...NO_DYNAMIC, jitter: 1 }, hue: 0.08 } }),
      ],
    },
  ];
}
