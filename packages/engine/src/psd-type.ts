/**
 * Type layers in PSD files — spec 07 §1: `TySh` and its EngineData, through ag-psd's decoded
 * text record. Photoshop separates paragraphs with \r and forced line breaks with U+0003;
 * font sizes and lengths are in the text's own space, which `transform` maps to the page.
 * A box's bounds are in that space too; our paragraph origin is the box's top-left.
 */
import { compose, translate, type Mat } from '@umbra/kernels/matrix';
import { DEFAULT_CHAR, DEFAULT_PARA, type AntiAlias, type CharStyle, type ParaStyle, type TextSpec } from '@umbra/text/style';
import type { FontRegistry } from '@umbra/text';
import { WARP_STYLES, type WarpSpec, type WarpStyle } from '@umbra/text/warp';
import type { TypeLayer } from './document.js';

interface AgColor {
  r?: number;
  g?: number;
  b?: number;
}
interface AgTextStyle {
  font?: { name: string };
  fontSize?: number;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  autoLeading?: boolean;
  leading?: number;
  horizontalScale?: number;
  verticalScale?: number;
  tracking?: number;
  autoKerning?: boolean;
  kerning?: number;
  baselineShift?: number;
  fontCaps?: number;
  fontBaseline?: number;
  underline?: boolean;
  strikethrough?: boolean;
  ligatures?: boolean;
  dLigatures?: boolean;
  fillColor?: AgColor;
}
interface AgParaStyle {
  justification?: 'left' | 'right' | 'center' | 'justify-left' | 'justify-right' | 'justify-center' | 'justify-all';
  firstLineIndent?: number;
  startIndent?: number;
  endIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  autoHyphenate?: boolean;
  autoLeading?: number;
  everyLineComposer?: boolean;
  wordSpacing?: number[];
  letterSpacing?: number[];
}
export interface AgText {
  text: string;
  transform?: number[];
  antiAlias?: string;
  orientation?: 'horizontal' | 'vertical';
  style?: AgTextStyle;
  styleRuns?: { length: number; style: AgTextStyle }[];
  paragraphStyle?: AgParaStyle;
  paragraphStyleRuns?: { length: number; style: AgParaStyle }[];
  shapeType?: 'point' | 'box';
  boxBounds?: number[];
  warp?: { style?: string; value?: number; perspective?: number; perspectiveOther?: number; rotate?: 'horizontal' | 'vertical' };
}

const JUST_FROM: Record<string, ParaStyle['align']> = {
  left: 'left',
  right: 'right',
  center: 'center',
  'justify-left': 'justifyLeft',
  'justify-right': 'justifyRight',
  'justify-center': 'justifyCenter',
  'justify-all': 'justifyAll',
};
const JUST_TO = Object.fromEntries(Object.entries(JUST_FROM).map(([k, v]) => [v, k])) as Record<ParaStyle['align'], AgParaStyle['justification']>;

const rgb = (c: AgColor | undefined): [number, number, number] => (c ? [(c.r ?? 0) / 255, (c.g ?? 0) / 255, (c.b ?? 0) / 255] : [0, 0, 0]);

function charFrom(s: AgTextStyle, reg: FontRegistry | null): CharStyle {
  const ps = s.font?.name ?? DEFAULT_CHAR.font;
  const face = reg?.byPostscript(ps);
  return {
    ...DEFAULT_CHAR,
    font: ps,
    family: face?.family ?? ps.split('-')[0] ?? ps,
    fontStyle: face?.style ?? ps.split('-')[1] ?? 'Regular',
    size: s.fontSize ?? DEFAULT_CHAR.size,
    leading: s.autoLeading === false && s.leading ? s.leading : 'auto',
    kerning: s.autoKerning === false ? (s.kerning ?? 0) : 'metrics',
    tracking: s.tracking ?? 0,
    hScale: (s.horizontalScale ?? 1) * 100,
    vScale: (s.verticalScale ?? 1) * 100,
    baselineShift: s.baselineShift ?? 0,
    color: rgb(s.fillColor),
    fauxBold: !!s.fauxBold,
    fauxItalic: !!s.fauxItalic,
    smallCaps: s.fontCaps === 1,
    allCaps: s.fontCaps === 2,
    position: s.fontBaseline === 1 ? 'superscript' : s.fontBaseline === 2 ? 'subscript' : 'normal',
    underline: !!s.underline,
    strikethrough: !!s.strikethrough,
    ligatures: s.ligatures !== false,
    discretionaryLigatures: !!s.dLigatures,
  };
}

