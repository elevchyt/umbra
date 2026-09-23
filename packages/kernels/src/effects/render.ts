/**
 * Rendering layer effects — spec 06 §9. Every effect becomes a raster (colour plus coverage)
 * with its own blend mode and opacity, and the caller composites them as layers: the ones
 * below the content (Drop Shadows, Outer Glow) and the ones above it, in Photoshop's order —
 * Pattern Overlay, Gradient Overlay, Color Overlay, Satin, Inner Glow, Inner Shadow, Stroke,
 * Bevel & Emboss. That is exactly what Photoshop's own Layer ▸ Layer Style ▸ Create Layers
 * produces, which is what makes the model checkable against it.
 *
 * The shape `S` is the layer's coverage at Fill 100 %, after its mask. Coverage rasters bake
 * `S` in (an overlay is `S` wide; an inner shadow is clipped to it), so they composite as
 * ordinary layers with no clipping.
 *
 * `[fit]` throughout where spec 06 says so: blur "size" is σ = size / 3 (finite support ≈ size),
 * spread and choke dilate by size·p and blur the rest, Range reshapes the contour's domain
 * around the default 50 %, and the bevel profiles are described at each one.
 */
import type { BlendMode } from '@umbra/core/blend';
import { hash2 } from '../filters/core.js';
import { gradientRamp, gradientT, type Gradient, type GradientStyle } from '../gradient.js';
import { gradientFillGeometry, patternTexel, type PatternDef } from '../fill.js';
import { applyContour, contourLut } from './contour.js';
import { blur, clamp01, shift, signedDistance, type Field } from './field.js';
import type { BevelEffect, Contour, GlobalLight, GlowEffect, LayerEffects, Rgb, ShadowEffect, StrokeEffect } from './types.js';

export interface EffectsInput {
  /** The layer's coverage over the working region, 0…1. */
  shape: Field;
  width: number;
  height: number;
  /** Where the region's (0,0) is in the document. */
  originX: number;
  originY: number;
  docWidth: number;
  docHeight: number;
  /** The layer's content bounds in the document, for "Align with Layer" and "Link with Layer". */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  light: GlobalLight;
}

export interface EffectRaster {
  name: string;
  blendMode: BlendMode;
  opacity: number;
  /** Straight RGBA8 over the region. */
  data: Uint8ClampedArray;
}

export interface RenderedEffects {
  below: EffectRaster[];
  above: EffectRaster[];
}

const sigmaOf = (size: number) => Math.max(0, size) / 3;

/** How far past the shape's edge the effects reach, so the caller can size the region. */
export function effectsReach(fx: LayerEffects): number {
  let r = 2;
  for (const d of fx.dropShadow) if (d.enabled) r = Math.max(r, d.distance + d.size + 2);
  if (fx.outerGlow?.enabled) r = Math.max(r, fx.outerGlow.size + 2);
  for (const s of fx.stroke) if (s.enabled && s.position !== 'inside') r = Math.max(r, s.size + 2);
  if (fx.bevel?.enabled && fx.bevel.style !== 'innerBevel') {
    const stroke = fx.stroke.find((s) => s.enabled)?.size ?? 0;
    r = Math.max(r, fx.bevel.size + fx.bevel.soften + stroke + 2);
  }
  return Math.ceil(r);
}

