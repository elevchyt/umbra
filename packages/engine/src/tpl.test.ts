import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ByteWriter, bool, en, list, long, obj, pct, px, ang, text, writeDescriptor, type DV } from './descriptor-writer.js';
import { readTplFile, writeTplFile, type ToolPresetExport } from './tpl.js';
import { DEFAULT_BRUSH, DEFAULT_SHAPE_DYNAMICS, DEFAULT_TEXTURE, NO_DYNAMIC, builtinTips } from '@umbra/kernels/brush';
import { builtinPatterns } from '@umbra/kernels/fill';
import { FOREGROUND_TO_TRANSPARENT } from '@umbra/kernels/gradient';

/** A .tpl with the given presets (name, class, items), as Photoshop writes one. */
function tpl(presets: [string, string, [string, DV][]][]): Uint8Array {
  const w = new ByteWriter();
  w.sig('8BTP');
  w.u32(2);
  w.u32(1);
  w.sig('8BIM');
  w.sig('tptp');
  const at = w.length;
  w.u32(0);
  const start = w.length;
  w.u32(presets.length);
  for (const [name, cls, items] of presets) {
    w.u32(name.length + 1);
    for (const c of name) w.u16(c.charCodeAt(0));
    w.u16(0);
    writeDescriptor(w, cls, items);
  }
  w.patch32(at, w.length - start);
  return w.result();
}

const computed = (size: number, hardness: number): DV =>
  obj('computedBrush', [['Dmtr', px(size)], ['Hrdn', pct(hardness)], ['Angl', ang(0)], ['Rndn', pct(100)], ['Spcn', pct(25)], ['Intr', bool(true)]]);

describe('.tpl', () => {
  it('reads a brush tool preset with its tip, dynamics and tool options', () => {
    const bytes = tpl([
      [
        'Soft 40',
        'PbTl',
        [
          ['Opct', long(60)],
          ['Md  ', en('BlnM', 'Mltp')],
          ['flow', long(35)],
          ['Brsh', computed(40, 0)],
          ['useTipDynamics', bool(true)],
          ['szVr', obj('brVr', [['bVTy', long(2)], ['fStp', long(25)], ['jitter', pct(20)], ['Mnm ', pct(10)]])],
          ['minimumDiameter', pct(10)],
        ],
      ],
      ['Wand 20', 'magicWandTool', [['Tlrn', long(20)], ['AntA', bool(false)], ['Cntg', bool(false)]]],
      ['BG Eraser', 'SETl', [['Tlrn', long(40)], ['BECn', long(2)], ['BESm', long(1)], ['BEPr', bool(true)], ['Brsh', computed(30, 100)]]],
      ['Sans 36', 'typeCreateOrEditTool', [['textToolCharacterOptions', obj('textToolCharacterOptions', [['TxtS', obj('TxtS', [['fontPostScriptName', text('NotoSans-Bold')], ['FntN', text('Noto Sans')], ['FntS', text('Bold')], ['Sz  ', { t: 'untf', unit: '#Pnt', v: 36 }]])]])]]],
      ['Hex', 'polygonTool', [['geometryToolMode', en('geometryToolMode', 'Shp ')], ['Clr ', obj('RGBC', [['Rd  ', long(255)], ['Grn ', long(0)], ['Bl  ', long(0)]])], ['sides', long(6)]]],
      ['Mystery', 'noSuchTool', []],
    ]);
    const { presets } = readTplFile(bytes, 'test.tpl');
    const [brush, wand, bg, type, hex, mystery] = presets;
    expect(brush!.tool).toBe('brush');
    expect(brush!.brush).toMatchObject({ size: 40, hardness: 0, opacity: 0.6, flow: 0.35, mode: 'multiply' });
    expect(brush!.brush!.shapeDynamics).toMatchObject({ enabled: true, minDiameter: 0.1 });
    expect(brush!.brush!.shapeDynamics!.size).toMatchObject({ control: 'pressure', jitter: 0.2 });
    expect(wand).toMatchObject({ tool: 'magicWand', select: { tolerance: 20, antialias: false, contiguous: false } });
    expect(bg).toMatchObject({ tool: 'backgroundEraser', retouch: { tolerance: 0.4, limits: 'findEdges', sampling: 'once', protectForeground: true } });
    expect(bg!.brush).toMatchObject({ size: 30, hardness: 1 });
    expect(type).toMatchObject({ tool: 'typeHorizontal', type: { font: 'NotoSans-Bold', family: 'Noto Sans', fontStyle: 'Bold', size: 36 } });
    expect(hex).toMatchObject({ tool: 'polygon', shape: { mode: 'shape', sides: 6, fill: { type: 'solid', color: [1, 0, 0] } } });
    expect(mystery!.tool).toBeNull();
    expect(mystery!.lost).toContain("tool 'noSuchTool'");
  });
});