function charTo(c: CharStyle): AgTextStyle {
  return {
    font: { name: c.font },
    fontSize: c.size,
    fauxBold: c.fauxBold,
    fauxItalic: c.fauxItalic,
    autoLeading: c.leading === 'auto',
    ...(c.leading === 'auto' ? {} : { leading: c.leading }),
    horizontalScale: c.hScale / 100,
    verticalScale: c.vScale / 100,
    tracking: c.tracking,
    autoKerning: typeof c.kerning !== 'number',
    kerning: typeof c.kerning === 'number' ? c.kerning : 0,
    baselineShift: c.baselineShift,
    fontCaps: c.allCaps ? 2 : c.smallCaps ? 1 : 0,
    fontBaseline: c.position === 'superscript' ? 1 : c.position === 'subscript' ? 2 : 0,
    underline: c.underline,
    strikethrough: c.strikethrough,
    ligatures: c.ligatures,
    dLigatures: c.discretionaryLigatures,
    fillColor: { r: Math.round(c.color[0] * 255), g: Math.round(c.color[1] * 255), b: Math.round(c.color[2] * 255) },
  };
}

function paraFrom(p: AgParaStyle): ParaStyle {
  return {
    ...DEFAULT_PARA,
    align: JUST_FROM[p.justification ?? 'left'] ?? 'left',
    indentLeft: p.startIndent ?? 0,
    indentRight: p.endIndent ?? 0,
    indentFirst: p.firstLineIndent ?? 0,
    spaceBefore: p.spaceBefore ?? 0,
    spaceAfter: p.spaceAfter ?? 0,
    autoLeading: (p.autoLeading ?? 1.2) * 100,
    hyphenate: !!p.autoHyphenate,
    composer: p.everyLineComposer ? 'every' : 'single',
    ...(p.wordSpacing?.length === 3 ? { wordSpacing: p.wordSpacing.map((v) => v * 100) as [number, number, number] } : {}),
    ...(p.letterSpacing?.length === 3 ? { letterSpacing: p.letterSpacing.map((v) => v * 100) as [number, number, number] } : {}),
  };
}

function paraTo(p: ParaStyle): AgParaStyle {
  return {
    justification: JUST_TO[p.align],
    startIndent: p.indentLeft,
    endIndent: p.indentRight,
    firstLineIndent: p.indentFirst,
    spaceBefore: p.spaceBefore,
    spaceAfter: p.spaceAfter,
    autoLeading: p.autoLeading / 100,
    autoHyphenate: p.hyphenate,
    everyLineComposer: p.composer === 'every',
    wordSpacing: p.wordSpacing.map((v) => v / 100),
    letterSpacing: p.letterSpacing.map((v) => v / 100),
  };
}