/** Straight colour raster from a coverage field and a colour function. */
function raster(m: Field, colour: (i: number) => Rgb | [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(m.length * 4);
  for (let i = 0; i < m.length; i++) {
    const a = m[i]!;
    if (a <= 0) continue;
    const c = colour(i);
    out[i * 4] = c[0] * 255;
    out[i * 4 + 1] = c[1] * 255;
    out[i * 4 + 2] = c[2] * 255;
    out[i * 4 + 3] = clamp01(a * (c.length === 4 ? c[3]! : 1)) * 255;
  }
  return out;
}

const solid = (m: Field, c: Rgb) => raster(m, () => c);

export function renderEffects(fx: LayerEffects, input: EffectsInput): RenderedEffects {
  const { shape: S, width: w, height: h, originX, originY, light } = input;
  const n = w * h;
  let sdCache: Field | null = null;
  const sd = () => (sdCache ??= signedDistance(S, w, h));

  /** The shape grown (r > 0) by r pixels, from the distance field. */
  const grown = (r: number): Field => {
    if (r <= 0) return S;
    const d = sd();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = clamp01(r + 0.5 - d[i]!);
    return out;
  };
  /** The shape's outside grown inward by r pixels (a choke). */
  const inverseGrown = (r: number): Field => {
    const out = new Float32Array(n);
    if (r <= 0) {
      for (let i = 0; i < n; i++) out[i] = 1 - S[i]!;
      return out;
    }
    const d = sd();
    for (let i = 0; i < n; i++) out[i] = clamp01(r + 0.5 + d[i]!);
    return out;
  };
  const contoured = (m: Field, c: Contour, aa: boolean, range = 50) => {
    const lut = contourLut(c, aa);
    const k = range / 50;
    for (let i = 0; i < n; i++) {
      const v = m[i]!;
      if (v <= 0) continue;
      // Range 50 % is the contour as drawn; less compresses it toward the edge, more widens it.
      m[i] = applyContour(lut, clamp01(1 - (1 - v) / k));
    }
    return m;
  };
  const noised = (m: Field, amount: number, seed: number) => {
    if (amount <= 0) return m;
    const a = amount / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (m[i]! <= 0) continue;
        m[i] = clamp01(m[i]! * (1 + (hash2(x + originX, y + originY, seed) - 0.5) * 2 * a));
      }
    }
    return m;
  };
  const angleOf = (e: { useGlobalLight: boolean; angle: number }) => ((e.useGlobalLight ? light.angle : e.angle) * Math.PI) / 180;

  const shadow = (e: ShadowEffect, inner: boolean, seed: number): Field => {
    const r = (e.size * e.spread) / 100;
    const base = inner ? inverseGrown(r) : grown(r);
    const a = angleOf(e);
    let m = blur(base, w, h, sigmaOf(e.size - r));
    // Cast away from the light: 90° (light from the top) puts a drop shadow below.
    m = shift(m, w, h, -Math.cos(a) * e.distance, Math.sin(a) * e.distance);
    if (m === base) m = m.slice();
    m = contoured(m, e.contour, e.antiAlias);
    m = noised(m, e.noise, seed);
    for (let i = 0; i < n; i++) {
      if (inner) m[i] = m[i]! * S[i]!;
      else if (e.knockout) m[i] = m[i]! * (1 - S[i]!);
    }
    return m;
  };

  const glow = (e: GlowEffect, inner: boolean, seed: number): Uint8ClampedArray => {
    const r = (e.size * e.spread) / 100;
    const rest = Math.max(0.5, e.size - r);
    let m: Field;
    if (e.technique === 'precise') {
      const d = sd();
      m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const dist = inner ? -d[i]! : d[i]!;
        m[i] = clamp01(1 - Math.max(0, dist - r) / rest);
      }
    } else {
      // A glow is full strength at the edge, where a plain blur of the shape is only half:
      // the blurred coverage is doubled and clamped. [fit]
      m = blur(inner ? inverseGrown(r) : grown(r), w, h, sigmaOf(rest));
      if (m === S) m = m.slice();
      for (let i = 0; i < n; i++) m[i] = clamp01(m[i]! * 2);
    }
    if (inner && e.source === 'center') for (let i = 0; i < n; i++) m[i] = 1 - m[i]!;
    m = contoured(m, e.contour, e.antiAlias, e.range);
    m = noised(m, e.noise, seed);
    if (inner) for (let i = 0; i < n; i++) m[i] = m[i]! * S[i]!;
    if (e.fill.type === 'color') return solid(m, e.fill.color);
    // A gradient runs from the edge (its left end) outward; Jitter scatters the position.
    const ramp = gradientRamp(e.fill.gradient);
    const jitter = e.jitter / 100;
    return raster(m, (i) => {
      let t = 1 - m[i]!;
      if (jitter > 0) t = clamp01(t + (hash2((i % w) + originX, Math.floor(i / w) + originY, seed + 7) - 0.5) * jitter);
      const k = Math.round(t * 255) * 4;
      return [ramp[k]! / 255, ramp[k + 1]! / 255, ramp[k + 2]! / 255, (ramp[k + 3]! / 255) * Math.min(1, m[i]! * 4) / Math.max(1e-6, m[i]!)];
    });
  };

  /** A gradient over the layer's bounds (Align with Layer) or the canvas, sampled per pixel. */
  const gradientSampler = (g: Gradient, style: GradientStyle, angle: number, scale: number, reverse: boolean, align: boolean, offset = { x: 0, y: 0 }) => {
    const box = align ? input.bounds : { x0: 0, y0: 0, x1: input.docWidth, y1: input.docHeight };
    const geo = gradientFillGeometry({ type: 'gradient', gradient: g, style, angle, scale, reverse, offset }, box.x1 - box.x0, box.y1 - box.y0);
    const ramp = gradientRamp(g);
    return (x: number, y: number): [number, number, number, number] => {
      let t = clamp01(gradientT(style, geo.x0 + box.x0, geo.y0 + box.y0, geo.x1 + box.x0, geo.y1 + box.y0, x + originX + 0.5, y + originY + 0.5));
      if (reverse) t = 1 - t;
      const k = Math.round(t * 255) * 4;
      return [ramp[k]! / 255, ramp[k + 1]! / 255, ramp[k + 2]! / 255, ramp[k + 3]! / 255];
    };
  };
  const patternSampler = (p: PatternDef, scale: number, link: boolean, phase = { x: 0, y: 0 }) => {
    const ph = link ? { x: input.bounds.x0 + phase.x, y: input.bounds.y0 + phase.y } : phase;
    return (x: number, y: number): [number, number, number, number] => {
      const o = patternTexel(p, scale, ph, x + originX, y + originY);
      return [p.data[o]! / 255, p.data[o + 1]! / 255, p.data[o + 2]! / 255, p.data[o + 3]! / 255];
    };
  };
  const overlay = (m: Field, sample: (x: number, y: number) => [number, number, number, number]) => raster(m, (i) => sample(i % w, Math.floor(i / w)));

  const strokeCoverage = (e: StrokeEffect): { cov: Field; t: Field } => {
    const d = sd();
    const cov = new Float32Array(n);
    const t = new Float32Array(n);
    const wd = e.size;
    for (let i = 0; i < n; i++) {
      const di = d[i]!;
      let c: number;
      if (e.position === 'outside') {
        c = clamp01(wd + 0.5 - di) - S[i]!;
        t[i] = clamp01(di / wd);
      } else if (e.position === 'inside') {
        c = S[i]! - clamp01(-di - wd + 0.5);
        t[i] = clamp01(-di / wd);
      } else {
        c = clamp01(wd / 2 + 0.5 - di) - clamp01(-di - wd / 2 + 0.5);
        t[i] = clamp01((di + wd / 2) / wd);
      }
      cov[i] = Math.max(0, c);
    }
    return { cov, t };
  };

  const bevel = (e: BevelEffect): EffectRaster[] => {
    const d = sd();
    const size = Math.max(1, e.size);
    const strokeW = e.style === 'strokeEmboss' ? (fx.stroke.find((s) => s.enabled)?.size ?? 0) : 0;
    let H: Field = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const di = d[i]!;
      switch (e.style) {
        case 'innerBevel':
          H[i] = clamp01(-di / size);
          break;
        case 'outerBevel':
          H[i] = clamp01(1 - di / size);
          break;
        case 'emboss':
          H[i] = clamp01(0.5 - di / (2 * size));
          break;
        case 'pillowEmboss':
          // Both sides slope down into the edge.
          H[i] = clamp01(Math.abs(di) / size);
          break;
        case 'strokeEmboss':
          H[i] = clamp01(-(di - strokeW) / size);
          break;
      }
    }
    if (e.technique === 'smooth') {
      // A rounded profile, then softened: Photoshop's Smooth bevel has no facets.
      for (let i = 0; i < n; i++) H[i] = Math.sqrt(clamp01(1 - (1 - H[i]!) ** 2));
      H = blur(H, w, h, size / 5);
    } else if (e.technique === 'chiselSoft') {
      H = blur(H, w, h, 1);
    } else {
      // Chisel Hard keeps its facets; a touch of blur only removes the distance field's pixel
      // steps, which otherwise streak curved edges.
      H = blur(H, w, h, 0.7);
    }
    if (e.contourEnabled) {
      const lut = contourLut(e.contour, e.contourAntiAlias);
      const k = e.contourRange / 50;
      for (let i = 0; i < n; i++) H[i] = applyContour(lut, clamp01(1 - (1 - H[i]!) / k));
    }
    if (e.textureEnabled && e.texture) {
      const tex = patternSampler(e.texture, e.textureScale, true);
      const k = (e.textureDepth / 100) * 0.25 * (e.textureInvert ? -1 : 1);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (S[i]! <= 0) continue;
          const [r, g, b] = tex(x, y);
          H[i] = H[i]! + (0.3 * r + 0.59 * g + 0.11 * b - 0.5) * k * S[i]!;
        }
      }
    }
    if (e.soften > 0) H = blur(H, w, h, e.soften / 2);
    const scale = size * (e.depth / 100) * (e.direction === 'up' ? 1 : -1);
    const a = angleOf(e);
    const alt = ((e.useGlobalLight ? light.altitude : e.altitude) * Math.PI) / 180;
    const L = [Math.cos(alt) * Math.cos(a), -Math.cos(alt) * Math.sin(a), Math.sin(alt)];
    const gloss = contourLut(e.gloss, e.antiAliasGloss);
    const I0 = applyContour(gloss, L[2]!);
    const hi = new Float32Array(n);
    const lo = new Float32Array(n);
    const at = (x: number, y: number) => H[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
    const clipInside = e.style === 'innerBevel' || e.style === 'strokeEmboss';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = ((at(x + 1, y) - at(x - 1, y)) / 2) * scale;
        const gy = ((at(x, y + 1) - at(x, y - 1)) / 2) * scale;
        if (gx === 0 && gy === 0) continue;
        const len = Math.hypot(gx, gy, 1);
        const I = applyContour(gloss, clamp01((-gx * L[0]! - gy * L[1]! + L[2]!) / len));
        const clip = clipInside ? S[i]! : 1;
        hi[i] = (clamp01((I - I0) / Math.max(1e-6, 1 - I0)) * clip);
        lo[i] = (clamp01((I0 - I) / Math.max(1e-6, I0)) * clip);
      }
    }
    return [
      { name: 'Bevel Shadow', blendMode: e.shadowMode, opacity: e.shadowOpacity, data: solid(lo, e.shadowColor) },
      { name: 'Bevel Highlight', blendMode: e.highlightMode, opacity: e.highlightOpacity, data: solid(hi, e.highlightColor) },
    ];
  };

  const below: EffectRaster[] = [];
  const above: EffectRaster[] = [];
  // Multi-instance lists run top of the dialog first; the bottom one is drawn first.
  const bottomUp = <T>(l: T[]) => [...l].reverse();

  bottomUp(fx.dropShadow).forEach((e, k) => {
    if (e.enabled) below.push({ name: 'Drop Shadow', blendMode: e.blendMode, opacity: e.opacity, data: solid(shadow(e, false, 31 + k), e.color) });
  });
  if (fx.outerGlow?.enabled) below.push({ name: 'Outer Glow', blendMode: fx.outerGlow.blendMode, opacity: fx.outerGlow.opacity, data: glow(fx.outerGlow, false, 41) });

  const p = fx.patternOverlay;
  if (p?.enabled && p.pattern) above.push({ name: 'Pattern Overlay', blendMode: p.blendMode, opacity: p.opacity, data: overlay(S, patternSampler(p.pattern, p.scale, p.link, p.phase)) });
  for (const g of bottomUp(fx.gradientOverlay)) {
    if (g.enabled) above.push({ name: 'Gradient Overlay', blendMode: g.blendMode, opacity: g.opacity, data: overlay(S, gradientSampler(g.gradient, g.style, g.angle, g.scale, g.reverse, g.align, g.offset)) });
  }
  for (const c of bottomUp(fx.colorOverlay)) if (c.enabled) above.push({ name: 'Color Overlay', blendMode: c.blendMode, opacity: c.opacity, data: solid(S, c.color) });
  const sat = fx.satin;
  if (sat?.enabled) {
    const a = (sat.angle * Math.PI) / 180;
    const dx = Math.cos(a) * sat.distance;
    const dy = -Math.sin(a) * sat.distance;
    const A = blur(shift(S, w, h, dx, dy), w, h, sigmaOf(sat.size));
    const B = blur(shift(S, w, h, -dx, -dy), w, h, sigmaOf(sat.size));
    let m: Field = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = Math.abs(A[i]! - B[i]!);
    m = contoured(m, sat.contour, sat.antiAlias);
    for (let i = 0; i < n; i++) m[i] = (sat.invert ? 1 - m[i]! : m[i]!) * S[i]!;
    above.push({ name: 'Satin', blendMode: sat.blendMode, opacity: sat.opacity, data: solid(m, sat.color) });
  }
  if (fx.innerGlow?.enabled) above.push({ name: 'Inner Glow', blendMode: fx.innerGlow.blendMode, opacity: fx.innerGlow.opacity, data: glow(fx.innerGlow, true, 43) });
  bottomUp(fx.innerShadow).forEach((e, k) => {
    if (e.enabled) above.push({ name: 'Inner Shadow', blendMode: e.blendMode, opacity: e.opacity, data: solid(shadow(e, true, 51 + k), e.color) });
  });
  for (const s of bottomUp(fx.stroke)) {
    if (!s.enabled) continue;
    const { cov, t } = strokeCoverage(s);
    const f = s.fill;
    let data: Uint8ClampedArray;
    if (f.type === 'color') data = solid(cov, f.color);
    else if (f.type === 'pattern') data = f.pattern ? overlay(cov, patternSampler(f.pattern, f.scale, f.link)) : solid(cov, [0, 0, 0]);
    else if (f.style === 'shapeBurst') {
      const ramp = gradientRamp(f.gradient);
      data = raster(cov, (i) => {
        const k = Math.round((f.reverse ? 1 - t[i]! : t[i]!) * 255) * 4;
        return [ramp[k]! / 255, ramp[k + 1]! / 255, ramp[k + 2]! / 255, ramp[k + 3]! / 255];
      });
    } else data = overlay(cov, gradientSampler(f.gradient, f.style, f.angle, f.scale, f.reverse, f.align));
    above.push({ name: 'Stroke', blendMode: s.blendMode, opacity: s.opacity, data });
  }
  if (fx.bevel?.enabled) above.push(...bevel(fx.bevel));
  return { below, above };
}
