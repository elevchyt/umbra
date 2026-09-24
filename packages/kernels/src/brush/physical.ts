/**
 * Photoshop's physical tips — Bristle, Erodible and Airbrush — as generated bitmaps [fit].
 *
 * Photoshop simulates these tips in 3-D; it does not document how. Here each tip is a small
 * family of sampled-tip bitmaps built from its settings, and the stroke engine picks one per
 * dab, so they flow through the same GPU and CPU dab paths as any sampled tip:
 *
 * - **Bristle**: a fixed set of bristles (from Bristles, Thickness and Clumping) in the
 *   brush's cross-section. Pressure presses the brush down: bristles whose tips reach the
 *   paper mark it, and they splay outward by how soft (Stiffness) and long (Length) they are.
 *   One bitmap per pressure level, all from the same bristles, so strokes streak.
 * - **Erodible**: the lead's footprint for its shape, with grain on its soft edge. It wears
 *   as it paints (faster the softer it is): a point broadens, a round edge hardens, corners
 *   round off. One bitmap per wear level; the stroke carries the wear, and Sharpen Tip resets it.
 * - **Airbrush**: a spray — a soft disc whose density turns to grain with Granularity, plus
 *   spatter droplets, pulled to one side by Distortion. Several random variants, one per dab.
 *
 * Ids are self-describing (`phys:<json>#<variant>`), so any holder of an id can rebuild its
 * bitmap; built bitmaps are cached.
 */
import type { TipBitmap } from './coverage.js';
import type { AirbrushTip, BristleTip, ErodibleTip, TipRef } from './model.js';
import { hash01, rng } from './rng.js';

export type PhysicalTip = BristleTip | ErodibleTip | AirbrushTip;

/** Bitmaps per tip: pressure levels (bristle), wear levels (erodible), variants (airbrush). */
export const PHYSICAL_LEVELS = 8;
const N = 256;

export function isPhysical(t: TipRef | undefined): t is PhysicalTip {
  return !!t && (t.kind === 'bristle' || t.kind === 'erodible' || t.kind === 'airbrush');
}

export function physicalTipId(t: PhysicalTip, variant: number): string {
  return `phys:${JSON.stringify(t)}#${variant}`;
}

/**
 * How much bigger than the brush's size the bitmap is: splayed bristles and spatter reach
 * past the tip's resting outline.
 */
export function physicalExtent(t: PhysicalTip): number {
  return t.kind === 'bristle' ? 1.45 : t.kind === 'airbrush' ? 1.25 : 1.05;
}

/** The bitmap for a dab: by pressure (bristle), wear (erodible) or at random (airbrush). */
export function physicalVariant(t: PhysicalTip, pressure: number, wear: number, rand: () => number): number {
  const top = PHYSICAL_LEVELS - 1;
  if (t.kind === 'bristle') return Math.max(0, Math.min(top, Math.round(pressure * top)));
  if (t.kind === 'erodible') return Math.max(0, Math.min(top, Math.floor(wear * PHYSICAL_LEVELS)));
  return Math.min(top, Math.floor(rand() * PHYSICAL_LEVELS));
}

/** How much an erodible tip wears per dab: softer leads faster; measured in diameters travelled. */
export function wearPerDab(t: ErodibleTip, spacing: number): number {
  return (1 - t.hardness) * Math.max(0.01, spacing) * 0.03;
}

const cache = new Map<string, TipBitmap>();

