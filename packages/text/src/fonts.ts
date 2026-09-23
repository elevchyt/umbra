/**
 * The font registry — spec 03 §7: faces from the bundled OFL set, from files the user loads,
 * and from the system (Local Font Access, in the app). Each face is parsed once by HarfBuzz;
 * glyph outlines are cached in font units.
 */
import type { Font as HbFont } from 'harfbuzzjs';
import type { HB } from './hb.js';

/** A glyph outline in font units (y up): closed contours of cubic segments, as flat points. */
export interface GlyphOutline {
  /** Each contour: [x0, y0, (c1x, c1y, c2x, c2y, x, y)*]. */
  contours: number[][];
}

export interface FontMetrics {
  upem: number;
  ascender: number;
  descender: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
  underlineOffset: number;
  underlineSize: number;
  strikeoutOffset: number;
  strikeoutSize: number;
}

export class FontFace {
  readonly glyphs = new Map<number, GlyphOutline>();
  private readonly coverage = new Map<number, boolean>();
  constructor(
    readonly id: string,
    readonly family: string,
    readonly style: string,
    readonly postscriptName: string,
    readonly weight: number,
    readonly italic: boolean,
    readonly metrics: FontMetrics,
    readonly hb: HbFont,
    readonly source: 'bundled' | 'user' | 'system',
    private readonly hbApi: HB,
  ) {}

  hasGlyph(cp: number): boolean {
    let v = this.coverage.get(cp);
    if (v === undefined) {
      v = (this.hb.nominalGlyph(cp) ?? 0) !== 0;
      this.coverage.set(cp, v);
    }
    return v;
  }

  /** Does the face have this OpenType feature in GSUB or GPOS? */
  hasFeature(tag: string): boolean {
    const f = this.hb.face;
    return f.getTableFeatureTags('GSUB').includes(tag) || f.getTableFeatureTags('GPOS').includes(tag);
  }

  outline(gid: number): GlyphOutline {
    let o = this.glyphs.get(gid);
    if (o) return o;
    const contours: number[][] = [];
    let cur: number[] | null = null;
    let lx = 0;
    let ly = 0;
    const funcs = new this.hbApi.DrawFuncs();
    funcs.setMoveToFunc((x: number, y: number) => {
      cur = [x, y];
      contours.push(cur);
      lx = x;
      ly = y;
    });
    funcs.setLineToFunc((x: number, y: number) => {
      cur?.push(lx, ly, x, y, x, y);
      lx = x;
      ly = y;
    });
    funcs.setQuadraticToFunc((cx: number, cy: number, x: number, y: number) => {
      // A quadratic raised to a cubic: control points ⅔ of the way to the quadratic's.
      cur?.push(lx + ((cx - lx) * 2) / 3, ly + ((cy - ly) * 2) / 3, x + ((cx - x) * 2) / 3, y + ((cy - y) * 2) / 3, x, y);
      lx = x;
      ly = y;
    });
    funcs.setCubicToFunc((c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
      cur?.push(c1x, c1y, c2x, c2y, x, y);
      lx = x;
      ly = y;
    });
    funcs.setClosePathFunc(() => {
      cur = null;
    });
    this.hb.drawGlyph(gid, funcs);
    o = { contours: contours.filter((c) => c.length > 2) };
    this.glyphs.set(gid, o);
    return o;
  }
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

function weightOf(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  return 400;
}

/** Number of faces in a font file: a TrueType collection says so in its header. */
function faceCount(bytes: Uint8Array): number {
  if (bytes.length >= 12 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  }
  return 1;
}

export class FontRegistry {
  readonly faces: FontFace[] = [];
  /** Faces tried, in order, for characters the chosen face lacks. */
  fallbacks: FontFace[] = [];

  constructor(readonly hb: HB) {}

  /** Add every face in a font file; returns them. */
  add(bytes: Uint8Array, source: FontFace['source'] = 'user'): FontFace[] {
    const hb = this.hb;
    const blob = new hb.Blob(bytes);
    const added: FontFace[] = [];
    const n = faceCount(bytes);
    for (let i = 0; i < n; i++) {
      const face = new hb.Face(blob, i);
      const name = (id: number) => {
        try {
          return face.getName(id, 'en') || '';
        } catch {
          return '';
        }
      };
      // Typographic family/subfamily (16/17) where present, else the legacy ones (1/2).
      const family = name(16) || name(1);
      const style = name(17) || name(2) || 'Regular';
      const ps = name(6) || `${family}-${style}`.replace(/\s+/g, '');
      if (!family) continue;
      if (this.faces.some((f) => f.postscriptName === ps)) continue;
      const font = new hb.Font(face);
      const ext = font.hExtents();
      const m = (tag: number, fb: number) => {
        try {
          return font.getMetricPosition(tag as never) ?? fb;
        } catch {
          return fb;
        }
      };
      const T = hb.MetricsTag;
      const upem = face.upem;
      const metrics: FontMetrics = {
        upem,
        ascender: ext.ascender,
        descender: ext.descender,
        lineGap: ext.lineGap,
        capHeight: m(T.CAP_HEIGHT, upem * 0.7),
        xHeight: m(T.X_HEIGHT, upem * 0.5),
        underlineOffset: m(T.UNDERLINE_OFFSET, -upem * 0.1),
        underlineSize: m(T.UNDERLINE_SIZE, upem * 0.05),
        strikeoutOffset: m(T.STRIKEOUT_OFFSET, upem * 0.25),
        strikeoutSize: m(T.STRIKEOUT_SIZE, upem * 0.05),
      };
      const f = new FontFace(`${source}:${ps}`, family, style, ps, weightOf(style), /italic|oblique/i.test(style), metrics, font, source, hb);
      this.faces.push(f);
      added.push(f);
    }
    return added;
  }

  families(): { family: string; styles: string[] }[] {
    const map = new Map<string, string[]>();
    for (const f of this.faces) map.set(f.family, [...(map.get(f.family) ?? []), f.style]);
    return [...map].map(([family, styles]) => ({ family, styles })).sort((a, b) => a.family.localeCompare(b.family));
  }

  byPostscript(ps: string): FontFace | undefined {
    return this.faces.find((f) => f.postscriptName === ps);
  }

  /** The face for a family and style: exact, else the nearest weight and slant in the family. */
  match(family: string, style = 'Regular'): FontFace | undefined {
    const fam = this.faces.filter((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!fam.length) return undefined;
    const exact = fam.find((f) => f.style.toLowerCase() === style.toLowerCase());
    if (exact) return exact;
    const w = weightOf(style);
    const it = /italic|oblique/i.test(style);
    return [...fam].sort((a, b) => Math.abs(a.weight - w) + (a.italic !== it ? 1000 : 0) - (Math.abs(b.weight - w) + (b.italic !== it ? 1000 : 0)))[0];
  }

  /** A face that has the character: the preferred one, else the first fallback that does. */
  forChar(cp: number, preferred: FontFace): FontFace {
    if (preferred.hasGlyph(cp)) return preferred;
    for (const f of this.fallbacks) if (f.hasGlyph(cp)) return f;
    for (const f of this.faces) if (f.hasGlyph(cp)) return f;
    return preferred;
  }
}
