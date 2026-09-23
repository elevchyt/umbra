/**
 * The line composer — spec 03 §7: HarfBuzz shapes each run (one style, script, face and
 * direction); lines are broken greedily at break opportunities (Photoshop's Single-line
 * Composer; Every-line falls back to it for now); bidi runs are reordered per line; then
 * tracking, kerning, justification, alignment, indents, leading and paragraph spacing place
 * every glyph.
 *
 * Coordinates are document pixels, y down. Point type: the origin is the first baseline at the
 * alignment point (left, centre or right). Paragraph type: the origin is the box's top-left
 * and the first baseline sits one ascent down ([fit]: Photoshop's first-baseline rule is
 * close to the ascent for most fonts). Vertical type runs in columns right to left, the
 * first column centred on x = 0; CJK stands upright, other scripts lie on their side.
 */
import type { FontFace, FontRegistry } from './fonts.js';
import type { HB } from './hb.js';
import { bidiLevels, breakOpportunities, codePoints, isCJK, isSpace, paragraphLevel, reorder, scriptOf, type Script } from './itemize.js';
import { DEFAULT_PARA, SMALL_CAPS, SUB_SHIFT, SUPER_SHIFT, SUPER_SIZE, FAUX_BOLD, FAUX_ITALIC, stylesAt, type CharStyle, type ParaStyle, type Rgb, type TextSpec } from './style.js';

export interface PlacedGlyph {
  face: FontFace;
  gid: number;
  /** The glyph origin (on the baseline), document px. */
  x: number;
  y: number;
  /** px per font unit, and the horizontal and vertical scale factors on top. */
  scale: number;
  sx: number;
  sy: number;
  /** Faux italic slant (x += skew · height) and faux bold growth, px. */
  skew: number;
  bold: number;
  color: Rgb;
  /** Index of the first UTF-16 unit of its cluster in the whole text. */
  cluster: number;
  /** Vertical type: lying on its side (turned 90° clockwise). */
  rotate: boolean;
}

/** A cluster's span along its line, in visual order — for carets and selections. */
export interface CaretCluster {
  start: number;
  end: number;
  /** Extent along the line: x for horizontal type, y for vertical. */
  a0: number;
  a1: number;
  rtl: boolean;
}

export interface LayoutLine {
  start: number;
  end: number;
  paragraph: number;
  /** Horizontal: baseline y. Vertical: the column's centre x. */
  baseline: number;
  /** Where the line's content starts and ends along it. */
  a0: number;
  a1: number;
  ascent: number;
  descent: number;
  rtl: boolean;
  clusters: CaretCluster[];
}

export interface Decoration {
  /** The line it belongs to. */
  line: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: Rgb;
}

export interface TextLayout {
  text: string;
  vertical: boolean;
  glyphs: PlacedGlyph[];
  lines: LayoutLine[];
  decorations: Decoration[];
  /** Ink-agnostic bounds: the line boxes, document px. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Paragraph type whose text does not fit its box: the lines past it are not drawn. */
  overflow: boolean;
}

/** What each character is drawn as: the style with the synthesized positions resolved. */
interface CharProps {
  style: CharStyle;
  face: FontFace;
  size: number;
  shift: number;
  /** Synthesized small caps: this character is drawn as its capital, smaller. */
  caps: boolean;
}

interface Segment {
  start: number;
  end: number;
  level: number;
  script: Script;
  props: CharProps;
  upright: boolean;
  glyphs: ShapedGlyph[];
}

interface ShapedGlyph {
  gid: number;
  cluster: number;
  /** Advance along the line and offsets, px (scales applied). */
  adv: number;
  dx: number;
  dy: number;
}

export interface LayoutOptions {
  registry: FontRegistry;
  hb: HB;
}

function faceFor(reg: FontRegistry, s: CharStyle): FontFace {
  const f = reg.byPostscript(s.font) ?? reg.match(s.family, s.fontStyle) ?? reg.fallbacks[0] ?? reg.faces[0];
  if (!f) throw new Error('No fonts are registered');
  return f;
}

/**
 * The text as drawn: All Caps upper-cases, and so do small caps where the face has none of
 * its own (they are synthesized from the capitals); only where that keeps the length.
 */
function displayText(reg: FontRegistry, text: string, styles: CharStyle[]): string {
  let out = '';
  for (const { cp, i, len } of codePoints(text)) {
    const s = styles[i]!;
    const ch = String.fromCodePoint(cp);
    const up = ch.toUpperCase();
    const synthCaps = s.smallCaps && !faceFor(reg, s).hasFeature('smcp');
    out += (s.allCaps || synthCaps) && up.length === len ? up : ch;
  }
  return out;
}