/** The bitmap for a physical tip id, or undefined for any other id. */
export function physicalTip(id: string): TipBitmap | undefined {
  if (!id.startsWith('phys:')) return undefined;
  const hit = cache.get(id);
  if (hit) return hit;
  const at = id.lastIndexOf('#');
  let t: PhysicalTip;
  try {
    t = JSON.parse(id.slice(5, at)) as PhysicalTip;
  } catch {
    return undefined;
  }
  const v = Number(id.slice(at + 1)) || 0;
  const bmp = t.kind === 'bristle' ? bristleBitmap(t, v) : t.kind === 'erodible' ? erodibleBitmap(t, v) : airbrushBitmap(t, v);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(id, bmp);
  return bmp;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A seed from a tip's settings, so the same tip always has the same bristles. */
function seedOf(t: PhysicalTip): number {
  const s = JSON.stringify(t);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A canvas in tip space: (u, v) in [−extent, extent]² over N × N pixels. */
class TipCanvas {
  readonly a = new Float32Array(N * N);
  constructor(private extent: number) {}
  /** Pixels per unit of tip space. */
  get scale(): number {
    return N / (2 * this.extent);
  }
  px(u: number): number {
    return (u + this.extent) * this.scale;
  }
  /** A soft disc (1 px edge), combined by max. */
  disc(u: number, v: number, r: number, value: number): void {
    const cx = this.px(u);
    const cy = this.px(v);
    const rp = Math.max(0.5, r * this.scale);
    for (let y = Math.max(0, Math.floor(cy - rp - 1)); y <= Math.min(N - 1, Math.ceil(cy + rp + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rp - 1)); x <= Math.min(N - 1, Math.ceil(cx + rp + 1)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const c = clamp(rp + 0.5 - d, 0, 1) * value;
        const i = y * N + x;
        if (c > this.a[i]!) this.a[i] = c;
      }
    }
  }
  /** Fill from a function of tip-space coordinates. */
  fill(f: (u: number, v: number, x: number, y: number) => number): void {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) this.a[y * N + x] = clamp(f((x + 0.5) / this.scale - this.extent, (y + 0.5) / this.scale - this.extent, x, y), 0, 1);
  }
  bitmap(): TipBitmap {
    const data = new Uint8Array(N * N);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(this.a[i]! * 255);
    return { width: N, height: N, data };
  }
}

// ---- bristle ------------------------------------------------------------------------------

function bristleBitmap(t: BristleTip, level: number): TipBitmap {
  const flat = t.shape.startsWith('flat');
  const form = t.shape.slice(flat ? 4 : 5).toLowerCase() as 'point' | 'blunt' | 'curve' | 'angle' | 'fan';
  // Resting cross-section: a disc, or an ellipse three times wider than thick.
  const ry = flat ? 0.32 : 1;
  const rand = rng(seedOf(t));
  const n = Math.round(4 + 120 * clamp(t.bristles, 0.01, 1));
  const k = Math.max(2, Math.round(n / 10));
  const clumps: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    clumps.push([Math.cos(a) * r, Math.sin(a) * r * ry]);
  }
  const soft = (1 - clamp(t.stiffness, 0.01, 1)) * Math.min(1, clamp(t.length, 0.25, 5) / 2);
  const radius = 0.012 + clamp(t.thickness, 0.01, 2) * 0.045;
  const cl = clamp(t.clumping, 0, 1) * 0.5;
  // Every random number is drawn whatever the level, so each level has the same bristles.
  const bristles: { x: number; y: number; d: number; ink: number; clump: [number, number] }[] = [];
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    if (form === 'fan') {
      x = rand() * 2 - 1;
      y = (x * x * 0.55 - 0.3) * (flat ? 0.6 : 1) + (rand() - 0.5) * (flat ? 0.08 : 0.3);
    } else {
      do {
        x = rand() * 2 - 1;
        y = (rand() * 2 - 1) * ry;
      } while (x * x + (y / ry) ** 2 > 1);
    }
    const jitter = rand();
    const ink = 0.4 + 0.6 * rand();
    const dist = Math.hypot(x, y / ry);
    // How far the bristle's tip sits above the paper when the brush just touches it.
    const lift =
      form === 'point' ? dist * 0.9 : form === 'curve' ? dist * dist * 0.85 : form === 'angle' ? ((x + 1) / 2) * 0.9 : form === 'fan' ? Math.abs(x) * 0.1 : 0;
    bristles.push({ x, y, d: lift + jitter * 0.08, ink, clump: clumps[i % k]! });
  }
  // Pressure presses the brush down, from its lowest bristle; a bristle marks once it reaches
  // the paper, and splays out by how far past that it is pressed.
  const p = level / (PHYSICAL_LEVELS - 1);
  const depth = Math.min(...bristles.map((b) => b.d)) + 0.2 + 0.9 * p;
  const c = new TipCanvas(1.45);
  for (const b of bristles) {
    if (b.d > depth) continue;
    const splay = 1 + (depth - b.d) * soft * 0.6;
    c.disc((b.x + (b.clump[0] - b.x) * cl) * splay, (b.y + (b.clump[1] - b.y) * cl) * splay, radius, b.ink);
  }
  return c.bitmap();
}

// ---- erodible -----------------------------------------------------------------------------

