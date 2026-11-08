import { describe, expect, it } from 'vitest';
import { normalizeFirstFull, shouldCelebrate, streaks, topicOf, topicProgress, trophyStats } from '../src/flows/celebrate';

const at = (d: number, h = 13) => new Date(2026, 10, d, h).getTime();
const pass = (n: number) => Array.from({ length: n }, () => ({ ok: true }));
const base = { bestBefore: 40, countedAfter: 100, points: 100, verdicts: pass(5), compileError: false, known: false };

describe('first-full-score celebration', () => {
  it('fires the first time every test passes or the counted score reaches 100, and only once', () => {
    expect(shouldCelebrate(base)).toBe('celebrate');
    expect(shouldCelebrate({ ...base, known: true })).toBe('none');
    expect(shouldCelebrate({ ...base, verdicts: [{ ok: true }, { ok: false }], points: 50, countedAfter: 50 })).toBe('none');
    expect(shouldCelebrate({ ...base, compileError: true, verdicts: [], points: 0, countedAfter: 40 })).toBe('none');
  });

  it('every test passing counts even when a hint caps the counted score', () => {
    expect(shouldCelebrate({ ...base, countedAfter: 80 })).toBe('celebrate');
  });

  it('a raw-sum problem at 100 counts without per-test verdicts', () => {
    expect(shouldCelebrate({ ...base, verdicts: [], points: 100, countedAfter: 100 })).toBe('celebrate');
  });

  it('a problem already full before is recorded silently', () => {
    expect(shouldCelebrate({ ...base, bestBefore: 100 })).toBe('record');
  });

  it('stored records are read back safely', () => {
    expect(normalizeFirstFull({ '12': at(3), '13': 0, x: 5, '14': -1, '15': 'no', '16': Number.NaN })).toEqual({ '12': at(3), '13': 0 });
    expect(normalizeFirstFull(null)).toEqual({});
    expect(normalizeFirstFull([1, 2])).toEqual({});
  });
});

describe('trophies', () => {
  it('a streak counts days in a row with a new full score; the day starts at 4:00', () => {
    const ff = { '1': at(3), '2': at(5, 2), '3': at(5, 10), '4': 0 }; // 5 Nov 2:00 belongs to the 4th
    expect(streaks(ff, at(5))).toEqual({ streak: 3, best: 3 });
    expect(streaks(ff, at(6))).toEqual({ streak: 3, best: 3 }); // yesterday still counts
    expect(streaks(ff, at(7))).toEqual({ streak: 0, best: 3 }); // a missed day ends it
    expect(streaks({ '1': at(3), '2': at(5, 10) }, at(5))).toEqual({ streak: 1, best: 1 }); // the gap on the 4th
    expect(streaks({ ...ff, '6': at(1), '7': at(2) }, at(5))).toEqual({ streak: 5, best: 5 });
    expect(streaks({}, at(5))).toEqual({ streak: 0, best: 0 });
  });

  it('topic progress follows the website topics, case-insensitive, and leaves out empty topics', () => {
    const problems = [
      { id: 1, status: 'solved' as const, tags: ['Recursion'] },
      { id: 2, status: 'inprogress' as const, tags: ['recursion', 'DFS'] },
      { id: 3, status: 'untried' as const, tags: ['Graph'] },
    ];
    const topics = [{ name: 'Recursion' }, { name: 'Graph' }, { name: 'DP' }];
    expect(topicProgress(problems, topics, { '2': at(5) })).toEqual([{ name: 'Recursion', solved: 2, total: 2 }, { name: 'Graph', solved: 0, total: 1 }]);
    const t = trophyStats({ '2': at(5), '99': 0 }, problems, topics, at(5));
    expect(t).toMatchObject({ firsts: 3, streak: 1, best: 1, wholeTopics: 1 });
    expect(topicOf(problems[1], t.topics)).toEqual({ name: 'Recursion', solved: 2, total: 2 });
    expect(topicOf({ id: 4, status: 'untried', tags: ['DFS'] }, t.topics)).toBeNull();
    expect(topicOf(undefined, t.topics)).toBeNull();
  });
});
