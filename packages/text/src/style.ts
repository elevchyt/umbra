/**
 * The text model — spec 02 §6. Sizes are document pixels: the engine works at 72 ppi, where a
 * point is a pixel, as a new Photoshop document is.
 */
export type AntiAlias = 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth';
export type Rgb = [number, number, number];

export interface CharStyle {
  /** PostScript name of the face; the family/style pair is kept for a missing-font prompt. */
  font: string;
  family: string;
  fontStyle: string;
  size: number;
  /** 'auto' is Auto Leading × the largest size on the line. */
  leading: number | 'auto';
  /** Metrics: the font's kerning; optical is metrics here ([fit]); a number is 1/1000 em after the character. */
  kerning: 'metrics' | 'optical' | number;
  /** 1/1000 em after every character. */
  tracking: number;
  /** Horizontal and vertical scale, %. */
  hScale: number;
  vScale: number;
  baselineShift: number;
  color: Rgb;
  fauxBold: boolean;
  fauxItalic: boolean;
  allCaps: boolean;
  smallCaps: boolean;
  position: 'normal' | 'superscript' | 'subscript';
  underline: boolean;
  strikethrough: boolean;
  ligatures: boolean;
  discretionaryLigatures: boolean;
  /** Further OpenType features: tag → on. */
  features: Record<string, boolean>;
  language: string;
}

export interface ParaStyle {
  align: 'left' | 'center' | 'right' | 'justifyLeft' | 'justifyCenter' | 'justifyRight' | 'justifyAll';
  indentLeft: number;
  indentRight: number;
  indentFirst: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Auto Leading, %. */
  autoLeading: number;
  hyphenate: boolean;
  /** Word spacing min/desired/max, % of a space (justification). */
  wordSpacing: [number, number, number];
  letterSpacing: [number, number, number];
  composer: 'single' | 'every';
  /** Paragraph direction: from the first strong character, or forced. */
  direction: 'auto' | 'ltr' | 'rtl';
}

export interface TextRun {
  text: string;
  style: CharStyle;
}

export interface TextSpec {
  /** Point type grows from its origin; paragraph type wraps in its box. */
  kind: 'point' | 'paragraph';
  orientation: 'horizontal' | 'vertical';
  /** Paragraph type: the box's size (its origin is the layout origin). */
  box?: { width: number; height: number };
  runs: TextRun[];
  /** One per paragraph (text separated by \n), in order; missing ones take the defaults. */
  paragraphs: ParaStyle[];
}

export const DEFAULT_CHAR: CharStyle = {
  font: 'NotoSans-Regular',
  family: 'Noto Sans',
  fontStyle: 'Regular',
  size: 12,
  leading: 'auto',
  kerning: 'metrics',
  tracking: 0,
  hScale: 100,
  vScale: 100,
  baselineShift: 0,
  color: [0, 0, 0],
  fauxBold: false,
  fauxItalic: false,
  allCaps: false,
  smallCaps: false,
  position: 'normal',
  underline: false,
  strikethrough: false,
  ligatures: true,
  discretionaryLigatures: false,
  features: {},
  language: 'en',
};

export const DEFAULT_PARA: ParaStyle = {
  align: 'left',
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  autoLeading: 120,
  hyphenate: false,
  wordSpacing: [80, 100, 133],
  letterSpacing: [0, 0, 0],
  composer: 'single',
  direction: 'auto',
};

/**
 * Photoshop's Type preferences for the synthesized positions and small caps: superscript
 * and subscript at 58.3 % size, raised or lowered by 33.3 % of the size; small caps at 70 %.
 */
export const SUPER_SIZE = 0.583;
export const SUPER_SHIFT = 0.333;
export const SUB_SHIFT = 0.333;
export const SMALL_CAPS = 0.7;
/** Faux italic's slant, as tan(angle): [fit] ≈ 12°, what Photoshop's looks like. */
export const FAUX_ITALIC = 0.21;
/** Faux bold's outline growth as a fraction of the size [fit]. */
export const FAUX_BOLD = 0.025;

export function styleEq(a: CharStyle, b: CharStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The plain text of a spec. */
export function specText(spec: TextSpec): string {
  return spec.runs.map((r) => r.text).join('');
}

/** The style at each UTF-16 index of the text. */
export function stylesAt(spec: TextSpec): CharStyle[] {
  const out: CharStyle[] = [];
  for (const r of spec.runs) for (let i = 0; i < r.text.length; i++) out.push(r.style);
  return out;
}