describe('.tpl writing', () => {
  it('round-trips every option family through write and read', () => {
    const tips = builtinTips();
    const pattern = builtinPatterns()[1]!;
    const presets: ToolPresetExport[] = [
      {
        name: 'Chalk 40',
        tool: 'brush',
        brush: {
          ...DEFAULT_BRUSH,
          size: 40,
          opacity: 0.6,
          flow: 0.5,
          mode: 'multiply',
          tip: { kind: 'sampled', id: 'builtin:chalk' },
          shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, enabled: true, angle: { ...NO_DYNAMIC, jitter: 0.5 } },
          texture: { ...DEFAULT_TEXTURE, enabled: true, patternId: pattern.id },
        },
      },
      { name: 'Heal from pattern', tool: 'healingBrush', brush: { ...DEFAULT_BRUSH, size: 21 }, retouch: { aligned: true, impressionist: false, healSource: 'pattern', patternId: pattern.id } },
      { name: 'BG Eraser', tool: 'backgroundEraser', brush: { ...DEFAULT_BRUSH, size: 30 }, retouch: { tolerance: 0.4, limits: 'findEdges', sampling: 'once', protectForeground: true } },
      { name: 'Wand 12', tool: 'magicWand', select: { tolerance: 12, antialias: false, contiguous: false, sampleAllLayers: true } },
      { name: 'Bucket 40', tool: 'paintBucket', brush: { opacity: 0.8, mode: 'screen' }, select: { tolerance: 40, antialias: true, contiguous: false, sampleAllLayers: false } },
      { name: 'Fade', tool: 'gradient', gradient: { gradient: FOREGROUND_TO_TRANSPARENT([1, 0.5, 0]), style: 'radial', mode: 'overlay', opacity: 0.7, reverse: true, dither: false } },
      { name: 'Title', tool: 'typeHorizontal', type: { font: 'NotoSans-Bold', family: 'Noto Sans', fontStyle: 'Bold', size: 36, align: 'center' } },
      {
        name: 'Star',
        tool: 'polygon',
        shape: {
          mode: 'shape',
          fill: { type: 'solid', color: [1, 0, 0] },
          stroke: { enabled: true, style: { width: 4, align: 'inside', cap: 'round', join: 'bevel', miterLimit: 4, dashes: [2, 1], dashOffset: 0 }, content: { type: 'solid', color: [0, 0, 1] }, opacity: 0.5, blendMode: 'multiply' },
          sides: 5,
          star: 40,
        },
      },
      { name: 'Heart', tool: 'customShape', shape: { mode: 'path', customShapeName: 'Heart' } },
    ];
    const bytes = writeTplFile(presets, tips, [pattern]);
    const back = readTplFile(bytes, 'mine.tpl');
    expect(back.presets.map((p) => [p.name, p.tool])).toEqual(presets.map((p) => [p.name, p.tool]));
    for (const p of back.presets) expect(p.lost, p.name).toEqual([]);
    expect(back.patterns.map((p) => p.id)).toEqual([pattern.id]);
    const [chalk, heal, bg, wand, bucket, fade, title, star, heart] = back.presets;
    expect(chalk!.brush).toMatchObject({ size: 40, opacity: 0.6, flow: 0.5, mode: 'multiply', shapeDynamics: { enabled: true }, texture: { enabled: true, patternId: pattern.id } });
    // The sampled tip came along with it.
    const tipId = (chalk!.brush!.tip as { id: string }).id;
    expect(back.tips.get(tipId)?.data).toEqual(tips.get('builtin:chalk')!.data);
    expect(heal!.retouch).toEqual({ aligned: true, impressionist: false, healSource: 'pattern', patternId: pattern.id });
    expect(bg!.retouch).toEqual({ tolerance: 0.4, limits: 'findEdges', sampling: 'once', protectForeground: true });
    expect(wand!.select).toEqual({ tolerance: 12, antialias: false, contiguous: false, sampleAllLayers: true });
    expect(bucket).toMatchObject({ brush: { opacity: 0.8, mode: 'screen' }, select: { tolerance: 40, contiguous: false } });
    expect(fade!.gradient).toMatchObject({ style: 'radial', mode: 'overlay', opacity: 0.7, reverse: true, dither: false });
    expect(fade!.gradient!.gradient!.colorStops.length).toBe(presets[5]!.gradient!.gradient!.colorStops.length);
    expect(title!.type).toEqual({ font: 'NotoSans-Bold', family: 'Noto Sans', fontStyle: 'Bold', size: 36, align: 'center' });
    expect(star!.shape).toMatchObject({ mode: 'shape', fill: { type: 'solid', color: [1, 0, 0] }, sides: 5, star: 40 });
    expect(star!.shape!.stroke).toMatchObject({ enabled: true, style: { width: 4, align: 'inside', cap: 'round', join: 'bevel', dashes: [2, 1] }, content: { type: 'solid', color: [0, 0, 1] }, opacity: 0.5, blendMode: 'multiply' });
    expect(heart!.shape).toMatchObject({ mode: 'path', customShapeName: 'Heart' });
  });
});

