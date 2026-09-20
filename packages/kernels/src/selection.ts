/**
 * Selection algorithms — docs/spec/02-document-model.md §5, spec 04 §3.
 *
 * A selection is a COVERAGE MASK, not a shape: one 8-bit value per document pixel, 0 = not
 * selected, 255 = fully selected. Everything downstream (painting, fills, filters, copy) just
 * multiplies by it, which is why anti-aliased and feathered selections need no special cases.
 *
 * These are pure functions over flat buffers so they can be tested without a document, a tile
 * store or a GPU. The engine owns the buffer and its document-sized geometry.
 *
 * Storage note: the active selection is a flat full-canvas buffer rather than a tiled plane.
 * That costs width×height bytes (8 MB at 4K) and keeps the distance transform, blur and flood
 * fill straightforward. Tiling it is worthwhile only once selections need undo history of
 * their own.
 */

export type Mask = Uint8Array;

export interface MaskSize {
  width: number;
  height: number;
}

export type CombineOp = 'new' | 'add' | 'subtract' | 'intersect';

export function createMask(width: number, height: number, fill = 0): Mask {
  const m = new Uint8Array(width * height);
  if (fill) m.fill(fill);
  return m;
}

/** Selection bounds, or null when nothing is selected. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function maskBounds(mask: Mask, { width, height }: MaskSize): Bounds | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export function isEmpty(mask: Mask): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) return false;
  return true;
}

/** Fraction of the document selected, for the "no pixels are more than 50% selected" warning. */
export function maxCoverage(mask: Mask): number {
  let max = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]! > max) max = mask[i]!;
  return max;
}

export function combine(dst: Mask, src: Mask, op: CombineOp): Mask {
  switch (op) {
    case 'new':
      dst.set(src);
      return dst;
    case 'add':
      for (let i = 0; i < dst.length; i++) dst[i] = Math.max(dst[i]!, src[i]!);
      return dst;
    case 'subtract':
      for (let i = 0; i < dst.length; i++) dst[i] = Math.max(0, dst[i]! - src[i]!);
      return dst;
    case 'intersect':
      for (let i = 0; i < dst.length; i++) dst[i] = Math.min(dst[i]!, src[i]!);
      return dst;
  }
}

export function invert(mask: Mask): Mask {
  for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]!;
  return mask;
}

// ---- rasterising shapes ------------------------------------------------------------------

/**
 * Rectangular marquee. Fractional edges produce partial coverage, which is what makes a
 * dragged selection settle smoothly rather than jumping a pixel at a time.
 */
export function rasterizeRect(
  mask: Mask,
  { width, height }: MaskSize,
  rect: { x0: number; y0: number; x1: number; y1: number },
  antialias = true,
): Mask {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);

  const ix0 = Math.max(0, Math.floor(x0));
  const iy0 = Math.max(0, Math.floor(y0));
  const ix1 = Math.min(width, Math.ceil(x1));
  const iy1 = Math.min(height, Math.ceil(y1));

  for (let y = iy0; y < iy1; y++) {
    // Vertical overlap of this pixel row with the rect.
    const cy = antialias ? Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0)) : y + 0.5 >= y0 && y + 0.5 < y1 ? 1 : 0;
    if (cy <= 0) continue;
    const row = y * width;
    for (let x = ix0; x < ix1; x++) {
      const cx = antialias ? Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) : x + 0.5 >= x0 && x + 0.5 < x1 ? 1 : 0;
      if (cx <= 0) continue;
      mask[row + x] = Math.round(cx * cy * 255);
    }
  }
  return mask;
}

