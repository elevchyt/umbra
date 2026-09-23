import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rasterizePath } from '@umbra/kernels/vector/raster';
import { loadHarfBuzz, type HB } from './hb.js';
import { FontRegistry } from './fonts.js';
import { DEFAULT_CHAR, DEFAULT_PARA, type CharStyle, type ParaStyle, type TextSpec } from './style.js';
import { layoutText, type TextLayout } from './layout.js';
import { inkBounds, layoutToPath, renderLayout } from './outline.js';
import { caretAt, hitTest, selectionRects } from './caret.js';
import { BUNDLED_FONTS, loadBundledFonts } from './bundled.js';
import { bidiLevels, breakOpportunities, paragraphLevel, reorder } from './itemize.js';

const font = (f: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fonts/${f}`, import.meta.url))));
const CJK = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';

let hb: HB;
let reg: FontRegistry;
beforeAll(async () => {
  hb = await loadHarfBuzz();
  reg = new FontRegistry(hb);
  for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf', 'NotoSansArabic-Regular.ttf', 'NotoSansHebrew-Regular.ttf', 'NotoSansDevanagari-Regular.ttf']) reg.add(font(f), 'bundled');
  if (existsSync(CJK)) reg.add(new Uint8Array(readFileSync(CJK)), 'system');
  reg.fallbacks = reg.faces.filter((f) => f.style === 'Regular');
});

const style = (over: Partial<CharStyle> = {}): CharStyle => ({ ...DEFAULT_CHAR, size: 40, ...over });
const spec = (text: string, over: Partial<CharStyle> = {}, para: Partial<ParaStyle> = {}, rest: Partial<TextSpec> = {}): TextSpec => ({
  kind: 'point',
  orientation: 'horizontal',
  runs: [{ text, style: style(over) }],
  paragraphs: [{ ...DEFAULT_PARA, ...para }],
  ...rest,
});
const lay = (s: TextSpec): TextLayout => layoutText(s, { registry: reg, hb });
const width = (l: TextLayout) => l.lines[0]!.a1 - l.lines[0]!.a0;

describe('fonts', () => {
  it('the bundled set loads through its URLs', async () => {
    const r = new FontRegistry(hb);
    await loadBundledFonts(r, async (u) => {
      const b = readFileSync(fileURLToPath(u));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    });
    expect(r.faces).toHaveLength(BUNDLED_FONTS.length);
    expect(r.fallbacks.map((f) => f.family)).toEqual(['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari']);
  });

  it('reads names and matches styles', () => {
    expect(reg.families().find((f) => f.family === 'Noto Sans')?.styles.sort()).toEqual(['Bold', 'Bold Italic', 'Italic', 'Regular']);
    expect(reg.match('Noto Sans', 'Semibold')?.style).toBe('Bold');
    expect(reg.match('noto sans', 'Light Italic')?.style).toBe('Italic');
    expect(reg.byPostscript('NotoSans-Bold')?.weight).toBe(700);
    const f = reg.byPostscript('NotoSans-Regular')!;
    expect(f.metrics.upem).toBe(1000);
    expect(f.metrics.capHeight).toBeGreaterThan(600);
    expect(f.outline(f.hb.nominalGlyph(0x6f)!).contours).toHaveLength(2);
  });
});

describe('Latin: kerning, ligatures, tracking', () => {
  it('metrics kerning tightens AV; a numeric kerning of 0 turns it off', () => {
    const kerned = width(lay(spec('AV')));
    const plain = width(lay(spec('AV', { kerning: 0 })));
    expect(kerned).toBeLessThan(plain - 0.5);
  });

  it('fi ligates unless ligatures are off', () => {
    expect(lay(spec('fi')).glyphs).toHaveLength(1);
    expect(lay(spec('fi', { ligatures: false })).glyphs).toHaveLength(2);
  });

  it('tracking adds 1/1000 em after each character', () => {
    const a = width(lay(spec('Hello')));
    const b = width(lay(spec('Hello', { tracking: 100 })));
    expect(b - a).toBeCloseTo(5 * 0.1 * 40, 6);
  });

  it('manual kerning after a character, and horizontal scale', () => {
    const a = width(lay(spec('Ab', { kerning: 0 })));
    const s = spec('Ab');
    s.runs = [{ text: 'A', style: style({ kerning: -200 }) }, { text: 'b', style: style({ kerning: 0 }) }];
    expect(width(lay(s))).toBeCloseTo(a - 8, 6);
    expect(width(lay(spec('Ab', { hScale: 50, kerning: 0 })))).toBeCloseTo(a / 2, 6);
  });
});

describe('lines: leading, wrapping, alignment, justification', () => {
  it('auto leading is 120 % of the size; a set leading wins', () => {
    const l = lay(spec('one\ntwo\u2028three'));
    expect(l.lines).toHaveLength(3);
    expect(l.lines[1]!.baseline - l.lines[0]!.baseline).toBeCloseTo(48, 6);
    expect(l.lines[2]!.baseline - l.lines[1]!.baseline).toBeCloseTo(48, 6);
    const fixed = lay(spec('one\ntwo', { leading: 60 }));
    expect(fixed.lines[1]!.baseline - fixed.lines[0]!.baseline).toBeCloseTo(60, 6);
    const spaced = lay(spec('one\ntwo', {}, { spaceBefore: 10, spaceAfter: 5 }));
    expect(spaced.lines[1]!.baseline - spaced.lines[0]!.baseline).toBeCloseTo(48 + 15, 6);
  });

  it('point type aligns about its origin', () => {
    const w = width(lay(spec('Centre')));
    expect(lay(spec('Centre', {}, { align: 'center' })).lines[0]!.a0).toBeCloseTo(-w / 2, 6);
    expect(lay(spec('Centre', {}, { align: 'right' })).lines[0]!.a1).toBeCloseTo(0, 6);
  });

  it('paragraph type wraps inside its box and justifies all but the last line', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps on running far away';
    const box = { width: 300, height: 400 };
    const l = lay(spec(text, { size: 24 }, { align: 'justifyLeft', indentLeft: 10, indentRight: 10 }, { kind: 'paragraph', box }));
    expect(l.lines.length).toBeGreaterThan(2);
    const last = l.lines[l.lines.length - 1]!;
    for (const line of l.lines) {
      expect(line.a0).toBeCloseTo(10, 6);
      if (line !== last) expect(line.a1).toBeCloseTo(290, 4);
    }
    expect(last.a1).toBeLessThan(290);
    // Lines break at spaces: every line but the first starts on a word.
    for (const line of l.lines.slice(1)) expect(text[line.start - 1]).toBe(' ');
    expect(l.lines[0]!.baseline).toBeCloseTo(24 * 1.069, 3);
  });

  it('paragraph type draws only the lines that fit its box', () => {
    const text = 'one two three four five six seven eight nine ten';
    const l = lay(spec(text, { size: 20, underline: true }, {}, { kind: 'paragraph', box: { width: 90, height: 55 } }));
    expect(l.overflow).toBe(true);
    // 20 px type, 24 px leading: two lines fit in 55 px.
    const shown = new Set(l.glyphs.map((g) => l.lines.findIndex((ln) => g.cluster >= ln.start && g.cluster < ln.end)));
    expect([...shown].sort()).toEqual([0, 1]);
    expect(new Set(l.decorations.map((d) => d.line))).toEqual(new Set([0, 1]));
    expect(lay(spec(text, { size: 20 }, {}, { kind: 'paragraph', box: { width: 90, height: 500 } })).overflow).toBe(false);
  });

  it('a word longer than the line breaks inside it', () => {
    const l = lay(spec('Supercalifragilistic', { size: 30 }, {}, { kind: 'paragraph', box: { width: 100, height: 300 } }));
    expect(l.lines.length).toBeGreaterThan(2);
    for (const line of l.lines) expect(line.a1 - line.a0).toBeLessThanOrEqual(100 + 1e-6);
  });
});

describe('bidi and complex scripts', () => {
  it('resolves levels and reorders', () => {
    expect(paragraphLevel('שלום world')).toBe(1);
    expect(paragraphLevel('hello שלום')).toBe(0);
    expect(Array.from(bidiLevels('ab שלום 12', 0))).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
    expect(reorder(['a', 'b', 'c', 'd'], [0, 1, 1, 0])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('Hebrew in an RTL paragraph reads right to left, with Latin inside it left to right', () => {
    const l = lay(spec('שלום world'));
    const at = (i: number) => l.glyphs.find((g) => g.cluster === i)!.x;
    // The first Hebrew letter is rightmost of the Hebrew; the Latin run sits to its left.
    expect(at(0)).toBeGreaterThan(at(3));
    expect(at(5)).toBeLessThan(at(3));
    expect(at(5)).toBeLessThan(at(9));
    expect(l.lines[0]!.rtl).toBe(true);
  });

  it('Arabic letters join: contextual forms differ from isolated ones, and lam-alef ligates', () => {
    const word = lay(spec('سلام'));
    // س ل ا م: lam and alef become one lam-alef glyph.
    expect(word.glyphs).toHaveLength(3);
    const alone = lay(spec('س')).glyphs[0]!.gid;
    // Joined, the first letter (drawn rightmost) takes its initial form.
    const first = word.glyphs.find((g) => g.cluster === 0)!;
    expect(first.gid).not.toBe(alone);
    expect(first.x).toBe(Math.max(...word.glyphs.map((g) => g.x)));
  });

  it('Devanagari reorders the i-matra before its consonant', () => {
    const l = lay(spec('कि'));
    expect(l.glyphs).toHaveLength(2);
    const ka = lay(spec('क')).glyphs[0]!.gid;
    const [left, right] = [...l.glyphs].sort((a, b) => a.x - b.x);
    // Drawn left of the consonant it follows in the text.
    expect(left!.gid).not.toBe(ka);
    expect(right!.gid).toBe(ka);
    expect(l.glyphs.every((g) => g.face.family === 'Noto Sans Devanagari')).toBe(true);
  });

  it.skipIf(!existsSync(CJK))('CJK: full-width advances, breaks between ideographs, no 。 at a line start', () => {
    const l = lay(spec('漢字漢字', { size: 20 }));
    expect(width(l)).toBeCloseTo(80, 3);
    const text = '日本語の文章を折り返します。これは試験です。';
    const w = lay(spec(text, { size: 20 }, {}, { kind: 'paragraph', box: { width: 130, height: 400 } }));
    expect(w.lines.length).toBeGreaterThan(2);
    for (const line of w.lines) expect(text[line.start]).not.toBe('。');
    const ops = breakOpportunities('漢字。漢');
    expect(Array.from(ops.slice(0, 4))).toEqual([0, 1, 0, 1]);
  });

  it.skipIf(!existsSync(CJK))('vertical type: CJK stands upright down the column; Latin lies on its side', () => {
    const l = lay(spec('漢字ab', { size: 20 }, {}, { orientation: 'vertical' }));
    const han = l.glyphs.filter((g) => !g.rotate);
    const lat = l.glyphs.filter((g) => g.rotate);
    expect(han).toHaveLength(2);
    expect(lat).toHaveLength(2);
    expect(han[1]!.y - han[0]!.y).toBeCloseTo(20, 3);
    // Two ems down the column the Latin starts; the column's ink starts at the top.
    expect(lat[0]!.y).toBeCloseTo(40, 3);
    expect(inkBounds(l)!.y0).toBeGreaterThan(-1);
    expect(inkBounds(l)!.y1).toBeGreaterThan(40);
  });
});

describe('carets and selections', () => {
  it('caret positions and hit-testing round-trip, LTR and RTL', () => {
    for (const text of ['Hello there', 'שלום עולם']) {
      const l = lay(spec(text));
      for (let i = 0; i <= text.length; i++) {
        const c = caretAt(l, i);
        expect(hitTest(l, c.at, l.lines[0]!.baseline - 5)).toBe(i);
      }
    }
    const rtl = lay(spec('שלום'));
    expect(caretAt(rtl, 0).at).toBeGreaterThan(caretAt(rtl, 4).at);
  });

  it('a ligature cluster splits its caret stops', () => {
    const l = lay(spec('fi'));
    const a = caretAt(l, 0).at;
    const b = caretAt(l, 1).at;
    const c = caretAt(l, 2).at;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('selection rectangles cover the selected clusters on each line', () => {
    const l = lay(spec('ab\ncd'));
    const r = selectionRects(l, 1, 4);
    // "b", the paragraph break sliver, and "c".
    expect(r).toHaveLength(3);
    expect(r[2]!.y0).toBeGreaterThan(r[0]!.y0);
  });
});

describe('outlines and pixels', () => {
  const box = (l: TextLayout) => {
    const b = inkBounds(l)!;
    return { x0: Math.floor(b.x0) - 2, y0: Math.floor(b.y0) - 2, x1: Math.ceil(b.x1) + 2, y1: Math.ceil(b.y1) + 2 };
  };
  const alphaSum = (bmp: { data: Uint8Array }) => {
    let s = 0;
    for (let i = 3; i < bmp.data.length; i += 4) s += bmp.data[i]! / 255;
    return s;
  };

  it("an 'o' has its counter; None anti-aliasing is bilevel", () => {
    const l = lay(spec('o', { size: 60, color: [1, 0, 0] }));
    const r = box(l);
    const bmp = renderLayout(l, r, 'none');
    const g = l.glyphs[0]!;
    const cx = Math.round(g.x + (g.face.hb.glyphHAdvance(g.gid) * g.scale) / 2) - r.x0;
    const cy = Math.round(g.y - 60 * 0.27) - r.y0;
    expect(bmp.data[(cy * bmp.width + cx) * 4 + 3]).toBe(0);
    for (let i = 3; i < bmp.data.length; i += 4) expect([0, 255]).toContain(bmp.data[i]);
    expect(Array.from(bmp.data.slice(0, 0))).toEqual([]);
    const px = Array.from(bmp.data).findIndex((v, i) => i % 4 === 3 && v === 255);
    expect(Array.from(bmp.data.slice(px - 3, px + 1))).toEqual([255, 0, 0, 255]);
  });

  it('the outline path fills to the same pixels as the rendering', () => {
    const l = lay(spec('Type & Ink', { size: 40 }));
    const r = box(l);
    const smooth = alphaSum(renderLayout(l, r, 'smooth'));
    const cov = rasterizePath(layoutToPath(l), r).reduce((s, v) => s + v, 0);
    expect(Math.abs(smooth - cov) / smooth).toBeLessThan(0.005);
  });

  it('faux bold adds ink; faux italic leans; Strong is heavier than Sharp', () => {
    const base = lay(spec('l', { size: 60 }));
    const r = box(base);
    const wide = { ...r, x0: r.x0 - 20, x1: r.x1 + 20 };
    const plain = alphaSum(renderLayout(base, wide, 'smooth'));
    expect(alphaSum(renderLayout(lay(spec('l', { size: 60, fauxBold: true })), wide, 'smooth'))).toBeGreaterThan(plain * 1.2);
    const it_ = inkBounds(lay(spec('l', { size: 60, fauxItalic: true })))!;
    expect(it_.x1).toBeGreaterThan(inkBounds(base)!.x1 + 5);
    expect(alphaSum(renderLayout(base, wide, 'strong'))).toBeGreaterThan(alphaSum(renderLayout(base, wide, 'sharp')));
  });

  it('superscript is smaller and raised; underline draws a bar under the text', () => {
    const s = spec('x2');
    s.runs = [{ text: 'x', style: style() }, { text: '2', style: style({ position: 'superscript' }) }];
    const l = lay(s);
    const [x, two] = l.glyphs;
    expect(two!.scale).toBeCloseTo(x!.scale * 0.583, 6);
    expect(two!.y).toBeCloseTo(x!.y - 40 * 0.333, 6);
    const u = lay(spec('under', { underline: true }));
    expect(u.decorations.length).toBeGreaterThan(0);
    expect(u.decorations[0]!.y0).toBeGreaterThan(u.lines[0]!.baseline);
  });

  it("small caps: the face's own where it has them, else capitals at 70 %", () => {
    const face = reg.byPostscript('NotoSans-Regular')!;
    expect(face.hasFeature('smcp')).toBe(true);
    const real = lay(spec('Ab', { smallCaps: true }));
    const capB = lay(spec('B')).glyphs[0]!.gid;
    const lowB = lay(spec('b')).glyphs[0]!.gid;
    expect(real.glyphs[1]!.gid).not.toBe(capB);
    expect(real.glyphs[1]!.gid).not.toBe(lowB);
    const has = face.hasFeature;
    face.hasFeature = () => false;
    try {
      const synth = lay(spec('Ab', { smallCaps: true }));
      expect(synth.glyphs[1]!.gid).toBe(capB);
      expect(synth.glyphs[1]!.scale / synth.glyphs[0]!.scale).toBeCloseTo(0.7, 6);
    } finally {
      face.hasFeature = has;
    }
  });
});

describe('warp text', () => {
  it('no bend and no distortion leaves every style unchanged', async () => {
    const { warpMap, WARP_STYLES } = await import('./warp.js');
    const box = { x0: 0, y0: -30, x1: 200, y1: 10 };
    for (const { value } of WARP_STYLES) {
      const f = warpMap({ style: value, bend: 0, hDistort: 0, vDistort: 0, orientation: 'horizontal' }, box);
      for (const p of [{ x: 10, y: -5 }, { x: 150, y: 8 }, { x: 100, y: -10 }]) {
        const q = f(p);
        expect(q.x).toBeCloseTo(p.x, 6);
        expect(q.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('Arc lifts the ends below the middle; the warped path fills what is drawn', async () => {
    const { warpMap } = await import('./warp.js');
    const box = { x0: 0, y0: -30, x1: 200, y1: 10 };
    const f = warpMap({ style: 'arc', bend: 50, hDistort: 0, vDistort: 0, orientation: 'horizontal' }, box);
    const mid = f({ x: 100, y: -10 });
    const end = f({ x: 0, y: -10 });
    expect(mid.x).toBeCloseTo(100, 6);
    expect(mid.y).toBeCloseTo(-10, 6);
    expect(end.y).toBeGreaterThan(mid.y + 10);
    const s = spec('Warped words', { size: 40 });
    s.warp = { style: 'arc', bend: 50, hDistort: 10, vDistort: -10, orientation: 'horizontal' };
    const l = lay(s);
    const b = inkBounds(l)!;
    const r = { x0: Math.floor(b.x0) - 2, y0: Math.floor(b.y0) - 2, x1: Math.ceil(b.x1) + 2, y1: Math.ceil(b.y1) + 2 };
    let drawn = 0;
    const bmp = renderLayout(l, r, 'smooth');
    for (let i = 3; i < bmp.data.length; i += 4) drawn += bmp.data[i]! / 255;
    const cov = rasterizePath(layoutToPath(l), r).reduce((a, v) => a + v, 0);
    expect(Math.abs(drawn - cov) / drawn).toBeLessThan(0.01);
    // The bend shows in the ink: the arc's ends reach well below the flat text's.
    expect(b.y1 - b.y0).toBeGreaterThan((inkBounds(lay(spec('Warped words', { size: 40 })))!.y1 - inkBounds(lay(spec('Warped words', { size: 40 })))!.y0) * 1.5);
  });
});

describe('type on a path and in a shape', () => {
  const circle = (cx: number, cy: number, r: number) => {
    const k = 0.5522847498 * r;
    const K = (x: number, y: number, ix: number, iy: number, ox: number, oy: number) => ({ anchor: { x, y }, in: { x: ix, y: iy }, out: { x: ox, y: oy }, smooth: true });
    return {
      subpaths: [
        {
          closed: true,
          op: 'add' as const,
          knots: [K(cx, cy - r, cx - k, cy - r, cx + k, cy - r), K(cx + r, cy, cx + r, cy - k, cx + r, cy + k), K(cx, cy + r, cx + k, cy + r, cx - k, cy + r), K(cx - r, cy, cx - r, cy + k, cx - r, cy - k)],
        },
      ],
    };
  };

  it('area type fits every line inside the shape', () => {
    const text = 'Words flow inside the circle and wrap to its edge on every line until it is full of text';
    const s = spec(text, { size: 14 }, { align: 'center' }, { kind: 'inShape', shape: circle(100, 100, 80) });
    const l = lay(s);
    expect(l.lines.length).toBeGreaterThan(4);
    for (const line of l.lines) {
      const y0 = line.baseline - line.ascent;
      const y1 = line.baseline + line.descent;
      for (const y of [y0, y1]) {
        const half = Math.sqrt(Math.max(0, 80 * 80 - (y - 100) ** 2));
        if (line.a1 > line.a0) {
          expect(line.a0).toBeGreaterThanOrEqual(100 - half - 0.5);
          expect(line.a1).toBeLessThanOrEqual(100 + half + 0.5);
        }
      }
    }
    // The first line starts just inside the top of the circle.
    expect(l.lines[0]!.baseline - l.lines[0]!.ascent).toBeGreaterThanOrEqual(20);
  });

  it('type on a path follows it, turned to the tangent; what does not fit is dropped', () => {
    const arc = { subpaths: [{ closed: false, op: 'add' as const, knots: [{ anchor: { x: 0, y: 100 }, in: { x: 0, y: 100 }, out: { x: 0, y: 45 }, smooth: false }, { anchor: { x: 100, y: 0 }, in: { x: 45, y: 0 }, out: { x: 100, y: 0 }, smooth: false }] }] };
    const l = lay(spec('Along the curve and beyond its end', { size: 12 }, {}, { kind: 'onPath', path: arc, pathStart: 5 }));
    expect(l.path).toBeDefined();
    expect(l.overflow).toBe(true);
    const g = l.glyphs;
    // Early glyphs climb the left side (tangent pointing up), later ones run right.
    expect(g[0]!.along!.sin).toBeLessThan(-0.5);
    expect(g[g.length - 1]!.along!.cos).toBeGreaterThan(0.5);
    // Every glyph centre is on the curve's quarter circle (radius ≈ 100 about (100, 100)).
    for (const x of g) expect(Math.abs(Math.hypot(x.along!.x - 100, x.along!.y - 100) - 100)).toBeLessThan(6);
  });
});
