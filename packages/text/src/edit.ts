/**
 * Editing a text spec — the operations behind the type tool's editing session and the
 * Character and Paragraph panels. Indices are UTF-16 offsets into the spec's text; every
 * operation returns a new spec with its runs normalised (no empty runs, equal neighbours
 * merged) and one paragraph style per paragraph.
 */
import { DEFAULT_CHAR, DEFAULT_PARA, styleEq, type CharStyle, type ParaStyle, type TextRun, type TextSpec } from './style.js';

function normalise(runs: TextRun[], fallback: CharStyle): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && (prev.style === r.style || styleEq(prev.style, r.style))) out[out.length - 1] = { text: prev.text + r.text, style: prev.style };
    else out.push(r);
  }
  // An empty text keeps one empty run, so it still has a style to type in.
  return out.length ? out : [{ text: '', style: runs[0]?.style ?? fallback }];
}

export function textOf(spec: TextSpec): string {
  return spec.runs.map((r) => r.text).join('');
}

/** The style typing at `i` continues: the character before it (or the first one). */
export function styleAt(spec: TextSpec, i: number): CharStyle {
  let pos = 0;
  let last = spec.runs[0]?.style ?? DEFAULT_CHAR;
  for (const r of spec.runs) {
    if (r.text.length && i > pos && i <= pos + r.text.length) return r.style;
    if (r.text.length && i === 0) return r.style;
    pos += r.text.length;
    last = r.style;
  }
  return last;
}

/** The paragraph index of a text index. */
export function paragraphAt(spec: TextSpec, i: number): number {
  const t = textOf(spec);
  let n = 0;
  for (let k = 0; k < Math.min(i, t.length); k++) if (t[k] === '\n') n++;
  return n;
}

function paraStyles(spec: TextSpec, count: number): ParaStyle[] {
  const out: ParaStyle[] = [];
  for (let i = 0; i < count; i++) out.push(spec.paragraphs[i] ?? spec.paragraphs[spec.paragraphs.length - 1] ?? DEFAULT_PARA);
  return out;
}

/** Split the runs so `i` falls on a boundary. */
function splitAt(runs: TextRun[], i: number): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runs) {
    if (i > pos && i < pos + r.text.length) {
      out.push({ text: r.text.slice(0, i - pos), style: r.style }, { text: r.text.slice(i - pos), style: r.style });
    } else out.push(r);
    pos += r.text.length;
  }
  return out;
}

/**
 * Replace [s, e) with `str` in `style` (default: the style at s). Paragraph styles follow the
 * text: a new paragraph copies the style of the one it was split from; joining two keeps the
 * first one's.
 */
export function replaceText(spec: TextSpec, s: number, e: number, str: string, style?: CharStyle): TextSpec {
  const text = textOf(spec);
  const a = Math.max(0, Math.min(s, e, text.length));
  const b = Math.min(text.length, Math.max(s, e));
  const st = style ?? styleAt(spec, a);
  let runs = splitAt(splitAt(spec.runs, a), b);
  let pos = 0;
  const next: TextRun[] = [];
  let inserted = false;
  for (const r of runs) {
    const r0 = pos;
    pos += r.text.length;
    if (!inserted && r0 >= a) {
      next.push({ text: str, style: st });
      inserted = true;
    }
    if (r0 >= a && pos <= b && r.text.length) continue;
    next.push(r);
  }
  if (!inserted) next.push({ text: str, style: st });
  runs = normalise(next, st);
  // Paragraphs: those before the edit, the edited one's style for every paragraph the new text
  // makes, then those after.
  const pa = paragraphAt(spec, a);
  const pb = paragraphAt(spec, b);
  const paras = paraStyles(spec, text.split('\n').length);
  const newCount = str.split('\n').length;
  const paragraphs = [...paras.slice(0, pa), ...Array.from({ length: newCount }, () => paras[pa]!), ...paras.slice(pb + 1)];
  return { ...spec, runs, paragraphs };
}

