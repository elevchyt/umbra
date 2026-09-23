/**
 * 3-D colour lookup tables — Image ▸ Adjustments ▸ Color Lookup (spec 05 §A, [exact]).
 *
 * A LUT is an N×N×N grid of output colours over the RGB cube, red varying fastest (the .cube
 * convention). Between grid points Photoshop interpolates TETRAHEDRALLY: the cube cell is cut
 * into six tetrahedra along its grey diagonal, so neutral inputs stay exactly on the grid's
 * neutral axis — trilinear would bend greys whenever the corners disagree.
 *
 * Tables live in a registry keyed by id, and adjustments refer to them by id. That keeps an
 * `Adjustment` small enough to send to the UI with every document summary, and lets a table
 * loaded from a file, a PSD, or the built-in set be used the same way.
 */

export interface Lut3D {
  id: string;
  /** Shown in the menu; for a file, its name. */
  name: string;
  size: number;
  /** size³ × 3 floats, 0…1, red fastest. */
  data: Float32Array;
  /** The file it came from, kept so saving a PSD can embed it byte for byte. */
  source?: { format: 'cube' | '3dl'; bytes: Uint8Array };
}

// ---- parsing ---------------------------------------------------------------------------------

/** Adobe/Resolve .cube: `LUT_3D_SIZE N`, optional DOMAIN_MIN/MAX, then N³ "r g b" lines. */
export function parseCube(text: string, id: string, name = id): Lut3D {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let title: string | null = null;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '');
      continue;
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1]!, 10);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) throw new Error('1-D .cube files are not 3-D LUTs');
    if (upper.startsWith('DOMAIN_MIN')) {
      min = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      max = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (/^[A-Z_]/.test(upper)) continue; // other keywords (LUT_3D_INPUT_RANGE, …)
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (size < 2 || size > 256) throw new Error(`.cube: bad LUT_3D_SIZE ${size}`);
  if (values.length !== size * size * size * 3) {
    throw new Error(`.cube: expected ${size ** 3} entries, found ${values.length / 3}`);
  }
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    // Outputs are in the domain's units; normalise them to 0…1.
    data[i] = (values[i]! - min[c]!) / (max[c]! - min[c]! || 1);
  }
  return { id, name: title && name === id ? title : name, size, data };
}

/**
 * Autodesk .3dl: an input mesh line (N integers), then N³ lines of integer outputs with BLUE
 * varying fastest; the output bit depth is inferred from the largest value.
 */
export function parse3dl(text: string, id: string, name = id): Lut3D {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^[A-Za-z]/.test(l))
    .map((l) => l.split(/\s+/).map(Number));
  const mesh = rows.shift();
  if (!mesh || mesh.length < 2) throw new Error('.3dl: missing input mesh');
  const size = mesh.length;
  const triples = rows.filter((r) => r.length >= 3);
  if (triples.length !== size ** 3) throw new Error(`.3dl: expected ${size ** 3} entries, found ${triples.length}`);
  let peak = 0;
  for (const t of triples) peak = Math.max(peak, t[0]!, t[1]!, t[2]!);
  const scale = peak > 4095 ? 65535 : peak > 1023 ? 4095 : 1023;
  const data = new Float32Array(size ** 3 * 3);
  // .3dl is r-slowest/b-fastest; store red-fastest like everything else here.
  let k = 0;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const t = triples[k++]!;
        const o = ((b * size + g) * size + r) * 3;
        data[o] = t[0]! / scale;
        data[o + 1] = t[1]! / scale;
        data[o + 2] = t[2]! / scale;
      }
    }
  }
  return { id, name, size, data };
}

export function parseLutFile(bytes: Uint8Array, fileName: string): Lut3D {
  const text = new TextDecoder().decode(bytes);
  const lower = fileName.toLowerCase();
  const name = fileName.replace(/\.[^.]+$/, '');
  const lut = lower.endsWith('.3dl') ? parse3dl(text, fileName, name) : parseCube(text, fileName, name);
  return { ...lut, source: { format: lower.endsWith('.3dl') ? '3dl' : 'cube', bytes } };
}

