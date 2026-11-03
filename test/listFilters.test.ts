import { describe, expect, it } from 'vitest';
import { parseTopicTags, problemStatus } from '../src/grader';
import type { ProblemView } from '../src/shared/messages';
import { filterProblems, sortProblems } from '../webview/filters';
import { cleanTagFilter, cleanTopicFilter, cycleTopic, matchesTags, otherTags, topicState } from '../src/shared/tags';
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

describe('other tags: the "Tags" dropdown (several at once, Any / All)', () => {
  const items = [
    V(1, 'solved', ['DataAlgo', 'Graph', 'DFS', 'BFS']),
    V(2, 'untried', ['DataAlgo', 'Graph']),
    V(3, 'untried', ['ComProg', 'dfs']),
    V(4, 'untried', []),
  ];
  const ids = (f: Parameters<typeof filterProblems>[1]) => filterProblems(items, f, '').map((p) => p.id);
  const topics = [{ name: 'ComProg' }, { name: 'DataAlgo' }];

  it('the dropdown lists every tag that is not a topic pill, case-insensitive, once, sorted', () => {
    expect(otherTags(items, topics)).toEqual(['BFS', 'DFS', 'Graph']);
  });
  it('topics unknown (no /main/list): every tag goes to the dropdown', () => {
    expect(otherTags(items, [])).toEqual(['BFS', 'ComProg', 'DataAlgo', 'DFS', 'Graph']);
  });
  it('a chosen tag no problem has any more stays listed, so it can be unticked', () => {
    expect(otherTags(items, topics, ['Heap'])).toEqual(['BFS', 'DFS', 'Graph', 'Heap']);
  });
  it('Any (OR, the default): at least one chosen tag; tag case does not matter', () => {
    expect(ids({ status: 'all', topic: null, tags: ['BFS', 'DFS'] })).toEqual([1, 3]);
    expect(ids({ status: 'all', topic: null, tags: ['BFS', 'DFS'], tagMode: 'or' })).toEqual([1, 3]);
  });
  it('All (AND): every chosen tag', () => {
    expect(ids({ status: 'all', topic: null, tags: ['Graph', 'DFS'], tagMode: 'and' })).toEqual([1]);
    expect(ids({ status: 'all', topic: null, tags: ['Graph'], tagMode: 'and' })).toEqual([1, 2]);
  });
  it('combines with the topic pill, status and search; no tags chosen = no tag filter (older saved filters)', () => {
    expect(ids({ status: 'all', topic: 'ComProg', tags: ['DFS'] })).toEqual([3]);
    expect(ids({ status: 'unsolved', topic: null, tags: ['Graph'] })).toEqual([2]);
    expect(ids({ status: 'all', topic: null, tags: [] })).toEqual([1, 2, 3, 4]);
    expect(ids({ status: 'all', topic: null })).toEqual([1, 2, 3, 4]);
    expect(matchesTags(undefined, ['Graph'], 'or')).toBe(false);
  });
  it('a stored filter is cleaned: strings only, no duplicates, mode defaults to OR', () => {
    expect(cleanTagFilter(['Graph', ' graph ', 3, '', 'DFS'], 'xor')).toEqual({ tags: ['Graph', 'DFS'], tagMode: 'or' });
    expect(cleanTagFilter(undefined, 'and')).toEqual({ tags: [], tagMode: 'and' });
  });
});

describe('topic pills: not chosen → hide → show only → not chosen', () => {
  const items = [V(1, 'solved', ['ComProg']), V(2, 'untried', ['DataAlgo', 'Graph']), V(3, 'untried', ['DigLo']), V(4, 'untried', [])];
  const ids = (f: Parameters<typeof filterProblems>[1]) => filterProblems(items, f, '').map((p) => p.id);
  const off = { status: 'all' as const, topic: null };

  it('a click cycles the state and keeps the other pills', () => {
    const a = cycleTopic(off, 'ComProg');
    expect(a).toEqual({ topic: null, topicsIn: [], topicsOut: ['ComProg'] });
    expect(topicState(a, 'ComProg')).toBe('out');
    const b = cycleTopic({ ...a, topicsOut: ['ComProg', 'DigLo'] }, 'ComProg');
    expect(b).toEqual({ topic: null, topicsIn: ['ComProg'], topicsOut: ['DigLo'] });
    expect(topicState(b, 'ComProg')).toBe('in');
    expect(cycleTopic(b, 'ComProg')).toEqual({ topic: null, topicsIn: [], topicsOut: ['DigLo'] });
  });
  it('hide: problems with that topic are left out (problems without tags stay)', () => {
    expect(ids({ ...off, topicsOut: ['ComProg'] })).toEqual([2, 3, 4]);
    expect(ids({ ...off, topicsOut: ['ComProg', 'DigLo'] })).toEqual([2, 4]);
  });
  it('show only: problems with at least one shown topic', () => {
    expect(ids({ ...off, topicsIn: ['DataAlgo'] })).toEqual([2]);
    expect(ids({ ...off, topicsIn: ['DataAlgo', 'DigLo'] })).toEqual([2, 3]);
  });
  it('both, and together with the Tags dropdown', () => {
    expect(ids({ ...off, topicsIn: ['DataAlgo', 'DigLo'], topicsOut: ['DigLo'] })).toEqual([2, 3]); // shown-only wins over hidden for the same topic
    expect(ids({ ...off, topicsOut: ['ComProg'], tags: ['Graph'] })).toEqual([2]);
  });
  it('older saved filters: one `topic` = show only; cleaned into the new fields', () => {
    expect(ids({ status: 'all', topic: 'ComProg' })).toEqual([1]);
    expect(topicState({ topic: 'ComProg' }, 'ComProg')).toBe('in');
    expect(cleanTopicFilter({ topic: 'ComProg' })).toEqual({ topic: null, topicsIn: ['ComProg'], topicsOut: [] });
    expect(cleanTopicFilter({ topic: 'X', topicsIn: ['A', 'a', 3], topicsOut: ['A', 'B'] })).toEqual({ topic: null, topicsIn: ['A'], topicsOut: ['B'] });
  });
});
