/**
 * Splitting text for shaping — scripts, bidirectional levels, and where lines may break.
 *
 * The bidi resolution is the Unicode algorithm's core, simplified: a paragraph level from the
 * first strong character; strong characters take their direction; numbers take the level
 * above an RTL context (so they read left to right); neutrals take their neighbours' level
 * when both sides agree, else the paragraph's. Explicit embeddings and isolates are not
 * modelled (Photoshop's own type engine does not expose them either).
 */

export type Script = 'Latn' | 'Grek' | 'Cyrl' | 'Armn' | 'Hebr' | 'Arab' | 'Deva' | 'Beng' | 'Taml' | 'Thai' | 'Hang' | 'Hani' | 'Hira' | 'Kana' | 'Zyyy';

const RANGES: [number, number, Script][] = [
  [0x0041, 0x024f, 'Latn'],
  [0x0370, 0x03ff, 'Grek'],
  [0x0400, 0x052f, 'Cyrl'],
  [0x0530, 0x058f, 'Armn'],
  [0x0590, 0x05ff, 'Hebr'],
  [0x0600, 0x06ff, 'Arab'],
  [0x0750, 0x077f, 'Arab'],
  [0x08a0, 0x08ff, 'Arab'],
  [0x0900, 0x097f, 'Deva'],
  [0x0980, 0x09ff, 'Beng'],
  [0x0b80, 0x0bff, 'Taml'],
  [0x0e00, 0x0e7f, 'Thai'],
  [0x1100, 0x11ff, 'Hang'],
  [0x1e00, 0x1eff, 'Latn'],
  [0x3040, 0x309f, 'Hira'],
  [0x30a0, 0x30ff, 'Kana'],
  [0x3400, 0x4dbf, 'Hani'],
  [0x4e00, 0x9fff, 'Hani'],
  [0xac00, 0xd7af, 'Hang'],
  [0xf900, 0xfaff, 'Hani'],
  [0xfb1d, 0xfb4f, 'Hebr'],
  [0xfb50, 0xfdff, 'Arab'],
  [0xfe70, 0xfeff, 'Arab'],
  [0xff21, 0xff3a, 'Latn'],
  [0xff41, 0xff5a, 'Latn'],
  [0xff66, 0xff9f, 'Kana'],
  [0x20000, 0x2fa1f, 'Hani'],
];

export function scriptOf(cp: number): Script {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'Latn';
  if (cp < 0xc0) return 'Zyyy';
  if (cp === 0xd7 || cp === 0xf7) return 'Zyyy';
  // Combining marks inherit their base's script.
  if (cp >= 0x0300 && cp <= 0x036f) return 'Zyyy';
  for (const [a, b, s] of RANGES) if (cp >= a && cp <= b) return s;
  return 'Zyyy';
}

export const isCJK = (s: Script) => s === 'Hani' || s === 'Hira' || s === 'Kana' || s === 'Hang';

type BidiClass = 'L' | 'R' | 'EN' | 'N';

function bidiClass(cp: number): BidiClass {
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if (cp >= 0x0660 && cp <= 0x0669) return 'EN';
  if (cp >= 0x06f0 && cp <= 0x06f9) return 'EN';
  const s = scriptOf(cp);
  if (s === 'Hebr' || s === 'Arab') return 'R';
  if (s === 'Zyyy') return (cp >= 0x0300 && cp <= 0x036f) || cp < 0x41 || (cp >= 0x2000 && cp <= 0x2bff) || (cp >= 0x3000 && cp <= 0x303f) ? 'N' : 'L';
  return 'L';
}

/** Code points with their UTF-16 index. */
export function codePoints(text: string): { cp: number; i: number; len: number }[] {
  const out: { cp: number; i: number; len: number }[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    out.push({ cp, i, len });
    i += len;
  }
  return out;
}

/** The paragraph's base level: 0 (LTR) or 1 (RTL). */
export function paragraphLevel(text: string, direction: 'auto' | 'ltr' | 'rtl' = 'auto'): number {
  if (direction !== 'auto') return direction === 'rtl' ? 1 : 0;
  for (const { cp } of codePoints(text)) {
    const c = bidiClass(cp);
    if (c === 'L') return 0;
    if (c === 'R') return 1;
  }
  return 0;
}