/** ag-psd's text record → our spec, transform and anti-aliasing (plus what could not be kept). */
export function typeFromPsd(raw: unknown, reg: FontRegistry | null): { text: TextSpec; transform: Mat; antiAlias: AntiAlias; lost: string[] } {
  const t = raw as AgText;
  const lost: string[] = [];
  // Photoshop's paragraph and line separators → ours.
  const text = t.text.replace(/\r\n?/g, '\n').replace(/\u0003/g, '\u2028');
  const base = t.style ?? {};
  const runs: TextSpec['runs'] = [];
  let pos = 0;
  for (const r of t.styleRuns ?? [{ length: text.length, style: {} }]) {
    const len = Math.min(r.length, text.length - pos);
    if (len > 0) runs.push({ text: text.slice(pos, pos + len), style: charFrom({ ...base, ...r.style }, reg) });
    pos += r.length;
  }
  if (pos < text.length) runs.push({ text: text.slice(pos), style: charFrom(base, reg) });
  if (!runs.length) runs.push({ text: '', style: charFrom(base, reg) });
  // One paragraph style per paragraph: each run covers whole paragraphs.
  const paraBase = t.paragraphStyle ?? {};
  const paragraphs: ParaStyle[] = [];
  const paraCount = text.split('\n').length;
  let p0 = 0;
  for (const r of t.paragraphStyleRuns ?? [{ length: text.length + 1, style: {} }]) {
    const seg = text.slice(p0, p0 + r.length);
    const n = Math.max(1, seg.split('\n').length - (seg.endsWith('\n') ? 1 : 0));
    for (let i = 0; i < n && paragraphs.length < paraCount; i++) paragraphs.push(paraFrom({ ...paraBase, ...r.style }));
    p0 += r.length;
  }
  while (paragraphs.length < paraCount) paragraphs.push(paraFrom(paraBase));
  const m = t.transform ?? [1, 0, 0, 1, 0, 0];
  let transform: Mat = { a: m[0]!, b: m[1]!, c: m[2]!, d: m[3]!, e: m[4]!, f: m[5]! };
  let box: TextSpec['box'];
  if (t.shapeType === 'box' && t.boxBounds?.length === 4) {
    const [l, top, r, b] = t.boxBounds as [number, number, number, number];
    box = { width: r - l, height: b - top };
    transform = compose(translate(l, top), transform);
  }
  let warp: WarpSpec | undefined;
  const ws = t.warp?.style;
  if (ws && ws !== 'none') {
    if (WARP_STYLES.some((x) => x.value === ws)) warp = { style: ws as WarpStyle, bend: t.warp!.value ?? 0, hDistort: t.warp!.perspective ?? 0, vDistort: t.warp!.perspectiveOther ?? 0, orientation: t.warp!.rotate === 'vertical' ? 'vertical' : 'horizontal' };
    else lost.push(`warp (${ws}) — drawn unwarped when edited`);
  }
  const aa = (t.antiAlias ?? 'sharp') as string;
  const antiAlias: AntiAlias = aa === 'none' || aa === 'crisp' || aa === 'strong' || aa === 'smooth' ? aa : 'sharp';
  const spec: TextSpec = { kind: box ? 'paragraph' : 'point', orientation: t.orientation === 'vertical' ? 'vertical' : 'horizontal', ...(box ? { box } : {}), ...(warp ? { warp } : {}), runs, paragraphs };
  return { text: spec, transform, antiAlias, lost };
}

/** A type layer → ag-psd's text record. */
export function typeToPsd(l: TypeLayer, source?: unknown): AgText {
  const spec = l.text;
  const text = spec.runs.map((r) => r.text).join('');
  const m = l.transform;
  // Our paragraph origin is the box's top-left, so the box sits at the text space's origin.
  const boxBounds = spec.kind === 'paragraph' && spec.box ? [0, 0, spec.box.width, spec.box.height] : undefined;
  const src = (source ?? {}) as Partial<AgText>;
  const paraRuns: { length: number; style: AgParaStyle }[] = [];
  text.split('\n').forEach((p, i) => paraRuns.push({ length: p.length + 1, style: paraTo(spec.paragraphs[i] ?? spec.paragraphs[0] ?? DEFAULT_PARA) }));
  return {
    ...(spec.warp
      ? { warp: { ...(src.warp ?? {}), style: spec.warp.style, value: spec.warp.bend, perspective: spec.warp.hDistort, perspectiveOther: spec.warp.vDistort, rotate: spec.warp.orientation } }
      : { warp: { style: 'none', value: 0, perspective: 0, perspectiveOther: 0, rotate: 'horizontal' } }),
    text: text.replace(/\u2028/g, '\u0003').replace(/\n/g, '\r'),
    transform: [m.a, m.b, m.c, m.d, m.e, m.f],
    antiAlias: l.antiAlias,
    orientation: spec.orientation,
    style: charTo(spec.runs[0]?.style ?? DEFAULT_CHAR),
    styleRuns: spec.runs.filter((r) => r.text.length).map((r) => ({ length: r.text.length, style: charTo(r.style) })),
    paragraphStyle: paraTo(spec.paragraphs[0] ?? DEFAULT_PARA),
    paragraphStyleRuns: paraRuns,
    shapeType: boxBounds ? 'box' : 'point',
    ...(boxBounds ? { boxBounds } : {}),
  };
}
