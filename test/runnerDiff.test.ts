import { describe, expect, it } from 'vitest';
import { sameOutput } from '../src/runner/compare';
import { diffOutputs, plainLines } from '../src/runner/diff';

const marked = (lines: { parts: { text: string; changed: boolean }[] }[]) => lines.flatMap((l) => l.parts.filter((p) => p.changed).map((p) => p.text));
const changedLines = (lines: { n: number; changed: boolean }[]) => lines.filter((l) => l.changed).map((l) => l.n);

describe('diffOutputs', () => {
  it('marks only the word that differs, and a line only on one side whole', () => {
    const d = diffOutputs('5\n1 2 3\n7 8 9\ndone\n', '5\n1 2 3\n7 6 9\ndone\nextra\n');
    expect(changedLines(d.expected)).toEqual([3]);
    expect(changedLines(d.actual)).toEqual([3, 5]);
    expect(marked(d.expected)).toEqual(['8']);
    expect(marked(d.actual)).toEqual(['6', 'extra']);
  });

  it('a missing line in the middle doesn\'t mark everything after it', () => {
    const d = diffOutputs('a\nb\nc\nd\n', 'a\nc\nd\n');
    expect(changedLines(d.expected)).toEqual([2]);
    expect(changedLines(d.actual)).toEqual([]);
  });

  // Whatever the compare ignores, the diff must not mark.
  it.each([
    ['spaces at a line end', 'a b\n', 'a b  \n'],
    ['a tab at a line end', 'a\n', 'a\t\n'],
    ['a run of spaces', 'a b\n', 'a   b\n'],
    ['a tab between words', 'a b\n', 'a\tb\n'],
    ['blank lines', 'a\nb\n', 'a\n\n\nb\n\n'],
    ['line endings', 'a\nb\n', 'a\r\nb\r\n'],
    ['a missing last newline', 'a\n', 'a'],
  ])('%s: same for the compare, nothing marked', (_, e, a) => {
    expect(sameOutput(a, e)).toBe(true);
    const d = diffOutputs(e, a);
    expect(changedLines(d.expected)).toEqual([]);
    expect(changedLines(d.actual)).toEqual([]);
  });

  // And whatever the compare counts, it must show.
  it.each([
    ['a leading space', 'a\n', ' a\n'],
    ['a space against none', 'ab\n', 'a b\n'],
    ['a no-break space', 'a b\n', 'a b\n'],
  ])('%s: differs for the compare, and is marked', (_, e, a) => {
    expect(sameOutput(a, e)).toBe(false);
    expect(changedLines(diffOutputs(e, a).actual)).toEqual([1]);
  });

  it('spaces at the end show as marks, on either side, and keep the line numbers', () => {
    const d = diffOutputs('a \n\nb\t\n', 'a\n');
    expect(d.expected.map((l) => [l.n, l.trail])).toEqual([[1, '·'], [2, ''], [3, '→']]);
    expect(d.expected[0].parts).toEqual([{ text: 'a', changed: false }]);
  });

  it('keeps every character of a changed line, in order', () => {
    const d = diffOutputs('x  y   z\n', 'x  q   z\n');
    expect(d.actual[0].parts.map((p) => p.text).join('')).toBe('x  q   z');
    expect(marked(d.actual)).toEqual(['q']);
  });

  it('nothing against something', () => {
    expect(diffOutputs('', '').expected).toEqual([]);
    expect(marked(diffOutputs('', 'a\n').actual)).toEqual(['a']);
    expect(marked(diffOutputs('a\n', '').expected)).toEqual(['a']);
  });

  it('64 KB of short, all different lines stays fast, and falls back to line by line', () => {
    const a = Array.from({ length: 32_000 }, (_, i) => `${i % 10}`).join('\n');
    const b = Array.from({ length: 32_000 }, (_, i) => `${(i + 1) % 10}`).join('\n');
    const t = performance.now();
    const d = diffOutputs(a, b);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(d.actual).toHaveLength(32_000);
    expect(changedLines(d.actual)).toHaveLength(32_000);
  });

  it('a very long line is marked whole rather than word by word', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(' ');
    const d = diffOutputs(`${a}\n`, `${b}\n`);
    expect(d.expected[0].changed).toBe(true);
    expect(d.expected[0].parts.map((p) => p.text).join('')).toBe(a);
  });
});

describe('plainLines', () => {
  it('numbers lines and marks nothing', () => {
    expect(plainLines('a\r\nb \n')).toEqual([
      { n: 1, changed: false, parts: [{ text: 'a', changed: false }], trail: '' },
      { n: 2, changed: false, parts: [{ text: 'b', changed: false }], trail: '·' },
    ]);
  });
});