/** Serialise as .cube — for tables with no file behind them (the built-ins) when saving PSDs. */
export function toCube(lut: Lut3D): string {
  const lines = [`TITLE "${lut.name}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(`${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

// ---- interpolation ------------------------------------------------------------------------

/**
 * Tetrahedral interpolation of `lut` at `rgb` (0…1), in place. The six cases are the six
 * orderings of the fractional parts; each walks from the cell's black corner to its white
 * corner through the two corners that ordering passes.
 */
export function sampleLut(lut: Lut3D, rgb: Float32Array): void {
  const n = lut.size;
  const d = lut.data;
  const fr = Math.min(1, Math.max(0, rgb[0]!)) * (n - 1);
  const fg = Math.min(1, Math.max(0, rgb[1]!)) * (n - 1);
  const fb = Math.min(1, Math.max(0, rgb[2]!)) * (n - 1);
  const r0 = Math.min(n - 2, Math.floor(fr));
  const g0 = Math.min(n - 2, Math.floor(fg));
  const b0 = Math.min(n - 2, Math.floor(fb));
  const x = fr - r0;
  const y = fg - g0;
  const z = fb - b0;
  const at = (dr: number, dg: number, db: number, c: number) => d[(((b0 + db) * n + (g0 + dg)) * n + (r0 + dr)) * 3 + c]!;
  for (let c = 0; c < 3; c++) {
    const c000 = at(0, 0, 0, c);
    const c111 = at(1, 1, 1, c);
    let v: number;
    if (x >= y) {
      if (y >= z) v = c000 + x * (at(1, 0, 0, c) - c000) + y * (at(1, 1, 0, c) - at(1, 0, 0, c)) + z * (c111 - at(1, 1, 0, c));
      else if (x >= z) v = c000 + x * (at(1, 0, 0, c) - c000) + z * (at(1, 0, 1, c) - at(1, 0, 0, c)) + y * (c111 - at(1, 0, 1, c));
      else v = c000 + z * (at(0, 0, 1, c) - c000) + x * (at(1, 0, 1, c) - at(0, 0, 1, c)) + y * (c111 - at(1, 0, 1, c));
    } else {
      if (z >= y) v = c000 + z * (at(0, 0, 1, c) - c000) + y * (at(0, 1, 1, c) - at(0, 0, 1, c)) + x * (c111 - at(0, 1, 1, c));
      else if (z >= x) v = c000 + y * (at(0, 1, 0, c) - c000) + z * (at(0, 1, 1, c) - at(0, 1, 0, c)) + x * (c111 - at(0, 1, 1, c));
      else v = c000 + y * (at(0, 1, 0, c) - c000) + x * (at(1, 1, 0, c) - at(0, 1, 0, c)) + z * (c111 - at(1, 1, 0, c));
    }
    rgb[c] = v;
  }
}

// ---- registry and the built-in set ---------------------------------------------------------

const registry = new Map<string, Lut3D>();

export function registerLut(lut: Lut3D): Lut3D {
  registry.set(lut.id, lut);
  return lut;
}

export function getLut(id: string): Lut3D | undefined {
  return registry.get(id);
}

export function listLuts(): { id: string; name: string; size: number }[] {
  return [...registry.values()].map((l) => ({ id: l.id, name: l.name, size: l.size }));
}

function build(id: string, name: string, fn: (r: number, g: number, b: number) => [number, number, number], size = 33): Lut3D {
  const data = new Float32Array(size ** 3 * 3);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data.set(out.map((v) => Math.min(1, Math.max(0, v))), ((b * size + g) * size + r) * 3);
      }
    }
  }
  return { id, name, size, data };
}

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const s = (t: number) => t * t * (3 - 2 * t);
const mixc = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The built-in looks — original, generated here, not Photoshop's shipped set. They are what a
 * grading LUT typically does: split toning, faded blacks, bleach bypass, a cool night grade.
 */
export const BUILTIN_LUT_IDS = ['umbra:identity', 'umbra:warm-film', 'umbra:teal-orange', 'umbra:bleach', 'umbra:faded', 'umbra:moonlight'] as const;

registerLut(build('umbra:identity', 'Identity', (r, g, b) => [r, g, b], 17));
registerLut(
  build('umbra:warm-film', 'Warm Film', (r, g, b) => [
    mixc(r, s(r), 0.5) * 1.02 + 0.02,
    mixc(g, s(g), 0.4) + 0.01,
    mixc(b, s(b), 0.3) * 0.9 + 0.03,
  ]),
);
registerLut(
  build('umbra:teal-orange', 'Teal & Orange', (r, g, b) => {
    const l = lum(r, g, b);
    // Shadows toward teal, highlights toward orange, weighted by luminance.
    const w = s(l);
    return [r + (w - 0.5) * 0.16, g + (0.5 - Math.abs(w - 0.5)) * 0.04, b + (0.5 - w) * 0.18];
  }),
);
registerLut(
  build('umbra:bleach', 'Bleach Bypass', (r, g, b) => {
    const l = lum(r, g, b);
    const k = s(l);
    return [mixc(r, k, 0.55), mixc(g, k, 0.55), mixc(b, k, 0.55)].map((v) => mixc(v, s(v), 0.6)) as [number, number, number];
  }),
);
registerLut(build('umbra:faded', 'Faded', (r, g, b) => [0.08 + r * 0.86, 0.07 + g * 0.87, 0.1 + b * 0.82]));
registerLut(
  build('umbra:moonlight', 'Moonlight', (r, g, b) => {
    const l = lum(r, g, b) * 0.85;
    return [mixc(r, l, 0.6) * 0.8, mixc(g, l, 0.6) * 0.9, mixc(b, l, 0.4) * 1.05 + 0.04];
  }),
);
