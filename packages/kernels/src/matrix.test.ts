import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  about,
  apply,
  compose,
  composeAll,
  decompose,
  fromRectToQuad,
  invert,
  isIdentity,
  isIntegerTranslation,
  rotate,
  scale,
  skew,
  transformedBounds,
  translate,
} from './matrix.js';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('affine matrices', () => {
  it('translates a point', () => {
    const p = apply(translate(10, -4), { x: 1, y: 2 });
    expect(p).toEqual({ x: 11, y: -2 });
  });

  it('composes left to right', () => {
    // Scale then translate: the translation must NOT be scaled.
    const m = compose(scale(2), translate(5, 0));
    expect(apply(m, { x: 1, y: 0 })).toEqual({ x: 7, y: 0 });
    // Translate then scale: it must be.
    const n = compose(translate(5, 0), scale(2));
    expect(apply(n, { x: 1, y: 0 })).toEqual({ x: 12, y: 0 });
  });

  it('agrees with applying each transform in turn', () => {
    const a = rotate(0.3);
    const b = scale(1.5, 0.5);
    const c = translate(4, -7);
    const p = { x: 3, y: 5 };
    const once = apply(composeAll(a, b, c), p);
    const step = apply(c, apply(b, apply(a, p)));
    near(once.x, step.x);
    near(once.y, step.y);
  });

  it('inverts', () => {
    const m = composeAll(translate(3, 4), rotate(0.7), scale(2, 3));
    const inv = invert(m)!;
    const p = { x: 11, y: -5 };
    const round = apply(inv, apply(m, p));
    near(round.x, p.x);
    near(round.y, p.y);
  });

  it('has no inverse when it collapses to a line', () => {
    expect(invert(scale(1, 0))).toBeNull();
  });

  it('rotates about a pivot rather than the origin', () => {
    const m = about(rotate(Math.PI / 2), { x: 10, y: 10 });
    const p = apply(m, { x: 10, y: 10 });
    near(p.x, 10);
    near(p.y, 10);
  });

  it('recognises identity and integer translations', () => {
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(isIntegerTranslation(translate(4, -9))).toBe(true);
    expect(isIntegerTranslation(translate(4.5, 0))).toBe(false);
    expect(isIntegerTranslation(rotate(0.1))).toBe(false);
  });

  it('bounds a rotated rectangle by its corners', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b = transformedBounds(rotate(Math.PI / 4), r);
    // A 10×10 square turned 45° is √2 times as wide.
    near(b.x1 - b.x0, Math.hypot(10, 10));
  });
});

describe('fromRectToQuad', () => {
  it('reproduces a plain translation', () => {
    const r = { x0: 0, y0: 0, x1: 4, y1: 2 };
    const m = fromRectToQuad(r, { x: 5, y: 5 }, { x: 9, y: 5 }, { x: 5, y: 7 });
    expect(apply(m, { x: 0, y: 0 })).toEqual({ x: 5, y: 5 });
    expect(apply(m, { x: 4, y: 2 })).toEqual({ x: 9, y: 7 });
  });

  it('honours the three corners it is given', () => {
    const r = { x0: 10, y0: 20, x1: 30, y1: 60 };
    const tl = { x: 1, y: 2 };
    const tr = { x: 40, y: 9 };
    const bl = { x: -5, y: 55 };
    const m = fromRectToQuad(r, tl, tr, bl);
    const check = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const p = apply(m, from);
      near(p.x, to.x);
      near(p.y, to.y);
    };
    check({ x: r.x0, y: r.y0 }, tl);
    check({ x: r.x1, y: r.y0 }, tr);
    check({ x: r.x0, y: r.y1 }, bl);
  });
});

describe('decompose', () => {
  it('reads back scale and rotation', () => {
    const d = decompose(compose(scale(2, 3), rotate(0.5)));
    near(d.scaleX, 2);
    near(d.scaleY, 3);
    near(d.rotation, 0.5);
    near(d.skewX, 0);
  });

  it('reads back skew', () => {
    const d = decompose(skew(0.3, 0));
    near(d.skewX, 0.3);
    near(d.rotation, 0);
  });

  it('reports a flip as a negative X scale', () => {
    expect(decompose(scale(-1, 1)).scaleX).toBeLessThan(0);
  });
});