/** Elliptical marquee, supersampled for a clean edge. */
export function rasterizeEllipse(
  mask: Mask,
  { width, height }: MaskSize,
  rect: { x0: number; y0: number; x1: number; y1: number },
  antialias = true,
): Mask {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  if (rx <= 0 || ry <= 0) return mask;

  const ix0 = Math.max(0, Math.floor(x0));
  const iy0 = Math.max(0, Math.floor(y0));
  const ix1 = Math.min(width, Math.ceil(x1));
  const iy1 = Math.min(height, Math.ceil(y1));
  const S = antialias ? 4 : 1;
  const inv = 1 / (S * S);

  for (let y = iy0; y < iy1; y++) {
    const row = y * width;
    for (let x = ix0; x < ix1; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        const py = y + (sy + 0.5) / S;
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const dx = (px - cx) / rx;
          const dy = (py - cy) / ry;
          if (dx * dx + dy * dy <= 1) hits++;
        }
      }
      if (hits) mask[row + x] = Math.round(hits * inv * 255);
    }
  }
  return mask;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Polygon fill for the lasso tools, using the non-zero winding rule and vertical
 * supersampling. Scanline coverage keeps a freehand outline from looking stepped.
 */
export function rasterizePolygon(
  mask: Mask,
  { width, height }: MaskSize,
  points: readonly Point[],
  antialias = true,
): Mask {
  if (points.length < 3) return mask;
  const S = antialias ? 4 : 1;
  const acc = new Float32Array(width);

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const iy0 = Math.max(0, Math.floor(minY));
  const iy1 = Math.min(height, Math.ceil(maxY));

  const xs: number[] = [];
  for (let y = iy0; y < iy1; y++) {
    acc.fill(0);
    for (let s = 0; s < S; s++) {
      const sy = y + (s + 0.5) / S;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if (a.y === b.y) continue;
        // Half-open test avoids counting a vertex twice.
        if (sy >= Math.min(a.y, b.y) && sy < Math.max(a.y, b.y)) {
          xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const spanStart = xs[i]!;
        const spanEnd = xs[i + 1]!;
        const px0 = Math.max(0, Math.floor(spanStart));
        const px1 = Math.min(width, Math.ceil(spanEnd));
        for (let x = px0; x < px1; x++) {
          // Horizontal coverage of this pixel by the span.
          const cover = Math.max(0, Math.min(x + 1, spanEnd) - Math.max(x, spanStart));
          acc[x]! += cover / S;
        }
      }
    }
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = acc[x]!;
      if (v > 0) mask[row + x] = Math.min(255, Math.round(v * 255));
    }
  }
  return mask;
}

/** Single row or column marquee. */
export function rasterizeLine(
  mask: Mask,
  { width, height }: MaskSize,
  index: number,
  vertical: boolean,
): Mask {
  if (vertical) {
    if (index < 0 || index >= width) return mask;
    for (let y = 0; y < height; y++) mask[y * width + index] = 255;
  } else {
    if (index < 0 || index >= height) return mask;
    mask.fill(255, index * width, index * width + width);
  }
  return mask;
}

// ---- Select ▸ Modify ----------------------------------------------------------------------

/** Separable box blur, the building block for a fast Gaussian approximation. */
function boxBlur(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const tmp = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(width - 1, Math.max(0, i))]!;
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum * norm;
      const out = row + Math.min(width - 1, Math.max(0, x - r));
      const add = row + Math.min(width - 1, Math.max(0, x + r + 1));
      sum += src[add]! - src[out]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[Math.min(height - 1, Math.max(0, i)) * width + x]!;
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum * norm;
      const out = Math.min(height - 1, Math.max(0, y - r)) * width + x;
      const add = Math.min(height - 1, Math.max(0, y + r + 1)) * width + x;
      sum += tmp[add]! - tmp[out]!;
    }
  }
}

/**
 * Feather — a Gaussian blur of the mask, approximated by three box blurs.
 *
 * Whether Photoshop's "feather radius" equals a Gaussian sigma or a support width is tagged
 * [fit] in spec 04 §3; three boxes of this width is the standard approximation and is what the
 * radius is currently interpreted as.
 */
export function feather(mask: Mask, { width, height }: MaskSize, radius: number): Mask {
  if (radius <= 0) return mask;
  const a = new Float32Array(mask.length);
  const b = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) a[i] = mask[i]!;
  // Three box passes of radius r converge on a Gaussian with total support ±3r, so r is
  // radius/3 for the softening to reach about `radius` pixels — which is what the Feather
  // dialog's number is understood to mean. The exact relation to Photoshop's own feather is
  // tagged [fit] in spec 04 §3.
  const w = Math.max(1, Math.round(radius / 3));
  boxBlur(a, b, width, height, w);
  boxBlur(b, a, width, height, w);
  boxBlur(a, b, width, height, w);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(Math.min(255, Math.max(0, b[i]!)));
  return mask;
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher, O(n)).
 * `inside` decides which side the distance is measured from.
 */
