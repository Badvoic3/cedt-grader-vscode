/** What an Explorer badge says: always something VS Code accepts, and the same on every run. */
import { describe, expect, it } from 'vitest';
import type { Problem } from '../src/grader/types';
import { badgeTag, badgeView, FULL_SCORE_BADGE, scoreBadge, scoreColor, TAG_COLORS, tagBadge, tagColor, UNTRIED_BADGE } from '../src/mapping/explorerBadge';
import { placeholder } from '../src/mapping/match';

/** VS Code's `FileDecoration.validate`: at most two characters, or it logs a warning and draws nothing. */
const accepted = (badge: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(badge)].length <= 2;

const problem = (extra: Partial<Problem>): Problem => ({ ...placeholder(7, 'hw_sum'), submissionCount: 1, ...extra });

describe('score badge', () => {
  it.each([
    [null, UNTRIED_BADGE],
    [0, '0'],
    [0.5, '0'],
    [5, '5'],
    [70, '70'],
    [99.9, '99'],
    [100, FULL_SCORE_BADGE],
    [137.5, FULL_SCORE_BADGE],
  ])('%s → %s', (counted, badge) => {
    expect(scoreBadge(counted)).toBe(badge);
    expect(accepted(badge)).toBe(true);
  });

  it('colours: green 100, amber in progress, red submitted but 0, grey untried', () => {
    expect([100, 137.5, 99.9, 0.5, 0, null].map((c) => scoreColor(c).split('.').pop())).toEqual(['solved', 'solved', 'inProgress', 'inProgress', 'zero', 'untried']);
  });
});

describe('tag badge', () => {
  it.each([
    ['Graph', 'GR'],
    ['dp', 'DP'],
    ['X', 'X'],
    ['  data algo', 'DA'],
    ['straße', 'ST'],
    ['ß', 'SS'],
    ['กราฟ', 'กร'],
    ['ต้นไม้', 'ต้น'],
    ['กำหนดการ', 'กำห'],
    ['🌲🌲🌲', undefined],
    ['', undefined],
    ['   ', undefined],
    ['​\u0007', undefined],
  ])('%j → %j', (tag, badge) => {
    expect(tagBadge(tag)).toBe(badge);
    if (badge) expect(accepted(badge)).toBe(true);
  });

  it('gives a tag the same colour on every run, whatever its case or spaces', () => {
    expect(['Graph', 'DP', 'ComProg', 'กราฟ'].map(tagColor)).toEqual(['cedtGrader.explorer.tag2', 'cedtGrader.explorer.tag4', 'cedtGrader.explorer.tag1', 'cedtGrader.explorer.tag1']);
    expect(tagColor(' GRAPH ')).toBe(tagColor('graph'));
    for (const t of ['a', 'b', 'c', 'Sorting', 'x'.repeat(500)]) expect(TAG_COLORS).toContain(tagColor(t));
  });

  it('prefers the first topic tag, and takes the first tag when none is a topic', () => {
    expect(badgeTag(['Graph', 'ComProg'], ['comprog'])).toBe('ComProg');
    expect(badgeTag(['Graph', 'DFS'], ['ComProg'])).toBe('Graph');
    expect(badgeTag([], ['ComProg'])).toBeUndefined();
  });
});

describe('badgeView', () => {
  it('shows the counted score, not the best one: a penalty lowers it', () => {
    const p = problem({ bestScore: 100, list: { cost: 20, hintCount: 1, aiCount: 0, rawSum: false } as Problem['list'] });
    expect(badgeView(p, 'chosen', 'score', true)).toMatchObject({ badge: '80', color: 'cedtGrader.explorer.inProgress' });
  });

  it('a never-submitted problem is untried, even with the 0 the API reports', () => {
    expect(badgeView(problem({ submissionCount: 0, bestScore: 0 }), 'filename', 'score', true)).toMatchObject({ badge: UNTRIED_BADGE, color: 'cedtGrader.explorer.untried' });
  });

  it('a suggestion keeps its number but no colour; so does everything with colours off', () => {
    const p = problem({ bestScore: 100 });
    expect(badgeView(p, 'suggested', 'score', true)).toMatchObject({ badge: FULL_SCORE_BADGE, color: null });
    expect(badgeView(p, 'chosen', 'score', false)).toMatchObject({ badge: FULL_SCORE_BADGE, color: null });
    expect(badgeView(problem({ tags: ['DP'] }), 'suggested', 'tag', true)).toMatchObject({ badge: 'DP', color: null });
  });

  it('tag mode with no tag has a tooltip and nothing else', () => {
    const v = badgeView(problem({ bestScore: 70 }), 'chosen', 'tag', true);
    expect(v).toMatchObject({ color: null });
    expect(v?.badge).toBeUndefined();
    expect(v?.tooltip).toContain('hw_sum #7');
  });

  it('the tooltip names the problem, its category, its tags, the score out of 100 and how the file matched', () => {
    expect(badgeView(problem({ name: 'hw​_sum', bestScore: 72.5, tags: ['Graph', 'DataAlgo', 'DFS', 'comprog'] }), 'suggested', 'score', true, ['ComProg', 'DataAlgo'])?.tooltip).toBe('hw_sum #7 · Category: DataAlgo, comprog · Graph, DFS · counted 72.5 / 100 · suggested');
    expect(badgeView(problem({ bestScore: 100, tags: ['ComProg'] }), 'chosen', 'score', true, ['ComProg'])?.tooltip).toBe('hw_sum #7 · Category: ComProg · counted 100 / 100 · linked');
    expect(badgeView(problem({ bestScore: 70, tags: ['Graph'] }), 'chosen', 'score', true)?.tooltip).toBe('hw_sum #7 · Graph · counted 70 / 100 · linked');
    expect(badgeView(problem({ submissionCount: 0 }), 'folder', 'score', true)?.tooltip).toBe('hw_sum #7 · not tried yet · matched by folder name');
  });

  it('a raw-sum problem has no maximum, so the tooltip gives just the number', () => {
    const p = problem({ bestScore: 137.5, list: { cost: 0, hintCount: 0, aiCount: 0, rawSum: true } as Problem['list'] });
    expect(badgeView(p, 'chosen', 'score', true)?.tooltip).toBe('hw_sum #7 · counted 137.5 · linked');
  });

  it('off gives nothing', () => {
    expect(badgeView(problem({}), 'chosen', 'off', true)).toBeNull();
  });
});
