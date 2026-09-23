/**
 * Custom shapes — spec 04 §6: a built-in set, and `.csh` files read into it. A custom shape
 * is a path in its own units; the Custom Shape tool fits it to the box the user drags.
 */
import type { Knot, Path, Pt, Subpath } from './path.js';
import { pathBounds, transformPath } from './path.js';

export interface CustomShape {
  id: string;
  name: string;
  path: Path;
}

/**
 * A minimal SVG path-data reader (absolute and relative M, L, H, V, C, S, Q, Z), enough for
 * the built-in set. Quadratics are raised to cubics.
 */
export function svgPath(d: string): Path {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const subpaths: Subpath[] = [];
  let knots: Knot[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | null = null;
  let cmd = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  const flush = (closed: boolean) => {
    if (knots.length > 1 || (closed && knots.length)) {
      // A closing segment that returns to the first anchor merges into it.
      const first = knots[0]!;
      const last = knots[knots.length - 1]!;
      if (closed && knots.length > 1 && Math.hypot(last.anchor.x - first.anchor.x, last.anchor.y - first.anchor.y) < 1e-9) {
        first.in = last.in;
        knots.pop();
      }
      subpaths.push({ closed, op: 'add', knots });
    }
    knots = [];
  };
  const lineTo = (p: Pt) => {
    knots.push({ anchor: p, in: p, out: p, smooth: false });
    cur = p;
    lastCtrl = null;
  };
  const curveTo = (c1: Pt, c2: Pt, p: Pt) => {
    const prev = knots[knots.length - 1];
    if (prev) prev.out = c1;
    knots.push({ anchor: p, in: c2, out: p, smooth: false });
    cur = p;
    lastCtrl = c2;
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        flush(true);
        cur = start;
        continue;
      }
    }
    const rel = cmd === cmd.toLowerCase();
    const o = rel ? cur : { x: 0, y: 0 };
    switch (cmd.toUpperCase()) {
      case 'M': {
        flush(false);
        const p = { x: o.x + num(), y: o.y + num() };
        start = p;
        lineTo(p);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        lineTo({ x: o.x + num(), y: o.y + num() });
        break;
      case 'H':
        lineTo({ x: (rel ? cur.x : 0) + num(), y: cur.y });
        break;
      case 'V':
        lineTo({ x: cur.x, y: (rel ? cur.y : 0) + num() });
        break;
      case 'C': {
        const c1 = { x: o.x + num(), y: o.y + num() };
        const c2 = { x: o.x + num(), y: o.y + num() };
        curveTo(c1, c2, { x: o.x + num(), y: o.y + num() });
        break;
      }
      case 'S': {
        const lc = lastCtrl as Pt | null;
        const c1 = lc ? { x: 2 * cur.x - lc.x, y: 2 * cur.y - lc.y } : cur;
        const c2 = { x: o.x + num(), y: o.y + num() };
        curveTo(c1, c2, { x: o.x + num(), y: o.y + num() });
        break;
      }
      case 'Q': {
        const q = { x: o.x + num(), y: o.y + num() };
        const p = { x: o.x + num(), y: o.y + num() };
        const p0 = cur;
        curveTo({ x: p0.x + ((q.x - p0.x) * 2) / 3, y: p0.y + ((q.y - p0.y) * 2) / 3 }, { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 }, p);
        break;
      }
      default:
        i++;
    }
  }
  flush(false);
  return { subpaths };
}

