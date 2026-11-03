import { describe, expect, it } from 'vitest';
import { parseTopicTags, problemStatus } from '../src/grader';
import type { ProblemView } from '../src/shared/messages';
import { filterProblems, sortProblems } from '../webview/filters';
import { realFixture } from './helpers';

const V = (id: number, status: ProblemView['status'], tags: string[] = [], name = `p${id}`): ProblemView => ({
  id, name, fullName: name, status, tags, hasFile: false, hasTestcase: false, hasAttachment: false, lastSubmissionTime: null, lastOpened: null,
  score: { counted: null, best: null, latest: null, attempts: 0, penaltyLabel: null, rawSum: false, outOf: 100, source: 'api', latestBelowCounted: false },
});

describe('status, as on the website (main/_problem.html.haml)', () => {
  it('solved = submitted and best >= 100; inprogress = submitted, best < 100; untried = none', () => {
    expect(problemStatus({ submissionCount: 2, bestScore: 100, lastSubmissionId: 1 })).toBe('solved');
    expect(problemStatus({ submissionCount: 1, bestScore: 137.5, lastSubmissionId: 1 })).toBe('solved'); // raw sum above 100
    expect(problemStatus({ submissionCount: 3, bestScore: 99.9, lastSubmissionId: 1 })).toBe('inprogress');
    expect(problemStatus({ submissionCount: 1, bestScore: null, lastSubmissionId: 1 })).toBe('inprogress');
    expect(problemStatus({ submissionCount: 0, bestScore: null, lastSubmissionId: null })).toBe('untried');
  });
});

describe('filters (status + topic + text, combined)', () => {
  const items = [V(1, 'solved', ['ComProg']), V(2, 'inprogress', ['ComProg', 'DataAlgo']), V(3, 'untried', ['DataAlgo']), V(4, 'untried', [], 'graph_walk')];
  const ids = (f: Parameters<typeof filterProblems>[1], q = '') => filterProblems(items, f, q).map((p) => p.id);
  it('All / Unsolved / In progress / Solved', () => {
    expect(ids({ status: 'all', topic: null })).toEqual([1, 2, 3, 4]);
    expect(ids({ status: 'unsolved', topic: null })).toEqual([2, 3, 4]);
    expect(ids({ status: 'inprogress', topic: null })).toEqual([2]);
    expect(ids({ status: 'solved', topic: null })).toEqual([1]);
  });
  it('topic and text combine with status', () => {
    expect(ids({ status: 'all', topic: 'DataAlgo' })).toEqual([2, 3]);
    expect(ids({ status: 'unsolved', topic: 'DataAlgo' })).toEqual([2, 3]);
    expect(ids({ status: 'unsolved', topic: 'ComProg' })).toEqual([2]);
    expect(ids({ status: 'untried' as never, topic: null }, 'graph')).toEqual([4]);
    expect(ids({ status: 'all', topic: null }, '#3')).toEqual([3]);
  });
});

describe('topic tags from /main/list', () => {
  const real = realFixture('main_list.html');
  it.runIf(real)('reads the website topic pills (with descriptions)', () => {
    const t = parseTopicTags(real!);
    expect(t.map((x) => x.name)).toEqual(expect.arrayContaining(['ComProg', 'DataAlgo', 'DB', 'DigLo', 'Math-Model']));
    expect(t.find((x) => x.name === 'Math-Model')!.description).toBe('For Applied Mathematical Model course');
    expect(t.find((x) => x.name === 'ComProg')!.description).toBeNull();
  });
  it('none on a page without them', () => {
    expect(parseTopicTags('<html><body><table></table></body></html>')).toEqual([]);
  });
});

describe('robust to problems without tags', () => {
  it('topic filter does not crash on a problem lacking `tags`', () => {
    const p = { ...V(9, 'untried'), tags: undefined as unknown as string[] };
    expect(filterProblems([p], { status: 'all', topic: 'ComProg' }, '')).toEqual([]);
    expect(filterProblems([p], { status: 'all', topic: null }, '')).toHaveLength(1);
  });
});

describe('sorting (works with the filters)', () => {
  const items: ProblemView[] = [
    { ...V(1, 'solved', [], 'b_two'), score: { ...V(1, 'solved').score, counted: 100 }, lastSubmissionTime: '2026-10-01T00:00:00Z', lastOpened: 10 },
    { ...V(2, 'inprogress', [], 'a_one'), score: { ...V(2, 'inprogress').score, counted: 40 }, lastSubmissionTime: '2026-11-01T00:00:00Z', lastOpened: null },
    { ...V(3, 'untried', [], 'c_10'), lastSubmissionTime: null, lastOpened: 30 },
    { ...V(4, 'untried', [], 'c_9'), lastSubmissionTime: null, lastOpened: 20 },
  ];
  const ids = (s: Parameters<typeof sortProblems>[1]) => sortProblems([...items], s).map((p) => p.id);
  it('each order; missing keys go last; ties keep grader order', () => {
    expect(ids('default')).toEqual([1, 2, 3, 4]);
    expect(ids('name-asc')).toEqual([2, 1, 4, 3]); // numeric-aware: c_9 before c_10
    expect(ids('name-desc')).toEqual([3, 4, 1, 2]);
    expect(ids('latest')).toEqual([2, 1, 3, 4]);
    expect(ids('score-asc')).toEqual([2, 1, 3, 4]);
    expect(ids('score-desc')).toEqual([1, 2, 3, 4]);
    expect(ids('recent')).toEqual([3, 4, 1, 2]);
  });
  it('combines with filters', () => {
    expect(sortProblems(filterProblems(items, { status: 'unsolved', topic: null }, ''), 'name-asc').map((p) => p.id)).toEqual([2, 4, 3]);
  });
});
