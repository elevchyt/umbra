/**
 * The editing model's geometry — spec 04 §7: where the caret is drawn for a text index, which
 * index a click lands on, and the rectangles a selection covers. Indices are UTF-16 offsets
 * into the layout's text; a ligature's cluster is split evenly among its characters.
 */
import type { LayoutLine, TextLayout } from './layout.js';

export interface CaretGeom {
  /** Horizontal type: x, and the line's top and bottom. Vertical: y, and the column's sides. */
  line: number;
  at: number;
  from: number;
  to: number;
}

function lineOf(layout: TextLayout, index: number): number {
  const ls = layout.lines;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const next = ls[i + 1];
    // A caret at a line's end belongs to it unless the next line starts there too.
    if (index >= l.start && (index < l.end || !next || next.start > index)) {
      if (next && index >= next.start) continue;
      return i;
    }
  }
  return Math.max(0, ls.length - 1);
}

/** Position along a line of the caret before `index`. */
function along(l: LayoutLine, index: number): number {
  for (const c of l.clusters) {
    if (index < c.start || index >= c.end) continue;
    const f = (index - c.start) / (c.end - c.start);
    return c.rtl ? c.a1 - (c.a1 - c.a0) * f : c.a0 + (c.a1 - c.a0) * f;
  }
  // After the last character: the logical end (the right for LTR lines, the left for RTL).
  if (!l.clusters.length) return l.a0;
  const last = l.clusters.reduce((m, c) => (c.end > m.end ? c : m));
  if (index >= last.end) return last.rtl ? last.a0 : last.a1;
  const first = l.clusters.reduce((m, c) => (c.start < m.start ? c : m));
  return first.rtl ? first.a1 : first.a0;
}

export function caretAt(layout: TextLayout, index: number): CaretGeom {
  const li = lineOf(layout, index);
  const l = layout.lines[li];
  if (!l) return { line: 0, at: 0, from: 0, to: 0 };
  const a = along(l, index);
  return { line: li, at: a, from: l.baseline - l.ascent, to: l.baseline + l.descent };
}

/** The text index nearest a point (document px, in the layout's own space). */
export function hitTest(layout: TextLayout, x: number, y: number): number {
  if (!layout.lines.length) return 0;
  const across = layout.vertical ? x : y;
  const pos = layout.vertical ? y : x;
  let best = layout.lines[0]!;
  let bd = Infinity;
  for (const l of layout.lines) {
    const lo = l.baseline - l.ascent;
    const hi = l.baseline + l.descent;
    const d = across < lo ? lo - across : across > hi ? across - hi : 0;
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  let index = best.start;
  let bdist = Infinity;
  // Candidate caret positions: every cluster boundary, both sides.
  const endIdx = Math.max(best.start, ...best.clusters.map((c) => c.end));
  for (let i = best.start; i <= endIdx; i++) {
    const d = Math.abs(along(best, i) - pos);
    if (d < bdist) {
      bdist = d;
      index = i;
    }
  }
  // Never land between the halves of a surrogate pair.
  const code = layout.text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) index--;
  return index;
}

/** Rectangles covering the text between two indices, in document px. */
export function selectionRects(layout: TextLayout, a: number, b: number): { x0: number; y0: number; x1: number; y1: number }[] {
  const s = Math.min(a, b);
  const e = Math.max(a, b);
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const l of layout.lines) {
    for (const c of l.clusters) {
      if (c.end <= s || c.start >= e) continue;
      const f0 = (Math.max(s, c.start) - c.start) / (c.end - c.start);
      const f1 = (Math.min(e, c.end) - c.start) / (c.end - c.start);
      const p0 = c.rtl ? c.a1 - (c.a1 - c.a0) * f1 : c.a0 + (c.a1 - c.a0) * f0;
      const p1 = c.rtl ? c.a1 - (c.a1 - c.a0) * f0 : c.a0 + (c.a1 - c.a0) * f1;
      const lo = l.baseline - l.ascent;
      const hi = l.baseline + l.descent;
      out.push(layout.vertical ? { x0: lo, x1: hi, y0: p0, y1: p1 } : { x0: p0, x1: p1, y0: lo, y1: hi });
    }
    // A selected line end (the paragraph break) shows as a sliver, as Photoshop draws it.
    if (l.end >= s && l.end < e && layout.text[l.end] === '\n') {
      const p = along(l, l.end);
      out.push(layout.vertical ? { x0: l.baseline - l.ascent, x1: l.baseline + l.descent, y0: p, y1: p + 3 } : { x0: p, x1: p + 3, y0: l.baseline - l.ascent, y1: l.baseline + l.descent });
    }
  }
  return out;
}
