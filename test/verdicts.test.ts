import { describe, expect, it } from 'vitest';
import { groupLabel, parseGraderComment, VERDICT_CODES, verdictLegend, VERDICT_STRING_RE } from '../src/grader';
import { G } from '../src/shared/strings';

/** As in cafe-grader: Evaluation::RESULT_CODE + config/locales/en.yml (grader_comment_helper.rb). */
const EXPECTED: [string, string, string][] = [
  ['?', 'waiting', 'Judging'],
  ['P', 'correct', 'Correct'],
  ['-', 'wrong', 'Wrong Answer'],
  ['s', 'partial', 'Partially Correct'],
  ['T', 'time_limit', 'Time Limit Exceed'],
  ['M', 'memory_limit', 'Memory Limit Exceed'],
  ['x', 'crash', 'Program Crashed'],
  ['E', 'unknown_error', 'UNKNOWN ERROR'],
  ['!', 'grader_error', 'GRADER ERROR'],
];

describe('parseGraderComment: every code', () => {
  it('the 9 codes in RESULT_CODE order', () => {
    expect(VERDICT_CODES).toEqual(EXPECTED.map((e) => e[0]));
    expect(verdictLegend().map((l) => [l.code, l.kind, l.word])).toEqual(EXPECTED);
  });

  for (const [code, kind, word] of EXPECTED) {
    it(`"${code}" → ${kind}`, () => {
      const [v] = parseGraderComment(code);
      expect(v).toEqual({ index: 1, ok: code === 'P', kind, label: `Test 1 of 1: ${word}` });
    });
  }

  it('one tile per test, in order, with website tooltips ("Test 5 of 12: …")', () => {
    const v = parseGraderComment('PPPPTPPPPPP-');
    expect(v).toHaveLength(12);
    expect(v[4].label).toBe('Test 5 of 12: Time Limit Exceed');
    expect(v.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('groups', () => {
  it('"[...]" = tests scored together; numbering continues across groups', () => {
    const v = parseGraderComment('P[P-][xP][PPP]');
    expect(v.map((x) => x.group)).toEqual([undefined, 1, 1, 2, 2, 3, 3, 3]);
    expect(v[3]).toMatchObject({ kind: 'crash', label: 'Test 4 of 8: Program Crashed' });
  });

  it('box tooltip: "Group 2 of 3: 2/3 passed. Tests in a box …" (passed = P tiles)', () => {
    const v = parseGraderComment('[P-][PsP][PP]');
    const g2 = v.filter((x) => x.group === 2);
    expect(groupLabel(2, 3, g2)).toBe(`Group 2 of 3: 2/3 passed. ${G.groupHint}`);
    expect(G.groupHint).toBe('Tests in a box are scored together — the box earns the lowest score inside it.');
  });
});

describe('plain-text fallback (never tiles)', () => {
  for (const c of ['No testcase', 'Compilation error', 'Evaluations are missing, please rejudge.', 'PZ', '[[P]]', '[P', 'P]', 'P[]', '[P[-]]', 'p', ' ']) {
    it(JSON.stringify(c), () => {
      expect(parseGraderComment(c)).toEqual([]);
      expect(VERDICT_STRING_RE.test(c.trim())).toBe(false);
    });
  }
  it('null / empty', () => {
    expect(parseGraderComment(null)).toEqual([]);
    expect(parseGraderComment('')).toEqual([]);
  });
});