function propsFor(reg: FontRegistry, s: CharStyle, cp: number, original: number): CharProps {
  let size = s.size;
  let shift = s.baselineShift;
  const face = reg.forChar(cp, faceFor(reg, s));
  // Synthesized small caps: lower-case letters (before upper-casing) drawn as capitals at
  // 70 % — unless the face has real small caps, which the smcp feature then supplies.
  const lower = String.fromCodePoint(original) !== String.fromCodePoint(original).toUpperCase();
  const caps = s.smallCaps && !s.allCaps && lower && !face.hasFeature('smcp');
  if (caps) size *= SMALL_CAPS;
  if (s.position === 'superscript') {
    shift += s.size * SUPER_SHIFT;
    size *= SUPER_SIZE;
  } else if (s.position === 'subscript') {
    shift -= s.size * SUB_SHIFT;
    size *= SUPER_SIZE;
  }
  return { style: s, face, size, shift, caps };
}

const sameProps = (a: CharProps, b: CharProps) => a.style === b.style && a.face === b.face && a.size === b.size && a.shift === b.shift && a.caps === b.caps;

function features(hb: HB, p: CharProps): InstanceType<HB['Feature']>[] {
  const s = p.style;
  const list: [string, number][] = [
    ['kern', typeof s.kerning === 'number' ? 0 : 1],
    ['liga', s.ligatures ? 1 : 0],
    ['clig', s.ligatures ? 1 : 0],
    ['dlig', s.discretionaryLigatures ? 1 : 0],
  ];
  if (s.smallCaps && !s.allCaps && p.face.hasFeature('smcp')) list.push(['smcp', 1]);
  for (const [tag, on] of Object.entries(s.features)) list.push([tag, on ? 1 : 0]);
  return list.map(([t, v]) => new hb.Feature(t, v));
}

function shapeSegment(hb: HB, text: string, seg: Segment, vertical: boolean): ShapedGlyph[] {
  const { face, size, style } = seg.props;
  const buf = new hb.Buffer();
  buf.addText(text, seg.start, seg.end - seg.start);
  const ttb = vertical && seg.upright;
  buf.setDirection(ttb ? hb.Direction.TTB : seg.level & 1 ? hb.Direction.RTL : hb.Direction.LTR);
  if (seg.script !== 'Zyyy') buf.setScript(seg.script);
  buf.setLanguage(style.language || 'en');
  hb.shape(face.hb, buf, features(hb, seg.props));
  const k = size / face.metrics.upem;
  const hs = style.hScale / 100;
  const vs = style.vScale / 100;
  return buf.getGlyphInfosAndPositions().map((g) => {
    const xa = g.xAdvance ?? 0;
    const ya = g.yAdvance ?? 0;
    const xo = g.xOffset ?? 0;
    const yo = g.yOffset ?? 0;
    // Along the line: x advance for horizontal runs, −y advance (HarfBuzz is y up) for TTB.
    return ttb
      ? { gid: g.codepoint, cluster: g.cluster, adv: -ya * k * vs, dx: xo * k * hs, dy: -yo * k * vs }
      : { gid: g.codepoint, cluster: g.cluster, adv: xa * k * hs, dy: -yo * k * vs, dx: xo * k * hs };
  });
}

