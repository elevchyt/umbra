import { describe, expect, it } from 'vitest';
import { getLut, parse3dl, parseCube, sampleLut, toCube, type Lut3D } from './lut.js';
import { applyToRgb } from './adjust.js';

const cube = (size: number, fn: (r: number, g: number, b: number) => [number, number, number]) => {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    lines.push(fn(r / (size - 1), g / (size - 1), b / (size - 1)).join(' '));
  }
  return lines.join('\n');
};
const at = (lut: Lut3D, r: number, g: number, b: number) => {
  const px = new Float32Array([r, g, b]);
  sampleLut(lut, px);
  return [...px];
};

describe('3-D LUTs', () => {
  it('an identity .cube is the identity everywhere, not only on the grid', () => {
    const lut = parseCube(cube(5, (r, g, b) => [r, g, b]), 'id');
    const points: [number, number, number][] = [[0, 0, 0], [1, 1, 1], [0.3, 0.71, 0.05], [0.9, 0.2, 0.55]];
    for (const p of points) {
      at(lut, p[0], p[1], p[2]).forEach((v, i) => expect(v).toBeCloseTo(p[i]!, 5));
    }
  });

  it('is exact on the grid and linear along each tetrahedron edge', () => {
    const lut = parseCube(cube(3, (r, g, b) => [r * r, g, 1 - b]), 'f');
    expect(at(lut, 0.5, 0.5, 0.5)).toEqual([0.25, 0.5, 0.5]);
    // Halfway along the red edge from (0,0,0) to (0.5,0,0): halfway between 0 and 0.25.
    expect(at(lut, 0.25, 0, 0)[0]).toBeCloseTo(0.125, 6);
  });

  it('keeps greys grey when the grid\'s neutral axis is grey — the point of tetrahedral', () => {
    // Corners that disagree off the diagonal would bend greys under trilinear interpolation.
    const lut = parseCube(cube(3, (r, g, b) => [r * 0.9 + g * 0.1, g * 0.8 + b * 0.2, b * 0.7 + r * 0.3]), 'm');
    const [r, g, b] = at(lut, 0.37, 0.37, 0.37);
    expect(r).toBeCloseTo(g!, 6);
    expect(g).toBeCloseTo(b!, 6);
  });

  it('reads DOMAIN_MAX and TITLE', () => {
    const text = 'TITLE "Doubled"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + cube(2, (r, g, b) => [r * 2, g * 2, b * 2]);
    const lut = parseCube(text, 'x.cube');
    expect(lut.name).toBe('Doubled');
    expect(at(lut, 1, 1, 1)).toEqual([1, 1, 1]);
  });

  it('reads .3dl with blue fastest and infers its bit depth', () => {
    const lines = ['0 1023'];
    for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) lines.push(`${b * 4095} ${r * 4095} ${g * 4095}`);
    const lut = parse3dl(lines.join('\n'), 's');
    // This table rotates channels: out = (b, r, g).
    expect(at(lut, 1, 0, 0)).toEqual([0, 1, 0]);
    expect(at(lut, 0, 0, 1)).toEqual([1, 0, 0]);
  });

  it('survives writing out as .cube', () => {
    const lut = getLut('umbra:teal-orange')!;
    const back = parseCube(toCube(lut), 'rt');
    expect(back.size).toBe(lut.size);
    back.data.forEach((v, i) => expect(Math.abs(v - lut.data[i]!)).toBeLessThan(1e-6));
  });

  it('as an adjustment: a missing table is a no-op, a built-in changes pixels', () => {
    expect(applyToRgb({ kind: 'colorLookup', lutId: 'nope', name: 'x' }, 30, 90, 200)).toEqual([30, 90, 200]);
    expect(applyToRgb({ kind: 'colorLookup', lutId: 'umbra:moonlight', name: 'Moonlight' }, 200, 150, 90)).not.toEqual([200, 150, 90]);
    expect(applyToRgb({ kind: 'colorLookup', lutId: 'umbra:identity', name: 'Identity' }, 30, 90, 200)).toEqual([30, 90, 200]);
  });
});
