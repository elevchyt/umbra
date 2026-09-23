/**
 * Warp Text — spec 04 §7: fifteen styles with Bend and Horizontal/Vertical Distortion, applied
 * to the glyph outlines (so the result stays vector-exact to the flattening tolerance).
 *
 * [fit] Photoshop builds each style as a Bézier patch whose control grid is not documented;
 * these are closed-form maps with the same shape and the same response to Bend (±100 %) —
 * what "Convert to custom warp" in a real file would settle, per style, by reading the grid.
 * Coordinates are normalised to the text's bounds: u, v in [−1, 1], v down.
 */
export type WarpStyle =
  | 'arc'
  | 'arcLower'
  | 'arcUpper'
  | 'arch'
  | 'bulge'
  | 'shellLower'
  | 'shellUpper'
  | 'flag'
  | 'wave'
  | 'fish'
  | 'rise'
  | 'fisheye'
  | 'inflate'
  | 'squeeze'
  | 'twist';

export const WARP_STYLES: { value: WarpStyle; label: string }[] = [
  { value: 'arc', label: 'Arc' },
  { value: 'arcLower', label: 'Arc Lower' },
  { value: 'arcUpper', label: 'Arc Upper' },
  { value: 'arch', label: 'Arch' },
  { value: 'bulge', label: 'Bulge' },
  { value: 'shellLower', label: 'Shell Lower' },
  { value: 'shellUpper', label: 'Shell Upper' },
  { value: 'flag', label: 'Flag' },
  { value: 'wave', label: 'Wave' },
  { value: 'fish', label: 'Fish' },
  { value: 'rise', label: 'Rise' },
  { value: 'fisheye', label: 'Fisheye' },
  { value: 'inflate', label: 'Inflate' },
  { value: 'squeeze', label: 'Squeeze' },
  { value: 'twist', label: 'Twist' },
];

export interface WarpSpec {
  style: WarpStyle;
  /** Bend, −100…100 %. */
  bend: number;
  /** Horizontal and vertical distortion, −100…100 %. */
  hDistort: number;
  vDistort: number;
  /** Horizontal warps bend across the width; vertical ones across the height. */
  orientation: 'horizontal' | 'vertical';
}

type Pt = { x: number; y: number };

/** The map for a warp over a box (in layout space). */
export function warpMap(w: WarpSpec, box: { x0: number; y0: number; x1: number; y1: number }): (p: Pt) => Pt {
  const W0 = Math.max(1e-6, box.x1 - box.x0);
  const H0 = Math.max(1e-6, box.y1 - box.y0);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const vert = w.orientation === 'vertical';
  // Work in a frame where the bend runs along x (turned for vertical warps).
  const W = vert ? H0 : W0;
  const H = vert ? W0 : H0;
  const hw = W / 2;
  const hh = H / 2;
  const b = Math.max(-1, Math.min(1, w.bend / 100));
  const hd = Math.max(-1, Math.min(1, w.hDistort / 100));
  const vd = Math.max(-1, Math.min(1, w.vDistort / 100));
  const core = (x: number, y: number): [number, number] => {
    const u = x / hw;
    const v = y / hh;
    const para = 1 - u * u;
    switch (w.style) {
      case 'arc': {
        // Concentric arcs about a centre below the text (above it for a negative bend): the
        // width becomes an arc of b·180°, heights become radii.
        if (Math.abs(b) < 1e-6) return [x, y];
        const s = Math.sign(b);
        const theta = Math.abs(b) * Math.PI;
        const R = hw / Math.sin(theta / 2);
        const a = u * (theta / 2);
        const r = R - s * y;
        return [r * Math.sin(a), s * (R - r * Math.cos(a))];
      }
      case 'arcLower':
        return [x, y + b * hh * para * ((v + 1) / 2)];
      case 'arcUpper':
        return [x, y - b * hh * para * ((1 - v) / 2)];
      case 'arch':
        return [x, y - b * hh * para];
      case 'bulge':
        return [x, y + v * b * hh * para];
      case 'shellLower':
        return [x * (1 + b * 0.25 * (v + 1)), y + b * hh * para * ((v + 1) / 2)];
      case 'shellUpper':
        return [x * (1 + b * 0.25 * (1 - v)), y - b * hh * para * ((1 - v) / 2)];
      case 'flag':
        return [x, y - b * hh * 0.5 * Math.sin(u * Math.PI)];
      case 'wave':
        return [x, y - b * hh * 0.5 * Math.sin(u * Math.PI + (v * Math.PI) / 2)];
      case 'fish':
        // Full at the head, pinched towards the tail.
        return [x, y * (1 + b * 0.7 * para * (1 - 0.5 * u))];
      case 'rise':
        return [x, y - b * hh * u];
      case 'fisheye': {
        const k = 1 + b * 0.6 * (1 - Math.min(1, u * u + v * v));
        return [x * k, y * k];
      }
      case 'inflate':
        return [x * (1 + b * 0.3 * (1 - v * v)), y * (1 + b * 0.5 * para)];
      case 'squeeze':
        return [x * (1 - b * 0.5 * (1 - v * v)), y * (1 + b * 0.3 * para)];
      case 'twist': {
        const a = b * Math.PI * (1 - Math.min(1, Math.hypot(u, v)));
        const c = Math.cos(a);
        const sn = Math.sin(a);
        return [hw * (u * c - v * sn), hh * (u * sn + v * c)];
      }
    }
  };
  return (p: Pt) => {
    const lx = vert ? p.y - cy : p.x - cx;
    const ly = vert ? cx - p.x : p.y - cy;
    let [x, y] = core(lx, ly);
    // Horizontal distortion grows one end and shrinks the other; vertical, the top against
    // the bottom — a perspective-like taper in the normalised frame.
    y *= 1 + hd * 0.5 * (lx / hw);
    x *= 1 - vd * 0.5 * (ly / hh);
    return vert ? { x: cx - y, y: cy + x } : { x: cx + x, y: cy + y };
  };
}
