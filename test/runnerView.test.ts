import { describe, expect, it } from 'vitest';
import type { CaseRun, RunnerCase } from '../src/runner/types';
import { capText, nothingSent, testsDelta } from '../src/runner/view';

const c = (id: string, input = 'in', extra: Partial<RunnerCase> = {}): RunnerCase => ({ id, source: 'custom', input, expected: 'out', ...extra });
const run = (caseId: string, state: CaseRun['state'] = 'done'): CaseRun => ({ caseId, state });

describe('capText', () => {
  it('keeps short text and marks cut text', () => {
    expect(capText('abc', 5)).toEqual({ text: 'abc', truncated: false });
    expect(capText('abcdef', 5)).toEqual({ text: 'abcde', truncated: true });
  });
});

describe('testsDelta', () => {
  it('sends everything first, then only what changed', () => {
    const sent = nothingSent();
    const list = [c('a'), c('b')];
    const r1 = new Map([['a', run('a', 'running')]]);
    const first = testsDelta(sent, 'k', list, r1);
    expect(first.fresh).toBe(true);
    expect(first.cases.map((x) => x.id)).toEqual(['a', 'b']);
    expect(Object.keys(first.runs)).toEqual(['a']);

    // A run's progress resends no case text.
    const r2 = new Map([['a', run('a')]]);
    const second = testsDelta(sent, 'k', list, r2);
    expect(second).toEqual({ fresh: false, order: ['a', 'b'], cases: [], runs: { a: r2.get('a') } });

    // The same list read again from disk: nothing to send.
    expect(testsDelta(sent, 'k', [c('a'), c('b')], r2)).toEqual({ fresh: false, order: ['a', 'b'], cases: [], runs: {} });
  });

  it('an edit sends that case, and a removed result goes as null', () => {
    const sent = nothingSent();
    const r = new Map([['a', run('a')]]);
    testsDelta(sent, 'k', [c('a'), c('b')], r);
    const d = testsDelta(sent, 'k', [c('a', 'new'), c('b')], new Map());
    expect(d.cases.map((x) => x.id)).toEqual(['a']);
    expect(d.runs).toEqual({ a: null });
  });

  it('a source change counts, a reorder sends only the order', () => {
    const sent = nothingSent();
    testsDelta(sent, 'k', [c('a', 'x', { source: 'grader' }), c('b')], new Map());
    expect(testsDelta(sent, 'k', [c('b'), c('a', 'x')], new Map())).toMatchObject({ order: ['b', 'a'], cases: [{ id: 'a', source: 'custom' }] });
    expect(testsDelta(sent, 'k', [c('a', 'x'), c('b')], new Map())).toMatchObject({ order: ['a', 'b'], cases: [] });
  });

  it('another list starts over, also from no list', () => {
    const sent = nothingSent();
    expect(testsDelta(sent, null, [], new Map()).fresh).toBe(true);
    testsDelta(sent, 'one', [c('a')], new Map());
    const d = testsDelta(sent, 'two', [c('a')], new Map());
    expect(d.fresh).toBe(true);
    expect(d.cases).toHaveLength(1);
  });

  it('caps the text it sends', () => {
    const d = testsDelta(nothingSent(), 'k', [c('a', 'x'.repeat(70_000))], new Map());
    expect(d.cases[0].input.truncated).toBe(true);
    expect(d.cases[0].input.text).toHaveLength(64 * 1024);
  });
});
