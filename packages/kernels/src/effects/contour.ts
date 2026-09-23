/**
 * Contours (spec 06 §9): a 256-entry table from a contour curve. Corner points split the
 * curve into independently smoothed segments, which is how Photoshop's contours get their
 * sharp peaks (Cone, Ring, Sawtooth) while staying smooth elsewhere.
 *
 * The presets are Umbra's own drawings of Photoshop's twelve standard shapes, by name — the
 * point lists are not Photoshop's. `[fit]`: an exact match needs the preset files.
 */
import { evaluateCurve } from '../curve.js';
import type { Contour } from './types.js';

export function contourLut(c: Contour, antiAlias = false): Float32Array {
  const pts = [...c.points].sort((a, b) => a.x - b.x);
  const lut = new Float32Array(256);
  // Segment boundaries: the ends and every corner point.
  const cuts = pts.map((p, i) => (i === 0 || i === pts.length - 1 || p.corner ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let s = 0;
    while (s < cuts.length - 2 && x > pts[cuts[s + 1]!]!.x) s++;
    const seg = pts.slice(cuts[s]!, cuts[s + 1]! + 1);
    lut[k] = seg.length >= 2 ? evaluateCurve(seg, x) : (seg[0]?.y ?? x);
  }
  if (antiAlias) {
    // Soften steep steps with a small box filter over the table.
    const out = new Float32Array(256);
    for (let k = 0; k < 256; k++) {
      let sum = 0;
      let n = 0;
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j < 0 || j > 255) continue;
        sum += lut[j]!;
        n++;
      }
      out[k] = sum / n;
    }
    return out;
  }
  return lut;
}

/** Look a 0…1 value up in a contour table (linear between entries). */
export function applyContour(lut: Float32Array, v: number): number {
  const f = Math.min(1, Math.max(0, v)) * 255;
  const i = Math.floor(f);
  if (i >= 255) return lut[255]!;
  return lut[i]! + (lut[i + 1]! - lut[i]!) * (f - i);
}

const P = (x: number, y: number, corner = false) => ({ x: x / 255, y: y / 255, corner });

export const CONTOUR_PRESETS: Contour[] = [
  { name: 'Linear', points: [P(0, 0), P(255, 255)] },
  { name: 'Cone', points: [P(0, 0), P(128, 255, true), P(255, 0)] },
  { name: 'Cone - Inverted', points: [P(0, 255), P(128, 0, true), P(255, 255)] },
  { name: 'Cove - Deep', points: [P(0, 0), P(96, 18), P(180, 80), P(255, 255)] },
  { name: 'Cove - Shallow', points: [P(0, 0), P(128, 90), P(255, 255)] },
  { name: 'Gaussian', points: [P(0, 0), P(64, 20), P(128, 128), P(192, 235), P(255, 255)] },
  { name: 'Half Round', points: [P(0, 0), P(40, 120), P(110, 215), P(190, 250), P(255, 255)] },
  { name: 'Ring', points: [P(0, 0), P(90, 255, true), P(180, 0, true), P(255, 0)] },
  { name: 'Ring - Double', points: [P(0, 0), P(55, 255, true), P(110, 0, true), P(170, 255, true), P(225, 0, true), P(255, 0)] },
  { name: 'Rolling Slope - Descending', points: [P(0, 255), P(80, 230), P(180, 90), P(255, 0)] },
  { name: 'Rounded Steps', points: [P(0, 0), P(50, 20), P(80, 110), P(120, 125), P(160, 140), P(190, 230), P(255, 255)] },
  { name: 'Sawtooth 1', points: [P(0, 0), P(85, 255, true), P(86, 0, true), P(170, 255, true), P(171, 0, true), P(255, 255)] },
];
