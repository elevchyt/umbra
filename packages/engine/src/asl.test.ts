import { describe, expect, it } from 'vitest';
import { builtinPatterns } from '@umbra/kernels/fill';
import { DEFAULTS, EMPTY_EFFECTS } from '@umbra/kernels/effects/types';
import { builtinStyles } from '@umbra/kernels/effects/presets';
import { readAsl, writeAsl } from './asl.js';

describe('.asl style libraries', () => {
  it('the built-in styles survive a write and read', () => {
    const styles = builtinStyles();
    const back = readAsl(writeAsl(styles));
    expect(back.lost).toEqual([]);
    expect(back.styles.map((s) => [s.id, s.name])).toEqual(styles.map((s) => [s.id, s.name]));
    for (let i = 0; i < styles.length; i++) {
      const a = styles[i]!.effects;
      const b = back.styles[i]!.effects;
      expect([b.dropShadow.length, b.stroke.length, !!b.bevel, !!b.outerGlow, b.gradientOverlay.length]).toEqual([a.dropShadow.length, a.stroke.length, !!a.bevel, !!a.outerGlow, a.gradientOverlay.length]);
      if (a.dropShadow[0]) expect(b.dropShadow[0]!.size).toBeCloseTo(a.dropShadow[0].size, 3);
    }
  });

  it('patterns the styles use travel inside the library', () => {
    const pattern = builtinPatterns()[1]!;
    const style = { id: 'p', name: 'Patterned', effects: { ...EMPTY_EFFECTS, patternOverlay: { ...DEFAULTS.patternOverlay(pattern), scale: 50 } } };
    const back = readAsl(writeAsl([style]));
    expect(back.patterns.map((p) => p.id)).toEqual([pattern.id]);
    expect(Array.from(back.patterns[0]!.data.subarray(0, 16))).toEqual(Array.from(pattern.data.subarray(0, 16)));
    const po = back.styles[0]!.effects.patternOverlay!;
    expect([po.pattern?.id, po.scale]).toEqual([pattern.id, 50]);
  });

  it('refuses a file that is not a style library', () => {
    expect(() => readAsl(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow();
  });
});