/** The built-in set, drawn on a 100-unit grid. */
const BUILTIN: [string, string, string][] = [
  ['heart', 'Heart', 'M50 90 C20 70 0 50 0 28 C0 10 14 0 28 0 C38 0 46 6 50 14 C54 6 62 0 72 0 C86 0 100 10 100 28 C100 50 80 70 50 90 Z'],
  ['star5', 'Star', 'M50 0 L61.8 35.4 L99 35.4 L69 57.3 L80.4 92.7 L50 70.8 L19.6 92.7 L31 57.3 L1 35.4 L38.2 35.4 Z'],
  ['arrow', 'Arrow', 'M0 35 L60 35 L60 10 L100 50 L60 90 L60 65 L0 65 Z'],
  ['check', 'Checkmark', 'M0 55 L15 40 L38 62 L85 10 L100 25 L38 92 Z'],
  ['bubble', 'Speech Bubble', 'M10 0 L90 0 C95.5 0 100 4.5 100 10 L100 60 C100 65.5 95.5 70 90 70 L40 70 L20 95 L25 70 L10 70 C4.5 70 0 65.5 0 60 L0 10 C0 4.5 4.5 0 10 0 Z'],
  ['bolt', 'Lightning', 'M60 0 L10 55 L45 55 L35 100 L90 40 L55 40 L70 0 Z'],
  ['cross', 'Cross', 'M35 0 L65 0 L65 35 L100 35 L100 65 L65 65 L65 100 L35 100 L35 65 L0 65 L0 35 L35 35 Z'],
  ['ring', 'Ring', 'M50 0 C77.6 0 100 22.4 100 50 C100 77.6 77.6 100 50 100 C22.4 100 0 77.6 0 50 C0 22.4 22.4 0 50 0 Z M50 25 C36.2 25 25 36.2 25 50 C25 63.8 36.2 75 50 75 C63.8 75 75 63.8 75 50 C75 36.2 63.8 25 50 25 Z'],
  ['frame', 'Frame', 'M0 0 L100 0 L100 100 L0 100 Z M15 15 L15 85 L85 85 L85 15 Z'],
  ['drop', 'Raindrop', 'M50 0 C50 0 85 45 85 65 C85 84.3 69.3 100 50 100 C30.7 100 15 84.3 15 65 C15 45 50 0 50 0 Z'],
];

/** Inner outlines are holes: each later component excludes. */
const withHoles = (p: Path): Path => ({ subpaths: p.subpaths.map((sp, i) => (i ? { ...sp, op: 'exclude' } : sp)) });

export const BUILTIN_SHAPES: CustomShape[] = BUILTIN.map(([id, name, d]) => ({ id, name, path: withHoles(svgPath(d)) }));

/** Fit a custom shape into a box (its bounds scaled to the box). */
export function fitShape(path: Path, box: { x: number; y: number; w: number; h: number }): Path {
  const b = pathBounds(path, 0.05);
  if (!b) return path;
  const sx = box.w / Math.max(1e-9, b.x1 - b.x0);
  const sy = box.h / Math.max(1e-9, b.y1 - b.y0);
  return transformPath(path, { a: sx, b: 0, c: 0, d: sy, e: box.x - b.x0 * sx, f: box.y - b.y0 * sy });
}

// ---- Photoshop path records (PSD image resources 2000–2997, vector masks, .csh) -------------

/** Record operation codes, as Photoshop numbers them. */
const PATH_OPS: Subpath['op'][] = ['exclude', 'add', 'subtract', 'intersect'];

/** Decode 26-byte path records (points are signed 8.24 fixed, stored y then x). */
export function readPathRecords(dv: DataView, offset: number, count: number): Path {
  const subpaths: Subpath[] = [];
  let knots: Knot[] | null = null;
  let left = 0;
  let closed = false;
  let op: Subpath['op'] = 'add';
  const fx = (o: number) => dv.getInt32(o) / (1 << 24);
  const pt = (o: number): Pt => ({ x: fx(o + 4), y: fx(o) });
  for (let r = 0; r < count; r++) {
    const o = offset + r * 26;
    const sel = dv.getUint16(o);
    if (sel === 0 || sel === 3) {
      closed = sel === 0;
      left = dv.getUint16(o + 2);
      // Photoshop CS6+ keeps each component's operation here. Older files write −1 and fill
      // by the even-odd rule, so their later components exclude — which is how holes read.
      const code = dv.getInt16(o + 4);
      op = PATH_OPS[code] ?? (subpaths.length ? 'exclude' : 'add');
      knots = [];
      if (left === 0) knots = null;
      continue;
    }
    if (sel === 1 || sel === 2 || sel === 4 || sel === 5) {
      if (!knots) continue;
      knots.push({ in: pt(o + 2), anchor: pt(o + 10), out: pt(o + 18), smooth: sel === 1 || sel === 4 });
      if (--left === 0) {
        subpaths.push({ closed, op, knots });
        knots = null;
      }
    }
  }
  return { subpaths };
}

