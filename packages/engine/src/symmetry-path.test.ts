import { describe, expect, it } from 'vitest';
import { DEFAULT_BRUSH, beginStroke, strokeTo, type Symmetry } from '@umbra/kernels/brush';
import { flattenSubpath } from '@umbra/kernels/vector/path';
import { symmetryPath } from './symmetry-path.js';

const at = { segments: 2, cx: 200, cy: 150, angle: 0 };
const asPathSymmetry = (s: Symmetry): Symmetry => ({
  ...at,
  mode: 'path',
  path: symmetryPath(s, 400, 300)!.subpaths.map((sp) => ({ points: flattenSubpath(sp, 0.1), closed: sp.closed })),
});

describe('the symmetry path (Edit Points)', () => {
  it('lines become straight two-point paths across the canvas', () => {
    const p = symmetryPath({ ...at, mode: 'dualAxis' }, 400, 300)!;
    expect(p.subpaths.map((sp) => sp.knots.map((k) => [Math.round(k.anchor.x), Math.round(k.anchor.y)]))).toEqual([
      [
        [0, 150],
        [400, 150],
      ],
      [
        [200, 0],
        [200, 300],
      ],
    ]);
  });

  it('a converted symmetry mirrors as the original did', () => {
    const cases: Symmetry[] = [
      { ...at, mode: 'vertical', angle: 20 },
      // (A stretched circle mirrors in its stretched frame; as a path it can only mirror through
      // the nearest point, which agrees for a true circle alone.)
      { ...at, mode: 'circle', size: 80, angle: 30 },
      { ...at, mode: 'horizontal', transform: { scaleX: 2, scaleY: 0.5, skew: 0 } },
      { ...at, mode: 'parallelLines', size: 60, angle: 90 },
    ];
    for (const s of cases) {
      const ps = asPathSymmetry(s);
      for (const [x, y] of [
        [230, 160],
        [120, 90],
        [310, 220],
      ] as const) {
        // A one-dab stroke under each symmetry: its mirrors.
        const mirrors = (sym: Symmetry) => strokeTo(beginStroke({ ...DEFAULT_BRUSH, size: 10, spacing: 5, smoothing: 0, symmetry: sym }), { x, y, pressure: 1, time: 0, tiltX: 0, tiltY: 0, twist: 0 }).slice(1);
        const want = mirrors(s);
        const got = mirrors(ps);
        // Parallel Lines: a mirror across each line, in both.
        expect(got.length, `${s.mode}`).toBe(want.length);
        for (let i = 0; i < want.length; i++) expect(Math.hypot(got[i]!.x - want[i]!.x, got[i]!.y - want[i]!.y), `${s.mode} ${x},${y} #${i}`).toBeLessThan(0.75);

      }
    }
  });

  it('Radial and Mandala have no path', () => {
    expect(symmetryPath({ ...at, mode: 'radial' }, 400, 300)).toBeNull();
    expect(symmetryPath({ ...at, mode: 'mandala' }, 400, 300)).toBeNull();
  });
});