function distanceTransform(mask: Mask, width: number, height: number, inside: boolean): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);
  const grid = new Float64Array(width * height);

  for (let i = 0; i < grid.length; i++) {
    const selected = mask[i]! >= 128;
    // Distance from the set we are measuring away from.
    grid[i] = (inside ? selected : !selected) ? INF : 0;
  }

  const transform1d = (n: number, read: (i: number) => number, write: (i: number, val: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = read(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      const dx = q - v[k]!;
      write(q, dx * dx + f[v[k]!]!);
    }
  };

  for (let x = 0; x < width; x++) {
    transform1d(
      height,
      (y) => grid[y * width + x]!,
      (y, val) => {
        d[y] = val;
      },
    );
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]!;
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    transform1d(
      width,
      (x) => grid[row + x]!,
      (x, val) => {
        d[x] = val;
      },
    );
    for (let x = 0; x < width; x++) grid[row + x] = d[x]!;
  }
  return grid;
}

/** Grow the selection by `px`, measured as a true Euclidean distance (round corners). */
export function expand(mask: Mask, size: MaskSize, px: number): Mask {
  if (px <= 0) return mask;
  const dist = distanceTransform(mask, size.width, size.height, false);
  const limit = px * px;
  for (let i = 0; i < mask.length; i++) if (dist[i]! <= limit) mask[i] = 255;
  return mask;
}

export function contract(mask: Mask, size: MaskSize, px: number): Mask {
  if (px <= 0) return mask;
  const dist = distanceTransform(mask, size.width, size.height, true);
  const limit = px * px;
  for (let i = 0; i < mask.length; i++) if (dist[i]! <= limit) mask[i] = 0;
  return mask;
}

/** Keep only a band of `px` around the selection edge. */
export function border(mask: Mask, size: MaskSize, px: number): Mask {
  if (px <= 0) return mask;
  const half = px / 2;
  const outside = distanceTransform(mask, size.width, size.height, false);
  const inside = distanceTransform(mask, size.width, size.height, true);
  const limit = half * half;
  for (let i = 0; i < mask.length; i++) {
    const selected = mask[i]! >= 128;
    const d = selected ? inside[i]! : outside[i]!;
    mask[i] = d <= limit ? 255 : 0;
  }
  return mask;
}

/**
 * Smooth — a majority vote inside a radius, which rounds off jagged corners without moving
 * straight edges. Photoshop describes it the same way.
 */
export function smooth(mask: Mask, { width, height }: MaskSize, radius: number): Mask {
  if (radius <= 0) return mask;
  const r = Math.floor(radius);
  const src = Uint8Array.from(mask);
  const area = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        const row = yy * width;
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          if (src[row + xx]! >= 128) count++;
        }
      }
      mask[y * width + x] = count * 2 >= area ? 255 : 0;
    }
  }
  return mask;
}

// ---- magic wand ---------------------------------------------------------------------------

export interface WandOptions {
  tolerance: number;
  contiguous: boolean;
  antialias: boolean;
}

/**
 * Magic Wand. The inclusion test is the maximum absolute per-channel difference from the seed
 * colour, which is the behaviour the tolerance slider is usually described as having; whether
 * Photoshop uses that or a Euclidean distance is tagged [fit] in spec 04 §3.
 *
 * `pixels` is straight-alpha RGBA.
 */
