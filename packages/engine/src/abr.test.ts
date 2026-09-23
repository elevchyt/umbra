import { describe, expect, it } from 'vitest';
import { builtinBrushes, builtinTips, DEFAULT_TEXTURE, DEFAULT_DUAL, NO_DYNAMIC, type BrushPreset } from '@umbra/kernels/brush';
import { builtinPatterns } from '@umbra/kernels/fill';
import { readAbrFile, writeAbrFile } from './abr.js';

describe('.abr', () => {
  it('round-trips presets, sampled tips, dynamics, texture and dual brush through v6.2', () => {
    const tips = builtinTips();
    const pattern = builtinPatterns()[1]!;
    const presets: BrushPreset[] = [
      ...builtinBrushes().flatMap((g) => g.presets),
      {
        id: 'x',
        name: 'Everything',
        params: {
          size: 42,
          hardness: 0.3,
          spacing: 0.4,
          angle: 30,
          roundness: 0.6,
          opacity: 0.8,
          flow: 0.5,
          smoothing: 0.25,
          texture: { ...DEFAULT_TEXTURE, enabled: true, patternId: pattern.id, scale: 150, mode: 'colorBurn', depth: 0.7, invert: true },
          dual: { ...DEFAULT_DUAL, enabled: true, size: 12, spacing: 0.3, mode: 'multiply', count: 3, scatter: 0.5 },
          pose: { enabled: true, tiltX: 20, tiltY: -10, rotation: 45, pressure: 0.5, overrideTilt: true, overrideRotation: false, overridePressure: true },
        },
      },
    ];
    const bytes = writeAbrFile(presets, tips, [pattern]);
    const back = readAbrFile(bytes, 'lib');
    expect(back.lost).toEqual([]);
    expect(back.presets.map((p) => p.name)).toEqual(presets.map((p) => p.name));
    // Sampled tips come back pixel for pixel, under the file's own prefix.
    const chalk = back.presets.find((p) => p.name === 'Chalk')!;
    expect(chalk.params.tip).toEqual({ kind: 'sampled', id: 'lib:builtin:chalk' });
    expect(back.tips.get('lib:builtin:chalk')!.data).toEqual(tips.get('builtin:chalk')!.data);
    // Dynamics.
    const charcoal = back.presets.find((p) => p.name === 'Charcoal')!;
    expect(charcoal.params.shapeDynamics).toMatchObject({ enabled: true, angle: { control: 'direction' }, size: { control: 'pressure', minimum: 0.4 } });
    expect(charcoal.params.transfer?.flow.jitter).toBeCloseTo(0.3, 6);
    const stars = back.presets.find((p) => p.name === 'Scattered Stars')!;
    expect(stars.params.scattering).toMatchObject({ enabled: true, count: 1 });
    expect(stars.params.scattering!.scatter.jitter).toBeCloseTo(2, 6);
    expect(stars.params.colorDynamics).toMatchObject({ enabled: true });
    expect(stars.params.colorDynamics!.hue).toBeCloseTo(0.4, 6);
    expect(back.presets.find((p) => p.name === 'Watercolor Wash')!.params.wetEdges).toBe(true);
    // Everything else.
    const e = back.presets.find((p) => p.name === 'Everything')!.params;
    expect(e).toMatchObject({ size: 42, spacing: 0.4, angle: 30, opacity: 0.8, flow: 0.5 });
    expect(e.roundness).toBeCloseTo(0.6, 6);
    expect(e.hardness).toBeCloseTo(0.3, 6);
    expect(e.smoothing).toBeCloseTo(0.25, 6);
    expect(e.texture).toMatchObject({ enabled: true, patternId: pattern.id, scale: 150, mode: 'colorBurn', invert: true });
    expect(e.texture!.depth).toBeCloseTo(0.7, 6);
    expect(e.dual).toMatchObject({ enabled: true, size: 12, mode: 'multiply', count: 3 });
    expect(e.dual!.scatter).toBeCloseTo(0.5, 6);
    expect(e.pose).toMatchObject({ enabled: true, tiltX: 20, tiltY: -10, overrideTilt: true, overridePressure: true });
    expect(back.patterns.map((p) => p.id)).toEqual([pattern.id]);
    expect(back.patterns[0]!.data).toEqual(pattern.data);
    void NO_DYNAMIC;
  });

  it('reads v2 files: computed and RLE-compressed sampled tips', () => {
    const parts: number[] = [];
    const i16 = (v: number) => parts.push((v >> 8) & 255, v & 255);
    const i32 = (v: number) => parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    i16(2);
    i16(2);
    // A computed brush: misc, spacing 25 %, diameter 19, roundness 100 %, angle 0, hardness 80 %.
    i16(1);
    i32(14);
    i32(0);
    i16(25);
    i16(19);
    i16(100);
    i16(0);
    i16(80);
    // A sampled 4×2 brush, named "Dots", RLE: row 0 = 255 ×4 (run), row 1 = 0,255,0,255 (literal).
    const body: number[] = [];
    const b16 = (v: number) => body.push((v >> 8) & 255, v & 255);
    const b32 = (v: number) => body.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    b32(0);
    b16(50);
    b32(5);
    for (const c of 'Dots\0') b16(c.charCodeAt(0));
    body.push(1);
    for (let i = 0; i < 4; i++) b16(0);
    b32(0);
    b32(0);
    b32(2);
    b32(4);
    b16(8);
    body.push(1);
    b16(2);
    b16(5);
    body.push(0xfd, 255);
    body.push(3, 0, 255, 0, 255);
    i16(2);
    i32(body.length);
    parts.push(...body);
    const out = readAbrFile(Uint8Array.from(parts), 'old');
    expect(out.presets).toHaveLength(2);
    expect(out.presets[0]!.params).toMatchObject({ size: 19, spacing: 0.25, roundness: 1, hardness: 0.8 });
    expect(out.presets[1]!.name).toBe('Dots');
    const tip = out.tips.get(out.presets[1]!.params.tip!.kind === 'sampled' ? (out.presets[1]!.params.tip as { id: string }).id : '')!;
    expect(Array.from(tip.data)).toEqual([255, 255, 255, 255, 0, 255, 0, 255]);
  });
});