/** An embedding level per UTF-16 index. */
export function bidiLevels(text: string, base: number): Uint8Array {
  const cps = codePoints(text);
  const cls = cps.map((c) => bidiClass(c.cp));
  const lv = new Array<number>(cps.length).fill(-1);
  // Strong types and numbers.
  let lastStrong: BidiClass = base ? 'R' : 'L';
  for (let k = 0; k < cps.length; k++) {
    const c = cls[k]!;
    if (c === 'L') lv[k] = base ? 2 : 0;
    else if (c === 'R') lv[k] = 1;
    else if (c === 'EN') lv[k] = lastStrong === 'R' ? 2 : base ? 2 : 0;
    if (c === 'L' || c === 'R') lastStrong = c;
  }
  // Neutrals (N1/N2): between characters of the same direction they take it — numbers
  // count as right-to-left here — otherwise the paragraph's direction.
  const dirAt = (k: number): 'L' | 'R' => {
    if (k < 0 || k >= cps.length) return base ? 'R' : 'L';
    const c = cls[k]!;
    return c === 'L' ? 'L' : c === 'R' ? 'R' : base ? 'R' : 'L';
  };
  for (let k = 0; k < cps.length; k++) {
    if (lv[k] !== -1) continue;
    let j = k;
    while (j < cps.length && lv[j] === -1) j++;
    const before = k > 0 && cls[k - 1] === 'EN' ? 'R' : dirAt(k - 1);
    const after = j < cps.length && cls[j] === 'EN' ? 'R' : dirAt(j);
    const d = before === after ? before : base ? 'R' : 'L';
    const v = d === 'R' ? 1 : base ? 2 : 0;
    for (let m = k; m < j; m++) lv[m] = v;
    k = j - 1;
  }
  const out = new Uint8Array(text.length);
  cps.forEach((c, k) => out.fill(lv[k]!, c.i, c.i + c.len));
  return out;
}

/**
 * Visual order of items from their levels (rule L2): from the highest level down to the
 * lowest odd one, reverse every maximal sequence at or above it.
 */
export function reorder<T>(items: T[], levels: number[]): T[] {
  const idx = items.map((_, i) => i);
  const max = Math.max(0, ...levels);
  const minOdd = levels.reduce((m, l) => (l & 1 ? Math.min(m, l) : m), Infinity);
  if (!Number.isFinite(minOdd)) return items;
  for (let l = max; l >= minOdd; l--) {
    for (let i = 0; i < idx.length; ) {
      if (levels[idx[i]!]! >= l) {
        let j = i;
        while (j < idx.length && levels[idx[j]!]! >= l) j++;
        idx.splice(i, j - i, ...idx.slice(i, j).reverse());
        i = j;
      } else i++;
    }
  }
  return idx.map((i) => items[i]!);
}

/** CJK punctuation that may not start a line (kinsoku, the common set). */
const NO_START = new Set([...'、。，．：；？！）」』】〕〉》’”ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・…‥々〻']);
const NO_END = new Set([...'（「『【〔〈《‘“']);

/**
 * Break opportunities: `true` at index i means a line may end before character i (the UTF-16
 * index of a code point start). After spaces, after hyphens and dashes, around CJK
 * characters (bar kinsoku), after a zero-width space; never inside a code point.
 */
export function breakOpportunities(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  const cps = codePoints(text);
  for (let k = 1; k < cps.length; k++) {
    const prev = cps[k - 1]!;
    const cur = cps[k]!;
    const pc = String.fromCodePoint(prev.cp);
    const cc = String.fromCodePoint(cur.cp);
    const prevSpace = prev.cp === 0x20 || prev.cp === 0x09 || prev.cp === 0x3000;
    const curSpace = cur.cp === 0x20 || cur.cp === 0x09 || cur.cp === 0x3000;
    let ok = false;
    if (prevSpace && !curSpace) ok = true;
    else if ((pc === '-' || pc === '‐' || pc === '–' || pc === '—') && !curSpace && /\p{L}/u.test(cc)) ok = true;
    else if (prev.cp === 0x200b) ok = true;
    else if ((isCJK(scriptOf(prev.cp)) || isCJK(scriptOf(cur.cp))) && !curSpace && !prevSpace) ok = !NO_START.has(cc) && !NO_END.has(pc);
    if (ok) out[cur.i] = 1;
  }
  out[text.length] = 1;
  return out;
}

export function isSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0xa0 || cp === 0x3000 || (cp >= 0x2000 && cp <= 0x200a);
}
