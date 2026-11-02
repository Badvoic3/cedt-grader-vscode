import { describe, expect, it } from 'vitest';
import { parseGraderComment } from '../src/grader';

describe('parseGraderComment', () => {
  it('one verdict per test with website-style labels', () => {
    const v = parseGraderComment('PP-T');
    expect(v.map((x) => x.label)).toEqual(['Test 1 of 4: Correct', 'Test 2 of 4: Correct', 'Test 3 of 4: Wrong Answer', 'Test 4 of 4: Time Limit Exceed']);
    expect(v.map((x) => x.ok)).toEqual([true, true, false, false]);
  });

  it('groups in brackets', () => {
    const v = parseGraderComment('P[P-][xP]');
    expect(v.map((x) => x.group)).toEqual([undefined, 1, 1, 2, 2]);
    expect(v[3]).toMatchObject({ kind: 'crash', label: 'Test 4 of 5: Program Crashed' });
  });

  it('unknown codes keep the raw character, plain comments give no tiles', () => {
    expect(parseGraderComment('PZ')[1]).toMatchObject({ kind: 'unknown', ok: false, label: 'Test 2 of 2: Result "Z"' });
    expect(parseGraderComment('Compilation error')).toEqual([]);
    expect(parseGraderComment('No testcase')).toEqual([]);
    expect(parseGraderComment(null)).toEqual([]);
  });
});