/** Apply a character-style patch to [s, e). */
export function restyleRange(spec: TextSpec, s: number, e: number, patch: Partial<CharStyle>): TextSpec {
  const a = Math.min(s, e);
  const b = Math.max(s, e);
  if (a === b) return spec;
  const runs = splitAt(splitAt(spec.runs, a), b);
  let pos = 0;
  const cache = new Map<CharStyle, CharStyle>();
  const next = runs.map((r) => {
    const r0 = pos;
    pos += r.text.length;
    if (r0 < a || pos > b) return r;
    let st = cache.get(r.style);
    if (!st) {
      st = { ...r.style, ...patch };
      cache.set(r.style, st);
    }
    return { text: r.text, style: st };
  });
  return { ...spec, runs: normalise(next, spec.runs[0]?.style ?? DEFAULT_CHAR) };
}

/** Apply a character-style patch to the whole text (the empty-text run included). */
export function restyleAll(spec: TextSpec, patch: Partial<CharStyle>): TextSpec {
  const cache = new Map<CharStyle, CharStyle>();
  const runs = spec.runs.map((r) => {
    let st = cache.get(r.style);
    if (!st) {
      st = { ...r.style, ...patch };
      cache.set(r.style, st);
    }
    return { text: r.text, style: st };
  });
  return { ...spec, runs: normalise(runs, runs[0]!.style) };
}

/** Apply a paragraph-style patch to every paragraph [s, e) touches. */
export function restyleParagraphs(spec: TextSpec, s: number, e: number, patch: Partial<ParaStyle>): TextSpec {
  const count = textOf(spec).split('\n').length;
  const pa = paragraphAt(spec, Math.min(s, e));
  const pb = paragraphAt(spec, Math.max(s, e));
  const paragraphs = paraStyles(spec, count).map((p, i) => (i >= pa && i <= pb ? { ...p, ...patch } : p));
  return { ...spec, paragraphs };
}

/** The word around an index (double-click), as [start, end). */
export function wordAt(text: string, i: number): [number, number] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ index: number; segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (Seg) {
    for (const s of new Seg(undefined, { granularity: 'word' }).segment(text)) {
      if (i >= s.index && i < s.index + s.segment.length) return [s.index, s.index + s.segment.length];
    }
    return [text.length, text.length];
  }
  const w = /[\p{L}\p{N}_]/u;
  let a = i;
  let b = i;
  while (a > 0 && w.test(text[a - 1]!)) a--;
  while (b < text.length && w.test(text[b]!)) b++;
  return [a, b];
}

/** The next caret stop from `i` in a direction: by character (code point), or by word. */
export function stepCaret(text: string, i: number, dir: 1 | -1, word: boolean): number {
  if (!word) {
    if (dir > 0) {
      if (i >= text.length) return text.length;
      const cp = text.codePointAt(i)!;
      let j = i + (cp > 0xffff ? 2 : 1);
      // Keep combining marks with their base.
      while (j < text.length && /\p{M}/u.test(text[j]!)) j++;
      return j;
    }
    if (i <= 0) return 0;
    let j = i - 1;
    if (j > 0 && /[\udc00-\udfff]/.test(text[j]!)) j--;
    while (j > 0 && /\p{M}/u.test(text[j]!)) j--;
    return j;
  }
  const w = /[\p{L}\p{N}_]/u;
  let j = i;
  if (dir > 0) {
    while (j < text.length && !w.test(text[j]!)) j++;
    while (j < text.length && w.test(text[j]!)) j++;
  } else {
    while (j > 0 && !w.test(text[j - 1]!)) j--;
    while (j > 0 && w.test(text[j - 1]!)) j--;
  }
  return j;
}

/** The paragraph (or forced line) around an index (triple-click): [start, end). */
export function lineRangeAt(text: string, i: number): [number, number] {
  let a = i;
  let b = i;
  while (a > 0 && text[a - 1] !== '\n') a--;
  while (b < text.length && text[b] !== '\n') b++;
  return [a, b];
}
