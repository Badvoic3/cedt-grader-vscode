import { SERVER_SCORE_CAP } from '../src/shared/constants';
import { describe, expect, it } from 'vitest';
import { countedScore, describeImprovement, penaltyLabel, scoreText, summarize } from '../src/grader';

const base = { bestScore: 70, lastScore: 40, submissionCount: 3, list: null };

describe('countedScore', () => {
  it('best counts, not latest', () => {
    const s = summarize(base);
    expect(s).toMatchObject({ counted: 70, best: 70, latest: 40, attempts: 3, latestBelowCounted: true, source: 'api', penaltyLabel: null });
  });

  it('penalties cap the score at 100 - cost', () => {
    expect(countedScore(100, 10)).toBe(90);
    expect(countedScore(60, 10)).toBe(60); // below the cap: unchanged
    expect(countedScore(100, 25)).toBe(75);
  });

  it('floors at 0 and caps the cost at 100', () => {
    expect(countedScore(50, 150)).toBe(0);
    expect(countedScore(0, 0)).toBe(0);
  });

  it('raw-sum mode shows the raw best without cap or penalty', () => {
    expect(countedScore(137.5, 50, true)).toBe(137.5);
    const s = summarize({ ...base, bestScore: 137.5, list: { rawMax: 137.5, adjusted: null, cost: 0, hintCount: 0, aiCount: 0, rawSum: true } });
    expect(s).toMatchObject({ counted: 137.5, rawSum: true, penalty: 0, penaltyLabel: null, source: 'problem-list' });
  });

  it('never submitted → null', () => {
    expect(summarize({ bestScore: null, lastScore: null, submissionCount: 0, list: null }).counted).toBeNull();
  });

  it('uses list penalties and labels them', () => {
    const s = summarize({ ...base, bestScore: 100, lastScore: 100, list: { rawMax: 100, adjusted: 90, cost: 10, hintCount: 0, aiCount: 2, rawSum: false } });
    expect(s).toMatchObject({ counted: 90, penalty: 10, penaltyLabel: '-10 AI assist', source: 'problem-list', latestBelowCounted: false });
  });

  it('penalty labels', () => {
    expect(penaltyLabel({ cost: 5, hintCount: 1, aiCount: 0 })).toBe('-5 hints');
    expect(penaltyLabel({ cost: 25, hintCount: 1, aiCount: 1 })).toBe('-25 hints + AI assist');
    expect(penaltyLabel({ cost: 0, hintCount: 1, aiCount: 0 })).toBeNull();
  });
});

describe('describeImprovement', () => {
  it('improved / unchanged / lower', () => {
    expect(describeImprovement(40, 70, 70)).toBe('Counted score improved: 40 → 70.');
    expect(describeImprovement(70, 70, 40)).toBe('This submission scored 40; your best, 70, still counts.');
    expect(describeImprovement(70, 70, 70)).toBe('Counted score unchanged (70).');
    expect(describeImprovement(null, 30, 30)).toBe('First counted score: 30.');
  });
});

describe('every score is out of 100 (app/engine/scorer.rb normalizes sum / group_min)', () => {
  const p = (best: number, list: Parameters<typeof summarize>[0]['list'] = null) => ({ bestScore: best, lastScore: best, submissionCount: 1, list });
  // The API's full_score for these problems would be 4, 10, 37 (weights) and 6 (groups): never the maximum.
  for (const [what, best] of [['4 tests', 75], ['10 tests', 70], ['weighted tests', 64.86], ['grouped tests', 50]] as const) {
    it(`${what}: "${best} / 100"`, () => {
      expect(summarize(p(best)).outOf).toBe(SERVER_SCORE_CAP);
      expect(scoreText(best, false)).toEqual({ text: `${best} / 100`, tip: null });
    });
  }
  it('raw_sum: the raw score, no "/ max", with a tooltip explaining it', () => {
    const raw = { rawMax: 37, adjusted: null, cost: 0, hintCount: 0, aiCount: 0, rawSum: true };
    expect(summarize(p(37, raw)).outOf).toBeNull();
    expect(summarize(p(37, raw)).counted).toBe(37); // uncapped
    const t = scoreText(37, true);
    expect(t.text).toBe('37');
    expect(t.tip).toMatch(/raw-sum scoring/);
  });
  it('the penalty cap is the same named constant', () => {
    expect(countedScore(150, 0)).toBe(SERVER_SCORE_CAP);
    expect(countedScore(90, 20)).toBe(80);
  });
});
