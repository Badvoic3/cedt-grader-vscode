import { describe, expect, it } from 'vitest';
import { caseKey, normalizeOutput, sameOutput } from '../src/runner/compare';

// The expected results are GNU `diff -q -b -B -Z`, written out by hand: the
// `diff` on macOS is the FreeBSD one and can't serve as the reference.
describe('sameOutput', () => {
  const same: [string, string, string][] = [
    ['identical', '1 2\n3\n', '1 2\n3\n'],
    ['missing final newline', '5', '5\n'],
    ['CRLF against LF', '1\r\n2\r\n', '1\n2\n'],
    ['lone CR as a line end', '1\r2', '1\n2'],
    ['trailing spaces', '1 2  \n3\t\n', '1 2\n3\n'],
    ['runs of spaces', '1   2', '1 2'],
    ['a tab against a space', '1\t2', '1 2'],
    ['blank lines inside', '1\n\n\n2\n', '1\n2\n'],
    ['blank lines at both ends', '\n\n1\n\n', '1'],
    ['a line of spaces counts as blank', '1\n   \n2', '1\n2'],
    ['leading runs of different length', '   a', ' a'],
    ['both empty', '', '\n\n'],
  ];
  it.each(same)('same: %s', (_, a, b) => {
    expect(sameOutput(a, b)).toBe(true);
    expect(sameOutput(b, a)).toBe(true);
  });

  const different: [string, string, string][] = [
    ['a changed token', '1 2', '1 3'],
    ['leading whitespace against none', ' a', 'a'],
    ['whitespace against none inside a line', 'a b', 'ab'],
    ['case', 'Yes', 'YES'],
    ['line order', '1\n2', '2\n1'],
    ['one line against two', '1 2', '1\n2'],
    ['an extra line', '1\n2', '1\n2\n3'],
    ['output against nothing', '1', ''],
    ['a no-break space is not whitespace', 'a b', 'a b'],
    ['a trailing no-break space stays', 'a ', 'a'],
  ];
  it.each(different)('different: %s', (_, a, b) => {
    expect(sameOutput(a, b)).toBe(false);
    expect(sameOutput(b, a)).toBe(false);
  });

  it('keeps a long output in one pass', () => {
    const big = '1 2 3\n'.repeat(200_000);
    expect(sameOutput(big, big.replace(/\n/g, ' \r\n'))).toBe(true);
  });

  it('normal form: one space per run, no blank lines', () => {
    expect(normalizeOutput('  a \t b  \n\n c\n')).toBe(' a b\n c');
  });
});

describe('caseKey', () => {
  const key = (input: string, expected: string) => caseKey({ input, expected });

  it('evens out line endings and the end of the input', () => {
    expect(key('1\r\n2\r\n', 'x')).toBe(key('1\n2', 'x'));
  });
  it('keeps spacing inside the input', () => {
    expect(key('1  2', 'x')).not.toBe(key('1 2', 'x'));
    expect(key(' 1', 'x')).not.toBe(key('1', 'x'));
  });
  it('counts the output as the compare does', () => {
    expect(key('1', 'a  b\n\n')).toBe(key('1', 'a b'));
    expect(key('1', 'a b')).not.toBe(key('1', 'ab'));
  });
  it('never joins input and output into the same key', () => {
    expect(key('a', 'b\nc')).not.toBe(key('a\nb', 'c'));
  });
});