/** Photoshop's own tool presets, read in place when installed (see abr-corpus.test.ts). */
function corpus(): string[] {
  const roots = process.env.UMBRA_TPL_CORPUS ? [process.env.UMBRA_TPL_CORPUS] : existsSync('/mnt') ? readdirSync('/mnt').map((d) => join('/mnt', d, 'Program Files/Adobe/Adobe Photoshop 2020')) : [];
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
        else if (/\.tpl$/i.test(e)) out.set(`${e}:${statSync(p).size}`, p);
      } catch {
        // Not the corpus.
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return [...out.values()];
}
const files = corpus();

describe.skipIf(files.length === 0)('.tpl corpus', () => {
  for (const file of files) {
    it(`reads ${file.split('/').pop()}`, () => {
      const t = readTplFile(new Uint8Array(readFileSync(file)), file.split('/').pop()!);
      expect(t.presets.length).toBeGreaterThan(0);
      for (const p of t.presets) {
        expect(p.tool, `${p.name} (${p.classID})`).not.toBeNull();
        expect(p.name.startsWith('$$$')).toBe(false);
        // No preset lost its brush outright.
        expect(p.lost.filter((l) => l.startsWith('brush (')), p.name).toEqual([]);
      }
      // Written back and read again, every preset maps to the same tool and options.
      // (Colours come back in 8 bits: Photoshop stores fractions of 0…255, we write whole ones.)
      const again = readTplFile(writeTplFile(t.presets, t.tips, t.patterns), 'again.tpl');
      const skip = new Set(['lost', 'classID', 'id', 'data']);
      const same = (a: unknown, b: unknown, path: string): void => {
        if (typeof a === 'number' && typeof b === 'number') return void expect(Math.abs(a - b), path).toBeLessThan(1 / 255);
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.has(k));
          for (const k of keys) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
          return;
        }
        expect(b, path).toEqual(a);
      };
      t.presets.forEach((p, i) => same(p, again.presets[i], p.name));
    });
  }
});