/** Signed distance to a rounded box of half-size (w, h) and corner radius r. */
function sdBox(u: number, v: number, w: number, h: number, r: number): number {
  const qx = Math.abs(u) - w + r;
  const qy = Math.abs(v) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to an equilateral triangle of circumradius 1 (apex up), rounded by r. */
function sdTriangle(u: number, v: number, r: number): number {
  // Iñigo Quilez's equilateral triangle about its centroid, with half-side h.
  const k = Math.sqrt(3);
  const h = ((1 - r) * k) / 2;
  let x = Math.abs(u) - h;
  let y = -v + h / k;
  if (x + k * y > 0) [x, y] = [(x - k * y) / 2, (-k * x - y) / 2];
  x -= clamp(x, -2 * h, 0);
  return -Math.hypot(x, y) * Math.sign(y) - r;
}

/** Smooth value noise at a few pixels' grain. */
function grain(x: number, y: number, seed: number): number {
  const cx = x / 2.5;
  const cy = y / 2.5;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const h = (i: number, j: number) => hash01(i, j, seed);
  return (h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx) * (1 - fy) + (h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx) * fy;
}

function erodibleBitmap(t: ErodibleTip, level: number): TipBitmap {
  const w = level / (PHYSICAL_LEVELS - 1);
  const softness = 1 - clamp(t.hardness, 0, 1);
  const seed = seedOf(t);
  const c = new TipCanvas(1.05);
  c.fill((u, v, x, y) => {
    let sd: number;
    let feather: number;
    switch (t.shape) {
      case 'point':
        // A sharpened lead: a fine point that broadens as it wears.
        sd = Math.hypot(u, v) - (0.3 + 0.7 * w);
        feather = 0.1 + 0.3 * softness * (1 - 0.5 * w);
        break;
      case 'flat':
        sd = sdBox(u, v, 1, 0.18 + 0.2 * w, 0.05);
        feather = 0.05 + 0.2 * softness;
        break;
      case 'round':
        sd = Math.hypot(u, v) - 1;
        feather = (0.1 + 0.4 * softness) * (1 - 0.6 * w);
        break;
      case 'square':
        sd = sdBox(u, v, 0.85, 0.85, 0.04 + 0.35 * w);
        feather = 0.05 + 0.2 * softness;
        break;
      case 'triangle':
        sd = sdTriangle(u, v, 0.04 + 0.3 * w);
        feather = 0.05 + 0.2 * softness;
        break;
    }
    const a = clamp(0.5 - sd / feather, 0, 1);
    // Soft leads leave grain where they are thin.
    return a * (1 - softness * 0.45 * grain(x, y, seed) * (1.2 - a * 0.4));
  });
  return c.bitmap();
}

// ---- airbrush -----------------------------------------------------------------------------

function airbrushBitmap(t: AirbrushTip, variant: number): TipBitmap {
  const seed = (seedOf(t) + variant * 7919) >>> 0;
  const rand = rng(seed);
  const distortion = clamp((t.cutoffAngle - 1) / 89, 0, 1);
  const h = clamp(t.hardness, 0, 0.99);
  const g = clamp(t.granularity, 0, 1);
  const c = new TipCanvas(1.25);
  c.fill((u, v, x, y) => {
    // Distortion pulls the spray to one side and stretches it.
    const du = (u + 0.25 * distortion) / (1 + 0.5 * distortion);
    const r = Math.hypot(du, v);
    if (r >= 1) return 0;
    const base = r <= h ? 1 : (() => {
      const s = (r - h) / (1 - h);
      return 1 - s * s * (3 - 2 * s);
    })();
    // Granularity turns the density into single droplets of paint.
    const on = hash01(x, y, seed) < base ? 1 : 0;
    return (1 - g) * base + g * on;
  });
  const drops = Math.round(clamp(t.spatterAmount, 1, 200));
  const size = 0.012 + clamp(t.spatterSize, 0, 1) * 0.18;
  for (let i = 0; i < drops; i++) {
    const a = rand() * Math.PI * 2;
    // Mostly near the centre, some flung out past the edge.
    const r = Math.min(1.2, Math.abs(gauss(rand)) * 0.5);
    c.disc(Math.cos(a) * r - 0.25 * distortion, Math.sin(a) * r, size * (0.5 + rand()), 0.7 + 0.3 * rand());
  }
  return c.bitmap();
}

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());
}