/** Lay out a text spec. The registry must hold every font the spec names (or a fallback). */
export function layoutText(spec: TextSpec, { registry, hb }: LayoutOptions): TextLayout {
  const full = spec.runs.map((r) => r.text).join('');
  const allStyles = stylesAt(spec);
  const vertical = spec.orientation === 'vertical';
  const glyphs: PlacedGlyph[] = [];
  const lines: LayoutLine[] = [];
  const decorations: Decoration[] = [];
  // Paragraph text wraps in its box; point type only at forced breaks.
  const measure = spec.kind === 'paragraph' && spec.box ? (vertical ? spec.box.height : spec.box.width) : Infinity;

  let pStart = 0;
  let pen = 0; // position of the next baseline (horizontal: y; vertical: −x)
  let firstLine = true;
  const paras = full.split('\n');
  paras.forEach((ptext, pi) => {
    const para: ParaStyle = spec.paragraphs[pi] ?? spec.paragraphs[spec.paragraphs.length - 1] ?? DEFAULT_PARA;
    const off = pStart;
    pStart += ptext.length + 1;
    const styles = allStyles.slice(off, off + ptext.length);
    // An empty paragraph still has a line, in the style of the character that ends it.
    const endStyle = allStyles[off + ptext.length] ?? allStyles[off - 1] ?? spec.runs[0]?.style;
    if (!endStyle) return;
    const shown = displayText(registry, ptext, styles);
    const base = paragraphLevel(ptext, para.direction);
    const levels = bidiLevels(ptext, base);
    const cps = codePoints(shown);
    const origCps = codePoints(ptext);

    // Segments of constant props, script, level and orientation.
    const segs: Segment[] = [];
    let lastScript: Script = 'Zyyy';
    cps.forEach(({ cp, i, len }, k) => {
      const props = propsFor(registry, styles[i]!, cp, origCps[k]!.cp);
      let script = scriptOf(cp);
      if (script === 'Zyyy') script = lastScript;
      else lastScript = script;
      const upright = !vertical || isCJK(scriptOf(cp)) || (scriptOf(cp) === 'Zyyy' && segs.length > 0 && segs[segs.length - 1]!.upright);
      const prev = segs[segs.length - 1];
      if (prev && sameProps(prev.props, props) && (prev.script === script || prev.script === 'Zyyy') && prev.level === levels[i] && prev.upright === upright) {
        prev.end = i + len;
        if (prev.script === 'Zyyy') prev.script = script;
      } else segs.push({ start: i, end: i + len, level: levels[i]!, script, props, upright, glyphs: [] });
    });
    for (const s of segs) s.glyphs = shapeSegment(hb, shown, s, vertical);

    // Advance per cluster (logical), with tracking and manual kerning after it.
    const adv = new Float64Array(ptext.length + 1);
    const clusterStart = new Uint8Array(ptext.length + 1);
    for (const s of segs) for (const g of s.glyphs) {
      adv[g.cluster]! += g.adv;
      clusterStart[g.cluster] = 1;
    }
    for (let i = 0; i < ptext.length; i++) {
      if (!clusterStart[i]) continue;
      const st = styles[i]!;
      let j = i + 1;
      while (j < ptext.length && !clusterStart[j]) j++;
      const lastStyle = styles[j - 1]!;
      adv[i]! += (st.tracking / 1000) * st.size + (typeof lastStyle.kerning === 'number' ? (lastStyle.kerning / 1000) * lastStyle.size : 0);
    }
    const spaceAt = (i: number) => isSpace(ptext.charCodeAt(i));
    const widthOf = (a: number, b: number) => {
      // Trailing spaces hang outside the measure.
      while (b > a && spaceAt(b - 1)) b--;
      let w = 0;
      for (let i = a; i < b; i++) w += adv[i]!;
      return w;
    };

    // Greedy line breaking (plus U+2028, the forced line break within a paragraph).
    const breaks = breakOpportunities(ptext);
    for (let i = 0; i < ptext.length; i++) if (!clusterStart[i]) breaks[i] = 0;
    const ranges: [number, number][] = [];
    let ls = 0;
    const avail = (first: boolean) => measure - para.indentLeft - para.indentRight - (first ? para.indentFirst : 0);
    while (ls <= ptext.length) {
      const hard = ptext.indexOf('\u2028', ls);
      const limit = hard === -1 ? ptext.length : hard;
      let le = limit;
      const room = avail(ranges.length === 0);
      if (widthOf(ls, limit) > room) {
        let lastOk = -1;
        for (let i = ls + 1; i <= limit; i++) {
          if (!breaks[i] && i !== limit) continue;
          if (widthOf(ls, i) <= room) lastOk = i;
          else break;
        }
        if (lastOk === -1) {
          // One word longer than the line: break it at the last cluster that fits.
          lastOk = ls + 1;
          for (let i = ls + 1; i < limit; i++) {
            if (!clusterStart[i]) continue;
            if (widthOf(ls, i) <= room) lastOk = i;
            else break;
          }
          while (lastOk < limit && !clusterStart[lastOk]) lastOk++;
        }
        le = lastOk;
      }
      ranges.push([ls, le]);
      if (le === limit && hard === -1) break;
      ls = le === hard ? le + 1 : le;
      if (ls > ptext.length) break;
    }

    ranges.forEach(([a, b], li) => {
      const lastOfPara = li === ranges.length - 1;
      // Pieces of segments on this line, reordered visually.
      const pieces: { seg: Segment; glyphs: ShapedGlyph[] }[] = [];
      for (const s of segs) {
        if (s.end <= a || s.start >= b) continue;
        const gs = s.glyphs.filter((g) => g.cluster >= a && g.cluster < b && !(g.cluster >= a && isTrailingSpace(g.cluster)));
        if (gs.length) pieces.push({ seg: s, glyphs: gs });
      }
      function isTrailingSpace(c: number): boolean {
        for (let i = c; i < b; i++) if (!spaceAt(i)) return false;
        return true;
      }
      const visual = reorder(pieces, pieces.map((p) => p.seg.level));
      const lineStyles = styles.slice(a, b);
      const sizeMax = Math.max(...(lineStyles.length ? lineStyles : [endStyle]).map((s) => s.size));
      const leadings = (lineStyles.length ? lineStyles : [endStyle]).map((s) => (s.leading === 'auto' ? (s.size * para.autoLeading) / 100 : s.leading));
      const leading = Math.max(...leadings);
      let ascent = 0;
      let descent = 0;
      for (const p of pieces) {
        const m = p.seg.props.face.metrics;
        const k = p.seg.props.size / m.upem;
        ascent = Math.max(ascent, m.ascender * k + p.seg.props.shift);
        descent = Math.max(descent, -m.descender * k - p.seg.props.shift);
      }
      if (!pieces.length) {
        const f = faceFor(registry, endStyle);
        ascent = (f.metrics.ascender * endStyle.size) / f.metrics.upem;
        descent = (-f.metrics.descender * endStyle.size) / f.metrics.upem;
      }

      // Baseline (vertical: the column's centre, as −x). Paragraph type starts one ascent
      // down, or half a column in from the box's right edge.
      if (firstLine) {
        pen = spec.kind !== 'paragraph' ? 0 : vertical ? -((spec.box?.width ?? 0) - sizeMax / 2) : ascent;
        firstLine = false;
      } else pen += leading + (li === 0 ? para.spaceBefore : 0);

      // Width and justification.
      const contentWidth = widthOf(a, b);
      const room = avail(li === 0);
      const justify = para.align.startsWith('justify') && Number.isFinite(room) && (!lastOfPara || para.align === 'justifyAll') && !(b < ptext.length && ptext[b] === '\u2028');
      let extraPerSpace = 0;
      let extraPerCluster = 0;
      if (justify && contentWidth < room) {
        let spaces = 0;
        let clusters = 0;
        let end = b;
        while (end > a && spaceAt(end - 1)) end--;
        for (let i = a; i < end; i++) {
          if (!clusterStart[i]) continue;
          clusters++;
          if (spaceAt(i)) spaces++;
        }
        if (spaces) extraPerSpace = (room - contentWidth) / spaces;
        else if (clusters > 1) extraPerCluster = (room - contentWidth) / (clusters - 1);
      }
      const width = justify && contentWidth < room ? room : contentWidth;
      const lastAlign = para.align === 'justifyCenter' ? 'center' : para.align === 'justifyRight' ? 'right' : 'left';
      const align = para.align.startsWith('justify') ? (justify ? 'left' : lastAlign) : para.align;
      const indent = para.indentLeft + (li === 0 ? para.indentFirst : 0);
      let start: number;
      if (!Number.isFinite(room)) start = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
      else start = indent + (align === 'center' ? (room - width) / 2 : align === 'right' ? room - width : 0);

      // Place glyphs along the line, visual order.
      let cursor = start;
      const clusters: CaretCluster[] = [];
      const colX = -pen; // vertical: this column's centre
      let clusterCount = 0;
      for (const p of visual) {
        const { props, level, upright } = p.seg;
        const st = props.style;
        const face = props.face;
        const k = props.size / face.metrics.upem;
        const rtl = (level & 1) === 1;
        // Group glyphs by cluster, keeping visual order.
        let gi = 0;
        while (gi < p.glyphs.length) {
          const c = p.glyphs[gi]!.cluster;
          let gj = gi;
          while (gj < p.glyphs.length && p.glyphs[gj]!.cluster === c) gj++;
          let cEnd = c + 1;
          while (cEnd < b && !clusterStart[cEnd]) cEnd++;
          const c0 = cursor;
          if (clusterCount > 0 && extraPerCluster) cursor += extraPerCluster;
          clusterCount++;
          for (let g = gi; g < gj; g++) {
            const sg = p.glyphs[g]!;
            let x: number;
            let y: number;
            const rotate = vertical && !upright;
            if (!vertical) {
              x = cursor + sg.dx;
              y = pen + sg.dy - props.shift;
            } else if (upright) {
              x = colX + sg.dx;
              y = cursor + sg.dy;
            } else {
              // On its side: the baseline runs down the column, the glyph centred on it.
              const m = face.metrics;
              const mid = ((m.ascender + m.descender) / 2) * k;
              x = colX - mid - sg.dy + props.shift;
              y = cursor + sg.dx;
            }
            glyphs.push({
              face,
              gid: sg.gid,
              x,
              y,
              scale: k,
              sx: st.hScale / 100,
              sy: st.vScale / 100,
              skew: st.fauxItalic ? FAUX_ITALIC : 0,
              bold: st.fauxBold ? props.size * FAUX_BOLD : 0,
              color: st.color,
              cluster: off + sg.cluster,
              rotate,
            });
            cursor += sg.adv;
          }
          // Tracking and manual kerning follow the cluster.
          cursor += adv[c]! - p.glyphs.slice(gi, gj).reduce((s, g) => s + g.adv, 0);
          if (spaceAt(c)) cursor += extraPerSpace;
          clusters.push({ start: off + c, end: off + cEnd, a0: c0, a1: cursor, rtl });
          gi = gj;
        }
      }
      // Decorations: underline and strikethrough, over each run of styled clusters.
      if (!vertical) {
        for (const cl of clusters) {
          const st = allStyles[cl.start];
          if (!st || (!st.underline && !st.strikethrough)) continue;
          const f = faceFor(registry, st);
          const k = st.size / f.metrics.upem;
          const m = f.metrics;
          if (st.underline) decorations.push({ line: lines.length, x0: cl.a0, x1: cl.a1, y0: pen - m.underlineOffset * k - (m.underlineSize * k) / 2, y1: pen - m.underlineOffset * k + (m.underlineSize * k) / 2, color: st.color });
          if (st.strikethrough) decorations.push({ line: lines.length, x0: cl.a0, x1: cl.a1, y0: pen - m.strikeoutOffset * k - m.strikeoutSize * k, y1: pen - m.strikeoutOffset * k, color: st.color });
        }
      }
      lines.push({ start: off + a, end: off + b, paragraph: pi, baseline: vertical ? colX : pen, a0: start, a1: cursor, ascent, descent, rtl: base === 1, clusters });
      if (lastOfPara) pen += para.spaceAfter;
    });
  });

  // Bounds: the line boxes.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of lines) {
    if (vertical) {
      x0 = Math.min(x0, l.baseline - Math.max(l.ascent, l.descent));
      x1 = Math.max(x1, l.baseline + Math.max(l.ascent, l.descent));
      y0 = Math.min(y0, l.a0);
      y1 = Math.max(y1, l.a1);
    } else {
      x0 = Math.min(x0, l.a0);
      x1 = Math.max(x1, l.a1);
      y0 = Math.min(y0, l.baseline - l.ascent);
      y1 = Math.max(y1, l.baseline + l.descent);
    }
  }
  if (!lines.length) x0 = y0 = x1 = y1 = 0;
  // Paragraph type shows only the lines that fit in its box, as Photoshop does; the rest
  // stays in the text (the caret can still reach it) but is not drawn.
  let overflow = false;
  if (spec.kind === 'paragraph' && spec.box) {
    const limit = vertical ? 0 : spec.box.height;
    const hidden = new Set<number>();
    lines.forEach((l, i) => {
      const out = vertical ? l.baseline - Math.max(l.ascent, l.descent) < limit - 1e-6 : l.baseline + l.descent > limit + 1e-6;
      if (out && i > 0) hidden.add(i);
    });
    if (hidden.size) {
      overflow = true;
      const ranges = [...hidden].map((i) => [lines[i]!.start, lines[i]!.end] as const);
      const inHidden = (c: number) => ranges.some(([a, b]) => c >= a && c < b);
      return {
        text: full,
        vertical,
        glyphs: glyphs.filter((g) => !inHidden(g.cluster)),
        lines,
        decorations: decorations.filter((d) => !hidden.has(d.line)),
        bounds: { x0, y0, x1, y1 },
        overflow,
      };
    }
  }
  return { text: full, vertical, glyphs, lines, decorations, bounds: { x0, y0, x1, y1 }, overflow };
}