/** Encode a path as records (with the fill-rule record Photoshop leads with). */
export function writePathRecords(path: Path): Uint8Array {
  const count = 1 + path.subpaths.reduce((n, sp) => n + 1 + sp.knots.length, 0);
  const out = new Uint8Array(count * 26);
  const dv = new DataView(out.buffer);
  const put = (o: number, q: Pt) => {
    dv.setInt32(o, Math.round(q.y * (1 << 24)));
    dv.setInt32(o + 4, Math.round(q.x * (1 << 24)));
  };
  dv.setUint16(0, 6);
  let r = 1;
  for (const sp of path.subpaths) {
    dv.setUint16(r * 26, sp.closed ? 0 : 3);
    dv.setUint16(r * 26 + 2, sp.knots.length);
    dv.setInt16(r * 26 + 4, PATH_OPS.indexOf(sp.op));
    dv.setUint16(r * 26 + 6, 1);
    r++;
    for (const k of sp.knots) {
      const o = r * 26;
      dv.setUint16(o, sp.closed ? (k.smooth ? 1 : 2) : k.smooth ? 4 : 5);
      put(o + 2, k.in);
      put(o + 10, k.anchor);
      put(o + 18, k.out);
      r++;
    }
  }
  return out;
}

/**
 * Read a `.csh` custom-shapes file: `cush`, version, count, then per shape a UTF-16 name
 * (padded to 4 bytes), two 32-bit words (an unknown 1 and the length of the rest), a Pascal
 * string id, the bounds (top, left, bottom, right) and path records to the end. The record
 * start is found by the record-alignment rule (what follows the id is 16 bytes of bounds and
 * then whole 26-byte records), which tolerates the id padding varying between versions.
 * Each shape's path is normalised to its own bounds — the tool fits it to the drag anyway.
 */
export function readCsh(buf: ArrayBuffer): CustomShape[] {
  const dv = new DataView(buf);
  const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (tag !== 'cush') throw new Error('Not a custom shapes file');
  const count = dv.getUint32(8);
  const shapes: CustomShape[] = [];
  let o = 12;
  for (let s = 0; s < count && o + 4 <= buf.byteLength; s++) {
    const nameLen = dv.getUint32(o);
    o += 4;
    let name = '';
    for (let c = 0; c < nameLen; c++) {
      const ch = dv.getUint16(o + c * 2);
      if (ch) name += String.fromCharCode(ch);
    }
    o += nameLen * 2;
    o = (o + 3) & ~3;
    o += 4; // unknown, 1
    const len = dv.getUint32(o);
    o += 4;
    const end = o + len;
    const idLen = dv.getUint8(o);
    let id = '';
    for (let c = 0; c < idLen; c++) id += String.fromCharCode(dv.getUint8(o + 1 + c));
    // Records start after the id and the 16 bytes of bounds, at an offset whole records fill.
    let rec = o + 1 + idLen + 16;
    while (rec < end && (end - rec) % 26 !== 0) rec++;
    const path = readPathRecords(dv, rec, Math.floor((end - rec) / 26));
    if (path.subpaths.length) shapes.push({ id: id || `csh-${s}`, name: name || `Shape ${s + 1}`, path });
    o = (end + 3) & ~3;
  }
  return shapes;
}

/** Write a `.csh` file (the inverse of {@link readCsh}); used by Save Shapes and the tests. */
export function writeCsh(shapes: readonly CustomShape[]): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const pad = () => {
    while (parts.length % 4) parts.push(0);
  };
  for (const c of 'cush') parts.push(c.charCodeAt(0));
  u32(2);
  u32(shapes.length);
  for (const s of shapes) {
    const name = s.name + '\0';
    u32(name.length);
    for (const c of name) parts.push(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255);
    pad();
    u32(1);
    const recs = writePathRecords(s.path);
    const b = pathBounds(s.path, 0.05) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    const id = s.id.slice(0, 255);
    const body: number[] = [id.length, ...Array.from(id, (c) => c.charCodeAt(0))];
    for (const v of [b.y0, b.x0, b.y1, b.x1]) {
      const n = Math.round(v) | 0;
      body.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    }
    body.push(...recs);
    u32(body.length);
    parts.push(...body);
    pad();
  }
  return Uint8Array.from(parts);
}