export function magicWand(
  pixels: Uint8Array | Uint8ClampedArray,
  { width, height }: MaskSize,
  seedX: number,
  seedY: number,
  opts: WandOptions,
): Mask {
  const mask = createMask(width, height);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return mask;

  const seed = (seedY * width + seedX) * 4;
  const sr = pixels[seed]!;
  const sg = pixels[seed + 1]!;
  const sb = pixels[seed + 2]!;
  const sa = pixels[seed + 3]!;
  const tol = opts.tolerance;

  const diff = (i: number): number => {
    const o = i * 4;
    return Math.max(
      Math.abs(pixels[o]! - sr),
      Math.abs(pixels[o + 1]! - sg),
      Math.abs(pixels[o + 2]! - sb),
      Math.abs(pixels[o + 3]! - sa),
    );
  };

  if (!opts.contiguous) {
    for (let i = 0; i < width * height; i++) {
      mask[i] = coverageFor(diff(i), tol, opts.antialias);
    }
    return mask;
  }

  // Scanline flood fill: far fewer stack operations than a per-pixel queue.
  const stack: number[] = [seedX, seedY];
  const visited = new Uint8Array(width * height);
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * width + x;
    if (visited[i]) continue;
    while (x >= 0 && diff(y * width + x) <= tol) x--;
    x++;
    let spanUp = false;
    let spanDown = false;
    for (; x < width; x++) {
      i = y * width + x;
      const d = diff(i);
      if (d > tol) break;
      visited[i] = 1;
      mask[i] = coverageFor(d, tol, opts.antialias);
      if (y > 0) {
        const up = diff(i - width) <= tol;
        if (up && !spanUp && !visited[i - width]) {
          stack.push(x, y - 1);
          spanUp = true;
        } else if (!up) spanUp = false;
      }
      if (y < height - 1) {
        const down = diff(i + width) <= tol;
        if (down && !spanDown && !visited[i + width]) {
          stack.push(x, y + 1);
          spanDown = true;
        } else if (!down) spanDown = false;
      }
    }
  }
  return mask;
}

/**
 * Soften the last part of the tolerance range so a wand edge is not a hard stair-step.
 * Fully inside the tolerance is fully selected; the top 25% ramps out.
 */
function coverageFor(diff: number, tolerance: number, antialias: boolean): number {
  if (diff > tolerance) return 0;
  if (!antialias || tolerance === 0) return 255;
  const soft = tolerance * 0.75;
  if (diff <= soft) return 255;
  return Math.round(255 * (1 - (diff - soft) / (tolerance - soft)));
}

/** Select ▸ Grow: re-run the wand from every currently selected pixel. */
export function grow(
  mask: Mask,
  pixels: Uint8Array | Uint8ClampedArray,
  size: MaskSize,
  tolerance: number,
): Mask {
  const out = Uint8Array.from(mask);
  const { width, height } = size;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]! < 128) continue;
      const seed = (y * width + x) * 4;
      // Only test the four neighbours; repeated application grows further.
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (out[ni]! >= 128) continue;
        const o = ni * 4;
        const d = Math.max(
          Math.abs(pixels[o]! - pixels[seed]!),
          Math.abs(pixels[o + 1]! - pixels[seed + 1]!),
          Math.abs(pixels[o + 2]! - pixels[seed + 2]!),
        );
        if (d <= tolerance) out[ni] = 255;
      }
    }
  }
  mask.set(out);
  return mask;
}

/**
 * Trace the 50% iso-contour as horizontal and vertical unit edges. Marching ants are drawn
 * along these, which is what keeps the outline one device pixel wide at any zoom.
 */
export interface EdgeSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function traceBoundary(mask: Mask, { width, height }: MaskSize): EdgeSegment[] {
  const segs: EdgeSegment[] = [];
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? false : mask[y * width + x]! >= 128;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      // A boundary edge sits between a selected pixel and an unselected neighbour.
      if (!at(x, y - 1)) segs.push({ x0: x, y0: y, x1: x + 1, y1: y });
      if (!at(x, y + 1)) segs.push({ x0: x, y0: y + 1, x1: x + 1, y1: y + 1 });
      if (!at(x - 1, y)) segs.push({ x0: x, y0: y, x1: x, y1: y + 1 });
      if (!at(x + 1, y)) segs.push({ x0: x + 1, y0: y, x1: x + 1, y1: y + 1 });
    }
  }
  return segs;
}
