import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAR, DEFAULT_PARA, type TextSpec } from './style.js';
import { lineRangeAt, replaceText, restyleParagraphs, restyleRange, stepCaret, styleAt, textOf, wordAt } from './edit.js';

const A = { ...DEFAULT_CHAR, size: 10 };
const B = { ...DEFAULT_CHAR, size: 20 };
const spec = (): TextSpec => ({ kind: 'point', orientation: 'horizontal', runs: [{ text: 'Hello ', style: A }, { text: 'world', style: B }], paragraphs: [{ ...DEFAULT_PARA, align: 'center' }] });

describe('text editing', () => {
  it('inserts in the style before the caret and merges equal runs', () => {
    const s = replaceText(spec(), 6, 6, 'big ');
    expect(textOf(s)).toBe('Hello big world');
    expect(s.runs.map((r) => r.text)).toEqual(['Hello big ', 'world']);
    const t = replaceText(spec(), 6, 6, 'X', B);
    expect(t.runs.map((r) => r.text)).toEqual(['Hello ', 'Xworld']);
    expect(styleAt(spec(), 0)).toBe(A);
    expect(styleAt(spec(), 7)).toBe(B);
  });

  it('replaces and deletes across runs; empty text keeps a run to type in', () => {
    const s = replaceText(spec(), 3, 8, '');
    expect(textOf(s)).toBe('Helrld');
    expect(s.runs.map((r) => r.style.size)).toEqual([10, 20]);
    const e = replaceText(spec(), 0, 11, '');
    expect(e.runs).toEqual([{ text: '', style: A }]);
  });

  it('paragraph styles follow new and joined paragraphs', () => {
    const s = replaceText(spec(), 5, 5, '\n');
    expect(s.paragraphs).toHaveLength(2);
    expect(s.paragraphs[1]!.align).toBe('center');
    const r = restyleParagraphs(s, 7, 7, { align: 'right' });
    expect(r.paragraphs.map((p) => p.align)).toEqual(['center', 'right']);
    const joined = replaceText(r, 5, 6, '');
    expect(joined.paragraphs.map((p) => p.align)).toEqual(['center']);
  });

  it('restyles a range, splitting and merging runs', () => {
    const s = restyleRange(spec(), 2, 8, { size: 20 });
    expect(s.runs.map((r) => [r.text, r.style.size])).toEqual([
      ['He', 10],
      ['llo world', 20],
    ]);
  });

  it('words, lines and caret steps', () => {
    expect(wordAt('one two three', 5)).toEqual([4, 7]);
    expect(lineRangeAt('ab\ncd\nef', 4)).toEqual([3, 5]);
    expect(stepCaret('a😀b', 1, 1, false)).toBe(3);
    expect(stepCaret('a😀b', 3, -1, false)).toBe(1);
    expect(stepCaret('e\u0301x', 0, 1, false)).toBe(2);
    expect(stepCaret('one two', 0, 1, true)).toBe(3);
    expect(stepCaret('one two', 7, -1, true)).toBe(4);
  });
});
