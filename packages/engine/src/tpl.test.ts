import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ByteWriter, bool, en, list, long, obj, pct, px, ang, text, writeDescriptor, type DV } from './descriptor-writer.js';
import { readTplFile } from './tpl.js';

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
    });
  }
});
